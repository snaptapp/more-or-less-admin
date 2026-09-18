/**
 * Feature: admin-quality-gates-and-shared-contracts
 *
 * Properties over the `bulkUpdateFacts` privileged mutation path — the batch
 * fact-edit endpoint whose missing implementation was the latent runtime defect
 * this spec set out to close.
 *
 * Property 14: `bulkUpdateFacts` persists a valid batch exactly and completely
 *   *For any* batch of 1 to 200 edits that each satisfy the edit schema,
 *   `bulkUpdateFacts` persists every edit and returns a count equal to the
 *   number of edits, and writes exactly one audit entry whose `targetType` is
 *   `fact` and whose `targetId` is the single edited fact id when the batch has
 *   one edit or a non-empty batch id (with the full edited-id list in the entry
 *   payload) when the batch has two or more edits.
 *   Validates: Requirements 3.2, 3.3
 *
 * Property 15: `bulkUpdateFacts` rejects an invalid batch with no side effects
 *   *For any* batch that is empty, exceeds 200 edits, or contains an edit
 *   violating the schema, `bulkUpdateFacts` rejects the invocation before any
 *   Firestore write, leaves every targeted document unchanged, writes no audit
 *   entry, and returns an error identifying the violated rule.
 *   Validates: Requirements 3.4
 *
 * Property 16: `bulkUpdateFacts` applies a persisted prefix on partial failure
 *   *For any* batch and any failure position k (1-indexed) at which persistence
 *   fails, `bulkUpdateFacts` stops applying further edits, returns an error
 *   naming the fact id whose edit failed, and writes at most one audit entry
 *   listing exactly the identifiers of the edits persisted before the failure.
 *   Validates: Requirements 3.5
 *
 * Design notes
 * ------------
 * Two call paths matter and both are exercised:
 *
 *   - the module export `bulkUpdateFacts` in `src/lib/admin/content.server.ts`,
 *     which owns pre-write validation, ordered application, and the persisted
 *     prefix on failure;
 *   - the `bulkUpdateFacts` server function in `src/lib/admin/content.functions.ts`,
 *     which owns the *single* audit entry per batch that wrote anything.
 *
 * Requirements 3.3 and 3.5 are audit claims, so every assertion about audit
 * entries goes through the handler. Reaching the handler needs the same
 * recording `createServerFn` seam `test/server-functions.property.test.ts`
 * established (TanStack Start does not expose `options` on what `.handler()`
 * returns), plus a mocked `@/lib/admin/middleware` so importing the functions
 * module pulls in nothing client-only. `content.server` itself is the real
 * module: only Firestore and the audit log are replaced by the in-memory
 * doubles from `test/setup.ts`, so no credential, emulator, or deployed service
 * is reached and the network guard stays silent.
 *
 * Generated edits deliberately never set `category`: assigning one makes
 * `updateFact` touch `fact_subjects` as well, which would decouple "one edit"
 * from "one recorded write" and blunt the write-count assertions that carry
 * Requirements 3.4 and 3.5. `category` is still exercised — as an *invalid*
 * value in Property 15.
 */
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import {
  auditDouble,
  blockedNetworkAttempts,
  firestoreDouble,
  toJson,
  type AdminUser,
  type Json,
  type RecordedAuditEntry,
} from "./setup";

// ---------------------------------------------------------------------------
// Recording harness for the server-function handler (hoisted above the mocks)
// ---------------------------------------------------------------------------

/** The handler shape this file invokes. `updates` is deliberately `unknown[]`:
 *  a batch arrives from the wire as untrusted JSON, and Requirement 3.4 is
 *  about rejecting values the declared input type forbids. */
type BulkHandlerInput = {
  data: { updates: unknown[] };
  context: { user: AdminUser };
};
type BulkHandler = (input: BulkHandlerInput) => Promise<BulkUpdateResultShape>;
type CapturedValidator = (data: unknown) => unknown;

