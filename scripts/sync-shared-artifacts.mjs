#!/usr/bin/env node
/**
 * Manifest-driven local handoff sync.
 *
 * This command reads `shared/artifact-manifest.gen.json` from a side-by-side
 * Main_Repository checkout, validates every covered source byte before writing,
 * and copies only the generated handoff destinations declared by the manifest
 * resolver. Coverage-only paths (for example Go producer files) are never
 * copied into Admin. The command has no network dependency and is intended for
 * the local task-06 handoff step.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTRACT_ADOPTION_FILENAME,
  SHARED_ARTIFACT_MANIFEST_RELATIVE_PATH,
  UPSTREAM_MANIFEST_RELATIVE_PATH,
  getHandoffEntries,
  parseAdoption,
  parseContractVersion,
  parseManifest,
  resolveRepositoryPath,
  sha256,
} from "./check-shared-artifacts.mjs";

export const EXIT_OK = 0;
export const EXIT_SYNC_FAILED = 1;
export const EXIT_DRY_RUN_OK = 0;

const SYNCED_MANIFEST_DESTINATION = SHARED_ARTIFACT_MANIFEST_RELATIVE_PATH;
const ADOPTION_DESTINATION = CONTRACT_ADOPTION_FILENAME;

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function readBytes(readFile, filePath) {
  const value = readFile(filePath);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error(`reader returned a non-byte value for ${filePath}`);
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value !== null && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = stableJson(value[key]);
    return sorted;
  }
  return value;
}

function adoptionBytes(adoption) {
  return Buffer.from(`${JSON.stringify(stableJson(adoption), null, 2)}\n`, "utf8");
}

function defaultUpstreamRoot(root) {
  return path.resolve(root, "../more-or-less");
}

function sourceCommitFor(manifest, explicitSourceCommit, existingSourceCommit) {
  if (explicitSourceCommit !== undefined && explicitSourceCommit !== null) {
    if (typeof explicitSourceCommit !== "string" || !/^[a-f0-9]{7,64}$/i.test(explicitSourceCommit)) {
      throw new Error("--source-commit must be a hexadecimal git commit id.");
    }
    return explicitSourceCommit;
  }
  return manifest.sourceCommit ?? existingSourceCommit;
}

function readAdoptionIfPresent({ root, readFile, exists }) {
  const adoptionPath = resolveRepositoryPath(root, ADOPTION_DESTINATION);
  if (!exists(adoptionPath)) return null;
  return parseAdoption(readFile(adoptionPath, "utf8"));
}

function makeOperation({ sourcePath, destination, bytes, digest, action }) {
  return { sourcePath, destination, bytes, digest, action };
}

function compareExisting(readFile, exists, root, destination, bytes) {
  const destinationPath = resolveRepositoryPath(root, destination);
  if (!exists(destinationPath)) return false;
  return readBytes(readFile, destinationPath).equals(bytes);
}

/**
 * Read and validate the complete upstream handoff before performing any write.
 * This preflight is intentional: a missing or mismatched source must not leave
 * a partially refreshed Admin bundle.
 */
