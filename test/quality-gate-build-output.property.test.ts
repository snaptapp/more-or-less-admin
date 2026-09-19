/**
 * Feature: admin-quality-gates-and-shared-contracts, Property 23: A gate failure leaves the
 * build output untouched.
 *
 * *For any* member that exits non-zero during `Build_Script`, `Build_Script` exits non-zero,
 * does not invoke the Vite build step, and leaves the build output directory byte-identical
 * to its pre-invocation contents.
 *
 * Validates: Requirement 7.2
 *
 * `Build_Script` is `node scripts/quality-gate.mjs && vite build` (package.json `build`). The
 * observable contract is the POSIX/`cmd`-shared `A && B` semantics that composition relies
 * on: when `A` (the gate) exits non-zero, `B` (the Vite build, the only writer of `dist/`)
 * never runs, so `dist/` is untouched. Rather than run the real multi-second Vite build, the
 * property drives that exact composition via child-process fixtures — a synthetic gate whose
 * exit status is the property variable, and a synthetic build step that writes into `dist/`
 * (standing in for Vite) — spawned through the shell exactly as npm runs the `build` script.
 * A companion case runs the *real* `quality-gate.mjs` against a failing fake member and
 * asserts the gate itself writes nothing into `dist/`, confirming the "gate writes no build
 * output" half of the requirement.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const QUALITY_GATE_PATH = fileURLToPath(new URL("../scripts/quality-gate.mjs", import.meta.url));
/** A `file://` URL is required to `import()` an absolute path on Windows. */
const QUALITY_GATE_URL = pathToFileURL(QUALITY_GATE_PATH).href;

/** Content + size fingerprint of a directory tree (empty object when absent). */
function snapshotDir(dir: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  if (!existsSync(dir)) return snapshot;
  const pending: string[] = [""];
  while (pending.length > 0) {
    const relativeDir = pending.pop() as string;
    for (const entry of readdirSync(path.join(dir, relativeDir), { withFileTypes: true })) {
      const relativePath = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        pending.push(relativePath);
        continue;
      }
      const absolute = path.join(dir, relativePath);
      const stats = statSync(absolute);
      const digest = createHash("sha256").update(readFileSync(absolute)).digest("hex");
      snapshot[relativePath] = `${stats.size}:${digest}`;
    }
  }
  return snapshot;
}

/**
 * Runs the `A && B` composition through the platform shell exactly as npm runs a package
 * script, where A is a synthetic gate and B is a synthetic Vite stand-in that writes `dist/`.
 */
function runComposedBuild(
  workDir: string,
  gateExitCode: number,
): { status: number | null; buildRan: boolean } {
  const gateScript = path.join(workDir, "fake-gate.mjs");
  const buildScript = path.join(workDir, "fake-build.mjs");
  const buildRanMarker = path.join(workDir, "build-ran.marker");
  const distDir = path.join(workDir, "dist");

  writeFileSync(
    gateScript,
    `// synthetic Quality_Gate: writes no build output, exits ${gateExitCode}.\n` +
    `process.exit(${gateExitCode});\n`,
    "utf8",
  );
  // Synthetic Vite: the only writer of dist/. If it ever runs, it leaves evidence.
  writeFileSync(
    buildScript,
    `import { mkdirSync, writeFileSync } from "node:fs";\n` +
    `import path from "node:path";\n` +
    `mkdirSync(${JSON.stringify(distDir)}, { recursive: true });\n` +
    `writeFileSync(path.join(${JSON.stringify(distDir)}, "bundle.js"), "built by vite\\n");\n` +
    `writeFileSync(${JSON.stringify(buildRanMarker)}, "ran\\n");\n`,
    "utf8",
  );

  const node = process.execPath;
  // `A && B` — the exact composition operator in the package.json `build` script.
  const command = `"${node}" "${gateScript}" && "${node}" "${buildScript}"`;
  const result = spawnSync(command, {
    cwd: workDir,
    shell: true,
    encoding: "utf8",
    windowsHide: true,
  });
  return { status: result.status, buildRan: existsSync(buildRanMarker) };
}

