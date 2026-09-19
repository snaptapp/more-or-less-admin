/**
 * Feature: admin-quality-gates-and-shared-contracts
 *
 * Enumeration-driven properties over `Server_Function_Enumeration`
 * (`scripts/enumerate-server-functions.mjs`). All three properties below are
 * *data-derived*: they iterate the real enumeration of every `.ts`/`.tsx` file
 * under `src/`, so a newly added server function or a newly added dynamic
 * import fails these tests without anybody writing a new test case.
 *
 * Property 11: Every dynamically imported symbol resolves to an export
 *   *For all* dynamic `import()` expressions inside a `Server_Function` handler,
 *   as enumerated by `Server_Function_Enumeration`, the imported module exports
 *   every symbol the handler destructures from it; a handler destructuring
 *   `bulkUpdateFacts` from a `./content.server` that exports no such symbol is
 *   reported as a failure naming the handler, specifier, and missing symbol,
 *   without invoking the handler and without any network request.
 *   Validates: Requirements 3.6, 6.3
 *
 * Property 12: Every server function is authorized or explicitly allowlisted
 *   *For all* exported `Server_Function` declarations enumerated by
 *   `Server_Function_Enumeration`, the declaration composes `authMiddleware`
 *   (directly or through `authedServerFn`) or appears in the tracked auth
 *   allowlist, and *for all* entries in that allowlist, the entry's symbol is
 *   one the enumeration finds (no stale entry).
 *   Validates: Requirements 6.1, 6.2
 *
 * Property 13: Input validators reject malformed payloads before any write
 *   *For all* exported `Server_Function` input validators enumerated by
 *   `Server_Function_Enumeration`, supplying a payload that omits a required
 *   field or supplies a field of the wrong type causes the validator to raise
 *   before the handler body executes, and the Firestore test double records
 *   zero writes.
 *   Validates: Requirements 6.4
 *
 * Design notes
 * ------------
 * Property 11 resolves exports **statically**, with the TypeScript AST. It never
 * imports the target module: `content.server.ts`, `roles.server.ts` and friends
 * reach for service-account credentials and the Firestore REST API at call time,
 * and importing them to read an export list would defeat the "without invoking
 * the handler and without a network request" clause of Requirement 6.3.
 *
 * Property 13 needs the *real* validator functions, and TanStack Start does not
 * expose `options` on the object `.handler()` returns (see
 * `@tanstack/start-client-core/dist/esm/createServerFn.js`). So this file mocks
 * `createServerFn` with a recording chain builder that captures each
 * declaration's validator and handler, and mocks `@/lib/admin/middleware` so
 * importing a `*.functions.ts` module pulls in nothing but `zod` and the pure
 * taxonomy/derivation helpers. The validators themselves are the genuine inline
 * zod schemas from `src/`, executed through TanStack's own `execValidator`, in
 * TanStack's own order: validator first, handler second.
 */
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { auditDouble, blockedNetworkAttempts, firestoreDouble } from "./setup";

// ---------------------------------------------------------------------------
// Recording harness for Property 13 (hoisted above the `vi.mock` factories)
// ---------------------------------------------------------------------------

/** What the recording `createServerFn` chain captured for one declaration. */
interface CapturedServerFn {
  factoryOptions: Record<string, unknown> | undefined;
  middleware: readonly unknown[];
  validator: unknown;
  validatorStep: "validator" | "inputValidator" | null;
  handler: unknown;
}

const harness = vi.hoisted(() => {
  interface ChainState {
    factoryOptions: Record<string, unknown> | undefined;
    middleware: unknown[];
    validator: unknown;
    validatorStep: "validator" | "inputValidator" | null;
  }

  /** token object returned by `.handler()` → what the module actually exports. */
  const registry = new Map<object, ChainState & { handler: unknown }>();

  const makeChain = (state: ChainState): Record<string, unknown> => ({
    options: state.factoryOptions,
    middleware: (list: unknown[]) =>
      makeChain({ ...state, middleware: [...state.middleware, ...list] }),
    validator: (fn: unknown) =>
      makeChain({ ...state, validator: fn, validatorStep: "validator" }),
    inputValidator: (fn: unknown) =>
      makeChain({ ...state, validator: fn, validatorStep: "inputValidator" }),
    handler: (fn: unknown) => {
      const token = {
        __recordedServerFn: true,
        method: state.factoryOptions?.["method"] ?? "GET",
      };
      registry.set(token, { ...state, handler: fn });
      return token;
    },
  });

  const createServerFn = (options?: Record<string, unknown>) =>
    makeChain({
      factoryOptions: options,
      middleware: [],
      validator: null,
      validatorStep: null,
    });

  /** Chainable no-op stand-in for `createMiddleware`, in case it is reached. */
  const createMiddleware = (): Record<string, unknown> => {
    const chain: Record<string, unknown> = {
      options: {},
      client: () => chain,
      server: () => chain,
      middleware: () => chain,
      validator: () => chain,
      inputValidator: () => chain,
    };
    return chain;
  };

  const authMiddleware = { __stubAuthMiddleware: true, options: {} };
  const authedServerFn = (options?: Record<string, unknown>) => {
    const chain = createServerFn(options) as {
      middleware: (list: unknown[]) => Record<string, unknown>;
    };
    return chain.middleware([authMiddleware]);
  };

  return { registry, createServerFn, createMiddleware, authMiddleware, authedServerFn };
});

