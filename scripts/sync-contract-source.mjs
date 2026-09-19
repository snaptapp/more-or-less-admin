#!/usr/bin/env node

/**
 * Sync_Contract_Source refreshes the vendored published copy of
 * Shared_Contract_Artifact at `contract/published/fact-lifecycle-contract.gen.ts`
 * from the live copy produced by Main_Repository's side-by-side checkout at
 * `../more-or-less/shared/fact-lifecycle-contract.gen.ts`.
 *
 * Exposed as `npm run sync:contract`. Run it after Main_Repository republishes
 * the contract: the byte difference it applies to the vendored copy is exactly
 * the drift that Contract_Drift_Check then requires to be adopted into
 * `shared/fact-lifecycle-contract.gen.ts` before Quality_Gate can pass again.
 *
 * Why a vendored copy exists: Quality_Gate must run inside CI and Workers
 * Builds, which clone only this repository, so the gate cannot read the
 * sibling checkout at deploy time. The vendored copy is the last published
 * state this repository has verified against, committed alongside the consumed
 * copy.
 *
 * Standalone: takes no arguments, uses only Node builtins. Fails closed with a
 * stderr diagnostic and a non-zero exit when the upstream checkout or artifact
 * is absent, or when the upstream file does not look like the contract
 * artifact (no `export const CONTRACT_VERSION`).
 */

import {
  copyFileSync as realCopyFileSync,
  existsSync as realExistsSync,
  readFileSync as realReadFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const UPSTREAM_ARTIFACT_RELATIVE_PATH =
  "../more-or-less/shared/fact-lifecycle-contract.gen.ts";

export const VENDORED_ARTIFACT_RELATIVE_PATH =
  "contract/published/fact-lifecycle-contract.gen.ts";

export const EXIT_SYNCED = 0;
export const EXIT_UPSTREAM_UNREACHABLE = 2;
export const EXIT_NOT_CONTRACT = 3;

/**
 * @param {{
 *   root?: string,
 *   existsSync?: typeof realExistsSync,
 *   readFileSync?: typeof realReadFileSync,
 *   copyFileSync?: typeof realCopyFileSync,
 * }} [options]
 * @returns {{ ok: boolean, exitCode: number, stdout: string[], stderr: string[] }}
 */
export function runContractSourceSync({
  root = process.cwd(),
  existsSync = realExistsSync,
  readFileSync = realReadFileSync,
  copyFileSync = realCopyFileSync,
} = {}) {
  const stdout = [];
  const stderr = [];

  const upstreamAbsPath = path.resolve(root, UPSTREAM_ARTIFACT_RELATIVE_PATH);
  const vendoredAbsPath = path.resolve(root, VENDORED_ARTIFACT_RELATIVE_PATH);

  if (!existsSync(upstreamAbsPath)) {
    stderr.push(
      `sync-contract-source: the upstream published copy is absent: ${UPSTREAM_ARTIFACT_RELATIVE_PATH} (resolved to ${upstreamAbsPath}).`,
    );
    stderr.push(
      "sync-contract-source: check out Main_Repository side by side and generate shared/fact-lifecycle-contract.gen.ts there, then retry.",
    );
    return {
      ok: false,
      exitCode: EXIT_UPSTREAM_UNREACHABLE,
      stdout,
      stderr,
    };
  }

  const upstream = readFileSync(upstreamAbsPath, "utf8");
  if (!upstream.includes("export const CONTRACT_VERSION")) {
    stderr.push(
      `sync-contract-source: ${UPSTREAM_ARTIFACT_RELATIVE_PATH} does not look like Shared_Contract_Artifact (missing "export const CONTRACT_VERSION"); refusing to vendor it.`,
    );
    return { ok: false, exitCode: EXIT_NOT_CONTRACT, stdout, stderr };
  }

  const vendored = existsSync(vendoredAbsPath)
    ? readFileSync(vendoredAbsPath, "utf8")
    : null;
  if (vendored === upstream) {
    stdout.push(
      "sync-contract-source: vendored published copy is already in sync.",
    );
    return { ok: true, exitCode: EXIT_SYNCED, stdout, stderr };
  }

  copyFileSync(upstreamAbsPath, vendoredAbsPath);
  stdout.push(
    `sync-contract-source: vendored published copy updated from ${UPSTREAM_ARTIFACT_RELATIVE_PATH}.`,
  );
  stdout.push(
    "sync-contract-source: adopt the new published state into shared/fact-lifecycle-contract.gen.ts so Contract_Drift_Check passes again.",
  );
  return { ok: true, exitCode: EXIT_SYNCED, stdout, stderr };
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
  const outcome = runContractSourceSync({ root: process.cwd() });
  for (const line of outcome.stdout) process.stdout.write(`${line}\n`);
  for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
  process.exit(outcome.exitCode);
}
