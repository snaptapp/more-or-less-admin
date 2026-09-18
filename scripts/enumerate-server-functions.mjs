#!/usr/bin/env node
/**
 * Server_Function_Enumeration — the structural scan that drives Requirements 6.1-6.4.
 *
 * Walks every `.ts`/`.tsx` file under `src/` with the TypeScript compiler API (a real
 * AST scan, not a regex sweep, because Requirement 6.3 needs accurate destructured-symbol
 * extraction from dynamic `import()` calls inside handler bodies) and reports, for every
 * exported `createServerFn`/`authedServerFn` declaration and every exported route handler
 * under `src/routes/api/`:
 *
 *   - the exported symbol name and its repo-relative file path,
 *   - its middleware composition (and whether `authMiddleware` is composed, directly or
 *     through `authedServerFn`),
 *   - its input validator (`.inputValidator(...)` or the legacy `.validator(...)`),
 *   - every dynamic `import()` specifier inside its handler, the file that specifier
 *     resolves to, and the symbols the handler destructures from it.
 *
 * Failure contract:
 *   - a source file that does not parse  → `EnumerationError` code `PARSE_FAILURE`,
 *     naming the file path and the parse diagnostic (Requirement 6.12),
 *   - a dynamic `import()` specifier that cannot be resolved (or is not a string literal)
 *     → `EnumerationError` code `UNRESOLVED_IMPORT`, naming the specifier and the
 *     importing handler (Requirement 6.12),
 *   - an enumeration that matches no declaration at all → `EnumerationError` code
 *     `EMPTY_ENUMERATION` (Requirement 6.13), so a broken scan cannot pass silently.
 *
 * None of those conditions is ever reported as a pass.
 *
 * The programmatic API (`enumerateServerFunctions`) is the contract the `Test_Suite`
 * consumes; it takes a `root` so tests can point it at temporary fixture directories to
 * exercise the failure modes. The CLI at the bottom is a thin shell that prints the
 * enumeration as JSON on stdout, or the diagnostic on stderr with a non-zero exit.
 *
 *   node scripts/enumerate-server-functions.mjs [--root <dir>] [--pretty]
 */

import { readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

/** Factories that create a `Server_Function`. */
export const SERVER_FN_FACTORIES = Object.freeze(["createServerFn", "authedServerFn"]);

/** The factory that composes `authMiddleware` on the caller's behalf. */
export const AUTHED_SERVER_FN_FACTORY = "authedServerFn";

/** The middleware that constitutes the `Authorization_Boundary` on a server function. */
export const AUTH_MIDDLEWARE_NAME = "authMiddleware";

/** Chain steps that install an input validator. `validator` is the pre-1.170 spelling. */
export const VALIDATOR_STEP_NAMES = Object.freeze(["inputValidator", "validator"]);

/** Directory prefix (repo-relative, forward slashes) holding enumerated route handlers. */
export const API_ROUTES_PREFIX = "src/routes/api/";

/** Source root scanned by the enumeration, relative to the repository root. */
export const SOURCE_ROOT = "src";

/** File extensions scanned. */
const SCANNED_EXTENSIONS = Object.freeze([".ts", ".tsx"]);

/** Directory names never descended into. */
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", ".output"]);

/** Suffixes tried, in order, when resolving a module specifier to a file on disk. */
const RESOLUTION_SUFFIXES = Object.freeze([
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".d.ts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  "/index.ts",
  "/index.tsx",
  "/index.mts",
  "/index.js",
  "/index.mjs",
]);

/** Exit code used by the CLI for any enumeration failure. */
export const EXIT_ENUMERATION_FAILURE = 1;

/** Raised for every enumeration failure; `code` identifies which contract was violated. */
export class EnumerationError extends Error {
  /**
   * @param {string} code - One of `PARSE_FAILURE`, `UNRESOLVED_IMPORT`,
   *   `EMPTY_ENUMERATION`, `MISSING_SOURCE_ROOT`.
   * @param {string} message - Diagnostic naming the cause.
   * @param {Record<string, unknown>} [details] - Structured context for assertions.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "EnumerationError";
    this.code = code;
    Object.assign(this, details);
  }
}

const require = createRequire(import.meta.url);

/** The repository root, derived from this script's location (`scripts/..`). */
export function defaultRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/** Normalizes an absolute path to forward slashes. */
function toPosix(candidate) {
  return candidate.split(path.sep).join("/");
}

/** Key used to look a source file up in a `ts.Program`, case-folded where the OS is. */
function programKey(absolutePath) {
  const normalized = toPosix(path.resolve(absolutePath));
  return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
}

function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isDirectory(candidate) {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Lists every scanned source file under `<root>/src`, repo-relative with forward slashes,
 * in lexicographic order.
 *
 * @param {string} root - Absolute repository root.
 * @returns {string[]}
 * @throws {EnumerationError} `MISSING_SOURCE_ROOT` when `<root>/src` is not a directory.
 */
export function listSourceFiles(root) {
  const sourceRoot = path.join(root, SOURCE_ROOT);
  if (!isDirectory(sourceRoot)) {
    throw new EnumerationError(
      "MISSING_SOURCE_ROOT",
      `enumerate-server-functions: no source root to scan: ${toPosix(sourceRoot)} is not a directory.`,
      { sourceRoot: toPosix(sourceRoot) },
    );
  }

  const found = [];
  const pending = [SOURCE_ROOT];

  while (pending.length > 0) {
    const relativeDir = pending.pop();
    let entries;
    try {
      entries = readdirSync(path.join(root, relativeDir), { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const relativePath = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".d.ts")) continue;
      if (SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
        found.push(relativePath);
      }
    }
  }

  return found.sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
}

/**
 * Reads the `compilerOptions.paths` aliases from `<root>/tsconfig.json`, so specifiers
 * such as `@/lib/firebase/audit.server` resolve the same way the bundler resolves them.
 * A missing or unreadable tsconfig yields no aliases rather than a failure — an alias
 * that then fails to resolve is reported as an unresolved specifier.
 *
 * @param {string} root
 * @returns {{ prefix: string, suffix: string, exact: boolean, targets: string[] }[]}
 */
export function loadPathAliases(root) {
  const configPath = path.join(root, "tsconfig.json");
  if (!isFile(configPath)) return [];

  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
  if (error || !config) return [];

  const compilerOptions = config.compilerOptions ?? {};
  const paths = compilerOptions.paths ?? {};
  const baseUrl = path.resolve(root, compilerOptions.baseUrl ?? ".");

  const aliases = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets)) continue;
    const resolvedTargets = targets.filter((target) => typeof target === "string");
    const starIndex = pattern.indexOf("*");
    if (starIndex === -1) {
      aliases.push({ prefix: pattern, suffix: "", exact: true, targets: resolvedTargets, baseUrl });
    } else {
      aliases.push({
        prefix: pattern.slice(0, starIndex),
        suffix: pattern.slice(starIndex + 1),
        exact: false,
        targets: resolvedTargets,
        baseUrl,
      });
    }
  }
  // Longest prefix first, matching TypeScript's own preference for the most specific pattern.
  return aliases.sort((a, b) => b.prefix.length - a.prefix.length);
}

/** Tries every resolution suffix against `base`, returning the first existing file. */
function resolveFileBase(base) {
  for (const suffix of RESOLUTION_SUFFIXES) {
    const candidate = base + suffix;
    if (isFile(candidate)) return candidate;
  }
  // TypeScript ESM convention: `./x.js` may name the emit of `./x.ts`.
  const jsExtension = /\.(js|jsx|mjs|cjs)$/.exec(base);
  if (jsExtension) {
    const stem = base.slice(0, -jsExtension[0].length);
    for (const suffix of [".ts", ".tsx", ".mts", ".cts"]) {
      if (isFile(stem + suffix)) return stem + suffix;
    }
  }
  return null;
}

const BUILTIN_MODULES = new Set([
  "assert",
  "buffer",
  "child_process",
  "crypto",
  "events",
  "fs",
  "http",
  "https",
  "module",
  "os",
  "path",
  "process",
  "stream",
  "url",
  "util",
  "zlib",
]);

