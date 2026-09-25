/**
 * Offline freshness tests. Upstream responses are supplied by deterministic
 * fetch doubles; the global network guard must observe zero attempts.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { blockedNetworkAttempts } from "./setup";

interface FreshnessOutcome {
  ok: boolean;
  exitCode: number;
  stdout: string[];
  stderr: string[];
}

interface FreshnessModule {
  runArtifactFreshnessCheck(options?: {
    root?: string;
    fetchImpl?: (input: string, init?: { method?: string }) => Promise<unknown>;
    upstreamMetadata?: unknown;
  }): Promise<FreshnessOutcome>;
}

const freshnessSpecifier = new URL("../scripts/check-artifact-freshness.mjs", import.meta.url).href;
const freshness = (await import(/* @vite-ignore */ freshnessSpecifier)) as FreshnessModule;

const createdRoots: string[] = [];
const SOURCE_COMMIT = "abcdef1234567890";
const NEWER_COMMIT = "fedcba9876543210";

interface FixtureManifest {
  sourceRepository: string;
  contractVersion: number;
  ddmVersion: string;
  coveredSourcePaths: string[];
  files: Record<string, string>;
}

function digest(source: string): string {
  return createHash("sha256").update(Buffer.from(source, "utf8")).digest("hex");
}

function makeManifest(): FixtureManifest {
  const sources: Record<string, string> = {
    "shared/fact-lifecycle-contract.gen.ts": "export const CONTRACT_VERSION = 2;\n",
    "src/derivation.ts": "export const DDMVersion = \"ddm-4\";\n",
    "tests/fixtures/derivation_parity.json": "{\"model_version\":\"ddm-4\"}\n",
  };
  return {
    sourceRepository: "snaptapp/more-or-less",
    contractVersion: 2,
    ddmVersion: "ddm-4",
    coveredSourcePaths: Object.keys(sources),
    files: Object.fromEntries(
      Object.entries(sources).map(([sourcePath, source]) => [sourcePath, digest(source)]),
    ),
  };
}

function makeLocalFixture(): { root: string; manifest: FixtureManifest } {
  const root = mkdtempSync(path.join(os.tmpdir(), "artifact-freshness-test-"));
  createdRoots.push(root);
  const manifest = makeManifest();
  const manifestPath = path.join(root, "contract", "published", "artifact-manifest.json");
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(
    path.join(root, "contract-adoption.json"),
    `${JSON.stringify({ adopted: true, contractVersion: 2, sourceCommit: SOURCE_COMMIT }, null, 2)}\n`,
    "utf8",
  );
  return { root, manifest };
}

function coveredCommits(
  manifest: FixtureManifest,
  commit: string,
  committedAt = "2026-09-24T00:00:00Z",
): Record<string, { sha: string; committedAt: string }> {
  return Object.fromEntries(
    [...manifest.coveredSourcePaths, "shared/artifact-manifest.gen.json"].map((sourcePath) => [
      sourcePath,
      { sha: commit, committedAt },
    ]),
  );
}

function response(body: unknown): { ok: true; json: () => Promise<unknown> } {
  return { ok: true, json: async () => body };
}

afterEach(() => {
  for (let index = createdRoots.length - 1; index >= 0; index -= 1) {
    rmSync(createdRoots[index], { recursive: true, force: true, maxRetries: 3 });
  }
  createdRoots.length = 0;
});

describe("read-only upstream freshness", () => {
  it("passes with a mocked current upstream response and issues no live request", async () => {
    const { root, manifest } = makeLocalFixture();
    const requests: Array<{ url: string; method: string | undefined }> = [];
    const encodedManifest = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8").toString(
      "base64",
    );
    const fetchImpl = async (url: string, init?: { method?: string }) => {
      requests.push({ url, method: init?.method });
      if (url.includes("/contents/")) {
        return response({ content: encodedManifest, encoding: "base64" });
      }
      return response([{ sha: SOURCE_COMMIT, commit: { committer: { date: "2026-09-24T00:00:00Z" } } }]);
    };

    const outcome = await freshness.runArtifactFreshnessCheck({ root, fetchImpl });

    expect(outcome.ok).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderr).toEqual([]);
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("fails when the upstream provider is unavailable", async () => {
    const { root } = makeLocalFixture();
    const fetchImpl = async () => {
      throw new Error("mock upstream outage");
    };

    const outcome = await freshness.runArtifactFreshnessCheck({ root, fetchImpl });

    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.stderr.join("\n")).toContain("upstream check unavailable");
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("fails closed when upstream metadata omits commit evidence", async () => {
    const { root, manifest } = makeLocalFixture();

    const outcome = await freshness.runArtifactFreshnessCheck({
      root,
      upstreamMetadata: { manifest },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.stderr.join("\n")).toContain("missing upstream metadata");
  });

  it("fails on a manifest digest mismatch", async () => {
    const { root, manifest } = makeLocalFixture();
    const drifted = {
      ...manifest,
      files: {
        ...manifest.files,
        "src/derivation.ts": digest("different bytes\n"),
      },
    };

    const outcome = await freshness.runArtifactFreshnessCheck({
      root,
      upstreamMetadata: {
        manifest: drifted,
        coveredCommits: coveredCommits(manifest, SOURCE_COMMIT),
      },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.stderr.join("\n")).toContain("digest mismatch");
  });

  it("fails when a newer commit touches a covered path", async () => {
    const { root, manifest } = makeLocalFixture();
    const commits = coveredCommits(manifest, SOURCE_COMMIT);
    commits["src/derivation.ts"] = {
      sha: NEWER_COMMIT,
      committedAt: "2026-09-25T00:00:00Z",
    };

    const outcome = await freshness.runArtifactFreshnessCheck({
      root,
      upstreamMetadata: { manifest, coveredCommits: commits },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.stderr.join("\n")).toContain("newer commit");
    expect(outcome.stderr.join("\n")).toContain("src/derivation.ts");
  });
});
