import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  useServerFn: () => vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ error: null, isPending: false, mutate: vi.fn() }),
  useQuery: () => ({ data: undefined }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  Link: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement("a", props, children),
}));

vi.mock("@/index", () => {
  const Wrapper = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    Badge: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
      createElement("span", props, children),
    Button: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
      createElement("button", props, children),
    Card: Wrapper,
    CardLabel: Wrapper,
    CardTitle: ({ children }: { children?: ReactNode }) => createElement("h2", null, children),
  };
});

vi.mock("@/admin/AdminShell", () => {
  const Wrapper = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    ErrorNote: () => null,
    FactStatusBadge: ({ status }: { status: string }) => createElement("span", null, status),
    InfoTip: () => null,
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
  createCorrectedReplacement: {},
  exportFactsData: {},
  fetchBankObservability: {},
  fetchFacts: {},
  saveFact: {},
}));
vi.mock("@/lib/admin/ops.functions", () => ({ fetchPlaylists: {}, fetchSubjects: {} }));
vi.mock("@/lib/admin/taxonomy", () => ({
  CONTENT_VIEWS: ["facts"],
  GENRES: ["General"],
  familiesForGenre: () => [],
  isContentView: () => true,
}));
vi.mock("@/lib/admin/contract", () => ({
  QK: { count: "count" },
  STATUS: { active: "active", pending: "pending", disputed: "disputed", retired: "retired" },
}));

import { BankObservabilityPanel } from "@/routes/admin/facts";
import type { BankObservability } from "@/lib/admin/content.server";

const known: BankObservability = {
  checkedAt: "2026-09-24T12:00:00.000Z",
  deployed: {
    state: "known",
    stale: false,
    bankVersion: "bank-2026-09-24",
    factCount: 420,
    ddmVersion: "ddm-4",
  },
  firestore: {
    lifecycle: { active: 400, pending: 20, disputed: 3, retired: 7 },
    total: 430,
    active: 400,
  },
  exportedDelta: -20,
  exportedDeltaDefinition:
    "Firestore active lifecycle count minus deployed fact_count; export filters can make the populations differ.",
};

describe("bank observability UI", () => {
  it("shows deployed versions, Firestore lifecycle counts, and the exact delta", () => {
    const html = renderToStaticMarkup(createElement(BankObservabilityPanel, { data: known }));

    expect(html).toContain("Deployed vs Firestore");
    expect(html).toContain("Deployed bank_version");
    expect(html).toContain("bank-2026-09-24");
    expect(html).toContain("Deployed fact_count");
    expect(html).toContain("420");
    expect(html).toContain("Deployed ddm_version");
    expect(html).toContain("ddm-4");
    expect(html).toContain("Firestore lifecycle counts");
    expect(html).toContain("active");
    expect(html).toContain("pending");
    expect(html).toContain("disputed");
    expect(html).toContain("retired");
    expect(html).toContain("Exported vs Firestore delta");
    expect(html).toContain("-20");
    expect(html).toContain("Firestore active lifecycle count minus deployed fact_count");
  });

  it("shows unknown/stale without inventing a version when deployment cannot be verified", () => {
    const html = renderToStaticMarkup(
      createElement(BankObservabilityPanel, {
        data: {
          ...known,
          deployed: {
            state: "unknown",
            stale: true,
            reason: "The Game Worker bank-version endpoint returned HTTP 503.",
          },
          exportedDelta: null,
        },
      }),
    );

    expect(html).toContain("Deployed bank version unknown or stale.");
    expect(html).toContain("HTTP 503");
    expect(html).toContain("No deployed version is shown");
    expect(html).not.toContain("bank-2026-09-24");
    expect(html).not.toContain("Deployed fact_count");
  });

  it("always explains the complete hydration propagation path", () => {
    const html = renderToStaticMarkup(createElement(BankObservabilityPanel, { data: known }));

    expect(html).toContain("Hydration path.");
    expect(html).toContain(
      "Firestore changes go live only after export, hydration PR merge, and Worker deployment.",
    );
    expect(html).toContain("Firestore itself is never the live serving source.");
  });
});
