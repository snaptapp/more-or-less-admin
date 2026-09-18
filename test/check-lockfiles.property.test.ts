/**
 * Feature: admin-quality-gates-and-shared-contracts, Property 1: Lockfile classification
 *
 * *For any* set of git-tracked file paths, `Lockfile_Check` exits 0 **if and only if**
 * that set contains `package-lock.json` at the repository root and contains none of
 * `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `bun.lockb`, or `npm-shrinkwrap.json` at
 * any depth; in the failing case it names the offending or missing path and modifies
 * no file.
 *
 * Validates: Requirements 2.1, 2.2, 2.3
 *
 * The biconditional is driven over the pure classifier `classifyLockfiles`, which
 * takes the tracked-path set as data — 300 fast-check iterations, no I/O. Three
 * temporary git repositories (created once each, not per iteration, to stay inside
 * the 10 s per-test and 120 s whole-suite budgets) give filesystem-level confidence
 * that the real `git ls-files`-backed runner agrees with the classifier and that it
 * leaves the working tree byte-identical.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

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
  runLockfileCheck(cwd?: string): LockfileOutcome;
}

// `scripts/check-lockfiles.mjs` is a plain Node ESM script with no type
// declarations, and the repository `tsconfig.json` does not enable `allowJs`, so a
// static relative import of it would not typecheck. Loading it through a computed
// specifier keeps `tsc --noEmit` clean while still exercising the real module.
const CHECKER_SPECIFIER = new URL("../scripts/check-lockfiles.mjs", import.meta.url).href;
const lockfileCheck = (await import(/* @vite-ignore */ CHECKER_SPECIFIER)) as LockfileCheckModule;
const { classifyLockfiles, runLockfileCheck } = lockfileCheck;

// ---------------------------------------------------------------------------
// The oracle: the requirement's own vocabulary, restated independently of the
// implementation so the property has something real to check against.
// ---------------------------------------------------------------------------

/** Requirement 2.3: the one lockfile that must be tracked, at the repository root. */
const REQUIRED_LOCKFILE = "package-lock.json";

/** Requirement 2.2: forbidden basenames, at any path depth. */
const FORBIDDEN_NAMES = [
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "npm-shrinkwrap.json",
] as const;

