#!/usr/bin/env node
/**
 * Read-only upstream freshness check for the shared artifact handoff.
 *
 * Local integrity and upstream freshness are intentionally separate commands:
 * the Quality_Gate must remain network-free, while this command may use a
 * read-only GitHub API client. All upstream access is injected through
 * `fetchImpl` or an explicit metadata object, so the test suite can exercise
 * every failure mode without live I/O.
 *
 * A check passes only when the local handoff's source commit is still the
 * latest commit touching any covered source/generated path and the upstream
 * manifest agrees byte-for-byte at the authority level. Missing evidence is a
 * failure, never an implicit pass.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTRACT_ADOPTION_FILENAME,
  SHARED_ARTIFACT_MANIFEST_RELATIVE_PATH,
  UPSTREAM_MANIFEST_RELATIVE_PATH,
  parseAdoption,
  parseManifest,
  resolveRepositoryPath,
  sha256,
  stableJson,
} from "./check-shared-artifacts.mjs";

export const DEFAULT_UPSTREAM_REPOSITORY = "snaptapp/more-or-less";
export const DEFAULT_UPSTREAM_REF = "main";
export const DEFAULT_GITHUB_API_BASE = "https://api.github.com";
export const EXIT_FRESH_OK = 0;
export const EXIT_FRESH_MISSING_METADATA = 1;
export const EXIT_FRESH_UNAVAILABLE = 2;
export const EXIT_FRESH_DIGEST_MISMATCH = 3;
export const EXIT_FRESH_NEWER_COMMIT = 4;
export const EXIT_FRESH_CONFIG = 5;

const COMMIT_PATTERN = /^[a-f0-9]{7,64}$/i;

export class UpstreamUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "UpstreamUnavailableError";
  }
}

export class FreshnessConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "FreshnessConfigError";
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function readText(readFile, filePath) {
  const value = readFile(filePath, "utf8");
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  throw new Error(`reader returned a non-text value for ${filePath}`);
}

function authority(manifest) {
  return {
    sourceRepository: manifest.sourceRepository,
    contractVersion: manifest.contractVersion,
    ddmVersion: manifest.ddmVersion,
    treeHash: manifest.treeHash,
    coveredSourcePaths: manifest.coveredSourcePaths,
    files: manifest.files,
  };
}

function commitMatches(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const first = left.toLowerCase();
  const second = right.toLowerCase();
  return first === second || first.startsWith(second) || second.startsWith(first);
}

function normalizeCommit(value, field) {
  if (typeof value !== "string" || !COMMIT_PATTERN.test(value)) {
    throw new FreshnessConfigError(`${field} must be a hexadecimal git commit id.`);
  }
  return value;
}

function decodeManifestBody(body) {
  if (typeof body === "string") return body;
  if (!isPlainObject(body)) throw new Error("upstream manifest response is not JSON");
  if (isPlainObject(body.manifest)) return body.manifest;
  if (isPlainObject(body.artifactManifest)) return body.artifactManifest;
  if (typeof body.content === "string") {
    const content = body.content.replace(/\s+/g, "");
    const encoding = typeof body.encoding === "string" ? body.encoding : "base64";
    if (encoding !== "base64") throw new Error("upstream manifest content is not base64 encoded");
    return Buffer.from(content, "base64").toString("utf8");
  }
  if (typeof body.data === "string") return body.data;
  if (isPlainObject(body.data) && typeof body.data.content === "string") {
    return Buffer.from(body.data.content.replace(/\s+/g, ""), "base64").toString("utf8");
  }
  // GitHub's contents API may be replaced by a small test double returning the
  // decoded manifest object directly.
  if (isPlainObject(body) && Array.isArray(body.coveredSourcePaths)) return body;
  throw new Error("upstream manifest response has no manifest content");
}

function normalizeChangedPaths(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new FreshnessConfigError("changedPaths must be an array.");
  const paths = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new FreshnessConfigError("changedPaths must contain non-empty strings.");
    }
    paths.push(entry);
  }
  return [...new Set(paths)];
}

function normalizeCoveredCommits(value) {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) {
    throw new FreshnessConfigError("coveredCommits must be an object keyed by path.");
  }
  const commits = {};
  for (const [sourcePath, commit] of Object.entries(value)) {
    commits[sourcePath] = normalizeCommit(commit, `coveredCommits.${sourcePath}`);
  }
  return commits;
}

/**
 * Normalize a direct test/provider response. The same shape is returned by
 * `fetchUpstreamMetadata`, which lets callers inject either a response object
 * or a provider function.
 */
