#!/usr/bin/env node
/**
 * Contract_Drift_Check (Admin_Repository side) — Requirements 9.7, 10.4, 10.5, 10.8.
 *
 * Standalone: takes no arguments, uses only Node builtins. Exposed as
 * `npm run check:contract` and, once `contract-adoption.json` records adoption,
 * as the final member of Quality_Gate (scripts/quality-gate.mjs). Until adoption
 * flips the gate excludes it, so this member is verified by direct invocation.
 *
 * What it does:
 *   - Resolves a TRACKED reference to the Shared_Contract_Artifact copy published by
 *     Main_Repository. The reference lives in `contract-source.json` at the repository
 *     root (field `publishedArtifactPath`), a repo-relative path. Both repositories are
 *     checked out side by side, so the default reference is
 *     `../more-or-less/shared/fact-lifecycle-contract.gen.ts` (Requirement 10.4).
 *   - Reads the consumed copy (`shared/fact-lifecycle-contract.gen.ts`) and the
 *     recorded Contract_Version (`contract-adoption.json` → `contractVersion`).
 *   - Compares consumed bytes vs published bytes AND recorded version vs the published
 *     artifact's `CONTRACT_VERSION`.
 *
 * Outcomes:
 *   - Byte-identical AND recorded version equals published `CONTRACT_VERSION` → exit 0,
 *     nothing on stderr, consumed copy unmodified, within 60 s (Requirement 10.4).
 *   - Version mismatch → stderr names both versions, exit non-zero, reported within 5 s
 *     (Requirements 9.7, 10.5). A version mismatch short-circuits before any byte diff so
 *     it stays well within the 5 s budget.
 *   - Byte difference → stderr names the differing field/value names together with each
 *     copy's version, consumed copy unmodified, exit non-zero (Requirement 10.5).
 *   - Published copy not resolvable/readable due to a transient condition → retried up to
 *     3 attempts within a 60 s total budget; on exhaustion the attempted reference is
 *     written to stderr, the condition is NOT treated as a pass, exit non-zero
 *     (Requirement 10.8).
 *
 * The module exports pure helpers (`parseSourceReference`, `parseRecordedVersion`,
 * `parseContractVersion`, `extractContractFields`, `diffContractFields`, `isTransientReadError`)
 * and an injectable runner (`runContractDriftCheck`) that accepts `readFileSync`, a clock,
 * and a sleeper so tests can drive drift, version skew, and transient-unreachability retries
 * deterministically. The CLI shell at the bottom runs only on direct invocation.
 */

import { readFileSync as realReadFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Tracked reference to the published artifact, at the repository root. */
export const CONTRACT_SOURCE_FILENAME = "contract-source.json";

/** Tracked adoption flag carrying the recorded Contract_Version. */
export const CONTRACT_ADOPTION_FILENAME = "contract-adoption.json";

/** The consumed Shared_Contract_Artifact copy, relative to the repository root. */
export const CONSUMED_ARTIFACT_RELATIVE_PATH = "shared/fact-lifecycle-contract.gen.ts";

/** Exit code when the consumed and published copies (bytes or versions) disagree. */
export const EXIT_DRIFT = 1;

/** Exit code when the published copy is unreachable after the retry budget is spent. */
export const EXIT_UNREACHABLE = 2;

/** Exit code when local tracked configuration cannot be read/parsed (fail closed). */
export const EXIT_CONFIG_UNREADABLE = 3;

/** Retry budget for a transient unreachability of the published copy (Requirement 10.8). */
export const MAX_ATTEMPTS = 3;

/** Total wall-clock budget, in ms, for the transient-unreachability retries (Requirement 10.8). */
export const TOTAL_RETRY_BUDGET_MS = 60_000;

/** Base backoff, in ms, between retry attempts (kept small so 3 tries fit inside the budget). */
export const RETRY_BACKOFF_MS = 250;

/** Node error codes treated as transient (worth retrying) rather than a hard "drifted"/"missing". */
const TRANSIENT_ERROR_CODES = new Set([
  "EBUSY",
  "EAGAIN",
  "EMFILE",
  "ENFILE",
  "ETIMEDOUT",
  "EACCES",
  "EPERM",
  "ENOTDIR",
  "EIO",
  "EBADF",
]);

/** Raised when a tracked configuration file exists but is not a usable document. */
export class ConfigFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigFormatError";
  }
}

