import { createFileRoute } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Button, Card } from "@/index";
import { PageHead } from "@/admin/AdminShell";
import { summarizeInsights } from "@/lib/admin/insights.functions";

export const Route = createFileRoute("/admin/insights")({
  head: () => ({
    meta: [
      { title: "AI Placement Insights — More or Less Admin" },
      { name: "description", content: "AI summary of click trends by placement for the Snaptapp site." },
      { property: "og:title", content: "AI Placement Insights — More or Less Admin" },
      { property: "og:description", content: "AI summary of click trends by placement." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: InsightsPage,
});

type Row = { event: "cta_click" | "outbound_click"; location: string; count: string };

const DEFAULT_ROWS: Row[] = [
  { event: "outbound_click", location: "header", count: "" },
  { event: "outbound_click", location: "hero", count: "" },
  { event: "outbound_click", location: "product_card", count: "" },
  { event: "outbound_click", location: "footer", count: "" },
  { event: "cta_click", location: "hero", count: "" },
  { event: "cta_click", location: "products_section", count: "" },
  { event: "cta_click", location: "footer_cta", count: "" },
];

function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function InsightsPage() {
  const summarize = useServerFn(summarizeInsights);
  const [startDate, setStart] = useState(() => daysAgo(28));
  const [endDate, setEnd] = useState(() => daysAgo(0));
  const [rows, setRows] = useState<Row[]>(DEFAULT_ROWS);
  const [notes, setNotes] = useState("");
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function update(i: number, patch: Partial<Row>) {
    setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const filled = rows
      .filter((r) => r.location.trim() && r.count !== "")
      .map((r) => ({ event: r.event, location: r.location.trim(), count: Number(r.count) }));
    if (!filled.length) return setError("Enter at least one click count.");
    if (startDate > endDate) return setError("Start date must be before end date.");
    setBusy(true);
    setError(null);
    setSummary(null);
    try {
      const res = await summarize({ data: { startDate, endDate, rows: filled, notes: notes || undefined } });
      setSummary(res.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHead
        title="AI Insights"
        description="Paste click counts from Google Analytics for a date range; AI summarizes trends and suggests placements to improve."
      />
      <Card>
        <form className="admin-stack" onSubmit={submit}>
          <div className="admin-responsive-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "var(--ds-arena-space-3)" }}>
            <label className="admin-field">
              <span>Start date</span>
              <input className="admin-input" type="date" value={startDate} onChange={(e) => setStart(e.target.value)} required />
            </label>
            <label className="admin-field">
              <span>End date</span>
              <input className="admin-input" type="date" value={endDate} onChange={(e) => setEnd(e.target.value)} required />
            </label>
          </div>

          <div className="admin-table-wrap">
            <table className="admin-table admin-card-table admin-card-table--insights">
              <thead>
                <tr><th>Event</th><th>Placement</th><th>Clicks</th><th><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td data-label="Event">
                      <select aria-label={`Event for row ${i + 1}`} className="admin-select" value={r.event} onChange={(e) => update(i, { event: e.target.value as Row["event"] })}>
                        <option value="outbound_click">Game link</option>
                        <option value="cta_click">Button (CTA)</option>
                      </select>
                    </td>
                    <td data-label="Placement">
                      <input aria-label={`Placement for row ${i + 1}`} className="admin-input" value={r.location} onChange={(e) => update(i, { location: e.target.value })} />
                    </td>
                    <td data-label="Clicks">
                      <input aria-label={`Clicks for row ${i + 1}`} className="admin-input" type="number" min={0} value={r.count} onChange={(e) => update(i, { count: e.target.value })} />
                    </td>
                    <td>
                      <Button variant="danger" size="sm" type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <Button variant="ghost" size="sm" type="button" onClick={() => setRows([...rows, { event: "cta_click", location: "", count: "" }])}>
              Add row
            </Button>
          </div>

          <label className="admin-field">
            <span>Notes (optional)</span>
            <textarea className="admin-input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. homepage redesign shipped mid-range" />
          </label>

          <div>
            <Button type="submit" disabled={busy}>{busy ? "Analysing…" : "Summarize trends"}</Button>
          </div>
        </form>
      </Card>

      {error && <p role="alert" className="admin-error">{error}</p>}
      {summary && (
        <Card>
          <h2>Summary</h2>
          <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{summary}</div>
        </Card>
      )}
    </>
  );
}
