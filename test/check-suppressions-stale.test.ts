/**
 * Edge-case coverage for a stale Suppression_Check baseline entry (task 4.4).
 *
 * Feature: admin-quality-gates-and-shared-contracts
 *
 * Requirement 4.9: IF the baseline file records an entry whose path is not
 * present in Admin_Repository, THEN Suppression_Check SHALL write that path to
 * standard error, SHALL indicate that the entry is stale and must be removed
 * from the baseline file, and SHALL exit with a non-zero status code.
 *
 * `test/check-suppressions.property.test.ts` already establishes the
 * biconditional of Requirement 4.10 over the pure comparator, including one
 * fixture whose baseline names an absent path. This file pins the parts of 4.9
 * that a biconditional cannot express, at the level of the real runner and the
 * real CLI:
 *
 *   - the exact diagnostic wording — the stale path is named AND the operator is
 *     told to remove the entry from `suppression-baseline.json`;
 *   - a genuinely non-zero process exit code, so Quality_Gate short-circuits;
 *   - the baseline file is left byte-identical, because the ratchet must not
 *     repair itself by dropping the entry;
 *   - a stale entry fails the check even when every scanned file is within its
 *     baseline, so staleness is an independent failure and not a side effect of
 *     some other clause firing;
 *   - every stale entry is reported when several are stale at once, not just the
 *     first;
 *   - a baseline entry naming a file that is present but outside the scan set is
 *     NOT stale, which is the boundary the requirement turns on ("not present in
 *     Admin_Repository", not "not scanned").
 *
 * Every temporary directory created here is removed in `afterEach`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

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
  compareSuppressions(input: {
    measured: Record<string, number>;
    baseline?: Record<string, number>;
    presentPaths?: Iterable<string>;
  }): SuppressionOutcome;
  parseBaseline(text: string): Record<string, number>;
  runSuppressionCheck(root?: string, options?: { scanDir?: string }): SuppressionOutcome;
}

// `scripts/check-suppressions.mjs` is a plain Node ESM script with no type
// declarations, and the repository `tsconfig.json` does not enable `allowJs`, so a
// static relative import would not typecheck. A computed specifier keeps
// `tsc --noEmit` clean while still exercising the real module.
const CHECKER_SPECIFIER = new URL("../scripts/check-suppressions.mjs", import.meta.url).href;
const suppressionCheck = (await import(
  /* @vite-ignore */ CHECKER_SPECIFIER
)) as SuppressionCheckModule;
const { compareSuppressions, parseBaseline, runSuppressionCheck } = suppressionCheck;
const { BASELINE_FILENAME, EXIT_BASELINE_UNREADABLE, EXIT_COMPARISON_FAILURE } =
  suppressionCheck;

const scriptPath = fileURLToPath(CHECKER_SPECIFIER);

// ---------------------------------------------------------------------------
// Fixture plumbing
// ---------------------------------------------------------------------------

/** Source with no Type_Suppression occurrence. */
const CLEAN_SOURCE = "export const value = 1;\nexport function identity(n: number) {\n  return n;\n}\n";

/** Source carrying exactly one cast to `any`. */
const ONE_SUPPRESSION_SOURCE = "export const widened = (0 as any);\n";

const createdTempDirs: string[] = [];

function createFixture(
  sources: Record<string, string>,
  baseline: Record<string, number>,
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suppression-stale-"));
  createdTempDirs.push(root);
  for (const [relativePath, source] of Object.entries(sources)) {
    const absolute = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, source, "utf8");
  }
  // The same shape as the repository's own tracked baseline: two-space
  // indentation and a trailing newline.
  fs.writeFileSync(
    path.join(root, BASELINE_FILENAME),
    `${JSON.stringify(baseline, null, 2)}\n`,
    "utf8",
  );
  return root;
}

