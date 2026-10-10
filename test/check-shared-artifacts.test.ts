/**
 * Offline tests for the manifest-driven Admin handoff and local integrity
 * gate. Every filesystem path is an isolated temporary fixture; the test
 * never calls fetch, Firestore, or any deployment/tooling command.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

interface CheckOutcome {
  ok: boolean;
  exitCode: number;
  stdout: string[];
  stderr: string[];
}

interface SyncOutcome {
  ok: boolean;
  exitCode: number;
  stdout: string[];
  stderr: string[];
  written: string[];
  unchanged: string[];
  planned: unknown[];
}

interface SharedArtifactModule {
  CONSUMED_CONTRACT_RELATIVE_PATH: string;
  SHARED_ARTIFACT_MANIFEST_RELATIVE_PATH: string;
  runSharedArtifactCheck(options?: {
    root?: string;
    upstreamRoot?: string | null;
  }): CheckOutcome;
}

interface SyncModule {
  runSharedArtifactSync(options?: {
    root?: string;
    upstreamRoot?: string;
    now?: () => number;
    sourceCommit?: string;
    stampAdoptedAt?: boolean;
    dryRun?: boolean;
  }): SyncOutcome;
}

const sharedSpecifier = new URL("../scripts/check-shared-artifacts.mjs", import.meta.url).href;
const syncSpecifier = new URL("../scripts/sync-shared-artifacts.mjs", import.meta.url).href;
const shared = (await import(/* @vite-ignore */ sharedSpecifier)) as SharedArtifactModule;
const sync = (await import(/* @vite-ignore */ syncSpecifier)) as SyncModule;

const createdRoots: string[] = [];

const CONTRACT_SOURCE = "// generated fixture\nexport const CONTRACT_VERSION = 2;\n";
const DDM_SOURCE = "export const DDMVersion = \"ddm-4\";\n";
const FIXTURE_SOURCE = "{\"model_version\":\"ddm-4\"}\n";
const SOURCE_COMMIT = "abcdef1234567890";

/**
 * Coverage-only producers the checker requires in every manifest. Mirrors
 * REQUIRED_COVERED_SOURCE_FILES in scripts/check-shared-artifacts.mjs; kept
 * inline so fixture drift fails loudly if the contract grows.
 */
const REQUIRED_COVERAGE = [
  ".github/scripts/open-hydration-pr.sh",
  ".github/scripts/verify-fact-bank-publication.mjs",
  ".github/workflows/fact-foundry.yml",
  "agent-go/factlint.go",
  "agent-go/factlint_rules.go",
  "agent-go/factquality_review.go",
  "scripts/export_eligible_coverage.mjs",
  "scripts/export_fact_bank.mjs",
  "scripts/frozen_bank_export.mjs",
  "scripts/gen_derivation_tables.mjs",
  "scripts/gen_fact_lint_catalog.mjs",
  "scripts/gen_fact_quality_units.mjs",
  "scripts/gen_shared_contract.mjs",
  "scripts/write_bank_pair.mjs",
];

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

function fixtureSources(): Record<string, string> {
  return {
    "shared/fact-lifecycle-contract.gen.ts": CONTRACT_SOURCE,
    "src/derivation.ts": DDM_SOURCE,
    "tests/fixtures/derivation_parity.json": FIXTURE_SOURCE,
    "agent-go/derivation.go": "package main\n",
    ...Object.fromEntries(REQUIRED_COVERAGE.map((p) => [p, `// ${p}\n`])),
  };
}

