/**
 * Lease-safety contract for the Admin crawl enqueue path.
 *
 * The only persistence seam is the in-memory Firestore double. The transaction
 * runner below mirrors the production rule that reads finish before writes and
 * that a contention retry evaluates the callback again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FirestoreDoc, FirestoreTransaction, Json } from "@/lib/firebase/firestore.server";
import { blockedNetworkAttempts, firestoreDouble } from "./setup";

const NOW = new Date("2026-09-24T12:00:00.000Z");
const NOW_ISO = NOW.toISOString();
const OLD_ISO = "2026-09-24T11:00:00.000Z";

const transactionControl = vi.hoisted(() => ({
  contentionFailures: 0,
  attempts: 0,
  beforeRetry: undefined as (() => void | Promise<void>) | undefined,
}));

type StagedWrite =
  | { kind: "set" | "update"; path: string; data: Record<string, unknown> }
  | { kind: "delete"; path: string };

vi.mock("@/lib/firebase/firestore.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/firebase/firestore.server")>();
  const { firestoreDouble: double } = await import("./setup");

  return {
    ...actual,
    ...double().module,
    // Keep the production canonical key normalizer; the historical test double
    // still models the pre-canonical underscore form for older suites.
    normalizeKey: actual.normalizeKey,
    runTransaction: async <T>(work: (tx: FirestoreTransaction) => Promise<T>): Promise<T> => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        transactionControl.attempts += 1;
        const writes: StagedWrite[] = [];
        let writesQueued = false;
        const tx: FirestoreTransaction = {
          get: async (path: string): Promise<FirestoreDoc | null> => {
            if (writesQueued) {
              throw new Error("Firestore transaction reads must occur before queued writes");
            }
            return double().module.getDoc(path);
          },
          set: (path: string, data: Record<string, unknown>) => {
            writesQueued = true;
            writes.push({ kind: "set", path, data });
          },
          update: (path: string, data: Record<string, unknown>) => {
            writesQueued = true;
            writes.push({ kind: "update", path, data });
          },
          delete: (path: string) => {
            writesQueued = true;
            writes.push({ kind: "delete", path });
          },
        };

        const result = await work(tx);
        if (transactionControl.contentionFailures > 0) {
          transactionControl.contentionFailures -= 1;
          if (transactionControl.beforeRetry) await transactionControl.beforeRetry();
          continue;
        }

        for (const write of writes) {
          if (write.kind === "delete") {
            await double().module.deleteDoc(write.path);
            continue;
          }
          if (write.kind === "update") {
            await double().module.patchDoc(write.path, write.data);
            continue;
          }

          const existing = double().document(write.path);
          if (!existing) {
            const [collection, documentId] = write.path.split("/");
            if (!collection || !documentId) {
              throw new Error(`invalid test document path: ${write.path}`);
            }
            await double().module.createDoc(collection, documentId, write.data);
            continue;
          }
          const deletePaths = Object.keys(existing.data).filter((field) => !(field in write.data));
          await double().module.patchDoc(write.path, write.data, deletePaths);
        }
        return result;
      }
      throw new Error("transaction contention retry budget exhausted");
    },
  };
});

import { decideEnqueueAction, enqueueSubject } from "@/lib/admin/ops.server";

function resetTransactionControl(): void {
  transactionControl.contentionFailures = 0;
  transactionControl.attempts = 0;
  transactionControl.beforeRetry = undefined;
}

function queueData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subject: "Giraffe",
    subject_key: "giraffe",
    priority: 3,
    status: "queued",
    requested_by: "manual",
    refresh: false,
    enqueued_at: OLD_ISO,
    updated_at: OLD_ISO,
    completed_at: null,
    ...overrides,
  };
}

function storedData(path: string): Record<string, Json> {
  return firestoreDouble().document(path)?.data ?? {};
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  firestoreDouble().reset();
  resetTransactionControl();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Go queue decision table", () => {
  it.each([
    ["missing", null, "insert"],
    ["queued", { status: "queued" }, "skip"],
    ["completed", { status: "completed" }, "requeue"],
    ["done", { status: "done" }, "requeue"],
    ["failed", { status: "failed" }, "requeue"],
    ["unknown", { status: "unexpected" }, "requeue"],
    [
      "active processing lease",
      { status: "processing", claim_expires_at: "2026-09-24T12:10:00.000Z" },
      "skip",
    ],
    [
      "expired processing lease",
      { status: "processing", claim_expires_at: "2026-09-24T11:59:59.000Z" },
      "requeue",
    ],
    ["missing processing lease", { status: "processing" }, "requeue"],
  ])("classifies %s as %s", (_label, existing, expected) => {
    expect(decideEnqueueAction(existing as Record<string, unknown> | null, NOW)).toBe(expected);
  });
});

describe("Admin enqueue transaction", () => {
  it("inserts a new queue item after reading the subject and queue documents", async () => {
    const result = await enqueueSubject({ subject: "Giraffe", priority: 0 });

    expect(result).toEqual({
      subject: "Giraffe",
      subjectKey: "giraffe",
      action: "inserted",
    });
    expect(firestoreDouble().reads().map((read) => read.target)).toEqual([
      "fact_subjects/giraffe",
      "crawl_queue/giraffe",
    ]);
    expect(firestoreDouble().writeCount()).toBe(1);
    const write = firestoreDouble().writes()[0];
    expect(write?.kind).toBe("create");
    expect(write?.data).toMatchObject({
      subject: "Giraffe",
      subject_key: "giraffe",
      priority: 5,
      status: "queued",
      requested_by: "manual",
      refresh: false,
      enqueued_at: NOW_ISO,
      updated_at: NOW_ISO,
      claim_token: null,
      claiming_agent: null,
      claim_expires_at: null,
    });
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("never resets an actively processing lease to queued", async () => {
    const path = "crawl_queue/giraffe";
    const before = firestoreDouble().seed(
      path,
      queueData({
        status: "processing",
        claim_token: "lease-1",
        claiming_agent: "foundry-a",
        claimed_by: "foundry-a",
        claim_expires_at: "2026-09-24T12:10:00.000Z",
        claimed_at: OLD_ISO,
      }),
    );

    const result = await enqueueSubject({ subject: "Giraffe", priority: 100, refresh: true });

    expect(result.action).toBe("skipped");
    expect(firestoreDouble().writeCount()).toBe(0);
    expect(storedData(path)).toEqual(before.data);
    expect(storedData(path)["status"]).toBe("processing");
    expect(storedData(path)["claim_token"]).toBe("lease-1");
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("upgrades an unclaimed queued item without changing its enqueue time", async () => {
    const path = "crawl_queue/giraffe";
    firestoreDouble().seed("fact_subjects/giraffe", { subject: "Giraffe", category: "Animals & Nature" });
    const before = firestoreDouble().seed(
      path,
      queueData({ priority: 2, refresh: false, enqueued_at: OLD_ISO, updated_at: OLD_ISO }),
    );

    const result = await enqueueSubject({
      subject: "Giraffe",
      priority: 8,
      refresh: true,
      category: "animals & nature",
    });

    expect(result.action).toBe("requeued");
    expect(firestoreDouble().writeCount()).toBe(1);
    expect(firestoreDouble().writes()[0]?.kind).toBe("patch");
    expect(storedData(path)).toMatchObject({
      status: "queued",
      priority: 8,
      refresh: true,
      category: "Animals & Nature",
      enqueued_at: before.data["enqueued_at"],
      updated_at: NOW_ISO,
    });
    expect(storedData(path)["enqueued_at"]).toBe(OLD_ISO);
    expect(storedData(path)["status"]).toBe("queued");
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("preserves a queued item when no upgrade is requested", async () => {
    const path = "crawl_queue/giraffe";
    const before = firestoreDouble().seed(path, queueData({ priority: 10, refresh: true }));

    const result = await enqueueSubject({
      subject: "Giraffe",
      priority: 2,
      refresh: false,
      category: "Music",
    });

    expect(result.action).toBe("skipped");
    expect(firestoreDouble().writeCount()).toBe(0);
    expect(storedData(path)).toEqual(before.data);
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it.each(["done", "failed", "unknown", "expired"])(
    "requeues a %s document with fresh timestamps and cleared lease fields",
    async (status) => {
      const path = "crawl_queue/giraffe";
      firestoreDouble().seed("fact_subjects/giraffe", { subject: "Giraffe" });
      firestoreDouble().seed(
        path,
        queueData({
          status: status === "expired" ? "processing" : status,
          priority: 9,
          refresh: false,
          completed_at: OLD_ISO,
          claim_token: "old-token",
          claiming_agent: "old-agent",
          claimed_by: "old-agent",
          claim_expires_at:
            status === "expired" ? "2026-09-24T11:59:59.000Z" : "2026-09-24T12:30:00.000Z",
          claimed_at: OLD_ISO,
        }),
      );

      const result = await enqueueSubject({ subject: "Giraffe", priority: 3 });

      expect(result.action).toBe("requeued");
      expect(firestoreDouble().writeCount()).toBe(1);
      expect(storedData(path)).toMatchObject({
        status: "queued",
        priority: 9,
        refresh: true,
        enqueued_at: NOW_ISO,
        updated_at: NOW_ISO,
        completed_at: null,
        claim_token: null,
        claiming_agent: null,
        claimed_by: null,
        claim_expires_at: null,
        claimed_at: null,
      });
      expect(blockedNetworkAttempts()).toEqual([]);
    },
  );

  it("re-evaluates the complete decision after transaction contention", async () => {
    const path = "crawl_queue/giraffe";
    firestoreDouble().seed(path, queueData({ status: "queued", priority: 1 }));
    transactionControl.contentionFailures = 1;
    transactionControl.beforeRetry = () => {
      firestoreDouble().seed("fact_subjects/giraffe", { subject: "Giraffe" });
      const current = firestoreDouble().document(path);
      if (!current) throw new Error("expected the queue fixture to exist");
      firestoreDouble().seed(path, { ...current.data, status: "done", completed_at: OLD_ISO });
    };

    const result = await enqueueSubject({ subject: "Giraffe", priority: 5 });

    expect(transactionControl.attempts).toBe(2);
    expect(result.action).toBe("requeued");
    expect(firestoreDouble().reads()).toHaveLength(4);
    expect(storedData(path)["status"]).toBe("queued");
    expect(storedData(path)["refresh"]).toBe(true);
    expect(storedData(path)["enqueued_at"]).toBe(NOW_ISO);
    expect(blockedNetworkAttempts()).toEqual([]);
  });
});
