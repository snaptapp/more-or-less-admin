/**
 * Feature: admin-quality-gates-and-shared-contracts, Property 22: The Quality_Gate runs
 * members in order, short-circuits, and reports.
 *
 * *For any* member position i that exits non-zero, `Quality_Gate` has invoked exactly
 * members 0 through i in the fixed order Lockfile_Check → Typecheck_Step → Lint_Step →
 * Suppression_Check → Contract_Literal_Check → Shared_Artifact_Integrity_Check →
 * Ops_Assistant_Check → Test_Suite (→ Contract_Drift_Check when
 * adopted), invokes no member
 * after i, writes to standard error the name of member i and the names of the members it
 * did not invoke, and itself exits non-zero.
 *
 * Validates: Requirements 7.6, 7.7
 *
 * The property is driven over the real `runQualityGate` composition root with `kind:
 * "command"` fake members and an injected `spawn` that returns a scripted exit status per
 * member. This exercises the actual ordering, short-circuit and reporting logic without
 * running the real suite (300 iterations, no I/O, no network). One structural assertion
 * pins the shipped member order to the requirement's fixed sequence so a reordering of
 * `GATE_MEMBERS` fails this test.
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

interface QualityGateModule {
  GATE_MEMBERS: readonly GateMember[];
  MEMBER_ORDER: readonly string[];
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

// `scripts/quality-gate.mjs` is a plain Node ESM script with no type declarations and the
// repository tsconfig does not enable `allowJs`, so a static relative import would not
// typecheck. A computed specifier keeps `tsc --noEmit` clean while exercising the real
// module.
const GATE_SPECIFIER = new URL("../scripts/quality-gate.mjs", import.meta.url).href;
const gate = (await import(/* @vite-ignore */ GATE_SPECIFIER)) as QualityGateModule;
const { GATE_MEMBERS, MEMBER_ORDER, runQualityGate } = gate;

/** The requirement's fixed order, restated independently of the implementation. */
const FIXED_ORDER = [
  "Lockfile_Check",
  "Typecheck_Step",
  "Lint_Step",
  "Suppression_Check",
  "Contract_Literal_Check",
  "Shared_Artifact_Integrity_Check",
  "Ops_Assistant_Check",
  "Test_Suite",
  "Contract_Drift_Check",
] as const;

/**
 * Build a set of `kind: "command"` fake members mirroring the shipped names, so the runner
 * resolves each to a launchable command without touching node_modules or scripts on disk.
 */
function fakeMembers(names: readonly string[]): GateMember[] {
  return names.map((name) => ({
    name,
    npmScript: name.toLowerCase(),
    kind: "command",
    command: "node",
    args: ["-e", "process.exit(0)"],
    requiresContractAdoption: false,
  }));
}

/**
 * An injected spawn that returns a scripted exit status keyed by the member name embedded in
 * the args. We stash the member name in a sentinel arg so the fake spawn can look up its
 * scripted result and record the invocation order.
 */
function scriptedSpawn(
  statusByName: Map<string, number>,
  invokedOrder: string[],
): (command: string, args: string[], options: object) => SpawnResult {
  return (_command, args) => {
    const marker = args.find((arg) => arg.startsWith("::member::"));
    const name = marker ? marker.slice("::member::".length) : "";
    invokedOrder.push(name);
    return { status: statusByName.get(name) ?? 0 };
  };
}

function membersWithMarker(names: readonly string[]): GateMember[] {
  return names.map((name) => ({
    name,
    npmScript: name.toLowerCase(),
    kind: "command",
    command: "node",
    args: [`::member::${name}`],
    requiresContractAdoption: false,
  }));
}