function makeManifest(): FixtureManifest {
  const sources = fixtureSources();
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

function makeFixture(): { adminRoot: string; upstreamRoot: string; manifest: FixtureManifest } {
  const parent = mkdtempSync(path.join(os.tmpdir(), "shared-artifacts-test-"));
  createdRoots.push(parent);
  const adminRoot = path.join(parent, "admin");
  const upstreamRoot = path.join(parent, "upstream");
  mkdirSync(adminRoot, { recursive: true });
  mkdirSync(upstreamRoot, { recursive: true });

  const manifest = makeManifest();
  const sources = fixtureSources();
  for (const [sourcePath, source] of Object.entries(sources)) {
    const absolute = path.join(upstreamRoot, ...sourcePath.split("/"));
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, source, "utf8");
  }
  writeFileSync(
    path.join(upstreamRoot, "shared", "artifact-manifest.gen.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return { adminRoot, upstreamRoot, manifest };
}

function installSyncedFixture(manifest: FixtureManifest, adminRoot: string, upstreamRoot: string): void {
  const destinations: Record<string, string> = {
    "contract/published/fact-lifecycle-contract.gen.ts": CONTRACT_SOURCE,
    "shared/fact-lifecycle-contract.gen.ts": CONTRACT_SOURCE,
    "shared/ddm/derivation.ts": DDM_SOURCE,
    "shared/ddm/fixtures/derivation_parity.json": FIXTURE_SOURCE,
  };
  for (const [destination, source] of Object.entries(destinations)) {
    const absolute = path.join(adminRoot, ...destination.split("/"));
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, source, "utf8");
  }
  writeFileSync(
    path.join(adminRoot, "contract", "published", "artifact-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(adminRoot, "contract-adoption.json"),
    `${JSON.stringify({ adopted: true, contractVersion: 2, sourceCommit: SOURCE_COMMIT }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(upstreamRoot, "shared", "artifact-manifest.gen.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

afterEach(() => {
  for (let index = createdRoots.length - 1; index >= 0; index -= 1) {
    rmSync(createdRoots[index], { recursive: true, force: true, maxRetries: 3 });
  }
  createdRoots.length = 0;
});

describe("local shared artifact integrity", () => {
  it("passes only when every declared consumed/published destination matches its digest", () => {
    const { adminRoot, upstreamRoot, manifest } = makeFixture();
    installSyncedFixture(manifest, adminRoot, upstreamRoot);

    const outcome = shared.runSharedArtifactCheck({ root: adminRoot, upstreamRoot });

    expect(outcome.ok).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderr).toEqual([]);
  });

  it("fails closed on a local vendored-byte digest mismatch", () => {
    const { adminRoot, upstreamRoot, manifest } = makeFixture();
    installSyncedFixture(manifest, adminRoot, upstreamRoot);
    writeFileSync(path.join(adminRoot, "shared", "ddm", "derivation.ts"), "tampered\n", "utf8");

    const outcome = shared.runSharedArtifactCheck({ root: adminRoot });

    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.stderr.join("\n")).toContain("digest mismatch");
  });

  it("rejects a manifest that omits a required coverage producer", () => {
    const { adminRoot, upstreamRoot, manifest } = makeFixture();
    installSyncedFixture(manifest, adminRoot, upstreamRoot);
    const dropped = manifest.coveredSourcePaths.filter(
      (sourcePath) => sourcePath !== "agent-go/factquality_review.go",
    );
    const files = { ...manifest.files };
    delete files["agent-go/factquality_review.go"];
    const underCovered = { ...manifest, coveredSourcePaths: dropped, files };
    writeFileSync(
      path.join(adminRoot, "contract", "published", "artifact-manifest.json"),
      `${JSON.stringify(underCovered, null, 2)}\n`,
      "utf8",
    );

    const outcome = shared.runSharedArtifactCheck({ root: adminRoot });

    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.stderr.join("\n")).toContain(
      "Manifest does not cover required producer agent-go/factquality_review.go",
    );
  });

  it("rejects an adoption version that does not match the manifest", () => {
    const { adminRoot, upstreamRoot, manifest } = makeFixture();
    installSyncedFixture(manifest, adminRoot, upstreamRoot);
    writeFileSync(
      path.join(adminRoot, "contract-adoption.json"),
      JSON.stringify({ adopted: true, contractVersion: 1, sourceCommit: SOURCE_COMMIT }),
      "utf8",
    );

    const outcome = shared.runSharedArtifactCheck({ root: adminRoot });

    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.stderr.join("\n")).toContain("adoption Contract_Version");
  });
});

describe("manifest-driven local sync", () => {
  it("writes only declared handoff destinations and leaves coverage-only sources alone", () => {
    const { adminRoot, upstreamRoot } = makeFixture();

    const outcome = sync.runSharedArtifactSync({
      root: adminRoot,
      upstreamRoot,
      sourceCommit: SOURCE_COMMIT,
      stampAdoptedAt: false,
      now: () => 1_700_000_000_000,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.written).toEqual(
      expect.arrayContaining([
        "contract/published/fact-lifecycle-contract.gen.ts",
        "shared/fact-lifecycle-contract.gen.ts",
        "shared/ddm/derivation.ts",
        "shared/ddm/fixtures/derivation_parity.json",
        "contract/published/artifact-manifest.json",
        "contract-adoption.json",
      ]),
    );
    expect(outcome.written).not.toContain("src/derivation.ts");
    expect(outcome.written).not.toContain("agent-go/derivation.go");
    expect(existsSync(path.join(adminRoot, "agent-go", "derivation.go"))).toBe(false);
    expect(readFileSync(path.join(adminRoot, "shared", "ddm", "derivation.ts"), "utf8")).toBe(
      DDM_SOURCE,
    );

    const checked = shared.runSharedArtifactCheck({ root: adminRoot });
    expect(checked.ok).toBe(true);
  });

  it("does not write any destination when upstream preflight fails", () => {
    const { adminRoot, upstreamRoot } = makeFixture();
    writeFileSync(path.join(upstreamRoot, "src", "derivation.ts"), "corrupt\n", "utf8");

    const outcome = sync.runSharedArtifactSync({
      root: adminRoot,
      upstreamRoot,
      sourceCommit: SOURCE_COMMIT,
      stampAdoptedAt: false,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.written).toEqual([]);
    expect(existsSync(path.join(adminRoot, "contract", "published", "artifact-manifest.json"))).toBe(
      false,
    );
    expect(existsSync(path.join(adminRoot, "shared", "fact-lifecycle-contract.gen.ts"))).toBe(false);
  });

  it("supports a dry run without modifying the worktree", () => {
    const { adminRoot, upstreamRoot } = makeFixture();

    const outcome = sync.runSharedArtifactSync({
      root: adminRoot,
      upstreamRoot,
      dryRun: true,
      sourceCommit: SOURCE_COMMIT,
      stampAdoptedAt: false,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.written).toEqual([]);
    expect(outcome.planned).toEqual(expect.any(Array));
    expect(existsSync(path.join(adminRoot, "contract-adoption.json"))).toBe(false);
  });
});