// `createServerFn` is replaced; everything else (notably `execValidator`) stays
// real, so Property 13 runs the validator through TanStack's own executor.
vi.mock("@tanstack/react-start", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createServerFn: harness.createServerFn,
    createMiddleware: harness.createMiddleware,
  };
});

// Keeps the `*.functions.ts` import graph off `@/lib/firebase/client` (the
// Firebase web SDK) — the middleware module is irrelevant to validator behaviour.
vi.mock("@/lib/admin/middleware", () => ({
  authMiddleware: harness.authMiddleware,
  authedServerFn: harness.authedServerFn,
}));

// Safety nets: if anything under test ever did reach Firestore or the audit log,
// the doubles record it instead of touching a real service (Requirement 6.10),
// and Property 13 asserts the recorded write count is zero (Requirement 6.4).
vi.mock("@/lib/firebase/firestore.server", async () => {
  const { firestoreDouble } = await import("./setup");
  return firestoreDouble().module;
});
vi.mock("@/lib/firebase/audit.server", async () => {
  const { auditDouble } = await import("./setup");
  return auditDouble().module;
});

// ---------------------------------------------------------------------------
// Server_Function_Enumeration under test
// ---------------------------------------------------------------------------

interface EnumeratedDynamicImport {
  specifier: string;
  resolvedFile: string | null;
  external: boolean;
  line: number;
  binding: string;
  symbols: string[];
  bindings: { imported: string; local: string }[];
}

interface EnumeratedValidator {
  step: string;
  line: number;
  text: string | null;
}

interface EnumeratedDeclaration {
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
  validator: EnumeratedValidator | null;
  hasHandler: boolean;
  dynamicImports: EnumeratedDynamicImport[];
}

interface Enumeration {
  root: string;
  sourceFiles: string[];
  declarations: EnumeratedDeclaration[];
}

interface PathAlias {
  prefix: string;
  suffix: string;
  exact: boolean;
  targets: string[];
  baseUrl: string;
}

interface EnumeratorModule {
  enumerateServerFunctions(input?: { root?: string; allowEmpty?: boolean }): Enumeration;
  loadPathAliases(root: string): PathAlias[];
  resolveModuleSpecifier(input: {
    specifier: string;
    fromFile: string;
    root: string;
    aliases?: PathAlias[];
  }): { resolvedFile: string | null; external: boolean };
  defaultRoot(): string;
}

// `scripts/enumerate-server-functions.mjs` is untyped Node ESM and the repository
// `tsconfig.json` leaves `allowJs` off, so a static relative import would not
// typecheck. Loading it through a computed specifier keeps `tsc --noEmit` clean
// while still exercising the real module (same pattern as
// `test/check-lockfiles.property.test.ts`).
const ENUMERATOR_SPECIFIER = new URL("../scripts/enumerate-server-functions.mjs", import.meta.url)
  .href;
const enumerator = (await import(/* @vite-ignore */ ENUMERATOR_SPECIFIER)) as EnumeratorModule;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PATH_ALIASES = enumerator.loadPathAliases(REPO_ROOT);
const ENUMERATION = enumerator.enumerateServerFunctions({ root: REPO_ROOT });
const DECLARATIONS = ENUMERATION.declarations;

/** `server-fn-auth-allowlist.json` — Requirement 6.2. */
interface AllowlistEntry {
  symbol: string;
  path: string;
  routeId?: string;
  methods?: string[];
  mechanism: string;
  reason: string;
}

interface AuthAllowlist {
  note: string;
  entries: AllowlistEntry[];
}