/** What `bulkUpdateFacts` resolves to, restated so the harness stays typed
 *  without importing from the module it wraps. */
interface BulkUpdateResultShape {
  count: number;
  editedIds: string[];
  failedId?: string;
}

interface CapturedServerFn {
  middleware: readonly unknown[];
  validator: CapturedValidator | null;
  handler: BulkHandler | null;
}

const harness = vi.hoisted(() => {
  interface ChainState {
    factoryOptions: Record<string, unknown> | undefined;
    middleware: unknown[];
    validator: CapturedValidator | null;
  }

  /** `.handler()` returns a token object; the module exports that token, so a
   *  test can map an export back to what its chain declared. */
  const registry = new Map<object, CapturedServerFn>();

  const makeChain = (state: ChainState): Record<string, unknown> => ({
    options: state.factoryOptions,
    middleware: (list: unknown[]) =>
      makeChain({ ...state, middleware: [...state.middleware, ...list] }),
    validator: (fn: CapturedValidator) => makeChain({ ...state, validator: fn }),
    inputValidator: (fn: CapturedValidator) => makeChain({ ...state, validator: fn }),
    handler: (fn: BulkHandler) => {
      const token = {
        __recordedServerFn: true,
        method: state.factoryOptions?.["method"] ?? "GET",
      };
      registry.set(token, {
        middleware: state.middleware,
        validator: state.validator,
        handler: fn,
      });
      return token;
    },
  });

  const createServerFn = (options?: Record<string, unknown>) =>
    makeChain({ factoryOptions: options, middleware: [], validator: null });

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

vi.mock("@tanstack/react-start", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createServerFn: harness.createServerFn,
    createMiddleware: harness.createMiddleware,
  };
});

// Keeps the functions-module import graph off `@/lib/firebase/client` (the
// Firebase web SDK); authorization itself is covered by the requireAdmin tests.
vi.mock("@/lib/admin/middleware", () => ({
  authMiddleware: harness.authMiddleware,
  authedServerFn: harness.authedServerFn,
}));

// The only two seams: persistence and the audit log (Requirement 6.10).
vi.mock("@/lib/firebase/firestore.server", async () => {
  const { firestoreDouble: double } = await import("./setup");
  return double().module;
});
vi.mock("@/lib/firebase/audit.server", async () => {
  const { auditDouble: double } = await import("./setup");
  return double().module;
});

// ---------------------------------------------------------------------------
// Modules under test
// ---------------------------------------------------------------------------

import {
  BULK_UPDATE_MAX_BATCH,
  BULK_UPDATE_MIN_BATCH,
  BulkUpdatePartialFailureError,
  BulkUpdateValidationError,
  bulkUpdateFacts,
  type FactEditInput,
} from "@/lib/admin/content.server";
import { normalizeKey } from "@/lib/firebase/firestore.server";

const contentFunctions = await import("@/lib/admin/content.functions");

const capturedBulkUpdate: CapturedServerFn | undefined = harness.registry.get(
  contentFunctions.bulkUpdateFacts,
);
if (!capturedBulkUpdate || capturedBulkUpdate.handler === null) {
  throw new Error(
    "the bulkUpdateFacts server function did not register a handler with the recording createServerFn",
  );
}
const bulkUpdateHandler: BulkHandler = capturedBulkUpdate.handler;
const bulkUpdateValidator: CapturedValidator | null = capturedBulkUpdate.validator;

const ADMIN: AdminUser = {
  uid: "admin-bulk-1",
  email: "ops@example.com",
  name: "Ops Operator",
  isClaimAdmin: true,
};

/** Invoke the server-function handler the way TanStack would, post-middleware. */
async function invokeHandler(updates: readonly unknown[]): Promise<BulkUpdateResultShape> {
  return bulkUpdateHandler({ data: { updates: [...updates] }, context: { user: ADMIN } });
}

// ---------------------------------------------------------------------------
// Fixtures and generators
// ---------------------------------------------------------------------------

