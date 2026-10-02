import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  applySourcePolicy,
  reviewReportWithCopilot,
  scoreFactCandidateQuality,
  compareDuplicateCandidates,
  isDuplicateDecisionSafe,
  type CopilotInput,
  type CopilotSource,
} from "@/lib/admin/report-copilot.server";

vi.mock("@/lib/firebase/credentials.server", () => ({
  getAccessToken: vi.fn(async () => "mock-token"),
}));

describe("report-copilot", () => {
  beforeEach(() => {
    process.env["GOOGLE_CLOUD_PROJECT"] = "test-project";
    process.env["VERTEX_LOCATION"] = "global";
    vi.restoreAllMocks();
  });

  it("applies source policy correctly against target number", () => {
    const sources: CopilotSource[] = [
      {
        url: "https://example.com/1",
        title: "Source 1",
        excerpts: ["There are 7 Super Bowls won."],
        value: 7,
        stance: "supports",
        conflicting: false,
      },
      {
        url: "https://example.com/2",
        title: "Source 2",
        excerpts: ["Tom Brady won 7 Super Bowls."],
        value: 7,
        stance: "supports",
        conflicting: false,
      },
    ];

    const result = applySourcePolicy(sources, 7, "high");
    expect(result.confidence).toBe("high");
    expect(result.policy.needsReview).toBe(false);
    expect(result.policy.score).toBeGreaterThan(90);
  });

  it("handles duplicate fact candidates and parses duplicate_resolution", async () => {
    const mockResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  verdict: "resolve_duplicate",
                  confidence: "high",
                  rationale:
                    "Fact B has a clearer question formulation and the verified true number 7 matches authoritative sources.",
                  suggested: {
                    true_number: 7,
                    note: "Keep Fact B (fact_2) and retire Fact A (fact_1).",
                  },
                  duplicate_resolution: {
                    keep_fact_id: "fact_2",
                    retire_fact_ids: ["fact_1"],
                    action: "keep_one",
                    reason: "Fact B has clearer wording and fewer flags.",
                  },
                  sources: [
                    {
                      url: "https://nfl.com/stats",
                      title: "NFL Official",
                      excerpt: "Tom Brady has 7 Super Bowl rings.",
                      value: 7,
                      stance: "supports",
                    },
                  ],
                }),
              },
            ],
          },
          groundingMetadata: {
            groundingChunks: [{ web: { uri: "https://nfl.com/stats", title: "NFL Official" } }],
            groundingSupports: [
              {
                segment: { text: "Tom Brady has 7 Super Bowl rings." },
                groundingChunkIndices: [0],
              },
            ],
          },
        },
      ],
    };

    let sentBody: Record<string, unknown> | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      sentBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        status: 200,
        json: async () => mockResponse,
      } as Response;
    });

    const input: CopilotInput = {
      topic: "Tom Brady",
      claimStatement: "Tom Brady won {n} Super Bowls.",
      presentedNumber: 6,
      trueNumber: 7,
      unit: "Super Bowls",
      reason: "duplicate_question",
      feedbackText: "",
      fact: {
        id: "fact_1",
        subject: "Tom Brady",
        angle: "Super Bowls won",
        question: "How many Super Bowls did Tom Brady win?",
        claim_template: "Tom Brady won {n} Super Bowls.",
        true_number: 7,
        unit: "Super Bowls",
        context: "NFL legend Tom Brady",
        source_urls: ["https://nfl.com"],
        quality_flags: ["duplicate_question"],
      },
      duplicateFacts: [
        {
          id: "fact_2",
          subject: "Tom Brady",
          angle: "Super Bowl titles",
          question: "How many Super Bowl titles did Tom Brady win in his NFL career?",
          claim_template: "Tom Brady won {n} Super Bowl titles in his NFL career.",
          true_number: 7,
          unit: "Super Bowls",
          quality_flags: [],
        },
      ],
    };

    const review = await reviewReportWithCopilot(input);

    expect(review.verdict).toBe("resolve_duplicate");
    expect(review.duplicateResolution).toBeDefined();
    expect(review.duplicateResolution?.keepFactId).toBe("fact_2");
    expect(review.duplicateResolution?.retireFactIds).toEqual(["fact_1"]);
    expect(review.duplicateResolution?.action).toBe("keep_one");
    expect(review.suggested.true_number).toBe(7);

    // Verify sent prompt contains candidate duplicate facts
    expect(sentBody).toBeDefined();
    const promptText = (sentBody as unknown as { contents?: Array<{ parts?: Array<{ text?: string }> }> })
      ?.contents?.[0]?.parts?.[0]?.text;
    expect(promptText).toContain("primaryFactA");
    expect(promptText).toContain("candidateDuplicateFacts");
    expect(promptText).toContain("fact_2");
  });

  it("handles fallback duplicate resolution when model returns keep_fact_id without duplicate_resolution block", async () => {
    const mockResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  verdict: "resolve_duplicate",
                  confidence: "medium",
                  rationale: "Fact 2 is the better question.",
                  suggested: {
                    true_number: 10,
                  },
                  keep_fact_id: "fact_2",
                  sources: [
                    {
                      url: "https://example.com",
                      title: "Example",
                      excerpt: "Value is 10.",
                      value: 10,
                      stance: "supports",
                    },
                  ],
                }),
              },
            ],
          },
        },
      ],
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => mockResponse,
      } as Response;
    });

    const input: CopilotInput = {
      topic: "Testing",
      claimStatement: "Testing claim",
      presentedNumber: null,
      trueNumber: 10,
      unit: "items",
      reason: "duplicate_question",
      feedbackText: "",
      fact: {
        id: "fact_1",
        subject: "Testing",
        angle: "Angle 1",
        question: "Q1",
        claim_template: "Claim 1 {n}",
        true_number: 10,
        unit: "items",
        context: "",
        source_urls: [],
      },
      duplicateFacts: [
        {
          id: "fact_2",
          subject: "Testing",
          angle: "Angle 2",
          question: "Q2",
          claim_template: "Claim 2 {n}",
          true_number: 10,
          unit: "items",
        },
      ],
    };

    const review = await reviewReportWithCopilot(input);
    expect(review.verdict).toBe("resolve_duplicate");
    expect(review.duplicateResolution?.keepFactId).toBe("fact_2");
    expect(review.duplicateResolution?.retireFactIds).toEqual(["fact_1"]);
  });

  it("scores duplicate candidates and breaks ties when both have identical true numbers", () => {
    const candidateA = {
      id: "fact_a",
      subject: "Apollo 11",
      angle: "Moonwalk Duration",
      question: "Apollo 11 lunar surface moonwalk duration in hours",
      claim_template: "The moonwalk lasted {n} hours.",
      true_number: 2.5,
      unit: "hours",
      context: "Armstrong and Aldrin spent approximately 2.5 hours on the lunar surface during Apollo 11.",
      source_urls: ["https://history.nasa.gov/apollo11.html", "https://airandspace.si.edu/apollo11"],
      quality_flags: [], // 0 flags!
      status: "active",
    };

    const candidateB = {
      id: "fact_b",
      subject: "Apollo 11",
      angle: "Moonwalk Duration",
      question: "Moonwalk", // under-specified stub!
      claim_template: "Moonwalk lasted 2.5 hours", // missing {n}!
      true_number: 2.5,
      unit: "hours",
      context: "",
      source_urls: [],
      quality_flags: ["bounds_chart_position"], // 1 flag!
      status: "disputed",
    };

    const scoreA = scoreFactCandidateQuality(candidateA, 2.5);
    const scoreB = scoreFactCandidateQuality(candidateB, 2.5);

    expect(scoreA.score).toBeGreaterThan(scoreB.score);

    const comparison = compareDuplicateCandidates([candidateA, candidateB], 2.5);
    expect(comparison.recommendedWinnerId).toBe("fact_a");
    expect(comparison.retireIds).toEqual(["fact_b"]);
    expect(comparison.tieBreakReason).toContain("fact_a chosen over fact_b");
    expect(comparison.tieBreakReason).toContain("clean quality state");
    expect(comparison.tieBreakReason).toContain("valid {n} claim template");
    expect(comparison.tieBreakReason).toContain("richer prompt description");
  });

  it("scoreFactCandidateQuality penalizes missing {n} and rewards engaging, well-sized prompts over stubs", () => {
    const naturalPrompt = scoreFactCandidateQuality({
      id: "fact_1",
      subject: "Cheetah",
      angle: "Speed",
      question: "A cheetah's top sprint speed in mph",
      claim_template: "A cheetah runs at {n} mph.",
      true_number: 70,
      unit: "mph",
    });

    const questionStylePrompt = scoreFactCandidateQuality({
      id: "fact_2",
      subject: "Cheetah",
      angle: "Speed",
      question: "How fast can a cheetah run in mph?",
      claim_template: "A cheetah runs at {n} mph.",
      true_number: 70,
      unit: "mph",
    });

    const stubPrompt = scoreFactCandidateQuality({
      id: "fact_stub",
      subject: "Cheetah",
      angle: "Speed",
      question: "Cheetah", // Under-specified stub
      claim_template: "A cheetah runs at {n} mph.",
      true_number: 70,
      unit: "mph",
    });

    const brokenTemplate = scoreFactCandidateQuality({
      id: "fact_3",
      subject: "Cheetah",
      angle: "Speed",
      question: "A cheetah's top sprint speed in mph",
      claim_template: "A cheetah runs at 70 mph.", // Missing {n}
      true_number: 70,
      unit: "mph",
    });

    // Both natural setup and conversational question are well-sized and engaging (+15)
    expect(naturalPrompt.breakdown).toContain("engaging, well-sized card prompt (+15)");
    expect(questionStylePrompt.breakdown).toContain("engaging, well-sized card prompt (+15)");
    expect(naturalPrompt.score).toBe(questionStylePrompt.score);

    // Stubs receive partial score (+5)
    expect(stubPrompt.score).toBeLessThan(naturalPrompt.score);
    expect(stubPrompt.breakdown).toContain("under-specified / stub prompt (+5)");

    // Missing {n} gets heavily penalized (-30 vs +25 -> 55 pt difference)
    expect(naturalPrompt.score - brokenTemplate.score).toBe(55);
    expect(brokenTemplate.breakdown).toContain("malformed: claim template missing {n} (-30)");
  });

  it("identifies safe vs unsafe duplicate decisions for bulk application", () => {
    const safeReview = {
      verdict: "resolve_duplicate" as const,
      confidence: "high" as const,
      rationale: "Clean duplicate collision. Fact A is sound.",
      suggested: { true_number: 10 },
      duplicateResolution: {
        keepFactId: "fact_a",
        retireFactIds: ["fact_b"],
        action: "keep_one" as const,
        reason: "Fact A has 0 flags and verified citations.",
      },
      sources: [
        {
          url: "https://example.com/source1",
          title: "Source 1",
          excerpts: ["Value is 10."],
          value: 10,
          stance: "supports" as const,
          conflicting: false,
        },
      ],
      policy: {
        needsReview: false,
        reasons: [],
        modelConfidence: "high" as const,
        score: 95,
        factors: [],
      },
      model: "gemini-3.8-flash",
    };

    const candidates = [
      {
        id: "fact_a",
        subject: "Topic",
        angle: "Angle",
        question: "Q?",
        claim_template: "T {n}",
        true_number: 10,
        unit: "items",
      },
      {
        id: "fact_b",
        subject: "Topic",
        angle: "Angle",
        question: "Q?",
        claim_template: "T {n}",
        true_number: 10,
        unit: "items",
      },
    ];

    const safeCheck = isDuplicateDecisionSafe(safeReview, candidates);
    expect(safeCheck.safe).toBe(true);
    expect(safeCheck.reasons).toEqual([]);

    // Low confidence / needs review -> should NOT be safe
    const unsafeReview = {
      ...safeReview,
      confidence: "medium" as const,
      policy: {
        ...safeReview.policy,
        needsReview: true,
        reasons: ["Sources disagree by >5%"],
        score: 60,
      },
      sources: [
        {
          ...safeReview.sources[0],
          conflicting: true,
        },
      ],
    };

    const unsafeCheck = isDuplicateDecisionSafe(unsafeReview, candidates);
    expect(unsafeCheck.safe).toBe(false);
    expect(unsafeCheck.reasons.length).toBeGreaterThan(0);

    // Winner with missing {n} in claim_template -> should NOT be safe
    const invalidTemplateCandidates = [
      { ...candidates[0], claim_template: "No placeholder here" },
      candidates[1],
    ];
    const invalidTemplateCheck = isDuplicateDecisionSafe(safeReview, invalidTemplateCandidates);
    expect(invalidTemplateCheck.safe).toBe(false);
    expect(invalidTemplateCheck.reasons.some((r) => r.includes("invalid claim template"))).toBe(true);
  });

  it("handles unbanked AI claims with add_to_bank verdict and suggestions", async () => {
    const mockResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  verdict: "add_to_bank",
                  confidence: "high",
                  rationale: "The claim is verifiable and true. Recommend adding to bank.",
                  suggested: {
                    subject: "Deepest Lake",
                    angle: "Lake Baikal Depth",
                    true_number: 1642,
                    unit: "meters",
                    question: "How many meters deep is Lake Baikal at its maximum depth?",
                    claim_template: "Lake Baikal reaches a maximum depth of {n} meters.",
                    context: "Lake Baikal in Siberia is the world's deepest and oldest freshwater lake.",
                    quantity_kind: "length",
                    surprise_factor: 2,
                    difficulty_hint: "medium",
                    note: "Added to fact bank via verified AI trivia report.",
                  },
                  sources: [
                    {
                      url: "https://britannica.com/place/Lake-Baikal",
                      title: "Lake Baikal | Britannica",
                      excerpt: "Lake Baikal has a maximum depth of 1,642 metres.",
                      value: 1642,
                      stance: "supports",
                    },
                  ],
                }),
              },
            ],
          },
          groundingMetadata: {
            groundingChunks: [{ web: { uri: "https://britannica.com/place/Lake-Baikal", title: "Britannica" } }],
            groundingSupports: [
              {
                segment: { text: "Lake Baikal has a maximum depth of 1,642 metres." },
                groundingChunkIndices: [0],
              },
            ],
          },
        },
      ],
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => mockResponse,
      } as Response;
    });

    const input: CopilotInput = {
      topic: "Deepest Lake",
      claimStatement: "Lake Baikal is 1642 meters deep.",
      presentedNumber: 1500,
      trueNumber: 1642,
      unit: "meters",
      reason: "player_report",
      feedbackText: "Great question!",
      fact: null, // Unbanked claim!
    };

    const review = await reviewReportWithCopilot(input);
    expect(review.verdict).toBe("add_to_bank");
    expect(review.suggested.subject).toBe("Deepest Lake");
    expect(review.suggested.true_number).toBe(1642);
    expect(review.suggested.quantity_kind).toBe("length");
  });
});