const ALLOWLIST_PATH = path.join(REPO_ROOT, "server-fn-auth-allowlist.json");
const ALLOWLIST = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8")) as AuthAllowlist;

// ---------------------------------------------------------------------------
// Static export-surface resolution (Property 11)
// ---------------------------------------------------------------------------

interface ExportSurface {
  /** Names available as runtime values (what a destructuring binding needs). */
  valueExports: ReadonlySet<string>;
  /** Names exported for types only — not destructurable at runtime. */
  typeExports: ReadonlySet<string>;
  /** `export * from` sources that could not be read, so the surface is partial. */
  unresolvedStarSources: readonly string[];
}

const EMPTY_SURFACE: ExportSurface = {
  valueExports: new Set<string>(),
  typeExports: new Set<string>(),
  unresolvedStarSources: [],
};

const surfaceCache = new Map<string, ExportSurface>();

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = (node as { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers;
  return (modifiers ?? []).some((modifier) => modifier.kind === kind);
}

function isExported(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function isDefaultExport(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.DefaultKeyword);
}

/** Collects every name a (possibly destructuring) binding introduces. */
function bindingNames(name: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) {
    into.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    bindingNames(element.name, into);
  }
}

/**
 * Reads the export surface of one module with the TypeScript AST — no import,
 * no evaluation, no network (Requirement 6.3).
 */
function exportSurfaceOf(absoluteFile: string, visiting: Set<string> = new Set()): ExportSurface {
  const cached = surfaceCache.get(absoluteFile);
  if (cached) return cached;
  if (visiting.has(absoluteFile)) return EMPTY_SURFACE;
  visiting.add(absoluteFile);

  let text: string;
  try {
    text = readFileSync(absoluteFile, "utf8");
  } catch {
    return { ...EMPTY_SURFACE, unresolvedStarSources: [absoluteFile] };
  }

  const sourceFile = ts.createSourceFile(
    absoluteFile,
    text,
    ts.ScriptTarget.ESNext,
    true,
    absoluteFile.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const valueExports = new Set<string>();
  const typeExports = new Set<string>();
  const unresolvedStarSources: string[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        bindingNames(declaration.name, valueExports);
      }
      continue;
    }

    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)) &&
      isExported(statement)
    ) {
      if (isDefaultExport(statement)) valueExports.add("default");
      const name = statement.name;
      if (name && ts.isIdentifier(name)) valueExports.add(name.text);
      continue;
    }

    if (
      (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
      isExported(statement)
    ) {
      typeExports.add(statement.name.text);
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      valueExports.add("default");
      continue;
    }

    if (!ts.isExportDeclaration(statement)) continue;

    const clause = statement.exportClause;

    if (clause && ts.isNamedExports(clause)) {
      for (const element of clause.elements) {
        const exportedName = element.name.text;
        if (statement.isTypeOnly || element.isTypeOnly) typeExports.add(exportedName);
        else valueExports.add(exportedName);
      }
      continue;
    }

    if (clause && ts.isNamespaceExport(clause)) {
      if (statement.isTypeOnly) typeExports.add(clause.name.text);
      else valueExports.add(clause.name.text);
      continue;
    }

    // `export * from "..."` — union in the re-exported module's surface.
    const moduleSpecifier = statement.moduleSpecifier;
    if (!moduleSpecifier || !ts.isStringLiteralLike(moduleSpecifier)) continue;

    const specifier = moduleSpecifier.text;
    const fromFile = path.relative(REPO_ROOT, absoluteFile).split(path.sep).join("/");
    let resolvedFile: string | null = null;
    try {
      resolvedFile = enumerator.resolveModuleSpecifier({
        specifier,
        fromFile,
        root: REPO_ROOT,
        aliases: PATH_ALIASES,
      }).resolvedFile;
    } catch {
      unresolvedStarSources.push(specifier);
      continue;
    }
    if (resolvedFile === null) {
      // External package: its surface is not statically readable here.
      unresolvedStarSources.push(specifier);
      continue;
    }

    const nested = exportSurfaceOf(path.resolve(REPO_ROOT, resolvedFile), visiting);
    for (const name of nested.valueExports) valueExports.add(name);
    for (const name of nested.typeExports) typeExports.add(name);
    unresolvedStarSources.push(...nested.unresolvedStarSources);
  }

  const surface: ExportSurface = { valueExports, typeExports, unresolvedStarSources };
  surfaceCache.set(absoluteFile, surface);
  return surface;
}

/**
 * The symbols `importRecord` destructures that `surface` does not export as a
 * runtime value. Type-only exports are reported too: a destructuring binding
 * needs a value, so a symbol that exists only as a type is still missing.
 */
