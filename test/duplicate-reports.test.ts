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

  it("resolving duplicate where kept fact has another linter flag retains remaining flag and stays disputed", async () => {
    const { resolveReport } = await import("@/lib/admin/content.server");

    firestoreDouble().seed("fact_bank/fact_multi_flag", {
      subject: "Billboard Hot 100",
      status: STATUS.disputed,
      quality_flags: ["duplicate_question", "bounds_chart_position"],
      disputed_reason: "fact_lint: duplicate_question,bounds_chart_position",
      true_number: 105,
    });
    firestoreDouble().seed("fact_bank/fact_loser_dup", {
      subject: "Billboard Hot 100",
      status: STATUS.disputed,
      quality_flags: ["duplicate_question"],
      disputed_reason: "fact_lint: duplicate_question",
      true_number: 105,
    });

    firestoreDouble().seed("trivia_reports/lint_fact_multi_flag", {
      factId: "fact_multi_flag",
      status: "pending_review",
      duplicateFactIds: ["fact_loser_dup"],
      qualityFlags: ["duplicate_question", "bounds_chart_position"],
    });

    await resolveReport({
      reportId: "lint_fact_multi_flag",
      action: "resolve_duplicate",
      keepFactId: "fact_multi_flag",
      retireFactIds: ["fact_loser_dup"],
    });

    // Kept fact should NOT be active because it still has bounds_chart_position!
    const kept = firestoreDouble().document("fact_bank/fact_multi_flag")!;
    expect(kept.data["status"]).toBe(STATUS.disputed);
    expect(kept.data["quality_flags"]).toEqual(["bounds_chart_position"]);
    expect(kept.data["disputed_reason"]).toBe("fact_lint: bounds_chart_position");

    // Loser should be retired
    expect(firestoreDouble().document("fact_bank/fact_loser_dup")!.data["status"]).toBe(STATUS.retired);

    // Report should remain in pending_review with bounds_chart_position so the moderator can fix it
    const rep = firestoreDouble().document("trivia_reports/lint_fact_multi_flag")!;
    expect(rep.data["status"]).toBe("pending_review");
    expect(rep.data["qualityFlags"]).toEqual(["bounds_chart_position"]);
    expect(rep.data["duplicateFactIds"]).toBeUndefined();
    expect(rep.data["resolutionNote"]).toContain("bounds_chart_position");
  });

  it("rejecting duplicate report where fact has another flag retains remaining flag and stays disputed", async () => {
    const { resolveReport } = await import("@/lib/admin/content.server");

    firestoreDouble().seed("fact_bank/fact_reject_multi", {
      subject: "Billboard Hot 100",
      status: STATUS.disputed,
      quality_flags: ["duplicate_question", "bounds_chart_position"],
      disputed_reason: "fact_lint: duplicate_question,bounds_chart_position",
      true_number: 105,
    });
    firestoreDouble().seed("fact_bank/fact_reject_clean", {
      subject: "Billboard Hot 100",
      status: STATUS.disputed,
      quality_flags: ["duplicate_question"],
      disputed_reason: "fact_lint: duplicate_question",
      true_number: 100,
    });

    firestoreDouble().seed("trivia_reports/lint_fact_reject_multi", {
      reportSource: "fact_lint",
      factId: "fact_reject_multi",
      status: "pending_review",
      duplicateFactIds: ["fact_reject_clean"],
      qualityFlags: ["duplicate_question", "bounds_chart_position"],
    });
    firestoreDouble().seed("trivia_reports/lint_fact_reject_clean", {
      reportSource: "fact_lint",
      factId: "fact_reject_clean",
      status: "pending_review",
      duplicateFactIds: ["fact_reject_multi"],
      qualityFlags: ["duplicate_question"],
    });

    await resolveReport({
      reportId: "lint_fact_reject_multi",
      action: "reject",
    });

    // Multi-flag fact should STILL be disputed with bounds_chart_position
    const multi = firestoreDouble().document("fact_bank/fact_reject_multi")!;
    expect(multi.data["status"]).toBe(STATUS.disputed);
    expect(multi.data["quality_flags"]).toEqual(["bounds_chart_position"]);

    // Clean fact should be reinstated to active
    const clean = firestoreDouble().document("fact_bank/fact_reject_clean")!;
    expect(clean.data["status"]).toBe(STATUS.active);
    expect(clean.data["quality_flags"]).toBeUndefined();

    // Multi-flag report should stay pending_review for bounds_chart_position
    const multiRep = firestoreDouble().document("trivia_reports/lint_fact_reject_multi")!;
    expect(multiRep.data["status"]).toBe("pending_review");
    expect(multiRep.data["qualityFlags"]).toEqual(["bounds_chart_position"]);

    // Clean fact report should be auto-rejected
    const cleanRep = firestoreDouble().document("trivia_reports/lint_fact_reject_clean")!;
    expect(cleanRep.data["status"]).toBe("rejected");
  });

  it("resolving duplicate with correctedNumber updates true_number on kept fact", async () => {
    const { resolveReport } = await import("@/lib/admin/content.server");

    firestoreDouble().seed("fact_bank/fact_conflicting_a", {
      subject: "Donna Summer",
      status: STATUS.disputed,
      quality_flags: ["conflicting_answer"],
      true_number: 4,
    });
    firestoreDouble().seed("fact_bank/fact_conflicting_b", {
      subject: "Donna Summer",
      status: STATUS.disputed,
      quality_flags: ["conflicting_answer"],
      true_number: 5,
    });

    firestoreDouble().seed("trivia_reports/lint_conflicting", {
      factId: "fact_conflicting_a",
      status: "pending_review",
      duplicateFactIds: ["fact_conflicting_b"],
      qualityFlags: ["conflicting_answer"],
    });

    await resolveReport({
      reportId: "lint_conflicting",
      action: "resolve_duplicate",
      keepFactId: "fact_conflicting_a",
      retireFactIds: ["fact_conflicting_b"],
      correctedNumber: 6,
      note: "Official count is 6 number-one hits",
    });

    const kept = firestoreDouble().document("fact_bank/fact_conflicting_a")!;
    expect(kept.data["status"]).toBe(STATUS.active);
    expect(kept.data["true_number"]).toBe(6);
    expect(kept.data["quality_flags"]).toBeUndefined();
  });

  it("flushStaleReports auto-resolves pending reports for deleted, retired, or active-clean facts", async () => {
    const { flushStaleReports } = await import("@/lib/admin/content.server");

    // 1. Deleted fact report
    firestoreDouble().seed("trivia_reports/lint_deleted_fact", {
      reportSource: "fact_lint",
      factId: "nonexistent_fact_id",
      status: "pending_review",
    });

    // 2. Retired fact report
    firestoreDouble().seed("fact_bank/fact_is_retired", {
      status: STATUS.retired,
      subject: "Retired Subject",
    });
    firestoreDouble().seed("trivia_reports/lint_retired_fact", {
      reportSource: "fact_lint",
      factId: "fact_is_retired",
      status: "pending_review",
    });

    // 3. Active and clean fact report
    firestoreDouble().seed("fact_bank/fact_is_active_clean", {
      status: STATUS.active,
      subject: "Clean Subject",
      quality_flags: [],
    });
    firestoreDouble().seed("trivia_reports/lint_active_clean_fact", {
      reportSource: "fact_lint",
      factId: "fact_is_active_clean",
      status: "pending_review",
    });

    // 4. Disputed fact with quality flags (MUST NOT be flushed)
    firestoreDouble().seed("fact_bank/fact_is_still_disputed", {
      status: STATUS.disputed,
      subject: "Disputed Subject",
      quality_flags: ["bounds_chart_position"],
    });
    firestoreDouble().seed("trivia_reports/lint_still_disputed", {
      reportSource: "fact_lint",
      factId: "fact_is_still_disputed",
      status: "pending_review",
    });

    // 5. Round telemetry report (MUST NOT be auto-flushed, requires human review)
    firestoreDouble().seed("trivia_reports/telemetry_player_report", {
      reportSource: "round_telemetry",
      factId: "fact_is_active_clean",
      status: "pending_review",
    });

    const result = await flushStaleReports();
    expect(result.flushed).toBe(3);

    // Assert flushed reports are resolved with explanatory notes
    const repDeleted = firestoreDouble().document("trivia_reports/lint_deleted_fact")!;
    expect(repDeleted.data["status"]).toBe("resolved");
    expect(repDeleted.data["resolutionNote"]).toContain("no longer exists");

    const repRetired = firestoreDouble().document("trivia_reports/lint_retired_fact")!;
    expect(repRetired.data["status"]).toBe("resolved");
    expect(repRetired.data["resolutionNote"]).toContain("retired");

    const repClean = firestoreDouble().document("trivia_reports/lint_active_clean_fact")!;
    expect(repClean.data["status"]).toBe("resolved");
    expect(repClean.data["resolutionNote"]).toContain("active and passes all lint rules");

    // Assert kept reports remain pending_review
    const repDisputed = firestoreDouble().document("trivia_reports/lint_still_disputed")!;
    expect(repDisputed.data["status"]).toBe("pending_review");

    const repTelemetry = firestoreDouble().document("trivia_reports/telemetry_player_report")!;
    expect(repTelemetry.data["status"]).toBe("pending_review");
  });

  it("areFactsDuplicateCandidates rejects unrelated facts with shared stop/common words", async () => {
    const { areFactsDuplicateCandidates } = await import("@/lib/admin/content.server");

    const stevieWonder = {
      id: "fact_stevie",
      subject: "Grammy Awards",
      subject_key: "grammy_awards",
      angle: "Stevie Wonder career Grammy Awards",
      question: "How many competitive Grammy Awards has Stevie Wonder won throughout his recording career?",
      claim_template: "Stevie Wonder has earned {n} competitive Grammy Awards throughout his career.",
    };

    const larryFitzgerald = {
      id: "fact_larry",
      subject: "Receiving Yards",
      subject_key: "receiving_yards",
      angle: "Larry Fitzgerald's career NFL receiving yards",
      question: "Larry Fitzgerald's career NFL receiving yards",
      claim_template: "Larry Fitzgerald accumulated {n} career receiving yards over his NFL career",
    };

    expect(areFactsDuplicateCandidates(stevieWonder, larryFitzgerald)).toBe(false);
    expect(areFactsDuplicateCandidates(larryFitzgerald, stevieWonder)).toBe(false);
  });

  it("areFactsDuplicateCandidates accepts true duplicate facts in the same subject", async () => {
    const { areFactsDuplicateCandidates } = await import("@/lib/admin/content.server");

    const stevieA = {
      id: "fact_stevie_1",
      subject: "Grammy Awards",
      subject_key: "grammy_awards",
      angle: "Stevie Wonder career Grammy Awards",
      question: "How many competitive Grammy Awards has Stevie Wonder won throughout his recording career?",
      claim_template: "Stevie Wonder has earned {n} competitive Grammy Awards throughout his career.",
    };

    const stevieB = {
      id: "fact_stevie_2",
      subject: "Grammy Awards",
      subject_key: "grammy_awards",
      angle: "Stevie Wonder Grammy wins",
      question: "How many Grammy Awards has Stevie Wonder won in his music career?",
      claim_template: "Stevie Wonder won {n} Grammy Awards over his career.",
    };

    expect(areFactsDuplicateCandidates(stevieA, stevieB)).toBe(true);
    expect(areFactsDuplicateCandidates(stevieB, stevieA)).toBe(true);
  });

  it("findDuplicateFactsForReport filters out invalid duplicateFactIds and cleans corrupted Firestore reports", async () => {
    const { findDuplicateFactsForReport } = await import("@/lib/admin/content.server");

    firestoreDouble().seed("fact_bank/fact_stevie", {
      subject: "Grammy Awards",
      subject_key: "grammy_awards",
      angle: "Stevie Wonder career Grammy Awards",
      question: "How many competitive Grammy Awards has Stevie Wonder won throughout his recording career?",
      claim_template: "Stevie Wonder has earned {n} competitive Grammy Awards throughout his career.",
      status: STATUS.disputed,
    });

    firestoreDouble().seed("fact_bank/fact_larry", {
      subject: "Receiving Yards",
      subject_key: "receiving_yards",
      angle: "Larry Fitzgerald's career NFL receiving yards",
      question: "Larry Fitzgerald's career NFL receiving yards",
      claim_template: "Larry Fitzgerald accumulated {n} career receiving yards over his NFL career",
      status: STATUS.disputed,
    });

    firestoreDouble().seed("trivia_reports/lint_fact_stevie", {
      id: "lint_fact_stevie",
      topic: "Grammy Awards",
      claimStatement: "Stevie Wonder has earned {n} competitive Grammy Awards throughout his career.",
      factId: "fact_stevie",
      duplicateFactIds: ["fact_larry"], // Corrupted ID
      status: "pending_review",
      reason: "fact_lint: duplicate_question",
    });

    const report = {
      id: "lint_fact_stevie",
      topic: "Grammy Awards",
      claimStatement: "Stevie Wonder has earned {n} competitive Grammy Awards throughout his career.",
      factId: "fact_stevie",
      duplicateFactIds: ["fact_larry"],
      status: "pending_review" as const,
      reason: "fact_lint: duplicate_question",
      explanation: "",
      presentedNumber: null,
      trueNumber: 25,
      unit: "awards",
      feedbackText: "",
      reporterUid: "",
      createdAt: new Date().toISOString(),
      resolutionNote: null,
      ombudsmanSources: [],
      qualityFlags: ["duplicate_question"],
    };
    const { toFact } = await import("@/lib/admin/content.server");
    const primaryFactDoc = firestoreDouble().document("fact_bank/fact_stevie")!;
    const primaryFact = toFact(primaryFactDoc);

    const results = await findDuplicateFactsForReport(report, primaryFact);
    // Larry Fitzgerald is NOT a candidate
    expect(results.some((f) => f.id === "fact_larry")).toBe(false);

    // Corrupted ID was removed from Firestore
    const patchedReport = firestoreDouble().document("trivia_reports/lint_fact_stevie")!;
    expect(patchedReport.data["duplicateFactIds"]).toEqual([]);
  });
});

