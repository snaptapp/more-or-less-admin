import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Badge, Button, Card, CardLabel, CardTitle } from "@/index";
import { ErrorNote, PageHead, statusTone } from "@/admin/AdminShell";
import {
  fetchCrawlQueue,
  fetchSubjects,
  queueCrawl,
  saveSubject,
  updateCrawlPriority,
} from "@/lib/admin/ops.functions";

export const Route = createFileRoute("/admin/taxonomy")({
  head: () => ({
    meta: [
      { title: "Taxonomy & Crawl — More or Less Admin" },
      { name: "description", content: "Manage topic taxonomy, aliases and the crawl queue." },
    ],
  }),
  component: TaxonomyPage,
});

const CATEGORIES = [
  "Animals & Nature",
  "Science & Space",
  "Sports",
  "Music",
  "Movies & TV",
  "Pop Culture & Records",
  "History & World",
  "Food & Drink",
  "Technology",
  "Money & Business",
  "General",
];

type Subject = Awaited<ReturnType<typeof fetchSubjects>>["subjects"][number];

function SubjectEditor({ subject, onDone }: { subject: Subject; onDone: () => void }) {
  const save = useServerFn(saveSubject);
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    category: subject.category,
    sub_category: subject.sub_category,
    aliases: subject.aliases.join(", "),
    crawl_notes: subject.crawl_notes,
  });

  const mutation = useMutation({
    mutationFn: () =>
      save({
        data: {
          id: subject.id,
          category: form.category,
          sub_category: form.sub_category,
          aliases: form.aliases.split(",").map((v) => v.trim()).filter(Boolean),
          crawl_notes: form.crawl_notes,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["subjects"] });
      onDone();
    },
  });

  return (
    <Card>
      <CardTitle>{subject.subject}</CardTitle>
      <div className="admin-grid" style={{ marginTop: "var(--ds-arena-space-3)" }}>
        <label className="admin-field">
          <span>Category</span>
          <select
            className="admin-select"
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
          >
            <option value="">—</option>
            {CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </label>
        <label className="admin-field">
          <span>Sub-category</span>
          <input
            className="admin-input"
            value={form.sub_category}
            onChange={(e) => setForm({ ...form, sub_category: e.target.value })}
          />
        </label>
      </div>
      <label className="admin-field" style={{ marginTop: "var(--ds-arena-space-3)" }}>
        <span>Aliases (comma separated)</span>
        <input
          className="admin-input"
          value={form.aliases}
          onChange={(e) => setForm({ ...form, aliases: e.target.value })}
        />
      </label>
      <label className="admin-field" style={{ marginTop: "var(--ds-arena-space-3)" }}>
        <span>Crawl notes</span>
        <textarea
          className="admin-textarea"
          value={form.crawl_notes}
          onChange={(e) => setForm({ ...form, crawl_notes: e.target.value })}
        />
      </label>
      <ErrorNote error={mutation.error} />
      <div className="admin-row-actions" style={{ marginTop: "var(--ds-arena-space-3)" }}>
        <Button disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          Save subject
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Close
        </Button>
      </div>
    </Card>
  );
}