/** True when `specifier` names a Node builtin. */
function isBuiltinSpecifier(specifier) {
  return specifier.startsWith("node:") || BUILTIN_MODULES.has(specifier);
}

/** Extracts the package name (with scope) from a bare specifier. */
function packageNameOf(specifier) {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

/** True when a bare specifier resolves to an installed package. */
function bareSpecifierIsInstalled(specifier, root, fromDirectory) {
  try {
    require.resolve(specifier, { paths: [fromDirectory, root] });
    return true;
  } catch {
    // Fall through: an ESM-only subpath export can defeat require.resolve.
  }

  const packageName = packageNameOf(specifier);
  let directory = fromDirectory;
  for (; ;) {
    if (isDirectory(path.join(directory, "node_modules", packageName))) return true;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return isDirectory(path.join(root, "node_modules", packageName));
}

/**
 * Resolves a module specifier written inside `fromFile` to a repo-relative source file.
 *
 * @param {object} input
 * @param {string} input.specifier
 * @param {string} input.fromFile - Repo-relative path of the importing file.
 * @param {string} input.root - Absolute repository root.
 * @param {ReturnType<typeof loadPathAliases>} input.aliases
 * @returns {{ resolvedFile: string | null, external: boolean }} `resolvedFile` is
 *   repo-relative for in-repo modules, and `null` for an external package or builtin.
 * @throws {EnumerationError} `UNRESOLVED_IMPORT` when nothing resolves.
 */
export function resolveModuleSpecifier({ specifier, fromFile, root, aliases = [] }) {
  const fromDirectory = path.dirname(path.join(root, fromFile));

  const unresolved = () => {
    throw new EnumerationError(
      "UNRESOLVED_IMPORT",
      `enumerate-server-functions: cannot resolve module specifier "${specifier}" imported by ${fromFile}.`,
      { specifier, fromFile },
    );
  };

  if (specifier === "") unresolved();

  if (isBuiltinSpecifier(specifier)) return { resolvedFile: null, external: true };

  const relativeToRepo = (absolutePath) => {
    const relative = toPosix(path.relative(root, absolutePath));
    return relative.startsWith("..") ? toPosix(absolutePath) : relative;
  };

  if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) {
    const base = specifier.startsWith("/")
      ? path.join(root, specifier)
      : path.resolve(fromDirectory, specifier);
    const resolved = resolveFileBase(base);
    if (!resolved) unresolved();
    return { resolvedFile: relativeToRepo(resolved), external: false };
  }

  for (const alias of aliases) {
    const { prefix, suffix, exact, targets, baseUrl } = alias;
    let captured = null;
    if (exact) {
      if (specifier !== prefix) continue;
      captured = "";
    } else {
      if (!specifier.startsWith(prefix)) continue;
      if (suffix !== "" && !specifier.endsWith(suffix)) continue;
      const end = suffix === "" ? specifier.length : specifier.length - suffix.length;
      if (end < prefix.length) continue;
      captured = specifier.slice(prefix.length, end);
    }

    for (const target of targets) {
      const substituted = exact ? target : target.replace("*", captured);
      const resolved = resolveFileBase(path.resolve(baseUrl, substituted));
      if (resolved) return { resolvedFile: relativeToRepo(resolved), external: false };
    }
    // A matching alias that resolves to nothing is an unresolved specifier, not a package.
    unresolved();
  }

  if (bareSpecifierIsInstalled(specifier, root, fromDirectory)) {
    return { resolvedFile: null, external: true };
  }

  return unresolved();
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

function hasExportModifier(node) {
  return (node.modifiers ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
}

/** Names re-exported through a bare `export { a, b as c }` list. */
function collectExportListNames(sourceFile) {
  const names = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    if (statement.moduleSpecifier) continue;
    const clause = statement.exportClause;
    if (!clause || !ts.isNamedExports(clause)) continue;
    for (const element of clause.elements) {
      names.add((element.propertyName ?? element.name).text);
    }
  }
  return names;
}

function isIdentifierNamed(node, name) {
  return ts.isIdentifier(node) && node.text === name;
}

function lineOf(node, sourceFile) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function textOf(node, sourceFile) {
  return node.getText(sourceFile);
}

/**
 * Decomposes a fluent call chain into its root call and its ordered steps.
 * `createServerFn({...}).middleware([m]).inputValidator(v).handler(h)` yields
 * `{ rootName: "createServerFn", steps: [middleware, inputValidator, handler] }`.
 */
function decomposeChain(expression) {
  const steps = [];
  let current = expression;

  while (ts.isCallExpression(current)) {
    const callee = current.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      steps.push({ name: callee.name.text, call: current });
      current = callee.expression;
      continue;
    }
    if (ts.isIdentifier(callee)) {
      return { rootName: callee.text, rootCall: current, steps: steps.reverse() };
    }
    return { rootName: null, rootCall: current, steps: steps.reverse() };
  }

  return { rootName: null, rootCall: null, steps: steps.reverse() };
}

/** Returns the initializer of `name` on an object literal, or `null`. */
function objectProperty(objectLiteral, name) {
  if (!objectLiteral || !ts.isObjectLiteralExpression(objectLiteral)) return null;
  for (const property of objectLiteral.properties) {
    const propertyName = property.name;
    if (!propertyName) continue;
    const key = ts.isIdentifier(propertyName) || ts.isStringLiteralLike(propertyName)
      ? propertyName.text
      : null;
    if (key !== name) continue;
    if (ts.isPropertyAssignment(property)) return property.initializer;
    if (ts.isMethodDeclaration(property)) return property;
    if (ts.isShorthandPropertyAssignment(property)) return property.name;
  }
  return null;
}

/** True for a dynamic `import(...)` call expression. */
function isDynamicImportCall(node) {
  return ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

/**
 * Unwraps `await`, parentheses, `as`, and `!` wrappers around an expression, so
 * `await import(x)` and `(await import(x)) as M` both reduce to the `import(x)` call.
 */
function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    (ts.isAwaitExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * Describes what a binding name pulls out of a dynamic import.
 * `{ a, b: c }` → the imported symbols `a` and `b`; a plain identifier → a namespace
 * binding with no named symbols.
 */
function describeBindingName(name) {
  if (ts.isObjectBindingPattern(name)) {
    const symbols = [];
    const bindings = [];
    let rest = false;
    for (const element of name.elements) {
      if (element.dotDotDotToken) {
        rest = true;
        continue;
      }
      const imported = element.propertyName ?? element.name;
      if (!ts.isIdentifier(imported) && !ts.isStringLiteralLike(imported)) continue;
      const importedName = imported.text;
      const local = ts.isIdentifier(element.name) ? element.name.text : importedName;
      symbols.push(importedName);
      bindings.push({ imported: importedName, local });
    }
    return { binding: rest ? "object-rest" : "object", symbols, bindings };
  }
  if (ts.isIdentifier(name)) {
    return { binding: "namespace", symbols: [], bindings: [], namespace: name.text };
  }
  return { binding: "other", symbols: [], bindings: [] };
}

const NO_BINDING = Object.freeze({ binding: "none", symbols: [], bindings: [] });

/**
 * Collects every dynamic `import()` call inside `node`, together with the symbols the
 * surrounding code destructures from it.
 *
 * The scan is top-down rather than parent-climbing: `ts.Program` source files do not carry
 * parent pointers, so each consumer (`const { a } = await import(x)`, `(await import(x)).a`)
 * is recorded on the way down and read back when the import call itself is visited.
 */
function collectDynamicImports({ node, sourceFile, relativeFile, root, aliases, owner }) {
  const results = [];
  if (!node) return results;

  /** @type {Map<ts.Node, object>} */
  const bindingByImportCall = new Map();

  const noteConsumer = (current) => {
    if (ts.isVariableDeclaration(current) && current.initializer) {
      const target = unwrapExpression(current.initializer);
      if (isDynamicImportCall(target)) {
        bindingByImportCall.set(target, describeBindingName(current.name));
      }
      return;
    }
    if (ts.isPropertyAccessExpression(current) && ts.isIdentifier(current.name)) {
      const target = unwrapExpression(current.expression);
      if (isDynamicImportCall(target)) {
        const importedName = current.name.text;
        bindingByImportCall.set(target, {
          binding: "property",
          symbols: [importedName],
          bindings: [{ imported: importedName, local: importedName }],
        });
      }
      return;
    }
    if (ts.isElementAccessExpression(current)) {
      const target = unwrapExpression(current.expression);
      const argument = current.argumentExpression;
      if (isDynamicImportCall(target) && argument && ts.isStringLiteralLike(argument)) {
        const importedName = argument.text;
        bindingByImportCall.set(target, {
          binding: "property",
          symbols: [importedName],
          bindings: [{ imported: importedName, local: importedName }],
        });
      }
    }
  };

  const visit = (current) => {
    noteConsumer(current);

    if (isDynamicImportCall(current)) {
      const argument = current.arguments[0];
      const line = lineOf(current, sourceFile);

      if (!argument || !ts.isStringLiteralLike(argument)) {
        throw new EnumerationError(
          "UNRESOLVED_IMPORT",
          `enumerate-server-functions: dynamic import in ${owner} (${relativeFile}:${line}) ` +
          `does not use a string-literal specifier: ${argument ? textOf(argument, sourceFile) : "<no argument>"}.`,
          { fromFile: relativeFile, owner, line, specifier: null },
        );
      }

      const specifier = argument.text;
      let resolution;
      try {
        resolution = resolveModuleSpecifier({ specifier, fromFile: relativeFile, root, aliases });
      } catch (error) {
        if (error instanceof EnumerationError && error.code === "UNRESOLVED_IMPORT") {
          throw new EnumerationError(
            "UNRESOLVED_IMPORT",
            `enumerate-server-functions: cannot resolve module specifier "${specifier}" ` +
            `dynamically imported by ${owner} (${relativeFile}:${line}).`,
            { specifier, fromFile: relativeFile, owner, line },
          );
        }
        throw error;
      }

      results.push({
        specifier,
        resolvedFile: resolution.resolvedFile,
        external: resolution.external,
        line,
        ...(bindingByImportCall.get(current) ?? NO_BINDING),
      });
    }
    ts.forEachChild(current, visit);
  };

  visit(node);
  return results;
}

/** Describes an exported `createServerFn`/`authedServerFn` declaration, or `null`. */
function describeServerFunction({ declaration, symbol, sourceFile, relativeFile, root, aliases }) {
  const chain = decomposeChain(declaration.initializer);
  if (!chain.rootName || !SERVER_FN_FACTORIES.includes(chain.rootName)) return null;

  const middleware = [];
  let validator = null;
  let handler = null;

  for (const step of chain.steps) {
    if (step.name === "middleware") {
      const argument = step.call.arguments[0];
      if (argument && ts.isArrayLiteralExpression(argument)) {
        for (const element of argument.elements) {
          middleware.push(textOf(element, sourceFile));
        }
      } else if (argument) {
        middleware.push(textOf(argument, sourceFile));
      }
      continue;
    }
    if (VALIDATOR_STEP_NAMES.includes(step.name) && validator === null) {
      const argument = step.call.arguments[0];
      validator = {
        step: step.name,
        line: lineOf(step.call, sourceFile),
        text: argument ? textOf(argument, sourceFile) : null,
      };
      continue;
    }
    if (step.name === "handler" && handler === null) {
      handler = step.call.arguments[0] ?? null;
    }
  }

  const composesAuthMiddleware =
    chain.rootName === AUTHED_SERVER_FN_FACTORY ||
    middleware.some(
      (entry) => entry === AUTH_MIDDLEWARE_NAME || entry.endsWith(`.${AUTH_MIDDLEWARE_NAME}`),
    );

  const methodOption = objectProperty(chain.rootCall.arguments[0], "method");
  const httpMethod =
    methodOption && ts.isStringLiteralLike(methodOption) ? methodOption.text : null;

  return {
    kind: "serverFn",
    symbol,
    exportedSymbol: symbol,
    file: relativeFile,
    line: lineOf(declaration, sourceFile),
    factory: chain.rootName,
    httpMethod,
    routePath: null,
    middleware,
    composesAuthMiddleware,
    validator,
    hasHandler: handler !== null,
    dynamicImports: collectDynamicImports({
      node: handler,
      sourceFile,
      relativeFile,
      root,
      aliases,
      owner: symbol,
    }),
  };
}

/** Describes the exported route handlers of a `createFileRoute` declaration, or `null`. */
function describeApiRouteHandlers({ declaration, symbol, sourceFile, relativeFile, root, aliases }) {
  if (!relativeFile.startsWith(API_ROUTES_PREFIX)) return null;

  const initializer = declaration.initializer;
  if (!ts.isCallExpression(initializer)) return null;
  const factoryCall = initializer.expression;
  if (!ts.isCallExpression(factoryCall)) return null;
  if (!isIdentifierNamed(factoryCall.expression, "createFileRoute")) return null;

  const routeArgument = factoryCall.arguments[0];
  const routePath =
    routeArgument && ts.isStringLiteralLike(routeArgument) ? routeArgument.text : null;

  const options = initializer.arguments[0];
  const handlers = objectProperty(objectProperty(options, "server"), "handlers");
  if (!handlers) return null;

  const base = {
    kind: "routeHandler",
    exportedSymbol: symbol,
    file: relativeFile,
    line: lineOf(declaration, sourceFile),
    factory: "createFileRoute",
    routePath,
    middleware: [],
    composesAuthMiddleware: false,
    validator: null,
  };

  if (!ts.isObjectLiteralExpression(handlers)) {
    // Handlers supplied indirectly (identifier, spread, call). Report the declaration
    // rather than dropping it, so an unauthorized endpoint cannot hide behind indirection.
    return [
      {
        ...base,
        symbol,
        httpMethod: null,
        handlerShape: "indirect",
        hasHandler: true,
        dynamicImports: collectDynamicImports({
          node: initializer,
          sourceFile,
          relativeFile,
          root,
          aliases,
          owner: `${symbol} (${relativeFile})`,
        }),
      },
    ];
  }

  const records = [];
  for (const property of handlers.properties) {
    const name = property.name;
    if (!name) continue;
    const methodName = ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null;
    if (!methodName) continue;

    let handlerNode = null;
    if (ts.isPropertyAssignment(property)) handlerNode = property.initializer;
    else if (ts.isMethodDeclaration(property)) handlerNode = property;
    else if (ts.isShorthandPropertyAssignment(property)) handlerNode = property.name;
    if (!handlerNode) continue;

    const httpMethod = methodName.toUpperCase();
    records.push({
      ...base,
      symbol: `${symbol}.${httpMethod}`,
      httpMethod,
      handlerShape: "inline",
      line: lineOf(property, sourceFile),
      hasHandler: true,
      dynamicImports: collectDynamicImports({
        node: handlerNode,
        sourceFile,
        relativeFile,
        root,
        aliases,
        owner: `${symbol}.${httpMethod} (${relativeFile})`,
      }),
    });
  }

  return records.length > 0 ? records : null;
}

/** Scans one parsed source file for `Server_Function` declarations. */
function scanSourceFile({ sourceFile, relativeFile, root, aliases }) {
  const exportListNames = collectExportListNames(sourceFile);
  const records = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const statementIsExported = hasExportModifier(statement);

    for (const declaration of statement.declarationList.declarations) {
      if (!declaration.initializer) continue;
      if (!ts.isIdentifier(declaration.name)) continue;
      const symbol = declaration.name.text;
      if (!statementIsExported && !exportListNames.has(symbol)) continue;

      const serverFunction = describeServerFunction({
        declaration,
        symbol,
        sourceFile,
        relativeFile,
        root,
        aliases,
      });
      if (serverFunction) {
        records.push(serverFunction);
        continue;
      }

      const routeHandlers = describeApiRouteHandlers({
        declaration,
        symbol,
        sourceFile,
        relativeFile,
        root,
        aliases,
      });
      if (routeHandlers) records.push(...routeHandlers);
    }
  }

  return records;
}

/**
 * Runs `Server_Function_Enumeration` over `<root>/src`.
 *
 * @param {object} [input]
 * @param {string} [input.root] - Absolute repository root. Defaults to this script's repo.
 * @param {boolean} [input.allowEmpty] - When true, an empty enumeration is returned instead
 *   of raising. Only for tests that assert on the empty shape; the `Test_Suite` and the CLI
 *   leave it false so Requirement 6.13 holds.
 * @returns {{ root: string, sourceFiles: string[], declarations: object[] }}
 * @throws {EnumerationError}
 */
export function enumerateServerFunctions({ root = defaultRoot(), allowEmpty = false } = {}) {
  const absoluteRoot = path.resolve(root);
  const sourceFiles = listSourceFiles(absoluteRoot);
  const aliases = loadPathAliases(absoluteRoot);

  const program = ts.createProgram(
    sourceFiles.map((relativeFile) => path.join(absoluteRoot, relativeFile)),
    {
      noResolve: true,
      noLib: true,
      allowJs: false,
      noEmit: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      types: [],
    },
  );

  const byKey = new Map();
  for (const sourceFile of program.getSourceFiles()) {
    byKey.set(programKey(sourceFile.fileName), sourceFile);
  }

  const declarations = [];
  for (const relativeFile of sourceFiles) {
    const sourceFile = byKey.get(programKey(path.join(absoluteRoot, relativeFile)));
    if (!sourceFile) {
      throw new EnumerationError(
        "PARSE_FAILURE",
        `enumerate-server-functions: could not read or parse ${relativeFile}.`,
        { file: relativeFile },
      );
    }

    const diagnostics = program.getSyntacticDiagnostics(sourceFile);
    if (diagnostics.length > 0) {
      const [first] = diagnostics;
      const message = ts.flattenDiagnosticMessageText(first.messageText, " ");
      const position =
        typeof first.start === "number"
          ? sourceFile.getLineAndCharacterOfPosition(first.start)
          : { line: 0, character: 0 };
      throw new EnumerationError(
        "PARSE_FAILURE",
        `enumerate-server-functions: cannot parse ${relativeFile}:${position.line + 1}:` +
        `${position.character + 1}: ${message}`,
        {
          file: relativeFile,
          line: position.line + 1,
          column: position.character + 1,
          diagnostic: message,
        },
      );
    }

    declarations.push(...scanSourceFile({ sourceFile, relativeFile, root: absoluteRoot, aliases }));
  }

  declarations.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
  });

  if (declarations.length === 0 && !allowEmpty) {
    throw new EnumerationError(
      "EMPTY_ENUMERATION",
      "enumerate-server-functions: enumeration matched no Server_Function declarations " +
      `across ${sourceFiles.length} scanned file(s) under ${SOURCE_ROOT}/ in ${toPosix(absoluteRoot)}; ` +
      "refusing to report a pass from a scan that found nothing.",
      { root: toPosix(absoluteRoot), scannedFileCount: sourceFiles.length },
    );
  }

  return { root: toPosix(absoluteRoot), sourceFiles, declarations };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Parses the CLI arguments. */
export function parseCliArgs(argv) {
  const options = { root: undefined, pretty: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") {
      options.root = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--root=")) {
      options.root = argument.slice("--root=".length);
      continue;
    }
    if (argument === "--pretty") options.pretty = true;
  }
  return options;
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
  const { root, pretty } = parseCliArgs(process.argv.slice(2));
  try {
    const result = enumerateServerFunctions({ root: root ?? defaultRoot() });
    process.stdout.write(`${JSON.stringify(result, null, pretty ? 2 : 0)}\n`);
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    if (error instanceof EnumerationError) {
      process.stderr.write(`enumerate-server-functions: failure code ${error.code}.\n`);
    }
    process.exit(EXIT_ENUMERATION_FAILURE);
  }
}
