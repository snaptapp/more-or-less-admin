import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState, type FormEvent } from "react";
import { Badge, Button, Card, CardLabel, CardTitle } from "@/index";
import { ErrorNote, PageHead, statusTone } from "@/admin/AdminShell";
import {
  addFact,
  changeFactStatus,
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

const EMPTY_DRAFT = {
  subject: "",
  angle: "",
  true_number: "",
  unit: "",
  claim_template: "",
  context: "",
  question: "",
  surprise_factor: "6",
  difficulty_hint: "medium",
  content_rating: "standard",
  source_urls: "",
};

function preview(template: string, value: string): string {
  if (!template) return "—";
  return template.replace("{n}", value || "{n}");
}

function FactEditor({ fact, onDone }: { fact: Fact; onDone: () => void }) {
  const save = useServerFn(saveFact);
  const status = useServerFn(changeFactStatus);
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    subject: fact.subject,
    angle: fact.angle,
    true_number: fact.true_number === null ? "" : String(fact.true_number),
    unit: fact.unit,
    claim_template: fact.claim_template,
    context: fact.context,
    question: fact.question,
    surprise_factor: String(fact.surprise_factor ?? 5),
    difficulty_hint: fact.difficulty_hint || "medium",
    content_rating: fact.content_rating || "standard",
    source_urls: fact.source_urls.join("\n"),
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
          claim_template: form.claim_template,
          context: form.context,
          question: form.question,
          surprise_factor: Number(form.surprise_factor),
          difficulty_hint: form.difficulty_hint as "casual" | "medium" | "hard",
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
            <span>Angle</span>
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
            <span>Surprise factor</span>
            <input
              className="admin-input"
              type="number"
              min={1}
              max={10}
              value={form.surprise_factor}
              onChange={(e) => setForm({ ...form, surprise_factor: e.target.value })}
            />
          </label>
          <label className="admin-field">
            <span>Difficulty</span>
            <select
              className="admin-select"
              value={form.difficulty_hint}
              onChange={(e) => setForm({ ...form, difficulty_hint: e.target.value })}
            >
              <option value="casual">casual</option>
              <option value="medium">medium</option>
              <option value="hard">hard</option>
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
          <span>Claim template</span>
          <input
            className="admin-input"
            value={form.claim_template}
            onChange={(e) => setForm({ ...form, claim_template: e.target.value })}
          />
        </label>
        <p style={{ color: "var(--ds-arena-color-lime)", fontSize: 14, margin: 0 }}>
          {preview(form.claim_template, form.true_number)}
        </p>

        <label className="admin-field">
          <span>Question</span>
          <input
            className="admin-input"
            value={form.question}
            onChange={(e) => setForm({ ...form, question: e.target.value })}
          />
        </label>
        <label className="admin-field">
          <span>Reveal context</span>
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
          claim_template: form.claim_template,
          context: form.context,
          question: form.question,
          surprise_factor: Number(form.surprise_factor),
          difficulty_hint: form.difficulty_hint as "casual" | "medium" | "hard",
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
            <span>Angle</span>
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
            <span>Surprise factor</span>
            <input
              className="admin-input"
              type="number"
              min={1}
              max={10}
              value={form.surprise_factor}
              onChange={(e) => setForm({ ...form, surprise_factor: e.target.value })}
            />
          </label>
          <label className="admin-field">
            <span>Difficulty</span>
            <select
              className="admin-select"
              value={form.difficulty_hint}
              onChange={(e) => setForm({ ...form, difficulty_hint: e.target.value })}
            >
              <option value="casual">casual</option>
              <option value="medium">medium</option>
              <option value="hard">hard</option>
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
          <span>Claim template (use {"{n}"})</span>
          <input
            className="admin-input"
            required
            value={form.claim_template}
            onChange={(e) => setForm({ ...form, claim_template: e.target.value })}
          />
        </label>
        <p style={{ color: "var(--ds-arena-color-lime)", fontSize: 14, margin: 0 }}>
          {preview(form.claim_template, form.true_number)}
        </p>
        <label className="admin-field">
          <span>Question</span>
          <input
            className="admin-input"
            required
            value={form.question}
            onChange={(e) => setForm({ ...form, question: e.target.value })}
          />
        </label>
        <label className="admin-field">
          <span>Reveal context</span>
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
            {mutation.isPending ? "Creating…" : "Create fact"}
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
  const [filters, setFilters] = useState({
    search: "",
    status: "active",
    contentRating: "",
    difficulty: "",
  });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Fact | null>(null);
  const [creating, setCreating] = useState(false);

  const query = useQuery({
    queryKey: ["facts", filters, page],
    queryFn: () =>
      list({
        data: {
          search: filters.search || undefined,
          status: filters.status || undefined,
          contentRating: filters.contentRating || undefined,
          difficulty: filters.difficulty || undefined,
          page,
          pageSize: 25,
        },
      }),
    retry: false,
  });

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
          <Button
            onClick={() => {
              setCreating((value) => !value);
              setSelected(null);
            }}
          >
            {creating ? "Close" : "New fact"}
          </Button>
        }
      />

      <div className="admin-toolbar">
        <label className="admin-field" style={{ flex: "1 1 260px" }}>
          <span>Search subject, angle or question</span>
          <input
            className="admin-input"
            value={filters.search}
            onChange={(e) => {
              setPage(1);
              setFilters({ ...filters, search: e.target.value });
            }}
          />
        </label>
        <label className="admin-field">
          <span>Status</span>
          <select
            className="admin-select"
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
        </label>
        <label className="admin-field">
          <span>Rating</span>
          <select
            className="admin-select"
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
        </label>
        <label className="admin-field">
          <span>Difficulty</span>
          <select
            className="admin-select"
            value={filters.difficulty}
            onChange={(e) => {
              setPage(1);
              setFilters({ ...filters, difficulty: e.target.value });
            }}
          >
            <option value="">All</option>
            <option value="casual">casual</option>
            <option value="medium">medium</option>
            <option value="hard">hard</option>
          </select>
        </label>
      </div>

      <ErrorNote error={query.error} />
      {creating ? <NewFactForm onDone={() => setCreating(false)} /> : null}
      {selected ? <FactEditor fact={selected} onDone={() => setSelected(null)} /> : null}

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Subject</th>
              <th>Angle</th>
              <th>Value</th>
              <th>Surprise</th>
              <th>Rating</th>
              <th>Status</th>
              <th>Served</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {query.data?.facts.map((fact) => (
              <tr key={fact.id}>
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
                <td>{fact.surprise_factor ?? "—"}</td>
                <td>{fact.content_rating}</td>
                <td>
                  <Badge tone={statusTone(fact.status)}>{fact.status}</Badge>
                </td>
                <td>{fact.served_count}</td>
                <td>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setCreating(false);
                      setSelected(fact);
                    }}
                  >
                    Edit
                  </Button>
                </td>
              </tr>
            ))}
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
          Showing the first 500 matching documents — narrow the filters for full coverage.
        </p>
      ) : null}
    </>
  );
}