/** The stored document every targeted fact starts from. Untouched documents are
 *  compared field-for-field against this, so "unchanged" is a real assertion. */
const SEED_DOC = {
  subject: "Seeded subject",
  subject_key: "seeded_subject",
  angle: "Seeded angle",
  angle_key: "seeded_angle",
  question: "Seeded question?",
  claim_template: "Seeded claim",
  context: "Seeded context",
  true_number: 1,
  unit: "units",
  status: "active",
  content_rating: "standard",
  surprise_factor: 1,
  source_urls: [],
  served_count: 0,
} as const;

const SEED_DOC_JSON = toJson(SEED_DOC);

const QUANTITY_KINDS = [
  "year",
  "count",
  "percentage",
  "ratio",
  "physical_measure",
  "money",
  "duration",
  "rating",
  "",
] as const;

function optional<T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> {
  return fc.option(arb, { nil: undefined });
}

/** Id fragment built from a fixed alphabet so every id is a legal single
 *  Firestore path segment (no `/`, never empty). */
const idFragmentArb = fc
  .array(fc.constantFrom("a", "b", "c", "d", "e", "f", "0", "1", "2", "3", "_"), {
    minLength: 3,
    maxLength: 8,
  })
  .map((chars) => chars.join(""));

/**
 * Fields of one schema-valid edit. `question` is always present so the edit
 * always produces a patch — an id-only edit is schema-valid but writes nothing,
 * which would make "every edit is reflected in Firestore" vacuous.
 */
const editFieldsArb = fc.record({
  question: fc.string({ minLength: 1, maxLength: 40 }),
  subject: optional(fc.string({ minLength: 1, maxLength: 24 })),
  angle: optional(fc.string({ minLength: 1, maxLength: 24 })),
  claim_template: optional(fc.string({ maxLength: 40 })),
  context: optional(fc.string({ maxLength: 40 })),
  unit: optional(fc.string({ maxLength: 12 })),
  true_number: optional(fc.double({ min: -1e9, max: 1e9, noNaN: true })),
  surprise_factor: optional(fc.integer({ min: 0, max: 3 })),
  content_rating: optional(fc.constantFrom("standard", "after_dark")),
  source_urls: optional(fc.array(fc.string({ maxLength: 16 }), { maxLength: 3 })),
  quantity_kind: optional(fc.constantFrom(...QUANTITY_KINDS)),
  plausible_min: optional(fc.string({ maxLength: 12 })),
  plausible_max: optional(fc.string({ maxLength: 12 })),
});

/** A batch of `size` schema-valid edits with distinct ids. */
function batchOfSize(sizeArb: fc.Arbitrary<number>): fc.Arbitrary<FactEditInput[]> {
  return sizeArb
    .chain((size) =>
      fc.array(fc.tuple(idFragmentArb, editFieldsArb), { minLength: size, maxLength: size }),
    )
    .map((entries) =>
      entries.map(([fragment, fields], index) => ({ id: `f${index}_${fragment}`, ...fields })),
    );
}

/** A minimal schema-valid edit — used where only the batch *size* matters. */
function minimalBatchOfSize(sizeArb: fc.Arbitrary<number>): fc.Arbitrary<FactEditInput[]> {
  return sizeArb
    .chain((size) => fc.array(idFragmentArb, { minLength: size, maxLength: size }))
    .map((fragments) =>
      fragments.map((fragment, index) => ({
        id: `f${index}_${fragment}`,
        question: `Question ${index}?`,
      })),
    );
}

/**
 * Batch sizes across the accepted range: weighted towards the small batches an
 * operator actually submits, with the 1-edit case (the single-fact `targetId`
 * branch of Requirement 3.3) and the upper bound both well represented.
 */
