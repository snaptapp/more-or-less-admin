import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MutationOptions = {
  mutationFn?: () => Promise<unknown> | unknown;
};

const harness = vi.hoisted(() => {
  const mutationOptions: MutationOptions[] = [];
  const admissionPayloads: Record<string, unknown>[] = [];
  const save = vi.fn(async (input: { data: Record<string, unknown> }) => {
    admissionPayloads.push(input.data);
    return input.data;
  });
  return {
    admissionPayloads,
    mutationOptions,
    save,
  };
});

vi.mock("@tanstack/react-start", () => ({
  useServerFn: () => harness.save,
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn(async () => undefined) }),
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
  return { Badge, Button, Card: Wrapper, CardLabel: Wrapper, CardTitle };
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
    adminAuthorizedTargetsFor: (status: string) => (status === "pending" ? ["active"] : []),
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
  GENRES: ["General", "Animals & Nature", "History & World"],
  matchScopesForGenre: () => [],
  isContentView: () => true,
}));

vi.mock("@/lib/admin/contract", () => ({
  QK: { count: "count" },
  STATUS: { active: "active", pending: "pending" },
}));

import {
  FactEditor,
  ImportCsvModal,
  NewFactForm,
  PENDING_ADMISSION_COPY,
  PENDING_PROMOTION_COPY,
} from "@/routes/admin/facts";

const fact = {
  id: "pending_fact",
  subject: "Giraffe",
  subject_key: "giraffe",
  angle: "Neck vertebrae",
  angle_key: "neck vertebrae",
  true_number: 7,
  unit: "vertebrae",
  claim_template: "A giraffe has {n} cervical vertebrae.",
  context: "Giraffes have seven cervical vertebrae.",
  question: "How many cervical vertebrae does a giraffe have?",
  surprise_factor: 2,
  content_rating: "standard",
  status: "pending",
  previous_true_number: null,
  source_urls: [],
  verifier_model: "",
  verified_at: null,
  served_count: 0,
  last_served_at: null,
  category: "Animals & Nature",
  derivation: null,
  quantity_kind: "count",
  plausible_min: null,
  plausible_max: null,
  quality_flags: [],
  disputed_reason: null,
  number_pinned: false,
  pinned_reason: null,
} as unknown as Parameters<typeof FactEditor>[0]["fact"];

function renderEditor(): string {
  return renderToStaticMarkup(createElement(FactEditor, { fact, onDone: vi.fn() }));
}

function renderNewForm(): string {
  return renderToStaticMarkup(createElement(NewFactForm, { onDone: vi.fn() }));
}

function renderImport(): string {
  return renderToStaticMarkup(createElement(ImportCsvModal, { onDone: vi.fn() }));
}

describe("pending fact admission UI", () => {
  beforeEach(() => {
    harness.mutationOptions.length = 0;
    harness.admissionPayloads.length = 0;
    harness.save.mockClear();
  });

  it("shows pending status and the Foundry-only promotion boundary", () => {
    const html = renderEditor();

    expect(html).toContain("pending");
    expect(html).toContain("Foundry audit");
    expect(html).toContain("only promoter");
    expect(html).toContain(PENDING_ADMISSION_COPY);
    expect(html).toContain(PENDING_PROMOTION_COPY);
    expect(html).not.toContain("Verify &amp; approve");
    expect(html).not.toContain("Reinstate active");
  });

  it("uses the auditor-facing fields in the new-fact form and submits no active metadata", async () => {
    const html = renderNewForm();

    expect(html).toContain("Claim template");
    expect(html).toContain("Reveal explanation");
    expect(html).toContain("Quantity kind");
    expect(html).toContain("Plausible min");
    expect(html).toContain("Plausible max");
    expect(html).toContain("Match Scope");
    expect(html).toContain("Save as pending");
    expect(html).toContain(PENDING_ADMISSION_COPY);
    expect(html).toContain("admin-grid");

    const mutation = harness.mutationOptions.at(-1);
    if (!mutation?.mutationFn) throw new Error("new-fact mutation was not registered");
    await mutation.mutationFn();

    const payload = harness.admissionPayloads.at(-1);
    expect(payload).toBeDefined();
    expect(payload).toMatchObject({
      subject: "",
      angle: "",
      true_number: 0,
      unit: "",
      claim_template: "",
      explanation: "",
      question: "",
      quantity_kind: "count",
      content_rating: "standard",
    });
    expect(payload).not.toHaveProperty("context");
    expect(payload).not.toHaveProperty("status");
    expect(payload).not.toHaveProperty("verified_at");
    expect(payload).not.toHaveProperty("verifier_model");
  });

  it("documents exact CSV admission columns while accepting legacy context aliases", () => {
    const html = renderImport();

    expect(html).toContain("Every row is admitted as pending");
    expect(html).toContain("claim_template");
    expect(html).toContain("explanation");
    expect(html).toContain("Legacy");
    expect(html).toContain("context</code> headers remain accepted");
    expect(html).toContain("Import facts from CSV");
    expect(html).toContain(PENDING_ADMISSION_COPY);
    expect(html).toContain("admin-toolbar");
  });
});
