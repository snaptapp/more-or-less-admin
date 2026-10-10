/**
 * Proves that Admin's DDM kernel/table bundle is a byte-for-byte vendor of the
 * Main handoff named by the tracked artifact manifest.
 *
 * The test is intentionally read-only. The separate artifact-gate validation
 * with `--upstream-root ../more-or-less` verifies the manifest against the live
 * side-by-side Main checkout; this test keeps the same evidence deterministic
 * in isolated and CI checkouts by comparing every vendored byte to the digest
 * carried by that manifest.
 */
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { DDMVersion, KindPercentChange } from "../shared/ddm/derivation";
import { DERIVATION_TABLES } from "../shared/ddm/derivation_tables_gen";

interface ArtifactManifest {
  readonly sourceRepository: string;
  readonly contractVersion: number | string;
  readonly ddmVersion: string;
  readonly coveredSourcePaths: readonly string[];
  readonly files: Readonly<Record<string, string>>;
}

interface HandoffEntry {
  readonly sourcePath: string;
  readonly destination: string;
  readonly digest: string;
}

interface ArtifactCheckOutcome {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

interface SharedArtifactModule {
  getHandoffEntries(manifest: ArtifactManifest): HandoffEntry[];
  runSharedArtifactCheck(options?: {
    root?: string;
    upstreamRoot?: string | null;
  }): ArtifactCheckOutcome;
}

const artifactsSpecifier = new URL("../scripts/check-shared-artifacts.mjs", import.meta.url).href;
const artifacts = (await import(/* @vite-ignore */ artifactsSpecifier)) as SharedArtifactModule;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localManifest = JSON.parse(
  readFileSync(path.join(repoRoot, "contract/published/artifact-manifest.json"), "utf8"),
) as ArtifactManifest;

const REQUIRED_DDM_VENDORING = [
  {
    source: "src/ddm_implementation_gen.ts",
    destination: "shared/ddm/ddm_implementation_gen.ts",
  },
  { source: "src/derivation.ts", destination: "shared/ddm/derivation.ts" },
  { source: "src/derivation_adapter.ts", destination: "shared/ddm/derivation_adapter.ts" },
  { source: "src/factbank_precompute.ts", destination: "shared/ddm/factbank_precompute.ts" },
  { source: "src/factquality_round.ts", destination: "shared/ddm/factquality_round.ts" },
  { source: "src/derivation_resolve.ts", destination: "shared/ddm/derivation_resolve.ts" },
  { source: "src/derivation_statement.ts", destination: "shared/ddm/derivation_statement.ts" },
  {
    source: "src/derivation_tables_gen.ts",
    destination: "shared/ddm/derivation_tables_gen.ts",
  },
  { source: "src/unit_tables_gen.ts", destination: "shared/ddm/unit_tables_gen.ts" },
] as const;

const createdRoots: string[] = [];
const tempParent = path.join(os.tmpdir(), "opencode");
mkdirSync(tempParent, { recursive: true });

const FIXTURE_CONTRACT = "// generated fixture\nexport const CONTRACT_VERSION = 2;\n";
const FIXTURE_DDM =
  'export const DDMVersion = "ddm-4";\nexport const KindPercentChange: "percent_change" = "percent_change";\n';

function sha256(bytes: string | Buffer): string {
  return createHash("sha256")
    .update(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes)
    .digest("hex");
}

function writeAt(root: string, relativePath: string, bytes: string | Buffer): void {
  const absolutePath = path.join(root, ...relativePath.split("/"));
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, bytes);
}

