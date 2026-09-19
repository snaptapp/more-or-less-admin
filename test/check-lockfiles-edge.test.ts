/**
 * Edge-case and timing coverage for Lockfile_Check (task 2.4).
 *
 * Feature: admin-quality-gates-and-shared-contracts
 *
 * Two properties of `scripts/check-lockfiles.mjs` are asserted here as examples
 * rather than as generated properties, because each pins a single concrete
 * behaviour:
 *
 *   - Requirement 2.5 — when git tracking information cannot be obtained (the
 *     directory is not a git working tree, or the tracking query itself exits
 *     non-zero), the check fails closed: a diagnostic identifying the cause on
 *     standard error, a non-zero exit code, and never a passing result.
 *   - Requirement 2.8 — the check completes within 5 seconds of wall-clock time
 *     on a checkout with no installed `node_modules`. The script depends only on
 *     Node builtins, so the run below is a genuine cold start of a fresh `node`
 *     process against a repository that has no `node_modules` at all.
 *
 * Every temporary directory this file creates is removed after the test that
 * created it.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..");
const scriptPath = path.join(repoRoot, "scripts", "check-lockfiles.mjs");

/** Wall-clock budget for one Lockfile_Check run (Requirement 2.8). */
const TIMING_BUDGET_MS = 5_000;

interface LockfileCheckOutcome {
  ok: boolean;
  exitCode: number;
  stdout: string[];
  stderr: string[];
}

interface LockfileCheckModule {
  runLockfileCheck(cwd: string): LockfileCheckOutcome;
  resolveRepositoryRoot(cwd: string): string;
  listTrackedPaths(root: string): string[];
  GitTrackingUnavailableError: new (message: string) => Error;
  EXIT_GIT_UNAVAILABLE: number;
  EXIT_CLASSIFICATION_FAILURE: number;
}

// The check is a plain `.mjs` script with no type declarations, so it is loaded
// through a computed specifier: a static import of a declaration-less `.mjs`
// module would not typecheck under `strict`.
const moduleSpecifier = new URL("../scripts/check-lockfiles.mjs", import.meta.url).href;
const lockfileCheck = (await import(moduleSpecifier)) as LockfileCheckModule;

// ---------------------------------------------------------------------------
// Temporary-directory plumbing
// ---------------------------------------------------------------------------

const createdTempDirs: string[] = [];
const cleanupFailures: string[] = [];

/** Real path of the OS temp root, so `GIT_CEILING_DIRECTORIES` matches exactly. */
const tempRoot = fs.realpathSync(os.tmpdir());

function makeTempDir(prefix: string): string {
  const created = fs.mkdtempSync(path.join(tempRoot, prefix));
  createdTempDirs.push(created);
  return fs.realpathSync(created);
}

afterEach(() => {
  for (;;) {
    const dir = createdTempDirs.pop();
    if (dir === undefined) break;
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A retained handle on a freshly written git object is not a test
      // failure; record the leak instead of masking the assertion result.
      cleanupFailures.push(dir);
    }
  }
});

/**
 * Environment for a git invocation under a temp directory. The ceiling stops
 * git from walking above the OS temp root, so a git repository anywhere further
 * up the tree (a developer's home directory, for instance) cannot make a
 * supposedly non-git temp directory look tracked.
 */
function gitScopedEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_CEILING_DIRECTORIES: tempRoot };
}

/** Runs `fn` with the same git ceiling applied to this process's environment. */
function withGitCeiling<T>(fn: () => T): T {
  const previous = process.env["GIT_CEILING_DIRECTORIES"];
  process.env["GIT_CEILING_DIRECTORIES"] = tempRoot;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env["GIT_CEILING_DIRECTORIES"];
    else process.env["GIT_CEILING_DIRECTORIES"] = previous;
  }
}

