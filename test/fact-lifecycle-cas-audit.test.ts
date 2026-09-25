/**
 * Fact lifecycle CAS and audit atomicity contract.
 *
 * The transaction seam is exercised with a local in-memory runner. It records
 * every staged write, can abort one attempt before commit, and then reads the
 * store again for the retry. No credential, emulator, or network endpoint is
 * involved.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  blockedNetworkAttempts,
  firestoreDouble,
  type AdminUser,
} from "./setup";

interface StagedWrite {
  readonly kind: "set" | "update" | "delete";
  readonly path: string;
  readonly data?: Record<string, unknown>;
  readonly deletePaths?: readonly string[];
  readonly updateTime?: string;
  readonly exists?: boolean;
}

const control = vi.hoisted(() => ({
  attempts: 0,
  contentionFailures: 0,
  beforeRetry: undefined as (() => void | Promise<void>) | undefined,
  failAuditStaging: false,
  staged: [] as Array<StagedWrite>,
}));

vi.mock("@/lib/firebase/firestore.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/firebase/firestore.server")>();
  const { firestoreDouble: double } = await import("./setup");

  return {
    ...actual,
    ...double().module,
    // Keep the canonical key normalizer while retaining the local transaction
    // runner and the rest of the in-memory service surface.
    normalizeKey: actual.normalizeKey,
    runTransaction: async <T>(
      work: (tx: import("@/lib/firebase/firestore.server").FirestoreTransaction) => Promise<T>,
    ): Promise<T> => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        control.attempts += 1;
        const writes: StagedWrite[] = [];
        let writesQueued = false;
        const tx: import("@/lib/firebase/firestore.server").FirestoreTransaction = {
          get: async (path: string) => {
            if (writesQueued) {
              throw new Error("Firestore transaction reads must occur before queued writes");
            }
            return double().module.getDoc(path);
          },
          set: (path: string, data: Record<string, unknown>): void => {
            writesQueued = true;
            if (control.failAuditStaging && path.startsWith("admin_audit_logs/")) {
              throw new Error("injected audit staging failure");
            }
            const write = { kind: "set" as const, path, data };
            writes.push(write);
            control.staged.push(write);
          },
          update: (
            path: string,
            data: Record<string, unknown>,
            options?: import("@/lib/firebase/firestore.server").FirestoreTransactionUpdateOptions,
          ): void => {
            writesQueued = true;
            const write: StagedWrite = {
              kind: "update",
              path,
              data,
              ...(options?.deletePaths ? { deletePaths: options.deletePaths } : {}),
              ...(options?.updateTime !== undefined ? { updateTime: options.updateTime } : {}),
              ...(options?.exists !== undefined ? { exists: options.exists } : {}),
            };
            writes.push(write);
            control.staged.push(write);
          },
          delete: (path: string): void => {
            writesQueued = true;
            const write = { kind: "delete" as const, path };
            writes.push(write);
            control.staged.push(write);
          },
        };

        try {
          const result = await work(tx);
          if (control.contentionFailures > 0) {
            control.contentionFailures -= 1;
            if (control.beforeRetry) await control.beforeRetry();
            continue;
          }

          // Commit is atomic for this test double: all preconditions are checked
          // before any staged write is handed to the ordinary in-memory methods.
          for (const write of writes) {
            if (write.kind === "delete") {
              await double().module.deleteDoc(write.path);
              continue;
            }
            const current = double().document(write.path);
            if (write.updateTime !== undefined && current?.updateTime !== write.updateTime) {
              throw new Error(`FAILED_PRECONDITION: stale updateTime for ${write.path}`);
            }
            if (write.kind === "set") {
              if (!current) {
                const [collection, documentId] = write.path.split("/");
                if (!collection || !documentId) {
                  throw new Error(`invalid test document path: ${write.path}`);
                }
                await double().module.createDoc(collection, documentId, write.data ?? {});
                continue;
              }
              const deletePaths = Object.keys(current.data).filter(
                (field) => !(field in (write.data ?? {})),
              );
              await double().module.patchDoc(write.path, write.data ?? {}, deletePaths);
              continue;
            }
            if (!current) {
              throw new Error(`FAILED_PRECONDITION: missing update target ${write.path}`);
            }
            await double().module.patchDoc(write.path, write.data ?? {}, [
              ...(write.deletePaths ?? []),
            ]);
          }
          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const contention =
            /\bABORTED\b/i.test(message) || /too much contention/i.test(message);
          if (!contention || attempt === 4) throw error;
        }
      }
      throw new Error("transaction retry budget exhausted");
    },
  };
});

import { buildAuditEntry } from "@/lib/firebase/audit.server";
import { setFactStatus, updateFact, FactStatusTransitionError, FactIdentityChangeError } from "@/lib/admin/content.server";

const ADMIN: AdminUser = {
  uid: "admin-cas",
  email: "ops@example.com",
  name: "Ops Operator",
  isClaimAdmin: true,
};

const AUDIT_CREATED_AT = "2026-09-24T08:00:00.000Z";

function preparedAudit(overrides: Partial<Parameters<typeof buildAuditEntry>[1]> = {}) {
  return buildAuditEntry(
    ADMIN,
    {
      action: "fact.update",
      targetType: "fact",
      targetId: "fact-cas",
      details: "CAS test",
      after: { question: "updated?" },
      ...overrides,
    },
    { id: "audit-stable", createdAt: AUDIT_CREATED_AT },
  );
}

function seedFact(overrides: Record<string, unknown> = {}) {
  return firestoreDouble().seed(`fact_bank/fact-cas`, {
    subject: "Stable subject",
    subject_key: "stable subject",
    angle: "Stable angle",
    angle_key: "stable angle",
    question: "old question?",
    claim_template: "Stable claim {n}",
    explanation: "Stable explanation",
    true_number: 7,
    unit: "units",
    status: "disputed",
    verifier_model: "banked_auditor",
    verified_at: "2026-09-23T00:00:00.000Z",
    retired_reason: "old retirement",
    source_urls: [],
    served_count: 0,
    ...overrides,
  });
}

function resetControl(): void {
  control.attempts = 0;
  control.contentionFailures = 0;
  control.beforeRetry = undefined;
  control.failAuditStaging = false;
  control.staged = [];
  firestoreDouble().reset();
}

beforeEach(() => {
  resetControl();
});

describe("fact lifecycle transaction CAS and audit", () => {
  it("uses the exact current updateTime and commits one fact plus one audit", async () => {
    const seeded = seedFact();

    await updateFact({ id: "fact-cas", question: "new question?" }, preparedAudit());

    const update = control.staged.find(
      (write) => write.kind === "update" && write.path === "fact_bank/fact-cas",
    );
    expect(update?.updateTime).toBe(seeded.updateTime);
    expect(control.staged.filter((write) => write.path === "fact_bank/fact-cas")).toHaveLength(1);
    expect(control.staged.filter((write) => write.path.startsWith("admin_audit_logs/"))).toHaveLength(1);
    expect(firestoreDouble().document("admin_audit_logs/audit-stable")?.data["action"]).toBe(
      "fact.update",
    );
    expect(firestoreDouble().document("fact_bank/fact-cas")?.data["question"]).toBe(
      "new question?",
    );
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("re-reads and revalidates the contract after a contention retry", async () => {
    seedFact({ status: "disputed" });
    control.contentionFailures = 1;
    control.beforeRetry = () => {
      const current = firestoreDouble().document("fact_bank/fact-cas");
      if (!current) throw new Error("fixture disappeared");
      firestoreDouble().seed("fact_bank/fact-cas", {
        ...current.data,
        status: "retired",
      });
    };

    await expect(
      setFactStatus({ id: "fact-cas", status: "active" }, preparedAudit()),
    ).rejects.toBeInstanceOf(FactStatusTransitionError);

    expect(control.attempts).toBe(2);
    expect(firestoreDouble().writeCount()).toBe(0);
    expect(firestoreDouble().document("fact_bank/fact-cas")?.data["status"]).toBe("retired");
    expect(firestoreDouble().document("admin_audit_logs/audit-stable")).toBeNull();
  });

  it("reuses one audit identity across retries and applies only the fresh attempt", async () => {
    const seeded = seedFact();
    control.contentionFailures = 1;
    control.beforeRetry = () => {
      const current = firestoreDouble().document("fact_bank/fact-cas");
      if (!current) throw new Error("fixture disappeared");
      firestoreDouble().seed("fact_bank/fact-cas", {
        ...current.data,
        question: "fresh question?",
      });
    };

    await updateFact({ id: "fact-cas", question: "requested question?" }, preparedAudit());

    const auditWrites = control.staged.filter((write) => write.path.startsWith("admin_audit_logs/"));
    expect(auditWrites).toHaveLength(2);
    expect(new Set(auditWrites.map((write) => write.path))).toEqual(
      new Set(["admin_audit_logs/audit-stable"]),
    );
    expect(firestoreDouble().document("fact_bank/fact-cas")?.updateTime).not.toBe(seeded.updateTime);
    expect(firestoreDouble().document("admin_audit_logs/audit-stable")?.data["createdAt"]).toBe(
      AUDIT_CREATED_AT,
    );
  });

  it("rolls back the fact when audit staging fails", async () => {
    const before = seedFact().data;
    control.failAuditStaging = true;

    await expect(
      updateFact({ id: "fact-cas", question: "must not persist?" }, preparedAudit()),
    ).rejects.toThrow(/injected audit staging failure/);

    expect(firestoreDouble().writeCount()).toBe(0);
    expect(firestoreDouble().document("fact_bank/fact-cas")?.data).toEqual(before);
    expect(firestoreDouble().document("admin_audit_logs/audit-stable")).toBeNull();
  });

  it("keeps identity immutable and never lets admin promote pending to active", async () => {
    seedFact({ status: "pending" });
    const before = firestoreDouble().document("fact_bank/fact-cas")?.data;

    await expect(
      setFactStatus({ id: "fact-cas", status: "active" }, preparedAudit()),
    ).rejects.toBeInstanceOf(FactStatusTransitionError);
    expect(firestoreDouble().writeCount()).toBe(0);

    await expect(
      updateFact(
        { id: "fact-cas", subject: "Changed subject", question: "must not persist?" },
        preparedAudit(),
      ),
    ).rejects.toBeInstanceOf(FactIdentityChangeError);
    expect(firestoreDouble().document("fact_bank/fact-cas")?.data).toEqual(before);
    expect(firestoreDouble().document("admin_audit_logs/audit-stable")).toBeNull();
  });

  it("preserves auditor verification metadata without adding it on active transition", async () => {
    const seeded = seedFact({ status: "disputed" });

    const record = await setFactStatus(
      { id: "fact-cas", status: "active", verifierModel: "untrusted-admin-model" },
      preparedAudit({ after: { status: "active", verifier_model: "untrusted-admin-model" } }),
    );
    const stored = firestoreDouble().document("fact_bank/fact-cas");
    const audit = firestoreDouble().document("admin_audit_logs/audit-stable");

    expect(record.status).toBe("active");
    expect(stored?.data["verified_at"]).toBe("2026-09-23T00:00:00.000Z");
    expect(stored?.data["verifier_model"]).toBe("banked_auditor");
    const transition = control.staged.find(
      (write) => write.kind === "update" && write.path === "fact_bank/fact-cas",
    );
    expect(transition?.updateTime).toBe(seeded.updateTime);
    expect(transition?.data).not.toHaveProperty("verified_at");
    expect(transition?.data).not.toHaveProperty("verifier_model");
    expect(audit?.data["after"]).toEqual({ status: "active", reason: null });
  });
});
