/**
 * Property coverage for Lockfile_Check reporting behaviour (task 2.3).
 *
 * Feature: admin-quality-gates-and-shared-contracts
 *
 * Property 2: Offending lockfiles are reported in lexicographic order
 *   For any set of git-tracked paths containing one or more forbidden lockfile
 *   names, the paths Lockfile_Check writes to standard error are exactly those
 *   offending paths, ordered lexicographically.
 *   Validates: Requirements 2.2
 *
 * Property 3: Untracked local lockfile artifacts do not fail the check
 *   For any pair of (tracked-path set, on-disk path set) in which a forbidden
 *   lockfile name appears only on disk and not in the tracked set,
 *   Lockfile_Check writes an advisory naming that path to standard output and
 *   exits 0 (provided the tracked set otherwise satisfies Property 1).
 *   Validates: Requirements 2.4
 *
 * Both properties are driven through the pure classifier
 * (`classifyLockfiles`) rather than through `runLockfileCheck`, so no temporary
 * git repository is created and the run stays fast. The ordering assertion is
 * byte-wise, matching the implementation, which deliberately does not use
 * locale-aware collation: the generated directory segments include `A`, `_tmp`
 * and `apps`, whose byte order (`A` < `_tmp` < `apps`) differs from the order a
 * locale-aware comparison would produce.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

interface LockfileOutcome {
  ok: boolean;
  exitCode: number;
  stdout: string[];
  stderr: string[];
}

interface LockfileCheckModule {
  REQUIRED_LOCKFILE: string;
  FORBIDDEN_LOCKFILE_NAMES: readonly string[];
  classifyLockfiles(input: {
    trackedPaths: Iterable<string>;
    onDiskPaths?: Iterable<string>;
  }): LockfileOutcome;
}

// `scripts/check-lockfiles.mjs` is a plain Node ESM script with no type
// declarations, and the repository `tsconfig.json` does not enable `allowJs`, so
// a static relative import of it would not typecheck. Loading it through a
// computed specifier keeps `tsc --noEmit` clean while still exercising the real
// module.
const CHECKER_SPECIFIER = new URL("../scripts/check-lockfiles.mjs", import.meta.url).href;
const lockfileCheck = (await import(/* @vite-ignore */ CHECKER_SPECIFIER)) as LockfileCheckModule;
const { classifyLockfiles, FORBIDDEN_LOCKFILE_NAMES, REQUIRED_LOCKFILE } = lockfileCheck;

/** ≥100 iterations per property, per the design's Testing Strategy. */
const NUM_RUNS = 200;

/** Byte-wise lexicographic order — the order the implementation reports in. */
function sortByteWise(paths: readonly string[]): string[] {
  return [...paths].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

/**
 * Directory segments chosen so that byte-wise and locale-aware ordering of the
 * generated paths disagree: `A` (0x41) < `_tmp` (0x5f) < `apps` (0x61).
 */
const directorySegment = fc.constantFrom(
  "A",
  "_tmp",
  "apps",
  "Apps",
  "packages",
  "Packages",
  "tools-legacy",
  "nested",
  "zz",
);

const forbiddenName = fc.constantFrom(...FORBIDDEN_LOCKFILE_NAMES);

/**
 * Names that must never be treated as offending. Several are deliberate near
 * misses on a forbidden basename, which is what makes the "exactly those
 * offending paths" half of Property 2 meaningful.
 */
const innocuousName = fc.constantFrom(
  "package.json",
  "README.md",
  "index.ts",
  "bun.lock.txt",
  "yarn.lock.bak",
  "pnpm-lock.yaml.orig",
  "not-bun.lock.md",
  "package-lock.json.bak",
);

/** A repo-relative path at depth 0-3 ending in `name`. */
function relativePath(name: fc.Arbitrary<string>): fc.Arbitrary<string> {
  return fc
    .tuple(fc.array(directorySegment, { maxLength: 3 }), name)
    .map(([directories, basename]) => [...directories, basename].join("/"));
}

/** Presents `paths` to the classifier in an arbitrary order. */
function shuffled(paths: readonly string[]): fc.Arbitrary<string[]> {
  return fc.shuffledSubarray([...paths], {
    minLength: paths.length,
    maxLength: paths.length,
  });
}

/** The indented path lines the classifier emits, one per offending path. */
function reportedPaths(stderr: readonly string[]): string[] {
  return stderr
    .map((line) => /^ {2}(\S.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1]);
}

/**
 * The paths named by the stdout advisories. Extracted rather than substring
 * matched: `bun.lock` is a substring of `A/bun.lock`, so a substring test
 * cannot tell the two advisories apart.
 */
function advisedPaths(stdout: readonly string[]): string[] {
  return stdout
    .map((line) => /advisory:\s+(\S+)\s/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1]);
}

