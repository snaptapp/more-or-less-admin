import { describe, expect, it, vi } from "vitest";
import { firestoreDouble } from "./setup";
import { STATUS } from "@/lib/admin/content.server";
import { QUALITY_REVIEW_KINDS } from "../shared/fact-lifecycle-contract.gen";
import { compareSourceValues } from "@/lib/admin/source-compare";

vi.mock("@/lib/firebase/firestore.server", async () => {
  const { firestoreDouble: double } = await import("./setup");
  return double().module;
});

function seedFact(id: string, data: Record<string, unknown>): void {
  firestoreDouble().seed(`fact_bank/${id}`, {
    subject: "Seeded",
    subject_key: "seeded",
    angle: "Reveal",
    angle_key: "reveal",
    true_number: 7,
    unit: "units",
    claim_template: "Seeded claim {n}",
    ...data,
  });
}

function factUpdateTime(id: string): string {
  const doc = firestoreDouble().document(`fact_bank/${id}`);
  if (!doc?.updateTime) throw new Error(`seeded fact ${id} has no updateTime`);
  return doc.updateTime;
}

describe("Task 7 revision-safe moderation", () => {
  it("resolves a stale-bound reject report without touching the fact", async () => {
    const { resolveReport } = await import("@/lib/admin/content.server");
    seedFact("f_stale", { status: STATUS.disputed, quality_flags: ["duplicate_question"] });
    const stale = "2000-01-01T00:00:00.000000Z";
    firestoreDouble().seed("trivia_reports/r_stale", {
      factId: "f_stale",
      reportSource: "fact_lint",
      status: "pending_review",
      fact_update_time: stale,
    });

    await resolveReport({ reportId: "r_stale", action: "reject" });

    const fact = firestoreDouble().document("fact_bank/f_stale")!;
    expect(fact.data["status"]).toBe(STATUS.disputed);
    expect(fact.data["quality_flags"]).toEqual(["duplicate_question"]);
    expect(firestoreDouble().document("trivia_reports/r_stale")!.data["status"]).toBe("rejected");
  });

  it("reinstates a lint-disputed fact whose bound revision still matches", async () => {
    const { resolveReport } = await import("@/lib/admin/content.server");
    seedFact("f_bound", {
      status: STATUS.disputed,
      quality_flags: ["duplicate_question"],
      disputed_reason: "fact_lint: duplicate_question",
    });
    firestoreDouble().seed("trivia_reports/r_bound", {
      factId: "f_bound",
      reportSource: "fact_lint",
      status: "pending_review",
      fact_update_time: factUpdateTime("f_bound"),
    });

    await resolveReport({ reportId: "r_bound", action: "reject" });

    const fact = firestoreDouble().document("fact_bank/f_bound")!;
    expect(fact.data["status"]).toBe(STATUS.active);
    expect(fact.data["quality_flags"]).toBeUndefined();
    const reviews = fact.data["quality_reviews"] as Array<Record<string, unknown>>;
    expect(reviews).toHaveLength(1);
    expect(reviews[0]["schema_version"]).toBe("fact-quality-review/1");
    expect(reviews[0]["kind"]).toBe("finding_accepted");
    expect(QUALITY_REVIEW_KINDS).toContain(reviews[0]["kind"]);
    expect(reviews[0]["fact_id"]).toBe("f_bound");
  });

  it("never reinstates pending or retired facts through a rejected report", async () => {
    const { resolveReport } = await import("@/lib/admin/content.server");
    for (const status of ["pending", "retired"]) {
      firestoreDouble().reset();
      seedFact("f_locked", { status });
      firestoreDouble().seed("trivia_reports/r_locked", {
        factId: "f_locked",
        reportSource: "fact_lint",
        status: "pending_review",
        factPreviousStatus: status === "pending" ? "active" : "active",
      });
      await resolveReport({ reportId: "r_locked", action: "reject" });
      expect(firestoreDouble().document("fact_bank/f_locked")!.data["status"]).toBe(status);
    }
  });

  it("ignores a forged factPreviousStatus when rejecting a lint dispute", async () => {
    const { resolveReport } = await import("@/lib/admin/content.server");
    seedFact("f_forged", { status: STATUS.pending });
    firestoreDouble().seed("trivia_reports/r_forged", {
      factId: "f_forged",
      reportSource: "fact_lint",
      status: "pending_review",
      // A stale/forged pointer claiming the fact was once active must not
      // be written back verbatim.
      factPreviousStatus: "active",
    });
    await resolveReport({ reportId: "r_forged", action: "reject" });
    expect(firestoreDouble().document("fact_bank/f_forged")!.data["status"]).toBe("pending");
  });

  it("material edits revoke the receipt, hold, and fingerprint and record finding_cleared", async () => {
    const { resolveReport } = await import("@/lib/admin/content.server");
    seedFact("f_material", {
      status: STATUS.disputed,
      quality_flags: ["wrong_number"],
      disputed_reason: "fact_lint: wrong_number",
      disputed_at: "2026-01-01T00:00:00.000Z",
      content_fingerprint: "fp_old",
      quality_receipt: { audit_id: "a1", content_fingerprint: "fp_old" },
      quality_hold: { reason: "legacy" },
      lint_findings: [{ rule: "wrong_number" }],
      lint_rules_revision: "rev1",
    });
    firestoreDouble().seed("trivia_reports/r_material", {
      factId: "f_material",
      reportSource: "fact_lint",
      status: "pending_review",
    });

    await resolveReport({ reportId: "r_material", action: "fix_number", factId: "f_material", correctedNumber: 42 });

    const fact = firestoreDouble().document("fact_bank/f_material")!;
    expect(fact.data["true_number"]).toBe(42);
    for (const gone of [
      "quality_receipt",
      "content_fingerprint",
      "lint_findings",
      "lint_rules_revision",
      "disputed_reason",
      "disputed_at",
      "derivation",
      "precomputed_derivation",
      "derivation_input_fingerprint",
    ]) {
      expect(fact.data, gone).not.toHaveProperty(gone);
    }
    // The seeded hold is replaced by a fresh material-edit hold, not kept.
    const hold = fact.data["quality_hold"] as Record<string, unknown> | undefined;
    expect(hold?.["reason"]).toContain("Material fact edit");
    expect(fact.data["status"]).toBe(STATUS.active);
    const reviews = fact.data["quality_reviews"] as Array<Record<string, unknown>>;
    expect(reviews).toHaveLength(1);
    expect(reviews[0]["kind"]).toBe("finding_cleared");
    expect(QUALITY_REVIEW_KINDS).toContain(reviews[0]["kind"]);
    expect(reviews[0]["review_id"]).toBeTruthy();
    expect(reviews[0]["created_at"]).toBeTruthy();
    expect(typeof reviews[0]["update_time"]).toBe("string");
  });

  it("rolls back the whole resolution when a write fails", async () => {
    const { resolveReport } = await import("@/lib/admin/content.server");
    seedFact("f_atomic", {
      status: STATUS.disputed,
      quality_flags: ["duplicate_question"],
      disputed_reason: "fact_lint: duplicate_question",
    });
    firestoreDouble().seed("trivia_reports/r_atomic", {
      factId: "f_atomic",
      reportSource: "fact_lint",
      status: "pending_review",
    });

    firestoreDouble().failNextWrite();
    await expect(resolveReport({ reportId: "r_atomic", action: "reject" })).rejects.toThrow();

    expect(firestoreDouble().document("fact_bank/f_atomic")!.data["status"]).toBe(STATUS.disputed);
    expect(firestoreDouble().document("trivia_reports/r_atomic")!.data["status"]).toBe("pending_review");
  });
});

