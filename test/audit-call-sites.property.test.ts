/**
 * Feature: admin-quality-gates-and-shared-contracts
 *
 * Property 18: Every `logAdminAction` call site supplies a valid target
 *   *For all* `logAdminAction` call sites in Admin_Repository, the `targetType`
 *   argument is a member of the declared `AuditLogEntry` target-type union and
 *   the `targetId` argument is a non-empty string.
 *   Validates: Requirement 3.8
 *
 * Why this is a source sweep
 * --------------------------
 * Requirement 3.8 is a `FOR ALL` over *call sites*, not over invocations: the
 * defect it closes was a literal (`targetType: "fact_bank"`) that no test
 * exercised. Enumerating the call sites from the source therefore catches a new
 * bad one the moment it is written, whether or not anyone writes a test for the
 * endpoint that contains it. `typescript` is already a devDependency, so the
 * enumeration is an AST walk over every `.ts`/`.tsx` under `src/` — the same
 * approach `test/type-fix-examples.test.ts` uses for design-system variants,
 * generalized here from one declaration to every call site in the repository.
 *
 * The `targetType` half is fully static: every call site passes a string
 * literal, so membership of the union (also read from the source, never
 * transcribed) is decided outright. A non-literal `targetType` is reported as
 * unresolved rather than silently passed, and the list of unresolved ones is
 * asserted empty — if one ever appears, the assertion names it and the compiler
 * (Typecheck_Step, Requirement 3.1) is the backstop for that case.
 *
 * The `targetId` half is partly static. Each expression is classified:
 *
 *   - **non-empty by construction** — a non-empty string literal, a template
 *     with at least one non-empty literal span, a concatenation with such a
 *     literal, or a local `const` resolving to one. Proven here, no run-time
 *     evidence needed.
 *   - **dynamic** — a property access, call, or fallback chain whose value a
 *     scan cannot evaluate. Every one of these is registered below with how it
 *     *is* covered: `property-19` (invoked behind the doubles in
 *     `test/privileged-mutation-audit.property.test.ts`), `schema-min-1` (the
 *     endpoint's own Zod schema declares the field `z.string().min(1)`, which
 *     this file verifies statically), or `documented` (neither — the reason is
 *     recorded and the gap stays visible).
 *
 * An unregistered dynamic expression fails the sweep, and a registry entry that
 * no longer appears in the source fails it too, so the registry cannot drift
 * away from the code in either direction.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = path.join(REPO_ROOT, "src");
const AUDIT_MODULE = "src/lib/firebase/audit.server.ts";

// ---------------------------------------------------------------------------
// Source enumeration
// ---------------------------------------------------------------------------

function repoRelative(absoluteFile: string): string {
  return path.relative(REPO_ROOT, absoluteFile).split(path.sep).join("/");
}

function parseSourceFile(repoRelativeFile: string): ts.SourceFile {
  const absolute = path.join(REPO_ROOT, repoRelativeFile);
  return ts.createSourceFile(
    absolute,
    readFileSync(absolute, "utf8"),
    ts.ScriptTarget.ESNext,
    true,
    repoRelativeFile.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** Every `.ts`/`.tsx` file under `src/`, repo-relative and sorted. */
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

// ---------------------------------------------------------------------------
// Declared target-type union
// ---------------------------------------------------------------------------

/** String-literal members of a union type node, or null if it is not one. */
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