function missingSymbols(
  importRecord: Pick<EnumeratedDynamicImport, "symbols">,
  surface: ExportSurface,
): string[] {
  return importRecord.symbols.filter((symbol) => !surface.valueExports.has(symbol));
}

// ---------------------------------------------------------------------------
// Property 11
// ---------------------------------------------------------------------------

describe("Feature: admin-quality-gates-and-shared-contracts, Property 11: Every dynamically imported symbol resolves to an export", () => {
  it("resolves every symbol every enumerated handler destructures from a dynamic import, without invoking a handler or issuing a request", () => {
    const failures: string[] = [];
    let checkedImports = 0;
    let checkedSymbols = 0;
    const skippedExternal: string[] = [];

    for (const declaration of DECLARATIONS) {
      for (const importRecord of declaration.dynamicImports) {
        if (importRecord.resolvedFile === null) {
          // External package or Node builtin: nothing in-repo to read.
          if (importRecord.symbols.length > 0) {
            skippedExternal.push(
              `${declaration.symbol} (${declaration.file}:${importRecord.line}) → ${importRecord.specifier}`,
            );
          }
          continue;
        }

        checkedImports += 1;
        checkedSymbols += importRecord.symbols.length;

        const surface = exportSurfaceOf(path.resolve(REPO_ROOT, importRecord.resolvedFile));
        for (const symbol of missingSymbols(importRecord, surface)) {
          const kind = surface.typeExports.has(symbol)
            ? "is exported for types only, so it is not destructurable at runtime"
            : "is not exported";
          failures.push(
            `${declaration.file}:${importRecord.line} handler ${declaration.symbol} destructures ` +
            `"${symbol}" from "${importRecord.specifier}" (${importRecord.resolvedFile}), but that ` +
            `module ${kind}.`,
          );
        }
      }
    }

    // Non-vacuity: the enumeration really did find handlers with dynamic imports.
    expect(checkedImports).toBeGreaterThan(0);
    expect(checkedSymbols).toBeGreaterThan(0);
    expect(failures).toEqual([]);

    // Requirement 6.3: reported statically — no handler ran, nothing was fetched.
    expect(blockedNetworkAttempts()).toEqual([]);
    expect(firestoreDouble().writeCount()).toBe(0);

    // Documented, not asserted away: an external specifier cannot be checked
    // statically. There are none today; if one appears this surfaces it.
    expect(skippedExternal).toEqual([]);
  });

  it("reports a handler that destructures a symbol its target module does not export", () => {
    // The concrete failure Requirement 6.3 names: `bulkUpdateFacts` destructured
    // from a `content.server` that exports no such symbol.
    const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "mol-admin-exports-"));
    try {
      const fixtureFile = path.join(fixtureRoot, "content.server.ts");
      writeFileSync(
        fixtureFile,
        [
          "export async function importFactsBatch() { return 0; }",
          "export interface BulkUpdateResult { count: number }",
        ].join("\n"),
        "utf8",
      );

      const surface = exportSurfaceOf(fixtureFile);
      expect(surface.valueExports.has("importFactsBatch")).toBe(true);
      expect(surface.valueExports.has("bulkUpdateFacts")).toBe(false);

      const missing = missingSymbols({ symbols: ["bulkUpdateFacts", "importFactsBatch"] }, surface);
      expect(missing).toEqual(["bulkUpdateFacts"]);

      // A type-only export is reported as missing as well: destructuring needs a value.
      expect(missingSymbols({ symbols: ["BulkUpdateResult"] }, surface)).toEqual([
        "BulkUpdateResult",
      ]);

      // Still nothing invoked and nothing fetched.
      expect(blockedNetworkAttempts()).toEqual([]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("agrees with the real content.server module surface for every symbol its handlers destructure", () => {
    const contentServer = exportSurfaceOf(
      path.resolve(REPO_ROOT, "src/lib/admin/content.server.ts"),
    );
    const destructured = new Set<string>();
    for (const declaration of DECLARATIONS) {
      for (const importRecord of declaration.dynamicImports) {
        if (importRecord.resolvedFile !== "src/lib/admin/content.server.ts") continue;
        for (const symbol of importRecord.symbols) destructured.add(symbol);
      }
    }

    expect(destructured.size).toBeGreaterThan(0);
    expect(destructured.has("bulkUpdateFacts")).toBe(true);
    expect([...destructured].filter((symbol) => !contentServer.valueExports.has(symbol))).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// Property 12
// ---------------------------------------------------------------------------

/** Allowlist entries are joined on file path + exported symbol (+ HTTP method). */
function allowlistEntriesFor(declaration: EnumeratedDeclaration): AllowlistEntry[] {
  return ALLOWLIST.entries.filter(
    (entry) => entry.path === declaration.file && entry.symbol === declaration.exportedSymbol,
  );
}

function declarationsFor(entry: AllowlistEntry): EnumeratedDeclaration[] {
  return DECLARATIONS.filter(
    (declaration) =>
      declaration.file === entry.path && declaration.exportedSymbol === entry.symbol,
  );
}

describe("Feature: admin-quality-gates-and-shared-contracts, Property 12: Every server function is authorized or explicitly allowlisted", () => {
  it("composes authMiddleware on every enumerated declaration that is not in the tracked allowlist", () => {
    // Non-vacuity: Requirement 6.13's own guard, restated here so a broken scan
    // cannot make this property pass by finding nothing.
    expect(DECLARATIONS.length).toBeGreaterThan(0);

    const failures: string[] = [];

    for (const declaration of DECLARATIONS) {
      if (declaration.composesAuthMiddleware) continue;

      const entries = allowlistEntriesFor(declaration);
      if (entries.length === 0) {
        failures.push(
          `${declaration.symbol} (${declaration.file}:${declaration.line}) composes no ` +
          `authMiddleware and has no entry in server-fn-auth-allowlist.json ` +
          `(join key: path "${declaration.file}" + symbol "${declaration.exportedSymbol}").`,
        );
        continue;
      }

      const method = declaration.httpMethod;
      if (method !== null) {
        const covered = entries.some(
          (entry) => entry.methods === undefined || entry.methods.includes(method),
        );
        if (!covered) {
          failures.push(
            `${declaration.symbol} (${declaration.file}:${declaration.line}) composes no ` +
            `authMiddleware and its allowlist entry does not list the ${method} method ` +
            `(listed: ${JSON.stringify(entries.flatMap((entry) => entry.methods ?? []))}).`,
          );
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("carries no stale allowlist entry", () => {
    const stale: string[] = [];

    for (const entry of ALLOWLIST.entries) {
      const matches = declarationsFor(entry);
      if (matches.length === 0) {
        stale.push(
          `stale allowlist entry: symbol "${entry.symbol}" at path "${entry.path}" is not found ` +
          `by Server_Function_Enumeration — remove it from server-fn-auth-allowlist.json.`,
        );
        continue;
      }

      // An entry whose declarations all compose authMiddleware is equally stale:
      // the exemption it records no longer applies.
      if (matches.every((declaration) => declaration.composesAuthMiddleware)) {
        stale.push(
          `stale allowlist entry: symbol "${entry.symbol}" at path "${entry.path}" now composes ` +
          `authMiddleware, so the exemption is obsolete — remove it from ` +
          `server-fn-auth-allowlist.json.`,
        );
        continue;
      }

      for (const method of entry.methods ?? []) {
        if (!matches.some((declaration) => declaration.httpMethod === method)) {
          stale.push(
            `stale allowlist entry: symbol "${entry.symbol}" at path "${entry.path}" lists the ` +
            `${method} method, which Server_Function_Enumeration does not find.`,
          );
        }
      }
    }

    expect(stale).toEqual([]);
  });

  it("records a mechanism and a reason for every allowlisted endpoint", () => {
    // Requirement 6.2: each entry records the symbol, the path, and the
    // authorization mechanism applied instead of authMiddleware.
    expect(ALLOWLIST.entries.length).toBeGreaterThan(0);
    for (const entry of ALLOWLIST.entries) {
      expect(entry.symbol.trim().length, `symbol for ${entry.path}`).toBeGreaterThan(0);
      expect(entry.path.trim().length, `path for ${entry.symbol}`).toBeGreaterThan(0);
      expect(entry.mechanism.trim().length, `mechanism for ${entry.path}`).toBeGreaterThan(0);
      expect(entry.reason.trim().length, `reason for ${entry.path}`).toBeGreaterThan(0);
    }
  });

  it("holds for every synthetic authorization shape the enumeration can report", () => {
    // The decision rule itself, exercised over generated declaration/allowlist
    // pairs: authorized ⟺ composes authMiddleware ∨ allowlisted.
    const authorized = (
      declaration: Pick<EnumeratedDeclaration, "composesAuthMiddleware" | "file" | "exportedSymbol">,
      entries: readonly Pick<AllowlistEntry, "path" | "symbol">[],
    ): boolean =>
      declaration.composesAuthMiddleware ||
      entries.some(
        (entry) => entry.path === declaration.file && entry.symbol === declaration.exportedSymbol,
      );

    fc.assert(
      fc.property(
        fc.boolean(),
        fc.string({ minLength: 1, maxLength: 12 }),
        fc.string({ minLength: 1, maxLength: 12 }),
        fc.boolean(),
        (composes, file, symbol, listed) => {
          const declaration = { composesAuthMiddleware: composes, file, exportedSymbol: symbol };
          const entries = listed ? [{ path: file, symbol }] : [];
          return authorized(declaration, entries) === (composes || listed);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 13
// ---------------------------------------------------------------------------

/** The `*.functions.ts` modules the enumeration found server functions in. */
const FUNCTION_MODULE_FILES = [
  ...new Set(
    DECLARATIONS.filter((declaration) => declaration.kind === "serverFn").map(
      (declaration) => declaration.file,
    ),
  ),
].sort();

/** Repo-relative source file → alias specifier Vitest can import. */
function aliasSpecifierFor(file: string): string {
  return file.replace(/^src\//, "@/").replace(/\.tsx?$/, "");
}

interface ValidatorUnderTest {
  declaration: EnumeratedDeclaration;
  captured: CapturedServerFn;
  validator: unknown;
}

/**
 * Imports every enumerated `*.functions.ts` module against the recording
 * `createServerFn` and pairs each enumerated declaration with the real validator
 * and handler it declared.
 */
async function loadCapturedDeclarations(): Promise<{
  captured: Map<string, CapturedServerFn>;
  missing: string[];
}> {
  const captured = new Map<string, CapturedServerFn>();
  const missing: string[] = [];

  for (const file of FUNCTION_MODULE_FILES) {
    const moduleNamespace = (await import(
      /* @vite-ignore */ aliasSpecifierFor(file)
    )) as Record<string, unknown>;

    for (const declaration of DECLARATIONS) {
      if (declaration.file !== file || declaration.kind !== "serverFn") continue;
      const exported = moduleNamespace[declaration.exportedSymbol];
      const record =
        typeof exported === "object" && exported !== null
          ? harness.registry.get(exported as object)
          : undefined;
      if (!record) {
        missing.push(`${declaration.symbol} (${declaration.file}:${declaration.line})`);
        continue;
      }
      captured.set(`${declaration.file}#${declaration.symbol}`, record as CapturedServerFn);
    }
  }

  return { captured, missing };
}

/** Zod 3 issue shape, narrowed to what the assertions read. */
interface ZodLikeIssue {
  code?: string;
  path?: (string | number)[];
  expected?: string;
  received?: string;
  message?: string;
}

function issuesOf(error: unknown): ZodLikeIssue[] {
  if (error === null || typeof error !== "object") return [];
  const issues = (error as { issues?: unknown }).issues;
  return Array.isArray(issues) ? (issues as ZodLikeIssue[]) : [];
}

/**
 * Runs one declaration's input pipeline in TanStack's own order: the input
 * validator first (through TanStack's `execValidator`), then the handler.
 *
 * The "handler" is a spy that never delegates to the real handler, so nothing
 * server-only executes; `handlerCalls === 0` is what proves the pipeline stopped
 * *before* the handler body. `validatorError` is exactly what the validator
 * raised, never conflated with anything the handler stage produced.
 */
async function runInputPipeline(
  captured: CapturedServerFn,
  data: unknown,
): Promise<{ validatorError: unknown; handlerCalls: number; validated: unknown }> {
  const { execValidator } = (await import("@tanstack/react-start")) as unknown as {
    execValidator: (validator: unknown, input: unknown) => Promise<unknown>;
  };

  const handlerSpy = vi.fn(async (): Promise<string> => "handler-body-would-execute-here");

  let validatorError: unknown = null;
  let validated: unknown = undefined;
  try {
    validated = await execValidator(captured.validator, data);
  } catch (thrown) {
    validatorError = thrown;
  }
  if (validatorError === null) await handlerSpy();

  return { validatorError, handlerCalls: handlerSpy.mock.calls.length, validated };
}

/** A wrong-typed value for a field whose schema reported `expected`. */
function wrongValueFor(expected: string | undefined): unknown[] {
  switch (expected) {
    case "string":
      return [1234, true, ["not", "a", "string"], { not: "a string" }];
    case "number":
    case "integer":
    case "bigint":
      return ["not-a-number", true, [1], { n: 1 }];
    case "boolean":
      return ["not-a-boolean", 1234, [true]];
    case "array":
      return ["not-an-array", 1234, { 0: "x" }];
    case "object":
      return [1234, "not-an-object", [{}]];
    default:
      // Unions, literals and enums report a composite `expected`; every value
      // below differs in type from at least one branch, and the assertion only
      // needs the field to be *present* and rejected.
      return ["__wrong_type__", 1234, true, ["x"], { wrong: true }];
  }
}

describe("Feature: admin-quality-gates-and-shared-contracts, Property 13: Input validators reject malformed payloads before any write", () => {
  it("captures the real validator of every enumerated server-function declaration", async () => {
    const { captured, missing } = await loadCapturedDeclarations();

    expect(missing).toEqual([]);
    expect(captured.size).toBeGreaterThan(0);

    const withValidator = DECLARATIONS.filter(
      (declaration) => declaration.kind === "serverFn" && declaration.validator !== null,
    );
    expect(withValidator.length).toBeGreaterThan(0);

    const mismatches: string[] = [];
    for (const declaration of withValidator) {
      const record = captured.get(`${declaration.file}#${declaration.symbol}`);
      if (!record) {
        mismatches.push(`${declaration.symbol} (${declaration.file}): not captured`);
        continue;
      }
      if (record.validator === null || record.validator === undefined) {
        mismatches.push(
          `${declaration.symbol} (${declaration.file}:${declaration.validator?.line}): the ` +
          `enumeration reports a .${declaration.validator?.step}() step but the declaration ` +
          `installed no validator.`,
        );
      }
      if (record.handler === null || record.handler === undefined) {
        mismatches.push(`${declaration.symbol} (${declaration.file}): no handler captured`);
      }
    }
    expect(mismatches).toEqual([]);

    // Nothing server-only was pulled in by importing the function modules.
    expect(firestoreDouble().writeCount()).toBe(0);
    expect(auditDouble().entryCount()).toBe(0);
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("rejects a payload whose root type differs from the declared schema type, before the handler runs", async () => {
    const { captured } = await loadCapturedDeclarations();
    const validators: ValidatorUnderTest[] = [];
    for (const declaration of DECLARATIONS) {
      if (declaration.kind !== "serverFn" || declaration.validator === null) continue;
      const record = captured.get(`${declaration.file}#${declaration.symbol}`);
      if (!record || record.validator == null) continue;
      validators.push({ declaration, captured: record, validator: record.validator });
    }
    expect(validators.length).toBeGreaterThan(0);

    // Every enumerated validator parses an object; a scalar, null, undefined or
    // array payload is a declared-type mismatch at the root.
    const nonObjectPayload = fc.oneof(
      fc.string(),
      fc.integer(),
      fc.double({ noNaN: true }),
      fc.boolean(),
      fc.constant(null),
      fc.constant(undefined),
      fc.array(fc.integer(), { maxLength: 4 }),
    );

    await fc.assert(
      fc.asyncProperty(nonObjectPayload, async (payload) => {
        for (const entry of validators) {
          const { validatorError, handlerCalls } = await runInputPipeline(entry.captured, payload);
          if (validatorError === null) {
            throw new Error(
              `${entry.declaration.symbol} (${entry.declaration.file}:` +
              `${entry.declaration.validator?.line}) accepted the non-object payload ` +
              `${JSON.stringify(payload) ?? String(payload)}.`,
            );
          }
          if (handlerCalls !== 0) {
            throw new Error(
              `${entry.declaration.symbol} (${entry.declaration.file}) ran its handler for the ` +
              `non-object payload ${JSON.stringify(payload) ?? String(payload)}.`,
            );
          }
        }
        return true;
      }),
      { numRuns: 120 },
    );

    // Requirement 6.4: zero writes recorded by the Firestore double.
    expect(firestoreDouble().writeCount()).toBe(0);
    expect(auditDouble().entryCount()).toBe(0);
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("rejects a payload that omits a required field, naming the field, before the handler runs", async () => {
    const { captured } = await loadCapturedDeclarations();

    const failures: string[] = [];
    let validatorsWithRequiredFields = 0;
    const allOptional: string[] = [];

    for (const declaration of DECLARATIONS) {
      if (declaration.kind !== "serverFn" || declaration.validator === null) continue;
      const record = captured.get(`${declaration.file}#${declaration.symbol}`);
      if (!record || record.validator == null) continue;

      // `{}` omits every required field the schema declares.
      const { validatorError, handlerCalls } = await runInputPipeline(record, {});
      const requiredFields = requiredFieldsFrom(validatorError);

      if (requiredFields.length === 0) {
        if (validatorError !== null) {
          failures.push(
            `${declaration.symbol} (${declaration.file}:${declaration.validator.line}) rejected ` +
            `{} without naming a field: ${String(validatorError)}`,
          );
        } else {
          // Every field is optional, so no payload can omit a required field.
          // The wrong-type half of Requirement 6.4 is covered at the root by the
          // non-object test above.
          allOptional.push(`${declaration.symbol} (${declaration.file})`);
        }
        continue;
      }

      validatorsWithRequiredFields += 1;
      if (handlerCalls !== 0) {
        failures.push(
          `${declaration.symbol} (${declaration.file}) ran its handler for a payload omitting ` +
          `${JSON.stringify(requiredFields)}.`,
        );
      }
    }

    expect(failures).toEqual([]);
    // Non-vacuity: at least one enumerated validator really does declare a
    // required field, so the omitted-field case is exercised.
    expect(validatorsWithRequiredFields).toBeGreaterThan(0);
    // Recorded, not asserted away: these validators declare no required field.
    expect(allOptional.length).toBeLessThan(
      DECLARATIONS.filter((d) => d.kind === "serverFn" && d.validator !== null).length,
    );

    expect(firestoreDouble().writeCount()).toBe(0);
    expect(auditDouble().entryCount()).toBe(0);
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("rejects every required field supplied with the wrong type, before the handler runs", async () => {
    const { captured } = await loadCapturedDeclarations();

    const failures: string[] = [];
    let checkedFields = 0;

    for (const declaration of DECLARATIONS) {
      if (declaration.kind !== "serverFn" || declaration.validator === null) continue;
      const record = captured.get(`${declaration.file}#${declaration.symbol}`);
      if (!record || record.validator == null) continue;

      const probe = await runInputPipeline(record, {});
      const requiredFields = requiredFieldsFrom(probe.validatorError);
      const expectedByField = expectedTypesFrom(probe.validatorError);

      for (const field of requiredFields) {
        const candidates = wrongValueFor(expectedByField.get(field));
        let rejected = false;
        let lastError: unknown = null;

        for (const candidate of candidates) {
          const payload: Record<string, unknown> = { [field]: candidate };
          const { validatorError, handlerCalls } = await runInputPipeline(record, payload);
          lastError = validatorError;

          if (handlerCalls !== 0) {
            failures.push(
              `${declaration.symbol} (${declaration.file}) ran its handler for payload ` +
              `${JSON.stringify(payload)}.`,
            );
            break;
          }
          // The field is present, so an issue on its path is necessarily a
          // declared-type rejection rather than an omission.
          const issueOnField = issuesOf(validatorError).some(
            (issue) => (issue.path ?? [])[0] === field,
          );
          if (validatorError !== null && issueOnField) {
            rejected = true;
            break;
          }
        }

        checkedFields += 1;
        if (!rejected) {
          failures.push(
            `${declaration.symbol} (${declaration.file}:${declaration.validator.line}) did not ` +
            `reject field "${field}" for any wrong-typed value ` +
            `${JSON.stringify(candidates)} (expected type ` +
            `${JSON.stringify(expectedByField.get(field) ?? null)}); last error: ` +
            `${String(lastError)}`,
          );
        }
      }
    }

    expect(failures).toEqual([]);
    expect(checkedFields).toBeGreaterThan(0);

    expect(firestoreDouble().writeCount()).toBe(0);
    expect(auditDouble().entryCount()).toBe(0);
    expect(blockedNetworkAttempts()).toEqual([]);
  });
});

/**
 * Required top-level field names, learned from the validation error a `{}`
 * payload produces. Every issue whose path starts at a field names a field the
 * schema will not accept as absent.
 */
function requiredFieldsFrom(error: unknown): string[] {
  const fields = new Set<string>();
  for (const issue of issuesOf(error)) {
    const first = (issue.path ?? [])[0];
    if (typeof first === "string" && first.length > 0) fields.add(first);
  }
  return [...fields].sort();
}

/** Field → the type the schema said it expected, when the issue reports one. */
function expectedTypesFrom(error: unknown): Map<string, string> {
  const expectedByField = new Map<string, string>();
  for (const issue of issuesOf(error)) {
    const first = (issue.path ?? [])[0];
    if (typeof first !== "string") continue;
    if (typeof issue.expected === "string" && !expectedByField.has(first)) {
      expectedByField.set(first, issue.expected);
    }
  }
  return expectedByField;
}