describe("Task 7 telemetry flag atomicity", () => {
  it("disputes the fact and creates the bound report in one transaction", async () => {
    const { flagQuestionTelemetry } = await import("@/lib/admin/ops.server");
    seedFact("f_tel", { status: STATUS.active });
    const bound = factUpdateTime("f_tel");

    const result = await flagQuestionTelemetry({ days: 30, questionId: "fact:f_tel" }, {
      uid: "a", email: "a@x", name: "a", isClaimAdmin: true,
    });

    expect(result.alreadyReviewed).toBe(false);
    const fact = firestoreDouble().document("fact_bank/f_tel")!;
    expect(fact.data["status"]).toBe(STATUS.disputed);
    expect(fact.data["disputed_at"]).toBeTruthy();
    expect(fact.data["disputed_reason"]).toBe("round_telemetry");
    const report = firestoreDouble().document(`trivia_reports/${result.reportId}`)!;
    expect(report.data["status"]).toBe("pending_review");
    expect(report.data["reportSource"]).toBe("round_telemetry");
    expect(report.data["factId"]).toBe("f_tel");
    expect(report.data["fact_update_time"]).toBe(bound);
    // Fact dispute + report create committed together, and every fact write is CAS'd.
    const txWrites = firestoreDouble().writes().filter((w) => w.transaction);
    expect(txWrites.length).toBeGreaterThanOrEqual(2);
  });

  it("does not overwrite an already-disputed fact but still files the bound report", async () => {
    const { flagQuestionTelemetry } = await import("@/lib/admin/ops.server");
    seedFact("f_tel2", {
      status: STATUS.disputed,
      disputed_reason: "fact_lint: bounds_chart_position",
    });
    const bound = factUpdateTime("f_tel2");

    const result = await flagQuestionTelemetry({ days: 30, questionId: "fact:f_tel2" }, {
      uid: "a", email: "a@x", name: "a", isClaimAdmin: true,
    });

    const fact = firestoreDouble().document("fact_bank/f_tel2")!;
    expect(fact.data["disputed_reason"]).toBe("fact_lint: bounds_chart_position");
    const report = firestoreDouble().document(`trivia_reports/${result.reportId}`)!;
    expect(report.data["fact_update_time"]).toBe(bound);
  });
});