function CrawlQueue() {
  const listQueue = useServerFn(fetchCrawlQueue);
  const enqueue = useServerFn(queueCrawl);
  const setPriority = useServerFn(updateCrawlPriority);
  const queryClient = useQueryClient();
  const [status, setStatus] = useState("");
  const [draft, setDraft] = useState({ subject: "", priority: "10", refresh: false });

  const query = useQuery({
    queryKey: ["crawl", status],
    queryFn: () => listQueue({ data: { status: status || undefined } }),
    retry: false,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["crawl"] });

  const enqueueMutation = useMutation({
    mutationFn: () =>
      enqueue({
        data: {
          subject: draft.subject,
          priority: Number(draft.priority),
          refresh: draft.refresh,
        },
      }),
    onSuccess: async () => {
      setDraft({ subject: "", priority: "10", refresh: false });
      await invalidate();
    },
  });

  const priorityMutation = useMutation({
    mutationFn: (input: { id: string; priority: number }) => setPriority({ data: input }),
    onSuccess: invalidate,
  });

  return (
    <Card>
      <CardTitle>Crawl queue</CardTitle>
      <div className="admin-toolbar" style={{ marginTop: "var(--ds-arena-space-3)" }}>
        <label className="admin-field" style={{ flex: "1 1 200px" }}>
          <span>Topic to enqueue</span>
          <input
            className="admin-input"
            value={draft.subject}
            onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
          />
        </label>
        <label className="admin-field">
          <span>Priority</span>
          <input
            className="admin-input"
            type="number"
            min={0}
            max={100}
            value={draft.priority}
            onChange={(e) => setDraft({ ...draft, priority: e.target.value })}
          />
        </label>
        <label className="admin-field">
          <span>Refresh existing</span>
          <input
            type="checkbox"
            checked={draft.refresh}
            style={{ width: 24, height: 24 }}
            onChange={(e) => setDraft({ ...draft, refresh: e.target.checked })}
          />
        </label>
        <Button
          disabled={!draft.subject || enqueueMutation.isPending}
          onClick={() => enqueueMutation.mutate()}
        >
          Enqueue topic
        </Button>
        <label className="admin-field">
          <span>Filter status</span>
          <select
            className="admin-select"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All</option>
            <option value="queued">queued</option>
            <option value="processing">processing</option>
            <option value="done">done</option>
          </select>
        </label>
      </div>
      <ErrorNote error={query.error ?? enqueueMutation.error ?? priorityMutation.error} />
      <div className="admin-table-wrap" style={{ marginTop: "var(--ds-arena-space-3)" }}>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Subject</th>
              <th>Status</th>
              <th>Priority</th>
              <th>Requested by</th>
              <th>Enqueued</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {query.data?.map((item) => (
              <tr key={item.id}>
                <td>
                  <strong>{item.subject}</strong>
                  {item.refresh ? " · refresh" : ""}
                </td>
                <td>
                  <Badge tone={statusTone(item.status)}>{item.status}</Badge>
                </td>
                <td>{item.priority}</td>
                <td>{item.requested_by}</td>
                <td>{item.enqueued_at ?? "—"}</td>
                <td>
                  <div className="admin-row-actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        priorityMutation.mutate({ id: item.id, priority: item.priority + 10 })
                      }
                    >
                      Bump
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        priorityMutation.mutate({
                          id: item.id,
                          priority: Math.max(0, item.priority - 10),
                        })
                      }
                    >
                      Lower
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {query.isLoading ? <p className="admin-empty">Loading queue…</p> : null}
        {query.data?.length === 0 ? <p className="admin-empty">Queue is empty.</p> : null}
      </div>
    </Card>
  );
}

function TaxonomyPage() {
  const list = useServerFn(fetchSubjects);
  const [filters, setFilters] = useState({ search: "", category: "" });
  const [selected, setSelected] = useState<Subject | null>(null);

  const query = useQuery({
    queryKey: ["subjects", filters],
    queryFn: () =>
      list({
        data: {
          search: filters.search || undefined,
          category: filters.category || undefined,
        },
      }),
    retry: false,
  });

  return (
    <>
      <PageHead
        title="Taxonomy & crawl"
        description="Topic categories, aliases and Fact Foundry intake."
      />

      <div className="admin-grid">
        {query.data?.coverage.map((entry) => (
          <Card key={entry.category}>
            <CardLabel>{entry.category}</CardLabel>
            <p className="admin-stat">{entry.facts}</p>
            <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 13, margin: 0 }}>
              {entry.subjects} subjects
            </p>
          </Card>
        ))}
      </div>

      <div className="admin-toolbar">
        <label className="admin-field" style={{ flex: "1 1 240px" }}>
          <span>Search subject or alias</span>
          <input
            className="admin-input"
            value={filters.search}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })}
          />
        </label>
        <label className="admin-field">
          <span>Category</span>
          <select
            className="admin-select"
            value={filters.category}
            onChange={(e) => setFilters({ ...filters, category: e.target.value })}
          >
            <option value="">All</option>
            {CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </label>
      </div>

      <ErrorNote error={query.error} />
      {selected ? <SubjectEditor subject={selected} onDone={() => setSelected(null)} /> : null}

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Subject</th>
              <th>Category</th>
              <th>Sub-category</th>
              <th>Aliases</th>
              <th>Facts</th>
              <th>Last crawled</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {query.data?.subjects.map((subject) => (
              <tr key={subject.id}>
                <td>
                  <strong>{subject.subject}</strong>
                </td>
                <td>{subject.category || "—"}</td>
                <td>{subject.sub_category || "—"}</td>
                <td>{subject.aliases.join(", ") || "—"}</td>
                <td>{subject.fact_count}</td>
                <td>{subject.last_crawled_at ?? "—"}</td>
                <td>
                  <Button size="sm" variant="ghost" onClick={() => setSelected(subject)}>
                    Edit
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {query.isLoading ? <p className="admin-empty">Loading subjects…</p> : null}
      </div>

      <CrawlQueue />
    </>
  );
}
