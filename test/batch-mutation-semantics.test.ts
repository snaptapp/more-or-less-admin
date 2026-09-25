/**
 * Contract tests for subtask fact-bank-correctness-21.
 *
 * These tests exercise the contract-only module with local in-memory
 * transactions. No Firestore, audit service, network, clock, or production
 * handler is imported or invoked.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  BATCH_MUTATION_SEMANTICS,
  BatchSemanticsError,
  commitFactAndAudit,
  defaultFailurePolicy,
  runPerItemBatch,
  summarizeBatch,
  type BatchItemOutcome,
  type FactAuditTransaction,
} from "@/lib/admin/batch-mutation-semantics";
import { blockedNetworkAttempts } from "./setup";

interface FactPayload {
  readonly id: string;
  readonly value: string;
}

interface AuditPayload {
  readonly id: string;
  readonly factId: string;
  readonly value: string;
}

interface MemoryStore {
  readonly facts: Map<string, FactPayload>;
  readonly audits: Map<string, AuditPayload>;
  readonly stagedFacts: FactPayload[];
  readonly stagedAudits: AuditPayload[];
  readonly failAuditFor: Set<string>;
  readonly failCommitFor: Set<string>;
  commits: number;
  rollbacks: number;
}

function createStore(
  failAuditFor: readonly string[] = [],
  failCommitFor: readonly string[] = [],
): MemoryStore {
  return {
    facts: new Map(),
    audits: new Map(),
    stagedFacts: [],
    stagedAudits: [],
    failAuditFor: new Set(failAuditFor),
    failCommitFor: new Set(failCommitFor),
    commits: 0,
    rollbacks: 0,
  };
}

function transactionFor(
  store: MemoryStore,
): FactAuditTransaction<FactPayload, AuditPayload> {
  return {
    stageFact(fact) {
      store.stagedFacts.push(fact);
    },
    stageAudit(audit) {
      if (store.failAuditFor.has(audit.factId)) {
        throw new Error(`audit staging failed for ${audit.factId}`);
      }
      store.stagedAudits.push(audit);
    },
    async commit() {
      store.commits += 1;
      if (store.stagedFacts.length !== 1 || store.stagedAudits.length !== 1) {
        throw new Error("a fact and its audit must be staged together");
      }
      const fact = store.stagedFacts[0];
      const audit = store.stagedAudits[0];
      if (fact === undefined || audit === undefined || audit.factId !== fact.id) {
        throw new Error("staged audit does not belong to the staged fact");
      }
      if (store.failCommitFor.has(fact.id)) {
        throw new Error(`commit failed for ${fact.id}`);
      }
      store.facts.set(fact.id, fact);
      store.audits.set(audit.id, audit);
      store.stagedFacts.length = 0;
      store.stagedAudits.length = 0;
    },
    async rollback() {
      store.rollbacks += 1;
      store.stagedFacts.length = 0;
      store.stagedAudits.length = 0;
    },
  };
}

function persisted(): BatchItemOutcome {
  return { status: "persisted", auditCommitted: true };
}

function failed(id: string): BatchItemOutcome {
  return {
    status: "failed",
    failure: { code: "injected_failure", message: `failed ${id}` },
  };
}

function notAttempted(): BatchItemOutcome {
  return { status: "not-attempted", reason: "not attempted by the test" };
}

describe("fact-bank per-item mutation semantics", () => {
  it("states per-item fact+audit atomicity and rejects batch-level atomicity", () => {
    // Arrange
    const semantics = BATCH_MUTATION_SEMANTICS;

    // Act
    const serialized = JSON.stringify(semantics);

    // Assert
    expect(semantics.atomicity).toBe("per-item");
    expect(semantics.transactionScope).toBe("one-fact");
    expect(semantics.factAndAudit).toBe("same-transaction");
    expect(semantics.auditEntriesPerPersistedFact).toBe(1);
    expect(semantics.batchAtomic).toBe(false);
    expect(semantics.ordering).toBe("input-order");
    expect(semantics.partialResults).toBe("deterministic");
    expect(serialized).not.toContain('"batchAtomic":true');
  });

  it("commits one fact and its audit together on a successful per-item transaction", async () => {
    // Arrange
    const store = createStore();
    const transaction = transactionFor(store);
    const fact: FactPayload = { id: "fact-a", value: "updated-a" };
    const audit: AuditPayload = {
      id: "audit-a",
      factId: fact.id,
      value: "fact.update:fact-a",
    };

    // Act
    const result = await commitFactAndAudit(transaction, fact, audit);

    // Assert
    expect(result).toEqual({ committed: true });
    expect(store.facts.get("fact-a")).toEqual(fact);
    expect(store.audits.get("audit-a")).toEqual(audit);
    expect(store.commits).toBe(1);
    expect(store.rollbacks).toBe(0);
    expect(store.stagedFacts).toEqual([]);
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("rolls back the fact when its audit cannot be staged", async () => {
    // Arrange
    const store = createStore(["fact-b"]);
    const transaction = transactionFor(store);
    const fact: FactPayload = { id: "fact-b", value: "must-not-persist" };
    const audit: AuditPayload = { id: "audit-b", factId: fact.id, value: "must-not-persist" };

    // Act
    const attempt = commitFactAndAudit(transaction, fact, audit);

    // Assert
    await expect(attempt).rejects.toThrow("audit staging failed for fact-b");
    expect(store.facts.size).toBe(0);
    expect(store.audits.size).toBe(0);
    expect(store.rollbacks).toBe(1);
    expect(store.commits).toBe(0);
  });

  it("rolls back both staged writes when the per-item commit fails", async () => {
    // Arrange
    const store = createStore([], ["fact-b"]);
    const transaction = transactionFor(store);
    const fact: FactPayload = { id: "fact-b", value: "must-not-persist" };
    const audit: AuditPayload = { id: "audit-b", factId: fact.id, value: "must-not-persist" };

    // Act
    const attempt = commitFactAndAudit(transaction, fact, audit);

    // Assert
    await expect(attempt).rejects.toThrow("commit failed for fact-b");
    expect(store.facts.size).toBe(0);
    expect(store.audits.size).toBe(0);
    expect(store.stagedFacts).toEqual([]);
    expect(store.stagedAudits).toEqual([]);
    expect(store.rollbacks).toBe(1);
    expect(store.commits).toBe(1);
  });

  it("records a skipped import row without a fact write or success audit", async () => {
    // Arrange
    const store = createStore();
    const execute = async (): Promise<BatchItemOutcome> => ({
      status: "skipped",
      reason: "identity already exists",
    });

    // Act
    const result = await runPerItemBatch("import", ["fact-existing"], execute);

    // Assert
    expect(result.successful).toBe(true);
    expect(result.partialSuccess).toBe(false);
    expect(result.skippedIds).toEqual(["fact-existing"]);
    expect(result.persistedIds).toEqual([]);
    expect(result.items).toEqual([
      { index: 0, id: "fact-existing", status: "skipped", reason: "identity already exists" },
    ]);
    expect(store.commits).toBe(0);
    expect(store.facts.size).toBe(0);
    expect(store.audits.size).toBe(0);
  });

  it("continues independent import rows after one row fails", async () => {
    // Arrange
    const ids = ["fact-a", "fact-b", "fact-c"];
    const calls: string[] = [];
    const execute = async (id: string): Promise<BatchItemOutcome> => {
      calls.push(id);
      return id === "fact-b" ? failed(id) : persisted();
    };

    // Act
    const result = await runPerItemBatch("import", ids, execute);

    // Assert
    expect(calls).toEqual(ids);
    expect(result.failurePolicy).toBe("continue");
    expect(result.successful).toBe(false);
    expect(result.partialSuccess).toBe(true);
    expect(result.failedId).toBe("fact-b");
    expect(result.persistedIds).toEqual(["fact-a", "fact-c"]);
    expect(result.failedIds).toEqual(["fact-b"]);
    expect(result.skippedIds).toEqual([]);
    expect(result.notAttemptedIds).toEqual([]);
    expect(result.counts).toEqual({
      total: 3,
      persisted: 2,
      skipped: 0,
      failed: 1,
      notAttempted: 0,
    });
    expect(result.items.map((item) => [item.index, item.id, item.status])).toEqual([
      [0, "fact-a", "persisted"],
      [1, "fact-b", "failed"],
      [2, "fact-c", "persisted"],
    ]);
  });

  it("keeps a 500-row import per-item and deterministic when one row fails", async () => {
    // Arrange
    const ids = Array.from({ length: 500 }, (_, index) => `fact-${index}`);
    const failureId = "fact-250";
    const calls: string[] = [];
    const execute = async (id: string): Promise<BatchItemOutcome> => {
      calls.push(id);
      return id === failureId ? failed(id) : persisted();
    };

    // Act
    const result = await runPerItemBatch("import", ids, execute);

    // Assert
    expect(calls).toEqual(ids);
    expect(result.total).toBe(500);
    expect(result.counts).toEqual({
      total: 500,
      persisted: 499,
      skipped: 0,
      failed: 1,
      notAttempted: 0,
    });
    expect(result.failedId).toBe(failureId);
    expect(result.persistedIds).toEqual(ids.filter((id) => id !== failureId));
    expect(result.partialSuccess).toBe(true);
    expect(result.successful).toBe(false);
  });

  it("stops a bulk update at the first failed item and reports the unattempted suffix", async () => {
    // Arrange
    const ids = ["fact-a", "fact-b", "fact-c"];
    const calls: string[] = [];
    const execute = async (id: string): Promise<BatchItemOutcome> => {
      calls.push(id);
      return id === "fact-b" ? failed(id) : persisted();
    };

    // Act
    const result = await runPerItemBatch("bulk-update", ids, execute);

    // Assert
    expect(calls).toEqual(["fact-a", "fact-b"]);
    expect(result.failurePolicy).toBe("stop");
    expect(result.successful).toBe(false);
    expect(result.partialSuccess).toBe(true);
    expect(result.persistedIds).toEqual(["fact-a"]);
    expect(result.failedIds).toEqual(["fact-b"]);
    expect(result.notAttemptedIds).toEqual(["fact-c"]);
    expect(result.items.map((item) => item.status)).toEqual([
      "persisted",
      "failed",
      "not-attempted",
    ]);
  });

  it("uses exactly one transaction and one audit for every persisted fact", async () => {
    // Arrange
    const store = createStore();
    const ids = ["fact-a", "fact-b", "fact-c"];
    const execute = async (id: string): Promise<BatchItemOutcome> => {
      await commitFactAndAudit(
        transactionFor(store),
        { id, value: `value-${id}` },
        { id: `audit-${id}`, factId: id, value: `audit-${id}` },
      );
      return persisted();
    };

    // Act
    const result = await runPerItemBatch("import", ids, execute);

    // Assert
    expect(result.successful).toBe(true);
    expect(result.persistedIds).toEqual(ids);
    expect(store.commits).toBe(ids.length);
    expect(store.facts.size).toBe(ids.length);
    expect(store.audits.size).toBe(ids.length);
    expect([...store.audits.values()].map((audit) => audit.factId)).toEqual(ids);
    expect(store.rollbacks).toBe(0);
  });

  it("preserves the committed prefix when a later item transaction fails", async () => {
    // Arrange
    const store = createStore(["fact-b"]);
    const ids = ["fact-a", "fact-b", "fact-c"];
    const execute = async (id: string): Promise<BatchItemOutcome> => {
      const transaction = transactionFor(store);
      await commitFactAndAudit(
        transaction,
        { id, value: `value-${id}` },
        { id: `audit-${id}`, factId: id, value: `audit-${id}` },
      );
      return persisted();
    };

    // Act
    const result = await runPerItemBatch("bulk-update", ids, execute);

    // Assert
    expect(result.failedId).toBe("fact-b");
    expect(result.persistedIds).toEqual(["fact-a"]);
    expect(result.notAttemptedIds).toEqual(["fact-c"]);
    expect([...store.facts.keys()]).toEqual(["fact-a"]);
    expect([...store.audits.keys()]).toEqual(["audit-fact-a"]);
    expect(store.facts.has("fact-b")).toBe(false);
    expect(store.audits.has("audit-b")).toBe(false);
    expect(store.commits).toBe(1);
    expect(store.rollbacks).toBe(1);
    expect(result.counts).toEqual({
      total: 3,
      persisted: 1,
      skipped: 0,
      failed: 1,
      notAttempted: 1,
    });
  });

  it("produces the same serialized result for the same input and outcomes", () => {
    // Arrange
    const ids = ["z", "a", "m"];
    const outcomes: BatchItemOutcome[] = [
      persisted(),
      failed("a"),
      { status: "skipped", reason: "already present" },
    ];

    // Act
    const first = summarizeBatch("import", ids, outcomes);
    const second = summarizeBatch("import", [...ids], outcomes.map((outcome) => ({ ...outcome })));

    // Assert
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(second.items.map((item) => item.id)).toEqual(["z", "a", "m"]);
    expect(second.persistedIds).toEqual(["z"]);
    expect(second.failedIds).toEqual(["a"]);
    expect(second.skippedIds).toEqual(["m"]);
    expect(first.partialSuccess).toBe(true);
    expect(first.successful).toBe(false);
  });

  it("rejects a persisted outcome that has no committed audit", () => {
    // Arrange
    const malformed = [
      { status: "persisted", auditCommitted: false },
    ] as unknown as BatchItemOutcome[];

    // Act
    const attempt = () => summarizeBatch("import", ["fact-a"], malformed);

    // Assert
    expect(attempt).toThrow(BatchSemanticsError);
    expect(attempt).toThrow(/auditCommitted=true/);
  });

  it("rejects outcome arrays that cannot describe the input deterministically", () => {
    // Arrange
    const tooFewOutcomes = [persisted()];
    const laterPersistedAfterStop: BatchItemOutcome[] = [failed("fact-a"), persisted()];
    const stopWithoutFailure: BatchItemOutcome[] = [notAttempted()];
    const continueWithUnattempted: BatchItemOutcome[] = [notAttempted()];

    // Act
    const lengthAttempt = () => summarizeBatch("import", ["a", "b"], tooFewOutcomes);
    const stopAttempt = () => summarizeBatch("bulk-update", ["a", "b"], laterPersistedAfterStop);
    const stopBeforeFailureAttempt = () => summarizeBatch("bulk-update", ["a"], stopWithoutFailure);
    const continueAttempt = () => summarizeBatch("import", ["a"], continueWithUnattempted);

    // Assert
    expect(lengthAttempt).toThrow(/one outcome is required per id/);
    expect(stopAttempt).toThrow(/not-attempted after a failure/);
    expect(stopBeforeFailureAttempt).toThrow(/before a failure/);
    expect(continueAttempt).toThrow(/cannot leave item/);
  });

  it("rejects an empty fact id before invoking the executor", async () => {
    // Arrange
    const calls: string[] = [];
    const execute = async (id: string): Promise<BatchItemOutcome> => {
      calls.push(id);
      return persisted();
    };

    // Act
    const attempt = runPerItemBatch("import", [""], execute);

    // Assert
    await expect(attempt).rejects.toBeInstanceOf(BatchSemanticsError);
    expect(calls).toEqual([]);
  });

  it("validates the whole id list before starting any per-item transaction", async () => {
    // Arrange
    const calls: string[] = [];
    const execute = async (id: string): Promise<BatchItemOutcome> => {
      calls.push(id);
      return persisted();
    };

    // Act
    const attempt = runPerItemBatch("import", ["fact-a", ""], execute);

    // Assert
    await expect(attempt).rejects.toBeInstanceOf(BatchSemanticsError);
    expect(calls).toEqual([]);
  });

  it("derives explicit operation policies and rejects an unknown operation", () => {
    // Arrange
    const unknown = "not-an-operation" as never;

    // Act
    const importPolicy = defaultFailurePolicy("import");
    const bulkPolicy = defaultFailurePolicy("bulk-update");
    const unknownAttempt = () => defaultFailurePolicy(unknown);

    // Assert
    expect(importPolicy).toBe("continue");
    expect(bulkPolicy).toBe("stop");
    expect(unknownAttempt).toThrow(/Unknown batch operation/);
  });

  it("documents the contract without claiming a globally atomic import or bulk batch", () => {
    // Arrange
    const documentUrl = new URL("../docs/BATCH_MUTATION_SEMANTICS.md", import.meta.url);
    const document = readFileSync(documentUrl, "utf8");

    // Act
    const lowerDocument = document.toLowerCase();

    // Assert
    expect(document).toMatch(/per-item/i);
    expect(document).toMatch(/audit/i);
    expect(document).toMatch(/input order/i);
    expect(document).toMatch(/partial/i);
    expect(lowerDocument).toMatch(/not (?:a )?batch[- ]atomic/);
    expect(lowerDocument).not.toMatch(/the batch is atomic/);
    expect(blockedNetworkAttempts()).toEqual([]);
  });
});