describe("Task 7 copilot exact source comparison", () => {
  it("agrees on identical values and on unit-normalized equivalents", () => {
    expect(compareSourceValues({ token: "4650000000" }, { token: "4650000000" })).toBe("agree");
    expect(
      compareSourceValues(
        { token: "4.65e9", unit: "meters" },
        { token: "4650000000", unit: "meters" },
      ),
    ).toBe("agree");
    // A stated unit the registry does not know is incomparable, never a match.
    expect(
      compareSourceValues({ token: "5", unit: "smoots" }, { token: "5", unit: "smoots" }),
    ).toBe("incomparable");
    expect(
      compareSourceValues({ token: "1000", unit: "meters" }, { token: "1", unit: "kilometers" }),
    ).toBe("agree");
  });

  it("conflicts only on exact mismatch, not percentage tolerance", () => {
    // 4% apart: a raw 5% tolerance would have passed this; exact does not.
    expect(compareSourceValues({ token: "100" }, { token: "104" })).toBe("conflict");
    expect(compareSourceValues({ token: "100" }, { token: "100.0" })).toBe("agree");
  });

  it("reports period mismatch and unparseable tokens as incomparable", () => {
    expect(
      compareSourceValues(
        { token: "5", period: "1989" },
        { token: "5", period: "1955" },
      ),
    ).toBe("incomparable");
    expect(compareSourceValues({ token: "about five" }, { token: "5" })).toBe("incomparable");
    // Cross-measure units cannot be reconciled.
    expect(
      compareSourceValues({ token: "100", unit: "kg" }, { token: "100", unit: "meters" }),
    ).toBe("incomparable");
  });
});
