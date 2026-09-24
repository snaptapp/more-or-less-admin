/**
 * Feature: admin-quality-gates-and-shared-contracts
 *
 * Property 19: Every privileged mutation records exactly one well-formed audit entry
 *   *For all* `Privileged_Mutation_Path` invocations exercised behind test
 *   doubles, exactly one audit entry is recorded whose `action`, `targetType`,
 *   and `targetId` are each non-empty strings and whose `targetType` is a member
 *   of the declared `AuditLogEntry` target-type union.
 *   Validates: Requirement 6.7
 *
 * Scope
 * -----
 * The Glossary enumerates the `Privileged_Mutation_Path` members: `updateFact`,
 * `setFactStatus`, `createFact`, `importFactsBatch`, the `roles.server` exports,
 * the `remote_config.server` exports, and the `trivia_reports` moderation
 * exports. None of them writes an audit entry itself — that is the
 * server-function handler's job — so every path is exercised *through its
 * handler*, which is where Requirement 6.7 is actually decidable:
 *
 *   handler (src/lib/admin/*.functions.ts)  →  privileged mutation
 *   ---------------------------------------------------------------
 *   saveFact                                →  updateFact
 *   changeFactStatus                        →  setFactStatus
 *   addFact                                 →  createFact
 *   bulkImportFacts                         →  importFactsBatch
 *   bulkUpdateFacts                         →  bulkUpdateFacts → updateFact
 *   actOnReport                             →  resolveReport (trivia_reports)
 *   setAdminRole                            →  setAdminClaim (Firebase Auth)
 *   saveRemoteConfigTopics                  →  publishTopicSuggestionsConfig
 *
 * The three write surfaces Requirement 6.10 names are all represented:
 * Firestore, Firebase Auth custom claims, and Firebase Remote Config.
 *
 * `bulkUpdateFacts` and `bulkImportFacts` also carry dedicated properties
 * (tasks 3.6 and 3.8); they are included here so the Requirement 6.7 sweep is
 * complete rather than "complete except for the two paths another file owns".
 *
 * Harness
 * -------
 * TanStack Start does not expose the handler on what `.handler()` returns, so
 * the recording `createServerFn` seam from `test/server-functions.property.test.ts`
 * is reused: the chain records middleware, validator, and handler against the
 * token the module exports. `@/lib/admin/middleware` is mocked to keep the
 * import graph off the Firebase web SDK. Everything else in `src/` is the real
 * implementation; only the four service boundaries are doubles, so nothing
 * reaches a credential, an emulator, a deployed service, or the network.
 */
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  auditDouble,
  blockedNetworkAttempts,
  firebaseAuthDouble,
  firestoreDouble,
  remoteConfigDouble,
  type AdminUser,
  type AuditLogEntry,
  type RecordedAuditEntry,
} from "./setup";

// ---------------------------------------------------------------------------
// Recording server-function harness (hoisted above the mocks)
// ---------------------------------------------------------------------------

type CapturedValidator = (data: unknown) => unknown;
type CapturedHandler = (input: {
  data: never;
  context: { user: AdminUser };
}) => Promise<unknown>;

interface CapturedServerFn {
  middleware: readonly unknown[];
  validator: CapturedValidator | null;
  handler: CapturedHandler | null;
}

const harness = vi.hoisted(() => {
  interface ChainState {
    middleware: unknown[];
    validator: unknown;
  }

  const registry = new Map<object, { middleware: unknown[]; validator: unknown; handler: unknown }>();

  const makeChain = (state: ChainState): Record<string, unknown> => ({
    options: {},
    middleware: (list: unknown[]) =>
      makeChain({ ...state, middleware: [...state.middleware, ...list] }),
    validator: (fn: unknown) => makeChain({ ...state, validator: fn }),
    inputValidator: (fn: unknown) => makeChain({ ...state, validator: fn }),
    handler: (fn: unknown) => {
      const token = { __recordedServerFn: true };
      registry.set(token, {
        middleware: state.middleware,
        validator: state.validator,
        handler: fn,
      });
      return token;
    },
  });

  const createServerFn = () => makeChain({ middleware: [], validator: null });

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
  const authedServerFn = () => makeChain({ middleware: [authMiddleware], validator: null });

  return { registry, createServerFn, createMiddleware, authMiddleware, authedServerFn };
});

