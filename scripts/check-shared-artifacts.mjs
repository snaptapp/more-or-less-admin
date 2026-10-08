#!/usr/bin/env node
/**
 * Shared artifact integrity gate.
 *
 * This module is deliberately read-only. It reads the tracked handoff manifest
 * and verifies every local consumed/published artifact against the SHA-256
 * digest recorded by Main_Repository. It never reads an upstream checkout
 * unless a caller explicitly supplies `--upstream-root`, and it never performs
 * network I/O.
 *
 * The same manifest parser and destination resolver are imported by the sync
 * and freshness commands so that all three commands agree on the handoff
 * surface. An explicit `destinations` map in a manifest, when present, is
 * authoritative; the fallback mapping is limited to the generated contract,
 * DDM port/table files, and parity fixtures known to this repository.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The manifest copied into the Admin repository by the handoff sync. */
export const SHARED_ARTIFACT_MANIFEST_RELATIVE_PATH =
  "contract/published/artifact-manifest.json";

/** The source manifest in Main_Repository. */
export const UPSTREAM_MANIFEST_RELATIVE_PATH = "shared/artifact-manifest.gen.json";

/** Adoption metadata maintained by the sync command. */
export const CONTRACT_ADOPTION_FILENAME = "contract-adoption.json";

/** The contract consumed by Admin code. */
export const CONSUMED_CONTRACT_RELATIVE_PATH = "shared/fact-lifecycle-contract.gen.ts";

/** The byte-for-byte published mirror used by the integrity gate. */
export const PUBLISHED_CONTRACT_RELATIVE_PATH =
  "contract/published/fact-lifecycle-contract.gen.ts";

export const EXIT_OK = 0;
export const EXIT_CONFIG_UNREADABLE = 3;
export const EXIT_ADOPTION_MISMATCH = 4;
export const EXIT_DIGEST_MISMATCH = 5;
export const EXIT_UPSTREAM_MISMATCH = 6;

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{7,64}$/i;

/** Generated DDM source files that are valid handoff artifacts. */
const DDM_SOURCE_FILES = new Set([
  "src/ddm_implementation_gen.ts",
  "src/derivation.ts",
  "src/derivation_adapter.ts",
  "src/factbank_precompute.ts",
  "src/derivation_resolve.ts",
  "src/derivation_statement.ts",
  "src/derivation_tables_gen.ts",
  "src/unit_tables_gen.ts",
]);

/** Generated fixtures that are valid handoff artifacts. */
const FIXTURE_SOURCE_FILES = new Set([
  "tests/fixtures/derivation_corpus.json",
  "tests/fixtures/derivation_cross_runtime.json",
  "tests/fixtures/derivation_parity.json",
  "tests/fixtures/derivation_playable_candidates.json",
  "tests/fixtures/derivation_tables.json",
  "tests/fixtures/unit_tables.json",
  "tests/fixtures/key_normalization.json",
]);

/**
 * Main_Repository coverage paths that describe inputs but are not files Admin
 * consumes. They remain in the manifest so freshness checks notice changes to
 * their producers; the sync command must not copy them into Admin.
 */
