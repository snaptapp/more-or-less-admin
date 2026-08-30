import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Card, CardLabel, CardTitle } from "@/index";
import { ErrorNote, PageHead } from "@/admin/AdminShell";
import { fetchGameAnalytics } from "@/lib/admin/ops.functions";

export const Route = createFileRoute("/admin/analytics")({
  head: () => ({
    meta: [
      { title: "Game Analytics — More or Less Admin" },
      { name: "description", content: "Read-only breakdown of recent games by mode and category." },
    ],
  }),
  component: AnalyticsPage,
});

const RANGES = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
];

function since(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function Breakdown({
  title,
  rows,
  total,
}: {
  title: string;
  rows: { name: string; count: number }[];
  total: number;
}) {
  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      <div style={{ marginTop: "var(--ds-arena-space-3)" }}>
        {rows.length === 0 ? (
          <p style={{ color: "var(--ds-arena-color-text-muted)" }}>No games in this window.</p>
        ) : null}
        {rows.map((row) => (
          <div key={row.name} className="admin-bar-row">
            <span>{row.name}</span>
            <span
              style={{
                display: "block",
                height: 8,
                borderRadius: 999,
                background: "var(--ds-arena-color-surface)",
                overflow: "hidden",
              }}
            >
              <span
                style={{
                  display: "block",
                  height: "100%",
                  width: `${total ? (row.count / total) * 100 : 0}%`,
                  background: "var(--ds-arena-color-lime)",
                }}
              />
            </span>
            <span style={{ textAlign: "right" }}>{row.count}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function AnalyticsPage() {
  const load = useServerFn(fetchGameAnalytics);
  const [days, setDays] = useState(7);

  const query = useQuery({
    queryKey: ["analytics", days],
    queryFn: () => load({ data: { since: since(days) } }),
    retry: false,
  });

  const data = query.data;

  return (
    <>
      <PageHead
        title="Game analytics"
        description="Read-only sample of the games collection."
        actions={
          <label className="admin-field">
            <span>Window</span>
            <select
              className="admin-select"
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
            >
              {RANGES.map((range) => (
                <option key={range.days} value={range.days}>
                  {range.label}
                </option>
              ))}
            </select>
          </label>
        }
      />
      <ErrorNote error={query.error} />
      {query.isLoading ? <p className="admin-empty">Loading games…</p> : null}
      {data ? (
        <>
          <Card>
            <CardLabel>Games sampled</CardLabel>
            <p className="admin-stat">{data.total}</p>
            {data.windowed ? (
              <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 13, margin: 0 }}>
                Capped at 500 documents — shorten the window for exact counts.
              </p>
            ) : null}
          </Card>
          <div className="admin-two-col">
            <Breakdown title="By mode" rows={data.byMode} total={data.total} />
            <Breakdown title="By pace" rows={data.byPace} total={data.total} />
          </div>
          <div className="admin-two-col">
            <Breakdown title="By category" rows={data.byCategory} total={data.total} />
            <Breakdown title="By difficulty" rows={data.byDifficulty} total={data.total} />
          </div>
        </>
      ) : null}
    </>
  );
}
