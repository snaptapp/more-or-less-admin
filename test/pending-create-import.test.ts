import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PENDING_FACT_ORIGINS,
  PENDING_FACT_STATUS,
  buildPendingFact,
  type PendingFactInput,
} from "@/lib/admin/fact-admission";
import { QK } from "@/lib/admin/contract";
import {
  createFact,
  importFactsBatch,
  type ImportFactInput,
  type ImportFactAuditContext,
} from "@/lib/admin/content.server";
import { blockedNetworkAttempts, firestoreDouble } from "./setup";

vi.mock("@/lib/firebase/firestore.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/firebase/firestore.server")>();
  const { firestoreDouble: double } = await import("./setup");
  return {
    ...actual,
    ...double().module,
    // Keep the admission builder on the real canonical normalizer rather than
    // the test double's legacy punctuation behavior.
    normalizeKey: actual.normalizeKey,
    factId: actual.factId,
  };
});

const TIMESTAMP = "2026-09-24T12:00:00.000Z";

function input(overrides: Partial<ImportFactInput> = {}): ImportFactInput {
  return {
    subject: "  Mount Everest  ",
    category: "History & World",
    sub_category: "Exploration",
    angle: "  First ascent year  ",
    true_number: 1953,
    unit: "year",
    claim_template: "Mount Everest was first climbed in {n}.",
    context: "The first confirmed ascent was in 1953.",
    question: "When was Mount Everest first climbed?",
    surprise_factor: 8,
    quantity_kind: QK.year,
    plausible_min: "1900",
    plausible_max: "2000",
    source_urls: [" https://example.com/everest "],
    ...overrides,
  };
}

function expectedPending(
  value: ImportFactInput,
  origin: (typeof PENDING_FACT_ORIGINS)[number],
) {
  const pendingInput: PendingFactInput = {
    subject: value.subject,
    category: value.category as PendingFactInput["category"],
    sub_category: value.sub_category ?? null,
    angle: value.angle,
    true_number: value.true_number,
    unit: value.unit,
    claim_template: value.claim_template ?? "",
    question: value.question ?? `${value.subject} - ${value.angle}`.trim(),
    explanation: value.explanation ?? value.context ?? "",
    source_urls: value.source_urls ?? [],
    surprise_factor: value.surprise_factor ?? 2,
    quantity_kind: value.quantity_kind === "" ? QK.count : (value.quantity_kind ?? QK.count),
    ...(value.plausible_min !== undefined ? { plausible_min: value.plausible_min } : {}),
    ...(value.plausible_max !== undefined ? { plausible_max: value.plausible_max } : {}),
    ...(value.number_pinned !== undefined ? { number_pinned: value.number_pinned } : {}),
    ...(value.pinned_reason !== undefined ? { pinned_reason: value.pinned_reason } : {}),
    origin,
  };
  return buildPendingFact(pendingInput, TIMESTAMP);
}

function importAudit({ id, index }: ImportFactAuditContext) {
  return {
    id: `import-audit-${index + 1}`,
    data: {
      action: "fact.bulk_import",
      targetType: "fact",
      targetId: id,
      details: "test import audit",
      before: null,
      after: null,
      createdAt: TIMESTAMP,
      adminUid: "admin-import-test",
      adminEmail: "ops@example.com",
    },
  };
}

function factWrites() {
  return firestoreDouble().writes().filter((write) => write.path.startsWith("fact_bank/"));
}

function factWrite(index = 0) {
  const write = firestoreDouble().writes()[index];
  if (write?.kind !== "create" || write.collection !== "fact_bank" || write.data === undefined) {
    throw new Error("expected a fact_bank create write");
  }
  return write;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(TIMESTAMP));
  firestoreDouble().reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pending fact create/import admission", () => {
  it("persists only the builder payload and leaves subject coverage reconciler-owned", async () => {
    const value = input();
    const created = await createFact(value);
    const write = factWrite();
    const expected = expectedPending(value, PENDING_FACT_ORIGINS[0]);

    expect(created.id).toBe(write.documentId);
    expect(write.data).toEqual(expected);
    expect(write.data).not.toHaveProperty("verified_at");
    expect(write.data).not.toHaveProperty("verifier_model");
    expect(write.data?.status).toBe(PENDING_FACT_STATUS);

    const subject = firestoreDouble().document(`fact_subjects/${expected.subject_key}`);
    expect(subject).not.toBeNull();
    expect(subject?.data["fact_count"]).toBeUndefined();
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("keeps import outcomes per item and continues after a validation error", async () => {
    const first = input({
      subject: "Giraffe",
      angle: "neck vertebrae",
      true_number: 7,
      unit: "vertebrae",
      quantity_kind: QK.count,
      plausible_min: undefined,
      plausible_max: undefined,
    });
    const invalid = input({
      subject: "Invalid",
      angle: "missing unit",
      unit: "",
      plausible_min: undefined,
      plausible_max: undefined,
    });
    const duplicate = { ...first };
    const later = input({
      subject: "Octopus",
      angle: "hearts",
      true_number: 3,
      unit: "hearts",
      quantity_kind: QK.count,
      plausible_min: undefined,
      plausible_max: undefined,
    });

    const result = await importFactsBatch([first, invalid, duplicate, later], importAudit);

    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Invalid / missing unit");
    expect(firestoreDouble().writeCount()).toBe(4);

    for (const write of factWrites()) {
      expect(write.collection).toBe("fact_bank");
      expect(write.data?.status).toBe(PENDING_FACT_STATUS);
      expect(write.data?.origin).toBe(PENDING_FACT_ORIGINS[1]);
      expect(write.data).not.toHaveProperty("verified_at");
      expect(write.data).not.toHaveProperty("verifier_model");
    }
    expect(factWrites()[0].data).toEqual(expectedPending(first, PENDING_FACT_ORIGINS[1]));
    expect(factWrites()[1].data).toEqual(expectedPending(later, PENDING_FACT_ORIGINS[1]));
    expect(
      firestoreDouble()
        .documents()
        .filter((doc) => doc.path.startsWith("admin_audit_logs/")),
    ).toHaveLength(2);
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("records a persistence error for one item and still imports later items", async () => {
    firestoreDouble().failNextWrite("injected per-item failure");
    const result = await importFactsBatch([
      input({ subject: "First", angle: "value", quantity_kind: QK.count }),
      input({ subject: "Second", angle: "value", quantity_kind: QK.count }),
    ], importAudit);

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("injected per-item failure");
    expect(factWrites().map((write) => write.path)).toHaveLength(1);
    expect(factWrites()[0].data?.status).toBe(PENDING_FACT_STATUS);
    expect(
      firestoreDouble()
        .documents()
        .filter((doc) => doc.path.startsWith("admin_audit_logs/")),
    ).toHaveLength(1);
    expect(blockedNetworkAttempts()).toEqual([]);
  });
});