describe("Property 22: The Quality_Gate runs members in order, short-circuits, and reports", () => {
  it("ships members in the fixed requirement order", () => {
    expect([...MEMBER_ORDER]).toEqual([...FIXED_ORDER]);
    expect(GATE_MEMBERS.map((member) => member.name)).toEqual([...FIXED_ORDER]);
  });

  it("invokes exactly members 0..i, skips the rest, and reports the failing + not-invoked members", () => {
    // The always-selected members (Contract_Drift_Check is excluded pre-adoption).
    const selectable = FIXED_ORDER.filter((name) => name !== "Contract_Drift_Check");

    fc.assert(
      fc.property(
        // Which member index fails first (or none — all pass).
        fc.nat({ max: selectable.length }),
        (failIndex) => {
          const members = membersWithMarker(selectable);
          const statusByName = new Map<string, number>();
          const willFail = failIndex < selectable.length;
          if (willFail) statusByName.set(selectable[failIndex], 1);

          const invokedOrder: string[] = [];
          const outcome = runQualityGate({
            root: process.cwd(),
            members,
            spawn: scriptedSpawn(statusByName, invokedOrder),
            adoption: { adopted: false, contractVersion: null, reason: "not adopted" },
            env: {},
            argv: [],
          });

          if (!willFail) {
            // Every member ran, in order, and the gate passed.
            expect(outcome.ok).toBe(true);
            expect(outcome.exitCode).toBe(0);
            expect(invokedOrder).toEqual([...selectable]);
            expect(outcome.invoked).toEqual([...selectable]);
            expect(outcome.notInvoked).toEqual([]);
            return;
          }

          const expectedInvoked = selectable.slice(0, failIndex + 1);
          const expectedNotInvoked = selectable.slice(failIndex + 1);

          // Short-circuit: exactly members 0..i were spawned, in order.
          expect(invokedOrder).toEqual([...expectedInvoked]);
          expect(outcome.invoked).toEqual([...expectedInvoked]);
          expect(outcome.notInvoked).toEqual([...expectedNotInvoked]);

          // Exits non-zero (Requirement 7.7).
          expect(outcome.ok).toBe(false);
          expect(outcome.exitCode).toBeGreaterThan(0);
          expect(outcome.failure?.member).toBe(selectable[failIndex]);

          // stderr names the failing member (Requirement 7.7).
          const diagnostic = outcome.stderr.join("\n");
          expect(diagnostic).toContain(selectable[failIndex]);

          // stderr names every member that was not invoked (Requirement 7.7).
          for (const notInvoked of expectedNotInvoked) {
            expect(diagnostic).toContain(notInvoked);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("preserves the fixed order under an adopted contract flag (Contract_Drift_Check appended last)", () => {
    fc.assert(
      fc.property(fc.nat({ max: FIXED_ORDER.length }), (failIndex) => {
        const members = membersWithMarker(FIXED_ORDER);
        const statusByName = new Map<string, number>();
        const willFail = failIndex < FIXED_ORDER.length;
        if (willFail) statusByName.set(FIXED_ORDER[failIndex], 1);

        const invokedOrder: string[] = [];
        const outcome = runQualityGate({
          root: process.cwd(),
          members,
          spawn: scriptedSpawn(statusByName, invokedOrder),
          adoption: { adopted: true, contractVersion: 1, reason: "adopted" },
          env: {},
          argv: [],
        });

        const expectedInvoked = willFail
          ? FIXED_ORDER.slice(0, failIndex + 1)
          : [...FIXED_ORDER];
        expect(invokedOrder).toEqual([...expectedInvoked]);
        expect(outcome.invoked).toEqual([...expectedInvoked]);

        if (willFail) {
          expect(outcome.ok).toBe(false);
          expect(outcome.notInvoked).toEqual(FIXED_ORDER.slice(failIndex + 1));
        } else {
          expect(outcome.ok).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("never invokes a member after the first failure regardless of later members' scripted status", () => {
    const selectable = FIXED_ORDER.filter((name) => name !== "Contract_Drift_Check");
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: selectable.length - 1 }),
        // Later members are scripted to fail too, but must never be spawned.
        fc.array(fc.boolean(), { minLength: selectable.length, maxLength: selectable.length }),
        (failIndex, laterFailures) => {
          const statusByName = new Map<string, number>();
          statusByName.set(selectable[failIndex], 1);
          for (let j = failIndex + 1; j < selectable.length; j++) {
            if (laterFailures[j]) statusByName.set(selectable[j], 1);
          }

          const invokedOrder: string[] = [];
          runQualityGate({
            root: process.cwd(),
            members: membersWithMarker(selectable),
            spawn: scriptedSpawn(statusByName, invokedOrder),
            adoption: { adopted: false, contractVersion: null, reason: "not adopted" },
            env: {},
            argv: [],
          });

          expect(invokedOrder).toEqual(selectable.slice(0, failIndex + 1));
        },
      ),
      { numRuns: 300 },
    );
  });

  it("uses fakeMembers helper consistently (sanity: all-pass run invokes every member)", () => {
    const selectable = FIXED_ORDER.filter((name) => name !== "Contract_Drift_Check");
    const invokedOrder: string[] = [];
    const outcome = runQualityGate({
      root: process.cwd(),
      members: fakeMembers(selectable).map((member) => ({
        ...member,
        args: [`::member::${member.name}`],
      })),
      spawn: scriptedSpawn(new Map(), invokedOrder),
      adoption: { adopted: false, contractVersion: null, reason: "not adopted" },
      env: {},
      argv: [],
    });
    expect(outcome.ok).toBe(true);
    expect(invokedOrder).toEqual([...selectable]);
  });
});