describe("Property 2: Offending lockfiles are reported in lexicographic order", () => {
  it("writes exactly the offending tracked paths to stderr, byte-wise sorted", () => {
    const trackedWithOffenders = fc
      .tuple(
        fc.uniqueArray(relativePath(forbiddenName), { minLength: 1, maxLength: 6 }),
        fc.uniqueArray(relativePath(innocuousName), { maxLength: 6 }),
        fc.boolean(),
      )
      .chain(([offending, innocuous, requiredLockfileTracked]) => {
        const tracked = unique([
          ...offending,
          ...innocuous,
          ...(requiredLockfileTracked ? [REQUIRED_LOCKFILE] : []),
        ]);
        return shuffled(tracked).map((trackedPaths) => ({
          trackedPaths,
          expectedOffending: unique(offending),
        }));
      });

    fc.assert(
      fc.property(trackedWithOffenders, ({ trackedPaths, expectedOffending }) => {
        const outcome = classifyLockfiles({ trackedPaths });

        // Reported paths are exactly the offending ones, in byte-wise order.
        expect(reportedPaths(outcome.stderr)).toEqual(sortByteWise(expectedOffending));

        // A tracked forbidden lockfile is a failure regardless of input order
        // or of whether package-lock.json happens to be tracked too.
        expect(outcome.ok).toBe(false);
        expect(outcome.exitCode).not.toBe(0);
        expect(outcome.stdout).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("reports the same paths in the same order however the input is ordered", () => {
    const twoOrderingsOfTheSameSet = fc
      .uniqueArray(relativePath(forbiddenName), { minLength: 2, maxLength: 6 })
      .chain((offending) => {
        const tracked = unique([...offending, REQUIRED_LOCKFILE]);
        return fc.tuple(shuffled(tracked), shuffled(tracked));
      });

    fc.assert(
      fc.property(twoOrderingsOfTheSameSet, ([firstOrder, secondOrder]) => {
        const first = classifyLockfiles({ trackedPaths: firstOrder });
        const second = classifyLockfiles({ trackedPaths: secondOrder });
        expect(first.stderr).toEqual(second.stderr);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Property 3: Untracked local lockfile artifacts do not fail the check", () => {
  it("advises on stdout and exits 0 when a forbidden name is only on disk", () => {
    const untrackedArtifactScenario = fc
      .tuple(
        fc.uniqueArray(relativePath(innocuousName), { maxLength: 6 }),
        fc.uniqueArray(relativePath(forbiddenName), { minLength: 1, maxLength: 6 }),
        fc.uniqueArray(relativePath(innocuousName), { maxLength: 4 }),
      )
      .chain(([extraTracked, untrackedArtifacts, otherOnDisk]) => {
        // The tracked set satisfies Property 1: package-lock.json at the root
        // and no forbidden basename at any depth.
        const tracked = unique([REQUIRED_LOCKFILE, ...extraTracked]);
        const onDisk = unique([REQUIRED_LOCKFILE, ...untrackedArtifacts, ...otherOnDisk]);
        return fc
          .tuple(shuffled(tracked), shuffled(onDisk))
          .map(([trackedPaths, onDiskPaths]) => ({
            trackedPaths,
            onDiskPaths,
            untrackedArtifacts: unique(untrackedArtifacts),
          }));
      });

    fc.assert(
      fc.property(
        untrackedArtifactScenario,
        ({ trackedPaths, onDiskPaths, untrackedArtifacts }) => {
          const outcome = classifyLockfiles({ trackedPaths, onDiskPaths });

          // A local install artifact never fails the check.
          expect(outcome.ok).toBe(true);
          expect(outcome.exitCode).toBe(0);
          expect(outcome.stderr).toEqual([]);

          // Each artifact is named by exactly one advisory on stdout, and no
          // advisory names anything else.
          expect(outcome.stdout).toHaveLength(untrackedArtifacts.length);
          expect(advisedPaths(outcome.stdout)).toEqual(sortByteWise(untrackedArtifacts));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("stays silent when no forbidden name is present on disk", () => {
    const cleanScenario = fc
      .tuple(
        fc.uniqueArray(relativePath(innocuousName), { maxLength: 6 }),
        fc.uniqueArray(relativePath(innocuousName), { maxLength: 6 }),
      )
      .chain(([extraTracked, otherOnDisk]) => {
        const tracked = unique([REQUIRED_LOCKFILE, ...extraTracked]);
        const onDisk = unique([REQUIRED_LOCKFILE, ...otherOnDisk]);
        return fc.tuple(shuffled(tracked), shuffled(onDisk));
      });

    fc.assert(
      fc.property(cleanScenario, ([trackedPaths, onDiskPaths]) => {
        const outcome = classifyLockfiles({ trackedPaths, onDiskPaths });
        expect(outcome).toEqual({ ok: true, exitCode: 0, stdout: [], stderr: [] });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("does not let an untracked artifact rescue a missing package-lock.json", () => {
    // Requirement 2.4 tolerates the local artifact; it does not relax 2.3.
    const outcome = classifyLockfiles({
      trackedPaths: ["package.json", "src/index.ts"],
      onDiskPaths: ["package.json", "pnpm-lock.yaml"],
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.stderr.join("\n")).toContain(REQUIRED_LOCKFILE);
  });
});