const validBatchSizeArb = fc.oneof(
  { weight: 4, arbitrary: fc.constant(BULK_UPDATE_MIN_BATCH) },
  { weight: 7, arbitrary: fc.integer({ min: BULK_UPDATE_MIN_BATCH, max: 8 }) },
  { weight: 1, arbitrary: fc.integer({ min: 150, max: BULK_UPDATE_MAX_BATCH }) },
);

/** Reset both doubles: `beforeEach` runs per test, not per fast-check run. */
function resetDoubles(): void {
  firestoreDouble().reset();
  auditDouble().reset();
}

function factPath(id: string): string {
  return `fact_bank/${id}`;
}

/** Seed `fact_bank` for every edit in the batch, optionally leaving one out so
 *  `updateFact` cannot find it. Seeding records no write. */
function seedTargets(updates: readonly FactEditInput[], skipIndex: number | null = null): void {
  updates.forEach((update, index) => {
    if (index === skipIndex) return;
    firestoreDouble().seed(factPath(update.id), { ...SEED_DOC });
  });
}

/** Fields `updateFact` assigns straight from the edit input. */
const ASSIGNED_KEYS = [
  "subject",
  "angle",
  "unit",
  "claim_template",
  "context",
  "question",
  "surprise_factor",
  "content_rating",
  "source_urls",
  "quantity_kind",
  "plausible_min",
  "plausible_max",
  "true_number",
] as const;

/** What the stored document must carry for this edit to count as persisted. */
function expectedStoredFields(edit: FactEditInput): Record<string, Json> {
  const expected: Record<string, Json> = {};
  for (const key of ASSIGNED_KEYS) {
    const value = edit[key];
    if (value === undefined) continue;
    expected[key] = toJson(value);
  }
  // Derived keys, via the same pure helper production uses.
  if (edit.subject !== undefined) expected["subject_key"] = normalizeKey(edit.subject);
  if (edit.angle !== undefined) expected["angle_key"] = normalizeKey(edit.angle);
  return expected;
}

/** Assert the stored document reflects every field the edit supplied. */
function expectEditPersisted(edit: FactEditInput): void {
  const doc = firestoreDouble().document(factPath(edit.id));
  if (doc === null) throw new Error(`fact ${edit.id} is absent after a successful bulk update`);

  const expected = expectedStoredFields(edit);
  const actual: Record<string, Json> = {};
  for (const key of Object.keys(expected)) actual[key] = doc.data[key];

  expect(actual, `stored fields for ${edit.id}`).toEqual(expected);
  expect(typeof doc.data["updated_at"], `updated_at for ${edit.id}`).toBe("string");
}

/** Assert the stored document is byte-for-byte the seeded baseline. */
function expectTargetUntouched(edit: FactEditInput): void {
  const doc = firestoreDouble().document(factPath(edit.id));
  if (doc === null) throw new Error(`seeded fact ${edit.id} vanished`);
  expect(doc.data, `untouched document ${edit.id}`).toEqual(SEED_DOC_JSON);
}

/** The `after` payload of a bulk-update audit entry, read without a cast. */
function readAuditAfter(entry: RecordedAuditEntry): {
  count: number | null;
  editedIds: string[];
  failedId: string | null;
} {
  const after = entry.after;
  if (after === null || typeof after !== "object" || Array.isArray(after)) {
    return { count: null, editedIds: [], failedId: null };
  }
  const count = typeof after["count"] === "number" ? after["count"] : null;
  const rawIds = after["editedIds"];
  return {
    count,
    editedIds: Array.isArray(rawIds)
      ? rawIds.filter((value): value is string => typeof value === "string")
      : [],
    failedId: typeof after["failedId"] === "string" ? after["failedId"] : null,
  };
}

/**
 * The single audit entry Requirements 3.3 / 3.5 mandate: `fact.bulk_update`,
 * `targetType: "fact"`, a non-empty `targetId` that is the fact id itself for a
 * one-edit batch, and the persisted-id list in the payload.
 */
