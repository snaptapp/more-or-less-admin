/**
 * Ordinary fact edits must not change a fact's deterministic identity.
 *
 * Subject and angle are part of the persisted fact identity. The server-side
 * guard is exercised directly and through both ordinary update server
 * functions, with the in-memory Firestore and audit doubles from test/setup.ts.
 */
import { describe, expect, it, vi } from "vitest";

import {
  auditDouble,
  blockedNetworkAttempts,
  firestoreDouble,
  type AdminUser,
} from "./setup";

type Handler = (input: {
  data: unknown;
  context: { user: AdminUser };
}) => Promise<unknown>;
type Validator = (data: unknown) => unknown;

interface CapturedServerFn {
  validator: Validator | null;
  handler: Handler | null;
}

const harness = vi.hoisted(() => {
  const registry = new Map<object, { validator: unknown; handler: unknown }>();
  const makeChain = (state: { validator: unknown; handler: unknown }): Record<string, unknown> => ({
    options: {},
    middleware: () => makeChain(state),
    validator: (fn: unknown) => makeChain({ ...state, validator: fn }),
    inputValidator: (fn: unknown) => makeChain({ ...state, validator: fn }),
    handler: (fn: unknown) => {
      const token = { __recordedServerFn: true };
      registry.set(token, { validator: state.validator, handler: fn });
      return token;
    },
  });
  const createServerFn = () => makeChain({ validator: null, handler: null });
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
  return {
    registry,
    createServerFn,
    createMiddleware,
    authMiddleware: { __stubAuthMiddleware: true },
  };
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
}));

vi.mock("@/lib/firebase/firestore.server", async () => {
  const { firestoreDouble: double } = await import("./setup");
  return double().module;
});

vi.mock("@/lib/firebase/audit.server", async () => {
  const { auditDouble: double } = await import("./setup");
  return double().module;
});

import {
  FactIdentityChangeError,
  updateFact,
  type FactEditInput,
} from "@/lib/admin/content.server";

const contentFunctions = await import("@/lib/admin/content.functions");

const FACT_ID = "fact_identity_immutable";
const SUBJECT = "Stable subject";
const ANGLE = "Stable angle";
const SEED = {
  subject: SUBJECT,
  subject_key: "stable_subject",
  angle: ANGLE,
  angle_key: "stable_angle",
  question: "Original question?",
  claim_template: "Original claim {n}",
  context: "Original context",
  true_number: 7,
  unit: "units",
  status: "active",
  content_rating: "standard",
  surprise_factor: 2,
  source_urls: [],
  served_count: 0,
} as const;

const ADMIN: AdminUser = {
  uid: "admin-identity",
  email: "ops@example.com",
  name: "Ops Operator",
  isClaimAdmin: true,
};

function seedFact(): Record<string, unknown> {
  firestoreDouble().reset();
  auditDouble().reset();
  const before = firestoreDouble().seed(`fact_bank/${FACT_ID}`, { ...SEED });
  return { ...before.data };
}

function capture(exported: unknown): CapturedServerFn {
  if (typeof exported !== "object" || exported === null) {
    throw new Error("server function export is not a recorded token");
  }
  const record = harness.registry.get(exported);
  if (!record) throw new Error("server function did not register a handler");
  return {
    validator: (record.validator as Validator | null) ?? null,
    handler: (record.handler as Handler | null) ?? null,
  };
}

function changedInput(field: "subject" | "angle"): FactEditInput {
  return {
    id: FACT_ID,
    [field]: field === "subject" ? "Changed subject" : "Changed angle",
    question: "This must not be written",
  };
}

