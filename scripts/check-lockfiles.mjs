#!/usr/bin/env node
/**
 * Lockfile_Check — enforces the single-package-manager decision (Requirement 2).
 *
 * Standalone: takes no arguments, needs no `node_modules`, uses only Node builtins.
 * Invoked as `npm run check:lockfiles`, and as the first member of Quality_Gate.
 *
 * Contract:
 *   - `git ls-files` supplies the set of tracked paths. If git tracking information
 *     cannot be obtained (not a git working tree, or the query exits non-zero), the
 *     check fails closed: diagnostic on stderr, non-zero exit, never a pass (2.5).
 *   - Any tracked file whose basename is in the forbidden set, at any depth, is
 *     reported to stderr in lexicographic order with a non-zero exit; nothing in the
 *     working tree is modified (2.2).
 *   - `package-lock.json` must be tracked at the repository root (2.3).
 *   - A forbidden name present on disk but untracked is a contributor's local install
 *     artifact: advisory on stdout, exit 0 (2.4).
 *   - On the pass condition nothing is written to stderr and the exit code is 0 (2.1).
 *
 * The module exports a pure classifier (`classifyLockfiles`) plus a working-directory
 * scoped runner (`runLockfileCheck`) so tests can drive it against temporary git repos.
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The one lockfile this repository is permitted to track, at the repository root. */
export const REQUIRED_LOCKFILE = "package-lock.json";

/** Lockfile basenames that must never be tracked, at any path depth. */
export const FORBIDDEN_LOCKFILE_NAMES = Object.freeze([
  "bun.lock",
  "bun.lockb",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

/** Directories never descended into when looking for untracked on-disk artifacts. */
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

const FORBIDDEN_SET = new Set(FORBIDDEN_LOCKFILE_NAMES);

/** Exit code for a classification failure (forbidden tracked file / missing lockfile). */
export const EXIT_CLASSIFICATION_FAILURE = 1;

/** Exit code for the fail-closed path where git tracking information is unavailable. */
export const EXIT_GIT_UNAVAILABLE = 2;

/** Raised when git tracking information cannot be obtained. */
export class GitTrackingUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "GitTrackingUnavailableError";
  }
}