function preflight({
  root,
  upstreamRoot,
  upstreamManifestPath,
  readFile,
  exists,
  stat,
  sourceCommit,
  now,
  stampAdoptedAt,
}) {
  const errors = [];
  const manifestPath = resolveRepositoryPath(upstreamRoot, upstreamManifestPath);
  let manifestBytes;
  try {
    if (!exists(manifestPath)) throw new Error("upstream manifest is missing");
    if (stat(manifestPath).isFile() !== true) throw new Error("upstream manifest is not a regular file");
    manifestBytes = readBytes(readFile, manifestPath);
  } catch (error) {
    return {
      errors: [`sync-shared-artifacts: cannot read ${upstreamManifestPath}: ${describeError(error)}`],
      manifest: null,
      operations: [],
      adoption: null,
    };
  }

  let manifest;
  try {
    manifest = parseManifest(manifestBytes.toString("utf8"));
  } catch (error) {
    return {
      errors: [`sync-shared-artifacts: invalid upstream manifest: ${describeError(error)}`],
      manifest: null,
      operations: [],
      adoption: null,
    };
  }

  let entries;
  try {
    entries = getHandoffEntries(manifest);
  } catch (error) {
    errors.push(`sync-shared-artifacts: ${describeError(error)}`);
    entries = [];
  }

  const sourceBytesByPath = new Map();
  for (const sourcePath of manifest.coveredSourcePaths) {
    const sourceAbs = resolveRepositoryPath(upstreamRoot, sourcePath);
    try {
      if (!exists(sourceAbs)) throw new Error("covered source is missing");
      if (stat(sourceAbs).isFile() !== true) throw new Error("covered source is not a regular file");
      const bytes = readBytes(readFile, sourceAbs);
      const digest = sha256(bytes);
      if (digest !== manifest.files[sourcePath]) {
        throw new Error(`digest mismatch (expected ${manifest.files[sourcePath]}, got ${digest})`);
      }
      sourceBytesByPath.set(sourcePath, bytes);
    } catch (error) {
      errors.push(`sync-shared-artifacts: cannot verify ${sourcePath}: ${describeError(error)}`);
    }
  }

  const contractSource = sourceBytesByPath.get("shared/fact-lifecycle-contract.gen.ts");
  if (contractSource) {
    const contractVersion = parseContractVersion(contractSource.toString("utf8"));
    if (contractVersion !== manifest.contractVersion) {
      errors.push(
        `sync-shared-artifacts: contract source declares ${JSON.stringify(contractVersion)}, manifest declares ${JSON.stringify(manifest.contractVersion)}.`,
      );
    }
  } else {
    errors.push("sync-shared-artifacts: manifest does not cover the generated contract artifact.");
  }

  const operations = [];
  for (const entry of entries) {
    const bytes = sourceBytesByPath.get(entry.sourcePath);
    if (!bytes) continue;
    for (const destination of [entry.destination]) {
      operations.push(
        makeOperation({
          sourcePath: entry.sourcePath,
          destination,
          bytes,
          digest: entry.digest,
          action: "artifact",
        }),
      );
    }
  }

  // The manifest itself is a declared handoff destination. It is copied only
  // after the same preflight has validated every source covered by it.
  operations.push(
    makeOperation({
      sourcePath: upstreamManifestPath,
      destination: SYNCED_MANIFEST_DESTINATION,
      bytes: manifestBytes,
      digest: null,
      action: "manifest",
    }),
  );

  let adoption;
  try {
    const existing = readAdoptionIfPresent({ root, readFile, exists });
    const adoptionValue = {
      adopted: true,
      contractVersion: manifest.contractVersion,
    };
    const commit = sourceCommitFor(manifest, sourceCommit, existing?.sourceCommit);
    if (commit !== undefined) adoptionValue.sourceCommit = commit;
    if (stampAdoptedAt) {
      adoptionValue.adoptedAt = new Date(now()).toISOString();
    }
    adoption = adoptionBytes(adoptionValue);
    if (existing === null) {
      // Parsing the existing file above is intentional: malformed adoption
      // metadata is configuration corruption, not something sync may hide.
    }
  } catch (error) {
    errors.push(`sync-shared-artifacts: cannot prepare ${ADOPTION_DESTINATION}: ${describeError(error)}`);
  }

  if (adoption !== null && adoption !== undefined) {
    operations.push(
      makeOperation({
        sourcePath: ADOPTION_DESTINATION,
        destination: ADOPTION_DESTINATION,
        bytes: adoption,
        digest: null,
        action: "adoption",
      }),
    );
  }

  return { errors, manifest, operations, adoption };
}

function classifyOperations({ root, readFile, exists, operations }) {
  const planned = [];
  for (const operation of operations) {
    const unchanged = compareExisting(
      readFile,
      exists,
      root,
      operation.destination,
      operation.bytes,
    );
    planned.push({ ...operation, action: unchanged ? "unchanged" : "write" });
  }
  return planned;
}

/**
 * Run the local sync. No child process, network call, or migration command is
 * involved. `dryRun` performs the complete preflight and reports planned
 * writes without changing the worktree.
 */
