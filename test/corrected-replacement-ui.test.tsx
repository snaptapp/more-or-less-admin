import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MutationOptions = {
  mutationFn?: () => Promise<unknown> | unknown;
  onSuccess?: (result: unknown) => Promise<void> | void;
};

const harness = vi.hoisted(() => {
  const mutationOptions: MutationOptions[] = [];
  const replacementPayloads: Record<string, unknown>[] = [];
  const invalidateQueries = vi.fn(async () => undefined);
  const onCommitted = vi.fn();
  const create = vi.fn(async (input: { data: Record<string, unknown> }) => {
    replacementPayloads.push(input.data);
    return {
      original: { id: "original-fact", status: "retired" },
      replacement: { id: "replacement-fact", status: "pending" },
    };
  });
  return {
    create,
    invalidateQueries,
    mutationOptions,
    onCommitted,
    replacementPayloads,
  };
});

vi.mock("@tanstack/react-start", () => ({
  useServerFn: () => harness.create,
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: harness.invalidateQueries }),
  useQuery: () => ({ data: { subjects: [] } }),
  useMutation: (options: MutationOptions) => {
    harness.mutationOptions.push(options);
    return { error: null, isPending: false, mutate: vi.fn() };
  },
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  Link: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement("a", props, children),
}));

vi.mock("@/index", () => {
  const Wrapper = ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children);
  const Button = ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement("button", props, children);
  const Badge = ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement("span", props, children);
  return {
    Badge,
    Button,
    Card: Wrapper,
    CardLabel: Wrapper,
    CardTitle: ({ children }: { children?: ReactNode }) => createElement("h2", null, children),
  };
});

vi.mock("@/admin/AdminShell", () => {
  const Wrapper = ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children);
  return {
    ErrorNote: () => null,
    FactStatusBadge: ({ status }: { status: string }) => createElement("span", null, status),
    InfoTip: ({ text }: { text: string }) => createElement("span", { "aria-label": text }, "?"),
    InlineEditorRow: Wrapper,
    PageHead: Wrapper,
    adminAuthorizedTargetsFor: (status: string) => (status === "active" ? ["retired"] : []),
  };
});

vi.mock("@/admin/taxonomyPanels", () => ({
  CrawlQueue: () => null,
  PlaylistsPanel: () => null,
  TopicsPanel: () => null,
}));

vi.mock("@/admin/FactsBankChat", () => ({ FactsBankChat: () => null }));

vi.mock("@/lib/admin/content.functions", () => ({
  addFact: {},
  bulkImportFacts: {},
  changeFactStatus: {},
  createCorrectedReplacement: {},
  exportFactsData: {},
  fetchFacts: {},
  saveFact: {},
}));

vi.mock("@/lib/admin/ops.functions", () => ({
  fetchPlaylists: {},
  fetchSubjects: {},
}));

vi.mock("@/lib/admin/taxonomy", () => ({
  CONTENT_VIEWS: ["facts"],
  GENRES: ["General", "Animals & Nature"],
  matchScopesForGenre: () => [],
  isContentView: () => true,
}));

vi.mock("@/lib/admin/contract", () => ({
  QK: { count: "count" },
  STATUS: { active: "active", pending: "pending", retired: "retired" },
}));

import {
  CorrectedReplacementForm,
  FactEditor,
  PENDING_PROMOTION_COPY,
} from "@/routes/admin/facts";

const fact = {
  id: "original-fact",
  subject: "Giraffe",
  subject_key: "giraffe",
  angle: "Neck vertebrae",
  angle_key: "neck vertebrae",
  true_number: 7,
  unit: "vertebrae",
  claim_template: "A giraffe has {n} cervical vertebrae.",
  context: "Most mammals have seven cervical vertebrae.",
  question: "How many cervical vertebrae does a giraffe have?",
  surprise_factor: 2,
  content_rating: "standard",
  status: "active",
  previous_true_number: null,
  source_urls: ["https://example.com/giraffe"],
  verifier_model: "test-model",
  verified_at: null,
  served_count: 4,
  last_served_at: null,
  category: "General",
  derivation: null,
  quantity_kind: "count",
  plausible_min: "1",
  plausible_max: "10",
  quality_flags: [],
  disputed_reason: null,
  number_pinned: false,
  pinned_reason: null,
  retired_reason: null,
  updateTime: "2026-09-24T12:00:00.000Z",
} as unknown as Parameters<typeof FactEditor>[0]["fact"];