export function normalizeUpstreamMetadata(input) {
  if (!isPlainObject(input)) throw new FreshnessConfigError("upstream metadata must be an object.");
  if (input.available === false) throw new UpstreamUnavailableError("upstream metadata is unavailable.");
  const manifestValue = input.manifest ?? input.artifactManifest ?? input;
  const manifest = parseManifest(
    typeof manifestValue === "string" ? manifestValue : stableJson(manifestValue),
  );
  const sourceCommit =
    input.sourceCommit === undefined || input.sourceCommit === null
      ? manifest.sourceCommit
      : normalizeCommit(input.sourceCommit, "sourceCommit");
  const headCommit =
    input.headCommit === undefined || input.headCommit === null
      ? undefined
      : normalizeCommit(input.headCommit, "headCommit");
  const latestCoveredCommit =
    input.latestCoveredCommit === undefined || input.latestCoveredCommit === null
      ? undefined
      : normalizeCommit(input.latestCoveredCommit, "latestCoveredCommit");
  const coveredCommits = normalizeCoveredCommits(
    input.coveredCommits ?? input.latestCoveredCommits,
  );
  const changedPaths = normalizeChangedPaths(input.changedPaths ?? input.changedFiles);
  const manifestDigest =
    input.manifestDigest === undefined || input.manifestDigest === null
      ? null
      : input.manifestDigest;
  if (manifestDigest !== null && !/^[a-f0-9]{64}$/i.test(String(manifestDigest))) {
    throw new FreshnessConfigError("manifestDigest must be a SHA-256 digest when supplied.");
  }
  return {
    manifest,
    sourceCommit,
    headCommit,
    latestCoveredCommit,
    coveredCommits,
    changedPaths,
    manifestDigest: manifestDigest === null ? null : String(manifestDigest).toLowerCase(),
  };
}

function sameAuthority(left, right) {
  return stableJson(authority(left)) === stableJson(authority(right));
}

function localSourceCommit(adoption, manifest) {
  return adoption.sourceCommit ?? manifest.sourceCommit ?? null;
}

/**
 * Pure freshness decision function. It is exported so all failure branches can
 * be tested with ordinary objects and without a network client.
 */