/** Byte-wise lexicographic comparison (deliberately not locale-aware). */
function compareLexicographically(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Normalizes a repo-relative path to forward slashes with no `./` prefix. */
function normalizePath(candidate) {
  return String(candidate).replace(/\\/g, "/").replace(/^\.\//, "");
}

function basenameOf(normalizedPath) {
  const index = normalizedPath.lastIndexOf("/");
  return index === -1 ? normalizedPath : normalizedPath.slice(index + 1);
}

/**
 * Pure classifier. Given the tracked path set and the on-disk path set (both
 * repo-relative), decides the outcome without touching the filesystem.
 *
 * @param {{ trackedPaths: Iterable<string>, onDiskPaths?: Iterable<string> }} input
 * @returns {{ ok: boolean, exitCode: number, stdout: string[], stderr: string[] }}
 */
export function classifyLockfiles({ trackedPaths, onDiskPaths = [] }) {
  const tracked = [...trackedPaths].map(normalizePath);
  const trackedSet = new Set(tracked);

  const offending = tracked
    .filter((trackedPath) => FORBIDDEN_SET.has(basenameOf(trackedPath)))
    .sort(compareLexicographically);

  if (offending.length > 0) {
    const stderr = [
      `check-lockfiles: ${offending.length} forbidden lockfile${
        offending.length === 1 ? "" : "s"
      } tracked by git; ${REQUIRED_LOCKFILE} is the only permitted lockfile:`,
      ...offending.map((offendingPath) => `  ${offendingPath}`),
      `check-lockfiles: remove ${
        offending.length === 1 ? "it" : "them"
      } from git tracking (git rm --cached <path>) and from the working tree.`,
    ];
    return { ok: false, exitCode: EXIT_CLASSIFICATION_FAILURE, stdout: [], stderr };
  }

  if (!trackedSet.has(REQUIRED_LOCKFILE)) {
    return {
      ok: false,
      exitCode: EXIT_CLASSIFICATION_FAILURE,
      stdout: [],
      stderr: [
        `check-lockfiles: required lockfile ${REQUIRED_LOCKFILE} is not tracked by git at the repository root.`,
        `check-lockfiles: npm is the sole supported package manager; commit ${REQUIRED_LOCKFILE}.`,
      ],
    };
  }

  const untrackedArtifacts = [...onDiskPaths]
    .map(normalizePath)
    .filter(
      (diskPath) => FORBIDDEN_SET.has(basenameOf(diskPath)) && !trackedSet.has(diskPath),
    )
    .sort(compareLexicographically);

  const stdout = untrackedArtifacts.map(
    (diskPath) =>
      `check-lockfiles: advisory: ${diskPath} is present on disk but untracked; it will not fail this check, but it is not the lockfile this repository uses.`,
  );

  return { ok: true, exitCode: 0, stdout, stderr: [] };
}

/**
 * Resolves the git working-tree root containing `cwd`.
 * @throws {GitTrackingUnavailableError}
 */
export function resolveRepositoryRoot(cwd) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.error) {
    throw new GitTrackingUnavailableError(
      `could not run 'git' in ${cwd}: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const detail = (result.stderr || "").trim() || `git exited with status ${result.status}`;
    throw new GitTrackingUnavailableError(`${cwd} is not a git working tree: ${detail}`);
  }

  const root = (result.stdout || "").trim();
  if (root === "") {
    throw new GitTrackingUnavailableError(
      `git reported no working-tree root for ${cwd}`,
    );
  }
  return root;
}

/**
 * Lists every path git tracks in `root`, relative to `root`.
 * @throws {GitTrackingUnavailableError}
 */
export function listTrackedPaths(root) {
  const result = spawnSync("git", ["ls-files", "-z", "--full-name"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.error) {
    throw new GitTrackingUnavailableError(
      `could not run 'git ls-files' in ${root}: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const detail = (result.stderr || "").trim() || `git exited with status ${result.status}`;
    throw new GitTrackingUnavailableError(`'git ls-files' failed in ${root}: ${detail}`);
  }

  return (result.stdout || "")
    .split("\0")
    .filter((entry) => entry !== "")
    .map(normalizePath);
}

/**
 * Finds forbidden lockfile names present on disk under `root`, skipping `.git` and
 * `node_modules`. Read-only; unreadable directories are skipped rather than fatal.
 */
export function findOnDiskLockfiles(root) {
  const found = [];
  const pending = [""];

  while (pending.length > 0) {
    const relativeDir = pending.pop();
    let entries;
    try {
      entries = readdirSync(path.join(root, relativeDir), { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const relativePath = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(relativePath);
      } else if (FORBIDDEN_SET.has(entry.name)) {
        found.push(relativePath);
      }
    }
  }

  return found.sort(compareLexicographically);
}

/**
 * Runs Lockfile_Check against the git working tree containing `cwd`.
 * Returns the outcome instead of writing or exiting, so tests can assert on it.
 *
 * @param {string} [cwd]
 * @returns {{ ok: boolean, exitCode: number, stdout: string[], stderr: string[] }}
 */
export function runLockfileCheck(cwd = process.cwd()) {
  let root;
  let trackedPaths;
  try {
    root = resolveRepositoryRoot(cwd);
    trackedPaths = listTrackedPaths(root);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      exitCode: EXIT_GIT_UNAVAILABLE,
      stdout: [],
      stderr: [
        `check-lockfiles: cannot obtain git tracking information: ${detail}`,
        "check-lockfiles: refusing to report a pass without git tracking information.",
      ],
    };
  }

  return classifyLockfiles({ trackedPaths, onDiskPaths: findOnDiskLockfiles(root) });
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
  const outcome = runLockfileCheck(process.cwd());
  for (const line of outcome.stdout) process.stdout.write(`${line}\n`);
  for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
  process.exit(outcome.exitCode);
}