function renderEditor(): string {
  return renderToStaticMarkup(createElement(FactEditor, { fact, onDone: vi.fn() }));
}

function renderReplacement(): string {
  return renderToStaticMarkup(
    createElement(CorrectedReplacementForm, {
      fact,
      onDone: vi.fn(),
      onCommitted: harness.onCommitted,
    }),
  );
}

describe("corrected replacement UI", () => {
  beforeEach(() => {
    harness.mutationOptions.length = 0;
    harness.replacementPayloads.length = 0;
    harness.invalidateQueries.mockClear();
    harness.onCommitted.mockClear();
    harness.create.mockClear();
  });

  it("offers the immutable correction action beside the read-only identity editor", () => {
    const html = renderEditor();

    expect(html).toContain("Create corrected replacement");
    expect(html).toContain("Subject and angle are immutable identity fields.");
    expect(html).toContain('id="fact-identity-subject"');
    expect(html).toContain('id="fact-identity-angle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="corrected-replacement-form"');
    expect(html).toContain("Subject and angle are immutable identity fields.");
  });

  it("prefills the replacement form and explains retirement and pending admission", () => {
    const html = renderReplacement();

    expect(html).toContain('id="corrected-replacement-form"');
    expect(html).toContain('aria-labelledby="corrected-replacement-title"');
    expect(html).toContain('aria-describedby="corrected-replacement-lifecycle-note"');
    expect(html).toContain("Original retirement + pending admission.");
    expect(html).toContain("the original will be retired when it is created");
    expect(html).toContain("pending Foundry admission");
    expect(html).toContain("Foundry");
    expect(html).toContain(PENDING_PROMOTION_COPY);
    expect(html).toContain('value="Giraffe"');
    expect(html).toContain('value="Neck vertebrae"');
    expect(html).toContain('value="7"');
    expect(html).toContain('value="A giraffe has {n} cervical vertebrae."');
    expect(html).toContain('class="admin-grid"');
    expect(html).toContain('class="admin-row-actions"');
    expect(html).toContain("Create replacement and retire original");
  });

  it("submits a prefilled pending replacement without status or verification metadata", async () => {
    renderReplacement();
    const mutation = harness.mutationOptions.at(-1);
    if (!mutation?.mutationFn) throw new Error("replacement mutation was not registered");

    await mutation.mutationFn();

    expect(harness.replacementPayloads).toHaveLength(1);
    const payload = harness.replacementPayloads[0];
    expect(payload).toMatchObject({
      originalId: "original-fact",
      originalUpdateTime: "2026-09-24T12:00:00.000Z",
      replacement: {
        subject: "Giraffe",
        angle: "Neck vertebrae",
        true_number: 7,
        unit: "vertebrae",
        claim_template: "A giraffe has {n} cervical vertebrae.",
        explanation: "Most mammals have seven cervical vertebrae.",
        question: "How many cervical vertebrae does a giraffe have?",
        quantity_kind: "count",
        content_rating: "standard",
        source_urls: ["https://example.com/giraffe"],
      },
    });
    expect(payload.replacement).not.toHaveProperty("status");
    expect(payload.replacement).not.toHaveProperty("verified_at");
    expect(payload.replacement).not.toHaveProperty("verifier_model");
  });

  it("refreshes the facts query and reports both committed statuses as retired/pending", async () => {
    renderReplacement();
    const mutation = harness.mutationOptions.at(-1);
    if (!mutation?.onSuccess) throw new Error("replacement success handler was not registered");

    const result = {
      original: { id: "original-fact", status: "retired" },
      replacement: { id: "replacement-fact", status: "pending" },
    };
    await mutation.onSuccess(result);

    expect(harness.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["facts"] });
    expect(harness.onCommitted).toHaveBeenCalledWith(result);
    expect(result.original.status).toBe("retired");
    expect(result.replacement.status).toBe("pending");
  });
});