const COVERAGE_ONLY_SOURCE_FILES = new Set([
  "agent-go/ddm_implementation_gen.go",
  "agent-go/derivation.go",
  "agent-go/derivation_bounds.go",
  "agent-go/derivation_candidate.go",
  "agent-go/derivation_classify.go",
  "agent-go/derivation_counterexample.go",
  "agent-go/derivation_derive.go",
  "agent-go/derivation_enumerate.go",
  "agent-go/derivation_giveaway_gate.go",
  "agent-go/derivation_ingest.go",
  "agent-go/derivation_kernel.go",
  "agent-go/derivation_playable.go",
  "agent-go/derivation_schema.go",
  "agent-go/derivation_snapping.go",
  "agent-go/derivation_statement_gate.go",
  "agent-go/derivation_statement_inflect.go",
  "agent-go/derivation_statement_policy.go",
  "agent-go/derivation_statement_scan.go",
  "agent-go/derivation_strategy.go",
  "agent-go/derivation_surprise.go",
  "agent-go/derivation_tables_gen.go",
  "agent-go/derivation_trap.go",
  "agent-go/derivation_variation.go",
  "agent-go/derivation_zero.go",
  "agent-go/enqueue.go",
  "agent-go/factlint.go",
  "agent-go/factlint_rules.go",
  "agent-go/factquality.go",
  "agent-go/factquality_audit.go",
  "agent-go/factquality_audit_store.go",
  "agent-go/factquality_evidence.go",
  "agent-go/factquality_fetch.go",
  "agent-go/factquality_numeric.go",
  "agent-go/factquality_units_gen.go",
  "agent-go/factrepair.go",
  "agent-go/foundry.go",
  "agent-go/foundry_crawl_prompt.txt",
  "agent-go/foundry_failure_log.go",
  "agent-go/foundry_refresh_prompt.txt",
  "agent-go/foundry_source_discovery_prompt.txt",
  "agent-go/subcommands.go",
  "agent-go/unit_tables_gen.go",
  "contract.version",
  "scripts/contract-transitions.json",
  "scripts/ddm-port-source/derivation.ts",
  "scripts/ddm-port-source/derivation_resolve.ts",
  "scripts/ddm-port-source/derivation_statement.ts",
  "scripts/gen_derivation_tables.mjs",
  "scripts/gen_fact_quality_units.mjs",
]);

const EXACT_DESTINATIONS = new Map([
  [
    "shared/fact-lifecycle-contract.gen.ts",
    [PUBLISHED_CONTRACT_RELATIVE_PATH, CONSUMED_CONTRACT_RELATIVE_PATH],
  ],
  [
    "shared/fact-lint-catalog.gen.ts",
    [
      "contract/published/fact-lint-catalog.gen.ts",
      "shared/fact-lint-catalog.gen.ts",
    ],
  ],
  [
    "shared/fact-quality-units.gen.ts",
    ["shared/fact-quality/fact-quality-units.gen.ts"],
  ],
  ["src/derivation.ts", ["shared/ddm/derivation.ts"]],
  ["src/derivation_resolve.ts", ["shared/ddm/derivation_resolve.ts"]],
  ["src/derivation_statement.ts", ["shared/ddm/derivation_statement.ts"]],
  ["src/derivation_tables_gen.ts", ["shared/ddm/derivation_tables_gen.ts"]],
  ["src/unit_tables_gen.ts", ["shared/ddm/unit_tables_gen.ts"]],
  [
    "tests/fixtures/derivation_corpus.json",
    ["shared/ddm/fixtures/derivation_corpus.json"],
  ],
  [
    "tests/fixtures/derivation_cross_runtime.json",
    ["shared/ddm/fixtures/derivation_cross_runtime.json"],
  ],
  [
    "tests/fixtures/derivation_parity.json",
    ["shared/ddm/fixtures/derivation_parity.json"],
  ],
  ["tests/fixtures/derivation_tables.json", ["shared/ddm/fixtures/derivation_tables.json"]],
  ["tests/fixtures/unit_tables.json", ["shared/ddm/fixtures/unit_tables.json"]],
  [
    "tests/fixtures/key_normalization.json",
    ["shared/ddm/fixtures/key_normalization.json"],
  ],
  // Fact-quality definitions and parity fixtures adopted under their own tree
  // so the DDM fixture namespace stays scoped to derivation behavior.
  [
    "tests/fixtures/derivation_playable_candidates.json",
    ["shared/fact-quality/fixtures/derivation_playable_candidates.json"],
  ],
  [
    "tests/fixtures/fact_quality_pr611.json",
    ["shared/fact-quality/fixtures/fact_quality_pr611.json"],
  ],
  [
    "tests/fixtures/fact_quality_units.json",
    ["shared/fact-quality/fixtures/fact_quality_units.json"],
  ],
  [
    "tests/fixtures/guardrail_parity.json",
    ["shared/fact-quality/fixtures/guardrail_parity.json"],
  ],
  [
    "tests/fixtures/question_normalization.json",
    ["shared/fact-quality/fixtures/question_normalization.json"],
  ],
]);