/** Members of `AuditLogEntry["targetType"]`, read from `audit.server.ts`. */
function declaredAuditTargetTypes(): string[] {
  const sourceFile = parseSourceFile(AUDIT_MODULE);
  const found: string[][] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === "AuditLogEntry") {
      for (const member of node.members) {
        if (
          ts.isPropertySignature(member) &&
          ts.isIdentifier(member.name) &&
          member.name.text === "targetType"
        ) {
          const members = stringLiteralUnionMembers(member.type);
          if (members !== null) found.push(members);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (found.length !== 1) {
    throw new Error(
      `expected exactly one AuditLogEntry["targetType"] string-literal union in ${AUDIT_MODULE}, ` +
      `found ${found.length}`,
    );
  }
  return found[0];
}

const AUDIT_TARGET_TYPES = declaredAuditTargetTypes();

// ---------------------------------------------------------------------------
// `targetId` classification
// ---------------------------------------------------------------------------

type TargetIdKind =
  /** Proven non-empty from the source alone. */
  | "non-empty-by-construction"
  /** A literal that is empty (or whitespace only) — a Requirement 3.8 failure. */
  | "empty-literal"
  /** Present, but its value is only known at run time. */
  | "dynamic";

interface TargetIdClassification {
  kind: TargetIdKind;
  /** Source text of the expression, used as the registry key. */
  text: string;
}

/** Top-level `const NAME = …` initializers in a file, by name. */
function constInitializers(sourceFile: ts.SourceFile): Map<string, ts.Expression> {
  const initializers = new Map<string, ts.Expression>();
  const duplicates = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const name = node.name.text;
      if (initializers.has(name)) duplicates.add(name);
      initializers.set(name, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  // An ambiguous name is not resolved: two declarations mean the scan cannot
  // know which one a call site sees.
  for (const name of duplicates) initializers.delete(name);
  return initializers;
}

/**
 * Decide whether an expression is non-empty purely from the source. Conservative
 * by design: anything not provably non-empty is `dynamic`, never assumed good.
 */
function classifyTargetId(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  consts: Map<string, ts.Expression>,
  depth = 0,
): TargetIdKind {
  if (depth > 6) return "dynamic";

  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text.trim().length > 0 ? "non-empty-by-construction" : "empty-literal";
  }

  if (ts.isParenthesizedExpression(expression)) {
    return classifyTargetId(expression.expression, sourceFile, consts, depth + 1);
  }
  if (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
    return classifyTargetId(expression.expression, sourceFile, consts, depth + 1);
  }
  if (ts.isNonNullExpression(expression)) {
    return classifyTargetId(expression.expression, sourceFile, consts, depth + 1);
  }

  // A template is non-empty as soon as one literal span is.
  if (ts.isTemplateExpression(expression)) {
    const spans = [expression.head.text, ...expression.templateSpans.map((s) => s.literal.text)];
    return spans.some((span) => span.trim().length > 0)
      ? "non-empty-by-construction"
      : "dynamic";
  }

  if (ts.isBinaryExpression(expression)) {
    const { kind } = expression.operatorToken;
    const left = classifyTargetId(expression.left, sourceFile, consts, depth + 1);
    const right = classifyTargetId(expression.right, sourceFile, consts, depth + 1);
    // Concatenation: one non-empty side is enough.
    if (kind === ts.SyntaxKind.PlusToken) {
      if (left === "non-empty-by-construction" || right === "non-empty-by-construction") {
        return "non-empty-by-construction";
      }
      return "dynamic";
    }
    // Fallback chains: every reachable branch must be non-empty.
    if (
      kind === ts.SyntaxKind.QuestionQuestionToken ||
      kind === ts.SyntaxKind.BarBarToken
    ) {
      if (left === "non-empty-by-construction" && right === "non-empty-by-construction") {
        return "non-empty-by-construction";
      }
      if (left === "empty-literal" || right === "empty-literal") return "empty-literal";
      return "dynamic";
    }
    return "dynamic";
  }

  if (ts.isConditionalExpression(expression)) {
    const whenTrue = classifyTargetId(expression.whenTrue, sourceFile, consts, depth + 1);
    const whenFalse = classifyTargetId(expression.whenFalse, sourceFile, consts, depth + 1);
    if (whenTrue === "empty-literal" || whenFalse === "empty-literal") return "empty-literal";
    return whenTrue === "non-empty-by-construction" && whenFalse === "non-empty-by-construction"
      ? "non-empty-by-construction"
      : "dynamic";
  }

  // A local `const` whose initializer is provably non-empty carries over.
  if (ts.isIdentifier(expression)) {
    if (expression.text === "undefined") return "empty-literal";
    const initializer = consts.get(expression.text);
    if (initializer) return classifyTargetId(initializer, sourceFile, consts, depth + 1);
    return "dynamic";
  }

  if (expression.kind === ts.SyntaxKind.NullKeyword) return "empty-literal";

  return "dynamic";
}

// ---------------------------------------------------------------------------
// Call-site enumeration
// ---------------------------------------------------------------------------

interface AuditCallSite {
  file: string;
  line: number;
  /** Nearest enclosing named declaration, for readable diagnostics. */
  enclosing: string;
  /** The `targetType` string literal, or null when it is not a literal. */
  targetType: string | null;
  /** Source text of the `targetType` expression. */
  targetTypeText: string;
  /** Present at all? A missing `targetId` is a Requirement 3.8 failure. */
  hasTargetId: boolean;
  targetId: TargetIdClassification;
  /** The `action` expression, checked for emptiness the same way. */
  actionKind: TargetIdKind;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** Nearest enclosing named function/variable declaration. */
function enclosingName(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
    current = current.parent;
  }
  return "<module scope>";
}

/** Named property of an object literal, if it is a plain assignment. */
function propertyOf(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = ts.isIdentifier(property.name)
      ? property.name.text
      : ts.isStringLiteral(property.name)
        ? property.name.text
        : null;
    if (key === name) return property.initializer;
  }
  return undefined;
}

/** Every `logAdminAction(...)` call in one parsed source file. */
function scanFileForAuditCalls(file: string, sourceFile: ts.SourceFile): AuditCallSite[] {
  const consts = constInitializers(sourceFile);
  const sites: AuditCallSite[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const calleeName = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;

      if (calleeName === "logAdminAction") {
        const entryArgument = node.arguments[1];
        const entry =
          entryArgument !== undefined && ts.isObjectLiteralExpression(entryArgument)
            ? entryArgument
            : null;

        const targetTypeExpression = entry ? propertyOf(entry, "targetType") : undefined;
        const targetIdExpression = entry ? propertyOf(entry, "targetId") : undefined;
        const actionExpression = entry ? propertyOf(entry, "action") : undefined;

        const targetTypeLiteral =
          targetTypeExpression !== undefined &&
            (ts.isStringLiteral(targetTypeExpression) ||
              ts.isNoSubstitutionTemplateLiteral(targetTypeExpression))
            ? targetTypeExpression.text
            : null;

        sites.push({
          file,
          line: lineOf(sourceFile, node),
          enclosing: enclosingName(node),
          targetType: targetTypeLiteral,
          targetTypeText: targetTypeExpression
            ? targetTypeExpression.getText(sourceFile)
            : "<absent>",
          hasTargetId: targetIdExpression !== undefined,
          targetId: {
            kind: targetIdExpression
              ? classifyTargetId(targetIdExpression, sourceFile, consts)
              : "empty-literal",
            text: targetIdExpression ? targetIdExpression.getText(sourceFile) : "<absent>",
          },
          actionKind: actionExpression
            ? classifyTargetId(actionExpression, sourceFile, consts)
            : "empty-literal",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return sites;
}

/** Every call site in the repository, in file/line order. */
function scanAuditCallSites(files: readonly string[]): AuditCallSite[] {
  const sites: AuditCallSite[] = [];
  for (const file of files) sites.push(...scanFileForAuditCalls(file, parseSourceFile(file)));
  return sites;
}

const CALL_SITES = scanAuditCallSites(SRC_FILES);

function describeSite(site: AuditCallSite): string {
  return `${site.file}:${site.line} (${site.enclosing})`;
}

// ---------------------------------------------------------------------------
// Static evidence for `data.<field>` targets: the endpoint's own Zod schema
// ---------------------------------------------------------------------------

/** Is this expression a `z.string()…min(n>=1)` chain? */
function isNonEmptyStringSchema(expression: ts.Expression, sourceFile: ts.SourceFile): boolean {
  if (!ts.isCallExpression(expression)) return false;
  if (!ts.isPropertyAccessExpression(expression.expression)) return false;
  if (expression.expression.name.text !== "min") return false;
  const [argument] = expression.arguments;
  if (argument === undefined || !ts.isNumericLiteral(argument)) return false;
  if (Number(argument.text) < 1) return false;
  return expression.expression.expression.getText(sourceFile).startsWith("z.string()");
}

/**
 * Does `file` declare `field: z.string().min(1)` in some Zod object? That is
 * static proof the validated payload cannot carry an empty value for the field,
 * so a `data.<field>` target is non-empty by construction at run time.
 */
function declaresNonEmptyStringField(file: string, field: string): boolean {
  const sourceFile = parseSourceFile(file);
  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAssignment(node)) {
      const key = ts.isIdentifier(node.name)
        ? node.name.text
        : ts.isStringLiteral(node.name)
          ? node.name.text
          : null;
      if (key === field && isNonEmptyStringSchema(node.initializer, sourceFile)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return found;
}

// ---------------------------------------------------------------------------
// Registry of dynamic `targetId` expressions
// ---------------------------------------------------------------------------

type DynamicCoverage =
  /** Invoked behind the doubles in privileged-mutation-audit.property.test.ts. */
  | "property-19"
  /** The endpoint's Zod schema declares the source field `z.string().min(1)`. */
  | "schema-min-1"
  /** Neither: recorded so the gap is visible rather than silent. */
  | "documented";

interface DynamicTargetIdEntry {
  coverage: DynamicCoverage;
  /** For `schema-min-1`: the validated field the expression reads. */
  schemaField?: string;
  reason: string;
}

/**
 * Every dynamic `targetId` expression in the repository, keyed by file and
 * source text. Both directions are asserted: an expression missing from here
 * fails, and an entry here that no longer appears in the source fails.
 */
const DYNAMIC_TARGET_IDS: Readonly<Record<string, Readonly<Record<string, DynamicTargetIdEntry>>>> =
{
  "src/lib/admin/report-copilot.functions.ts": {
    "data.reportId": {
      coverage: "schema-min-1",
      schemaField: "reportId",
      reason: "The runReportCopilot validator declares `reportId: z.string().min(1)`.",
    },
  },
  "src/lib/admin/content.functions.ts": {
    "created.id": {
      coverage: "property-19",
      reason:
        "`createFact` returns the digest-derived fact id it just wrote; Property 19 invokes " +
        "addFact and asserts the recorded targetId is non-empty.",
    },
  },
  "src/lib/admin/ops-moderation.server.ts": {
    id: {
      coverage: "documented",
      reason:
        "`moderationCopilot` validates `id` against the pending queue before running review and logging.",
    },
  },
  "src/lib/admin/ops.functions.ts": {
    "data.id": {
      coverage: "schema-min-1",
      schemaField: "id",
      reason:
        "The saveSubject, savePlaylist and updateCrawlPriority validators each declare " +
        "`id: z.string().min(1)`.",
    },
    "created.id": {
      coverage: "documented",
      reason:
        "`createSubject` / `createPlaylist` return the normalized key of a `z.string().min(1)` " +
        "name, so the value is non-empty in practice; the ops taxonomy handlers are outside the " +
        "Privileged_Mutation_Path set the Glossary enumerates and are not invoked by Property 19.",
    },
    "enqueued.expandedFrom ?? enqueued.items[0]?.id ?? data.subject": {
      coverage: "documented",
      reason:
        "A three-step fallback ending in `data.subject`, which the queueCrawl validator declares " +
        "`z.string().min(1)`. The two earlier branches are non-empty in practice but a scan " +
        "cannot prove it, and the handler is not invoked by Property 19.",
    },
    "result.reportId": {
      coverage: "documented",
      reason:
        "`flagQuestionTelemetry` returns the telemetry report id it wrote; not invoked by " +
        "Property 19 (signed telemetry input is outside this task's scope).",
    },
  },
  "src/lib/admin/ops-portal.server.ts": {
    "result.reportId": {
      coverage: "documented",
      reason:
        "`opsAnalyticsFlag` returns the written telemetry report id; non-empty in practice.",
    },
  },
  "src/lib/admin/ops.server.ts": {
    "email || input.id": {
      coverage: "documented",
      reason:
        "`setPremium` prefers the resolved account email and falls back to the player id it was " +
        "called with; neither branch is a literal, and the daily/player ops exports are outside " +
        "the Privileged_Mutation_Path set the Glossary enumerates.",
    },
    date: {
      coverage: "documented",
      reason:
        "`deleteDailyPack(date)` audits the pack document it just deleted at `daily_packs/{date}`; " +
        "the parameter is the document key, so an empty value could not have addressed a pack.",
    },
    "input.date": {
      coverage: "documented",
      reason:
        "`scheduleDailyPack` audits the pack date it wrote; same reasoning as `deleteDailyPack`.",
    },
  },
  "src/lib/admin/roles.functions.ts": {
    "data.uid": {
      coverage: "schema-min-1",
      schemaField: "uid",
      reason:
        "The setAdminRole validator declares `uid: z.string().min(1)`; the handler is also " +
        "invoked behind the doubles by Property 19.",
    },
  },
};

// ---------------------------------------------------------------------------
// Property 18
// ---------------------------------------------------------------------------

describe("Feature: admin-quality-gates-and-shared-contracts, Property 18: Every `logAdminAction` call site supplies a valid target", () => {
  it("enumerates a non-trivial set of call sites and a non-trivial union", () => {
    // Non-vacuity: a broken scan must not pass by finding nothing
    // (the same failure mode Requirement 6.13 guards for the server-function
    // enumeration).
    expect(SRC_FILES.length).toBeGreaterThan(10);
    expect(CALL_SITES.length).toBeGreaterThanOrEqual(15);
    expect(new Set(CALL_SITES.map((site) => site.file)).size).toBeGreaterThanOrEqual(4);

    expect(AUDIT_TARGET_TYPES.length).toBeGreaterThan(1);
    expect(new Set(AUDIT_TARGET_TYPES).size).toBe(AUDIT_TARGET_TYPES.length);
    // The literal the defect used was never a member.
    expect(AUDIT_TARGET_TYPES).not.toContain("fact_bank");

    // The known call sites, so a silent drop in coverage is visible.
    const byFile = new Map<string, number>();
    for (const site of CALL_SITES) byFile.set(site.file, (byFile.get(site.file) ?? 0) + 1);
    // Ordinary edit/status/import/bulk handlers and report resolution now stage
    // one audit per mutation inside the item transaction rather than calling
    // logAdminAction afterwards; the remaining handler call sites are still
    // checked here.
    expect(byFile.get("src/lib/admin/content.functions.ts")).toBeGreaterThanOrEqual(2);
    expect(byFile.get("src/lib/admin/ops.functions.ts")).toBeGreaterThanOrEqual(7);
    expect(byFile.get("src/lib/admin/ops.server.ts")).toBeGreaterThanOrEqual(5);
    expect(byFile.get("src/lib/admin/roles.functions.ts")).toBe(1);
    expect(byFile.get("src/lib/admin/config.functions.ts")).toBe(1);
  });

  it("passes a targetType from the declared union at every call site", () => {
    const failures = CALL_SITES.filter(
      (site) => site.targetType === null || !AUDIT_TARGET_TYPES.includes(site.targetType),
    ).map(
      (site) =>
        `${describeSite(site)} passes targetType ${site.targetTypeText}, which is not a member of ` +
        `AuditLogEntry["targetType"] (${AUDIT_TARGET_TYPES.join(" | ")})`,
    );
    expect(failures).toEqual([]);

    // Every call site resolves statically today, so the union check above is a
    // real decision rather than a skipped one.
    const unresolved = CALL_SITES.filter((site) => site.targetType === null).map(describeSite);
    expect(unresolved).toEqual([]);
  });

  it("passes a non-empty targetId at every call site", () => {
    // A missing or provably empty target is an outright failure.
    const missing = CALL_SITES.filter((site) => !site.hasTargetId).map(describeSite);
    expect(missing).toEqual([]);

    const empty = CALL_SITES.filter((site) => site.targetId.kind === "empty-literal").map(
      (site) => `${describeSite(site)} passes targetId ${site.targetId.text}, which is empty`,
    );
    expect(empty).toEqual([]);

    // `action` gets the same treatment: Requirement 6.7 needs it non-empty too.
    const emptyAction = CALL_SITES.filter((site) => site.actionKind === "empty-literal").map(
      describeSite,
    );
    expect(emptyAction).toEqual([]);
  });

  it("accounts for every dynamic targetId expression, with no stale registry entry", () => {
    const unregistered: string[] = [];
    for (const site of CALL_SITES) {
      if (site.targetId.kind !== "dynamic") continue;
      const entry = DYNAMIC_TARGET_IDS[site.file]?.[site.targetId.text];
      if (!entry) {
        unregistered.push(
          `${describeSite(site)} passes a dynamic targetId \`${site.targetId.text}\` that no ` +
          "coverage entry accounts for",
        );
      }
    }
    expect(unregistered).toEqual([]);

    // The other direction: nothing lingers in the registry after the source moved on.
    const present = new Set(
      CALL_SITES.filter((site) => site.targetId.kind === "dynamic").map(
        (site) => `${site.file}::${site.targetId.text}`,
      ),
    );
    const stale: string[] = [];
    for (const [file, entries] of Object.entries(DYNAMIC_TARGET_IDS)) {
      for (const text of Object.keys(entries)) {
        if (!present.has(`${file}::${text}`)) stale.push(`${file}: \`${text}\``);
      }
    }
    expect(stale, "stale dynamic-targetId registry entries").toEqual([]);
  });

  it("proves the schema-backed dynamic targets non-empty from the endpoint's own validator", () => {
    // Static evidence, not an assumption: the field the expression reads is
    // declared `z.string().min(1)` in the same file, so a validated payload
    // cannot carry an empty value for it.
    const checked: string[] = [];
    for (const [file, entries] of Object.entries(DYNAMIC_TARGET_IDS)) {
      for (const [text, entry] of Object.entries(entries)) {
        if (entry.coverage !== "schema-min-1") continue;
        const field = entry.schemaField;
        expect(field, `${file}: \`${text}\` records no schemaField`).toBeTypeOf("string");
        if (field === undefined) continue;
        expect(
          declaresNonEmptyStringField(file, field),
          `${file} declares \`${field}: z.string().min(1)\``,
        ).toBe(true);
        checked.push(`${file}::${field}`);
      }
    }
    // The two removed `data.id` sites are now checked by the dedicated
    // transaction-audit suite; the remaining handler call sites retain their
    // schema-backed non-empty proof.
    expect(checked.length).toBeGreaterThanOrEqual(3);

    // Negative control for the schema probe itself.
    expect(
      declaresNonEmptyStringField("src/lib/admin/content.functions.ts", "sub_category"),
    ).toBe(false);
  });

  it("holds for every enumerated call site under random sampling", async () => {
    // The universe is finite, so the generator samples it: each run re-checks a
    // uniformly drawn call site against the whole of Requirement 3.8. The
    // exhaustive assertions above and this sampling agree by construction; the
    // sampling is what makes a newly added call site fail without anyone
    // extending this file.
    const visited = new Set<string>();

    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...CALL_SITES), async (site) => {
        visited.add(describeSite(site));

        expect(site.hasTargetId, describeSite(site)).toBe(true);
        expect(site.targetId.kind, `${describeSite(site)} targetId ${site.targetId.text}`).not.toBe(
          "empty-literal",
        );
        expect(site.targetType, describeSite(site)).not.toBeNull();
        expect(AUDIT_TARGET_TYPES, describeSite(site)).toContain(String(site.targetType));

        if (site.targetId.kind === "dynamic") {
          const entry = DYNAMIC_TARGET_IDS[site.file]?.[site.targetId.text];
          expect(entry, `${describeSite(site)} coverage entry`).toBeDefined();
          expect(entry?.reason.length ?? 0).toBeGreaterThan(0);
        }
        return true;
      }),
      { numRuns: 200 },
    );

    // 200 uniform draws over this many sites covers all of them with
    // overwhelming probability; asserting it makes the coverage explicit.
    expect(visited.size).toBe(CALL_SITES.length);
  });

  it("flags an invalid target, so the passing sweep is not vacuous", () => {
    // The classifier is exercised against generated bad call sites, including
    // the exact defect this requirement closed (`targetType: "fact_bank"`).
    // Characters that survive being written back into a source literal
    // verbatim: no quote, backslash, backtick or `$` to re-escape.
    const badTargetTypeArb = fc
      .array(
        fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-. ".split("")),
        { minLength: 1, maxLength: 12 },
      )
      .map((chars) => chars.join(""))
      .filter((value) => !AUDIT_TARGET_TYPES.includes(value));

    fc.assert(
      fc.property(
        fc.oneof(fc.constant("fact_bank"), fc.constant("facts"), badTargetTypeArb),
        fc.constantFrom('""', '"   "', "undefined", "null", "``"),
        (badTargetType, badTargetId) => {
          const synthetic = ts.createSourceFile(
            "synthetic/bad-call-site.ts",
            [
              'import { logAdminAction } from "@/lib/firebase/audit.server";',
              "export async function bad(caller: never) {",
              "  await logAdminAction(caller, {",
              '    action: "thing.happened",',
              `    targetType: "${badTargetType}",`,
              `    targetId: ${badTargetId},`,
              "  });",
              "}",
            ].join("\n"),
            ts.ScriptTarget.ESNext,
            true,
            ts.ScriptKind.TS,
          );

          const sites = scanFileForAuditCalls("synthetic/bad-call-site.ts", synthetic);
          expect(sites).toHaveLength(1);
          const site = sites[0];

          expect(site.enclosing).toBe("bad");
          expect(site.targetType).toBe(badTargetType);
          expect(AUDIT_TARGET_TYPES.includes(String(site.targetType))).toBe(false);
          expect(site.hasTargetId).toBe(true);
          expect(site.targetId.kind).toBe("empty-literal");
          return true;
        },
      ),
      { numRuns: 120 },
    );
  });

  it("recognises a valid target, so the classifier is not simply strict", () => {
    // Positive control: the shapes the repository actually uses must classify as
    // valid, otherwise the sweep above would be passing for the wrong reason.
    fc.assert(
      fc.property(
        fc.constantFrom(...AUDIT_TARGET_TYPES),
        fc.constantFrom(
          '"custom_topic_suggestions"',
          "`${input.date}:${input.uid}`",
          "generatedId",
          '"prefix_" + suffix',
          "flag ? \"a\" : \"b\"",
        ),
        (goodTargetType, goodTargetId) => {
          const synthetic = ts.createSourceFile(
            "synthetic/good-call-site.ts",
            [
              'import { logAdminAction } from "@/lib/firebase/audit.server";',
              "export async function good(caller: never, input: never, flag: boolean, suffix: string) {",
              "  const generatedId = `generated_${Date.now()}`;",
              "  await logAdminAction(caller, {",
              '    action: "thing.happened",',
              `    targetType: "${goodTargetType}",`,
              `    targetId: ${goodTargetId},`,
              "  });",
              "}",
            ].join("\n"),
            ts.ScriptTarget.ESNext,
            true,
            ts.ScriptKind.TS,
          );

          const sites = scanFileForAuditCalls("synthetic/good-call-site.ts", synthetic);
          expect(sites).toHaveLength(1);
          expect(AUDIT_TARGET_TYPES).toContain(String(sites[0].targetType));
          expect(sites[0].targetId.kind).toBe("non-empty-by-construction");
          return true;
        },
      ),
      { numRuns: 120 },
    );
  });
});