function makeDriftFixture(): { adminRoot: string; upstreamRoot: string } {
  const parent = mkdtempSync(path.join(tempParent, "ddm-vendoring-"));
  createdRoots.push(parent);
  const adminRoot = path.join(parent, "admin");
  const upstreamRoot = path.join(parent, "main");

  // The checker requires these coverage-only producers to be covered by every
  // manifest; fixtures must satisfy the same contract as the real handoff.
  const requiredCoverage = [
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
  const manifest: ArtifactManifest = {
    sourceRepository: "snaptapp/more-or-less",
    contractVersion: 2,
    ddmVersion: "ddm-4",
    coveredSourcePaths: [
      "shared/fact-lifecycle-contract.gen.ts",
      "src/derivation.ts",
      ...requiredCoverage,
    ],
    files: {
      "shared/fact-lifecycle-contract.gen.ts": sha256(FIXTURE_CONTRACT),
      "src/derivation.ts": sha256(FIXTURE_DDM),
      ...Object.fromEntries(
        requiredCoverage.map((p) => [p, sha256(`// ${p}\n`)]),
      ),
    },
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;

  writeAt(upstreamRoot, "shared/fact-lifecycle-contract.gen.ts", FIXTURE_CONTRACT);
  writeAt(upstreamRoot, "src/derivation.ts", FIXTURE_DDM);
  for (const covered of requiredCoverage) {
    writeAt(upstreamRoot, covered, `// ${covered}\n`);
  }
  writeAt(upstreamRoot, "shared/artifact-manifest.gen.json", manifestBytes);

  writeAt(adminRoot, "contract/published/fact-lifecycle-contract.gen.ts", FIXTURE_CONTRACT);
  writeAt(adminRoot, "shared/fact-lifecycle-contract.gen.ts", FIXTURE_CONTRACT);
  writeAt(adminRoot, "shared/ddm/derivation.ts", FIXTURE_DDM);
  writeAt(adminRoot, "contract/published/artifact-manifest.json", manifestBytes);
  writeAt(
    adminRoot,
    "contract-adoption.json",
    `${JSON.stringify({ adopted: true, contractVersion: 2 }, null, 2)}\n`,
  );

  return { adminRoot, upstreamRoot };
}

afterEach(() => {
  for (let index = createdRoots.length - 1; index >= 0; index -= 1) {
    rmSync(createdRoots[index], { recursive: true, force: true, maxRetries: 3 });
  }
  createdRoots.length = 0;
});

describe("DDM production-port vendoring", () => {
  it("proves every manifest-named DDM kernel/table file is byte-identical to its Main digest", () => {
    // Arrange
    const handoffEntries = artifacts.getHandoffEntries(localManifest);
    const ddmDestinations = handoffEntries
      .filter(
        ({ destination }) =>
          destination.startsWith("shared/ddm/") && !destination.startsWith("shared/ddm/fixtures/"),
      )
      .map(({ destination }) => destination);

    // Act
    const vendoredProofs = REQUIRED_DDM_VENDORING.map(({ source, destination }) => {
      const entry = handoffEntries.find(
        (candidate) =>
          candidate.sourcePath === source && candidate.destination === destination,
      );
      const bytes = readFileSync(path.join(repoRoot, ...destination.split("/")));
      return { source, destination, entry, digest: sha256(bytes) };
    });
    const artifactCheck = artifacts.runSharedArtifactCheck({ root: repoRoot });

    // Assert
    expect(ddmDestinations.slice().sort()).toEqual(
      REQUIRED_DDM_VENDORING.map(({ destination }) => destination).slice().sort(),
    );
    for (const proof of vendoredProofs) {
      expect(proof.entry, `${proof.source} must have a manifest handoff entry`).toBeDefined();
      expect(
        proof.digest,
        `${proof.destination} must match the digest recorded for ${proof.source}`,
      ).toBe(proof.entry?.digest);
    }
    expect(artifactCheck).toMatchObject({ ok: true, exitCode: 0, stderr: [] });
  });

  it("pins the vendored kernel and generated tables to ddm-4 with percent_change", () => {
    // Arrange
    const manifestVersion = localManifest.ddmVersion;
    const quantityKinds = DERIVATION_TABLES.closed_sets.quantity_kind;

    // Act
    const kernelVersion = DDMVersion;
    const kernelPercentChange = KindPercentChange;

    // Assert
    expect(manifestVersion).toBe("ddm-4");
    expect(kernelVersion).toBe(manifestVersion);
    expect(kernelPercentChange).toBe("percent_change");
    expect(quantityKinds).toContain("percent_change");
  });

  it("fails the artifact gate when a vendored DDM byte differs from the manifest digest", () => {
    // Arrange
    const { adminRoot, upstreamRoot } = makeDriftFixture();
    writeAt(adminRoot, "shared/ddm/derivation.ts", `${FIXTURE_DDM}\n// vendored drift\n`);

    // Act
    const outcome = artifacts.runSharedArtifactCheck({ root: adminRoot, upstreamRoot });

    // Assert
    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).toBe(5);
    expect(outcome.stderr.join("\n")).toContain(
      "digest mismatch for shared/ddm/derivation.ts",
    );
  });

  it("fails the artifact gate when a Main DDM source no longer matches the manifest digest", () => {
    // Arrange
    const { adminRoot, upstreamRoot } = makeDriftFixture();
    writeAt(upstreamRoot, "src/derivation.ts", `${FIXTURE_DDM}\n// upstream drift\n`);

    // Act
    const outcome = artifacts.runSharedArtifactCheck({ root: adminRoot, upstreamRoot });

    // Assert
    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).toBe(6);
    expect(outcome.stderr.join("\n")).toContain(
      "upstream digest mismatch for src/derivation.ts",
    );
  });
});