/** A deliberately small error type so callers can distinguish bad config. */
export class ArtifactConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArtifactConfigError";
  }
}

/** True for a normalized POSIX repository-relative path. */
export function isSafeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\")) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  if (path.posix.normalize(value) !== value) return false;
  return !value.split("/").some((segment) => segment === ".." || segment === "");
}

/** Resolve a safe repository-relative path without allowing it to escape root. */
export function resolveRepositoryPath(root, relativePath) {
  if (!isSafeRelativePath(relativePath)) {
    throw new ArtifactConfigError(`Unsafe repository-relative path: ${JSON.stringify(relativePath)}.`);
  }
  const rootPath = path.resolve(root);
  const resolved = path.resolve(rootPath, ...relativePath.split("/"));
  const prefix = rootPath.endsWith(path.sep) ? rootPath : `${rootPath}${path.sep}`;
  if (resolved !== rootPath && !resolved.startsWith(prefix)) {
    throw new ArtifactConfigError(`Repository path escapes its root: ${relativePath}.`);
  }
  return resolved;
}

/** SHA-256 of bytes, returned as lowercase hexadecimal. */
export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ArtifactConfigError(`${field} must be a non-empty string.`);
  }
  return value;
}

function parseDigest(value, field) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value.toLowerCase())) {
    throw new ArtifactConfigError(`${field} must be a 64-character hexadecimal SHA-256 digest.`);
  }
  return value.toLowerCase();
}

function parseDestinationList(value, field) {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) {
    throw new ArtifactConfigError(`${field} must declare at least one destination.`);
  }
  const destinations = [];
  const seen = new Set();
  for (const destination of values) {
    requireString(destination, field);
    if (!isSafeRelativePath(destination)) {
      throw new ArtifactConfigError(
        `${field} contains an unsafe destination path: ${JSON.stringify(destination)}.`,
      );
    }
    if (seen.has(destination)) {
      throw new ArtifactConfigError(`${field} contains duplicate destination ${destination}.`);
    }
    seen.add(destination);
    destinations.push(destination);
  }
  return destinations;
}

function parseExplicitDestinations(parsed) {
  const declared = parsed.destinations ?? parsed.handoffDestinations;
  if (declared === undefined) return null;
  if (!isPlainObject(declared)) {
    throw new ArtifactConfigError("Manifest destinations must be an object keyed by source path.");
  }
  const normalized = {};
  for (const [sourcePath, value] of Object.entries(declared)) {
    if (!isSafeRelativePath(sourcePath)) {
      throw new ArtifactConfigError(`Manifest destination key is unsafe: ${sourcePath}.`);
    }
    normalized[sourcePath] = parseDestinationList(value, `destinations.${sourcePath}`);
  }
  return normalized;
}

/**
 * Parse and validate a handoff manifest. The returned object is a normalized
 * copy; unknown top-level metadata is intentionally preserved for forward
 * compatibility but is not used as an authority.
 */
