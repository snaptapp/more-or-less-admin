import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState, Fragment, type FormEvent } from "react";
import { Badge, Button, Card, CardLabel, CardTitle } from "@/index";
import { ErrorNote, InfoTip, PageHead, statusTone } from "@/admin/AdminShell";
import {
  addFact,
  bulkImportFacts,
  changeFactStatus,
  exportFactsData,
  fetchFacts,
  saveFact,
} from "@/lib/admin/content.functions";

export const Route = createFileRoute("/admin/facts")({
  head: () => ({
    meta: [
      { title: "Fact Bank — More or Less Admin" },
      { name: "description", content: "Search, edit and verify curated trivia facts." },
    ],
  }),
  component: FactsPage,
});

type Fact = Awaited<ReturnType<typeof fetchFacts>>["facts"][number];

function escapeCsv(val: unknown): string {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      row.push(field.trim());
      field = "";
    } else if ((char === "\r" || char === "\n") && !inQuotes) {
      if (char === "\r" && nextChar === "\n") i++;
      row.push(field.trim());
      if (row.some((cell) => cell.length > 0)) {
        rows.push(row);
      }
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field || row.length > 0) {
    row.push(field.trim());
    if (row.some((cell) => cell.length > 0)) {
      rows.push(row);
    }
  }

  return rows;
}const EMPTY_DRAFT = {
  subject: "",
  angle: "",
  true_number: "",
  unit: "",
  context: "",
  question: "",
  surprise_factor: "2",
  content_rating: "standard",
  source_urls: "",
};

