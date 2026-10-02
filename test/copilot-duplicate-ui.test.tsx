import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { BulkDuplicateHub, CopilotPanel, ReportCard } from "@/routes/admin/reports";

type MutationOptions = {
  mutationFn?: (args?: unknown) => Promise<unknown> | unknown;
};

const harness = vi.hoisted(() => {
  const mutationOptions: MutationOptions[] = [];
  const serverFnCalls: Record<string, unknown>[] = [];
  const mutationResult = {
    data: undefined as unknown,
    error: null,
    isPending: false,
    mutate: vi.fn(),
  };
  const serverFn = vi.fn(async (input: { data: Record<string, unknown> }) => {
    serverFnCalls.push(input.data);
    return input.data;
  });
  return {
    mutationOptions,
    mutationResult,
    serverFn,
    serverFnCalls,
  };
});

vi.mock("@tanstack/react-start", () => {
  const chain = {
    middleware: () => chain,
    inputValidator: () => chain,
    handler: () => chain,
    client: () => chain,
    server: () => chain,
  };
  return {
    useServerFn: () => harness.serverFn,
    createServerFn: () => chain,
    createMiddleware: () => chain,
  };
});

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn(async () => undefined) }),
  useQuery: () => ({ data: [], isLoading: false, error: null }),
  useMutation: (options: MutationOptions) => {
    harness.mutationOptions.push(options);
    return harness.mutationResult;
  },
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  Link: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement("a", props, children),
}));

vi.mock("@/index", () => {
  const Wrapper = ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement("div", props, children);
  const Button = ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement("button", props, children);
  const Badge = ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement("span", props, children);
  const CardTitle = ({ children }: { children?: ReactNode }) =>
    createElement("h2", null, children);
  return { Badge, Button, Card: Wrapper, CardLabel: Wrapper, CardTitle };
});

vi.mock("@/admin/AdminShell", () => {
  const Wrapper = ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children);
  return {
    ErrorNote: () => null,
    PageHead: Wrapper,
    statusTone: () => "neutral",
  };
});

vi.mock("@/admin/LintFindings", () => ({
  LintFindings: () => createElement("div", null, "Lint findings"),
}));

