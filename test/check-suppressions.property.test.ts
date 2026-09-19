/**
 * Feature: admin-quality-gates-and-shared-contracts, Property 4: Suppression comparison biconditional
 *
 * *For any* baseline map (path → count), measured map (path → count), and set of
 * files present in the repository, `Suppression_Check` exits 0 **if and only if**
 * every scanned file's measured count is less than or equal to its baseline count
 * (an absent baseline entry treated as 0) **and** every baseline entry corresponds
 * to a file present in the repository; in every failing case it reports the
 * responsible path(s) on standard error and leaves the baseline file unmodified,
 * and in the under-baseline case it reports the improvement on standard output
 * while still exiting 0.
 *
 * Validates: Requirements 4.3, 4.4, 4.7, 4.8, 4.10
 *
 * The biconditional is driven over the pure comparator `compareSuppressions`,
 * which takes the three maps as data — 200 fast-check iterations, no I/O. Five
 * temporary fixture directories carrying a real `suppression-baseline.json`
 * (created once each, not per iteration, to stay inside the 10 s per-test and
 * 120 s whole-suite budgets) give filesystem-level confidence that the real
 * runner agrees with the comparator and that the baseline file is byte-identical
 * afterwards, on the passing and the failing paths alike.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

interface SuppressionOutcome {
  ok: boolean;
  exitCode: number;
  stdout: string[];
  stderr: string[];
}

interface SuppressionCheckModule {
  BASELINE_FILENAME: string;
  EXIT_COMPARISON_FAILURE: number;
  EXIT_BASELINE_UNREADABLE: number;
  countSuppressions(source: string): { total: number; byForm: Record<string, number> };
  compareSuppressions(input: {
    measured: Record<string, number>;
    baseline?: Record<string, number>;
    presentPaths?: Iterable<string>;
  }): SuppressionOutcome;
  measureSuppressions(root: string, options?: { scanDir?: string }): Record<string, number>;
  listScannedFiles(root: string, scanDir?: string): string[];
  parseBaseline(text: string): Record<string, number>;
  runSuppressionCheck(root?: string, options?: { scanDir?: string }): SuppressionOutcome;
}

// `scripts/check-suppressions.mjs` is a plain Node ESM script with no type
// declarations, and the repository `tsconfig.json` does not enable `allowJs`, so a
// static relative import of it would not typecheck. Loading it through a computed
// specifier keeps `tsc --noEmit` clean while still exercising the real module.
const CHECKER_SPECIFIER = new URL("../scripts/check-suppressions.mjs", import.meta.url).href;
const suppressionCheck = (await import(
  /* @vite-ignore */ CHECKER_SPECIFIER
)) as SuppressionCheckModule;
const { compareSuppressions, countSuppressions, runSuppressionCheck } = suppressionCheck;
const { BASELINE_FILENAME, EXIT_COMPARISON_FAILURE } = suppressionCheck;

// ---------------------------------------------------------------------------
// The oracle: Requirement 4.10 restated independently of the implementation.
// ---------------------------------------------------------------------------

