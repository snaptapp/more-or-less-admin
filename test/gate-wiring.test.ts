/**
 * Example tests for the Quality_Gate wiring (task 7.6).
 *
 * Feature: admin-quality-gates-and-shared-contracts
 *
 * Each assertion here pins one concrete wiring behaviour rather than a
 * generated property (Property 22-24, task 7.5, own the gate runner's ordering,
 * short-circuit and no-skip properties). The four criteria covered are:
 *
 *   - Requirement 7.9 — a single npm script runs Quality_Gate alone, exits with
 *     the gate status code, and produces no build output.
 *   - Requirement 7.8 — Lint_Step exits with status 0 on warnings-only and
 *     non-zero on 1 or more ESLint errors, so the existing warnings do not block
 *     the gate but an error does.
 *   - Requirement 7.1 — Build_Script invokes the Vite build step only if
 *     Quality_Gate exited with status code 0.
 *   - Requirement 7.5 — Deploy_Script skips its `wrangler` invocation when a
 *     Quality_Gate member exits non-zero.
 *
 * Approach
 * --------
 * The npm script *composition* (7.1, 7.5, 7.9) is asserted against the literal
 * `package.json` script strings, because the composition — `&&` sequencing and
 * the gate-only `gate` script — is exactly the mechanism the design relies on:
 * `&&` prevents `vite build` (the only step that writes `dist/`) from running on
 * a non-zero gate exit, and `deploy` reaches the gate through `build` so the
 * same `&&` skips `wrangler`. To show that the sequencing actually gates, the
 * real `runQualityGate` is driven with a forced-failing fake member (it exits
 * non-zero, so a following `&&` step never runs) and with all-passing fake
 * members (it exits 0, so a following step does run). Driving the runner with
 * fakes keeps the test off the real 120 s suite while exercising the genuine
 * composition root.
 *
 * The gate "produces no build output" clause (7.9) is verified directly: the
 * runner is executed against a temp root and the run is shown to create no
 * `dist/` (or other build) directory there.
 *
 * Lint_Step (7.8) is exercised for real: an isolated ESLint fixture with its own
 * flat config is linted through the *same* ESLint binary the gate resolves for
 * its Lint_Step member (`resolveMemberCommand`), once with a warnings-only
 * source and once with an error source. The real member definition is also
 * asserted to carry no `--max-warnings`, which is what makes warnings non-fatal.
 *
 * No real `vite build` and no real `wrangler deploy` are ever run.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..");

// The gate is a declaration-less `.mjs` module, so it is loaded through a
// computed specifier (a static import would not typecheck under `strict`).
interface GateMember {
  name: string;
  npmScript?: string;
  kind: string;
  package?: string;
  bin?: string;
  script?: string;
  command?: string;
  args?: readonly string[];
  requiresContractAdoption?: boolean;
}

interface GateOutcome {
  ok: boolean;
  exitCode: number;
  invoked: string[];
  notInvoked: string[];
  excluded: string[];
  failure: { member: string; exitCode: number | null; reason: string } | null;
  stdout: string[];
  stderr: string[];
}

interface QualityGateModule {
  GATE_MEMBERS: readonly GateMember[];
  MEMBER_ORDER: readonly string[];
  runQualityGate(options?: {
    root?: string;
    members?: readonly GateMember[];
    spawn?: (
      command: string,
      args: string[],
      options: object,
    ) => { status: number | null; error?: Error; signal?: string | null };
    env?: Record<string, string | undefined>;
    argv?: string[];
    adoption?: { adopted: boolean; contractVersion?: number | string | null; reason?: string };
    now?: () => number;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
  }): GateOutcome;
  resolveMemberCommand(member: GateMember, root: string): { command: string; args: string[] };
}

const gateSpecifier = new URL("../scripts/quality-gate.mjs", import.meta.url).href;
const gate = (await import(gateSpecifier)) as QualityGateModule;

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
};
const scripts = pkg.scripts ?? {};

// ---------------------------------------------------------------------------
// Temporary-directory plumbing
// ---------------------------------------------------------------------------

const createdTempDirs: string[] = [];
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
      // A retained handle is not a test failure; leave the leaked temp dir.
    }
  }
});

/** A fake gate member that exits with a fixed status when invoked. */
function fakeMember(name: string): GateMember {
  return {
    name,
    npmScript: name.toLowerCase(),
    kind: "command",
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    requiresContractAdoption: false,
  };
}