export function runSharedArtifactSync({
  root = process.cwd(),
  upstreamRoot = defaultUpstreamRoot(root),
  upstreamManifestPath = UPSTREAM_MANIFEST_RELATIVE_PATH,
  readFileSync: readFile = readFileSync,
  existsSync: exists = existsSync,
  statSync: stat = statSync,
  mkdirSync: makeDirectory = mkdirSync,
  writeFileSync: writeFile = writeFileSync,
  now = () => Date.now(),
  sourceCommit = undefined,
  dryRun = false,
  stampAdoptedAt = true,
} = {}) {
  const stdout = [];
  const stderr = [];
  const resolvedUpstreamRoot = path.resolve(root, upstreamRoot);

  let preflightResult;
  try {
    preflightResult = preflight({
      root,
      upstreamRoot: resolvedUpstreamRoot,
      upstreamManifestPath,
      readFile,
      exists,
      stat,
      sourceCommit,
      now,
      stampAdoptedAt,
    });
  } catch (error) {
    return {
      ok: false,
      exitCode: EXIT_SYNC_FAILED,
      stdout,
      stderr: [`sync-shared-artifacts: ${describeError(error)}`],
      manifest: null,
      written: [],
      unchanged: [],
      planned: [],
    };
  }

  if (preflightResult.errors.length > 0) {
    return {
      ok: false,
      exitCode: EXIT_SYNC_FAILED,
      stdout,
      stderr: preflightResult.errors,
      manifest: preflightResult.manifest,
      written: [],
      unchanged: [],
      planned: [],
    };
  }

  let planned;
  try {
    planned = classifyOperations({ root, readFile, exists, operations: preflightResult.operations });
  } catch (error) {
    return {
      ok: false,
      exitCode: EXIT_SYNC_FAILED,
      stdout,
      stderr: [`sync-shared-artifacts: cannot classify destination state: ${describeError(error)}`],
      manifest: preflightResult.manifest,
      written: [],
      unchanged: [],
      planned: [],
    };
  }

  const writeOperations = planned.filter((operation) => operation.action === "write");
  const unchanged = planned
    .filter((operation) => operation.action === "unchanged")
    .map((operation) => operation.destination);

  if (dryRun) {
    stdout.push(
      `sync-shared-artifacts: dry run — ${writeOperations.length} destination${writeOperations.length === 1 ? "" : "s"} would be written; ${unchanged.length} already match.`,
    );
    return {
      ok: true,
      exitCode: EXIT_DRY_RUN_OK,
      stdout,
      stderr,
      manifest: preflightResult.manifest,
      written: [],
      unchanged,
      planned,
    };
  }

  const written = [];
  try {
    for (const operation of writeOperations) {
      const destinationPath = resolveRepositoryPath(root, operation.destination);
      makeDirectory(path.dirname(destinationPath), { recursive: true });
      writeFile(destinationPath, operation.bytes);
      written.push(operation.destination);
    }
  } catch (error) {
    return {
      ok: false,
      exitCode: EXIT_SYNC_FAILED,
      stdout,
      stderr: [
        ...stderr,
        `sync-shared-artifacts: write failed after ${written.length} destination${written.length === 1 ? "" : "s"}: ${describeError(error)}`,
      ],
      manifest: preflightResult.manifest,
      written,
      unchanged,
      planned,
    };
  }

  stdout.push(
    `sync-shared-artifacts: ${written.length === 0 ? "already in sync" : "synchronized"} — ${written.length} destination${written.length === 1 ? "" : "s"} written, ${unchanged.length} unchanged.`,
  );
  return {
    ok: true,
    exitCode: EXIT_OK,
    stdout,
    stderr,
    manifest: preflightResult.manifest,
    written,
    unchanged,
    planned,
  };
}

/** Compatibility aliases used by task-specific callers. */
export const runArtifactSync = runSharedArtifactSync;
export const runSyncSharedArtifacts = runSharedArtifactSync;

function parseCliArgs(argv) {
  const options = { dryRun: false, sourceCommit: undefined, upstreamRoot: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run" || argument === "--check") {
      options.dryRun = true;
      continue;
    }
    if (argument === "--upstream-root") {
      if (!argv[index + 1]) throw new Error("--upstream-root requires a path.");
      options.upstreamRoot = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--upstream-root=")) {
      options.upstreamRoot = argument.slice("--upstream-root=".length);
      if (!options.upstreamRoot) throw new Error("--upstream-root requires a path.");
      continue;
    }
    if (argument === "--source-commit") {
      if (!argv[index + 1]) throw new Error("--source-commit requires a commit id.");
      options.sourceCommit = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--source-commit=")) {
      options.sourceCommit = argument.slice("--source-commit=".length);
      if (!options.sourceCommit) throw new Error("--source-commit requires a commit id.");
      continue;
    }
    if (argument === "--no-adopted-at") {
      options.stampAdoptedAt = false;
      continue;
    }
    throw new Error(`Unsupported argument: ${argument}.`);
  }
  return options;
}

function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  let options;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`sync-shared-artifacts: ${describeError(error)}\n`);
    process.exit(EXIT_SYNC_FAILED);
  }
  const root = process.cwd();
  const outcome = runSharedArtifactSync({
    root,
    upstreamRoot:
      options.upstreamRoot === undefined
        ? path.resolve(root, "../more-or-less")
        : path.resolve(root, options.upstreamRoot),
    dryRun: options.dryRun,
    sourceCommit: options.sourceCommit,
    stampAdoptedAt: options.stampAdoptedAt !== false,
  });
  for (const line of outcome.stdout) process.stdout.write(`${line}\n`);
  for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
  process.exit(outcome.exitCode);
}
