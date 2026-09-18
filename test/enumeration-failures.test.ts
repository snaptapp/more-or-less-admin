/**
 * Feature: admin-quality-gates-and-shared-contracts
 *
 * Edge-case coverage for the failure modes of `Server_Function_Enumeration`
 * (`scripts/enumerate-server-functions.mjs`), task 6.7.
 *
 *   - Requirement 6.12 — IF the enumeration cannot parse a source file under
 *     `src/`, or cannot resolve a dynamically imported module specifier, THEN
 *     the `Test_Suite` fails with an error naming the file path or the
 *     unresolved specifier, and never treats the unparsed file or unresolved
 *     import as passing.
 *   - Requirement 6.13 — IF the enumeration matches zero `Server_Function`
 *     declarations, THEN the `Test_Suite` fails with an error indicating that
 *     the scan matched nothing, so a broken scan cannot pass silently.
 *
 * Method
 * ------
 * Each failure mode is exercised by injecting exactly one defect into an
 * otherwise valid temporary fixture repository, so every failing assertion is
 * attributable to that defect and to nothing else. The first test in the file
 * establishes non-vacuity: the undamaged fixture enumerates successfully, with
 * both a relative and a `@/`-aliased dynamic import resolving, and the CLI exits
 * 0 on it. Every later test reuses that same fixture shape with one thing wrong.
 *
 * Both surfaces are checked for each mode: the programmatic API (which raises an
 * `EnumerationError` carrying a `code`) and the CLI shell (which must exit
 * `EXIT_ENUMERATION_FAILURE` with the diagnostic on stderr and nothing on
 * stdout, so a broken scan cannot be mistaken for an empty-but-valid one).
 *
 * The `MISSING_SOURCE_ROOT` mode is covered here too: it is the degenerate case
 * of a scan that found nothing, and distinguishing it from `EMPTY_ENUMERATION`
 * is what makes the Requirement 6.13 diagnostic actionable.
 *
 * Requirement 6.13 as it applies to the real repository (the enumeration of the
 * actual `src/` is non-empty) is asserted once at the end. The per-declaration
 * properties over that enumeration are Properties 11-13 and live in
 * `test/server-functions.property.test.ts`; they are not repeated here.
 *
 * Every temporary directory this file creates is removed in `afterEach`.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

type EnumerationFailureCode =
  | "PARSE_FAILURE"
  | "UNRESOLVED_IMPORT"
  | "EMPTY_ENUMERATION"
  | "MISSING_SOURCE_ROOT";

/** The shape `EnumerationError` presents once its details have been merged in. */
interface EnumerationFailure extends Error {
  code: EnumerationFailureCode;
  /** `PARSE_FAILURE`: the repo-relative file that did not parse. */
  file?: string;
  line?: number;
  column?: number;
  diagnostic?: string;
  /** `UNRESOLVED_IMPORT`: the specifier, or `null` when it was not a literal. */
  specifier?: string | null;
  fromFile?: string;
  owner?: string;
  /** `MISSING_SOURCE_ROOT`: the directory that was expected to hold sources. */
  sourceRoot?: string;
  /** `EMPTY_ENUMERATION`: the scanned root and how many files it held. */
  root?: string;
  scannedFileCount?: number;
}

interface DynamicImportRecord {
  specifier: string;
  resolvedFile: string | null;
  external: boolean;
  line: number;
  binding: string;
  symbols: string[];
  bindings: { imported: string; local: string }[];
}

interface DeclarationRecord {
  kind: "serverFn" | "routeHandler";
  symbol: string;
  exportedSymbol: string;
  file: string;
  line: number;
  factory: string;
  httpMethod: string | null;
  routePath: string | null;
  middleware: string[];
  composesAuthMiddleware: boolean;
  validator: { step: string; line: number; text: string | null } | null;
  hasHandler: boolean;
  dynamicImports: DynamicImportRecord[];
}

interface EnumerationResult {
  root: string;
  sourceFiles: string[];
  declarations: DeclarationRecord[];
}

interface PathAlias {
  prefix: string;
  suffix: string;
  exact: boolean;
  targets: string[];
}

interface EnumerationModule {
  enumerateServerFunctions(input?: { root?: string; allowEmpty?: boolean }): EnumerationResult;
  listSourceFiles(root: string): string[];
  loadPathAliases(root: string): PathAlias[];
  resolveModuleSpecifier(input: {
    specifier: string;
    fromFile: string;
    root: string;
    aliases?: PathAlias[];
  }): { resolvedFile: string | null; external: boolean };
  parseCliArgs(argv: string[]): { root: string | undefined; pretty: boolean };
  EnumerationError: new (
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) => EnumerationFailure;
  EXIT_ENUMERATION_FAILURE: number;
  SOURCE_ROOT: string;
  defaultRoot(): string;
}

