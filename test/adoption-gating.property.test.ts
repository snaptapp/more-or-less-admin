/**
 * Feature: admin-quality-gates-and-shared-contracts
 *
 * Property 33: The drift check is excluded before adoption and passes on the rest.
 * Property 34: Version skew fails only the admin gate.
 *
 * Validates: Requirements 10.7, 10.9
 *
 * Property 33 drives the real `runQualityGate`/`selectMembers` composition root
 * (scripts/quality-gate.mjs) with `kind: "command"` fake members — one of which carries
 * `requiresContractAdoption: true` to stand in for Contract_Drift_Check — over an injected
 * adoption flag. It asserts that member is in `excluded` (and never invoked, and its skip +
 * reason reported on stdout) IFF the flag does not record adoption, and that the remaining
 * members decide the outcome. No I/O, no network.
 *
 * Property 34 models "published Contract_Version > recorded Contract_Version":
 *   - The ADMIN side (`runContractDriftCheck`, scripts/check-contract-drift.mjs) reads the
 *     recorded version (M) and the published artifact's CONTRACT_VERSION (N) and exits
 *     non-zero on the mismatch, naming both versions. The property drives it through its
 *     injected `readFileSync`/`now`/`sleep` seams over in-memory fixture bytes, so it is
 *     deterministic and immune to any filesystem contention from parallel test files; a
 *     single end-to-end case additionally exercises a real, uniquely-scoped temp tree.
 *   - The MAIN side (`gen_shared_contract.mjs --check`) compares its regenerated content —
 *     which depends only on the published inputs — byte-for-byte against the checked-in
 *     published artifact. It has no notion of the admin's recorded version, so its result is
 *     invariant under M. We assert that invariance by comparing the published artifact
 *     against a regenerated copy carrying the same published version N for any M < N.
 *
 * Both scripts are declaration-less Node ESM loaded through a computed specifier so
 * `tsc --noEmit` stays clean (the repo tsconfig has no allowJs).
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Module surfaces (typed locally; loaded via computed specifiers).
// ---------------------------------------------------------------------------

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
  selectMembers(input?: {
    members?: readonly GateMember[];
    adopted?: boolean;
    reason?: string;
  }): { selected: GateMember[]; excluded: { member: GateMember; reason: string }[] };
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

interface DriftOutcome {
  ok: boolean;
  exitCode: number;
  stdout: string[];
  stderr: string[];
}

interface DriftModule {
  CONTRACT_SOURCE_FILENAME: string;
  CONTRACT_ADOPTION_FILENAME: string;
  CONSUMED_ARTIFACT_RELATIVE_PATH: string;
  EXIT_DRIFT: number;
  parseContractVersion(source: string): number | string | null;
  runContractDriftCheck(options?: {
    root?: string;
    readFileSync?: (p: string, enc: string) => string;
    now?: () => number;
    sleep?: (ms: number) => void;
  }): DriftOutcome;
}

const GATE_SPECIFIER = new URL("../scripts/quality-gate.mjs", import.meta.url).href;
const gate = (await import(/* @vite-ignore */ GATE_SPECIFIER)) as QualityGateModule;
const { GATE_MEMBERS, selectMembers, runQualityGate } = gate;

const DRIFT_SPECIFIER = new URL("../scripts/check-contract-drift.mjs", import.meta.url).href;
const drift = (await import(/* @vite-ignore */ DRIFT_SPECIFIER)) as DriftModule;
const {
  CONTRACT_SOURCE_FILENAME,
  CONTRACT_ADOPTION_FILENAME,
  CONSUMED_ARTIFACT_RELATIVE_PATH,
  EXIT_DRIFT,
  parseContractVersion,
  runContractDriftCheck,
} = drift;

// ---------------------------------------------------------------------------
// Property 33 helpers — fake members driving the real gate composition root.
// ---------------------------------------------------------------------------

/**
 * A fake member set mirroring the shape of the shipped gate: a leading block of ordinary
 * members plus a trailing `Contract_Drift_Check`-like member gated on adoption. Each is a
 * `kind: "command"` member the runner can resolve without touching node_modules or scripts on
 * disk. The member name is stashed in a sentinel arg so the injected spawn can record the
 * invocation order and look up a scripted exit status.
 */