function FactEditor({ fact, onDone }: { fact: Fact; onDone: () => void }) {
  const save = useServerFn(saveFact);
  const status = useServerFn(changeFactStatus);
  const queryClient = useQueryClient();
  const rawSurprise = fact.surprise_factor;
  const normalizedSurprise =
    rawSurprise !== null && rawSurprise !== undefined
      ? rawSurprise > 3
        ? rawSurprise >= 8 ? 3 : rawSurprise >= 5 ? 2 : rawSurprise >= 3 ? 1 : 0
        : Math.min(3, Math.max(0, Math.round(rawSurprise)))
      : 2;

  const [form, setForm] = useState({
    subject: fact.subject,
    angle: fact.angle ?? "",
    true_number: fact.true_number === null ? "" : String(fact.true_number),
    unit: fact.unit ?? "",
    question: fact.question ?? "",
    context: fact.context ?? "",
    surprise_factor: String(normalizedSurprise),
    content_rating: fact.content_rating || "standard",
    source_urls: (fact.source_urls || []).join("\n"),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["facts"] });

  const saveMutation = useMutation({
    mutationFn: () =>
      save({
        data: {
          id: fact.id,
          subject: form.subject,
          angle: form.angle,
          true_number: Number(form.true_number),
          unit: form.unit,
          claim_template: form.question ? `${form.question}: {n}` : `${form.subject}: {n}`,
          context: form.context,
          question: form.question,
          surprise_factor: Number(form.surprise_factor),
          content_rating: form.content_rating as "standard" | "after_dark",
          source_urls: form.source_urls.split("\n").map((v) => v.trim()).filter(Boolean),
        },
      }),
    onSuccess: async () => {
      await invalidate();
      onDone();
    },
  });

  const statusMutation = useMutation({
    mutationFn: (next: "active" | "disputed" | "retired") =>
      status({
        data: {
          id: fact.id,
          status: next,
          reason: next === "retired" ? "Retired from admin portal" : undefined,
        },
      }),
    onSuccess: invalidate,
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!window.confirm("Save changes to this fact?")) return;
    saveMutation.mutate();
  }

  return (
    <Card>
      <form onSubmit={submit} style={{ display: "grid", gap: "var(--ds-arena-space-4)" }}>
        <div className="admin-page-head">
          <CardTitle>Edit fact</CardTitle>
          <Badge tone={statusTone(fact.status)}>{fact.status}</Badge>
        </div>
        <p style={{ fontFamily: "var(--ds-arena-font-mono)", fontSize: 12, color: "var(--ds-arena-color-text-muted)" }}>
          {fact.id}
        </p>

        <div className="admin-grid">
          <label className="admin-field">
            <span>Subject</span>
            <input
              className="admin-input"
              value={form.subject}
              onChange={(e) => setForm({ ...form, subject: e.target.value })}
            />
          </label>
          <label className="admin-field">
            <span>
              Angle <InfoTip text="The specific metric, dimension, or record being measured (e.g. 'Top Speed', 'Career Points', 'MVP Awards won'). Uniquely identifies the fact for this subject." />
            </span>
            <input
              className="admin-input"
              value={form.angle}
              onChange={(e) => setForm({ ...form, angle: e.target.value })}
            />
          </label>
          <label className="admin-field">
            <span>True number</span>
            <input
              className="admin-input"
              type="number"
              step="any"
              value={form.true_number}
              onChange={(e) => setForm({ ...form, true_number: e.target.value })}
            />
          </label>
          <label className="admin-field">
            <span>Unit</span>
            <input
              className="admin-input"
              value={form.unit}
              onChange={(e) => setForm({ ...form, unit: e.target.value })}
            />
          </label>
          <label className="admin-field">
            <span>
              Surprise factor <InfoTip text="Scale of 0–3 gauging how shocking the number is (0: Obvious/common knowledge, 1: Mildly surprising, 2: Very surprising, 3: Mind-blowing intuition trap)." />
            </span>
            <select
              className="admin-select"
              value={form.surprise_factor}
              onChange={(e) => setForm({ ...form, surprise_factor: e.target.value })}
            >
              <option value="0">0 · Obvious (Common knowledge)</option>
              <option value="1">1 · Mildly surprising</option>
              <option value="2">2 · Very surprising</option>
              <option value="3">3 · Mind-blowing (Intuition trap)</option>
            </select>
          </label>
          <label className="admin-field">
            <span>Content rating</span>
            <select
              className="admin-select"
              value={form.content_rating}
              onChange={(e) => setForm({ ...form, content_rating: e.target.value })}
            >
              <option value="standard">standard</option>
              <option value="after_dark">after_dark</option>
            </select>
          </label>
        </div>

        <label className="admin-field">
          <span>
            Question / Prompt{" "}
            <InfoTip text="The numberless question or phrase shown on the game card (e.g. 'How many neck vertebrae does a giraffe have?' or 'Career touchdowns')." />
          </span>
          <input
            className="admin-input"
            value={form.question}
            onChange={(e) => setForm({ ...form, question: e.target.value })}
          />
        </label>
        <label className="admin-field">
          <span>
            Reveal explanation (Context){" "}
            <InfoTip text="The engaging 1-2 sentence explanation revealed to players after they guess (e.g. 'Giraffes have 7 cervical vertebrae, the same as humans.')." />
          </span>
          <textarea
            className="admin-textarea"
            value={form.context}
            onChange={(e) => setForm({ ...form, context: e.target.value })}
          />
        </label>
        <label className="admin-field">
          <span>Source URLs (one per line)</span>
          <textarea
            className="admin-textarea"
            value={form.source_urls}
            onChange={(e) => setForm({ ...form, source_urls: e.target.value })}
          />
        </label>

        <dl className="admin-kv">
          <dt>Previous number</dt>
          <dd>{fact.previous_true_number ?? "—"}</dd>
          <dt>Verified</dt>
          <dd>
            {fact.verified_at ?? "—"} {fact.verifier_model ? `· ${fact.verifier_model}` : ""}
          </dd>
          <dt>Served</dt>
          <dd>
            {fact.served_count} {fact.last_served_at ? `· last ${fact.last_served_at}` : ""}
          </dd>
          <dt>Retired reason</dt>
          <dd>{fact.retired_reason ?? "—"}</dd>
        </dl>

        <ErrorNote error={saveMutation.error ?? statusMutation.error} />
        <div className="admin-row-actions">
          <Button type="submit" disabled={saveMutation.isPending}>
            {saveMutation.isPending ? "Saving…" : "Save changes"}
          </Button>
          <Button
            type="button"
            variant="daily"
            onClick={() => statusMutation.mutate("active")}
          >
            Verify &amp; approve
          </Button>
          <Button
            type="button"
            variant="skip"
            onClick={() => statusMutation.mutate("disputed")}
          >
            Mark disputed
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={() => {
              if (window.confirm("Retire this fact? It stops being served.")) {
                statusMutation.mutate("retired");
              }
            }}
          >
            Retire
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Close
          </Button>
        </div>
      </form>
    </Card>
  );
}