/**
 * A spawn double that reports the status recorded for each member name, so the
 * runner's real ordering and short-circuit logic run without launching anything.
 * The command carries the member name via a trailing marker arg.
 */
function scriptedSpawn(statusByMember: Record<string, number>) {
  const calls: string[] = [];
  const spawn = (_command: string, args: string[]): { status: number } => {
    // The member name is the last arg of the fake member's `args`.
    const marker = args[args.length - 1] ?? "";
    calls.push(marker);
    return { status: statusByMember[marker] ?? 0 };
  };
  return { spawn, calls };
}

/** Builds fake members whose final arg is a marker equal to the member name. */
function markedMembers(names: string[]): GateMember[] {
  return names.map((name) => ({
    name,
    npmScript: name.toLowerCase(),
    kind: "command",
    command: process.execPath,
    args: ["-e", "process.exit(0)", name],
    requiresContractAdoption: false,
  }));
}

// ===========================================================================
// Requirement 7.9 — a single script runs the gate alone and produces no output
// ===========================================================================

describe("Requirement 7.9: the gate-only script runs Quality_Gate alone with no build output", () => {
  it("exposes a `gate` script that invokes the gate composition root and nothing else", () => {
    expect(scripts["gate"]).toBe("node scripts/quality-gate.mjs");
  });

  it("does not invoke Vite or wrangler from the gate-only script", () => {
    const gateScript = scripts["gate"] ?? "";
    expect(gateScript).not.toMatch(/vite/);
    expect(gateScript).not.toMatch(/wrangler/);
  });

  it("produces no build output directory when the gate runs to completion", () => {
    const root = makeTempDir("gate-only-no-output-");

    const outcome = gate.runQualityGate({
      root,
      members: [fakeMember("Alpha"), fakeMember("Beta")],
      adoption: { adopted: false, reason: "test" },
    });

    // Every configured member passed, so the gate itself exits 0 …
    expect(outcome.ok).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.invoked).toEqual(["Alpha", "Beta"]);

    // … and it wrote no build output of its own: the classic Vite/Worker output
    // directories do not exist under the root it ran against.
    for (const buildDir of ["dist", ".output", ".nitro", ".wrangler"]) {
      expect(fs.existsSync(path.join(root, buildDir))).toBe(false);
    }
  });
});

// ===========================================================================
// Requirement 7.8 — Lint_Step: warnings-only exits 0, an error exits non-zero
// ===========================================================================