// `scripts/enumerate-server-functions.mjs` is a plain Node ESM script with no
// type declarations, and the repository `tsconfig.json` does not enable
// `allowJs`, so a static relative import would not typecheck. Loading it through
// a computed specifier keeps `tsc --noEmit` clean while exercising the real
// module — the same seam `test/check-lockfiles.property.test.ts` uses.
const ENUMERATION_SPECIFIER = new URL("../scripts/enumerate-server-functions.mjs", import.meta.url)
  .href;
const enumeration = (await import(/* @vite-ignore */ ENUMERATION_SPECIFIER)) as EnumerationModule;
const { EnumerationError, EXIT_ENUMERATION_FAILURE, enumerateServerFunctions } = enumeration;

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..");
const scriptPath = path.join(repoRoot, "scripts", "enumerate-server-functions.mjs");

// ---------------------------------------------------------------------------
// Fixture plumbing
// ---------------------------------------------------------------------------

const createdTempDirs: string[] = [];

afterEach(() => {
  for (;;) {
    const dir = createdTempDirs.pop();
    if (dir === undefined) break;
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

/** Writes `files` (repo-relative paths, forward slashes) into a fresh temp root. */
function writeFixture(files: Record<string, string>): string {
  const created = mkdtempSync(path.join(realpathSync(os.tmpdir()), "enumeration-fixture-"));
  createdTempDirs.push(created);
  const root = realpathSync(created);

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents, "utf8");
  }
  return root;
}

/** Mirrors the real repository's `@/*` → `./src/*` alias so aliased specifiers resolve. */
const FIXTURE_TSCONFIG = `${JSON.stringify(
  { compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } },
  null,
  2,
)}\n`;

/** A middleware module: an exported declaration that is deliberately *not* a server function. */
const MIDDLEWARE_SOURCE = `import { createMiddleware } from "@tanstack/react-start";

export const authMiddleware = createMiddleware().server(({ next }) => next());
`;

/** The dynamically imported server module the valid handlers destructure from. */
const CONTENT_SERVER_SOURCE = `export async function updateThing(id: string): Promise<string> {
  return id;
}
`;

/**
 * The valid `Server_Function` module: one authorized declaration with an input
 * validator and a resolvable relative dynamic import, plus one that resolves
 * through the `@/` alias.
 */
const VALID_SERVER_FN_SOURCE = `import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "./middleware";

export const updateThingFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const { updateThing } = await import("./lib/content.server");
    return updateThing(data.id);
  });

export const readThingFn = createServerFn()
  .middleware([authMiddleware])
  .handler(async () => {
    const { updateThing } = await import("@/lib/content.server");
    return updateThing("seed");
  });
`;

/** Every file of the undamaged fixture, keyed by repo-relative path. */
function baseFiles(): Record<string, string> {
  return {
    "tsconfig.json": FIXTURE_TSCONFIG,
    "src/middleware.ts": MIDDLEWARE_SOURCE,
    "src/lib/content.server.ts": CONTENT_SERVER_SOURCE,
    "src/server-fns.ts": VALID_SERVER_FN_SOURCE,
  };
}

/** The undamaged fixture: the control for every defect injected below. */
function validFixture(): string {
  return writeFixture(baseFiles());
}

/** The undamaged fixture plus/minus exactly one injected defect. */
function fixtureWith(overrides: Record<string, string | null>): string {
  const files = baseFiles();
  for (const [relativePath, contents] of Object.entries(overrides)) {
    if (contents === null) delete files[relativePath];
    else files[relativePath] = contents;
  }
  return writeFixture(files);
}

/** A handler whose single dynamic import is the injected defect. */
function serverFnImporting(specifierExpression: string): string {
  return `import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "./middleware";

export const updateThingFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator((data: { id: string; moduleName: string }) => data)
  .handler(async ({ data }) => {
    const moduleName = data.moduleName;
    const { updateThing } = await import(${specifierExpression});
    return updateThing(data.id);
  });
`;
}

/**
 * Runs `fn`, asserting it raised an `EnumerationError` carrying `code`, and
 * returns the error so the diagnostic can be inspected. A call that *returns* is
 * a test failure: "SHALL NOT treat the unparsed file or unresolved import as
 * passing" is exactly the clause under test.
 */
function captureFailure(code: EnumerationFailureCode, fn: () => unknown): EnumerationFailure {
  let raised: unknown;
  let returned = false;
  try {
    fn();
    returned = true;
  } catch (error) {
    raised = error;
  }

  expect(returned, `expected an EnumerationError (${code}), but the call returned a result`).toBe(
    false,
  );
  expect(raised).toBeInstanceOf(EnumerationError);
  const failure = raised as EnumerationFailure;
  expect(failure.code).toBe(code);
  expect(failure.message.length).toBeGreaterThan(0);
  return failure;
}

/** Invokes the CLI shell against `fixtureRoot`. */
function runCli(fixtureRoot: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [scriptPath, "--root", fixtureRoot], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// ---------------------------------------------------------------------------
// Non-vacuity: the undamaged fixture enumerates successfully
// ---------------------------------------------------------------------------

describe("Server_Function_Enumeration succeeds on an undamaged fixture (non-vacuity)", () => {
  it("enumerates both declarations and resolves relative and aliased dynamic imports", () => {
    const root = validFixture();

    const result = enumerateServerFunctions({ root });

    expect(result.sourceFiles).toEqual([
      "src/lib/content.server.ts",
      "src/middleware.ts",
      "src/server-fns.ts",
    ]);
    expect(result.declarations.map((declaration) => declaration.symbol)).toEqual([
      "updateThingFn",
      "readThingFn",
    ]);

    const [updateThingFn, readThingFn] = result.declarations;

    expect(updateThingFn.file).toBe("src/server-fns.ts");
    expect(updateThingFn.factory).toBe("createServerFn");
    expect(updateThingFn.httpMethod).toBe("POST");
    expect(updateThingFn.composesAuthMiddleware).toBe(true);
    expect(updateThingFn.validator?.step).toBe("inputValidator");
    expect(updateThingFn.hasHandler).toBe(true);
    expect(updateThingFn.dynamicImports).toHaveLength(1);
    expect(updateThingFn.dynamicImports[0].specifier).toBe("./lib/content.server");
    expect(updateThingFn.dynamicImports[0].resolvedFile).toBe("src/lib/content.server.ts");
    expect(updateThingFn.dynamicImports[0].symbols).toEqual(["updateThing"]);

    // The `@/` alias resolves through the fixture tsconfig, so the aliased
    // failure below is attributable to the missing target, not to alias support.
    expect(readThingFn.dynamicImports).toHaveLength(1);
    expect(readThingFn.dynamicImports[0].specifier).toBe("@/lib/content.server");
    expect(readThingFn.dynamicImports[0].resolvedFile).toBe("src/lib/content.server.ts");
    expect(enumeration.loadPathAliases(root).map((alias) => alias.prefix)).toEqual(["@/"]);
  });

  it("exits 0 from the CLI and prints the enumeration on stdout", () => {
    const root = validFixture();

    const cli = runCli(root);

    expect(cli.status).toBe(0);
    expect(cli.stderr).toBe("");
    const parsed = JSON.parse(cli.stdout) as EnumerationResult;
    expect(parsed.declarations.map((declaration) => declaration.symbol)).toEqual([
      "updateThingFn",
      "readThingFn",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Requirement 6.12 — an unparseable source file
// ---------------------------------------------------------------------------

describe("Requirement 6.12: an unparseable source file fails, naming the file", () => {
  /** Syntactically invalid TypeScript: the initializer expression is missing. */
  const BROKEN_SOURCE = "export const broken = ;\n";

  it("raises PARSE_FAILURE naming the file path, position, and parse message", () => {
    const root = fixtureWith({ "src/broken.ts": BROKEN_SOURCE });

    const failure = captureFailure("PARSE_FAILURE", () => enumerateServerFunctions({ root }));

    expect(failure.file).toBe("src/broken.ts");
    expect(failure.message).toContain("src/broken.ts");
    // The diagnostic carries the position and the compiler's own message, so the
    // report is actionable rather than merely naming the file.
    expect(failure.message).toMatch(/src\/broken\.ts:\d+:\d+/);
    expect(failure.line).toBe(1);
    expect(typeof failure.column).toBe("number");
    expect(failure.diagnostic).toBeTruthy();
    expect(failure.message).toContain(failure.diagnostic as string);
  });

  it("does not report a pass even when allowEmpty would otherwise permit an empty result", () => {
    // `allowEmpty` is the only opt-out the API offers, and it must not launder a
    // parse failure into a passing empty enumeration.
    const root = fixtureWith({ "src/server-fns.ts": null, "src/broken.ts": BROKEN_SOURCE });

    const failure = captureFailure("PARSE_FAILURE", () =>
      enumerateServerFunctions({ root, allowEmpty: true }),
    );

    expect(failure.file).toBe("src/broken.ts");
  });

  it("exits non-zero from the CLI with the diagnostic on stderr", () => {
    const root = fixtureWith({ "src/broken.ts": BROKEN_SOURCE });

    const cli = runCli(root);

    expect(cli.status).toBe(EXIT_ENUMERATION_FAILURE);
    expect(cli.status).not.toBe(0);
    expect(cli.stdout).toBe("");
    expect(cli.stderr).toContain("src/broken.ts");
    expect(cli.stderr).toContain("cannot parse");
    expect(cli.stderr).toContain("failure code PARSE_FAILURE");
  });
});

// ---------------------------------------------------------------------------
// Requirement 6.12 — an unresolved dynamic import specifier
// ---------------------------------------------------------------------------

describe("Requirement 6.12: an unresolved dynamic import specifier fails, naming the specifier", () => {
  it("raises UNRESOLVED_IMPORT for an unresolvable relative specifier, naming the handler", () => {
    const root = fixtureWith({
      "src/server-fns.ts": serverFnImporting('"./lib/does-not-exist.server"'),
    });

    const failure = captureFailure("UNRESOLVED_IMPORT", () => enumerateServerFunctions({ root }));

    expect(failure.specifier).toBe("./lib/does-not-exist.server");
    expect(failure.fromFile).toBe("src/server-fns.ts");
    expect(failure.owner).toBe("updateThingFn");
    expect(failure.message).toContain("./lib/does-not-exist.server");
    expect(failure.message).toContain("updateThingFn");
    expect(failure.message).toContain("src/server-fns.ts");
    expect(failure.message).toMatch(/cannot resolve module specifier/);
  });

  it("raises UNRESOLVED_IMPORT for an unresolvable @/ alias specifier", () => {
    const root = fixtureWith({
      "src/server-fns.ts": serverFnImporting('"@/lib/does-not-exist.server"'),
    });

    const failure = captureFailure("UNRESOLVED_IMPORT", () => enumerateServerFunctions({ root }));

    expect(failure.specifier).toBe("@/lib/does-not-exist.server");
    expect(failure.fromFile).toBe("src/server-fns.ts");
    expect(failure.owner).toBe("updateThingFn");
    expect(failure.message).toContain("@/lib/does-not-exist.server");
    expect(failure.message).toContain("updateThingFn");

    // A matching alias whose target is absent is an unresolved specifier, not a
    // bare package name that happens to be uninstalled.
    captureFailure("UNRESOLVED_IMPORT", () =>
      enumeration.resolveModuleSpecifier({
        specifier: "@/lib/does-not-exist.server",
        fromFile: "src/server-fns.ts",
        root,
        aliases: enumeration.loadPathAliases(root),
      }),
    );
  });

  it("raises UNRESOLVED_IMPORT for a dynamic import whose specifier is not a string literal", () => {
    const root = fixtureWith({ "src/server-fns.ts": serverFnImporting("moduleName") });

    const failure = captureFailure("UNRESOLVED_IMPORT", () => enumerateServerFunctions({ root }));

    // Nothing was resolved, so there is no specifier to name — the diagnostic
    // names the offending expression and the handler that owns it instead.
    expect(failure.specifier).toBeNull();
    expect(failure.fromFile).toBe("src/server-fns.ts");
    expect(failure.owner).toBe("updateThingFn");
    expect(failure.message).toContain("does not use a string-literal specifier");
    expect(failure.message).toContain("moduleName");
    expect(failure.message).toContain("updateThingFn");
    expect(typeof failure.line).toBe("number");
  });

  it("does not report a pass even when allowEmpty is set", () => {
    const root = fixtureWith({
      "src/server-fns.ts": serverFnImporting('"./lib/does-not-exist.server"'),
    });

    const failure = captureFailure("UNRESOLVED_IMPORT", () =>
      enumerateServerFunctions({ root, allowEmpty: true }),
    );

    expect(failure.specifier).toBe("./lib/does-not-exist.server");
  });

  it("exits non-zero from the CLI with the specifier on stderr", () => {
    const root = fixtureWith({
      "src/server-fns.ts": serverFnImporting('"./lib/does-not-exist.server"'),
    });

    const cli = runCli(root);

    expect(cli.status).toBe(EXIT_ENUMERATION_FAILURE);
    expect(cli.status).not.toBe(0);
    expect(cli.stdout).toBe("");
    expect(cli.stderr).toContain("./lib/does-not-exist.server");
    expect(cli.stderr).toContain("updateThingFn");
    expect(cli.stderr).toContain("failure code UNRESOLVED_IMPORT");
  });
});

// ---------------------------------------------------------------------------
// Requirement 6.13 — an empty enumeration
// ---------------------------------------------------------------------------

describe("Requirement 6.13: an empty enumeration fails rather than reporting a pass", () => {
  /** Valid sources, no `createServerFn`/`authedServerFn`/api-route declaration. */
  function emptyFixture(): string {
    return fixtureWith({ "src/server-fns.ts": null });
  }

  it("raises EMPTY_ENUMERATION explaining that the scan matched nothing", () => {
    const root = emptyFixture();

    const failure = captureFailure("EMPTY_ENUMERATION", () => enumerateServerFunctions({ root }));

    expect(failure.message).toContain("matched no Server_Function declarations");
    expect(failure.message).toContain("refusing to report a pass");
    // The diagnostic distinguishes "scanned nothing" from "scanned files and
    // matched nothing", which is what makes a broken scan diagnosable.
    expect(failure.scannedFileCount).toBe(2);
    expect(failure.message).toContain("2 scanned file(s)");
  });

  it("is not defeated by files that merely look like declarations", () => {
    // A non-exported server function and an exported non-server-function chain:
    // both are correctly *not* matched, and the scan still refuses to pass.
    const root = fixtureWith({
      "src/server-fns.ts": `import { createServerFn } from "@tanstack/react-start";

const notExported = createServerFn({ method: "POST" }).handler(async () => "x");

export const notAServerFn = someOtherFactory().handler(async () => notExported);
`,
    });

    const failure = captureFailure("EMPTY_ENUMERATION", () => enumerateServerFunctions({ root }));

    expect(failure.scannedFileCount).toBe(3);
  });

  it("returns the empty shape instead of raising only when allowEmpty is set", () => {
    const root = emptyFixture();

    const result = enumerateServerFunctions({ root, allowEmpty: true });

    expect(result.declarations).toEqual([]);
    expect(result.sourceFiles).toEqual(["src/lib/content.server.ts", "src/middleware.ts"]);
  });

  it("exits non-zero from the CLI, which never sets allowEmpty", () => {
    const root = emptyFixture();

    const cli = runCli(root);

    expect(cli.status).toBe(EXIT_ENUMERATION_FAILURE);
    expect(cli.status).not.toBe(0);
    expect(cli.stdout).toBe("");
    expect(cli.stderr).toContain("matched no Server_Function declarations");
    expect(cli.stderr).toContain("failure code EMPTY_ENUMERATION");
  });
});

// ---------------------------------------------------------------------------
// Requirement 6.13 — the degenerate case: no source root at all
// ---------------------------------------------------------------------------

describe("Requirement 6.13: a missing source root fails, naming the directory", () => {
  it("raises MISSING_SOURCE_ROOT from both listSourceFiles and the enumeration", () => {
    const root = writeFixture({ "tsconfig.json": FIXTURE_TSCONFIG });

    const listFailure = captureFailure("MISSING_SOURCE_ROOT", () =>
      enumeration.listSourceFiles(root),
    );
    expect(listFailure.message).toContain(`${enumeration.SOURCE_ROOT} is not a directory`);
    expect(listFailure.sourceRoot).toContain(`/${enumeration.SOURCE_ROOT}`);

    const failure = captureFailure("MISSING_SOURCE_ROOT", () =>
      // Even with the empty-enumeration guard opted out, an absent source root
      // is a scan that could not run, not a scan that found nothing.
      enumerateServerFunctions({ root, allowEmpty: true }),
    );
    expect(failure.message).toContain("no source root to scan");
  });

  it("exits non-zero from the CLI with the missing directory on stderr", () => {
    const root = writeFixture({ "tsconfig.json": FIXTURE_TSCONFIG });

    const cli = runCli(root);

    expect(cli.status).toBe(EXIT_ENUMERATION_FAILURE);
    expect(cli.stdout).toBe("");
    expect(cli.stderr).toContain("no source root to scan");
    expect(cli.stderr).toContain("failure code MISSING_SOURCE_ROOT");
  });
});

// ---------------------------------------------------------------------------
// Requirement 6.13 applied to the real repository
// ---------------------------------------------------------------------------

describe("Requirement 6.13: the real repository enumeration is non-empty", () => {
  it("enumerates the actual src/ without raising, and matches at least one declaration", () => {
    // The default root is this repository, and the default `allowEmpty` is
    // false, so a scan that silently stopped matching would raise here.
    const result = enumerateServerFunctions();

    expect(result.root).toContain("/");
    expect(result.sourceFiles.length).toBeGreaterThan(0);
    expect(result.declarations.length).toBeGreaterThan(0);
  });
});
