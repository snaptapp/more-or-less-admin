#!/usr/bin/env node
/**
 * Quality_Gate — the mandatory pre-deploy gate composition root (Requirement 7).
 *
 * Standalone: takes no arguments, uses only Node builtins. Invoked as
 * `npm run gate` (gate only) and from `npm run build` before `vite build`, so a
 * failing member blocks the Workers Builds deploy.
 *
 * Members run in the FIXED order (Requirement 7.6):
 *
 *   1. Lockfile_Check      (scripts/check-lockfiles.mjs)   — no node_modules needed, so it
 *                                                            fails fast and cheap on a fresh
 *                                                            checkout (Requirements 2.6, 2.8)
 *   2. Typecheck_Step      (tsc --noEmit)
 *   3. Lint_Step           (eslint .)
 *   4. Suppression_Check       (scripts/check-suppressions.mjs)
 *   5. Contract_Literal_Check  (scripts/check-contract-literals.mjs — Requirement 9.9)
 *   6. Shared_Artifact_Integrity_Check (network-free local handoff digest/adoption gate)
 *   7. Test_Suite              (vitest run)
 *   8. Contract_Drift_Check    (only once contract-adoption.json records adoption — 10.7)
 *
 * Contract:
 *   - Each member is spawned as a child process with inherited stdio, so its diagnostics
 *     reach this process's stdout/stderr verbatim and unbuffered.
 *   - Execution short-circuits at the first non-zero exit; no remaining member is invoked
 *     (Requirement 7.6).
 *   - On that first failure, stderr carries the failing member's name, a note that the
 *     member's own diagnostics appear above, and the names of the members that were NOT
 *     invoked; the exit code is non-zero (Requirement 7.7).
 *   - Lint_Step is invoked with ESLint's default warning handling and deliberately WITHOUT
 *     `--max-warnings`, so ≥1 ESLint error exits non-zero while warnings alone exit 0
 *     (Requirement 7.8). The repository currently carries 3 warnings and 0 errors.
 *   - `contract-adoption.json` governs Contract_Drift_Check membership: `adopted === false`,
 *     or an absent file, excludes it, reports the exclusion and its reason on stdout, and
 *     lets the remaining members decide the exit code (Requirement 10.7). A present but
 *     unreadable adoption file fails closed — the gate cannot tell whether drift applies.
 *   - There is NO skip flag, environment variable, branch condition, or local-versus-CI
 *     condition (Requirement 7.13). A recognised skip request is actively ignored: every
 *     configured member still runs and an "ignored" diagnostic is written to stderr
 *     (Requirement 7.14). Nothing in this module branches on a skip request.
 *   - The gate writes no build output of its own, so a gate failure leaves `dist/`
 *     byte-unchanged (Requirement 7.2).
 *
 * The module exports the member definitions (`GATE_MEMBERS`, `MEMBER_ORDER`), the pure
 * helpers (`selectMembers`, `detectSkipRequests`, `parseAdoption`, `resolveMemberCommand`)
 * and a runner (`runQualityGate`) that accepts an injectable `spawn`, `env`, `argv`, clock
 * and output sinks plus a root directory, so tests can drive it with fake members and assert
 * ordering, short-circuiting and reporting without running the real suite. The CLI shell at
 * the bottom runs only on direct invocation.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Tracked adoption flag for Shared_Contract_Artifact, at the repository root. */
export const CONTRACT_ADOPTION_FILENAME = "contract-adoption.json";

/** Exit code when a member exits non-zero. */
export const EXIT_MEMBER_FAILURE = 1;

/** Exit code when a member could not be launched at all (missing binary, spawn error). */
export const EXIT_MEMBER_UNLAUNCHABLE = 2;

/** Exit code when the adoption flag exists but cannot be read as a usable document. */
export const EXIT_ADOPTION_UNREADABLE = 3;