export function parseManifest(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ArtifactConfigError(
      `Shared artifact manifest is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new ArtifactConfigError("Shared artifact manifest must be a JSON object.");
  }

  const sourceRepository = requireString(parsed.sourceRepository, "sourceRepository");
  const ddmVersion = requireString(parsed.ddmVersion, "ddmVersion");
  const contractVersion = parsed.contractVersion;
  if (
    !(
      (typeof contractVersion === "number" && Number.isSafeInteger(contractVersion) && contractVersion >= 0) ||
      (typeof contractVersion === "string" && contractVersion.trim() !== "")
    )
  ) {
    throw new ArtifactConfigError(
      "contractVersion must be a non-negative integer or a non-empty string.",
    );
  }

  if (!Array.isArray(parsed.coveredSourcePaths) || parsed.coveredSourcePaths.length === 0) {
    throw new ArtifactConfigError("coveredSourcePaths must be a non-empty array.");
  }
  const coveredSourcePaths = [];
  const seenSources = new Set();
  for (const sourcePath of parsed.coveredSourcePaths) {
    if (!isSafeRelativePath(sourcePath)) {
      throw new ArtifactConfigError(`coveredSourcePaths contains an unsafe path: ${sourcePath}.`);
    }
    if (seenSources.has(sourcePath)) {
      throw new ArtifactConfigError(`coveredSourcePaths contains a duplicate path: ${sourcePath}.`);
    }
    seenSources.add(sourcePath);
    coveredSourcePaths.push(sourcePath);
  }

  if (!isPlainObject(parsed.files)) {
    throw new ArtifactConfigError("files must be an object mapping covered paths to SHA-256 digests.");
  }
  const files = {};
  for (const [sourcePath, digest] of Object.entries(parsed.files)) {
    if (!seenSources.has(sourcePath)) {
      throw new ArtifactConfigError(`files contains a path absent from coveredSourcePaths: ${sourcePath}.`);
    }
    files[sourcePath] = parseDigest(digest, `files.${sourcePath}`);
  }
  for (const sourcePath of coveredSourcePaths) {
    if (files[sourcePath] === undefined) {
      throw new ArtifactConfigError(`files is missing covered source path: ${sourcePath}.`);
    }
  }

  let treeHash;
  if (parsed.treeHash !== undefined) {
    treeHash = parseDigest(parsed.treeHash, "treeHash");
  }
  let sourceCommit;
  if (parsed.sourceCommit !== undefined && parsed.sourceCommit !== null) {
    sourceCommit = requireString(parsed.sourceCommit, "sourceCommit");
    if (!COMMIT_PATTERN.test(sourceCommit)) {
      throw new ArtifactConfigError("sourceCommit must look like a hexadecimal git commit id.");
    }
  }

  return {
    ...parsed,
    sourceRepository,
    contractVersion,
    ddmVersion,
    coveredSourcePaths,
    files,
    ...(treeHash === undefined ? {} : { treeHash }),
    ...(sourceCommit === undefined ? {} : { sourceCommit }),
    ...(parseExplicitDestinations(parsed) === null
      ? {}
      : { destinations: parseExplicitDestinations(parsed) }),
  };
}

/** Parse adoption metadata written by the sync command. */
export function parseAdoption(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ArtifactConfigError(
      `${CONTRACT_ADOPTION_FILENAME} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isPlainObject(parsed) || typeof parsed.adopted !== "boolean") {
    throw new ArtifactConfigError(
      `${CONTRACT_ADOPTION_FILENAME} must contain a boolean adopted field.`,
    );
  }
  const version = parsed.contractVersion ?? null;
  if (
    version !== null &&
    !(
      (typeof version === "number" && Number.isSafeInteger(version) && version >= 0) ||
      (typeof version === "string" && version.trim() !== "")
    )
  ) {
    throw new ArtifactConfigError(
      `${CONTRACT_ADOPTION_FILENAME} contractVersion must be null, a non-negative integer, or a string.`,
    );
  }
  let sourceCommit;
  if (parsed.sourceCommit !== undefined && parsed.sourceCommit !== null) {
    sourceCommit = requireString(parsed.sourceCommit, `${CONTRACT_ADOPTION_FILENAME}.sourceCommit`);
    if (!COMMIT_PATTERN.test(sourceCommit)) {
      throw new ArtifactConfigError(
        `${CONTRACT_ADOPTION_FILENAME}.sourceCommit must look like a hexadecimal git commit id.`,
      );
    }
  }
  return { ...parsed, adopted: parsed.adopted, contractVersion: version, sourceCommit };
}

/** Read the declaration embedded in a generated contract artifact. */
export function parseContractVersion(source) {
  const numeric = source.match(/export\s+const\s+CONTRACT_VERSION\s*=\s*(-?\d+)\s*;/);
  if (numeric) return Number.parseInt(numeric[1], 10);
  const stringValue = source.match(/export\s+const\s+CONTRACT_VERSION\s*=\s*["']([^"']*)["']\s*;/);
  return stringValue ? stringValue[1] : null;
}

/** Return the fixed destination for a known handoff source, or null. */
export function canonicalDestinations(sourcePath) {
  const exact = EXACT_DESTINATIONS.get(sourcePath);
  if (exact) return [...exact];
  if (DDM_SOURCE_FILES.has(sourcePath)) {
    return [`shared/ddm/${path.posix.basename(sourcePath)}`];
  }
  if (FIXTURE_SOURCE_FILES.has(sourcePath)) {
    return [`shared/ddm/fixtures/${path.posix.basename(sourcePath)}`];
  }
  return null;
}