function NewFactForm({ onDone }: { onDone: () => void }) {
  const create = useServerFn(addFact);
  const queryClient = useQueryClient();
  const [form, setForm] = useState(EMPTY_DRAFT);

  const mutation = useMutation({
    mutationFn: () =>
      create({
        data: {
          subject: form.subject,
          angle: form.angle,
          true_number: Number(form.true_number),
          unit: form.unit,
          claim_template: form.question ? `${form.question}: {n}` : `${form.subject}: {n}`,
          context: form.context,
          question: form.question,
          surprise_factor: Number(form.surprise_factor),
          content_rating: form.content_rating as "standard" | "after_dark",
          source_urls: form.source_urls.split("\n").map((v) => v.trim()).filter(Boolean),
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["facts"] });
      setForm(EMPTY_DRAFT);
      onDone();
    },
  });

  return (
    <Card>
      <form
        style={{ display: "grid", gap: "var(--ds-arena-space-4)" }}
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <CardTitle>New fact</CardTitle>
        <div className="admin-grid">
          <label className="admin-field">
            <span>Subject</span>
            <input
              className="admin-input"
              required
              value={form.subject}
              onChange={(e) => setForm({ ...form, subject: e.target.value })}
            />
          </label>
          <label className="admin-field">
            <span>
              Angle <InfoTip text="The specific metric, dimension, or record being measured (e.g. 'Top Speed', 'Career Points', 'MVP Awards won'). Uniquely identifies the fact for this subject." />
            </span>
            <input
              className="admin-input"
              required
              value={form.angle}
              onChange={(e) => setForm({ ...form, angle: e.target.value })}
            />
          </label>
          <label className="admin-field">
            <span>True number</span>
            <input
              className="admin-input"
              type="number"
              step="any"
              required
              value={form.true_number}
              onChange={(e) => setForm({ ...form, true_number: e.target.value })}
            />
          </label>
          <label className="admin-field">
            <span>Unit</span>
            <input
              className="admin-input"
              value={form.unit}
              onChange={(e) => setForm({ ...form, unit: e.target.value })}
            />
          </label>
          <label className="admin-field">
            <span>
              Surprise factor <InfoTip text="Scale of 0–3 gauging how shocking the number is (0: Obvious/common knowledge, 1: Mildly surprising, 2: Very surprising, 3: Mind-blowing intuition trap)." />
            </span>
            <select
              className="admin-select"
              value={form.surprise_factor}
              onChange={(e) => setForm({ ...form, surprise_factor: e.target.value })}
            >
              <option value="0">0 · Obvious (Common knowledge)</option>
              <option value="1">1 · Mildly surprising</option>
              <option value="2">2 · Very surprising</option>
              <option value="3">3 · Mind-blowing (Intuition trap)</option>
            </select>
          </label>
          <label className="admin-field">
            <span>Content rating</span>
            <select
              className="admin-select"
              value={form.content_rating}
              onChange={(e) => setForm({ ...form, content_rating: e.target.value })}
            >
              <option value="standard">standard</option>
              <option value="after_dark">after_dark</option>
            </select>
          </label>
        </div>
        <label className="admin-field">
          <span>
            Question / Prompt{" "}
            <InfoTip text="The numberless question or phrase shown on the game card (e.g. 'How many neck vertebrae does a giraffe have?' or 'Career touchdowns')." />
          </span>
          <input
            className="admin-input"
            required
            value={form.question}
            onChange={(e) => setForm({ ...form, question: e.target.value })}
          />
        </label>
        <label className="admin-field">
          <span>
            Reveal explanation (Context){" "}
            <InfoTip text="The engaging 1-2 sentence explanation revealed to players after they guess (e.g. 'Giraffes have 7 cervical vertebrae, the same as humans.')." />
          </span>
          <textarea
            className="admin-textarea"
            value={form.context}
            onChange={(e) => setForm({ ...form, context: e.target.value })}
          />
        </label>
        <label className="admin-field">
          <span>Source URLs (one per line)</span>
          <textarea
            className="admin-textarea"
            value={form.source_urls}
            onChange={(e) => setForm({ ...form, source_urls: e.target.value })}
          />
        </label>
        <ErrorNote error={mutation.error} />
        <div className="admin-row-actions">
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? "Creating…" : "Save to bank"}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function FactsPage() {
  const list = useServerFn(fetchFacts);
  const exportFn = useServerFn(exportFactsData);
  const [filters, setFilters] = useState({
    search: "",
    subject: "",
    angle: "",
    status: "active",
    contentRating: "",
    surpriseFactor: "",
  });
  const [sort, setSort] = useState<{
    field: "subject" | "angle" | "true_number" | "surprise_factor" | "served_count";
    order: "asc" | "desc";
  }>({
    field: "subject",
    order: "asc",
  });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [selected, setSelected] = useState<Fact | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);

  const query = useQuery({
    queryKey: ["facts", filters, sort, page, pageSize],
    queryFn: () =>
      list({
        data: {
          search: filters.search || undefined,
          subject: filters.subject || undefined,
          angle: filters.angle || undefined,
          status: filters.status || undefined,
          contentRating: filters.contentRating || undefined,
          surpriseFactor: filters.surpriseFactor !== "" ? Number(filters.surpriseFactor) : undefined,
          sortField: sort.field,
          sortOrder: sort.order,
          page,
          pageSize,
        },
      }),
    retry: false,
  });

  const toggleSort = (field: typeof sort.field) => {
    setPage(1);
    if (sort.field === field) {
      setSort({ field, order: sort.order === "asc" ? "desc" : "asc" });
    } else {
      setSort({ field, order: "asc" });
    }
  };

  const renderSortIcon = (field: typeof sort.field) => {
    if (sort.field !== field) return <span style={{ opacity: 0.35, marginLeft: 4, fontSize: 10 }}>↕</span>;
    return (
      <span style={{ color: "var(--ds-arena-color-lime)", marginLeft: 4, fontSize: 11 }}>
        {sort.order === "asc" ? "▲" : "▼"}
      </span>
    );
  };

  const hasActiveFilters = Boolean(
    filters.search ||
      filters.subject ||
      filters.angle ||
      filters.status !== "active" ||
      filters.contentRating ||
      filters.surpriseFactor !== "",
  );

  const resetFilters = () => {
    setPage(1);
    setFilters({
      search: "",
      subject: "",
      angle: "",
      status: "active",
      contentRating: "",
      surpriseFactor: "",
    });
  };

  const handleExportCsv = async () => {
    try {
      setExporting(true);
      const facts = await exportFn({
        data: {
          search: filters.search || undefined,
          subject: filters.subject || undefined,
          angle: filters.angle || undefined,
          status: filters.status || undefined,
          contentRating: filters.contentRating || undefined,
          surpriseFactor: filters.surpriseFactor !== "" ? Number(filters.surpriseFactor) : undefined,
          sortField: sort.field,
          sortOrder: sort.order,
        },
      });
      const headers = [
        "id",
        "subject",
        "angle",
        "true_number",
        "unit",
        "question",
        "context",
        "surprise_factor",
        "content_rating",
        "status",
        "source_urls",
      ];
      const rows = facts.map((f) => [
        escapeCsv(f.id),
        escapeCsv(f.subject),
        escapeCsv(f.angle),
        escapeCsv(f.true_number),
        escapeCsv(f.unit),
        escapeCsv(f.question || f.claim_template),
        escapeCsv(f.context),
        escapeCsv(f.surprise_factor),
        escapeCsv(f.content_rating),
        escapeCsv(f.status),
        escapeCsv((f.source_urls || []).join(" ; ")),
      ]);
      const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", `fact_bank_export_${new Date().toISOString().slice(0, 10)}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  const totalPages = useMemo(
    () => (query.data ? Math.max(1, Math.ceil(query.data.total / query.data.pageSize)) : 1),
    [query.data],
  );

  return (
    <>
      <PageHead
        title="Fact bank"
        description="The curated trivia master list in Cloud Firestore."
        actions={
          <div style={{ display: "flex", gap: "8px" }}>
            <Button
              variant="ghost"
              disabled={exporting}
              onClick={() => void handleExportCsv()}
            >
              {exporting ? "Exporting…" : "Export CSV"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setImporting((v) => !v);
                setCreating(false);
                setSelected(null);
              }}
            >
              {importing ? "Close Import" : "Import CSV"}
            </Button>
            <Button
              onClick={() => {
                setCreating((value) => !value);
                setImporting(false);
                setSelected(null);
              }}
            >
              {creating ? "Close" : "New fact"}
            </Button>
          </div>
        }
      />

      <div className="admin-toolbar">
        <label className="admin-field" style={{ flex: "1 1 260px" }}>
          <span>Search all text (subject, angle, question, context)</span>
          <input
            className="admin-input"
            placeholder="Search keywords…"
            value={filters.search}
            onChange={(e) => {
              setPage(1);
              setFilters({ ...filters, search: e.target.value });
            }}
          />
        </label>
        <label className="admin-field">
          <span>Per page</span>
          <select
            className="admin-select"
            value={pageSize}
            onChange={(e) => {
              setPage(1);
              setPageSize(Number(e.target.value));
            }}
          >
            <option value="25">25</option>
            <option value="50">50</option>
            <option value="100">100</option>
            <option value="250">250</option>
            <option value="500">500</option>
            <option value="1000">All (1,000)</option>
          </select>
        </label>
        {hasActiveFilters ? (
          <div style={{ alignSelf: "flex-end", paddingBottom: "6px" }}>
            <Button size="sm" variant="ghost" onClick={resetFilters}>
              Reset filters
            </Button>
          </div>
        ) : null}
      </div>

      <ErrorNote error={query.error} />
      {importing ? <ImportCsvModal onDone={() => setImporting(false)} /> : null}
      {creating ? <NewFactForm onDone={() => setCreating(false)} /> : null}

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th className="admin-th-sortable" onClick={() => toggleSort("subject")}>
                Subject {renderSortIcon("subject")}
              </th>
              <th className="admin-th-sortable" onClick={() => toggleSort("angle")}>
                Angle {renderSortIcon("angle")}{" "}
                <InfoTip position="bottom" text="The specific metric, dimension, or record being measured." />
              </th>
              <th className="admin-th-sortable" onClick={() => toggleSort("true_number")}>
                Value {renderSortIcon("true_number")}
              </th>
              <th className="admin-th-sortable" onClick={() => toggleSort("surprise_factor")}>
                Surprise {renderSortIcon("surprise_factor")}{" "}
                <InfoTip position="bottom" text="Scale of 0 (obvious) to 3 (mind-blowing counterintuitive)." />
              </th>
              <th>Rating</th>
              <th>Status</th>
              <th className="admin-th-sortable" onClick={() => toggleSort("served_count")}>
                Served {renderSortIcon("served_count")}
              </th>
              <th style={{ width: 80, textAlign: "right" }} />
            </tr>
            <tr className="admin-table-header-filters">
              <th>
                <input
                  className="admin-header-input"
                  placeholder="Filter subject…"
                  value={filters.subject}
                  onChange={(e) => {
                    setPage(1);
                    setFilters({ ...filters, subject: e.target.value });
                  }}
                />
              </th>
              <th>
                <input
                  className="admin-header-input"
                  placeholder="Filter angle…"
                  value={filters.angle}
                  onChange={(e) => {
                    setPage(1);
                    setFilters({ ...filters, angle: e.target.value });
                  }}
                />
              </th>
              <th />
              <th>
                <select
                  className="admin-header-select"
                  value={filters.surpriseFactor}
                  onChange={(e) => {
                    setPage(1);
                    setFilters({ ...filters, surpriseFactor: e.target.value });
                  }}
                >
                  <option value="">All</option>
                  <option value="0">0 · Obvious</option>
                  <option value="1">1 · Mild</option>
                  <option value="2">2 · Very</option>
                  <option value="3">3 · Mind-blowing</option>
                </select>
              </th>
              <th>
                <select
                  className="admin-header-select"
                  value={filters.contentRating}
                  onChange={(e) => {
                    setPage(1);
                    setFilters({ ...filters, contentRating: e.target.value });
                  }}
                >
                  <option value="">All</option>
                  <option value="standard">standard</option>
                  <option value="after_dark">after_dark</option>
                </select>
              </th>
              <th>
                <select
                  className="admin-header-select"
                  value={filters.status}
                  onChange={(e) => {
                    setPage(1);
                    setFilters({ ...filters, status: e.target.value });
                  }}
                >
                  <option value="">All</option>
                  <option value="active">active</option>
                  <option value="disputed">disputed</option>
                  <option value="retired">retired</option>
                </select>
              </th>
              <th />
              <th>
                {hasActiveFilters ? (
                  <button
                    type="button"
                    className="admin-clear-filter-btn"
                    onClick={resetFilters}
                    title="Reset all filters"
                  >
                    Reset
                  </button>
                ) : null}
              </th>
            </tr>
          </thead>
          <tbody>
            {query.data?.facts.map((fact) => {
              const isEditing = selected?.id === fact.id;
              return (
                <Fragment key={fact.id}>
                  <tr
                    style={
                      isEditing
                        ? {
                            backgroundColor: "var(--ds-arena-color-surface-hover)",
                          }
                        : undefined
                    }
                  >
                    <td>
                      <strong>{fact.subject}</strong>
                    </td>
                    <td>{fact.angle}</td>
                    <td>
                      {fact.true_number ?? "—"} {fact.unit}
                      {fact.previous_true_number !== null ? (
                        <div style={{ fontSize: 12, color: "var(--ds-arena-color-amber)" }}>
                          was {fact.previous_true_number}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {fact.surprise_factor !== null && fact.surprise_factor !== undefined ? (
                        <span
                          title={
                            fact.surprise_factor >= 3
                              ? "3 · Mind-blowing (Intuition trap)"
                              : fact.surprise_factor === 2
                                ? "2 · Very surprising"
                                : fact.surprise_factor === 1
                                  ? "1 · Mildly surprising"
                                  : "0 · Obvious"
                          }
                        >
                          {fact.surprise_factor}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{fact.content_rating}</td>
                    <td>
                      <Badge tone={statusTone(fact.status)}>{fact.status}</Badge>
                    </td>
                    <td>{fact.served_count}</td>
                    <td>
                      <Button
                        size="sm"
                        variant={isEditing ? "primary" : "ghost"}
                        onClick={() => {
                          setCreating(false);
                          setImporting(false);
                          setSelected(isEditing ? null : fact);
                        }}
                      >
                        {isEditing ? "Close" : "Edit"}
                      </Button>
                    </td>
                  </tr>
                  {isEditing ? (
                    <tr className="admin-inline-editor-row" key={`${fact.id}-editor`}>
                      <td
                        colSpan={8}
                        style={{
                          padding: "16px 20px",
                          background: "var(--ds-arena-color-surface-sunken, rgba(0, 0, 0, 0.25))",
                          borderLeft: "3px solid var(--ds-arena-color-lime, #84cc16)",
                          borderBottom: "1px solid var(--ds-arena-color-border-subtle)",
                        }}
                      >
                        <FactEditor fact={fact} onDone={() => setSelected(null)} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {query.isLoading ? <p className="admin-empty">Loading facts…</p> : null}
        {query.data && query.data.facts.length === 0 ? (
          <p className="admin-empty">No facts match these filters.</p>
        ) : null}
      </div>

      <div className="admin-toolbar">
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          Previous
        </Button>
        <CardLabel>
          Page {page} of {totalPages} · {query.data?.total ?? 0} matches
        </CardLabel>
        <Button
          size="sm"
          variant="ghost"
          disabled={page >= totalPages}
          onClick={() => setPage(page + 1)}
        >
          Next
        </Button>
      </div>
      {query.data?.windowed ? (
        <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 13 }}>
          Showing the first 1,000 matching documents — narrow the filters for full coverage.
        </p>
      ) : null}
    </>
  );
}

function ImportCsvModal({ onDone }: { onDone: () => void }) {
  const bulkImport = useServerFn(bulkImportFacts);
  const queryClient = useQueryClient();
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState("");
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null);

  const handleDownloadTemplate = () => {
    const templateContent = [
      "subject,angle,true_number,unit,question,context,surprise_factor,content_rating,source_urls",
      'Giraffe,Neck vertebrae count,7,vertebrae,"How many neck vertebrae does a giraffe have?","Mammals usually have 7 cervical vertebrae.",3,standard,https://en.wikipedia.org/wiki/Giraffe',
      'Mount Everest,Elevation in feet,29032,feet,"What is the elevation of Mount Everest in feet?","Official survey elevation.",1,standard,https://en.wikipedia.org/wiki/Mount_Everest',
    ].join("\n");
    const blob = new Blob([templateContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", "fact_bank_template.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = String(evt.target?.result ?? "");
      setCsvText(text);
    };
    reader.readAsText(file);
  };

  const parsedRows = useMemo(() => {
    if (!csvText.trim()) return [];
    const grid = parseCsv(csvText);
    if (grid.length < 2) return [];

    const headers = grid[0].map((h) => h.toLowerCase().trim().replace(/[^a-z0-9_]/g, "_"));
    const colIdx = {
      subject: headers.findIndex((h) => h.includes("subject")),
      angle: headers.findIndex((h) => h.includes("angle")),
      true_number: headers.findIndex((h) => h.includes("number") || h.includes("value") || h.includes("true")),
      unit: headers.findIndex((h) => h.includes("unit")),
      claim_template: headers.findIndex((h) => h.includes("template") || h.includes("claim")),
      context: headers.findIndex((h) => h.includes("context")),
      question: headers.findIndex((h) => h.includes("question") || h.includes("prompt")),
      surprise_factor: headers.findIndex((h) => h.includes("surprise")),
      content_rating: headers.findIndex((h) => h.includes("rating")),
      source_urls: headers.findIndex((h) => h.includes("source") || h.includes("url")),
    };

    return grid.slice(1).map((row, idx) => {
      const getVal = (col: number) => (col >= 0 && row[col] !== undefined ? row[col].trim() : "");
      const subject = getVal(colIdx.subject);
      const angle = getVal(colIdx.angle);
      const rawNum = getVal(colIdx.true_number);
      const true_number = Number(rawNum);
      const unit = getVal(colIdx.unit);
      const rawClaim = getVal(colIdx.claim_template);
      const rawQuestion = getVal(colIdx.question);
      const rawContext = getVal(colIdx.context);

      const question = rawQuestion || (rawClaim ? rawClaim.replace(/\{n\}/g, "").trim() : `${subject} - ${angle}`);
      const context = rawContext || rawClaim || question;
      const claim_template = rawClaim || (question ? `${question}: {n}` : `${subject}: {n}`);

      const rawSurprise = getVal(colIdx.surprise_factor);
      let surprise_factor = 2;
      if (rawSurprise) {
        const numSurprise = Number(rawSurprise);
        if (!isNaN(numSurprise)) {
          if (numSurprise > 3) {
            surprise_factor = numSurprise >= 8 ? 3 : numSurprise >= 5 ? 2 : numSurprise >= 3 ? 1 : 0;
          } else {
            surprise_factor = Math.min(3, Math.max(0, Math.round(numSurprise)));
          }
        }
      }
      const ratingRaw = getVal(colIdx.content_rating).toLowerCase();
      const content_rating: "standard" | "after_dark" =
        ratingRaw === "after_dark" ? "after_dark" : "standard";
      const rawUrls = getVal(colIdx.source_urls);
      const source_urls = rawUrls
        ? rawUrls.split(/[;\n,]+/).map((u) => u.trim()).filter((u) => u.startsWith("http"))
        : [];

      const issues: string[] = [];
      if (!subject) issues.push("Missing subject");
      if (!angle) issues.push("Missing angle");
      if (isNaN(true_number) || rawNum === "") issues.push("Invalid true_number");

      return {
        rowNumber: idx + 2,
        isValid: issues.length === 0,
        issues,
        fact: {
          subject,
          angle,
          true_number: isNaN(true_number) ? 0 : true_number,
          unit,
          claim_template,
          context,
          question,
          surprise_factor,
          content_rating,
          source_urls,
        },
      };
    });
  }, [csvText]);

  const validFacts = useMemo(() => parsedRows.filter((r) => r.isValid).map((r) => r.fact), [parsedRows]);

  const mutation = useMutation({
    mutationFn: () => bulkImport({ data: { facts: validFacts } }),
    onSuccess: (res) => {
      setImportResult(res);
      queryClient.invalidateQueries({ queryKey: ["facts"] });
    },
  });

  return (
    <Card>
      <div className="admin-page-head">
        <div>
          <CardTitle>Import facts from CSV</CardTitle>
          <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 13, margin: "4px 0 0" }}>
            Upload or paste a CSV with trivia facts. Columns: <code>subject</code>, <code>angle</code>, <code>true_number</code>, <code>unit</code>, <code>question</code>, <code>context</code>, <code>surprise_factor</code> (0–3), <code>content_rating</code>, <code>source_urls</code>.
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <Button size="sm" variant="ghost" onClick={handleDownloadTemplate}>
            Download Template (.csv)
          </Button>
          <Button size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </div>

      {importResult ? (
        <div style={{ padding: "16px 0" }}>
          <Badge tone="lime">Import Complete</Badge>
          <p style={{ color: "var(--ds-arena-color-text)", margin: "8px 0" }}>
            Successfully imported <strong>{importResult.imported}</strong> facts (<strong>{importResult.skipped}</strong> skipped as duplicates).
          </p>
          {importResult.errors.length > 0 ? (
            <div style={{ color: "var(--ds-arena-color-red)", fontSize: 13, marginTop: "8px" }}>
              <p><strong>Errors ({importResult.errors.length}):</strong></p>
              <ul>
                {importResult.errors.map((e, idx) => (
                  <li key={idx}>{e}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <Button size="sm" onClick={onDone} style={{ marginTop: "12px" }}>
            Done
          </Button>
        </div>
      ) : (
        <>
          <div className="admin-toolbar" style={{ marginTop: "12px" }}>
            <label className="admin-field" style={{ flex: "1 1 280px" }}>
              <span>Upload CSV file</span>
              <input className="admin-input" type="file" accept=".csv,text/csv" onChange={handleFileUpload} />
            </label>
            {fileName ? (
              <div style={{ alignSelf: "flex-end", paddingBottom: "10px", color: "var(--ds-arena-color-lime)", fontSize: 13 }}>
                Loaded: {fileName}
              </div>
            ) : null}
          </div>

          <label className="admin-field" style={{ marginTop: "12px" }}>
            <span>Or paste raw CSV text</span>
            <textarea
              className="admin-textarea"
              style={{ minHeight: "100px", fontFamily: "var(--ds-arena-font-mono)", fontSize: "12px" }}
              placeholder={"subject,angle,true_number,unit,question,context,surprise_factor,content_rating,source_urls\nGiraffe,Neck vertebrae count,7,vertebrae,How many neck vertebrae does a giraffe have?,Mammals have 7 vertebrae.,3,standard,"}
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
            />
          </label>

          {parsedRows.length > 0 ? (
            <div style={{ marginTop: "16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                <span style={{ fontSize: 13, color: "var(--ds-arena-color-text-muted)" }}>
                  Parsed <strong>{parsedRows.length}</strong> rows — <strong style={{ color: "var(--ds-arena-color-lime)" }}>{validFacts.length} valid</strong>
                  {parsedRows.length - validFacts.length > 0 ? (
                    <>
                      , <strong style={{ color: "var(--ds-arena-color-red)" }}>{parsedRows.length - validFacts.length} invalid</strong>
                    </>
                  ) : null}
                </span>
                <Button
                  size="sm"
                  disabled={validFacts.length === 0 || mutation.isPending}
                  onClick={() => mutation.mutate()}
                >
                  {mutation.isPending ? "Importing…" : `Import ${validFacts.length} Facts`}
                </Button>
              </div>

              <div className="admin-table-wrap" style={{ maxHeight: "240px", overflowY: "auto" }}>
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Subject</th>
                      <th>Angle</th>
                      <th>Value</th>
                      <th>Claim template</th>
                      <th>Issues</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsedRows.slice(0, 50).map((row, idx) => (
                      <tr key={idx}>
                        <td>
                          {row.isValid ? (
                            <Badge tone="lime">Ready</Badge>
                          ) : (
                            <Badge tone="red">Error</Badge>
                          )}
                        </td>
                        <td><strong>{row.fact.subject || "—"}</strong></td>
                        <td>{row.fact.angle || "—"}</td>
                        <td>{row.fact.true_number} {row.fact.unit}</td>
                        <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {row.fact.claim_template}
                        </td>
                        <td style={{ color: row.isValid ? "var(--ds-arena-color-text-muted)" : "var(--ds-arena-color-red)", fontSize: 12 }}>
                          {row.issues.length > 0 ? row.issues.join(", ") : "OK"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <ErrorNote error={mutation.error} />
        </>
      )}
    </Card>
  );
}
