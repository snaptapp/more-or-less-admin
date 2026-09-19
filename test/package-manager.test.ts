/**
 * Example tests for the npm-only migration artifacts (task 1.3).
 *
 * Feature: admin-quality-gates-and-shared-contracts
 *
 * Covers Requirements 1.2, 1.3 and 1.4:
 *   1.2 `package.json` pins `packageManager` to npm at an exact three-part version
 *   1.3 the four competing package-manager files are ignored and untracked
 *   1.4 `.npmrc` records a native-build determination for each formerly
 *       `allowBuilds`-approved package
 *
 * These are file/tracking assertions, so they read the repository from disk and
 * query git rather than exercising application code. `git ls-files` is queried
 * once and cached to keep the suite fast, and no test writes to the tree.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

/** Repo-relative paths git tracks, queried once (POSIX separators, as git reports them). */
const trackedFiles: readonly string[] = execFileSync("git", ["ls-files"], {
  cwd: repoRoot,
  encoding: "utf8",
})
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

/** The paths `git check-ignore` confirms are covered by an ignore rule. */
function gitIgnoredPaths(candidates: readonly string[]): readonly string[] {
  // `check-ignore` exits 1 when nothing matches, so use spawnSync (no throw).
  const result = spawnSync("git", ["check-ignore", "--", ...candidates], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return (result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * The package-manager config files Requirement 1.3 removes from tracking. These
 * four are the concrete files that existed before the migration; `bun.lockb`
 * and `yarn.lock` never existed here but still need ignore rules.
 */
const REMOVED_CONFIG_FILES = [
  "bun.lock",
  "bunfig.toml",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
] as const;

/** Every ignore rule Requirement 1.3 mandates. */
const REQUIRED_IGNORE_RULES = [
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "bunfig.toml",
  "pnpm-workspace.yaml",
  "yarn.lock",
] as const;

/** Packages the removed `pnpm-workspace.yaml` `allowBuilds` list approved (Requirement 1.4). */
const ALLOW_BUILDS_PACKAGES = [
  "@firebase/util",
  "esbuild",
  "protobufjs",
  "workerd",
] as const;

describe("package.json packageManager (Requirement 1.2)", () => {
  const pkg = JSON.parse(readRepoFile("package.json")) as { packageManager?: unknown };

  it("is a string naming npm with exactly three dot-separated non-negative integers", () => {
    expect(typeof pkg.packageManager).toBe("string");

    const value = pkg.packageManager as string;
    const match = /^npm@(\d+)\.(\d+)\.(\d+)$/.exec(value);

    expect(match, `packageManager "${value}" must match npm@<x>.<y>.<z>`).not.toBeNull();

    const segments = (match as RegExpExecArray).slice(1, 4);
    expect(segments).toHaveLength(3);
    for (const segment of segments) {
      expect(Number.isInteger(Number(segment))).toBe(true);
      expect(Number(segment)).toBeGreaterThanOrEqual(0);
    }
  });

  it("carries no range operator, wildcard, or tag component", () => {
    const value = pkg.packageManager as string;

    // Range operators, wildcards, whitespace, and tag/pre-release separators are
    // all forbidden by Requirement 1.2 — the pin must be one exact version.
    for (const forbidden of ["^", "~", "*", ">", "<", "=", "|", " ", "-", "x", "X", "+"]) {
      expect(value.includes(forbidden), `packageManager must not contain "${forbidden}"`).toBe(
        false,
      );
    }
  });
});

describe("competing package-manager files (Requirement 1.3)", () => {
  const gitignore = readRepoFile(".gitignore");
  const ignoreLines = gitignore.split("\n").map((line) => line.trim());

  it.each(REQUIRED_IGNORE_RULES)("declares an ignore rule for %s", (rule) => {
    expect(ignoreLines).toContain(rule);
  });

  it.each(REMOVED_CONFIG_FILES)("does not track %s", (file) => {
    expect(trackedFiles).not.toContain(file);
  });

  it("tracks package-lock.json as the single lockfile", () => {
    expect(trackedFiles).toContain("package-lock.json");

    const trackedLockfiles = trackedFiles.filter((file) =>
      ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"].includes(
        path.posix.basename(file),
      ),
    );
    expect(trackedLockfiles).toEqual(["package-lock.json"]);
  });

  it("has effective ignore rules, so a later commit cannot reintroduce them as tracked files", () => {
    const ignored = gitIgnoredPaths(REQUIRED_IGNORE_RULES);
    for (const rule of REQUIRED_IGNORE_RULES) {
      expect(ignored, `${rule} must be ignored by git`).toContain(rule);
    }
  });
});

describe(".npmrc native-build determinations (Requirement 1.4)", () => {
  const npmrc = readRepoFile(".npmrc");
  const lines = npmrc.split("\n");

  /** Strip a leading `#` and surrounding whitespace so entry rows compare cleanly. */
  const stripComment = (line: string): string => line.replace(/^\s*#\s*/, "").trim();

  it("is git-tracked, so the approval is a reviewable artifact", () => {
    expect(trackedFiles).toContain(".npmrc");
  });

  it.each(ALLOW_BUILDS_PACKAGES)("records a lifecycle-build determination for %s", (pkgName) => {
    const entryIndex = lines.findIndex((line) => stripComment(line).startsWith(pkgName));
    expect(entryIndex, `.npmrc must carry an entry row for ${pkgName}`).toBeGreaterThanOrEqual(0);

    // The determination may wrap onto the following lines of the same entry.
    const entryBlock = lines.slice(entryIndex, entryIndex + 4).join(" ");
    expect(
      /->\s*lifecycle build\s+(required|not required|none|unnecessary)/i.test(entryBlock),
      `${pkgName} entry must state whether a lifecycle build is required`,
    ).toBe(true);
  });

  it("sets the npm configuration that enforces those determinations", () => {
    const settings = lines
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    expect(settings).toContain("ignore-scripts=false");
  });
});