describe("Property 23: A gate failure leaves the build output untouched", () => {
  it(
    "Build_Script skips the Vite step and leaves dist/ byte-identical when the gate fails",
    () => {
      // Each iteration spawns a shell plus two Node processes, so the run count is kept
      // modest and well inside the per-test budget. The `A && B` short-circuit does not
      // depend on the specific non-zero code, so a representative spread of failure codes
      // exercises the property faithfully.
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 255 }), (gateExitCode) => {
          const workDir = mkdtempSync(path.join(os.tmpdir(), "gate-build-fail-"));
          try {
            const distDir = path.join(workDir, "dist");
            // Seed a pre-existing dist/ so "untouched" means byte-identical, not merely absent.
            mkdirSync(distDir, { recursive: true });
            writeFileSync(path.join(distDir, "prior.js"), "previous deploy artifact\n", "utf8");
            const before = snapshotDir(distDir);

            const { status, buildRan } = runComposedBuild(workDir, gateExitCode);

            // Build_Script exits non-zero and never invoked the Vite build step.
            expect(status).not.toBe(0);
            expect(buildRan).toBe(false);

            // dist/ is byte-identical to its pre-invocation contents.
            expect(snapshotDir(distDir)).toEqual(before);
          } finally {
            rmSync(workDir, { recursive: true, force: true, maxRetries: 3 });
          }
        }),
        { numRuns: 20 },
      );
    },
    60_000,
  );

  it("Build_Script proceeds to the Vite step only when the gate passes (control)", () => {
    const workDir = mkdtempSync(path.join(os.tmpdir(), "gate-build-pass-"));
    try {
      const { status, buildRan } = runComposedBuild(workDir, 0);
      expect(status).toBe(0);
      expect(buildRan).toBe(true);
      // The Vite stand-in is the writer of dist/ — it wrote only on the passing path.
      expect(existsSync(path.join(workDir, "dist", "bundle.js"))).toBe(true);
    } finally {
      rmSync(workDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("the real quality-gate.mjs writes nothing into dist/ when a member fails", () => {
    // Drive the real gate as a child process against a failing fake member, in a scratch
    // working directory whose dist/ we watch. The gate is not a writer of build output, so a
    // failure must leave dist/ byte-identical (Requirement 7.2).
    const workDir = mkdtempSync(path.join(os.tmpdir(), "gate-real-fail-"));
    try {
      const distDir = path.join(workDir, "dist");
      mkdirSync(distDir, { recursive: true });
      writeFileSync(path.join(distDir, "prior.js"), "previous deploy artifact\n", "utf8");
      const before = snapshotDir(distDir);

      // A tiny harness that imports the real runner and drives it with a failing fake member.
      const harness = path.join(workDir, "run-gate.mjs");
      writeFileSync(
        harness,
        `import { runQualityGate } from ${JSON.stringify(QUALITY_GATE_URL)};\n` +
        `const outcome = runQualityGate({\n` +
        `  root: process.cwd(),\n` +
        `  members: [\n` +
        `    { name: "Fake_Failing", npmScript: "fake", kind: "command", command: process.execPath, args: ["-e", "process.exit(7)"], requiresContractAdoption: false },\n` +
        `  ],\n` +
        `  adoption: { adopted: false, contractVersion: null, reason: "not adopted" },\n` +
        `  env: {}, argv: [],\n` +
        `  stdout: (line) => process.stdout.write(line + "\\n"),\n` +
        `  stderr: (line) => process.stderr.write(line + "\\n"),\n` +
        `});\n` +
        `process.exit(outcome.exitCode);\n`,
        "utf8",
      );

      const result = spawnSync(process.execPath, [harness], {
        cwd: workDir,
        encoding: "utf8",
        windowsHide: true,
      });

      // The gate exited non-zero and left dist/ untouched.
      expect(result.status).not.toBe(0);
      expect(snapshotDir(distDir)).toEqual(before);
      // The failing member's name is reported (sanity on the driven runner).
      expect(`${result.stderr}`).toContain("Fake_Failing");
    } finally {
      rmSync(workDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