function isCoverageOnly(sourcePath) {
  return COVERAGE_ONLY_SOURCE_FILES.has(sourcePath);
}

/**
 * Build the declared handoff operations from a manifest. Coverage-only source
 * paths are deliberately omitted. A source that is neither a known coverage
 * path nor a known handoff path is rejected rather than silently ignored.
 */
export function getHandoffEntries(manifest) {
  const explicit = manifest.destinations ?? null;
  const entries = [];
  const destinationOwners = new Map();

  for (const sourcePath of manifest.coveredSourcePaths) {
    const declared = explicit?.[sourcePath];
    const destinations = declared ?? (isCoverageOnly(sourcePath) ? [] : canonicalDestinations(sourcePath));
    if (declared === undefined && !isCoverageOnly(sourcePath) && destinations === null) {
      throw new ArtifactConfigError(
        `Manifest source ${sourcePath} has no declared Admin handoff destination.`,
      );
    }
    if (destinations === null || destinations.length === 0) continue;

    for (const destination of destinations) {
      if (!isSafeRelativePath(destination)) {
        throw new ArtifactConfigError(`Unsafe handoff destination: ${destination}.`);
      }
      const previous = destinationOwners.get(destination);
      if (previous !== undefined) {
        throw new ArtifactConfigError(
          `Handoff destination ${destination} is declared by both ${previous} and ${sourcePath}.`,
        );
      }
      destinationOwners.set(destination, sourcePath);
      entries.push({
        sourcePath,
        destination,
        digest: manifest.files[sourcePath],
      });
    }
  }

  if (explicit !== null) {
    for (const sourcePath of Object.keys(explicit)) {
      if (!manifest.coveredSourcePaths.includes(sourcePath)) {
        throw new ArtifactConfigError(
          `Manifest destinations declares a source absent from coveredSourcePaths: ${sourcePath}.`,
        );
      }
    }
  }

  return entries;
}

