/**
 * Example tests for two of the five typecheck fixes (task 3.8).
 *
 * Feature: admin-quality-gates-and-shared-contracts
 *
 * Requirement 3.9 — a component that renders a design-system `Button` supplies a
 * `variant` declared in the design-system `ButtonVariant` union. The defect this
 * pins was `variant="secondary"` in `src/admin/DerivationInspector.tsx`.
 *
 * Requirement 3.8 — every audit construction passes a `targetType` from the
 * declared `AuditLogEntry` target-type union and a non-empty `targetId`. The
 * defect this pins was `targetType: "fact_bank"` in the `bulkImportFacts` server
 * function, which is not a member of that union. Its per-fact audit now commits
 * in the import transaction rather than through a later `logAdminAction` call.
 *
 * Why the variant check is static, not a render
 * ---------------------------------------------
 * `jsdom` is not installed and the suite runs in the `node` environment, so
 * there is no DOM to render into. Adding `jsdom` + `@testing-library/react` to
 * assert one string attribute would be a heavyweight dependency for a property
 * that is purely syntactic: the `variant` value is a literal in the source, and
 * a render would only observe the same literal travelling into `class="…"`.
 *
 * So the check parses the sources with the TypeScript AST (`typescript` is
 * already a devDependency) and is deliberately *generalized*: it discovers every
 * design-system component that declares a `<Name>Variant` union (today `Button`
 * and `Card`), then checks every JSX usage of those components anywhere under
 * `src/`. A future invalid variant on any of them fails here, not just the one
 * line task 3.1 fixed.
 *
 * Dynamic `variant={someVariable}` expressions are the compiler's job
 * (Typecheck_Step, Requirement 3.1) — they are counted and reported, not
 * asserted on, because a scan cannot evaluate them. Every usage in the
 * repository today resolves statically.
 *
 * How the `bulkImportFacts` assertion runs the real code
 * ------------------------------------------------------
 * The handler is the genuine one from `src/lib/admin/content.functions.ts`,
 * reached through a recording `createServerFn` (the pattern established in
 * `test/server-functions.property.test.ts`), and it runs against the in-memory
 * Firestore and audit doubles from `test/setup.ts`. Its real input validator
 * parses the payload first, `importFactsBatch` really writes each fact and its
 * prepared audit in one transaction, and the assertions read those audit docs.
 * Nothing reaches a credential, an emulator, or the network.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { blockedNetworkAttempts, firestoreDouble, type AdminUser } from "./setup";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = path.join(REPO_ROOT, "src");

// ---------------------------------------------------------------------------
// Shared AST helpers
// ---------------------------------------------------------------------------

/** Repo-relative, forward-slashed path, matching how the enumeration reports files. */
function repoRelative(absoluteFile: string): string {
  return path.relative(REPO_ROOT, absoluteFile).split(path.sep).join("/");
}

function parseSourceFile(absoluteFile: string): ts.SourceFile {
  return ts.createSourceFile(
    absoluteFile,
    readFileSync(absoluteFile, "utf8"),
    ts.ScriptTarget.ESNext,
    true,
    absoluteFile.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** Every `.ts`/`.tsx` file under `src/`, sorted, repo-relative. */
function sourceFilesUnderSrc(): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (/\.tsx?$/.test(entry.name)) found.push(repoRelative(absolute));
    }
  };
  walk(SRC_ROOT);
  return found.sort();
}

const SRC_FILES = sourceFilesUnderSrc();

/** String-literal members of a union type node, or null if it is not such a union. */
function stringLiteralUnionMembers(node: ts.TypeNode | undefined): string[] | null {
  if (!node) return null;
  const members: string[] = [];
  const collect = (type: ts.TypeNode): boolean => {
    if (ts.isParenthesizedTypeNode(type)) return collect(type.type);
    if (ts.isUnionTypeNode(type)) return type.types.every((member) => collect(member));
    if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) {
      members.push(type.literal.text);
      return true;
    }
    return false;
  };
  return collect(node) ? members : null;
}

// ---------------------------------------------------------------------------
// Requirement 3.9 — declared design-system variant unions
// ---------------------------------------------------------------------------