describe("fact identity immutability at the Admin server boundary", () => {
  it("rejects a changed subject before any Firestore write", async () => {
    const before = seedFact();

    await expect(updateFact(changedInput("subject"))).rejects.toBeInstanceOf(FactIdentityChangeError);

    expect(firestoreDouble().writeCount()).toBe(0);
    expect(firestoreDouble().document(`fact_bank/${FACT_ID}`)?.data).toEqual(before);
    expect(auditDouble().entryCount()).toBe(0);
  });

  it("rejects a changed angle before any Firestore write", async () => {
    const before = seedFact();

    await expect(updateFact(changedInput("angle"))).rejects.toBeInstanceOf(FactIdentityChangeError);

    expect(firestoreDouble().writeCount()).toBe(0);
    expect(firestoreDouble().document(`fact_bank/${FACT_ID}`)?.data).toEqual(before);
    expect(auditDouble().entryCount()).toBe(0);
  });

  it("treats omitted and exact same-value identity fields as no-ops", async () => {
    const before = seedFact();

    const result = await updateFact({
      id: FACT_ID,
      subject: SUBJECT,
      angle: ANGLE,
    });

    expect(result.id).toBe(FACT_ID);
    expect(result.subject).toBe(SUBJECT);
    expect(result.angle).toBe(ANGLE);
    expect(firestoreDouble().writeCount()).toBe(0);
    expect(firestoreDouble().document(`fact_bank/${FACT_ID}`)?.data).toEqual(before);
  });

  it("does not write identity fields or keys when another fact field changes", async () => {
    seedFact();

    await updateFact({
      id: FACT_ID,
      subject: SUBJECT,
      angle: ANGLE,
      question: "Updated question?",
    });

    const writes = firestoreDouble().writes();
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(`fact_bank/${FACT_ID}`);
    expect(writes[0].data).not.toHaveProperty("subject");
    expect(writes[0].data).not.toHaveProperty("angle");
    expect(writes[0].data).not.toHaveProperty("subject_key");
    expect(writes[0].data).not.toHaveProperty("angle_key");

    const stored = firestoreDouble().document(`fact_bank/${FACT_ID}`);
    expect(stored?.data["subject"]).toBe(SUBJECT);
    expect(stored?.data["angle"]).toBe(ANGLE);
    expect(stored?.data["subject_key"]).toBe(SEED.subject_key);
    expect(stored?.data["angle_key"]).toBe(SEED.angle_key);
    expect(stored?.id).toBe(FACT_ID);
  });

  it("guards a crafted saveFact request even when the handler is called with unvalidated data", async () => {
    const before = seedFact();
    const captured = capture(contentFunctions.saveFact);
    expect(captured.handler).not.toBeNull();

    await expect(
      captured.handler?.({
        data: { id: FACT_ID, subject: "Injected subject", question: "Injected question?" },
        context: { user: ADMIN },
      }),
    ).rejects.toBeInstanceOf(FactIdentityChangeError);

    expect(firestoreDouble().writeCount()).toBe(0);
    expect(firestoreDouble().document(`fact_bank/${FACT_ID}`)?.data).toEqual(before);
    expect(auditDouble().entryCount()).toBe(0);
  });

  it("guards a crafted bulk-update request and does not re-key its target", async () => {
    const before = seedFact();
    const captured = capture(contentFunctions.bulkUpdateFacts);
    expect(captured.handler).not.toBeNull();

    await expect(
      captured.handler?.({
        data: {
          updates: [
            {
              id: FACT_ID,
              angle: "Injected angle",
              subject_key: "injected_subject",
              angle_key: "injected_angle",
            },
          ],
        },
        context: { user: ADMIN },
      }),
    ).rejects.toBeInstanceOf(FactIdentityChangeError);

    expect(firestoreDouble().writeCount()).toBe(0);
    expect(firestoreDouble().document(`fact_bank/${FACT_ID}`)?.data).toEqual(before);
    expect(auditDouble().entryCount()).toBe(0);
  });

  it("retains changed identity fields while stripping internal keys at the validated boundary", () => {
    const captured = capture(contentFunctions.saveFact);
    expect(captured.validator).not.toBeNull();

    const validated = captured.validator?.({
      id: FACT_ID,
      subject: "Injected subject",
      angle: "Injected angle",
      subject_key: "injected_subject",
      angle_key: "injected_angle",
    }) as Record<string, unknown>;

    expect(validated).toEqual({
      id: FACT_ID,
      subject: "Injected subject",
      angle: "Injected angle",
    });
  });

  it("does not reach a guarded service while checking identity immutability", async () => {
    seedFact();
    await expect(updateFact(changedInput("subject"))).rejects.toBeInstanceOf(FactIdentityChangeError);
    expect(blockedNetworkAttempts()).toEqual([]);
  });
});