vi.mock("@tanstack/react-start", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createServerFn: harness.createServerFn,
    createMiddleware: harness.createMiddleware,
  };
});

vi.mock("@/lib/admin/middleware", () => ({
  authMiddleware: harness.authMiddleware,
  authedServerFn: harness.authedServerFn,
}));

// The four service boundaries (Requirement 6.10).
vi.mock("@/lib/firebase/firestore.server", async () => {
  const { firestoreDouble: double } = await import("./setup");
  return double().module;
});
vi.mock("@/lib/firebase/audit.server", async () => {
  const { auditDouble: double } = await import("./setup");
  return double().module;
});
vi.mock("@/lib/admin/roles.server", async () => {
  const { firebaseAuthDouble: double } = await import("./setup");
  return double().module;
});
vi.mock("@/lib/firebase/remote_config.server", async () => {
  const { remoteConfigDouble: double } = await import("./setup");
  return double().module;
});

// ---------------------------------------------------------------------------
// Modules under test
// ---------------------------------------------------------------------------

import { FACT_STATUSES } from "@/lib/admin/content.server";
import { STATUS_TRANSITIONS } from "../shared/fact-lifecycle-contract.gen";

/** The transitions an admin is contract-authorized to write (Requirement 9.3). */
const ADMIN_AUTHORIZED_TRANSITIONS = STATUS_TRANSITIONS.filter((t) => t.adminAuthorized);

const contentFunctions = await import("@/lib/admin/content.functions");
const rolesFunctions = await import("@/lib/admin/roles.functions");
const configFunctions = await import("@/lib/admin/config.functions");

const FUNCTION_MODULES: Record<string, Record<string, unknown>> = {
  "src/lib/admin/content.functions.ts": contentFunctions as unknown as Record<string, unknown>,
  "src/lib/admin/roles.functions.ts": rolesFunctions as unknown as Record<string, unknown>,
  "src/lib/admin/config.functions.ts": configFunctions as unknown as Record<string, unknown>,
};

/** Resolve one exported server function to the validator + handler it declared. */
function capture(moduleFile: string, exportedSymbol: string): CapturedServerFn {
  const moduleNamespace = FUNCTION_MODULES[moduleFile];
  if (!moduleNamespace) throw new Error(`no loaded module for ${moduleFile}`);
  const exported = moduleNamespace[exportedSymbol];
  const record =
    typeof exported === "object" && exported !== null
      ? harness.registry.get(exported as object)
      : undefined;
  if (!record) {
    throw new Error(
      `${exportedSymbol} in ${moduleFile} registered no handler with the recording createServerFn`,
    );
  }
  return {
    middleware: (record.middleware ?? []) as readonly unknown[],
    validator: (record.validator ?? null) as CapturedValidator | null,
    handler: (record.handler ?? null) as CapturedHandler | null,
  };
}