export function evaluateArtifactFreshness({ localManifest, adoption, upstream }) {
  const normalizedUpstream = normalizeUpstreamMetadata(upstream);
  const sourceCommit = localSourceCommit(adoption, localManifest);
  const failures = [];

  if (sourceCommit === null || sourceCommit === undefined) {
    failures.push({
      code: EXIT_FRESH_MISSING_METADATA,
      message:
        "check-artifact-freshness: missing upstream metadata — the local adoption record has no sourceCommit.",
    });
  }

  if (!sameAuthority(localManifest, normalizedUpstream.manifest)) {
    failures.push({
      code: EXIT_FRESH_DIGEST_MISMATCH,
      message: "check-artifact-freshness: digest mismatch — the local and upstream artifact manifests differ.",
    });
  }

  if (
    normalizedUpstream.manifestDigest !== null &&
    normalizedUpstream.manifestDigest !== sha256(Buffer.from(stableJson(normalizedUpstream.manifest), "utf8"))
  ) {
    failures.push({
      code: EXIT_FRESH_DIGEST_MISMATCH,
      message: "check-artifact-freshness: digest mismatch — the upstream manifest digest does not match its content.",
    });
  }

  const covered = new Set([
    ...localManifest.coveredSourcePaths,
    ...normalizedUpstream.manifest.coveredSourcePaths,
    UPSTREAM_MANIFEST_RELATIVE_PATH,
  ]);
  const changedCovered = normalizedUpstream.changedPaths.filter((changedPath) => covered.has(changedPath));
  const newerCovered = [];
  for (const [sourcePath, latestCommit] of Object.entries(normalizedUpstream.coveredCommits)) {
    if (covered.has(sourcePath) && !commitMatches(latestCommit, sourceCommit)) {
      newerCovered.push(`${sourcePath} (${latestCommit})`);
    }
  }
  if (
    normalizedUpstream.latestCoveredCommit !== undefined &&
    !commitMatches(normalizedUpstream.latestCoveredCommit, sourceCommit)
  ) {
    newerCovered.push(`covered paths (${normalizedUpstream.latestCoveredCommit})`);
  }

  if (normalizedUpstream.sourceCommit !== undefined && !commitMatches(normalizedUpstream.sourceCommit, sourceCommit)) {
    newerCovered.push(`upstream manifest sourceCommit (${normalizedUpstream.sourceCommit})`);
  }

  const hasCommitEvidence =
    normalizedUpstream.sourceCommit !== undefined ||
    normalizedUpstream.headCommit !== undefined ||
    normalizedUpstream.latestCoveredCommit !== undefined ||
    Object.keys(normalizedUpstream.coveredCommits).length > 0;
  if (!hasCommitEvidence) {
    failures.push({
      code: EXIT_FRESH_MISSING_METADATA,
      message: "check-artifact-freshness: missing upstream metadata — no latest covered-path commit was supplied.",
    });
  }

  if (newerCovered.length > 0) {
    failures.push({
      code: EXIT_FRESH_NEWER_COMMIT,
      message: `check-artifact-freshness: newer commit touches covered source/generated paths: ${newerCovered.join(", ")}.`,
    });
  } else if (changedCovered.length > 0) {
    const head = normalizedUpstream.headCommit;
    if (head === undefined || !commitMatches(head, sourceCommit)) {
      failures.push({
        code: EXIT_FRESH_NEWER_COMMIT,
        message: `check-artifact-freshness: newer commit touches covered source/generated paths: ${changedCovered.join(", ")}.`,
      });
    }
  } else if (
    normalizedUpstream.headCommit !== undefined &&
    !commitMatches(normalizedUpstream.headCommit, sourceCommit) &&
    Object.keys(normalizedUpstream.coveredCommits).length === 0 &&
    normalizedUpstream.latestCoveredCommit === undefined
  ) {
    // An unrelated head commit is harmless, but without per-path metadata we
    // cannot prove that. Fail closed rather than guessing from the head alone.
    failures.push({
      code: EXIT_FRESH_MISSING_METADATA,
      message: `check-artifact-freshness: missing upstream metadata — cannot prove whether head ${normalizedUpstream.headCommit} touched covered paths.`,
    });
  }

  if (failures.length > 0) {
    const priority = [
      EXIT_FRESH_MISSING_METADATA,
      EXIT_FRESH_DIGEST_MISMATCH,
      EXIT_FRESH_NEWER_COMMIT,
    ];
    const exitCode = priority.find((code) => failures.some((failure) => failure.code === code));
    return {
      ok: false,
      exitCode,
      stdout: [],
      stderr: failures.map((failure) => failure.message),
      sourceCommit,
      upstream: normalizedUpstream,
    };
  }

  return {
    ok: true,
    exitCode: EXIT_FRESH_OK,
    stdout: [
      `check-artifact-freshness: OK — upstream handoff is current at source commit ${sourceCommit}.`,
    ],
    stderr: [],
    sourceCommit,
    upstream: normalizedUpstream,
  };
}

async function responseJson(fetchImpl, url, headers) {
  let response;
  try {
    response = await fetchImpl(url, { method: "GET", headers });
  } catch (error) {
    throw new UpstreamUnavailableError(`request failed: ${describeError(error)}`);
  }
  if (!response) throw new UpstreamUnavailableError("upstream returned no response.");
  if (response.ok === false || (typeof response.status === "number" && response.status >= 400)) {
    throw new UpstreamUnavailableError(
      `upstream returned HTTP ${response.status ?? "error"}.`,
    );
  }
  try {
    if (typeof response.json === "function") return await response.json();
    if (typeof response.text === "function") return JSON.parse(await response.text());
    return response;
  } catch (error) {
    throw new UpstreamUnavailableError(`upstream returned invalid JSON: ${describeError(error)}`);
  }
}

function apiHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (typeof token === "string" && token.trim() !== "") {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

function contentUrl(apiBase, repository, ref, sourcePath) {
  const repositoryParts = repository.split("/").map((part) => encodeURIComponent(part));
  return `${apiBase.replace(/\/$/, "")}/repos/${repositoryParts.join("/")}/contents/${encodeURIComponent(sourcePath)}?ref=${encodeURIComponent(ref)}`;
}

function commitsUrl(apiBase, repository, ref, sourcePath) {
  const repositoryParts = repository.split("/").map((part) => encodeURIComponent(part));
  return `${apiBase.replace(/\/$/, "")}/repos/${repositoryParts.join("/")}/commits?path=${encodeURIComponent(sourcePath)}&sha=${encodeURIComponent(ref)}&per_page=1`;
}

function latestCommitFromBody(body) {
  const entry = Array.isArray(body) ? body[0] : body;
  if (!isPlainObject(entry)) return null;
  if (typeof entry.sha === "string") return entry.sha;
  if (isPlainObject(entry.commit) && typeof entry.commit.sha === "string") return entry.commit.sha;
  return null;
}

/**
 * Fetch the upstream manifest and the latest commit for every covered path.
 * Only GET requests are made. The function accepts a fetch implementation so
 * tests can provide deterministic responses without touching the network.
 */
export async function fetchUpstreamMetadata({
  fetchImpl = globalThis.fetch,
  repository = DEFAULT_UPSTREAM_REPOSITORY,
  ref = DEFAULT_UPSTREAM_REF,
  apiBase = DEFAULT_GITHUB_API_BASE,
  token = undefined,
  upstreamManifestPath = UPSTREAM_MANIFEST_RELATIVE_PATH,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new UpstreamUnavailableError("no upstream fetch implementation is available.");
  }
  const headers = apiHeaders(token);
  let manifestBody;
  try {
    manifestBody = await responseJson(
      fetchImpl,
      contentUrl(apiBase, repository, ref, upstreamManifestPath),
      headers,
    );
  } catch (error) {
    if (error instanceof UpstreamUnavailableError) throw error;
    throw new UpstreamUnavailableError(describeError(error));
  }

  let manifest;
  try {
    const decodedManifest = decodeManifestBody(manifestBody);
    const manifestObject = typeof decodedManifest === "string" ? JSON.parse(decodedManifest) : decodedManifest;
    manifest = parseManifest(stableJson(manifestObject));
  } catch (error) {
    throw new UpstreamUnavailableError(`invalid upstream manifest: ${describeError(error)}`);
  }

  // A provider double may return all freshness evidence alongside the
  // manifest. Avoid extra requests in that case while still validating it
  // through the same normalizer below.
  if (
    isPlainObject(manifestBody) &&
    (manifestBody.sourceCommit !== undefined ||
      manifestBody.headCommit !== undefined ||
      manifestBody.coveredCommits !== undefined ||
      manifestBody.changedPaths !== undefined)
  ) {
    return normalizeUpstreamMetadata({ ...manifestBody, manifest });
  }

  const coveredPaths = [...new Set([...manifest.coveredSourcePaths, upstreamManifestPath])];
  const commitEntries = await Promise.all(
    coveredPaths.map(async (sourcePath) => {
      let body;
      try {
        body = await responseJson(
          fetchImpl,
          commitsUrl(apiBase, repository, ref, sourcePath),
          headers,
        );
      } catch (error) {
        if (error instanceof UpstreamUnavailableError) throw error;
        throw new UpstreamUnavailableError(describeError(error));
      }
      const commit = latestCommitFromBody(body);
      if (commit === null) {
        throw new UpstreamUnavailableError(
          `upstream metadata has no commit for covered path ${sourcePath}.`,
        );
      }
      return [sourcePath, commit];
    }),
  );
  return normalizeUpstreamMetadata({
    manifest,
    coveredCommits: Object.fromEntries(commitEntries),
  });
}

function readLocalInputs(root, readFile) {
  const manifest = parseManifest(
    readText(readFile, resolveRepositoryPath(root, SHARED_ARTIFACT_MANIFEST_RELATIVE_PATH)),
  );
  const adoption = parseAdoption(
    readText(readFile, resolveRepositoryPath(root, CONTRACT_ADOPTION_FILENAME)),
  );
  return { manifest, adoption };
}

function readLocalUpstreamMetadata(upstreamRoot, upstreamManifestPath, readFile) {
  const manifest = parseManifest(
    readText(readFile, resolveRepositoryPath(upstreamRoot, upstreamManifestPath)),
  );
  return normalizeUpstreamMetadata({ manifest });
}

/**
 * Run the read-only freshness check. `upstreamMetadata` or `metadataProvider`
 * bypasses HTTP entirely; otherwise the injected/default fetch client is used.
 */
export async function runArtifactFreshnessCheck({
  root = process.cwd(),
  readFileSync: readFile = readFileSync,
  upstreamMetadata = undefined,
  metadataProvider = undefined,
  fetchImpl,
  repository = DEFAULT_UPSTREAM_REPOSITORY,
  ref = DEFAULT_UPSTREAM_REF,
  apiBase = DEFAULT_GITHUB_API_BASE,
  token,
  upstreamRoot = null,
  upstreamManifestPath = UPSTREAM_MANIFEST_RELATIVE_PATH,
} = {}) {
  let local;
  try {
    local = readLocalInputs(root, readFile);
  } catch (error) {
    return {
      ok: false,
      exitCode: EXIT_FRESH_CONFIG,
      stdout: [],
      stderr: [`check-artifact-freshness: cannot read local handoff metadata: ${describeError(error)}`],
    };
  }

  let upstream;
  try {
    if (metadataProvider !== undefined) {
      upstream = await metadataProvider();
    } else if (upstreamMetadata !== undefined) {
      upstream = upstreamMetadata;
    } else if (upstreamRoot !== null && upstreamRoot !== undefined) {
      upstream = readLocalUpstreamMetadata(
        path.resolve(root, upstreamRoot),
        upstreamManifestPath,
        readFile,
      );
    } else {
      upstream = await fetchUpstreamMetadata({
        fetchImpl,
        repository,
        ref,
        apiBase,
        token,
        upstreamManifestPath,
      });
    }
  } catch (error) {
    const code = error instanceof UpstreamUnavailableError
      ? EXIT_FRESH_UNAVAILABLE
      : EXIT_FRESH_CONFIG;
    return {
      ok: false,
      exitCode: code,
      stdout: [],
      stderr: [`check-artifact-freshness: upstream check unavailable: ${describeError(error)}`],
    };
  }

  try {
    return evaluateArtifactFreshness({
      localManifest: local.manifest,
      adoption: local.adoption,
      upstream,
    });
  } catch (error) {
    return {
      ok: false,
      exitCode: EXIT_FRESH_CONFIG,
      stdout: [],
      stderr: [`check-artifact-freshness: invalid freshness metadata: ${describeError(error)}`],
    };
  }
}

function parseCliArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repository" || argument === "--ref" || argument === "--api-base" || argument === "--upstream-root") {
      if (!argv[index + 1]) throw new FreshnessConfigError(`${argument} requires a value.`);
      options[argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[index + 1];
      index += 1;
      continue;
    }
    const match = /^--(repository|ref|api-base|upstream-root)=(.+)$/.exec(argument);
    if (match) {
      const key = match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      options[key] = match[2];
      continue;
    }
    throw new FreshnessConfigError(`Unsupported argument: ${argument}.`);
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
    process.stderr.write(`check-artifact-freshness: ${describeError(error)}\n`);
    process.exit(EXIT_FRESH_CONFIG);
  }
  const outcome = await runArtifactFreshnessCheck({
    root: process.cwd(),
    repository: options.repository,
    ref: options.ref,
    apiBase: options.apiBase,
    upstreamRoot: options.upstreamRoot,
    token: process.env.GITHUB_TOKEN,
  });
  for (const line of outcome.stdout) process.stdout.write(`${line}\n`);
  for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
  process.exit(outcome.exitCode);
}