/** Raised when a member's command cannot be resolved to something launchable. */
export class MemberUnlaunchableError extends Error {
  constructor(message) {
    super(message);
    this.name = "MemberUnlaunchableError";
  }
}

/** Raised when the adoption flag exists but is not a usable adoption document. */
export class AdoptionFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "AdoptionFormatError";
  }
}

/**
 * The configured member set, in execution order. `kind` selects how the member is
 * resolved to a command:
 *   - `"script"`      — a repository Node script, run with this process's Node binary.
 *   - `"package-bin"` — a dependency's bin entry, resolved from `node_modules` and run
 *                       with this process's Node binary (no shell, no npm indirection,
 *                       so Windows `.cmd` shims and quoting are not involved).
 *   - `"command"`     — an explicit `command` + `args`, used by tests for fake members.
 *
 * `npmScript` records the standalone npm script that runs the same member, so the failure
 * report can tell a contributor how to reproduce one member in isolation.
 */
export const GATE_MEMBERS = Object.freeze([
  Object.freeze({
    name: "Lockfile_Check",
    npmScript: "check:lockfiles",
    kind: "script",
    script: "scripts/check-lockfiles.mjs",
    args: Object.freeze([]),
    requiresContractAdoption: false,
  }),
  Object.freeze({
    name: "Typecheck_Step",
    npmScript: "typecheck",
    kind: "package-bin",
    package: "typescript7",
    bin: "tsc",
    args: Object.freeze(["--noEmit"]),
    requiresContractAdoption: false,
  }),
  Object.freeze({
    // No `--max-warnings`: warnings must not fail the gate, errors must (Requirement 7.8).
    name: "Lint_Step",
    npmScript: "lint",
    kind: "package-bin",
    package: "eslint",
    bin: "eslint",
    args: Object.freeze(["."]),
    requiresContractAdoption: false,
  }),
  Object.freeze({
    name: "Suppression_Check",
    npmScript: "check:suppressions",
    kind: "script",
    script: "scripts/check-suppressions.mjs",
    args: Object.freeze([]),
    requiresContractAdoption: false,
  }),
  Object.freeze({
    // Forbids fact-status / quantity_kind string literals outside the artifact
    // (Requirement 9.9). Runs after the other lexical `src/` checks and before
    // the heavier Test_Suite so a stray literal fails fast and cheap.
    name: "Contract_Literal_Check",
    npmScript: "check:contract-literals",
    kind: "script",
    script: "scripts/check-contract-literals.mjs",
    args: Object.freeze([]),
    requiresContractAdoption: false,
  }),
  Object.freeze({
    // The local handoff gate is deliberately unconditional: an absent, stale,
    // or partially synchronized generated bundle must never be deployable.
    name: "Shared_Artifact_Integrity_Check",
    npmScript: "check:artifacts",
    kind: "script",
    script: "scripts/check-shared-artifacts.mjs",
    args: Object.freeze([]),
    requiresContractAdoption: false,
  }),
  Object.freeze({
    name: "Test_Suite",
    npmScript: "test",
    kind: "package-bin",
    package: "vitest",
    bin: "vitest",
    args: Object.freeze(["run"]),
    requiresContractAdoption: false,
  }),
  Object.freeze({
    name: "Contract_Drift_Check",
    npmScript: "check:contract",
    kind: "script",
    script: "scripts/check-contract-drift.mjs",
    args: Object.freeze([]),
    requiresContractAdoption: true,
  }),
]);

/** Member names in fixed execution order, for assertions and reporting. */
export const MEMBER_ORDER = Object.freeze(GATE_MEMBERS.map((member) => member.name));

/**
 * Environment variable names that a contributor or CI job might plausibly set to skip a
 * check. They are recognised only so the gate can say it ignored them (Requirement 7.14);
 * no code path branches on any of them.
 */
