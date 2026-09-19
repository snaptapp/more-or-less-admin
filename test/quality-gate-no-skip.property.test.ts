/**
 * Feature: admin-quality-gates-and-shared-contracts, Property 24: The gate cannot be skipped.
 *
 * *For any* environment-variable or command-line input requesting that a member be skipped,
 * `Quality_Gate` ignores the request, attempts every member of its configured member set
 * (subject only to short-circuit on a genuine failure), and writes a diagnostic to standard
 * error indicating the skip request was ignored.
 *
 * Validates: Requirements 7.13, 7.14
 *
 * The property is driven over the real `runQualityGate` composition root with `kind:
 * "command"` fake members and an injected `spawn`, so the assertion is on the actual runner
 * — not a reimplementation. For any combination of known skip environment variables and
 * skip-shaped command-line arguments, every configured member is still spawned and a stderr
 * diagnostic names the ignored request (300 iterations, no I/O, no network).
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

interface GateMember {
  name: string;
  npmScript?: string;
  kind: string;
  command?: string;
  args?: readonly string[];
  requiresContractAdoption?: boolean;
}

interface SpawnResult {
  status: number | null;
  error?: Error;
  signal?: string | null;
}

interface GateOutcome {
  ok: boolean;
  exitCode: number;
  invoked: string[];
  notInvoked: string[];
  excluded: string[];
  failure: { member: string; exitCode: number | null; reason: string } | null;
  stdout: string[];
  stderr: string[];
}

interface SkipRequest {
  kind: "environment variable" | "command-line argument";
  name: string;
}

interface QualityGateModule {
  KNOWN_SKIP_ENV_VARS: readonly string[];
  isSkipRequestValue(value: unknown): boolean;
  isSkipRequestArgument(argument: unknown): boolean;
  detectSkipRequests(input?: {
    env?: Record<string, string | undefined>;
    argv?: string[];
  }): SkipRequest[];
  runQualityGate(options?: {
    root?: string;
    members?: readonly GateMember[];
    spawn?: (command: string, args: string[], options: object) => SpawnResult;
    env?: Record<string, string | undefined>;
    argv?: string[];
    adoption?: {
      adopted: boolean;
      contractVersion?: number | string | null;
      reason?: string;
      error?: Error | null;
    };
    now?: () => number;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
  }): GateOutcome;
}

const GATE_SPECIFIER = new URL("../scripts/quality-gate.mjs", import.meta.url).href;
const gate = (await import(/* @vite-ignore */ GATE_SPECIFIER)) as QualityGateModule;
const { KNOWN_SKIP_ENV_VARS, detectSkipRequests, isSkipRequestValue, runQualityGate } = gate;

/** The six always-selected member names (Contract_Drift_Check excluded pre-adoption). */
const MEMBER_NAMES = [
  "Lockfile_Check",
  "Typecheck_Step",
  "Lint_Step",
  "Suppression_Check",
  "Contract_Literal_Check",
  "Test_Suite",
] as const;

function passingMembers(): GateMember[] {
  return MEMBER_NAMES.map((name) => ({
    name,
    npmScript: name.toLowerCase(),
    kind: "command",
    command: "node",
    args: [`::member::${name}`],
    requiresContractAdoption: false,
  }));
}

/** Records the invocation order; every member passes. */
function recordingSpawn(invokedOrder: string[]): (
  command: string,
  args: string[],
  options: object,
) => SpawnResult {
  return (_command, args) => {
    const marker = args.find((arg) => arg.startsWith("::member::"));
    invokedOrder.push(marker ? marker.slice("::member::".length) : "");
    return { status: 0 };
  };
}

/** Arbitrary that produces a subset of the known skip env vars with truthy values. */
const skipEnvArb: fc.Arbitrary<Record<string, string>> = fc
  .uniqueArray(fc.constantFrom(...KNOWN_SKIP_ENV_VARS), { maxLength: KNOWN_SKIP_ENV_VARS.length })
  .chain((names) =>
    fc
      .array(fc.constantFrom("1", "true", "yes", "on", "please"), {
        minLength: names.length,
        maxLength: names.length,
      })
      .map((values) => {
        const env: Record<string, string> = {};
        names.forEach((name, index) => {
          env[name] = values[index];
        });
        return env;
      }),
  );

