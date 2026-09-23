import { describe, expect, it, vi } from "vitest";
import {
  firestoreDouble,
  type AdminUser,
} from "./setup";
import { STATUS } from "@/lib/admin/content.server";

const ADMIN: AdminUser = {
  uid: "admin-1",
  email: "ops@example.com",
  name: "Ops Operator",
  isClaimAdmin: true,
};

vi.mock("@/lib/firebase/firestore.server", async () => {
  const { firestoreDouble: double } = await import("./setup");
  return double().module;
});

describe("Duplicate reports handling", () => {
  it("finds duplicate facts using direct duplicateFactIds on report", async () => {
    const { findDuplicateFactsForReport } = await import("@/lib/admin/content.server");

    firestoreDouble().seed("fact_bank/fact_1", {
      subject: "Tom Brady",
      subject_key: "tom brady",
      angle: "Super Bowls won",
      question: "How many Super Bowls did Tom Brady win?",
      claim_template: "Tom Brady won {n} Super Bowls.",
      true_number: 7,
      unit: "Super Bowls",
      status: STATUS.disputed,
    });

    firestoreDouble().seed("fact_bank/fact_2", {
      subject: "Tom Brady",
      subject_key: "tom brady",
      angle: "Super Bowl victories",
      question: "How many Super Bowls did Tom Brady win?",
      claim_template: "Tom Brady won {n} Super Bowls.",
      true_number: 7,
      unit: "Super Bowls",
      status: STATUS.active,
    });

    const report = {
      id: "lint_fact_1",
      topic: "Tom Brady",
      claimStatement: "Tom Brady won {n} Super Bowls.",
      explanation: "",
      presentedNumber: null,
      trueNumber: 7,
      unit: "Super Bowls",
      reason: "fact_lint: duplicate_question",
      feedbackText: "",
      reporterUid: "",
      status: "pending_review",
      createdAt: new Date().toISOString(),
      resolutionNote: null,
      factId: "fact_1",
      duplicateFactIds: ["fact_2"],
      ombudsmanSources: [],
      qualityFlags: ["duplicate_question"],
    };

    const primaryFactDoc = firestoreDouble().document("fact_bank/fact_1")!;
    const { toFact } = await import("@/lib/admin/content.server");
    const primaryFact = toFact(primaryFactDoc);

    const duplicates = await findDuplicateFactsForReport(report, primaryFact);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.id).toBe("fact_2");
    expect(duplicates[0]?.angle).toBe("Super Bowl victories");
  });

  it("finds duplicate facts using fallback question normalization similarity", async () => {
    const { findDuplicateFactsForReport } = await import("@/lib/admin/content.server");

    firestoreDouble().seed("fact_bank/fact_a", {
      subject: "Apollo 11",
      subject_key: "apollo 11",
      angle: "Moon walk duration",
      question: "How long was the Apollo 11 moonwalk?",
      claim_template: "The moonwalk lasted {n} hours.",
      true_number: 2.5,
      unit: "hours",
      status: STATUS.disputed,
    });

    firestoreDouble().seed("fact_bank/fact_b", {
      subject: "Apollo 11",
      subject_key: "apollo 11",
      angle: "Lunar surface eva",
      question: "What was the Apollo 11 moonwalk duration?",
      claim_template: "The moonwalk lasted {n} hours.",
      true_number: 2.5,
      unit: "hours",
      status: STATUS.active,
    });

    const report = {
      id: "lint_fact_a",
      topic: "Apollo 11",
      claimStatement: "The moonwalk lasted {n} hours.",
      explanation: "",
      presentedNumber: null,
      trueNumber: 2.5,
      unit: "hours",
      reason: "fact_lint: duplicate_question",
      feedbackText: "",
      reporterUid: "",
      status: "pending_review",
      createdAt: new Date().toISOString(),
      resolutionNote: null,
      factId: "fact_a",
      duplicateFactIds: [], // Empty, triggers query fallback
      ombudsmanSources: [],
      qualityFlags: ["duplicate_question"],
    };

    const primaryFactDoc = firestoreDouble().document("fact_bank/fact_a")!;
    const { toFact } = await import("@/lib/admin/content.server");
    const primaryFact = toFact(primaryFactDoc);

    const duplicates = await findDuplicateFactsForReport(report, primaryFact);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.id).toBe("fact_b");
  });

  it("resolves duplicate choice by retiring loser, keeping winner, and auto-resolving counterpart report", async () => {
    const { resolveReport } = await import("@/lib/admin/content.server");

    firestoreDouble().seed("fact_bank/fact_winner", {
      subject: "Cheetah",
      subject_key: "cheetah",
      angle: "Top speed",
      true_number: 70,
      unit: "mph",
      status: STATUS.disputed,
      quality_flags: ["duplicate_question"],
      disputed_reason: "fact_lint: duplicate_question",
      disputed_at: "2026-01-01T00:00:00.000Z",
    });

    firestoreDouble().seed("fact_bank/fact_loser", {
      subject: "Cheetah",
      subject_key: "cheetah",
      angle: "Max running speed",
      true_number: 70,
      unit: "mph",
      status: STATUS.active,
    });

    firestoreDouble().seed("trivia_reports/lint_fact_winner", {
      factId: "fact_winner",
      status: "pending_review",
      reason: "fact_lint: duplicate_question",
    });

    firestoreDouble().seed("trivia_reports/lint_fact_loser", {
      factId: "fact_loser",
      status: "pending_review",
      reason: "fact_lint: duplicate_question",
    });

    const res = await resolveReport({
      reportId: "lint_fact_winner",
      action: "resolve_duplicate",
      keepFactId: "fact_winner",
      retireFactId: "fact_loser",
      note: "Winner has clearer phrasing and official citation",
    });

    expect(res).toEqual({ ok: true });

    // Winner should be active, and lint flags cleared
    const winnerDoc = firestoreDouble().document("fact_bank/fact_winner")!;
    expect(winnerDoc.data["status"]).toBe(STATUS.active);
    expect(winnerDoc.data["quality_flags"]).toBeUndefined();
    expect(winnerDoc.data["disputed_reason"]).toBeUndefined();

    // Loser should be retired
    const loserDoc = firestoreDouble().document("fact_bank/fact_loser")!;
    expect(loserDoc.data["status"]).toBe(STATUS.retired);
    expect(loserDoc.data["retired_reason"]).toContain("Winner has clearer phrasing");

    // Both reports should be resolved
    const winnerReport = firestoreDouble().document("trivia_reports/lint_fact_winner")!;
    expect(winnerReport.data["status"]).toBe("resolved");

    const loserReport = firestoreDouble().document("trivia_reports/lint_fact_loser")!;
    expect(loserReport.data["status"]).toBe("resolved");
  });

  it("resolves multi-duplicate group retiring multiple losers and does not create partial report if missing", async () => {
    const { resolveReport } = await import("@/lib/admin/content.server");

    firestoreDouble().seed("fact_bank/fact_1", {
      subject: "U2",
      angle: "Grammys",
      true_number: 22,
      unit: "count",
      status: STATUS.disputed,
      quality_flags: ["duplicate_question"],
    });
    firestoreDouble().seed("fact_bank/fact_2", {
      subject: "U2",
      angle: "Grammys",
      true_number: 22,
      unit: "count",
      status: STATUS.disputed,
      quality_flags: ["duplicate_question"],
    });
    firestoreDouble().seed("fact_bank/fact_3", {
      subject: "U2",
      angle: "Grammys",
      true_number: 22,
      unit: "count",
      status: STATUS.disputed,
      quality_flags: ["duplicate_question"],
    });

    firestoreDouble().seed("trivia_reports/lint_fact_1", {
      factId: "fact_1",
      status: "pending_review",
      reason: "fact_lint: duplicate_question",
      duplicateFactIds: ["fact_2", "fact_3"],
    });
    // Note: trivia_reports/lint_fact_2 and lint_fact_3 are deliberately not seeded!

    const res = await resolveReport({
      reportId: "lint_fact_1",
      action: "resolve_duplicate",
      keepFactId: "fact_1",
      retireFactIds: ["fact_2", "fact_3"],
    });

    expect(res).toEqual({ ok: true });
    expect(firestoreDouble().document("fact_bank/fact_1")!.data["status"]).toBe(STATUS.active);
    expect(firestoreDouble().document("fact_bank/fact_2")!.data["status"]).toBe(STATUS.retired);
    expect(firestoreDouble().document("fact_bank/fact_3")!.data["status"]).toBe(STATUS.retired);

    // Unseeded counterpart reports must NOT be created as partial docs
    expect(firestoreDouble().document("trivia_reports/lint_fact_2")).toBeNull();
    expect(firestoreDouble().document("trivia_reports/lint_fact_3")).toBeNull();
  });

  it("rejecting duplicate report reinstates all disputed duplicate facts and auto-rejects counterpart reports", async () => {
    const { resolveReport } = await import("@/lib/admin/content.server");

    firestoreDouble().seed("fact_bank/fact_x", {
      subject: "Beatles",
      status: STATUS.disputed,
    });
    firestoreDouble().seed("fact_bank/fact_y", {
      subject: "Beatles",
      status: STATUS.disputed,
    });

    firestoreDouble().seed("trivia_reports/lint_fact_x", {
      factId: "fact_x",
      reportSource: "fact_lint",
      status: "pending_review",
      duplicateFactIds: ["fact_y"],
    });
    firestoreDouble().seed("trivia_reports/lint_fact_y", {
      factId: "fact_y",
      reportSource: "fact_lint",
      status: "pending_review",
      duplicateFactIds: ["fact_x"],
    });

    await resolveReport({
      reportId: "lint_fact_x",
      action: "reject",
      note: "Distinct nuances, keep both active",
    });

    expect(firestoreDouble().document("fact_bank/fact_x")!.data["status"]).toBe(STATUS.active);
    expect(firestoreDouble().document("fact_bank/fact_y")!.data["status"]).toBe(STATUS.active);
    expect(firestoreDouble().document("trivia_reports/lint_fact_x")!.data["status"]).toBe("rejected");
    expect(firestoreDouble().document("trivia_reports/lint_fact_y")!.data["status"]).toBe("rejected");
  });
});