export const KNOWN_SKIP_ENV_VARS = Object.freeze([
  "FORCE_DEPLOY",
  "GATE_SKIP",
  "NO_GATE",
  "NO_VERIFY",
  "QUALITY_GATE_SKIP",
  "SKIP_CHECKS",
  "SKIP_GATE",
  "SKIP_LINT",
  "SKIP_LOCKFILE_CHECK",
  "SKIP_QUALITY_GATE",
  "SKIP_SUPPRESSIONS",
  "SKIP_TESTS",
  "SKIP_TYPECHECK",
]);

/** Values that read as "not actually requesting a skip", so a benign `SKIP_TESTS=0` is quiet. */
const NEGATIVE_VALUES = new Set(["", "0", "false", "no", "off"]);

/** Byte-wise lexicographic comparison (deliberately not locale-aware). */
function compareLexicographically(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** True when an environment variable value reads as a skip request. */
export function isSkipRequestValue(value) {
  if (value === undefined || value === null) return false;
  return !NEGATIVE_VALUES.has(String(value).trim().toLowerCase());
}

/** True when a command-line argument reads as a skip request. */
export function isSkipRequestArgument(argument) {
  const argumentText = String(argument);
  const flag = argumentText.split("=")[0];
  if (flag.startsWith("--skip") || flag.startsWith("--no-")) return true;
  return ["--force", "-f", "--only"].includes(flag);
}

/**
 * Finds every recognised skip request. Pure: reports what was seen and changes nothing.
 *
 * @param {{ env?: Record<string, string | undefined>, argv?: string[] }} [input]
 * @returns {{ kind: "environment variable" | "command-line argument", name: string }[]}
 */
export function detectSkipRequests({ env = {}, argv = [] } = {}) {
  const requests = [];
  for (const name of KNOWN_SKIP_ENV_VARS) {
    if (isSkipRequestValue(env[name])) {
      requests.push({ kind: "environment variable", name });
    }
  }
  for (const argument of argv) {
    if (isSkipRequestArgument(argument)) {
      requests.push({ kind: "command-line argument", name: String(argument) });
    }
  }
  return requests;
}

/**
 * Parses the adoption document: an object carrying a boolean `adopted` and a
 * `contractVersion` that is either null or a non-negative integer or a string.
 * Fails closed on anything else — the gate must not guess whether drift applies.
 *
 * @param {string} text file contents
 * @returns {{ adopted: boolean, contractVersion: number | string | null }}
 * @throws {AdoptionFormatError}
 */
export function parseAdoption(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new AdoptionFormatError(
      `${CONTRACT_ADOPTION_FILENAME} is not valid JSON: ${error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AdoptionFormatError(
      `${CONTRACT_ADOPTION_FILENAME} must be a JSON object carrying "adopted" and "contractVersion".`,
    );
  }
  if (typeof parsed.adopted !== "boolean") {
    throw new AdoptionFormatError(
      `${CONTRACT_ADOPTION_FILENAME} must carry a boolean "adopted" field, got ${JSON.stringify(
        parsed.adopted,
      )}.`,
    );
  }
  const version = parsed.contractVersion ?? null;
  if (
    version !== null &&
    typeof version !== "string" &&
    !(typeof version === "number" && Number.isInteger(version) && version >= 0)
  ) {
    throw new AdoptionFormatError(
      `${CONTRACT_ADOPTION_FILENAME} "contractVersion" must be null, a non-negative integer, or a string, got ${JSON.stringify(
        version,
      )}.`,
    );
  }
  return { adopted: parsed.adopted, contractVersion: version };
}

/**
 * Reads the adoption flag from `root`. An absent file means not adopted (Requirement 10.7):
 * Phase 1 ships before `Shared_Contract_Artifact` exists at all.
 *
 * @param {string} root
 * @returns {{ adopted: boolean, contractVersion: number | string | null, reason: string, error: AdoptionFormatError | null }}
 */
export function readAdoption(root) {
  const adoptionPath = path.join(root, CONTRACT_ADOPTION_FILENAME);
  if (!existsSync(adoptionPath)) {
    return {
      adopted: false,
      contractVersion: null,
      reason: `${CONTRACT_ADOPTION_FILENAME} is absent, so Shared_Contract_Artifact is not adopted yet`,
      error: null,
    };
  }
  try {
    const adoption = parseAdoption(readFileSync(adoptionPath, "utf8"));
    return {
      ...adoption,
      reason: adoption.adopted
        ? `${CONTRACT_ADOPTION_FILENAME} records adopted: true (contractVersion ${JSON.stringify(
          adoption.contractVersion,
        )})`
        : `${CONTRACT_ADOPTION_FILENAME} records adopted: false`,
      error: null,
    };
  } catch (error) {
    const formatError =
      error instanceof AdoptionFormatError
        ? error
        : new AdoptionFormatError(error instanceof Error ? error.message : String(error));
    return {
      adopted: false,
      contractVersion: null,
      reason: formatError.message,
      error: formatError,
    };
  }
}

/**
 * Splits the configured member set into the members to invoke and the members excluded
 * because Shared_Contract_Artifact is not adopted. Pure and order-preserving.
 *
 * @param {{ members?: readonly object[], adopted?: boolean, reason?: string }} input
 * @returns {{ selected: object[], excluded: { member: object, reason: string }[] }}
 */
export function selectMembers({ members = GATE_MEMBERS, adopted = false, reason = "" } = {}) {
  const selected = [];
  const excluded = [];
  for (const member of members) {
    if (member.requiresContractAdoption && !adopted) {
      excluded.push({
        member,
        reason: reason || `${CONTRACT_ADOPTION_FILENAME} does not record adoption`,
      });
    } else {
      selected.push(member);
    }
  }
  return { selected, excluded };
}

/**
 * Resolves the executable + arguments for one member, relative to `root`.
 *
 * @param {object} member
 * @param {string} root absolute repository root
 * @returns {{ command: string, args: string[] }}
 * @throws {MemberUnlaunchableError}
 */
export function resolveMemberCommand(member, root) {
  const args = [...(member.args ?? [])];

  if (member.kind === "command") {
    if (typeof member.command !== "string" || member.command === "") {
      throw new MemberUnlaunchableError(
        `${member.name}: a "command" member must carry a non-empty command.`,
      );
    }
    return { command: member.command, args };
  }

  if (member.kind === "script") {
    const scriptPath = path.join(root, member.script);
    if (!existsSync(scriptPath)) {
      throw new MemberUnlaunchableError(
        `${member.name}: ${member.script} is not present at ${scriptPath}.`,
      );
    }
    return { command: process.execPath, args: [scriptPath, ...args] };
  }

  if (member.kind === "package-bin") {
    const packageRoot = path.join(root, "node_modules", member.package);
    const manifestPath = path.join(packageRoot, "package.json");
    if (!existsSync(manifestPath)) {
      throw new MemberUnlaunchableError(
        `${member.name}: dependency "${member.package}" is not installed (${manifestPath} is absent). Run npm ci.`,
      );
    }
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      throw new MemberUnlaunchableError(
        `${member.name}: could not read ${manifestPath}: ${error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const bin = manifest.bin;
    const relativeBin =
      typeof bin === "string" ? bin : bin && typeof bin === "object" ? bin[member.bin] : undefined;
    if (typeof relativeBin !== "string" || relativeBin === "") {
      throw new MemberUnlaunchableError(
        `${member.name}: dependency "${member.package}" declares no "${member.bin}" bin entry.`,
      );
    }
    const binPath = path.join(packageRoot, relativeBin);
    if (!existsSync(binPath)) {
      throw new MemberUnlaunchableError(
        `${member.name}: the "${member.bin}" bin of "${member.package}" is missing at ${binPath}. Run npm ci.`,
      );
    }
    return { command: process.execPath, args: [binPath, ...args] };
  }

  throw new MemberUnlaunchableError(`${member.name}: unsupported member kind "${member.kind}".`);
}

/** Default child-process runner: synchronous, inherited stdio, no shell. */
function defaultSpawn(command, args, options) {
  return spawnSync(command, args, { ...options, stdio: "inherit", windowsHide: true });
}

/** Formats "A, B and C" / "(none)" for a member-name list. */
function formatNames(names) {
  if (names.length === 0) return "(none)";
  return names.join(", ");
}

/**
 * Runs Quality_Gate.
 *
 * Every configured member is invoked in order until one exits non-zero. Output is written
 * through the injected sinks as it happens (so it interleaves correctly with the members'
 * inherited stdio) and is also collected into the returned outcome so tests can assert on it.
 *
 * @param {{
 *   root?: string,
 *   members?: readonly object[],
 *   spawn?: (command: string, args: string[], options: object) => { status: number | null, error?: Error, signal?: string | null },
 *   env?: Record<string, string | undefined>,
 *   argv?: string[],
 *   adoption?: { adopted: boolean, contractVersion?: number | string | null, reason?: string, error?: Error | null },
 *   now?: () => number,
 *   stdout?: (line: string) => void,
 *   stderr?: (line: string) => void,
 * }} [options]
 * @returns {{
 *   ok: boolean,
 *   exitCode: number,
 *   invoked: string[],
 *   notInvoked: string[],
 *   excluded: string[],
 *   failure: { member: string, exitCode: number | null, reason: string } | null,
 *   stdout: string[],
 *   stderr: string[],
 * }}
 */
export function runQualityGate({
  root = process.cwd(),
  members = GATE_MEMBERS,
  spawn = defaultSpawn,
  env = process.env,
  argv = [],
  adoption,
  now = () => Date.now(),
  stdout,
  stderr,
} = {}) {
  const stdoutLines = [];
  const stderrLines = [];
  const emitOut = (line) => {
    stdoutLines.push(line);
    if (stdout) stdout(line);
  };
  const emitErr = (line) => {
    stderrLines.push(line);
    if (stderr) stderr(line);
  };

  const finish = (outcome) => ({ ...outcome, stdout: stdoutLines, stderr: stderrLines });

  // Requirement 7.14 — recognise a skip request only to say it was ignored. Nothing below
  // reads `skipRequests`, so no member can be skipped, downgraded, or reordered by it.
  for (const request of detectSkipRequests({ env, argv })) {
    emitErr(
      `quality-gate: ignoring skip request from ${request.kind} ${request.name}: Quality_Gate has no bypass; every configured member will run.`,
    );
  }

  const resolvedAdoption = adoption ?? readAdoption(root);
  if (resolvedAdoption.error) {
    emitErr(`quality-gate: cannot read the contract adoption flag: ${resolvedAdoption.reason}`);
    emitErr(
      "quality-gate: refusing to decide Contract_Drift_Check membership without a usable adoption flag.",
    );
    return finish({
      ok: false,
      exitCode: EXIT_ADOPTION_UNREADABLE,
      invoked: [],
      notInvoked: members.map((member) => member.name),
      excluded: [],
      failure: {
        member: CONTRACT_ADOPTION_FILENAME,
        exitCode: EXIT_ADOPTION_UNREADABLE,
        reason: resolvedAdoption.reason,
      },
    });
  }

  const { selected, excluded } = selectMembers({
    members,
    adopted: resolvedAdoption.adopted === true,
    reason: resolvedAdoption.reason,
  });

  // Requirement 10.7 — report the exclusion and its reason on stdout, then pass on the rest.
  for (const { member, reason } of excluded) {
    emitOut(`quality-gate: skipping ${member.name}: ${reason}.`);
  }

  emitOut(
    `quality-gate: running ${selected.length} member${selected.length === 1 ? "" : "s"} in order: ${formatNames(
      selected.map((member) => member.name),
    )}.`,
  );

  const invoked = [];

  for (let index = 0; index < selected.length; index++) {
    const member = selected[index];
    const remaining = selected.slice(index + 1).map((next) => next.name);

    let command;
    let args;
    try {
      ({ command, args } = resolveMemberCommand(member, root));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      emitErr(`quality-gate: FAILED — ${member.name} could not be launched: ${detail}`);
      emitErr(`quality-gate: members not invoked: ${formatNames(remaining)}.`);
      return finish({
        ok: false,
        exitCode: EXIT_MEMBER_UNLAUNCHABLE,
        invoked,
        notInvoked: remaining,
        excluded: excluded.map(({ member: skipped }) => skipped.name),
        failure: { member: member.name, exitCode: null, reason: detail },
      });
    }

    emitOut(
      `quality-gate: [${index + 1}/${selected.length}] ${member.name} — ${member.npmScript ? `npm run ${member.npmScript}` : `${command} ${args.join(" ")}`.trim()
      }`,
    );

    const startedAt = now();
    const result = spawn(command, args, { cwd: root, env });
    const elapsedMs = Math.max(0, now() - startedAt);

    if (result?.error) {
      const detail = result.error instanceof Error ? result.error.message : String(result.error);
      invoked.push(member.name);
      emitErr(`quality-gate: FAILED — ${member.name} could not be executed: ${detail}`);
      emitErr(`quality-gate: members not invoked: ${formatNames(remaining)}.`);
      return finish({
        ok: false,
        exitCode: EXIT_MEMBER_UNLAUNCHABLE,
        invoked,
        notInvoked: remaining,
        excluded: excluded.map(({ member: skipped }) => skipped.name),
        failure: { member: member.name, exitCode: null, reason: detail },
      });
    }

    invoked.push(member.name);

    const status = result?.status ?? null;
    if (status !== 0) {
      const signalDetail = result?.signal ? ` (terminated by signal ${result.signal})` : "";
      // Requirement 7.7 — failing member name, a pointer to its own diagnostics above, and
      // the members that were not invoked.
      emitErr(
        `quality-gate: FAILED — ${member.name} exited with status ${status === null ? "unknown" : status
        }${signalDetail}.`,
      );
      emitErr(
        `quality-gate: the diagnostic output of ${member.name} appears above this message.`,
      );
      emitErr(`quality-gate: members not invoked: ${formatNames(remaining)}.`);
      if (member.npmScript) {
        emitErr(
          `quality-gate: reproduce this member alone with: npm run ${member.npmScript}`,
        );
      }
      emitErr(
        "quality-gate: Quality_Gate has no bypass. Fix the failure, or record an entry in EMERGENCY_DEPLOYS.md if a deploy must proceed without it.",
      );
      return finish({
        ok: false,
        exitCode: status === null ? EXIT_MEMBER_FAILURE : status,
        invoked,
        notInvoked: remaining,
        excluded: excluded.map(({ member: skipped }) => skipped.name),
        failure: {
          member: member.name,
          exitCode: status,
          reason: `exited with status ${status === null ? "unknown" : status}${signalDetail}`,
        },
      });
    }

    emitOut(`quality-gate: ${member.name} passed in ${elapsedMs} ms.`);
  }

  emitOut(
    `quality-gate: OK — ${invoked.length} member${invoked.length === 1 ? "" : "s"} passed: ${formatNames(
      invoked,
    )}.`,
  );

  return finish({
    ok: true,
    exitCode: 0,
    invoked,
    notInvoked: [],
    excluded: excluded.map(({ member }) => member.name),
    failure: null,
  });
}

/** Sorted copy of the known skip environment variable names, for documentation and tests. */
export function knownSkipEnvVars() {
  return [...KNOWN_SKIP_ENV_VARS].sort(compareLexicographically);
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
  const outcome = runQualityGate({
    root: process.cwd(),
    env: process.env,
    argv: process.argv.slice(2),
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
  process.exit(outcome.exitCode);
}