function expectSingleBulkAuditEntry(
  persistedIds: readonly string[],
  failedId: string | null = null,
): void {
  const entries = auditDouble().entries();
  expect(entries).toHaveLength(1);
  const entry = entries[0];

  expect(entry.action).toBe("fact.bulk_update");
  expect(entry.targetType).toBe("fact");
  expect(entry.targetId.length).toBeGreaterThan(0);
  if (persistedIds.length === 1) expect(entry.targetId).toBe(persistedIds[0]);
  expect(entry.adminUid).toBe(ADMIN.uid);

  const after = readAuditAfter(entry);
  expect(after.count).toBe(persistedIds.length);
  expect(after.editedIds).toEqual([...persistedIds]);
  expect(after.failedId).toBe(failedId);
}

// ---------------------------------------------------------------------------
// Property 14
// ---------------------------------------------------------------------------

describe("Feature: admin-quality-gates-and-shared-contracts, Property 14: `bulkUpdateFacts` persists a valid batch exactly and completely", () => {
  it("persists every edit of a 1..200 batch, returns the exact count and ids, and writes exactly one audit entry", async () => {
    await fc.assert(
      fc.asyncProperty(batchOfSize(validBatchSizeArb), async (updates) => {
        resetDoubles();
        seedTargets(updates);

        // The declared input validator accepts the batch, so the property is
        // about genuinely valid input at the endpoint boundary.
        if (bulkUpdateValidator !== null) bulkUpdateValidator({ updates });

        const result = await invokeHandler(updates);

        // Requirement 3.2: every edit persisted, count equal to the batch size.
        expect(result.count).toBe(updates.length);
        expect(result.editedIds).toEqual(updates.map((update) => update.id));
        expect(result.failedId).toBeUndefined();

        for (const edit of updates) expectEditPersisted(edit);

        // One write per edit: the batch touched exactly its own targets.
        expect(firestoreDouble().writeCount()).toBe(updates.length);

        // Requirement 3.3: exactly one audit entry for the whole batch.
        expectSingleBulkAuditEntry(updates.map((update) => update.id));

        expect(blockedNetworkAttempts()).toEqual([]);
        return true;
      }),
      { numRuns: 120 },
    );
  });

  it("attributes a one-edit batch to the fact itself and a multi-edit batch to a generated batch id", async () => {
    await fc.assert(
      fc.asyncProperty(batchOfSize(fc.integer({ min: 2, max: 6 })), async (updates) => {
        resetDoubles();
        seedTargets(updates);

        await invokeHandler(updates);
        const multiTargetId = auditDouble().entries()[0].targetId;
        expect(multiTargetId.length).toBeGreaterThan(0);
        // A multi-edit batch has no single document to key on, so the id is a
        // generated batch id rather than any one edited fact.
        expect(updates.map((update) => update.id)).not.toContain(multiTargetId);

        // The same batch reduced to its first edit is attributed to that fact.
        const single = [updates[0]];
        resetDoubles();
        seedTargets(single);
        await invokeHandler(single);
        expect(auditDouble().entries()[0].targetId).toBe(single[0].id);

        return true;
      }),
      { numRuns: 100 },
    );
  });

  it("agrees with the module export: the handler adds the audit entry and nothing else", async () => {
    await fc.assert(
      fc.asyncProperty(batchOfSize(fc.integer({ min: 1, max: 6 })), async (updates) => {
        resetDoubles();
        seedTargets(updates);

        // The module export is the persistence authority and writes no audit
        // entry of its own (Requirement 3.3: exactly one, from the handler).
        const direct = await bulkUpdateFacts(updates);
        expect(direct.count).toBe(updates.length);
        expect(direct.editedIds).toEqual(updates.map((update) => update.id));
        expect(auditDouble().entryCount()).toBe(0);
        for (const edit of updates) expectEditPersisted(edit);

        return true;
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 15
// ---------------------------------------------------------------------------

/** An invalid batch, the rule it must be reported against, and the edit index
 *  the rule applies to (null for the whole-batch size rules). */
interface InvalidBatchCase<T> {
  updates: T[];
  rule: RegExp;
  index: number | null;
  label: string;
}

/**
 * Invalid batches that still satisfy the *declared* `FactEditInput` type, so
 * they can be handed to both the module export and the handler: the two batch
 * size rules plus value-level schema violations.
 */
const typedInvalidBatchArb: fc.Arbitrary<InvalidBatchCase<FactEditInput>> = fc.oneof(
  // Empty batch (Requirement 3.4).
  fc.constant({
    updates: [] as FactEditInput[],
    rule: new RegExp(`^batch size >= ${BULK_UPDATE_MIN_BATCH}$`),
    index: null,
    label: "empty batch",
  }),
  // Over the upper bound (Requirement 3.4).
  minimalBatchOfSize(fc.integer({ min: BULK_UPDATE_MAX_BATCH + 1, max: BULK_UPDATE_MAX_BATCH + 6 })).map(
    (updates) => ({
      updates,
      rule: new RegExp(`^batch size <= ${BULK_UPDATE_MAX_BATCH}$`),
      index: null,
      label: `oversize batch (${updates.length})`,
    }),
  ),
  // One schema-violating edit at a generated position.
  batchOfSize(fc.integer({ min: 1, max: 6 }))
    .chain((updates) =>
      fc.tuple(
        fc.constant(updates),
        fc.integer({ min: 0, max: updates.length - 1 }),
        fc.constantFrom<{ field: string; mutate: (edit: FactEditInput) => FactEditInput }>(
          { field: "id", mutate: (edit) => ({ ...edit, id: "" }) },
          { field: "surprise_factor", mutate: (edit) => ({ ...edit, surprise_factor: 4 }) },
          { field: "surprise_factor", mutate: (edit) => ({ ...edit, surprise_factor: -1 }) },
          { field: "surprise_factor", mutate: (edit) => ({ ...edit, surprise_factor: 1.5 }) },
          { field: "quantity_kind", mutate: (edit) => ({ ...edit, quantity_kind: "bananas" }) },
          { field: "content_rating", mutate: (edit) => ({ ...edit, content_rating: "spicy" }) },
          { field: "category", mutate: (edit) => ({ ...edit, category: "not-a-genre" }) },
        ),
      ),
    )
    .map(([updates, index, violation]) => ({
      updates: updates.map((edit, position) => (position === index ? violation.mutate(edit) : edit)),
      rule: new RegExp(`^${violation.field}: `),
      index,
      label: `${violation.field} violation at index ${index}`,
    })),
);

/**
 * Invalid batches carrying values the declared type forbids outright — the
 * shape untrusted JSON actually arrives in. These go through the handler, whose
 * batch parameter is the wire boundary.
 */
const untypedInvalidBatchArb: fc.Arbitrary<InvalidBatchCase<unknown>> = batchOfSize(
  fc.integer({ min: 1, max: 6 }),
)
  .chain((updates) =>
    fc.tuple(
      fc.constant(updates),
      fc.integer({ min: 0, max: updates.length - 1 }),
      fc.constantFrom<{ field: string; mutate: (edit: FactEditInput) => unknown }>(
        { field: "id", mutate: ({ id: _id, ...rest }) => ({ ...rest }) },
        { field: "true_number", mutate: (edit) => ({ ...edit, true_number: "12" }) },
        { field: "unit", mutate: (edit) => ({ ...edit, unit: 42 }) },
        { field: "question", mutate: (edit) => ({ ...edit, question: 7 }) },
        { field: "source_urls", mutate: (edit) => ({ ...edit, source_urls: "https://example.com" }) },
        { field: "plausible_min", mutate: (edit) => ({ ...edit, plausible_min: 5 }) },
        { field: "edit", mutate: () => null },
        { field: "edit", mutate: (edit) => edit.id },
      ),
    ),
  )
  .map(([updates, index, violation]) => ({
    updates: updates.map((edit, position): unknown =>
      position === index ? violation.mutate(edit) : edit,
    ),
    rule: new RegExp(`^${violation.field}: `),
    index,
    label: `${violation.field} type violation at index ${index}`,
  }));

/** Seed whatever targets an invalid batch names, so "left unchanged" is real. */
function seedInvalidTargets(updates: readonly unknown[]): FactEditInput[] {
  const seeded: FactEditInput[] = [];
  for (const update of updates) {
    if (update === null || typeof update !== "object") continue;
    const id = (update as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) continue;
    firestoreDouble().seed(factPath(id), { ...SEED_DOC });
    seeded.push({ id });
  }
  return seeded;
}

/** Run one invalid batch through a call path and assert the full no-side-effect
 *  contract of Requirement 3.4. */
async function expectRejectedWithoutSideEffects(
  invoke: () => Promise<unknown>,
  expectation: { rule: RegExp; index: number | null; label: string },
  seeded: readonly FactEditInput[],
): Promise<void> {
  const before = JSON.stringify(firestoreDouble().documents());

  let error: unknown = null;
  try {
    await invoke();
  } catch (thrown) {
    error = thrown;
  }

  expect(error, `${expectation.label} was accepted`).toBeInstanceOf(BulkUpdateValidationError);
  if (error instanceof BulkUpdateValidationError) {
    // The error identifies the violated rule (Requirement 3.4).
    expect(error.rule, expectation.label).toMatch(expectation.rule);
    expect(error.index, expectation.label).toBe(expectation.index);
    expect(error.message.length).toBeGreaterThan(0);
  }

  // Rejected before any Firestore write, with every targeted document intact.
  expect(firestoreDouble().writeCount(), expectation.label).toBe(0);
  expect(JSON.stringify(firestoreDouble().documents()), expectation.label).toBe(before);
  for (const target of seeded) expectTargetUntouched(target);

  // No audit entry for a batch that wrote nothing (Requirement 3.4).
  expect(auditDouble().entryCount(), expectation.label).toBe(0);
  expect(blockedNetworkAttempts()).toEqual([]);
}

describe("Feature: admin-quality-gates-and-shared-contracts, Property 15: `bulkUpdateFacts` rejects an invalid batch with no side effects", () => {
  it("rejects an empty, oversize, or schema-violating batch before any write, through both the module export and the handler", async () => {
    await fc.assert(
      fc.asyncProperty(typedInvalidBatchArb, async (testCase) => {
        // The module export owns pre-write validation.
        resetDoubles();
        const seeded = seedInvalidTargets(testCase.updates);
        await expectRejectedWithoutSideEffects(
          () => bulkUpdateFacts(testCase.updates),
          testCase,
          seeded,
        );

        // The handler surfaces the same rejection and adds no audit entry.
        resetDoubles();
        const seededAgain = seedInvalidTargets(testCase.updates);
        await expectRejectedWithoutSideEffects(
          () => invokeHandler(testCase.updates),
          testCase,
          seededAgain,
        );

        return true;
      }),
      { numRuns: 120 },
    );
  });

  it("rejects an edit whose value type differs from the declared schema type, naming the field", async () => {
    await fc.assert(
      fc.asyncProperty(untypedInvalidBatchArb, async (testCase) => {
        resetDoubles();
        const seeded = seedInvalidTargets(testCase.updates);
        await expectRejectedWithoutSideEffects(
          () => invokeHandler(testCase.updates),
          testCase,
          seeded,
        );
        return true;
      }),
      { numRuns: 120 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 16
// ---------------------------------------------------------------------------

/** Assert the persisted prefix, and only the prefix, landed. */
function expectPersistedPrefix(updates: readonly FactEditInput[], failureIndex: number): void {
  updates.forEach((edit, index) => {
    if (index < failureIndex) {
      expectEditPersisted(edit);
      return;
    }
    if (index === failureIndex) return; // handled by the caller: absent or write-failed
    expectTargetUntouched(edit);
  });
  // One write per persisted edit and not one more.
  expect(firestoreDouble().writeCount()).toBe(failureIndex);
}

describe("Feature: admin-quality-gates-and-shared-contracts, Property 16: `bulkUpdateFacts` applies a persisted prefix on partial failure", () => {
  it("stops at the failing edit, names its fact id, and persists exactly the prefix before it", async () => {
    const scenario = fc
      .integer({ min: 1, max: 10 })
      .chain((size) =>
        fc.tuple(batchOfSize(fc.constant(size)), fc.integer({ min: 0, max: size - 1 })),
      );

    await fc.assert(
      fc.asyncProperty(scenario, async ([updates, failureIndex]) => {
        resetDoubles();
        // Every target exists except the one at the failure position, so
        // `updateFact` raises there — the batch is already mid-flight.
        seedTargets(updates, failureIndex);

        let error: unknown = null;
        try {
          await invokeHandler(updates);
        } catch (thrown) {
          error = thrown;
        }

        expect(error).toBeInstanceOf(BulkUpdatePartialFailureError);
        if (!(error instanceof BulkUpdatePartialFailureError)) return false;

        const persistedIds = updates.slice(0, failureIndex).map((update) => update.id);

        // Requirement 3.5: the error names the fact whose edit failed.
        expect(error.failedId).toBe(updates[failureIndex].id);
        expect(error.message).toContain(updates[failureIndex].id);
        expect(error.result.count).toBe(failureIndex);
        expect(error.result.editedIds).toEqual(persistedIds);
        expect(error.result.failedId).toBe(updates[failureIndex].id);

        // Only the prefix persisted; the failing target was never created.
        expect(firestoreDouble().document(factPath(updates[failureIndex].id))).toBeNull();
        expectPersistedPrefix(updates, failureIndex);

        // At most one audit entry, listing exactly the persisted ids.
        expect(auditDouble().entryCount()).toBeLessThanOrEqual(1);
        if (failureIndex > 0) {
          expectSingleBulkAuditEntry(persistedIds, updates[failureIndex].id);
        } else if (auditDouble().entryCount() === 1) {
          expectSingleBulkAuditEntry(persistedIds, updates[failureIndex].id);
        }

        expect(blockedNetworkAttempts()).toEqual([]);
        return true;
      }),
      { numRuns: 120 },
    );
  });

  it("persists nothing and records no edited id when the very first write fails", async () => {
    await fc.assert(
      fc.asyncProperty(batchOfSize(fc.integer({ min: 1, max: 8 })), async (updates) => {
        resetDoubles();
        seedTargets(updates);
        // A genuine persistence failure rather than a missing document: the
        // first `patchDoc` of the batch rejects.
        firestoreDouble().failNextWrite();

        let error: unknown = null;
        try {
          await invokeHandler(updates);
        } catch (thrown) {
          error = thrown;
        }

        expect(error).toBeInstanceOf(BulkUpdatePartialFailureError);
        if (!(error instanceof BulkUpdatePartialFailureError)) return false;

        expect(error.failedId).toBe(updates[0].id);
        expect(error.result.count).toBe(0);
        expect(error.result.editedIds).toEqual([]);

        // Nothing landed: every target is still the seeded baseline.
        expect(firestoreDouble().writeCount()).toBe(0);
        for (const edit of updates) expectTargetUntouched(edit);

        expect(auditDouble().entryCount()).toBeLessThanOrEqual(1);
        const entries = auditDouble().entries();
        if (entries.length === 1) {
          expect(readAuditAfter(entries[0]).editedIds).toEqual([]);
          expect(entries[0].targetId.length).toBeGreaterThan(0);
        }

        expect(blockedNetworkAttempts()).toEqual([]);
        return true;
      }),
      { numRuns: 100 },
    );
  });
});