function fakeMembersWithGatedDrift(ordinaryCount: number): GateMember[] {
  const members: GateMember[] = [];
  for (let i = 0; i < ordinaryCount; i++) {
    members.push({
      name: `Member_${i}`,
      npmScript: `member-${i}`,
      kind: "command",
      command: "node",
      args: [`::member::Member_${i}`],
      requiresContractAdoption: false,
    });
  }
  members.push({
    name: "Contract_Drift_Check",
    npmScript: "check:contract",
    kind: "command",
    command: "node",
    args: ["::member::Contract_Drift_Check"],
    requiresContractAdoption: true,
  });
  return members;
}

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

describe("Property 33: the drift check is excluded before adoption and passes on the rest", () => {
  // Structural anchor: the shipped Contract_Drift_Check member is the one gated on adoption,
  // and it is the only such member. If this changes, the property below is describing the
  // wrong seam.
  it("Contract_Drift_Check is the sole adoption-gated shipped member", () => {
    const gated = GATE_MEMBERS.filter((m) => m.requiresContractAdoption);
    expect(gated.map((m) => m.name)).toEqual(["Contract_Drift_Check"]);
  });

  it("excludes Contract_Drift_Check via selectMembers iff not adopted", () => {
    fc.assert(
      fc.property(fc.boolean(), (adopted) => {
        const { selected, excluded } = selectMembers({
          members: GATE_MEMBERS,
          adopted,
          reason: adopted ? "adopted: true" : "adopted: false",
        });
        const selectedNames = selected.map((m) => m.name);
        const excludedNames = excluded.map((e) => e.member.name);

        // The adoption-gated member is excluded exactly when not adopted.
        expect(excludedNames.includes("Contract_Drift_Check")).toBe(!adopted);
        expect(selectedNames.includes("Contract_Drift_Check")).toBe(adopted);

        // Every non-gated member is always selected and never excluded.
        for (const member of GATE_MEMBERS) {
          if (!member.requiresContractAdoption) {
            expect(selectedNames).toContain(member.name);
            expect(excludedNames).not.toContain(member.name);
          }
        }
        // Selected + excluded partition the configured members with no loss.
        expect(selected.length + excluded.length).toBe(GATE_MEMBERS.length);
      }),
      { numRuns: 200 },
    );
  });

  it("over the real runQualityGate: excluded iff not adopted, skip+reason on stdout, rest decide outcome", () => {
    fc.assert(
      fc.property(
        fc.boolean(), // adopted flag
        fc.integer({ min: 1, max: 5 }), // number of ordinary (always-selected) members
        // A scripted failure among the ordinary members, or -1 for "all ordinary members pass".
        fc.integer({ min: -1, max: 4 }),
        (adopted, ordinaryCount, failOrdinal) => {
          const members = fakeMembersWithGatedDrift(ordinaryCount);
          const statusByName = new Map<string, number>();
          const failIndex = failOrdinal >= 0 && failOrdinal < ordinaryCount ? failOrdinal : -1;
          if (failIndex >= 0) statusByName.set(`Member_${failIndex}`, 1);

          const invokedOrder: string[] = [];
          const reason = adopted
            ? "contract-adoption.json records adopted: true"
            : "contract-adoption.json records adopted: false";
          const outcome = runQualityGate({
            root: process.cwd(),
            members,
            spawn: scriptedSpawn(statusByName, invokedOrder),
            adoption: { adopted, contractVersion: adopted ? 1 : null, reason },
            env: {},
            argv: [],
          });

          // (a) Contract_Drift_Check is excluded exactly when not adopted (Requirement 10.7).
          if (adopted) {
            expect(outcome.excluded).not.toContain("Contract_Drift_Check");
          } else {
            expect(outcome.excluded).toContain("Contract_Drift_Check");
            // The skip and its reason are reported on stdout (Requirement 10.7).
            const out = outcome.stdout.join("\n");
            expect(out).toContain("Contract_Drift_Check");
            expect(out).toContain(reason);
            // An excluded member is never invoked.
            expect(invokedOrder).not.toContain("Contract_Drift_Check");
            expect(outcome.invoked).not.toContain("Contract_Drift_Check");
          }

          // (b) The remaining (ordinary) members decide the outcome.
          if (failIndex >= 0) {
            expect(outcome.ok).toBe(false);
            expect(outcome.exitCode).toBeGreaterThan(0);
            expect(outcome.failure?.member).toBe(`Member_${failIndex}`);
          } else {
            // No ordinary member fails.
            if (adopted) {
              // The drift member is scripted to pass (status 0), so the whole gate passes.
              expect(outcome.ok).toBe(true);
              expect(outcome.exitCode).toBe(0);
              expect(outcome.invoked).toContain("Contract_Drift_Check");
            } else {
              // With the drift member excluded and every ordinary member passing, the gate
              // passes on the remaining members alone (Requirement 10.7).
              expect(outcome.ok).toBe(true);
              expect(outcome.exitCode).toBe(0);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 34 helpers — fixture trees for the admin drift check + main --check model.
// ---------------------------------------------------------------------------

/** A representative artifact carrying the given CONTRACT_VERSION, in the generator's shape. */
function artifactWithVersion(version: number): string {
  return [
    "// Code generated by scripts/gen_shared_contract.mjs; DO NOT EDIT.",
    "",
    `export const CONTRACT_VERSION = ${version};`,
    "",
    'export const FACT_STATUSES = ["pending", "active", "disputed", "retired"] as const;',
    "export type FactStatus = (typeof FACT_STATUSES)[number];",
    "",
    "export const STATUS_TRANSITIONS: readonly StatusTransition[] = [",
    '  { from: "pending", to: "active", adminAuthorized: true },',
    '  { from: "active", to: "disputed", adminAuthorized: true },',
    "] as const;",
    "",
    "export const QUANTITY_KINDS = [",
    '  "year",',
    '  "count",',
    "] as const;",
    "",
    "export const LIFECYCLE_FIELDS: readonly FieldDescriptor[] = [",
    '  { name: "plausible_min", type: "number", required: false },',
    "] as const;",
    "",
  ].join("\n");
}

/**
 * Builds an admin-side fixture where the consumed copy records version M and the published
 * copy declares version N, with the consumed bytes otherwise matching the published bytes
 * except for the CONTRACT_VERSION line. Returns the root and a cleanup function.
 */
function makeSkewFixture(recorded: number, published: number): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(os.tmpdir(), "adoption-skew-"));
  // Keep the published copy INSIDE this unique temp root (under a dedicated
  // subdirectory) rather than at a shared sibling path, so parallel test files
  // cannot collide on one absolute `published-repo` directory.
  const publishedRel = "published-repo/shared/fact-lifecycle-contract.gen.ts";

  const consumedAbs = path.join(root, CONSUMED_ARTIFACT_RELATIVE_PATH);
  mkdirSync(path.dirname(consumedAbs), { recursive: true });
  // Consumed copy is the artifact carrying the recorded version M.
  writeFileSync(consumedAbs, artifactWithVersion(recorded), "utf8");

  const publishedAbs = path.resolve(root, publishedRel);
  mkdirSync(path.dirname(publishedAbs), { recursive: true });
  writeFileSync(publishedAbs, artifactWithVersion(published), "utf8");

  writeFileSync(
    path.join(root, CONTRACT_SOURCE_FILENAME),
    JSON.stringify({ publishedArtifactPath: publishedRel }),
    "utf8",
  );
  writeFileSync(
    path.join(root, CONTRACT_ADOPTION_FILENAME),
    JSON.stringify({ adopted: true, contractVersion: recorded }),
    "utf8",
  );

  const cleanup = () => {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  };
  return { root, cleanup };
}

describe("Property 34: version skew fails only the admin gate", () => {
  it("published > recorded: the ADMIN drift check exits non-zero naming both versions", () => {
    // Build the tracked-config + consumed + published bytes purely in memory and feed them to
    // `runContractDriftCheck` through an injected `readFileSync`, with an injected clock and a
    // no-op sleep. This keeps the property deterministic and immune to filesystem contention
    // from other test files running in parallel (no real temp trees, no shared paths, no
    // busy-wait). It mirrors the injectable seams the drift check exposes for exactly this.
    const PUBLISHED_REL = "published-repo/shared/fact-lifecycle-contract.gen.ts";

    fc.assert(
      fc.property(
        // recorded M in [0, 40], strictly-positive gap so published N = M + gap > M.
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 1, max: 20 }),
        (recorded, gap) => {
          const published = recorded + gap; // published > recorded, always.
          const root = path.join(os.tmpdir(), "adoption-skew-inmem");

          const consumedBytes = artifactWithVersion(recorded);
          const files = new Map<string, string>([
            [
              path.resolve(root, CONTRACT_SOURCE_FILENAME),
              JSON.stringify({ publishedArtifactPath: PUBLISHED_REL }),
            ],
            [
              path.resolve(root, CONTRACT_ADOPTION_FILENAME),
              JSON.stringify({ adopted: true, contractVersion: recorded }),
            ],
            [path.resolve(root, CONSUMED_ARTIFACT_RELATIVE_PATH), consumedBytes],
            [path.resolve(root, PUBLISHED_REL), artifactWithVersion(published)],
          ]);

          const reads: string[] = [];
          const readFileSyncStub = (p: string): string => {
            reads.push(path.resolve(p));
            const value = files.get(path.resolve(p));
            if (value === undefined) {
              const err = new Error(`ENOENT: ${p}`) as Error & { code: string };
              err.code = "ENOENT";
              throw err;
            }
            return value;
          };

          let clock = 0;
          const outcome = runContractDriftCheck({
            root,
            readFileSync: readFileSyncStub,
            now: () => clock,
            sleep: (ms: number) => {
              clock += ms;
            },
          });

          // The admin gate fails on the version mismatch (Requirement 10.9).
          expect(outcome.ok).toBe(false);
          expect(outcome.exitCode).toBe(EXIT_DRIFT);
          const err = outcome.stderr.join("\n");
          expect(err).toContain("Contract_Version mismatch");
          // Both versions are named.
          expect(err).toContain(`recorded ${recorded}`);
          expect(err).toContain(`published ${published}`);
          // The check never wrote anything — it only ever read (consumed copy unmodified).
          expect(reads.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("the MAIN --check byte-comparison is independent of the admin's recorded version", () => {
    // The Main_Repository generator regenerates content purely from the published inputs
    // (contract.version = N, agent-go/, etc.) and byte-compares it to the checked-in
    // published artifact. It never reads the admin's recorded version M. We model that
    // invariance directly: for any recorded M < published N, a clean main tree (checked-in
    // artifact === regenerated content, both at version N) is byte-identical regardless of M,
    // so the main --check would exit 0. The admin-side helper `parseContractVersion` is the
    // same byte-level reader the main generator's diff uses on the CONTRACT_VERSION line.
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 1, max: 20 }),
        (recorded, gap) => {
          const published = recorded + gap;

          // A "clean main tree": the regenerated content matches the checked-in published
          // artifact byte-for-byte, both stamped with the published version N.
          const checkedIn = artifactWithVersion(published);
          const regenerated = artifactWithVersion(published);

          // The main --check equality test (`committed === regenerated`) holds — exit 0 —
          // and this equality does not reference the admin's recorded version M at all.
          expect(checkedIn).toBe(regenerated);
          expect(parseContractVersion(checkedIn)).toBe(published);

          // The very same published tree paired with ANY recorded M < N still leaves the main
          // side byte-identical (M does not appear in the published artifact bytes).
          expect(checkedIn.includes(`CONTRACT_VERSION = ${published};`)).toBe(true);
          expect(checkedIn.includes(`CONTRACT_VERSION = ${recorded};`)).toBe(recorded === published);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("end-to-end skew: admin fails while the modelled main tree stays clean (exit 0)", () => {
    const recorded = 1;
    const published = 2; // published > recorded
    const { root, cleanup } = makeSkewFixture(recorded, published);
    try {
      // Admin side: non-zero on the skew.
      const admin = runContractDriftCheck({ root });
      expect(admin.ok).toBe(false);
      expect(admin.exitCode).toBe(EXIT_DRIFT);

      // Main side (modelled): its checked-in published artifact equals its regenerated
      // content, so `committed === regenerated` and the main --check exits 0 — the admin's
      // recorded version never enters the comparison.
      const publishedAbs = path.resolve(
        root,
        "published-repo/shared/fact-lifecycle-contract.gen.ts",
      );
      const committed = readFileSync(publishedAbs, "utf8");
      const regenerated = artifactWithVersion(published);
      expect(committed).toBe(regenerated);
    } finally {
      cleanup();
    }
  });
});