function runGit(args: string[], cwd: string): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitScopedEnv(),
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr ?? ""}`);
  }
}

/**
 * A minimal passing checkout: a git working tree whose index tracks
 * `package-lock.json` and which has no `node_modules` directory. Staging the
 * lockfile is enough — `git ls-files` reads the index, so no commit (and no git
 * identity configuration) is required.
 */
function makeGitRepoWithLockfile(prefix: string): string {
  const dir = makeTempDir(prefix);
  runGit(["init", "-q"], dir);
  fs.writeFileSync(
    path.join(dir, "package-lock.json"),
    '{\n  "name": "temp-fixture",\n  "lockfileVersion": 3,\n  "packages": {}\n}\n',
    "utf8",
  );
  runGit(["add", "package-lock.json"], dir);
  return dir;
}

/** Runs the check as a child process, returning the outcome and wall-clock cost. */
function runCheckAsChildProcess(cwd: string): {
  status: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
} {
  const startedAt = performance.now();
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd,
    encoding: "utf8",
    env: gitScopedEnv(),
    windowsHide: true,
  });
  const elapsedMs = performance.now() - startedAt;
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    elapsedMs,
  };
}

// ---------------------------------------------------------------------------
// Requirement 2.5 — fail closed when git tracking information is unavailable
// ---------------------------------------------------------------------------

describe("Lockfile_Check fails closed when git tracking information is unavailable", () => {
  it("reports the cause and exits non-zero for a directory that is not a git working tree", () => {
    const dir = makeTempDir("lockfile-check-not-a-repo-");

    const outcome = withGitCeiling(() => lockfileCheck.runLockfileCheck(dir));

    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.exitCode).toBe(lockfileCheck.EXIT_GIT_UNAVAILABLE);

    const stderr = outcome.stderr.join("\n");
    expect(stderr).toMatch(/cannot obtain git tracking information/);
    expect(stderr).toMatch(/not a git working tree/);
    expect(stderr).toMatch(/refusing to report a pass/);

    // No pass is reported on any channel: nothing on stdout, and in particular
    // no advisory that would read as a successful run.
    expect(outcome.stdout).toEqual([]);
  });

  it("throws GitTrackingUnavailableError from resolveRepositoryRoot outside a working tree", () => {
    const dir = makeTempDir("lockfile-check-no-root-");

    withGitCeiling(() => {
      expect(() => lockfileCheck.resolveRepositoryRoot(dir)).toThrow(
        lockfileCheck.GitTrackingUnavailableError,
      );
      expect(() => lockfileCheck.resolveRepositoryRoot(dir)).toThrow(
        /not a git working tree/,
      );
    });
  });

  it("reports the cause and exits non-zero when the tracking query exits non-zero", () => {
    const dir = makeGitRepoWithLockfile("lockfile-check-corrupt-index-");
    // A corrupt index leaves the working tree resolvable but makes the tracking
    // query itself exit non-zero — the second cause named by Requirement 2.5.
    fs.writeFileSync(path.join(dir, ".git", "index"), "not a git index\n", "utf8");

    withGitCeiling(() => {
      expect(() => lockfileCheck.listTrackedPaths(dir)).toThrow(
        lockfileCheck.GitTrackingUnavailableError,
      );

      const outcome = lockfileCheck.runLockfileCheck(dir);

      expect(outcome.ok).toBe(false);
      expect(outcome.exitCode).not.toBe(0);
      expect(outcome.exitCode).toBe(lockfileCheck.EXIT_GIT_UNAVAILABLE);

      const stderr = outcome.stderr.join("\n");
      expect(stderr).toMatch(/cannot obtain git tracking information/);
      expect(stderr).toMatch(/ls-files/);
      expect(stderr).toMatch(/refusing to report a pass/);
      expect(outcome.stdout).toEqual([]);
    });
  });

  it("exits non-zero with a stderr diagnostic and an empty stdout when invoked as a script outside a working tree", () => {
    const dir = makeTempDir("lockfile-check-cli-not-a-repo-");

    const result = runCheckAsChildProcess(dir);

    expect(result.status).not.toBe(0);
    expect(result.status).toBe(lockfileCheck.EXIT_GIT_UNAVAILABLE);
    expect(result.stderr).toMatch(/cannot obtain git tracking information/);
    expect(result.stderr).toMatch(/refusing to report a pass/);
    expect(result.stdout).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Requirement 2.8 — 5 second wall-clock budget with no installed node_modules
// ---------------------------------------------------------------------------

describe("Lockfile_Check timing", () => {
  it("completes within 5 seconds on a checkout with no installed node_modules", () => {
    const dir = makeGitRepoWithLockfile("lockfile-check-timing-");

    // The precondition the requirement names: nothing is installed.
    expect(fs.existsSync(path.join(dir, "node_modules"))).toBe(false);

    const result = runCheckAsChildProcess(dir);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.elapsedMs).toBeLessThan(TIMING_BUDGET_MS);
  });

  it("completes within 5 seconds on the fail-closed path as well", () => {
    const dir = makeTempDir("lockfile-check-timing-fail-closed-");

    const result = runCheckAsChildProcess(dir);

    expect(result.status).toBe(lockfileCheck.EXIT_GIT_UNAVAILABLE);
    expect(result.elapsedMs).toBeLessThan(TIMING_BUDGET_MS);
  });
});