interface VariantComponent {
  /** Component name as used in JSX, e.g. `Button`. */
  component: string;
  /** Declaring file, repo-relative. */
  file: string;
  /** Name of the union type alias, e.g. `ButtonVariant`. */
  unionName: string;
  /** Declared members, in declaration order. */
  variants: readonly string[];
}

/**
 * Discovers every design-system component that declares its own `variant` union:
 * a `src/design-system/components/<Name>.tsx` exporting both a `<Name>Variant`
 * string-literal union and a props member `variant?: <Name>Variant`.
 */
function discoverVariantComponents(): VariantComponent[] {
  const componentsDir = path.join(SRC_ROOT, "design-system", "components");
  const discovered: VariantComponent[] = [];

  for (const entry of readdirSync(componentsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".tsx")) continue;
    const component = entry.name.replace(/\.tsx$/, "");
    const unionName = `${component}Variant`;
    const absolute = path.join(componentsDir, entry.name);
    const sourceFile = parseSourceFile(absolute);

    let variants: string[] | null = null;
    let propUsesUnion = false;

    const visit = (node: ts.Node): void => {
      if (ts.isTypeAliasDeclaration(node) && node.name.text === unionName) {
        variants = stringLiteralUnionMembers(node.type);
      }
      if (
        ts.isPropertySignature(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "variant" &&
        node.type !== undefined &&
        ts.isTypeReferenceNode(node.type) &&
        ts.isIdentifier(node.type.typeName) &&
        node.type.typeName.text === unionName
      ) {
        propUsesUnion = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    if (variants !== null && propUsesUnion) {
      discovered.push({
        component,
        file: repoRelative(absolute),
        unionName,
        variants,
      });
    }
  }

  return discovered.sort((left, right) => left.component.localeCompare(right.component));
}

const VARIANT_COMPONENTS = discoverVariantComponents();

const VARIANT_COMPONENTS_BY_NAME = new Map(
  VARIANT_COMPONENTS.map((entry) => [entry.component, entry]),
);

/**
 * Import specifiers a design-system component may legitimately arrive through.
 * `@/index` is the package barrel that re-exports the design system; the direct
 * module path is accepted too. Anything else is a different component that
 * happens to share the name, and is reported rather than checked.
 */
function importSpecifierIsDesignSystem(specifier: string, component: string): boolean {
  if (specifier === "@/index" || specifier === "@/index.ts") return true;
  return new RegExp(`design-system/components/${component}(\\.tsx?)?$`).test(specifier);
}

interface VariantUsage {
  component: string;
  file: string;
  line: number;
  /** Literal values the attribute can evaluate to. */
  values: readonly string[];
}

interface UnresolvedVariantUsage {
  component: string;
  file: string;
  line: number;
  expression: string;
}

interface ForeignComponentUsage {
  component: string;
  file: string;
  line: number;
  importedFrom: string | null;
}

/**
 * Literal values an attribute expression can evaluate to, or `null` when the
 * expression is not statically resolvable.
 */
function resolveVariantLiterals(expression: ts.Expression): string[] | null {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return [expression.text];
  }
  if (ts.isParenthesizedExpression(expression)) return resolveVariantLiterals(expression.expression);
  if (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
    return resolveVariantLiterals(expression.expression);
  }
  if (ts.isConditionalExpression(expression)) {
    const whenTrue = resolveVariantLiterals(expression.whenTrue);
    const whenFalse = resolveVariantLiterals(expression.whenFalse);
    if (whenTrue === null || whenFalse === null) return null;
    return [...whenTrue, ...whenFalse];
  }
  if (
    ts.isBinaryExpression(expression) &&
    (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    const left = resolveVariantLiterals(expression.left);
    const right = resolveVariantLiterals(expression.right);
    if (left === null || right === null) return null;
    return [...left, ...right];
  }
  return null;
}

interface VariantScan {
  usages: VariantUsage[];
  unresolved: UnresolvedVariantUsage[];
  foreign: ForeignComponentUsage[];
}

/** Scans one already-parsed source file for `variant` attributes on the discovered components. */
function scanSourceFileForVariants(file: string, sourceFile: ts.SourceFile, into: VariantScan): void {
  // Local name → import specifier, for provenance checks.
  const importedFrom = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) importedFrom.set(element.name.text, specifier);
    }
    const defaultName = statement.importClause?.name;
    if (defaultName) importedFrom.set(defaultName.text, specifier);
  }

  const visit = (node: ts.Node): void => {
    const isElement = ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node);
    if (isElement && ts.isIdentifier(node.tagName)) {
      const component = node.tagName.text;
      if (VARIANT_COMPONENTS_BY_NAME.has(component)) {
        const specifier = importedFrom.get(component) ?? null;
        const line = lineOf(sourceFile, node);

        if (specifier === null || !importSpecifierIsDesignSystem(specifier, component)) {
          into.foreign.push({ component, file, line, importedFrom: specifier });
        } else {
          const attribute = node.attributes.properties.find(
            (property): property is ts.JsxAttribute =>
              ts.isJsxAttribute(property) &&
              ts.isIdentifier(property.name) &&
              property.name.text === "variant",
          );

          // No attribute at all is fine: the component defaults it.
          if (attribute?.initializer) {
            const initializer = attribute.initializer;
            const expression = ts.isJsxExpression(initializer)
              ? (initializer.expression ?? null)
              : initializer;

            const values =
              expression === null
                ? null
                : ts.isStringLiteral(expression)
                  ? [expression.text]
                  : resolveVariantLiterals(expression);

            if (values === null) {
              into.unresolved.push({
                component,
                file,
                line,
                expression: (expression ?? initializer).getText(sourceFile),
              });
            } else {
              into.usages.push({ component, file, line, values });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

/** Every `variant` attribute on a variant-declaring design-system component under `src/`. */
function scanVariantUsages(files: readonly string[]): VariantScan {
  const scan: VariantScan = { usages: [], unresolved: [], foreign: [] };
  for (const file of files) {
    scanSourceFileForVariants(file, parseSourceFile(path.join(REPO_ROOT, file)), scan);
  }
  return scan;
}

/** Undeclared variant values in a scan, formatted as diagnostics. */
function undeclaredVariantValues(usages: readonly VariantUsage[]): string[] {
  return usages.flatMap((usage) => {
    const declared = VARIANT_COMPONENTS_BY_NAME.get(usage.component);
    const allowed = new Set(declared?.variants ?? []);
    return usage.values
      .filter((value) => !allowed.has(value))
      .map(
        (value) =>
          `${usage.file}:${usage.line} <${usage.component} variant="${value}"> is not a member ` +
          `of ${declared?.unionName ?? `${usage.component}Variant`} ` +
          `(declared in ${declared?.file ?? "?"}: ${[...allowed].join(" | ")})`,
      );
  });
}

const VARIANT_SCAN = scanVariantUsages(SRC_FILES);

describe("Requirement 3.9: components render declared design-system Button variants", () => {
  it("discovers the ButtonVariant union from the design-system source", () => {
    const button = VARIANT_COMPONENTS_BY_NAME.get("Button");
    expect(button, "no ButtonVariant union found under src/design-system/components").toBeDefined();
    expect(button?.file).toBe("src/design-system/components/Button.tsx");
    expect(button?.unionName).toBe("ButtonVariant");
    // Non-vacuity: the union has members, so membership is a real constraint.
    expect(button?.variants.length).toBeGreaterThan(1);
    expect(new Set(button?.variants)).toEqual(new Set(button?.variants ?? []));
  });

  it("supplies a declared variant at every Button usage in DerivationInspector.tsx", () => {
    const allowed = new Set(VARIANT_COMPONENTS_BY_NAME.get("Button")?.variants ?? []);
    const usages = VARIANT_SCAN.usages.filter(
      (usage) => usage.file === "src/admin/DerivationInspector.tsx" && usage.component === "Button",
    );

    // The file task 3.1 fixed: three Button variant attributes (two sub-tab
    // toggles and one row action).
    expect(usages.length).toBeGreaterThanOrEqual(3);

    expect(undeclaredVariantValues(usages)).toEqual([]);
    expect(allowed.size).toBeGreaterThan(1);

    // The specific regression: the invalid literal is gone from the file, and
    // the sub-tab toggles resolve to the declared pair task 3.1 chose.
    const values = new Set(usages.flatMap((usage) => usage.values));
    expect(values.has("secondary")).toBe(false);
    expect(values.has("primary")).toBe(true);
    expect(values.has("ghost")).toBe(true);

    const toggleUsages = usages.filter((usage) => usage.values.length === 2);
    expect(toggleUsages.length).toBeGreaterThanOrEqual(2);
    for (const toggle of toggleUsages) {
      expect(new Set(toggle.values), `${toggle.file}:${toggle.line}`).toEqual(
        new Set(["primary", "ghost"]),
      );
    }
  });

  it("supplies a declared variant at every design-system component usage under src/", () => {
    // Generalized: every component that declares its own variant union, every
    // usage anywhere under src/ — so a future invalid variant fails here too.
    expect(VARIANT_COMPONENTS.length).toBeGreaterThan(0);
    expect(VARIANT_SCAN.usages.length).toBeGreaterThan(0);

    expect(undeclaredVariantValues(VARIANT_SCAN.usages)).toEqual([]);

    // Every Button in the repository is checked, not just the fixed file.
    const buttonFiles = new Set(
      VARIANT_SCAN.usages.filter((usage) => usage.component === "Button").map((usage) => usage.file),
    );
    expect(buttonFiles.size).toBeGreaterThan(1);
    expect(buttonFiles.has("src/admin/DerivationInspector.tsx")).toBe(true);

    // Documented rather than asserted away: a component sharing a design-system
    // name but imported from somewhere else is out of scope for this scan.
    expect(VARIANT_SCAN.foreign).toEqual([]);
  });

  it("flags an undeclared variant, so the passing scan above is not vacuous", () => {
    // Negative control: the exact defect task 3.1 fixed, replayed against the
    // same scanner over a synthetic source (nothing under `src/` is touched).
    const synthetic = ts.createSourceFile(
      "synthetic/DerivationInspectorBefore.tsx",
      [
        'import { Button } from "@/index";',
        "export function Before({ subTab }: { subTab: string }) {",
        "  return (",
        "    <>",
        '      <Button variant="secondary">Probe</Button>',
        '      <Button variant={subTab === "probe" ? "primary" : "nonsense"}>Toggle</Button>',
        '      <Button variant="ghost">Fine</Button>',
        "      <Button>Defaulted</Button>",
        "    </>",
        "  );",
        "}",
      ].join("\n"),
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TSX,
    );

    const scan: VariantScan = { usages: [], unresolved: [], foreign: [] };
    scanSourceFileForVariants("synthetic/DerivationInspectorBefore.tsx", synthetic, scan);

    // Three attributes seen; the un-attributed Button is correctly ignored.
    expect(scan.usages).toHaveLength(3);
    expect(scan.foreign).toEqual([]);
    expect(scan.unresolved).toEqual([]);

    const failures = undeclaredVariantValues(scan.usages);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain('variant="secondary"');
    expect(failures[0]).toContain("ButtonVariant");
    expect(failures[1]).toContain('variant="nonsense"');
  });

  it("resolves every variant attribute in the repository statically today", () => {
    // Not a requirement, a scope statement: a `variant={someVariable}` usage
    // cannot be evaluated by a scan and is left to Typecheck_Step
    // (Requirement 3.1). There are none right now; if one appears, this test
    // names it so the coverage gap is visible rather than silent.
    expect(
      VARIANT_SCAN.unresolved.map(
        (usage) => `${usage.file}:${usage.line} <${usage.component} variant={${usage.expression}}>`,
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Requirement 3.8 — bulkImportFacts audit targetType
// ---------------------------------------------------------------------------

/** Declared `AuditLogEntry["targetType"]` members, read from the source of truth. */
function declaredAuditTargetTypes(): string[] {
  const absolute = path.join(REPO_ROOT, "src/lib/firebase/audit.server.ts");
  const sourceFile = parseSourceFile(absolute);
  let members: string[] | null = null;

  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === "AuditLogEntry") {
      for (const member of node.members) {
        if (
          ts.isPropertySignature(member) &&
          ts.isIdentifier(member.name) &&
          member.name.text === "targetType"
        ) {
          members = stringLiteralUnionMembers(member.type);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (members === null) {
    throw new Error(
      `could not read AuditLogEntry["targetType"] string-literal union from ${repoRelative(absolute)}`,
    );
  }
  return members;
}

const AUDIT_TARGET_TYPES = declaredAuditTargetTypes();

/** The `targetType` literal passed to `buildAuditEntry` inside one exported declaration. */
function auditTargetTypeLiteralsIn(file: string, exportedSymbol: string): string[] {
  const sourceFile = parseSourceFile(path.join(REPO_ROOT, file));
  const literals: string[] = [];

  const collectFromCall = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const calleeName = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      if (calleeName === "buildAuditEntry") {
        for (const argument of node.arguments) {
          if (!ts.isObjectLiteralExpression(argument)) continue;
          for (const property of argument.properties) {
            if (
              ts.isPropertyAssignment(property) &&
              ((ts.isIdentifier(property.name) && property.name.text === "targetType") ||
                (ts.isStringLiteral(property.name) && property.name.text === "targetType")) &&
              ts.isStringLiteral(property.initializer)
            ) {
              literals.push(property.initializer.text);
            }
          }
        }
      }
    }
    ts.forEachChild(node, collectFromCall);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === exportedSymbol) {
          collectFromCall(declaration);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return literals;
}

// --- Recording `createServerFn`, so the real handler can be invoked ---------

/** What the recording chain captured for one server-function declaration. */
interface CapturedServerFn {
  validator: ((data: unknown) => unknown) | null;
  handler: ((input: { data: never; context: { user: AdminUser } }) => Promise<unknown>) | null;
}

const harness = vi.hoisted(() => {
  interface ChainState {
    validator: unknown;
  }

  const registry = new Map<object, { validator: unknown; handler: unknown }>();

  const makeChain = (state: ChainState): Record<string, unknown> => ({
    middleware: () => makeChain(state),
    validator: (fn: unknown) => makeChain({ validator: fn }),
    inputValidator: (fn: unknown) => makeChain({ validator: fn }),
    handler: (fn: unknown) => {
      const token = { __recordedServerFn: true };
      registry.set(token, { validator: state.validator, handler: fn });
      return token;
    },
  });

  const createServerFn = () => makeChain({ validator: null });
  const authMiddleware = { __stubAuthMiddleware: true, options: {} };
  const authedServerFn = () => makeChain({ validator: null });

  return { registry, createServerFn, authMiddleware, authedServerFn };
});

vi.mock("@tanstack/react-start", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createServerFn: harness.createServerFn };
});

// Keeps the import graph of `content.functions.ts` off the Firebase web SDK.
vi.mock("@/lib/admin/middleware", () => ({
  authMiddleware: harness.authMiddleware,
  authedServerFn: harness.authedServerFn,
}));

// The real `importFactsBatch` runs, writing each fact and its prepared audit to
// the in-memory Firestore double.
vi.mock("@/lib/firebase/firestore.server", async () => {
  const { firestoreDouble: double } = await import("./setup");
  return double().module;
});
vi.mock("@/lib/firebase/audit.server", async () => {
  const { auditDouble: double } = await import("./setup");
  return double().module;
});

const ADMIN: AdminUser = {
  uid: "admin-uid-1",
  email: "ops@snaptapp.us",
  name: "Ops Operator",
  isClaimAdmin: true,
};

/** Pairs an exported server function with the validator and handler it declared. */
async function captureServerFn(exportedSymbol: string): Promise<CapturedServerFn> {
  const moduleNamespace = (await import("@/lib/admin/content.functions")) as Record<
    string,
    unknown
  >;
  const exported = moduleNamespace[exportedSymbol];
  const record =
    typeof exported === "object" && exported !== null
      ? harness.registry.get(exported as object)
      : undefined;
  if (!record) throw new Error(`no recorded server function for ${exportedSymbol}`);
  return record as CapturedServerFn;
}

interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

function importAuditEntries() {
  return firestoreDouble()
    .documents()
    .filter((doc) => doc.path.startsWith("admin_audit_logs/"))
    .map((doc) => ({
      action: String(doc.data["action"] ?? ""),
      targetType: String(doc.data["targetType"] ?? ""),
      targetId: String(doc.data["targetId"] ?? ""),
      adminUid: String(doc.data["adminUid"] ?? ""),
    }));
}

/** Runs the real validator then the real handler, in TanStack's order. */
async function runBulkImport(payload: unknown): Promise<ImportResult> {
  const captured = await captureServerFn("bulkImportFacts");
  expect(captured.validator, "bulkImportFacts declares an input validator").toBeTypeOf("function");
  expect(captured.handler, "bulkImportFacts declares a handler").toBeTypeOf("function");

  const validated = captured.validator?.(payload);
  const result = await captured.handler?.({
    data: validated as never,
    context: { user: ADMIN },
  });
  return result as ImportResult;
}

describe("Requirement 3.8: bulkImportFacts logs a declared audit targetType", () => {
  it("reads the declared AuditLogEntry target-type union from audit.server.ts", () => {
    // Non-vacuity, and the reason the assertions below are not hardcoded: the
    // union is the source of truth and "fact_bank" was never in it.
    expect(AUDIT_TARGET_TYPES.length).toBeGreaterThan(1);
    expect(AUDIT_TARGET_TYPES).toContain("fact");
    expect(AUDIT_TARGET_TYPES).not.toContain("fact_bank");
  });

  it("records one audit per imported fact with a union-member targetType and non-empty targetId", async () => {
    const result = await runBulkImport({
      facts: [
        {
          subject: "Giraffe",
          angle: "neck vertebrae",
          true_number: 7,
          unit: "vertebrae",
          claim_template: "A giraffe neck has {n} vertebrae",
        },
        {
          subject: "Octopus",
          angle: "hearts",
          true_number: 3,
          unit: "hearts",
          claim_template: "An octopus has {n} hearts",
        },
      ],
    });

    // The privileged path really ran: two fact_bank documents were written.
    expect(result.imported).toBe(2);
    expect(result.errors).toEqual([]);
    expect(firestoreDouble().writeCount()).toBe(4);

    // Requirement 3.8 for this call site: one atomic audit per imported fact.
    const entries = importAuditEntries();
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.action).toBe("fact.bulk_import");
      expect(AUDIT_TARGET_TYPES).toContain(entry.targetType);
      expect(entry.targetType).toBe("fact");
      expect(entry.targetType).not.toBe("fact_bank");
      expect(entry.targetId.length).toBeGreaterThan(0);
      expect(entry.targetId.trim()).toBe(entry.targetId);
      expect(entry.adminUid).toBe(ADMIN.uid);
    }

    // No credential, emulator, or deployed service was reached.
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("keeps targetType a union member and targetId non-empty on a single-fact import", async () => {
    const result = await runBulkImport({
      facts: [
        {
          subject: "Sahara",
          angle: "annual rainfall",
          true_number: 25,
          unit: "mm",
          claim_template: "The Sahara gets {n} mm of rain a year",
        },
      ],
    });

    expect(result.imported).toBe(1);
    const entries = importAuditEntries();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(AUDIT_TARGET_TYPES).toContain(entry.targetType);
    expect(entry.targetId.length).toBeGreaterThan(0);
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("passes a declared targetType literal at the bulkImportFacts call site in source", async () => {
    // The static counterpart: the literal in the source, independent of what the
    // handler happened to do at run time. (Property 18, task 6.5, generalizes
    // this across every call site.)
    const literals = auditTargetTypeLiteralsIn(
      "src/lib/admin/content.functions.ts",
      "bulkImportFacts",
    );
    expect(literals.length).toBeGreaterThan(0);
    expect(literals).not.toContain("fact_bank");
    for (const literal of literals) expect(AUDIT_TARGET_TYPES).toContain(literal);
  });
});