/**
 * True when a filesystem read error looks transient (a retry might succeed), rather than a
 * definitive "the file is not there" (which is real drift, not a transient condition).
 * A missing file (`ENOENT`) is deliberately NOT transient.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isTransientReadError(error) {
  const code = error && typeof error === "object" ? String(error.code ?? "") : "";
  return TRANSIENT_ERROR_CODES.has(code);
}

/**
 * Parses `contract-source.json`. Requires an object carrying a non-empty string
 * `publishedArtifactPath`. Fails closed on anything else.
 *
 * @param {string} text
 * @returns {{ publishedArtifactPath: string }}
 * @throws {ConfigFormatError}
 */
export function parseSourceReference(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigFormatError(
      `${CONTRACT_SOURCE_FILENAME} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigFormatError(
      `${CONTRACT_SOURCE_FILENAME} must be a JSON object carrying "publishedArtifactPath".`,
    );
  }
  const reference = parsed.publishedArtifactPath;
  if (typeof reference !== "string" || reference.trim() === "") {
    throw new ConfigFormatError(
      `${CONTRACT_SOURCE_FILENAME} must carry a non-empty string "publishedArtifactPath", got ${JSON.stringify(
        reference,
      )}.`,
    );
  }
  return { publishedArtifactPath: reference };
}

/**
 * Parses `contract-adoption.json` and returns the recorded Contract_Version. The version is
 * null, a non-negative integer, or a string. Fails closed on a malformed document.
 *
 * @param {string} text
 * @returns {{ adopted: boolean, contractVersion: number | string | null }}
 * @throws {ConfigFormatError}
 */
export function parseRecordedVersion(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigFormatError(
      `${CONTRACT_ADOPTION_FILENAME} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigFormatError(
      `${CONTRACT_ADOPTION_FILENAME} must be a JSON object carrying "contractVersion".`,
    );
  }
  const version = parsed.contractVersion ?? null;
  if (
    version !== null &&
    typeof version !== "string" &&
    !(typeof version === "number" && Number.isInteger(version) && version >= 0)
  ) {
    throw new ConfigFormatError(
      `${CONTRACT_ADOPTION_FILENAME} "contractVersion" must be null, a non-negative integer, or a string, got ${JSON.stringify(
        version,
      )}.`,
    );
  }
  return { adopted: parsed.adopted === true, contractVersion: version };
}

/**
 * Extracts the `CONTRACT_VERSION` value declared in a Shared_Contract_Artifact source.
 * Accepts an integer or a quoted string literal. Returns null when the declaration is absent.
 *
 * @param {string} source
 * @returns {number | string | null}
 */
export function parseContractVersion(source) {
  const numeric = source.match(/export\s+const\s+CONTRACT_VERSION\s*=\s*(-?\d+)\s*;/);
  if (numeric) return Number.parseInt(numeric[1], 10);
  const stringy = source.match(/export\s+const\s+CONTRACT_VERSION\s*=\s*["']([^"']*)["']\s*;/);
  if (stringy) return stringy[1];
  return null;
}

/**
 * Extracts the named field/value groups from a Shared_Contract_Artifact source so a drift can
 * be reported by field/value name rather than as an opaque byte offset (Requirement 10.5).
 * Purely lexical — it reads the generated `as const` arrays and the transition tuples.
 *
 * @param {string} source
 * @returns {{
 *   contractVersion: number | string | null,
 *   factStatuses: string[],
 *   quantityKinds: string[],
 *   transitions: string[],
 *   lifecycleFields: string[],
 * }}
 */
