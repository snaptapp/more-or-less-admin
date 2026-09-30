import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MutationOptions = {
  mutationFn?: () => Promise<unknown> | unknown;
};

const harness = vi.hoisted(() => {
  const mutationOptions: MutationOptions[] = [];
  const savePayloads: Record<string, unknown>[] = [];
  const save = vi.fn(async (input: { data: Record<string, unknown> }) => {
    savePayloads.push(input.data);
    return input.data;
  });
  const invalidateQueries = vi.fn(async () => undefined);
  return { invalidateQueries, mutationOptions, save, savePayloads };
});

vi.mock("@tanstack/react-start", () => ({
  useServerFn: () => harness.save,
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
  const CardTitle = ({ children }: { children?: ReactNode }) =>
    createElement("h2", null, children);
  return {
    Badge,
    Button,
    Card: Wrapper,
    CardLabel: Wrapper,
    CardTitle,
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
    adminAuthorizedTargetsFor: () => [],
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
  GENRES: ["General"],
  matchScopesForGenre: () => [],
  isContentView: () => true,
}));

vi.mock("@/lib/admin/contract", () => ({
  QK: { count: "count" },
  STATUS: { active: "active", pending: "pending" },
}));

import { FactEditor } from "@/routes/admin/facts";

const fact = {
  id: "fact_ui",
  subject: "Giraffe",
  subject_key: "giraffe",
  angle: "Neck vertebrae",
  angle_key: "neck vertebrae",
  true_number: 7,
  unit: "vertebrae",
  claim_template: "How many neck vertebrae?: {n}",
  context: "Giraffes have seven neck vertebrae.",
  question: "How many neck vertebrae does a giraffe have?",
  surprise_factor: 2,
  content_rating: "standard",
  status: "active",
  previous_true_number: null,
  source_urls: [],
  verifier_model: "test",
  verified_at: null,
  served_count: 0,
  last_served_at: null,
  category: "General",
  derivation: null,
  quantity_kind: "",
  plausible_min: null,
  plausible_max: null,
  quality_flags: [],
  disputed_reason: null,
  number_pinned: false,
  pinned_reason: null,
} as unknown as Parameters<typeof FactEditor>[0]["fact"];

function inputFor(html: string, id: string): string {
  const match = html.match(new RegExp(`<input[^>]*\\bid="${id}"[^>]*>`));
  if (!match) throw new Error(`input ${id} was not rendered`);
  return match[0];
}

function renderEditor(): string {
  harness.mutationOptions.length = 0;
  harness.savePayloads.length = 0;
  harness.save.mockClear();
  return renderToStaticMarkup(createElement(FactEditor, { fact, onDone: vi.fn() }));
}

describe("fact identity editor UI", () => {
  beforeEach(() => {
    harness.mutationOptions.length = 0;
    harness.savePayloads.length = 0;
    harness.save.mockClear();
  });

  it("renders subject and angle as read-only identity fields with replacement guidance", () => {
    const html = renderEditor();
    const subjectInput = inputFor(html, "fact-identity-subject");
    const angleInput = inputFor(html, "fact-identity-angle");

    expect(subjectInput).toMatch(/\breadonly(?:=""|=)/i);
    expect(angleInput).toMatch(/\breadonly(?:=""|=)/i);
    expect(subjectInput).toContain('aria-readonly="true"');
    expect(angleInput).toContain('aria-readonly="true"');
    expect(subjectInput).not.toMatch(/\bdisabled\b/i);
    expect(angleInput).not.toMatch(/\bdisabled\b/i);
    expect(subjectInput).not.toMatch(/\bonchange=/i);
    expect(angleInput).not.toMatch(/\bonchange=/i);
    expect(html).toContain("Subject and angle are immutable identity fields.");
    expect(html).toContain("Corrections create a replacement fact rather than re-keying");
  });

  it("keeps identity fields out of the ordinary save payload", async () => {
    renderEditor();
    const saveOptions = harness.mutationOptions[0];
    if (!saveOptions?.mutationFn) throw new Error("save mutation was not registered");

    await saveOptions.mutationFn();

    expect(harness.save).toHaveBeenCalledTimes(1);
    expect(harness.savePayloads).toHaveLength(1);
    const payload = harness.savePayloads[0];
    expect(payload).not.toHaveProperty("subject");
    expect(payload).not.toHaveProperty("angle");
    expect(payload).toMatchObject({
      id: "fact_ui",
      true_number: 7,
      question: "How many neck vertebrae does a giraffe have?",
    });
  });

  it("preserves the responsive editor grid and ordinary editable value fields", () => {
    const html = renderEditor();

    expect(html).toContain('class="admin-grid"');
    const numberInput = html.match(/<input[^>]*type="number"[^>]*>/)?.[0];
    expect(numberInput).toBeDefined();
    expect(numberInput).not.toMatch(/\breadonly(?:=""|=)/i);
  });
});
