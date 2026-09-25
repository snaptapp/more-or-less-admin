/**
 * Corrected replacements are an immutable, one-transaction correction path.
 * The local Firestore and TanStack doubles prove the write shape without
 * contacting credentials, an emulator, a deployed worker, or production data.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  blockedNetworkAttempts,
  firestoreDouble,
  type AdminUser,
} from "./setup";
import { buildAuditEntry } from "@/lib/firebase/audit.server";
import { factId, normalizeKey } from "@/lib/firebase/firestore.server";
import { PENDING_FACT_STATUS } from "@/lib/admin/fact-admission";
import { QK } from "@/lib/admin/contract";

const control = vi.hoisted(() => ({
  transactionCount: 0,
  failAuditStaging: false,
}));

vi.mock("@/lib/firebase/firestore.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/firebase/firestore.server")>();
  const { firestoreDouble: double } = await import("./setup");
  return {
    ...actual,
    ...double().module,
    // Keep canonical production key/id behavior while retaining the local
    // transaction store.
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
          set: (path: string, data: Record<string, unknown>) => {
            if (control.failAuditStaging && path.startsWith("admin_audit_logs/")) {
              throw new Error("injected corrected-replacement audit failure");
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

const serverHarness = vi.hoisted(() => {
  interface Registered {
    validator: Validator | null;
    handler: Handler | null;
  }
  const registry = new Map<object, Registered>();
  const chain = (state: { validator: Validator | null; handler: Handler | null }) => ({
    options: {},
    middleware: () => chain(state),
    validator: (value: Validator) => chain({ ...state, validator: value }),
    inputValidator: (value: Validator) => chain({ ...state, validator: value }),
    handler: (value: Handler) => {
      const token = { __correctedReplacementServerFn: true };
      registry.set(token, { validator: state.validator, handler: value });
      return token;
    },
  });
  return {
    registry,
    createServerFn: () => chain({ validator: null, handler: null }),
  };
});

vi.mock("@tanstack/react-start", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createServerFn: serverHarness.createServerFn };
});

vi.mock("@/lib/admin/middleware", () => ({
  authMiddleware: { __correctedReplacementAuth: true },
}));

const {
  FactStatusTransitionError,
  createCorrectedReplacement,
  STATUS,
} = await import("@/lib/admin/content.server");
const contentFunctions = await import("@/lib/admin/content.functions");

const ADMIN: AdminUser = {
  uid: "admin-correction",
  email: "ops@example.com",
  name: "Ops Operator",
  isClaimAdmin: true,
};

const ORIGINAL_ID = "original-correction";
const AUDIT_ID = "audit-correction";
const AUDIT_CREATED_AT = "2026-09-24T12:00:00.000Z";

const ORIGINAL = {
  subject: "Original subject",
  subject_key: "original subject",
  angle: "Original angle",
  angle_key: "original angle",
  question: "What is the original value?",
  claim_template: "The original value is {n}.",
  explanation: "The original value is documented.",
  true_number: 7,
  unit: "widgets",
  status: STATUS.active,
  content_rating: "standard",
  surprise_factor: 1,
  quantity_kind: QK.count,
  source_urls: [],
  served_count: 0,
};

function replacementInput(overrides: Record<string, unknown> = {}) {
  return {
    subject: "Corrected subject",
    angle: "Corrected angle",
    true_number: 9,
    unit: "widgets",
    claim_template: "The corrected value is {n}.",
    question: "What is the corrected value?",
    explanation: "The corrected value was independently checked.",
    surprise_factor: 2,
    quantity_kind: QK.count,
    source_urls: ["https://example.com/corrected"],
    ...overrides,
  };
}

function audit(targetId = ORIGINAL_ID) {
  return buildAuditEntry(
    ADMIN,
    {
      action: "fact.corrected_replacement",
      targetType: "fact",
      targetId,
      details: "corrected replacement test",
    },
    { id: AUDIT_ID, createdAt: AUDIT_CREATED_AT },
  );
}

async function canonicalReplacementId(input: ReturnType<typeof replacementInput>): Promise<string> {
  return factId(normalizeKey(String(input.subject)), normalizeKey(String(input.angle)));
}

function seedOriginal(overrides: Record<string, unknown> = {}) {
  return firestoreDouble().seed(`fact_bank/${ORIGINAL_ID}`, { ...ORIGINAL, ...overrides });
}

function auditDocuments() {
  return firestoreDouble()
    .documents()
    .filter((doc) => doc.path.startsWith("admin_audit_logs/"));
}

function handlerFor(token: object): Handler {
  const record = serverHarness.registry.get(token);
  if (!record?.handler) throw new Error("corrected-replacement server function did not register");
  return record.handler;
}

beforeEach(() => {
  control.transactionCount = 0;
  control.failAuditStaging = false;
  firestoreDouble().reset();
});

describe("transactional corrected replacement", () => {
  it("creates a canonical pending replacement and retires the immutable source with one audit", async () => {
    const seeded = seedOriginal();
    const input = replacementInput();
    const replacementId = await canonicalReplacementId(input);

    const result = await createCorrectedReplacement(
      {
        originalId: ORIGINAL_ID,
        replacement: input,
        reason: "Corrected source evidence",
        originalUpdateTime: seeded.updateTime,
      },
      audit(),
    );

    const original = firestoreDouble().document(`fact_bank/${ORIGINAL_ID}`);
    const replacement = firestoreDouble().document(`fact_bank/${replacementId}`);
    const auditDoc = firestoreDouble().document(`admin_audit_logs/${AUDIT_ID}`);

    expect(result.original.id).toBe(ORIGINAL_ID);
    expect(result.replacement.id).toBe(replacementId);
    expect(original?.data["status"]).toBe(STATUS.retired);
    expect(original?.data["subject"]).toBe(ORIGINAL.subject);
    expect(original?.data["angle"]).toBe(ORIGINAL.angle);
    expect(original?.data["subject_key"]).toBe(ORIGINAL.subject_key);
    expect(original?.data["angle_key"]).toBe(ORIGINAL.angle_key);
    expect(replacement?.data["status"]).toBe(PENDING_FACT_STATUS);
    expect(replacement?.data["subject_key"]).toBe("corrected subject");
    expect(replacement?.data["angle_key"]).toBe("corrected angle");
    expect(replacement?.data).not.toHaveProperty("verified_at");
    expect(replacement?.data).not.toHaveProperty("verifier_model");
    expect(auditDocuments()).toHaveLength(1);
    expect(auditDoc?.data["action"]).toBe("fact.corrected_replacement");
    expect(auditDoc?.data["targetId"]).toBe(ORIGINAL_ID);
    expect(control.transactionCount).toBe(1);

    const writes = firestoreDouble().writes();
    const sourceUpdate = writes.find(
      (write) => write.path === `fact_bank/${ORIGINAL_ID}`,
    );
    expect(sourceUpdate?.kind).toBe("patch");
    expect(sourceUpdate?.precondition?.updateTime).toBe(seeded.updateTime);
    expect(writes.filter((write) => write.path === `fact_bank/${replacementId}`)).toHaveLength(1);
    expect(writes.filter((write) => write.path === `admin_audit_logs/${AUDIT_ID}`)).toHaveLength(1);
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("leaves both facts unchanged for an invalid replacement", async () => {
    const seeded = seedOriginal();
    const input = replacementInput({ unit: "" });

    await expect(
      createCorrectedReplacement({ originalId: ORIGINAL_ID, replacement: input }, audit()),
    ).rejects.toThrow();

    expect(firestoreDouble().document(`fact_bank/${ORIGINAL_ID}`)?.data).toEqual(seeded.data);
    expect(firestoreDouble().documents().filter((doc) => doc.path.startsWith("fact_bank/"))).toHaveLength(1);
    expect(auditDocuments()).toHaveLength(0);
    expect(firestoreDouble().writeCount()).toBe(0);
  });

  it("rejects a stale original token without retiring or creating anything", async () => {
    seedOriginal();
    const input = replacementInput();

    await expect(
      createCorrectedReplacement(
        { originalId: ORIGINAL_ID, replacement: input, originalUpdateTime: "stale-token" },
        audit(),
      ),
    ).rejects.toMatchObject({ code: "stale_original" });

    expect(firestoreDouble().document(`fact_bank/${ORIGINAL_ID}`)?.data["status"]).toBe(STATUS.active);
    expect(firestoreDouble().documents().filter((doc) => doc.path.startsWith("fact_bank/"))).toHaveLength(1);
    expect(auditDocuments()).toHaveLength(0);
    expect(firestoreDouble().writeCount()).toBe(0);
  });

  it("rejects a source whose contract does not allow retirement", async () => {
    const seeded = seedOriginal({ status: STATUS.retired });
    const input = replacementInput();

    await expect(
      createCorrectedReplacement({ originalId: ORIGINAL_ID, replacement: input }, audit()),
    ).rejects.toBeInstanceOf(FactStatusTransitionError);

    expect(firestoreDouble().document(`fact_bank/${ORIGINAL_ID}`)?.data).toEqual(seeded.data);
    expect(firestoreDouble().documents().filter((doc) => doc.path.startsWith("fact_bank/"))).toHaveLength(1);
    expect(auditDocuments()).toHaveLength(0);
    expect(firestoreDouble().writeCount()).toBe(0);
  });

  it("rolls back both fact writes when the audit cannot be staged", async () => {
    const seeded = seedOriginal();
    const input = replacementInput();
    const replacementId = await canonicalReplacementId(input);
    control.failAuditStaging = true;

    await expect(
      createCorrectedReplacement({ originalId: ORIGINAL_ID, replacement: input }, audit()),
    ).rejects.toThrow(/audit failure/);

    expect(firestoreDouble().document(`fact_bank/${ORIGINAL_ID}`)?.data).toEqual(seeded.data);
    expect(firestoreDouble().document(`fact_bank/${replacementId}`)).toBeNull();
    expect(auditDocuments()).toHaveLength(0);
    expect(firestoreDouble().writeCount()).toBe(0);
  });

  it("prepares the audit at the server boundary and commits exactly one replacement operation", async () => {
    const seeded = seedOriginal();
    const input = replacementInput();
    const replacementId = await canonicalReplacementId(input);
    const handler = handlerFor(contentFunctions.createCorrectedReplacement);

    const result = (await handler({
      data: { originalId: ORIGINAL_ID, replacement: input, reason: "Evidence update" },
      context: { user: ADMIN },
    })) as { original: { id: string }; replacement: { id: string } };

    expect(result.original.id).toBe(ORIGINAL_ID);
    expect(result.replacement.id).toBe(replacementId);
    expect(firestoreDouble().document(`fact_bank/${ORIGINAL_ID}`)?.data["status"]).toBe(STATUS.retired);
    expect(firestoreDouble().document(`fact_bank/${replacementId}`)?.data["status"]).toBe(PENDING_FACT_STATUS);
    expect(auditDocuments()).toHaveLength(1);
    expect(auditDocuments()[0]?.data["action"]).toBe("fact.corrected_replacement");
    expect(auditDocuments()[0]?.data["targetId"]).toBe(ORIGINAL_ID);
    expect(auditDocuments()[0]?.data["adminUid"]).toBe(ADMIN.uid);
    expect(firestoreDouble().document(`fact_bank/${ORIGINAL_ID}`)?.updateTime).not.toBe(seeded.updateTime);
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("does not overwrite an existing canonical replacement", async () => {
    const seeded = seedOriginal();
    const input = replacementInput();
    const replacementId = await canonicalReplacementId(input);
    const existing = firestoreDouble().seed(`fact_bank/${replacementId}`, {
      subject: "Existing replacement",
      subject_key: "existing replacement",
      angle: "Existing angle",
      angle_key: "existing angle",
      status: STATUS.active,
    });

    await expect(
      createCorrectedReplacement({ originalId: ORIGINAL_ID, replacement: input }, audit()),
    ).rejects.toMatchObject({ code: "replacement_exists" });

    expect(firestoreDouble().document(`fact_bank/${ORIGINAL_ID}`)?.data).toEqual(seeded.data);
    expect(firestoreDouble().document(`fact_bank/${replacementId}`)?.data).toEqual(existing.data);
    expect(auditDocuments()).toHaveLength(0);
    expect(firestoreDouble().writeCount()).toBe(0);
  });

  it("rejects a same-canonical-identity replacement instead of re-keying the source", async () => {
    const sameIdentity = replacementInput({
      subject: ORIGINAL.subject,
      angle: ORIGINAL.angle,
    });
    const canonicalId = await canonicalReplacementId(sameIdentity);
    firestoreDouble().reset();
    const seeded = firestoreDouble().seed(`fact_bank/${canonicalId}`, { ...ORIGINAL });

    await expect(
      createCorrectedReplacement(
        { originalId: canonicalId, replacement: sameIdentity },
        audit(canonicalId),
      ),
    ).rejects.toMatchObject({ code: "replacement_identity_collision" });

    expect(firestoreDouble().document(`fact_bank/${canonicalId}`)?.data).toEqual(seeded.data);
    expect(firestoreDouble().documents().filter((doc) => doc.path.startsWith("fact_bank/"))).toHaveLength(1);
    expect(auditDocuments()).toHaveLength(0);
    expect(firestoreDouble().writeCount()).toBe(0);
  });
});