export function extractContractFields(source) {
  return {
    contractVersion: parseContractVersion(source),
    factStatuses: parseStringArrayConst(source, "FACT_STATUSES"),
    quantityKinds: parseStringArrayConst(source, "QUANTITY_KINDS"),
    transitions: parseTransitionTuples(source),
    lifecycleFields: parseFieldDescriptorNames(source),
  };
}

/** Reads the string members of an `export const NAME = [ "a", "b" ] as const;` declaration. */
function parseStringArrayConst(source, constName) {
  const escaped = constName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(`export\\s+const\\s+${escaped}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "m");
  const match = source.match(declaration);
  if (!match) return [];
  const values = [];
  const stringLiteral = /["']([^"']*)["']/g;
  let hit;
  while ((hit = stringLiteral.exec(match[1])) !== null) {
    values.push(hit[1]);
  }
  return values;
}

/** Reads the `{ from, to, adminAuthorized }` transition tuples as stable "from->to:flag" strings. */
function parseTransitionTuples(source) {
  const block = source.match(/STATUS_TRANSITIONS[^=]*=\s*\[([\s\S]*?)\]\s*as\s+const/m);
  if (!block) return [];
  const tuples = [];
  const tuple = /\{\s*from:\s*["']([^"']*)["']\s*,\s*to:\s*["']([^"']*)["']\s*,\s*adminAuthorized:\s*(true|false)\s*\}/g;
  let hit;
  while ((hit = tuple.exec(block[1])) !== null) {
    tuples.push(`${hit[1]}->${hit[2]}:${hit[3]}`);
  }
  return tuples;
}

/** Reads the `{ name, type, required }` lifecycle field descriptors as "name:type:required" strings. */
function parseFieldDescriptorNames(source) {
  const block = source.match(/LIFECYCLE_FIELDS[^=]*=\s*\[([\s\S]*?)\]\s*as\s+const/m);
  if (!block) return [];
  const fields = [];
  const descriptor = /\{\s*name:\s*["']([^"']*)["']\s*,\s*type:\s*["']([^"']*)["']\s*,\s*required:\s*(true|false)\s*\}/g;
  let hit;
  while ((hit = descriptor.exec(block[1])) !== null) {
    fields.push(`${hit[1]}:${hit[2]}:${hit[3]}`);
  }
  return fields;
}

/** Set-symmetric-difference of two string arrays, sorted, as "-only-in-a" / "+only-in-b" tags. */
function symmetricDifference(consumed, published) {
  const consumedSet = new Set(consumed);
  const publishedSet = new Set(published);
  const diffs = [];
  for (const value of consumed) {
    if (!publishedSet.has(value)) diffs.push(`consumed-only: ${value}`);
  }
  for (const value of published) {
    if (!consumedSet.has(value)) diffs.push(`published-only: ${value}`);
  }
  return diffs.sort();
}

/**
 * Compares the extracted field groups of the consumed and published artifacts and returns a
 * list of human-readable field/value-name differences (Requirement 10.5). Empty when the two
 * agree on every named group.
 *
 * @param {ReturnType<typeof extractContractFields>} consumed
 * @param {ReturnType<typeof extractContractFields>} published
 * @returns {string[]}
 */
export function diffContractFields(consumed, published) {
  const differences = [];

  if (consumed.contractVersion !== published.contractVersion) {
    differences.push(
      `CONTRACT_VERSION: consumed ${JSON.stringify(consumed.contractVersion)} vs published ${JSON.stringify(
        published.contractVersion,
      )}`,
    );
  }

  const groups = [
    ["FACT_STATUSES", consumed.factStatuses, published.factStatuses],
    ["QUANTITY_KINDS", consumed.quantityKinds, published.quantityKinds],
    ["STATUS_TRANSITIONS", consumed.transitions, published.transitions],
    ["LIFECYCLE_FIELDS", consumed.lifecycleFields, published.lifecycleFields],
  ];
  for (const [name, a, b] of groups) {
    const groupDiff = symmetricDifference(a, b);
    for (const entry of groupDiff) {
      differences.push(`${name}: ${entry}`);
    }
  }

  return differences;
}

/** Sleeps for `ms` (used only on the transient-retry path). Injectable via the runner. */
function defaultSleep(ms) {
  const end = Date.now() + ms;
  // Busy-wait with a coarse granularity; the retry path is exceptional and the budget is
  // enforced by the caller, so this never spins for long.
  while (Date.now() < end) {
    // intentionally empty
  }
}

/**
 * Reads the published artifact, retrying transient failures up to `MAX_ATTEMPTS` times within
 * `TOTAL_RETRY_BUDGET_MS` (Requirement 10.8). Returns the source text, or a structured failure
 * describing why the published copy is unreachable.
 *
 * @param {{
 *   publishedAbsPath: string,
 *   readFileSync: typeof realReadFileSync,
 *   now: () => number,
 *   sleep: (ms: number) => void,
 * }} deps
 * @returns {{ ok: true, source: string } | { ok: false, attempts: number, lastError: string }}
 */
function readPublishedWithRetry({ publishedAbsPath, readFileSync, now, sleep }) {
  const startedAt = now();
  let attempts = 0;
  let lastError = "";

  while (attempts < MAX_ATTEMPTS && now() - startedAt < TOTAL_RETRY_BUDGET_MS) {
    attempts += 1;
    try {
      return { ok: true, source: readFileSync(publishedAbsPath, "utf8") };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (!isTransientReadError(error)) {
        // Not transient (e.g. ENOENT — the published copy is simply not where the tracked
        // reference points). No point retrying; report as unreachable immediately.
        return { ok: false, attempts, lastError };
      }
      const remaining = TOTAL_RETRY_BUDGET_MS - (now() - startedAt);
      if (attempts < MAX_ATTEMPTS && remaining > RETRY_BACKOFF_MS) {
        sleep(RETRY_BACKOFF_MS);
      }
    }
  }

  return { ok: false, attempts, lastError };
}

/**
 * Runs Contract_Drift_Check. Returns the outcome instead of writing/exiting, so tests can
 * assert on it. Never modifies the consumed copy.
 *
 * @param {{
 *   root?: string,
 *   readFileSync?: typeof realReadFileSync,
 *   now?: () => number,
 *   sleep?: (ms: number) => void,
 * }} [options]
 * @returns {{ ok: boolean, exitCode: number, stdout: string[], stderr: string[] }}
 */
export function runContractDriftCheck({
  root = process.cwd(),
  readFileSync = realReadFileSync,
  now = () => Date.now(),
  sleep = defaultSleep,
} = {}) {
  const stdout = [];
  const stderr = [];

  // 1. Local tracked configuration — fail closed if unreadable/malformed.
  let reference;
  let recorded;
  let consumedSource;
  try {
    reference = parseSourceReference(
      readFileSync(path.join(root, CONTRACT_SOURCE_FILENAME), "utf8"),
    );
  } catch (error) {
    stderr.push(
      `check-contract-drift: cannot read the tracked source reference: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { ok: false, exitCode: EXIT_CONFIG_UNREADABLE, stdout, stderr };
  }
  try {
    recorded = parseRecordedVersion(
      readFileSync(path.join(root, CONTRACT_ADOPTION_FILENAME), "utf8"),
    );
  } catch (error) {
    stderr.push(
      `check-contract-drift: cannot read the recorded contract version: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { ok: false, exitCode: EXIT_CONFIG_UNREADABLE, stdout, stderr };
  }
  try {
    consumedSource = readFileSync(path.join(root, CONSUMED_ARTIFACT_RELATIVE_PATH), "utf8");
  } catch (error) {
    stderr.push(
      `check-contract-drift: cannot read the consumed artifact ${CONSUMED_ARTIFACT_RELATIVE_PATH}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { ok: false, exitCode: EXIT_CONFIG_UNREADABLE, stdout, stderr };
  }

  const publishedAbsPath = path.resolve(root, reference.publishedArtifactPath);

  // 2. Resolve/read the published copy, retrying transient unreachability (Requirement 10.8).
  const read = readPublishedWithRetry({ publishedAbsPath, readFileSync, now, sleep });
  if (!read.ok) {
    stderr.push(
      `check-contract-drift: the published Shared_Contract_Artifact copy is unreachable after ${read.attempts} attempt${
        read.attempts === 1 ? "" : "s"
      }.`,
    );
    stderr.push(
      `check-contract-drift: attempted reference: ${reference.publishedArtifactPath} (resolved to ${publishedAbsPath}).`,
    );
    if (read.lastError) {
      stderr.push(`check-contract-drift: last error: ${read.lastError}`);
    }
    stderr.push(
      "check-contract-drift: an unreachable published copy is not a pass; failing closed.",
    );
    return { ok: false, exitCode: EXIT_UNREACHABLE, stdout, stderr };
  }

  const publishedSource = read.source;
  const publishedVersion = parseContractVersion(publishedSource);
  const recordedVersion = recorded.contractVersion;

  // 3. Version comparison first — cheap and reported within 5 s (Requirements 9.7, 10.5).
  if (recordedVersion !== publishedVersion) {
    stderr.push(
      `check-contract-drift: Contract_Version mismatch — recorded ${JSON.stringify(
        recordedVersion,
      )} (in ${CONTRACT_ADOPTION_FILENAME}) vs published ${JSON.stringify(publishedVersion)} (in ${
        reference.publishedArtifactPath
      }).`,
    );
    stderr.push(
      "check-contract-drift: update the consumed copy and the recorded contractVersion to match the published artifact.",
    );
    return { ok: false, exitCode: EXIT_DRIFT, stdout, stderr };
  }

  // 4. Byte comparison — the authoritative equality check (Requirement 10.4/10.5).
  const consumedBytes = Buffer.from(consumedSource, "utf8");
  const publishedBytes = Buffer.from(publishedSource, "utf8");
  if (!consumedBytes.equals(publishedBytes)) {
    const fieldDiffs = diffContractFields(
      extractContractFields(consumedSource),
      extractContractFields(publishedSource),
    );
    stderr.push(
      `check-contract-drift: the consumed Shared_Contract_Artifact copy differs from the published copy (recorded version ${JSON.stringify(
        recordedVersion,
      )}, published version ${JSON.stringify(publishedVersion)}).`,
    );
    if (fieldDiffs.length > 0) {
      stderr.push("check-contract-drift: differing fields/values:");
      for (const diff of fieldDiffs) {
        stderr.push(`  ${diff}`);
      }
    } else {
      stderr.push(
        "check-contract-drift: the named contract fields agree but the bytes differ (formatting or header drift); regenerate the consumed copy from Main_Repository.",
      );
    }
    stderr.push(
      `check-contract-drift: replace ${CONSUMED_ARTIFACT_RELATIVE_PATH} with the published copy from ${reference.publishedArtifactPath}.`,
    );
    return { ok: false, exitCode: EXIT_DRIFT, stdout, stderr };
  }

  stdout.push(
    `check-contract-drift: OK — consumed copy is byte-identical to the published copy and Contract_Version ${JSON.stringify(
      publishedVersion,
    )} matches.`,
  );
  return { ok: true, exitCode: 0, stdout, stderr };
}

function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  const outcome = runContractDriftCheck({ root: process.cwd() });
  for (const line of outcome.stdout) process.stdout.write(`${line}\n`);
  for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
  process.exit(outcome.exitCode);
}