afterEach(() => {
  for (; ;) {
    const dir = createdTempDirs.pop();
    if (dir === undefined) break;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

// ---------------------------------------------------------------------------
// Requirement 4.9 — a stale entry is named, explained, and fatal
// ---------------------------------------------------------------------------

describe("Suppression_Check rejects a stale baseline entry (Requirement 4.9)", () => {
  it("names the absent path and says to remove it from the baseline file", () => {
    const root = createFixture(
      { "src/clean.ts": CLEAN_SOURCE },
      { "src/clean.ts": 0, "src/deleted/gone.ts": 3 },
    );

    const outcome = runSuppressionCheck(root);
    const stderr = outcome.stderr.join("\n");

    // The path itself, and the instruction, both on standard error.
    expect(stderr).toContain("src/deleted/gone.ts");
    expect(stderr).toContain("src/deleted/gone.ts: stale, remove from baseline");
    expect(stderr).toContain(
      `1 baseline entry is stale — the path is not present in the repository and must be removed from ${BASELINE_FILENAME}`,
    );

    // Nothing on standard output claims a pass.
    expect(outcome.stdout.join("\n")).not.toContain("OK");
  });

  it("exits with the comparison-failure code, not the baseline-unreadable code", () => {
    const root = createFixture(
      { "src/clean.ts": CLEAN_SOURCE },
      { "src/clean.ts": 0, "src/deleted/gone.ts": 3 },
    );

    // The baseline document itself is well-formed: the failure is staleness, not
    // an unreadable ratchet file.
    const baselineText = fs.readFileSync(path.join(root, BASELINE_FILENAME), "utf8");
    expect(parseBaseline(baselineText)).toEqual({
      "src/clean.ts": 0,
      "src/deleted/gone.ts": 3,
    });

    const outcome = runSuppressionCheck(root);

    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.exitCode).toBe(EXIT_COMPARISON_FAILURE);
    expect(outcome.exitCode).not.toBe(EXIT_BASELINE_UNREADABLE);
  });

  it("exits non-zero as a process, so Quality_Gate short-circuits", () => {
    const root = createFixture(
      { "src/clean.ts": CLEAN_SOURCE },
      { "src/clean.ts": 0, "src/deleted/gone.ts": 3 },
    );

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });

    if (result.error) throw result.error;
    expect(result.status).toBe(EXIT_COMPARISON_FAILURE);
    expect(result.stderr).toContain("src/deleted/gone.ts");
    expect(result.stderr).toContain("remove from baseline");
  });

  it("fails even though every scanned file is within its baseline", () => {
    const root = createFixture(
      // Both scanned files are within baseline: one exactly at it, one below it.
      { "src/clean.ts": CLEAN_SOURCE, "src/one.ts": ONE_SUPPRESSION_SOURCE },
      { "src/clean.ts": 0, "src/one.ts": 4, "src/deleted/gone.ts": 1 },
    );

    const outcome = runSuppressionCheck(root);
    const stderr = outcome.stderr.join("\n");

    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).toBe(EXIT_COMPARISON_FAILURE);

    // Staleness is the sole reason: neither of the other two failing clauses is
    // reported.
    expect(stderr).toContain("stale");
    expect(stderr).not.toContain("exceed the recorded Type_Suppression baseline");
    expect(stderr).not.toContain("no baseline entry");

    // The under-baseline improvement is still reported on standard output.
    expect(outcome.stdout.join("\n")).toContain("src/one.ts: baseline 4, measured 1");
  });

  it("reports every stale entry, in lexicographic order, with plural wording", () => {
    const staleEntries = ["src/z/last.ts", "src/a/first.ts", "src/m/middle.tsx"];
    const baseline: Record<string, number> = { "src/clean.ts": 0 };
    for (const [index, entry] of staleEntries.entries()) baseline[entry] = index + 1;

    const root = createFixture({ "src/clean.ts": CLEAN_SOURCE }, baseline);

    const outcome = runSuppressionCheck(root);
    const stderr = outcome.stderr.join("\n");

    expect(outcome.exitCode).toBe(EXIT_COMPARISON_FAILURE);
    expect(stderr).toContain(
      `3 baseline entries are stale — the path is not present in the repository and must be removed from ${BASELINE_FILENAME}`,
    );

    // Each stale path is named with the removal instruction.
    for (const entry of staleEntries) {
      expect(stderr).toContain(`${entry}: stale, remove from baseline`);
    }

    // Lexicographic order, matching the reporting order used elsewhere in the check.
    const reportedOrder = outcome.stderr
      .filter((line) => line.includes(": stale, remove from baseline"))
      .map((line) => line.trim().split(":")[0]);
    expect(reportedOrder).toEqual([...staleEntries].sort());
  });

  it("leaves the baseline file byte-identical instead of dropping the stale entry", () => {
    const root = createFixture(
      { "src/clean.ts": CLEAN_SOURCE },
      { "src/clean.ts": 0, "src/deleted/gone.ts": 3 },
    );
    const baselinePath = path.join(root, BASELINE_FILENAME);
    const before = fs.readFileSync(baselinePath);

    const outcome = runSuppressionCheck(root);

    expect(outcome.exitCode).toBe(EXIT_COMPARISON_FAILURE);
    expect(fs.readFileSync(baselinePath).equals(before)).toBe(true);
    // The check says so as well, so the operator is not left guessing.
    expect(outcome.stderr.join("\n")).toContain(
      `${BASELINE_FILENAME} is a ratchet and was not modified`,
    );
  });

  it("passes once the stale entry is removed, with nothing on standard error", () => {
    const root = createFixture(
      { "src/clean.ts": CLEAN_SOURCE },
      { "src/clean.ts": 0, "src/deleted/gone.ts": 3 },
    );
    const baselinePath = path.join(root, BASELINE_FILENAME);

    expect(runSuppressionCheck(root).exitCode).toBe(EXIT_COMPARISON_FAILURE);

    // The documented remedy, applied.
    fs.writeFileSync(baselinePath, `${JSON.stringify({ "src/clean.ts": 0 }, null, 2)}\n`, "utf8");

    const outcome = runSuppressionCheck(root);
    expect(outcome.ok).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderr).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The boundary: "absent from the repository", not "absent from the scan set"
// ---------------------------------------------------------------------------

describe("Suppression_Check distinguishes a stale entry from an unscanned one", () => {
  it("does not treat a baseline entry naming a present file outside the scan set as stale", () => {
    const root = createFixture({ "src/clean.ts": CLEAN_SOURCE }, { "src/clean.ts": 0 });

    // Present in the repository, but outside `src/`, so never measured.
    fs.writeFileSync(path.join(root, "vite.config.ts"), CLEAN_SOURCE, "utf8");
    fs.writeFileSync(
      path.join(root, BASELINE_FILENAME),
      `${JSON.stringify({ "src/clean.ts": 0, "vite.config.ts": 0 }, null, 2)}\n`,
      "utf8",
    );

    const outcome = runSuppressionCheck(root);

    expect(outcome.ok).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderr).toEqual([]);
  });

  it("treats the same entry as stale once the file is deleted", () => {
    const root = createFixture({ "src/clean.ts": CLEAN_SOURCE }, { "src/clean.ts": 0 });

    const outsideScan = path.join(root, "vite.config.ts");
    fs.writeFileSync(outsideScan, CLEAN_SOURCE, "utf8");
    fs.writeFileSync(
      path.join(root, BASELINE_FILENAME),
      `${JSON.stringify({ "src/clean.ts": 0, "vite.config.ts": 0 }, null, 2)}\n`,
      "utf8",
    );
    expect(runSuppressionCheck(root).exitCode).toBe(0);

    fs.rmSync(outsideScan);

    const outcome = runSuppressionCheck(root);
    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).toBe(EXIT_COMPARISON_FAILURE);
    expect(outcome.stderr.join("\n")).toContain("vite.config.ts: stale, remove from baseline");
  });

  it("agrees with the pure comparator on the stale verdict", () => {
    // The comparator defaults `presentPaths` to the measured paths, so an entry
    // for a file it never measured is stale by construction — the same verdict
    // the runner reaches through the filesystem.
    const outcome = compareSuppressions({
      measured: { "src/clean.ts": 0 },
      baseline: { "src/clean.ts": 0, "src/deleted/gone.ts": 3 },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).toBe(EXIT_COMPARISON_FAILURE);
    expect(outcome.stderr.join("\n")).toContain(
      "src/deleted/gone.ts: stale, remove from baseline",
    );
  });
});
