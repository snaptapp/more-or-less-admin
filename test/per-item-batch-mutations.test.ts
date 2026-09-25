/**
 * Integration contract for per-fact import and bulk-update transactions.
 * The Firestore and TanStack seams are local in-memory doubles; no credential,
 * emulator, deployed service, or network endpoint is used.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  blockedNetworkAttempts,
  firestoreDouble,
  type AdminUser,
} from "./setup";

const control = vi.hoisted(() => ({
  transactionCount: 0,
  failAuditTargets: new Set<string>(),
}));

vi.mock("@/lib/firebase/firestore.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/firebase/firestore.server")>();
  const { firestoreDouble: double } = await import("./setup");
  return {
    ...actual,
    ...double().module,
    normalizeKey: actual.normalizeKey,
    factId: actual.factId,
    runTransaction: async <T>(
      work: (tx: import("@/lib/firebase/firestore.server").FirestoreTransaction) => Promise<T>,
    ): Promise<T> => {
      control.transactionCount += 1;
      return double().module.runTransaction(async (tx) => {
        const guarded: import("@/lib/firebase/firestore.server").FirestoreTransaction = {
          get: tx.get,
          update: tx.update,
          delete: tx.delete,
          set: (path, data) => {
            const targetId = path.startsWith("admin_audit_logs/") ? data["targetId"] : null;
            if (typeof targetId === "string" && control.failAuditTargets.has(targetId)) {
              throw new Error(`injected audit staging failure for ${targetId}`);
            }
            tx.set(path, data);
          },
        };
        return work(guarded);
      });
    },
  };
});

type Handler = (input: {
  data: unknown;
  context: { user: AdminUser };
}) => Promise<unknown>;

type Validator = (data: unknown) => unknown;

const harness = vi.hoisted(() => {
  interface Registered {
    validator: Validator | null;
    handler: Handler | null;
  }
  const registry = new Map<object, Registered>();

  const chain = (state: {
    options: Record<string, unknown>;
    middleware: unknown[];
    validator: Validator | null;
  }) => ({
    options: state.options,
    middleware: (values: unknown[]) =>
      chain({ ...state, middleware: [...state.middleware, ...values] }),
    validator: (value: Validator) => chain({ ...state, validator: value }),
    inputValidator: (value: Validator) => chain({ ...state, validator: value }),
    handler: (value: Handler) => {
      const token = { __serverFn: true };
      registry.set(token, { validator: state.validator, handler: value });
      return token;
    },
  });

  return {
    registry,
    createServerFn: (options: Record<string, unknown> = {}) =>
      chain({ options, middleware: [], validator: null }),
  };
});

vi.mock("@tanstack/react-start", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createServerFn: harness.createServerFn };
});

vi.mock("@/lib/admin/middleware", () => ({
  authMiddleware: { __authMiddleware: true },
  authedServerFn: harness.createServerFn,
}));

import {
  BulkUpdatePartialFailureError,
  type BulkUpdateResult,
  type ImportFactInput,
  type ImportFactsResult,
} from "@/lib/admin/content.server";
import { factId, normalizeKey } from "@/lib/firebase/firestore.server";

const contentFunctions = await import("@/lib/admin/content.functions");

const ADMIN: AdminUser = {
  uid: "admin-batch-25",
  email: "ops@example.com",
  name: "Ops Operator",
  isClaimAdmin: true,
};

const SEED_FACT = {
  subject: "Seeded subject",
  subject_key: "seeded subject",
  angle: "Seeded angle",
  angle_key: "seeded angle",
  question: "old question?",
  claim_template: "Seeded claim {n}",
  explanation: "Seeded explanation",
  true_number: 7,
  unit: "units",
  status: "active",
  content_rating: "standard",
  surprise_factor: 1,
  source_urls: [],
  served_count: 0,
} as const;

function handlerFor(token: object): Handler {
  const captured = harness.registry.get(token);
  if (!captured?.handler) throw new Error("server function did not register a handler");
  return captured.handler;
}

function importInput(subject: string, angle: string): ImportFactInput {
  return {
    subject,
    angle,
    true_number: 7,
    unit: "units",
    claim_template: `${subject} has {n} ${angle}.`,
    explanation: `A verified statement about ${subject}.`,
    question: `How many ${angle} does ${subject} have?`,
    quantity_kind: "count",
  };
}

async function importId(input: ImportFactInput): Promise<string> {
  return factId(normalizeKey(input.subject), normalizeKey(input.angle));
}

function seedFact(id: string, question = "old question?"): void {
  firestoreDouble().seed(`fact_bank/${id}`, { ...SEED_FACT, question });
}

function auditDocuments() {
  return firestoreDouble()
    .documents()
    .filter((doc) => doc.path.startsWith("admin_audit_logs/"));
}

function auditTargetIds(): string[] {
  return auditDocuments().map((doc) => String(doc.data["targetId"]));
}

beforeEach(() => {
  control.transactionCount = 0;
  control.failAuditTargets.clear();
  firestoreDouble().reset();
});

describe("per-item fact import and bulk update transactions", () => {
  it("commits each imported fact with exactly one audit and reports deterministic partial results", async () => {
    const rows = [
      importInput("First subject", "first count"),
      importInput("Second subject", "second count"),
      importInput("Third subject", "third count"),
    ];
    control.failAuditTargets.add(await importId(rows[1]));

    const result = (await handlerFor(contentFunctions.bulkImportFacts)({
      data: { facts: rows },
      context: { user: ADMIN },
    })) as ImportFactsResult;

    expect(result.operation).toBe("import");
    expect(result.atomicity).toBe("per-item");
    expect(result.batchAtomic).toBe(false);
    expect(result.failurePolicy).toBe("continue");
    expect(result.partialSuccess).toBe(true);
    expect(result.successful).toBe(false);
    expect(result.counts).toEqual({
      total: 3,
      persisted: 2,
      skipped: 0,
      failed: 1,
      notAttempted: 0,
    });
    expect(result.items.map((item) => item.status)).toEqual(["persisted", "failed", "persisted"]);
    expect(result.failedId).toBe(await importId(rows[1]));
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.summary).toMatch(/not batch-atomic/i);
    expect(control.transactionCount).toBe(3);
    expect(auditTargetIds().sort()).toEqual(
      [await importId(rows[0]), await importId(rows[2])].sort(),
    );
    expect(firestoreDouble().document(`fact_bank/${await importId(rows[1])}`)).toBeNull();
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("treats a duplicate import row as skipped without a success audit", async () => {
    const row = importInput("Duplicate subject", "duplicate count");
    const result = (await handlerFor(contentFunctions.bulkImportFacts)({
      data: { facts: [row, { ...row }] },
      context: { user: ADMIN },
    })) as ImportFactsResult;

    expect(result.counts).toEqual({
      total: 2,
      persisted: 1,
      skipped: 1,
      failed: 0,
      notAttempted: 0,
    });
    expect(result.partialSuccess).toBe(false);
    expect(result.successful).toBe(true);
    expect(control.transactionCount).toBe(2);
    expect(auditDocuments()).toHaveLength(1);
    expect(auditTargetIds()).toEqual([await importId(row)]);
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("commits one fact and one audit transaction for every successful bulk edit", async () => {
    const updates = [
      { id: "fact-a", question: "updated a?" },
      { id: "fact-b", question: "updated b?" },
      { id: "fact-c", question: "updated c?" },
    ];
    for (const update of updates) seedFact(update.id);

    const result = (await handlerFor(contentFunctions.bulkUpdateFacts)({
      data: { updates },
      context: { user: ADMIN },
    })) as BulkUpdateResult;

    expect(result.operation).toBe("bulk-update");
    expect(result.batchAtomic).toBe(false);
    expect(result.atomicity).toBe("per-item");
    expect(result.partialSuccess).toBe(false);
    expect(result.successful).toBe(true);
    expect(result.count).toBe(3);
    expect(result.editedIds).toEqual(updates.map((update) => update.id));
    expect(result.persistedIds).toEqual(updates.map((update) => update.id));
    expect(result.notAttemptedIds).toEqual([]);
    expect(control.transactionCount).toBe(3);
    expect(auditTargetIds().sort()).toEqual(updates.map((update) => update.id).sort());
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("stops at a failed audit, preserves the committed prefix, and leaves the suffix unattempted", async () => {
    const updates = [
      { id: "fact-a", question: "updated a?" },
      { id: "fact-b", question: "updated b?" },
      { id: "fact-c", question: "updated c?" },
    ];
    for (const update of updates) seedFact(update.id);
    control.failAuditTargets.add("fact-b");

    let error: unknown = null;
    try {
      await handlerFor(contentFunctions.bulkUpdateFacts)({
        data: { updates },
        context: { user: ADMIN },
      });
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(BulkUpdatePartialFailureError);
    if (!(error instanceof BulkUpdatePartialFailureError)) return;
    expect(error.failedId).toBe("fact-b");
    expect(error.result.count).toBe(1);
    expect(error.result.editedIds).toEqual(["fact-a"]);
    expect(error.result.persistedIds).toEqual(["fact-a"]);
    expect(error.result.failedIds).toEqual(["fact-b"]);
    expect(error.result.notAttemptedIds).toEqual(["fact-c"]);
    expect(error.result.partialSuccess).toBe(true);
    expect(error.result.batchAtomic).toBe(false);
    expect(control.transactionCount).toBe(2);
    expect(auditTargetIds()).toEqual(["fact-a"]);
    expect(firestoreDouble().document("fact_bank/fact-a")?.data["question"]).toBe("updated a?");
    expect(firestoreDouble().document("fact_bank/fact-b")?.data["question"]).toBe("old question?");
    expect(firestoreDouble().document("fact_bank/fact-c")?.data["question"]).toBe("old question?");
    expect(blockedNetworkAttempts()).toEqual([]);
  });
});