function normalize(candidate: string): string {
  return candidate.replace(/\\/g, "/").replace(/^\.\//, "");
}

function basenameOf(candidate: string): string {
  const normalized = normalize(candidate);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

/** Independent restatement of the passing condition (Requirement 2.1). */
function shouldPass(trackedPaths: readonly string[]): boolean {
  const normalized = trackedPaths.map(normalize);
  const hasRequiredAtRoot = normalized.includes(REQUIRED_LOCKFILE);
  const hasForbidden = normalized.some((candidate) =>
    (FORBIDDEN_NAMES as readonly string[]).includes(basenameOf(candidate)),
  );
  return hasRequiredAtRoot && !hasForbidden;
}

function offendingPaths(trackedPaths: readonly string[]): string[] {
  return trackedPaths
    .map(normalize)
    .filter((candidate) => (FORBIDDEN_NAMES as readonly string[]).includes(basenameOf(candidate)));
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Paths that must count as neither the required root lockfile nor a forbidden
 * lockfile. The near-misses are the interesting ones: a nested
 * `package-lock.json` does not satisfy the root requirement, and a name that
 * merely contains a forbidden name is not itself forbidden.
 */
const benignPathArb = fc.constantFrom(
  "package.json",
  "README.md",
  "src/main.tsx",
  "scripts/check-lockfiles.mjs",
  "not-package-lock.json",
  "packages/app/package-lock.json",
  "pnpm-lock.yaml.bak",
  "docs/notes-about-yarn.lock.md",
  "bun.lock.txt",
  "vendor/bun.lock/README.md",
  "npm-shrinkwrap.json.orig",
  "yarnlock",
);

const directoryPrefixArb = fc.constantFrom("", "sub/", "packages/app/", "a/b/c/d/");

const forbiddenPathArb = fc
  .tuple(directoryPrefixArb, fc.constantFrom(...FORBIDDEN_NAMES))
  .map(([prefix, name]) => `${prefix}${name}`);

interface TrackedSetCase {
  trackedPaths: string[];
  useBackslashes: boolean;
}

const trackedSetArb: fc.Arbitrary<TrackedSetCase> = fc
  .record({
    includeRequired: fc.boolean(),
    benign: fc.uniqueArray(benignPathArb, { maxLength: 6 }),
    forbidden: fc.uniqueArray(forbiddenPathArb, { maxLength: 4 }),
    rotation: fc.nat({ max: 12 }),
    useBackslashes: fc.boolean(),
  })
  .map(({ includeRequired, benign, forbidden, rotation, useBackslashes }) => {
    const combined = [...(includeRequired ? [REQUIRED_LOCKFILE] : []), ...benign, ...forbidden];
    // Rotate so the property never depends on a fixed input ordering.
    const offset = combined.length === 0 ? 0 : rotation % combined.length;
    const rotated = [...combined.slice(offset), ...combined.slice(0, offset)];
    const trackedPaths = useBackslashes
      ? rotated.map((candidate) => candidate.replace(/\//g, "\\"))
      : rotated;
    return { trackedPaths, useBackslashes };
  });

// ---------------------------------------------------------------------------
// Property 1
// ---------------------------------------------------------------------------

describe("Property 1: Lockfile classification", () => {
  it("agrees with the requirement on the forbidden and required lockfile names", () => {
    expect(lockfileCheck.REQUIRED_LOCKFILE).toBe(REQUIRED_LOCKFILE);
    expect([...lockfileCheck.FORBIDDEN_LOCKFILE_NAMES].sort()).toEqual(
      [...FORBIDDEN_NAMES].sort(),
    );
  });

  it("exits 0 if and only if package-lock.json is tracked at the root and no forbidden name is tracked at any depth", () => {
    fc.assert(
      fc.property(trackedSetArb, ({ trackedPaths }) => {
        const outcome = classifyLockfiles({ trackedPaths: Object.freeze([...trackedPaths]) });
        const expectedPass = shouldPass(trackedPaths);

        // The biconditional, in both directions, on both halves of the result.
        expect(outcome.ok).toBe(expectedPass);
        expect(outcome.exitCode === 0).toBe(expectedPass);

        if (expectedPass) {
          // Requirement 2.1: the pass condition writes nothing to standard error.
          expect(outcome.stderr).toEqual([]);
        } else {
          expect(outcome.exitCode).toBeGreaterThan(0);
          expect(outcome.stderr.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("names every offending tracked path, or the missing required lockfile, in the failing case", () => {
    fc.assert(
      fc.property(trackedSetArb, ({ trackedPaths }) => {
        fc.pre(!shouldPass(trackedPaths));

        const outcome = classifyLockfiles({ trackedPaths: [...trackedPaths] });
        const diagnostic = outcome.stderr.join("\n");
        const offending = offendingPaths(trackedPaths);

        if (offending.length > 0) {
          // Requirement 2.2: every offending tracked path is named.
          for (const offender of offending) {
            expect(diagnostic).toContain(offender);
          }
        } else {
          // Requirement 2.3: the missing required lockfile is named.
          expect(diagnostic).toContain(REQUIRED_LOCKFILE);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("mutates neither the tracked-path set nor the on-disk-path set it is given", () => {
    fc.assert(
      fc.property(trackedSetArb, fc.uniqueArray(forbiddenPathArb, { maxLength: 3 }), (
        { trackedPaths },
        onDiskPaths,
      ) => {
        const trackedBefore = [...trackedPaths];
        const onDiskBefore = [...onDiskPaths];

        // Frozen inputs: an in-place write by the classifier would throw here.
        classifyLockfiles({
          trackedPaths: Object.freeze([...trackedPaths]),
          onDiskPaths: Object.freeze([...onDiskPaths]),
        });

        expect(trackedPaths).toEqual(trackedBefore);
        expect(onDiskPaths).toEqual(onDiskBefore);
      }),
      { numRuns: 300 },
    );
  });

  it("is deterministic: the same tracked-path set always classifies identically", () => {
    fc.assert(
      fc.property(trackedSetArb, ({ trackedPaths }) => {
        const first = classifyLockfiles({ trackedPaths: [...trackedPaths] });
        const second = classifyLockfiles({ trackedPaths: [...trackedPaths] });
        expect(second).toEqual(first);
      }),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// Filesystem-level confirmation: a small number of real git working trees.
// ---------------------------------------------------------------------------

function git(args: readonly string[], cwd: string): void {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr ?? ""}`);
  }
}

const gitAvailable = (() => {
  const probe = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
  return !probe.error && probe.status === 0;
})();

/**
 * Creates a temporary git working tree whose index tracks exactly `trackedPaths`.
 * Staging is enough: `git ls-files` reports the index, so no commit (and therefore
 * no `user.email` configuration) is needed.
 */
function createTempRepo(trackedPaths: readonly string[]): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "lockfile-check-"));
  git(["init", "--quiet"], root);
  for (const relativePath of trackedPaths) {
    const absolute = path.join(root, relativePath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, `// ${relativePath}\n`, "utf8");
    git(["add", "--", relativePath], root);
  }
  return root;
}

/** Content + size + mtime fingerprint of the working tree, excluding `.git`. */
function snapshotWorkingTree(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const pending: string[] = [""];

  while (pending.length > 0) {
    const relativeDir = pending.pop() as string;
    for (const entry of readdirSync(path.join(root, relativeDir), { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const relativePath = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        pending.push(relativePath);
        continue;
      }
      const absolute = path.join(root, relativePath);
      const stats = statSync(absolute);
      const digest = createHash("sha256").update(readFileSync(absolute)).digest("hex");
      snapshot[relativePath] = `${stats.size}:${stats.mtimeMs}:${digest}`;
    }
  }

  return snapshot;
}

interface RepoCase {
  name: string;
  trackedPaths: string[];
  expectedPass: boolean;
  /** Substrings the failing diagnostic must contain. */
  namedInDiagnostic: string[];
}

const repoCases: RepoCase[] = [
  {
    name: "package-lock.json tracked at the root and nothing forbidden",
    trackedPaths: ["package.json", REQUIRED_LOCKFILE, "src/main.tsx"],
    expectedPass: true,
    namedInDiagnostic: [],
  },
  {
    name: "a forbidden lockfile tracked below the root",
    trackedPaths: ["package.json", REQUIRED_LOCKFILE, "sub/pnpm-lock.yaml"],
    expectedPass: false,
    namedInDiagnostic: ["sub/pnpm-lock.yaml"],
  },
  {
    name: "package-lock.json tracked only below the root",
    trackedPaths: ["package.json", "packages/app/package-lock.json"],
    expectedPass: false,
    namedInDiagnostic: [REQUIRED_LOCKFILE],
  },
];

describe.skipIf(!gitAvailable)(
  "Property 1 over real git working trees (Requirements 2.1, 2.2, 2.3)",
  () => {
    for (const repoCase of repoCases) {
      it(`classifies ${repoCase.name} and modifies no file`, () => {
        const root = createTempRepo(repoCase.trackedPaths);
        try {
          const before = snapshotWorkingTree(root);
          const outcome = runLockfileCheck(root);
          const after = snapshotWorkingTree(root);

          expect(outcome.ok).toBe(repoCase.expectedPass);
          expect(outcome.exitCode === 0).toBe(repoCase.expectedPass);

          if (repoCase.expectedPass) {
            expect(outcome.stderr).toEqual([]);
          } else {
            expect(outcome.exitCode).toBeGreaterThan(0);
            const diagnostic = outcome.stderr.join("\n");
            for (const named of repoCase.namedInDiagnostic) {
              expect(diagnostic).toContain(named);
            }
          }

          // Requirement 2.2: the check modifies no file in the working tree.
          expect(after).toEqual(before);
        } finally {
          rmSync(root, { recursive: true, force: true, maxRetries: 3 });
        }
      });
    }
  },
);