function normalize(candidate: string): string {
  return candidate.replace(/\\/g, "/").replace(/^\.\//, "");
}

function normalizeMap(map: Record<string, number>): Record<string, number> {
  const normalized: Record<string, number> = {};
  for (const [key, value] of Object.entries(map)) normalized[normalize(key)] = value;
  return normalized;
}

/**
 * Requirement 4.10: exit 0 iff every scanned file is within its baseline (absent
 * entry treated as 0) and every baseline entry maps to a present path.
 */
function shouldPass(input: {
  measured: Record<string, number>;
  baseline: Record<string, number>;
  presentPaths: readonly string[];
}): boolean {
  const measured = normalizeMap(input.measured);
  const baseline = normalizeMap(input.baseline);
  const present = new Set(input.presentPaths.map(normalize));

  const everyFileWithinBaseline = Object.entries(measured).every(
    ([filePath, count]) => count <= (baseline[filePath] ?? 0),
  );
  const everyEntryPresent = Object.keys(baseline).every((filePath) => present.has(filePath));

  return everyFileWithinBaseline && everyEntryPresent;
}

// ---------------------------------------------------------------------------
// Generators — one case kind per clause of Requirement 4
// ---------------------------------------------------------------------------

/**
 * The comparison-relevant situations a single file can be in. Names mirror the
 * requirement clauses: `over` is 4.4, `under` is 4.7, `unbaselinedOccurrences`
 * is 4.8, `stale` is 4.9, and `exact` / `unbaselinedZero` /
 * `baselinedNotScanned` are the passing shapes 4.3 has to accept.
 */
type CaseKind =
  | "over"
  | "exact"
  | "under"
  | "unbaselinedZero"
  | "unbaselinedOccurrences"
  | "stale"
  | "baselinedNotScanned";

const CASE_KINDS: readonly CaseKind[] = [
  "over",
  "exact",
  "under",
  "unbaselinedZero",
  "unbaselinedOccurrences",
  "stale",
  "baselinedNotScanned",
];

/** Kinds the requirement says must fail the check. */
const FAILING_KINDS: ReadonlySet<CaseKind> = new Set<CaseKind>([
  "over",
  "unbaselinedOccurrences",
  "stale",
]);

interface FileCase {
  filePath: string;
  kind: CaseKind;
  /** Resolved baseline count, when the file has a baseline entry. */
  baselineCount: number;
  /** Resolved measured count, when the file is in the scan set. */
  measuredCount: number;
}

const scannedPathArb = fc
  .tuple(
    fc.constantFrom("", "lib/", "lib/admin/", "routes/api/internal/", "a/b/c/d/"),
    fc.constantFrom("alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"),
    fc.constantFrom(".ts", ".tsx"),
  )
  .map(([dir, base, ext]) => `src/${dir}${base}${ext}`);

const rawFileCaseArb = fc.record({
  filePath: scannedPathArb,
  kind: fc.constantFrom(...CASE_KINDS),
  base: fc.nat({ max: 5 }),
  delta: fc.integer({ min: 1, max: 4 }),
});

function resolveCase(raw: {
  filePath: string;
  kind: CaseKind;
  base: number;
  delta: number;
}): FileCase {
  const { filePath, kind, base, delta } = raw;
  switch (kind) {
    case "over":
      return { filePath, kind, baselineCount: base, measuredCount: base + delta };
    case "exact":
      return { filePath, kind, baselineCount: base, measuredCount: base };
    case "under":
      // baseline strictly greater than measured, so baseline is at least 1.
      return { filePath, kind, baselineCount: base + delta, measuredCount: base };
    case "unbaselinedZero":
      return { filePath, kind, baselineCount: 0, measuredCount: 0 };
    case "unbaselinedOccurrences":
      return { filePath, kind, baselineCount: 0, measuredCount: delta };
    case "stale":
    case "baselinedNotScanned":
      return { filePath, kind, baselineCount: base, measuredCount: 0 };
  }
}

/** True when the case contributes a baseline entry. */
function hasBaselineEntry(fileCase: FileCase): boolean {
  return fileCase.kind !== "unbaselinedZero" && fileCase.kind !== "unbaselinedOccurrences";
}

/** True when the case contributes a measured (scanned) entry. */
function isScanned(fileCase: FileCase): boolean {
  return fileCase.kind !== "stale" && fileCase.kind !== "baselinedNotScanned";
}

interface ComparisonScenario {
  cases: FileCase[];
  measured: Record<string, number>;
  baseline: Record<string, number>;
  presentPaths: string[];
}

const scenarioArb: fc.Arbitrary<ComparisonScenario> = fc
  .record({
    raws: fc.uniqueArray(rawFileCaseArb, {
      minLength: 1,
      maxLength: 8,
      selector: (raw) => raw.filePath,
    }),
    // Separator skew: the comparator normalizes keys, so a Windows-style key must
    // compare identically to its POSIX form.
    useBackslashes: fc.boolean(),
    rotation: fc.nat({ max: 12 }),
  })
  .map(({ raws, useBackslashes, rotation }) => {
    const resolved = raws.map(resolveCase);
    // Rotate so no property depends on a fixed insertion order.
    const offset = resolved.length === 0 ? 0 : rotation % resolved.length;
    const cases = [...resolved.slice(offset), ...resolved.slice(0, offset)];

    const skew = (candidate: string): string =>
      useBackslashes ? candidate.replace(/\//g, "\\") : candidate;

    const measured: Record<string, number> = {};
    const baseline: Record<string, number> = {};
    const presentPaths: string[] = [];

    for (const fileCase of cases) {
      if (isScanned(fileCase)) {
        measured[skew(fileCase.filePath)] = fileCase.measuredCount;
        presentPaths.push(fileCase.filePath);
      }
      if (hasBaselineEntry(fileCase)) {
        baseline[skew(fileCase.filePath)] = fileCase.baselineCount;
      }
      // A `baselinedNotScanned` file is present in the repository but outside the
      // scan set (Requirement 4.10 asks only that the entry corresponds to a
      // present file), so it is present without being measured. A `stale` file is
      // neither.
      if (fileCase.kind === "baselinedNotScanned") presentPaths.push(fileCase.filePath);
    }

    return { cases, measured, baseline, presentPaths };
  });

function frozenCall(scenario: ComparisonScenario): SuppressionOutcome {
  return compareSuppressions({
    measured: Object.freeze({ ...scenario.measured }),
    baseline: Object.freeze({ ...scenario.baseline }),
    presentPaths: Object.freeze([...scenario.presentPaths]),
  });
}

// ---------------------------------------------------------------------------
// Property 4 — the biconditional
// ---------------------------------------------------------------------------

describe("Property 4: Suppression comparison biconditional", () => {
  it("exits 0 if and only if every measured count is within baseline and every baseline entry is present", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const outcome = frozenCall(scenario);
        const expectedPass = shouldPass(scenario);

        // Cross-check the oracle against the generated case kinds: the two
        // independent statements of the pass condition must agree.
        const noFailingKind = !scenario.cases.some((fileCase) =>
          FAILING_KINDS.has(fileCase.kind),
        );
        expect(expectedPass).toBe(noFailingKind);

        // The biconditional, in both directions, on both halves of the result.
        expect(outcome.ok).toBe(expectedPass);
        expect(outcome.exitCode === 0).toBe(expectedPass);

        if (expectedPass) {
          // Requirement 4.3: the pass condition writes nothing to standard error.
          expect(outcome.stderr).toEqual([]);
        } else {
          expect(outcome.exitCode).toBe(EXIT_COMPARISON_FAILURE);
          expect(outcome.stderr.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("names the responsible path with its baseline and measured counts on standard error", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const outcome = frozenCall(scenario);
        const diagnostic = outcome.stderr.join("\n");

        for (const fileCase of scenario.cases) {
          if (fileCase.kind === "over") {
            // Requirement 4.4: path, recorded baseline, measured count.
            expect(diagnostic).toContain(fileCase.filePath);
            expect(diagnostic).toContain(
              `${fileCase.filePath}: baseline ${fileCase.baselineCount}, measured ${fileCase.measuredCount}`,
            );
          } else if (fileCase.kind === "unbaselinedOccurrences") {
            // Requirement 4.8: absent entry treated as baseline 0, path + measured.
            expect(diagnostic).toContain(fileCase.filePath);
            expect(diagnostic).toContain(
              `${fileCase.filePath}: baseline 0 (no entry), measured ${fileCase.measuredCount}`,
            );
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("reports every under-baseline improvement on standard output with path, baseline and measured", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const outcome = frozenCall(scenario);
        const report = outcome.stdout.join("\n");

        for (const fileCase of scenario.cases) {
          if (fileCase.kind !== "under") continue;
          // Requirement 4.7: the improvement is reported on standard output.
          expect(report).toContain(
            `${fileCase.filePath}: baseline ${fileCase.baselineCount}, measured ${fileCase.measuredCount}`,
          );
          expect(outcome.stderr.join("\n")).not.toContain(
            `${fileCase.filePath}: baseline ${fileCase.baselineCount}, measured ${fileCase.measuredCount}`,
          );
        }
      }),
      { numRuns: 200 },
    );
  });

  it("still exits 0 when the only deviation from baseline is an improvement", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        // Restrict to scenarios whose only non-exact case kind is `under`.
        fc.pre(scenario.cases.some((fileCase) => fileCase.kind === "under"));
        fc.pre(!scenario.cases.some((fileCase) => FAILING_KINDS.has(fileCase.kind)));

        const outcome = frozenCall(scenario);

        // Requirement 4.7: an improvement is informational, never a failure.
        expect(outcome.ok).toBe(true);
        expect(outcome.exitCode).toBe(0);
        expect(outcome.stderr).toEqual([]);
        expect(outcome.stdout.length).toBeGreaterThan(0);
      }),
      { numRuns: 200 },
    );
  });

  it("mutates neither the measured map, the baseline map, nor the present-path set", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const measuredBefore = { ...scenario.measured };
        const baselineBefore = { ...scenario.baseline };
        const presentBefore = [...scenario.presentPaths];

        // Frozen inputs: an in-place write by the comparator would throw here.
        frozenCall(scenario);

        expect(scenario.measured).toEqual(measuredBefore);
        expect(scenario.baseline).toEqual(baselineBefore);
        expect(scenario.presentPaths).toEqual(presentBefore);
      }),
      { numRuns: 200 },
    );
  });

  it("is deterministic: the same three maps always compare identically", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        expect(frozenCall(scenario)).toEqual(frozenCall(scenario));
      }),
      { numRuns: 200 },
    );
  });

  it("defaults the present-path set to the measured paths, so a baseline entry outside the scan set is stale", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const outcome = compareSuppressions({
          measured: { ...scenario.measured },
          baseline: { ...scenario.baseline },
        });
        const expectedPass = shouldPass({
          measured: scenario.measured,
          baseline: scenario.baseline,
          presentPaths: Object.keys(scenario.measured),
        });

        expect(outcome.ok).toBe(expectedPass);
        expect(outcome.exitCode === 0).toBe(expectedPass);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Filesystem-level confirmation: the runner never rewrites the baseline file.
// ---------------------------------------------------------------------------

/** Source with no Type_Suppression occurrence. */
const CLEAN_SOURCE = "export const value = 1;\nexport function identity(n: number) {\n  return n;\n}\n";

/** Source carrying exactly two explicit `any` annotations. */
const TWO_SUPPRESSIONS_SOURCE = "export function pair(x: any, y: any) {\n  return [x, y];\n}\n";

/** Source carrying exactly one cast to `any`. */
const ONE_SUPPRESSION_SOURCE = "export const widened = (0 as any);\n";

interface FixtureCase {
  name: string;
  /** Scanned sources, keyed by repo-relative path. */
  sources: Record<string, string>;
  baseline: Record<string, number>;
  expectedPass: boolean;
  /** Substrings the failing diagnostic, or the passing report, must contain. */
  namedInStderr?: string[];
  namedInStdout?: string[];
}

const fixtureCases: FixtureCase[] = [
  {
    name: "every scanned file exactly at its baseline",
    sources: { "src/clean.ts": CLEAN_SOURCE, "src/one.ts": ONE_SUPPRESSION_SOURCE },
    baseline: { "src/clean.ts": 0, "src/one.ts": 1 },
    expectedPass: true,
  },
  {
    name: "a scanned file over its baseline (Requirement 4.4)",
    sources: { "src/two.ts": TWO_SUPPRESSIONS_SOURCE },
    baseline: { "src/two.ts": 1 },
    expectedPass: false,
    namedInStderr: ["src/two.ts: baseline 1, measured 2"],
  },
  {
    name: "a scanned file with occurrences and no baseline entry (Requirement 4.8)",
    sources: { "src/one.ts": ONE_SUPPRESSION_SOURCE },
    baseline: {},
    expectedPass: false,
    namedInStderr: ["src/one.ts: baseline 0 (no entry), measured 1"],
  },
  {
    name: "a scanned file under its baseline (Requirement 4.7)",
    sources: { "src/one.ts": ONE_SUPPRESSION_SOURCE },
    baseline: { "src/one.ts": 3 },
    expectedPass: true,
    namedInStdout: ["src/one.ts: baseline 3, measured 1"],
  },
  {
    name: "a stale baseline entry naming an absent path (Requirement 4.9)",
    sources: { "src/clean.ts": CLEAN_SOURCE },
    baseline: { "src/clean.ts": 0, "src/removed.ts": 2 },
    expectedPass: false,
    namedInStderr: ["src/removed.ts"],
  },
];

function createFixture(fixtureCase: FixtureCase): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "suppression-check-"));
  for (const [relativePath, source] of Object.entries(fixtureCase.sources)) {
    const absolute = path.join(root, relativePath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, source, "utf8");
  }
  // A real, tracked-shape baseline document, written with trailing newline and
  // two-space indentation exactly as the repository's own file is.
  writeFileSync(
    path.join(root, BASELINE_FILENAME),
    `${JSON.stringify(fixtureCase.baseline, null, 2)}\n`,
    "utf8",
  );
  return root;
}