describe("Requirement 7.8: Lint_Step exits 0 on warnings-only and non-zero on an error", () => {
  /** Resolve the exact ESLint binary the gate's Lint_Step member would launch. */
  const lintMember = gate.GATE_MEMBERS.find((member) => member.name === "Lint_Step");

  it("configures Lint_Step without --max-warnings, so warnings are not fatal", () => {
    expect(lintMember, "Lint_Step must be a configured gate member").toBeTruthy();
    const args = [...(lintMember?.args ?? [])];
    expect(args).not.toContain("--max-warnings");
    expect(args.some((arg) => arg.startsWith("--max-warnings"))).toBe(false);
  });

  /**
   * Writes an isolated ESLint fixture: a flat config that makes one rule a
   * warning and one rule an error, plus a source file. Linting runs through the
   * same `eslint` bin the gate resolves, in the fixture directory, so the repo's
   * own config and sources are untouched.
   */
  function makeLintFixture(prefix: string, source: string): string {
    const dir = makeTempDir(prefix);
    fs.writeFileSync(
      path.join(dir, "eslint.config.js"),
      [
        "export default [",
        "  {",
        '    files: ["**/*.js"],',
        "    rules: {",
        // `no-unused-vars` as a warning, `no-debugger` as an error: two
        // built-in core rules, so the fixture needs no plugin install.
        '      "no-unused-vars": "warn",',
        '      "no-debugger": "error",',
        "    },",
        "  },",
        "];",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(path.join(dir, "source.js"), source, "utf8");
    return dir;
  }

  /** Runs the resolved ESLint bin against the fixture directory. */
  function runEslint(fixtureDir: string): { status: number | null; stdout: string; stderr: string } {
    // Resolve the ESLint bin exactly as the gate does (package-bin, no shell).
    const { command, args } = gate.resolveMemberCommand(
      { name: "Lint_Step", kind: "package-bin", package: "eslint", bin: "eslint", args: ["."] },
      repoRoot,
    );
    const result = spawnSync(command, args, {
      cwd: fixtureDir,
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  it("exits 0 when the source has warnings but no errors", () => {
    // `unused` triggers the warning rule; there is no `debugger`, so no error.
    const fixture = makeLintFixture("gate-lint-warn-", "const unused = 1;\nexport const ok = 2;\n");

    const result = runEslint(fixture);

    expect(result.status).toBe(0);
  });

  it("exits non-zero when the source has at least one error", () => {
    // `debugger` triggers the error rule; the warning is present too.
    const fixture = makeLintFixture(
      "gate-lint-error-",
      "const unused = 1;\nexport function go() {\n  debugger;\n}\n",
    );

    const result = runEslint(fixture);

    expect(result.status).not.toBe(0);
  });
});

// ===========================================================================
// Requirement 7.1 — Build_Script invokes Vite only on gate exit 0
// ===========================================================================

describe("Requirement 7.1: Build_Script invokes Vite only if the gate exits 0", () => {
  it("sequences the gate before Vite with && so Vite runs only on gate success", () => {
    // The && operator is exactly what makes `vite build` conditional on the
    // gate's exit code: a non-zero gate exit short-circuits the sequence.
    expect(scripts["build"]).toBe("node scripts/quality-gate.mjs && vite build");
  });

  it("does not run Vite when a gate member fails (the gate exits non-zero)", () => {
    // A forced-failing member makes the gate exit non-zero; with `&&`, the shell
    // would never reach `vite build`. Assert the gate's non-zero exit directly.
    const members = markedMembers(["First", "Second", "Third"]);
    const { spawn, calls } = scriptedSpawn({ Second: 1 });

    const outcome = gate.runQualityGate({
      root: repoRoot,
      members,
      spawn,
      adoption: { adopted: false, reason: "test" },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).not.toBe(0);
    // Short-circuit: the member after the failing one is never invoked.
    expect(outcome.invoked).toEqual(["First", "Second"]);
    expect(outcome.notInvoked).toContain("Third");
    expect(calls).toEqual(["First", "Second"]);
  });

  it("exits 0 when every gate member passes, so the following Vite step would run", () => {
    const members = markedMembers(["First", "Second"]);
    const { spawn } = scriptedSpawn({});

    const outcome = gate.runQualityGate({
      root: repoRoot,
      members,
      spawn,
      adoption: { adopted: false, reason: "test" },
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.invoked).toEqual(["First", "Second"]);
  });
});

// ===========================================================================
// Requirement 7.5 — Deploy_Script skips wrangler on gate failure
// ===========================================================================

describe("Requirement 7.5: Deploy_Script skips wrangler when the gate fails", () => {
  it("runs the build (and thus the gate) before wrangler, sequenced with &&", () => {
    // `deploy` reaches the gate through `build`; the same `&&` that gates Vite
    // therefore also gates `wrangler deploy`.
    expect(scripts["deploy"]).toBe("npm run build && wrangler deploy");

    // The gate must sit inside `build`, ahead of the vite step.
    expect(scripts["build"]).toMatch(/^node scripts\/quality-gate\.mjs &&/);
  });

  it("keeps the Workers Builds deploy command shape (npm run build / wrangler deploy)", () => {
    // Requirement 1.7 / 7.3: the build and deploy commands stay conventional so
    // Workers Builds needs no reconfiguration; the gate blocks by running first.
    expect(scripts["build"]?.startsWith("node scripts/quality-gate.mjs")).toBe(true);
    expect(scripts["deploy"]?.includes("wrangler deploy")).toBe(true);
  });

  it("exits non-zero on a gate member failure, so the following wrangler step would not run", () => {
    const members = markedMembers(["Lockfile_Check", "Typecheck_Step"]);
    const { spawn } = scriptedSpawn({ Lockfile_Check: 2 });

    const outcome = gate.runQualityGate({
      root: repoRoot,
      members,
      spawn,
      adoption: { adopted: false, reason: "test" },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).not.toBe(0);
    // The failing first member short-circuits before the second even runs, so a
    // build wrapping this gate would exit non-zero and `&& wrangler deploy`
    // would never be reached.
    expect(outcome.invoked).toEqual(["Lockfile_Check"]);
    expect(outcome.notInvoked).toContain("Typecheck_Step");
  });
});