/** Stable JSON used to compare two manifests without formatting differences. */
export function stableJson(value) {
  const sortKeys = (entry) => {
    if (Array.isArray(entry)) return entry.map(sortKeys);
    if (isPlainObject(entry)) {
      const sorted = {};
      for (const key of Object.keys(entry).sort()) sorted[key] = sortKeys(entry[key]);
      return sorted;
    }
    return entry;
  };
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function readBytes(readFile, filePath) {
  const value = readFile(filePath, "utf8");
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new ArtifactConfigError(`Reader returned a non-byte value for ${filePath}.`);
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function makeOutcome({ ok, exitCode, stdout = [], stderr = [], manifest = null }) {
  return { ok, exitCode, stdout, stderr, manifest };
}

function chooseExitCode(errors) {
  if (errors.some((error) => error.code === EXIT_CONFIG_UNREADABLE)) return EXIT_CONFIG_UNREADABLE;
  if (errors.some((error) => error.code === EXIT_UPSTREAM_MISMATCH)) return EXIT_UPSTREAM_MISMATCH;
  if (errors.some((error) => error.code === EXIT_ADOPTION_MISMATCH)) return EXIT_ADOPTION_MISMATCH;
  return EXIT_DIGEST_MISMATCH;
}

function compareManifestAuthority(local, upstream) {
  const differences = [];
  for (const field of ["sourceRepository", "contractVersion", "ddmVersion", "treeHash"]) {
    if (local[field] !== upstream[field]) differences.push(field);
  }
  if (stableJson(local.coveredSourcePaths) !== stableJson(upstream.coveredSourcePaths)) {
    differences.push("coveredSourcePaths");
  }
  const localFiles = Object.entries(local.files).sort(([left], [right]) => left.localeCompare(right));
  const upstreamFiles = Object.entries(upstream.files).sort(([left], [right]) => left.localeCompare(right));
  if (stableJson(localFiles) !== stableJson(upstreamFiles)) differences.push("files");
  return differences;
}

/**
 * Run the local, network-free integrity check. If `upstreamRoot` is supplied,
 * its manifest and covered source bytes are also checked; that mode remains
 * local filesystem I/O and is used by the task-06 handoff validation.
 */
export function runSharedArtifactCheck({
  root = process.cwd(),
  readFileSync: readFile = readFileSync,
  existsSync: exists = existsSync,
  statSync: stat = statSync,
  upstreamRoot = null,
  upstreamManifestPath = UPSTREAM_MANIFEST_RELATIVE_PATH,
} = {}) {
  const errors = [];
  const stdout = [];
  let manifest = null;

  let manifestText;
  try {
    manifestText = readFile(
      resolveRepositoryPath(root, SHARED_ARTIFACT_MANIFEST_RELATIVE_PATH),
      "utf8",
    );
    manifest = parseManifest(
      typeof manifestText === "string" ? manifestText : Buffer.from(manifestText).toString("utf8"),
    );
  } catch (error) {
    errors.push({
      code: EXIT_CONFIG_UNREADABLE,
      message: `check-shared-artifacts: cannot read ${SHARED_ARTIFACT_MANIFEST_RELATIVE_PATH}: ${describeError(error)}`,
    });
    return makeOutcome({
      ok: false,
      exitCode: EXIT_CONFIG_UNREADABLE,
      stderr: errors.map((entry) => entry.message),
    });
  }

  let adoption;
  try {
    adoption = parseAdoption(
      readFile(resolveRepositoryPath(root, CONTRACT_ADOPTION_FILENAME), "utf8"),
    );
    if (!adoption.adopted) {
      errors.push({
        code: EXIT_ADOPTION_MISMATCH,
        message: `check-shared-artifacts: ${CONTRACT_ADOPTION_FILENAME} records adopted: false; the local handoff is mandatory.`,
      });
    }
    if (adoption.contractVersion === null || adoption.contractVersion !== manifest.contractVersion) {
      errors.push({
        code: EXIT_ADOPTION_MISMATCH,
        message: `check-shared-artifacts: adoption Contract_Version ${JSON.stringify(adoption.contractVersion)} does not match manifest ${JSON.stringify(manifest.contractVersion)}.`,
      });
    }
  } catch (error) {
    errors.push({
      code: EXIT_ADOPTION_MISMATCH,
      message: `check-shared-artifacts: cannot read ${CONTRACT_ADOPTION_FILENAME}: ${describeError(error)}`,
    });
  }

  let entries;
  try {
    entries = getHandoffEntries(manifest);
  } catch (error) {
    errors.push({ code: EXIT_CONFIG_UNREADABLE, message: describeError(error) });
    entries = [];
  }

  for (const entry of entries) {
    let destinationPath;
    try {
      destinationPath = resolveRepositoryPath(root, entry.destination);
      if (!exists(destinationPath)) {
        throw new Error("file is missing");
      }
      if (stat(destinationPath).isFile() !== true) {
        throw new Error("path is not a regular file");
      }
      const actual = sha256(readBytes(readFile, destinationPath));
      if (actual !== entry.digest) {
        errors.push({
          code: EXIT_DIGEST_MISMATCH,
          message: `check-shared-artifacts: digest mismatch for ${entry.destination} (expected ${entry.digest}, got ${actual}).`,
        });
      }
    } catch (error) {
      errors.push({
        code: EXIT_DIGEST_MISMATCH,
        message: `check-shared-artifacts: cannot verify ${entry.destination}: ${describeError(error)}`,
      });
    }
  }

  if (adoption?.adopted && adoption.contractVersion === manifest.contractVersion) {
    try {
      const consumed = readBytes(
        readFile,
        resolveRepositoryPath(root, CONSUMED_CONTRACT_RELATIVE_PATH),
      );
      const published = readBytes(
        readFile,
        resolveRepositoryPath(root, PUBLISHED_CONTRACT_RELATIVE_PATH),
      );
      if (!consumed.equals(published)) {
        errors.push({
          code: EXIT_DIGEST_MISMATCH,
          message: `check-shared-artifacts: consumed and published contract copies are not byte-identical.`,
        });
      }
      const consumedVersion = parseContractVersion(consumed.toString("utf8"));
      if (consumedVersion !== manifest.contractVersion) {
        errors.push({
          code: EXIT_ADOPTION_MISMATCH,
          message: `check-shared-artifacts: consumed contract declares ${JSON.stringify(consumedVersion)}, expected ${JSON.stringify(manifest.contractVersion)}.`,
        });
      }
    } catch (error) {
      errors.push({
        code: EXIT_DIGEST_MISMATCH,
        message: `check-shared-artifacts: cannot inspect the consumed contract: ${describeError(error)}`,
      });
    }
  }

  if (upstreamRoot !== null && upstreamRoot !== undefined) {
    try {
      const upstreamManifestText = readFile(
        resolveRepositoryPath(upstreamRoot, upstreamManifestPath),
        "utf8",
      );
      const upstreamManifest = parseManifest(
        typeof upstreamManifestText === "string"
          ? upstreamManifestText
          : Buffer.from(upstreamManifestText).toString("utf8"),
      );
      const authorityDifferences = compareManifestAuthority(manifest, upstreamManifest);
      if (authorityDifferences.length > 0) {
        errors.push({
          code: EXIT_UPSTREAM_MISMATCH,
          message: `check-shared-artifacts: local manifest differs from upstream manifest in ${authorityDifferences.join(", ")}.`,
        });
      }
      for (const sourcePath of manifest.coveredSourcePaths) {
        const sourceBytes = readBytes(
          readFile,
          resolveRepositoryPath(upstreamRoot, sourcePath),
        );
        const actual = sha256(sourceBytes);
        if (actual !== manifest.files[sourcePath]) {
          errors.push({
            code: EXIT_UPSTREAM_MISMATCH,
            message: `check-shared-artifacts: upstream digest mismatch for ${sourcePath} (expected ${manifest.files[sourcePath]}, got ${actual}).`,
          });
        }
      }
    } catch (error) {
      errors.push({
        code: EXIT_UPSTREAM_MISMATCH,
        message: `check-shared-artifacts: upstream artifact source is unavailable: ${describeError(error)}`,
      });
    }
  }

  if (errors.length > 0) {
    return makeOutcome({
      ok: false,
      exitCode: chooseExitCode(errors),
      stdout,
      stderr: errors.map((entry) => entry.message),
      manifest,
    });
  }

  stdout.push(
    `check-shared-artifacts: OK — ${entries.length} local consumed/published artifact destination${entries.length === 1 ? "" : "s"} and Contract_Version ${JSON.stringify(manifest.contractVersion)} verified.`,
  );
  return makeOutcome({ ok: true, exitCode: EXIT_OK, stdout, stderr: [], manifest });
}

/** Compatibility aliases for callers that use the shorter command name. */
export const runArtifactIntegrityCheck = runSharedArtifactCheck;
export const runCheckSharedArtifacts = runSharedArtifactCheck;

function parseCliArgs(argv) {
  let upstreamRoot = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--upstream-root") {
      const value = argv[index + 1];
      if (!value) throw new ArtifactConfigError("--upstream-root requires a path.");
      upstreamRoot = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--upstream-root=")) {
      const value = argument.slice("--upstream-root=".length);
      if (!value) throw new ArtifactConfigError("--upstream-root requires a path.");
      upstreamRoot = value;
      continue;
    }
    throw new ArtifactConfigError(`Unsupported argument: ${argument}.`);
  }
  return { upstreamRoot };
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
    const parsed = parseCliArgs(process.argv.slice(2));
    options = {
      root: process.cwd(),
      upstreamRoot:
        parsed.upstreamRoot === null
          ? null
          : path.resolve(process.cwd(), parsed.upstreamRoot),
    };
  } catch (error) {
    process.stderr.write(`check-shared-artifacts: ${describeError(error)}\n`);
    process.exit(EXIT_CONFIG_UNREADABLE);
  }
  const outcome = runSharedArtifactCheck(options);
  for (const line of outcome.stdout) process.stdout.write(`${line}\n`);
  for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
  process.exit(outcome.exitCode);
}
