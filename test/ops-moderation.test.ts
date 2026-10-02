import { beforeEach, describe, expect, it, vi } from "vitest";
import { firestoreDouble } from "./setup";

vi.mock("@/lib/firebase/firestore.server", async () => {
  const { firestoreDouble } = await import("./setup");
  return firestoreDouble().module;
});

const reviewReportWithCopilot = vi.hoisted(() => vi.fn());

vi.mock("@/lib/admin/report-copilot.server", () => ({
  reviewReportWithCopilot,
}));

import {
  moderationAct,
  moderationCopilot,
  moderationQueue,
  ModerationRequestError,
  recommendModerationAction,
} from "@/lib/admin/ops-moderation.server";

const FACT = {
  status: "active",
  subject: "Disco",
  subject_key: "disco",
  angle: "Peak year",
  angle_key: "peak-year",
  true_number: 1978,
  unit: "year",
  question: "In what year did disco peak?",
  claim_template: "Disco peaked in {n}",
  explanation: "Billboard's disco peak.",
  source_urls: ["https://example.com/disco"],
  verifier_model: "foundry",
  category: "Music",
  content_rating: "standard",
  quality_flags: ["bounds_chart_position"],
};

describe("ops moderation queue", () => {
  beforeEach(() => {
    reviewReportWithCopilot.mockReset();
    firestoreDouble().seedMany({
      "fact_bank/f1": FACT,
      "trivia_reports/r1": {
        status: "pending_review",
        topic: "Disco",
        claimStatement: "Disco peaked in 1978",
        factId: "f1",
        trueNumber: 1978,
        presentedNumber: 1970,
        unit: "year",
        reason: "number looks wrong",
        feedbackText: "I think it was later",
        createdAt: "2026-10-01T00:00:00.000Z",
      },
      "trivia_reports/r2": {
        status: "pending_review",
        topic: "Unmatched",
        claimStatement: "A claim with no fact",
        trueNumber: 12,
        presentedNumber: 3,
        unit: "count",
        reason: "missing",
        feedbackText: "",
        createdAt: "2026-10-02T00:00:00.000Z",
      },
    });
  });

  it("returns the pending count and the inbox buttons for each report", async () => {
    const queue = await moderationQueue();
    expect(queue.count).toBe(2);
    expect(queue.truncated).toBe(false);
    const matched = queue.items.find((item) => item.report.id === "r1");
    const unmatched = queue.items.find((item) => item.report.id === "r2");
    expect(matched?.fact?.id).toBe("f1");
    expect(matched?.fact?.true_number).toBe(1978);
    expect(matched?.buttons.map((button) => button.action)).toEqual([
      "retire_fact",
      "fix_number",
      "edit_fact",
      "resolve_as_is",
      "reject",
    ]);
    expect(unmatched?.fact).toBeNull();
    expect(unmatched?.buttons.map((button) => button.action)).toEqual([
      "resolve_only",
      "add_to_bank",
      "reject",
    ]);
  });

  it("returns the full pending count and the next page after 100", async () => {
    const extra: Record<string, Record<string, unknown>> = {};
    for (let index = 0; index < 99; index += 1) {
      extra[`trivia_reports/p${index}`] = {
        status: "pending_review",
        topic: "Paged",
        claimStatement: `Paged claim ${index}`,
        createdAt: "2026-09-01T00:00:00.000Z",
      };
    }
    firestoreDouble().seedMany(extra);
    const first = await moderationQueue();
    expect(first.count).toBe(101);
    expect(first.items).toHaveLength(100);
    expect(first.truncated).toBe(true);
    expect(first.next_offset).toBe(100);
    const second = await moderationQueue(100);
    expect(second.count).toBe(101);
    expect(second.items).toHaveLength(1);
    expect(second.truncated).toBe(false);
    expect(second.next_offset).toBeNull();
    const seen = new Set([...first.items, ...second.items].map((item) => item.report.id));
    expect(seen.size).toBe(101);
  });

  it("rejects a pending report through the inbox reject button", async () => {
    const result = await moderationAct({ reportId: "r2", action: "reject", note: "Not a fact" });
    expect(result).toEqual({ ok: true, reportId: "r2", action: "reject" });
    expect(firestoreDouble().document("trivia_reports/r2")?.data["status"]).toBe("rejected");
  });

  it("refuses a number fix that does not include a corrected number", async () => {
    await expect(moderationAct({ reportId: "r1", action: "fix_number" })).rejects.toBeInstanceOf(
      ModerationRequestError,
    );
  });

  it("refuses a button the report does not show", async () => {
    await expect(moderationAct({ reportId: "r2", action: "retire_fact" })).rejects.toThrow(
      /not available/,
    );
  });

  it("runs copilot and recommends the matching button without applying it", async () => {
    reviewReportWithCopilot.mockResolvedValue({
      verdict: "fix_number",
      confidence: "high",
      rationale: "The peak year is 1977.",
      suggested: { true_number: 1977, note: "Use 1977" },
      sources: [],
      policy: {
        needsReview: false,
        reasons: [],
        modelConfidence: "high",
        score: 90,
        factors: [],
      },
      model: "gemini-3.8-flash",
    });
    const result = await moderationCopilot("r1");
    expect(result.recommendation).toMatchObject({
      apply: true,
      action: "fix_number",
      correctedNumber: 1977,
      factId: "f1",
    });
    expect(firestoreDouble().document("trivia_reports/r1")?.data["status"]).toBe("pending_review");
  });

  it("does not recommend pressing a button when copilot is unclear", () => {
    const recommendation = recommendModerationAction(
      {
        verdict: "unclear",
        suggested: {},
        policy: { needsReview: true, reasons: ["No sources"], modelConfidence: "low", score: 10, factors: [] },
      },
      [{ action: "reject", label: "Reject report" }],
    );
    expect(recommendation.apply).toBe(false);
    expect(recommendation.action).toBeNull();
  });
});