describe("Property 4 over real fixture directories: the baseline file is never rewritten", () => {
  for (const fixtureCase of fixtureCases) {
    it(`compares ${fixtureCase.name} and leaves ${BASELINE_FILENAME} byte-identical`, () => {
      const root = createFixture(fixtureCase);
      const baselinePath = path.join(root, BASELINE_FILENAME);
      try {
        const before = readFileSync(baselinePath);
        const outcome = runSuppressionCheck(root);
        const after = readFileSync(baselinePath);

        expect(outcome.ok).toBe(fixtureCase.expectedPass);
        expect(outcome.exitCode === 0).toBe(fixtureCase.expectedPass);

        if (fixtureCase.expectedPass) {
          // Requirement 4.3.
          expect(outcome.stderr).toEqual([]);
        } else {
          expect(outcome.exitCode).toBe(EXIT_COMPARISON_FAILURE);
          const diagnostic = outcome.stderr.join("\n");
          for (const named of fixtureCase.namedInStderr ?? []) {
            expect(diagnostic).toContain(named);
          }
        }

        const report = outcome.stdout.join("\n");
        for (const named of fixtureCase.namedInStdout ?? []) {
          expect(report).toContain(named);
        }

        // Requirements 4.4 / 4.10: the baseline is a ratchet, never rewritten —
        // on the failing paths as much as the passing ones.
        expect(after.equals(before)).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true, maxRetries: 3 });
      }
    });
  }

  it("measures the fixture sources at the counts the fixtures assume", () => {
    // Guards the fixtures above against a silent drift in the counter, which
    // would otherwise turn a real regression into a passing test.
    expect(countSuppressions(CLEAN_SOURCE).total).toBe(0);
    expect(countSuppressions(ONE_SUPPRESSION_SOURCE).total).toBe(1);
    expect(countSuppressions(TWO_SUPPRESSIONS_SOURCE).total).toBe(2);
  });
});