// ---------------------------------------------------------------------------
// Declared audit target-type union, read from the source of truth
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Members of `AuditLogEntry["targetType"]` as declared in `audit.server.ts`. */
function declaredAuditTargetTypes(): string[] {
  const absolute = path.join(REPO_ROOT, "src/lib/firebase/audit.server.ts");
  const sourceFile = ts.createSourceFile(
    absolute,
    readFileSync(absolute, "utf8"),
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const members: string[] = [];

  const collectUnion = (type: ts.TypeNode | undefined): void => {
    if (!type) return;
    if (ts.isParenthesizedTypeNode(type)) return collectUnion(type.type);
    if (ts.isUnionTypeNode(type)) {
      for (const member of type.types) collectUnion(member);
      return;
    }
    if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) {
      members.push(type.literal.text);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === "AuditLogEntry") {
      for (const member of node.members) {
        if (
          ts.isPropertySignature(member) &&
          ts.isIdentifier(member.name) &&
          member.name.text === "targetType"
        ) {
          collectUnion(member.type);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (members.length === 0) {
    throw new Error('could not read the AuditLogEntry["targetType"] union from audit.server.ts');
  }
  return members;
}

const AUDIT_TARGET_TYPES = declaredAuditTargetTypes();

// ---------------------------------------------------------------------------
// Scenarios: one per Privileged_Mutation_Path, reached through its handler
// ---------------------------------------------------------------------------

const ADMIN: AdminUser = {
  uid: "admin-privileged-1",
  email: "ops@snaptapp.us",
  name: "Ops Operator",
  isClaimAdmin: true,
};

/** Which privileged mutation a scenario exercises — the coverage key. */
type MutationPath =
  | "updateFact"
  | "setFactStatus"
  | "createFact"
  | "importFactsBatch"
  | "bulkUpdateFacts"
  | "resolveReport"
  | "setAdminClaim"
  | "publishTopicSuggestionsConfig";

interface MutationScenario {
  /** Human-readable label used in assertion messages. */
  label: string;
  /** The privileged mutation the handler reaches. */
  mutation: MutationPath;
  /** Declaring module of the handler, repo-relative. */
  moduleFile: string;
  /** Exported server-function symbol. */
  exportedSymbol: string;
  /** Seed whatever documents/users/config the invocation needs. */
  prepare: () => void;
  /** The payload as it would arrive from the wire. */
  payload: unknown;
  /** Expected audit `action`. */
  expectedAction: string;
  /** Expected audit `targetType`. */
  expectedTargetType: AuditLogEntry["targetType"];
  /** Expected `targetId`, or null when it is generated and only its shape matters. */
  expectedTargetId: string | null;
  /** Proof the invocation actually mutated something. */
  expectMutated: () => void;
}

/** Ids/keys from a fixed alphabet: legal single Firestore path segments. */
const slugArb = fc
  .array(fc.constantFrom("a", "b", "c", "d", "e", "f", "0", "1", "2", "3", "_"), {
    minLength: 3,
    maxLength: 8,
  })
  .map((chars) => chars.join(""));

/** Non-empty text with at least one alphanumeric, so `normalizeKey` is stable. */
const wordArb = fc
  .tuple(slugArb, fc.string({ maxLength: 6 }))
  .map(([slug, tail]) => `${slug}${tail}`.trim() || slug);

const SEED_FACT = {
  subject: "Seeded subject",
  subject_key: "seeded_subject",
  angle: "Seeded angle",
  angle_key: "seeded_angle",
  question: "Seeded question?",
  claim_template: "Seeded claim {n}",
  context: "Seeded context",
  true_number: 7,
  unit: "units",
  status: "active",
  content_rating: "standard",
  surprise_factor: 2,
  source_urls: [],
  served_count: 0,
} as const;

function seedFact(id: string, status: string = SEED_FACT.status): void {
  firestoreDouble().seed(`fact_bank/${id}`, { ...SEED_FACT, status });
}

/** `saveFact` → `updateFact`. */
const saveFactScenario: fc.Arbitrary<MutationScenario> = fc
  .tuple(slugArb, wordArb)
  .map(([id, question]) => ({
    label: `saveFact(${id})`,
    mutation: "updateFact" as const,
    moduleFile: "src/lib/admin/content.functions.ts",
    exportedSymbol: "saveFact",
    prepare: () => seedFact(id),
    payload: { id, question },
    expectedAction: "fact.update",
    expectedTargetType: "fact" as const,
    expectedTargetId: id,
    expectMutated: () => {
      expect(firestoreDouble().writeCount()).toBe(1);
      expect(firestoreDouble().document(`fact_bank/${id}`)?.data["question"]).toBe(question);
    },
  }));

/**
 * `changeFactStatus` → `setFactStatus`. Only admin-authorized transitions are
 * exercised here: `setFactStatus` now rejects a non-authorized target before
 * any write (Requirements 9.3, 9.4), so it would emit no audit entry and there
 * would be nothing for Property 19 to assert. The fact is seeded in the
 * transition's `from` status so the requested `to` is reachable.
 */
const changeFactStatusScenario: fc.Arbitrary<MutationScenario> = fc
  .tuple(slugArb, fc.constantFrom(...ADMIN_AUTHORIZED_TRANSITIONS), fc.option(wordArb, { nil: undefined }))
  .map(([id, transition, reason]) => {
    const status = transition.to;
    return {
      label: `changeFactStatus(${id}, ${transition.from}→${status})`,
      mutation: "setFactStatus" as const,
      moduleFile: "src/lib/admin/content.functions.ts",
      exportedSymbol: "changeFactStatus",
      prepare: () => seedFact(id, transition.from),
      payload: reason === undefined ? { id, status } : { id, status, reason },
      expectedAction: `fact.status_${status}`,
      expectedTargetType: "fact" as const,
      expectedTargetId: id,
      expectMutated: () => {
        expect(firestoreDouble().writeCount()).toBe(1);
        expect(firestoreDouble().document(`fact_bank/${id}`)?.data["status"]).toBe(status);
      },
    };
  });

/** `addFact` → `createFact`. */
const addFactScenario: fc.Arbitrary<MutationScenario> = fc
  .tuple(wordArb, wordArb, fc.integer({ min: -10_000, max: 10_000 }))
  .map(([subject, angle, trueNumber]) => ({
    label: `addFact(${subject} / ${angle})`,
    mutation: "createFact" as const,
    moduleFile: "src/lib/admin/content.functions.ts",
    exportedSymbol: "addFact",
    // Nothing to seed: `createFact` refuses an existing subject/angle pair.
    prepare: () => undefined,
    payload: { subject, angle, true_number: trueNumber, unit: "units" },
    expectedAction: "fact.create",
    expectedTargetType: "fact" as const,
    // The id is derived from a digest of the subject/angle keys.
    expectedTargetId: null,
    expectMutated: () => {
      const writes = firestoreDouble().writes();
      expect(writes.length).toBeGreaterThanOrEqual(1);
      expect(writes[0].kind).toBe("create");
      expect(writes[0].collection).toBe("fact_bank");
    },
  }));

/** `bulkImportFacts` → `importFactsBatch`. */
const bulkImportScenario: fc.Arbitrary<MutationScenario> = fc
  .tuple(wordArb, fc.array(wordArb, { minLength: 1, maxLength: 3 }))
  .map(([subject, angles]) => ({
    label: `bulkImportFacts(${subject}, ${angles.length} facts)`,
    mutation: "importFactsBatch" as const,
    moduleFile: "src/lib/admin/content.functions.ts",
    exportedSymbol: "bulkImportFacts",
    prepare: () => undefined,
    payload: {
      facts: angles.map((angle, index) => ({
        subject,
        // Index-prefixed so two generated angles cannot collapse to one id.
        angle: `a${index}_${angle}`,
        true_number: index + 1,
        unit: "units",
      })),
    },
    expectedAction: "fact.bulk_import",
    expectedTargetType: "fact" as const,
    // Keyed by a generated import-batch id.
    expectedTargetId: null,
    expectMutated: () => {
      expect(firestoreDouble().writeCount()).toBe(angles.length);
    },
  }));

/** `bulkUpdateFacts` → `bulkUpdateFacts` → `updateFact` (also task 3.6). */
const bulkUpdateScenario: fc.Arbitrary<MutationScenario> = fc
  .array(fc.tuple(slugArb, wordArb), { minLength: 1, maxLength: 4 })
  .map((entries) => {
    const updates = entries.map(([slug, question], index) => ({
      id: `b${index}_${slug}`,
      question,
    }));
    return {
      label: `bulkUpdateFacts(${updates.length} edits)`,
      mutation: "bulkUpdateFacts" as const,
      moduleFile: "src/lib/admin/content.functions.ts",
      exportedSymbol: "bulkUpdateFacts",
      prepare: () => {
        for (const update of updates) seedFact(update.id);
      },
      payload: { updates },
      expectedAction: "fact.bulk_update",
      expectedTargetType: "fact" as const,
      // A one-edit batch is attributed to the fact; a larger batch to a
      // generated batch id.
      expectedTargetId: updates.length === 1 ? updates[0].id : null,
      expectMutated: () => {
        expect(firestoreDouble().writeCount()).toBe(updates.length);
      },
    };
  });

/** `actOnReport` → `resolveReport` (the `trivia_reports` moderation path). */
const actOnReportScenario: fc.Arbitrary<MutationScenario> = fc
  .tuple(
    slugArb,
    slugArb,
    fc.constantFrom(
      "retire_fact",
      "fix_number",
      "reject",
      "resolve_only",
      "add_to_bank",
      "resolve_duplicate",
      "edit_fact",
      "resolve_as_is",
    ),
    fc.integer({ min: 1, max: 5_000 }),
    fc.option(wordArb, { nil: undefined }),
  )
  .map(([reportSlug, factSlug, action, correctedNumber, note]) => {
    const reportId = `r_${reportSlug}`;
    const factId = `f_${factSlug}`;
    return {
      label: `actOnReport(${action})`,
      mutation: "resolveReport" as const,
      moduleFile: "src/lib/admin/content.functions.ts",
      exportedSymbol: "actOnReport",
      prepare: () => {
        firestoreDouble().seed(`trivia_reports/${reportId}`, {
          factId,
          status: "pending_review",
          reason: "wrong number",
          created_at: "2024-01-01T00:00:00.000Z",
        });
        seedFact(factId);
      },
      payload: {
        reportId,
        action,
        factId,
        correctedNumber,
        ...(note === undefined ? {} : { note }),
        // Only read by `add_to_bank`, harmless elsewhere.
        topic: `topic_${reportSlug}`,
        claimStatement: `Claim about ${reportSlug}`,
        unit: "units",
      },
      expectedAction: `report.${action}`,
      expectedTargetType: "report" as const,
      expectedTargetId: reportId,
      expectMutated: () => {
        // Every action resolves or rejects the report document itself.
        const report = firestoreDouble().document(`trivia_reports/${reportId}`);
        expect(report?.data["status"]).toBe(action === "reject" ? "rejected" : "resolved");
        expect(firestoreDouble().writeCount()).toBeGreaterThanOrEqual(1);
      },
    };
  });

/** `setAdminRole` → `setAdminClaim` (Firebase Auth custom claims). */
const setAdminRoleScenario: fc.Arbitrary<MutationScenario> = fc
  .tuple(slugArb, fc.boolean(), slugArb)
  .map(([uidSlug, admin, emailSlug]) => {
    // Never the caller's own uid: revoking your own admin is refused before any
    // mutation, which is a different (already-covered) path.
    const uid = `u_${uidSlug}`;
    const email = `${emailSlug}@example.com`;
    return {
      label: `setAdminRole(${uid}, ${String(admin)})`,
      mutation: "setAdminClaim" as const,
      moduleFile: "src/lib/admin/roles.functions.ts",
      exportedSymbol: "setAdminRole",
      prepare: () => {
        firebaseAuthDouble().seedUser({ uid, email, isAdmin: !admin });
      },
      payload: { uid, admin },
      expectedAction: admin ? "grant_admin" : "revoke_admin",
      expectedTargetType: "user" as const,
      expectedTargetId: uid,
      expectMutated: () => {
        expect(firebaseAuthDouble().claimChanges()).toEqual([{ uid, admin }]);
        // The entitlements mirror is written through Firestore.
        expect(firestoreDouble().document(`entitlements/${email}`)?.data["isAdmin"]).toBe(admin);
      },
    };
  });

/** `saveRemoteConfigTopics` → `publishTopicSuggestionsConfig` (Remote Config). */
const remoteConfigScenario: fc.Arbitrary<MutationScenario> = fc
  .array(wordArb, { minLength: 1, maxLength: 4 })
  .map((topics) => ({
    label: `saveRemoteConfigTopics(${topics.length} topics)`,
    mutation: "publishTopicSuggestionsConfig" as const,
    moduleFile: "src/lib/admin/config.functions.ts",
    exportedSymbol: "saveRemoteConfigTopics",
    prepare: () => {
      remoteConfigDouble().seedTopicSuggestions({
        defaultTopics: ["seeded topic"],
        variants: [],
      });
    },
    // `"*"` is the wildcard precondition the real client also accepts.
    payload: { defaultTopics: topics, variants: [], etag: "*" },
    expectedAction: "update_remote_config_topics",
    expectedTargetType: "system" as const,
    expectedTargetId: "custom_topic_suggestions",
    expectMutated: () => {
      const publishes = remoteConfigDouble().publishes();
      expect(publishes).toHaveLength(1);
      expect(publishes[0].defaultTopics).toEqual(topics);
    },
  }));

const SCENARIO_ARBITRARIES: ReadonlyArray<fc.Arbitrary<MutationScenario>> = [
  saveFactScenario,
  changeFactStatusScenario,
  addFactScenario,
  bulkImportScenario,
  bulkUpdateScenario,
  actOnReportScenario,
  setAdminRoleScenario,
  remoteConfigScenario,
];

/** Every privileged mutation this file claims to cover. */
const COVERED_MUTATIONS: readonly MutationPath[] = [
  "updateFact",
  "setFactStatus",
  "createFact",
  "importFactsBatch",
  "bulkUpdateFacts",
  "resolveReport",
  "setAdminClaim",
  "publishTopicSuggestionsConfig",
];

const scenarioArb = fc.oneof(...SCENARIO_ARBITRARIES);

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function resetDoubles(): void {
  firestoreDouble().reset();
  auditDouble().reset();
  firebaseAuthDouble().reset();
  remoteConfigDouble().reset();
}

/** Assert one recorded entry satisfies every clause of Requirement 6.7. */
function expectWellFormedEntry(entry: RecordedAuditEntry, scenario: MutationScenario): void {
  const where = scenario.label;

  expect(typeof entry.action, where).toBe("string");
  expect(entry.action.length, `${where}: action is non-empty`).toBeGreaterThan(0);
  expect(entry.action, where).toBe(scenario.expectedAction);

  expect(typeof entry.targetType, where).toBe("string");
  expect(String(entry.targetType).length, `${where}: targetType is non-empty`).toBeGreaterThan(0);
  // Membership of the declared union, read from `audit.server.ts` at run time.
  expect(AUDIT_TARGET_TYPES, `${where}: targetType ${entry.targetType}`).toContain(
    String(entry.targetType),
  );
  expect(entry.targetType, where).toBe(scenario.expectedTargetType);

  expect(typeof entry.targetId, where).toBe("string");
  expect(entry.targetId.length, `${where}: targetId is non-empty`).toBeGreaterThan(0);
  expect(entry.targetId.trim(), `${where}: targetId is not whitespace`).not.toBe("");
  if (scenario.expectedTargetId !== null) {
    expect(entry.targetId, where).toBe(scenario.expectedTargetId);
  }

  // The entry is attributed to the caller the middleware supplied.
  expect(entry.adminUid, where).toBe(ADMIN.uid);
  expect(entry.adminEmail, where).toBe(ADMIN.email);
}

/** Seed, validate, invoke, and assert the whole Requirement 6.7 contract. */
async function runScenario(scenario: MutationScenario): Promise<void> {
  resetDoubles();
  scenario.prepare();

  const captured = capture(scenario.moduleFile, scenario.exportedSymbol);
  const handler = captured.handler;
  if (handler === null) throw new Error(`${scenario.exportedSymbol} declared no handler`);

  // The declared validator runs first, exactly as TanStack would run it, so the
  // payload reaching the handler is the validated one.
  const validated =
    captured.validator === null ? scenario.payload : captured.validator(scenario.payload);

  await handler({ data: validated as never, context: { user: ADMIN } });

  // Requirement 6.7: exactly one entry.
  const entries = auditDouble().entries();
  expect(auditDouble().entryCount(), `${scenario.label}: audit entry count`).toBe(1);
  expectWellFormedEntry(entries[0], scenario);

  // The privileged mutation really happened, so the entry is not recording a
  // no-op.
  scenario.expectMutated();

  // No credential, emulator, or deployed service was reached.
  expect(blockedNetworkAttempts(), scenario.label).toEqual([]);
}

// ---------------------------------------------------------------------------
// Property 19
// ---------------------------------------------------------------------------

describe("Feature: admin-quality-gates-and-shared-contracts, Property 19: Every privileged mutation records exactly one well-formed audit entry", () => {
  it("reads a non-trivial target-type union and captures every scenario handler", () => {
    // Non-vacuity: membership is a real constraint, and every handler the
    // scenarios name exists and registered a handler.
    expect(AUDIT_TARGET_TYPES.length).toBeGreaterThan(1);
    expect(new Set(AUDIT_TARGET_TYPES).size).toBe(AUDIT_TARGET_TYPES.length);

    for (const symbol of [
      "saveFact",
      "changeFactStatus",
      "addFact",
      "bulkImportFacts",
      "bulkUpdateFacts",
      "actOnReport",
    ]) {
      const captured = capture("src/lib/admin/content.functions.ts", symbol);
      expect(captured.handler, `${symbol} handler`).toBeTypeOf("function");
      expect(captured.middleware.length, `${symbol} middleware`).toBeGreaterThan(0);
    }
    expect(
      capture("src/lib/admin/roles.functions.ts", "setAdminRole").handler,
    ).toBeTypeOf("function");
    expect(
      capture("src/lib/admin/config.functions.ts", "saveRemoteConfigTopics").handler,
    ).toBeTypeOf("function");
  });

  it("records exactly one well-formed entry for any privileged mutation invocation", async () => {
    const seen = new Set<MutationPath>();

    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        await runScenario(scenario);
        seen.add(scenario.mutation);
        return true;
      }),
      { numRuns: 200 },
    );

    // Coverage is asserted, not assumed: every Privileged_Mutation_Path the
    // Glossary enumerates was actually exercised by the run above.
    expect([...seen].sort()).toEqual([...COVERED_MUTATIONS].sort());
  });

  it("covers each Privileged_Mutation_Path at least once deterministically", async () => {
    // A shrink-free, order-independent sweep: one sampled scenario per mutation
    // path, so a fast-check distribution change can never quietly drop a path.
    for (const arbitrary of SCENARIO_ARBITRARIES) {
      const [scenario] = fc.sample(arbitrary, { numRuns: 1, seed: 20260604 });
      await runScenario(scenario);
    }
  });

  it("writes no audit entry when the mutation never happens", async () => {
    // The counterpart of "exactly one": a rejected invocation must leave no
    // trail, so the count above is a real discriminator and not just "at most
    // one entry ever exists".
    resetDoubles();
    const captured = capture("src/lib/admin/content.functions.ts", "saveFact");
    const handler = captured.handler;
    if (handler === null) throw new Error("saveFact declared no handler");

    // A fact that does not exist: `updateFact` raises before the audit call.
    await expect(
      handler({ data: { id: "absent_fact", question: "?" } as never, context: { user: ADMIN } }),
    ).rejects.toThrow(/absent_fact/);

    expect(auditDouble().entryCount()).toBe(0);
    expect(firestoreDouble().writeCount()).toBe(0);
    expect(blockedNetworkAttempts()).toEqual([]);
  });
});