describe("Copilot duplicate moderation UI", () => {
  beforeEach(() => {
    harness.mutationOptions.length = 0;
    harness.serverFnCalls.length = 0;
    harness.mutationResult.data = undefined;
    vi.restoreAllMocks();
  });

  it("CopilotPanel renders duplicate recommendation and duplicate-aware prefill note", () => {
    const mockReview = {
      verdict: "resolve_duplicate" as const,
      confidence: "high" as const,
      rationale: "Fact B is accurately verified by official records.",
      suggested: {
        true_number: 7,
        note: "Keep Fact B (fact_2) and retire Fact A (fact_1).",
      },
      duplicateResolution: {
        keepFactId: "fact_2",
        retireFactIds: ["fact_1"],
        action: "keep_one" as const,
        reason: "Fact B has clearer phrasing and zero quality flags.",
      },
      sources: [
        {
          url: "https://example.com",
          title: "Official Records",
          excerpts: ["Total is 7."],
          value: 7,
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

    harness.mutationResult.data = mockReview;

    const html = renderToStaticMarkup(
      createElement(CopilotPanel, {
        reportId: "report_1",
        hasFact: true,
        hasDuplicates: true,
        duplicateCandidateIds: ["fact_2"],
        onPrefill: vi.fn(),
        onResult: vi.fn(),
      }),
    );

    expect(html).toContain("Duplicate Recommendation");
    expect(html).toContain("Keep Fact (fact_2) &amp; Retire other(s)");
    expect(html).toContain("Fact B has clearer phrasing and zero quality flags.");
    expect(html).toContain("Prefills duplicate winner and resolution details below.");
  });

  it("ReportCard renders duplicate comparison cards and actions", () => {
    const entry = {
      report: {
        id: "rep_1",
        topic: "Tom Brady",
        claimStatement: "Tom Brady won {n} Super Bowls.",
        explanation: "",
        presentedNumber: 6,
        trueNumber: 7,
        unit: "Super Bowls",
        reason: "duplicate_question",
        feedbackText: "",
        reporterUid: "user_1",
        status: "pending_review",
        createdAt: "2026-10-01T00:00:00.000Z",
        resolutionNote: null,
        factId: "fact_1",
        duplicateFactIds: ["fact_2"],
        ombudsmanSources: [],
        qualityFlags: ["duplicate_question"],
      },
      fact: {
        id: "fact_1",
        subject: "Tom Brady",
        subject_key: "tom brady",
        angle: "Super Bowls won",
        question: "How many Super Bowls did Tom Brady win?",
        claim_template: "Tom Brady won {n} Super Bowls.",
        true_number: 7,
        unit: "Super Bowls",
        status: "disputed",
        quality_flags: ["duplicate_question"],
        context: "NFL legend",
        source_urls: [],
      },
      duplicateFacts: [
        {
          id: "fact_2",
          subject: "Tom Brady",
          subject_key: "tom brady",
          angle: "Super Bowl titles",
          question: "How many Super Bowl titles did Tom Brady win?",
          claim_template: "Tom Brady won {n} Super Bowl titles.",
          true_number: 7,
          unit: "Super Bowls",
          status: "active",
          quality_flags: [],
          context: "",
          source_urls: [],
        },
      ],
    };

    type ReportEntry = Parameters<typeof ReportCard>[0]["entry"];
    const html = renderToStaticMarkup(createElement(ReportCard, { entry: entry as unknown as ReportEntry }));

    expect(html).toContain("2 Conflicting Facts");
    expect(html).toContain("Reported Fact (A)");
    expect(html).toContain("Duplicate Fact (B)");
    expect(html).toContain("Keep Fact A &amp; Retire Fact B");
    expect(html).toContain("Keep Fact B &amp; Retire Fact A");
    expect(html).toContain("Corrected number on winner (optional)");
    expect(html).toContain("Retire all duplicates");
  });

  it("ReportCard duplicate resolution mutation submits keepFactId, retireFactIds, and correctedNumber", async () => {
    const entry = {
      report: {
        id: "rep_apollo",
        topic: "Apollo 11",
        claimStatement: "Moonwalk lasted {n} hours.",
        trueNumber: 2.5,
        unit: "hours",
        reason: "duplicate_question",
        status: "pending_review",
        factId: "fact_a",
        duplicateFactIds: ["fact_b"],
        qualityFlags: ["duplicate_question"],
      },
      fact: {
        id: "fact_a",
        subject: "Apollo 11",
        question: "How long was the Apollo 11 moonwalk?",
        claim_template: "The moonwalk lasted {n} hours.",
        true_number: 2.5,
        unit: "hours",
        status: "disputed",
        quality_flags: ["duplicate_question"],
      },
      duplicateFacts: [
        {
          id: "fact_b",
          subject: "Apollo 11",
          question: "What was the Apollo 11 moonwalk duration?",
          claim_template: "The moonwalk lasted {n} hours.",
          true_number: 2.5,
          unit: "hours",
          status: "active",
          quality_flags: [],
        },
      ],
    };

    type ReportEntry = Parameters<typeof ReportCard>[0]["entry"];
    renderToStaticMarkup(createElement(ReportCard, { entry: entry as unknown as ReportEntry }));

    // Find the mutation registered for actOnReport
    const mutation = harness.mutationOptions.find((m) => m.mutationFn !== undefined);
    expect(mutation).toBeDefined();

    await mutation?.mutationFn?.({
      action: "resolve_duplicate",
      keepFactId: "fact_b",
      retireFactIds: ["fact_a"],
      correctedNumber: 3,
      note: "Keep Fact B with updated 3 hours",
    });

    expect(harness.serverFnCalls).toHaveLength(1);
    const call = harness.serverFnCalls[0];
    expect(call?.["action"]).toBe("resolve_duplicate");
    expect(call?.["keepFactId"]).toBe("fact_b");
    expect(call?.["retireFactIds"]).toEqual(["fact_a"]);
    expect(call?.["correctedNumber"]).toBe(3);
    expect(call?.["note"]).toBe("Keep Fact B with updated 3 hours");
  });

  it("BulkDuplicateHub returns null when no entries are provided", () => {
    const html = renderToStaticMarkup(createElement(BulkDuplicateHub, { entries: [] }));
    expect(html).toBe("");
  });

  it("BulkDuplicateHub renders collision badge and evaluate button when duplicate entries exist", () => {
    type HubEntries = Parameters<typeof BulkDuplicateHub>[0]["entries"];
    const entries: HubEntries = [
      {
        report: {
          id: "rep_dup_1",
          topic: "Deep Space",
          claimStatement: "Voyager 1 distance {n} AU",
          trueNumber: 160,
          unit: "AU",
          reason: "duplicate_question",
          status: "pending_review",
          factId: "fact_v1",
          duplicateFactIds: ["fact_v2"],
        },
        fact: {
          id: "fact_v1",
          subject: "Voyager 1",
          question: "How far is Voyager 1 in AU?",
          claim_template: "Voyager 1 is {n} AU away.",
          true_number: 160,
          unit: "AU",
          status: "active",
        },
        duplicateFacts: [
          {
            id: "fact_v2",
            subject: "Voyager 1",
            question: "Distance to Voyager 1 in AU?",
            claim_template: "Voyager 1 is {n} AU from Earth.",
            true_number: 160,
            unit: "AU",
            status: "active",
          },
        ],
      } as unknown as HubEntries[number],
    ];

    const html = renderToStaticMarkup(createElement(BulkDuplicateHub, { entries }));
    expect(html).toContain("Duplicate Collision Resolution Hub");
    expect(html).toContain("1 pending collision(s)");
    expect(html).toContain("Evaluate All Duplicates (1 new)");
    expect(html).toContain("Collapse Hub");
  });
});