/** Arbitrary that produces skip-shaped command-line arguments. */
const skipArgvArb: fc.Arbitrary<string[]> = fc.array(
  fc.oneof(
    fc.constantFrom("--skip-tests", "--skip-lint", "--no-verify", "--no-gate", "--force", "-f", "--only"),
    fc.constantFrom("--skip-suppressions=1", "--no-typecheck", "--skip"),
  ),
  { maxLength: 5 },
);

describe("Property 24: The gate cannot be skipped", () => {
  it("recognises the documented skip env vars and skip-shaped args as skip requests", () => {
    for (const name of KNOWN_SKIP_ENV_VARS) {
      expect(isSkipRequestValue("1")).toBe(true);
      expect(detectSkipRequests({ env: { [name]: "1" }, argv: [] })).toContainEqual({
        kind: "environment variable",
        name,
      });
    }
    // A benign "off" value is not a skip request.
    expect(isSkipRequestValue("0")).toBe(false);
    expect(isSkipRequestValue("false")).toBe(false);
    expect(isSkipRequestValue("")).toBe(false);
    expect(isSkipRequestValue(undefined)).toBe(false);
  });

  it("runs every configured member and reports the ignored request for any skip input", () => {
    fc.assert(
      fc.property(skipEnvArb, skipArgvArb, (skipEnv, skipArgv) => {
        fc.pre(Object.keys(skipEnv).length > 0 || skipArgv.some((arg) =>
          arg.startsWith("--skip") || arg.startsWith("--no-") || ["--force", "-f", "--only"].includes(arg),
        ));

        const invokedOrder: string[] = [];
        const outcome = runQualityGate({
          root: process.cwd(),
          members: passingMembers(),
          spawn: recordingSpawn(invokedOrder),
          adoption: { adopted: false, contractVersion: null, reason: "not adopted" },
          env: skipEnv,
          argv: skipArgv,
        });

        // Requirement 7.14: every configured member still ran, in order — nothing skipped.
        expect(invokedOrder).toEqual([...MEMBER_NAMES]);
        expect(outcome.invoked).toEqual([...MEMBER_NAMES]);
        expect(outcome.notInvoked).toEqual([]);
        expect(outcome.ok).toBe(true);
        expect(outcome.exitCode).toBe(0);

        // Requirement 7.14: a stderr diagnostic says the skip request was ignored.
        const detected = detectSkipRequests({ env: skipEnv, argv: skipArgv });
        expect(detected.length).toBeGreaterThan(0);
        const diagnostic = outcome.stderr.join("\n");
        expect(diagnostic.toLowerCase()).toContain("ignor");
        for (const request of detected) {
          expect(diagnostic).toContain(request.name);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("does not let a genuine skip request downgrade a real failure (short-circuit still applies)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MEMBER_NAMES.length - 1 }),
        skipEnvArb,
        (failIndex, skipEnv) => {
          fc.pre(Object.keys(skipEnv).length > 0);

          const invokedOrder: string[] = [];
          const outcome = runQualityGate({
            root: process.cwd(),
            members: passingMembers(),
            spawn: (_command, args) => {
              const marker = args.find((arg) => arg.startsWith("::member::"));
              const name = marker ? marker.slice("::member::".length) : "";
              invokedOrder.push(name);
              return { status: name === MEMBER_NAMES[failIndex] ? 1 : 0 };
            },
            adoption: { adopted: false, contractVersion: null, reason: "not adopted" },
            env: skipEnv,
            argv: [],
          });

          // The failing member's index bounds the invocations: the skip request neither
          // suppressed the failure nor skipped earlier members.
          expect(invokedOrder).toEqual(MEMBER_NAMES.slice(0, failIndex + 1));
          expect(outcome.ok).toBe(false);
          expect(outcome.exitCode).toBeGreaterThan(0);
          const diagnostic = outcome.stderr.join("\n");
          expect(diagnostic.toLowerCase()).toContain("ignor");
        },
      ),
      { numRuns: 300 },
    );
  });

  it("emits no ignored-skip diagnostic when no skip request is present", () => {
    const invokedOrder: string[] = [];
    const outcome = runQualityGate({
      root: process.cwd(),
      members: passingMembers(),
      spawn: recordingSpawn(invokedOrder),
      adoption: { adopted: false, contractVersion: null, reason: "not adopted" },
      env: { SKIP_TESTS: "0", FORCE_DEPLOY: "false" },
      argv: ["run"],
    });
    expect(invokedOrder).toEqual([...MEMBER_NAMES]);
    const diagnostic = outcome.stderr.join("\n").toLowerCase();
    expect(diagnostic).not.toContain("ignoring skip request");
  });
});
