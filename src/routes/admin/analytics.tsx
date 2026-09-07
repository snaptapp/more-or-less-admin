import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { Button, Card, CardLabel, CardTitle } from "@/index";
import { ErrorNote, PageHead } from "@/admin/AdminShell";
import { fetchGameAnalytics } from "@/lib/admin/ops.functions";

export const Route = createFileRoute("/admin/analytics")({
  head: () => ({
    meta: [
      { title: "Game Analytics — More or Less Admin" },
      { name: "description", content: "Breakdown of recent game_history by mode, category, and source." },
    ],
  }),
  component: AnalyticsPage,
});

const RANGES = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
];

const HIDDEN_CATEGORIES_KEY = "admin.analytics.hiddenCategories";

function since(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function readHiddenCategories(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HIDDEN_CATEGORIES_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((value): value is string => typeof value === "string" && value.length > 0))];
  } catch {
    return [];
  }
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
            <span className="admin-bar-row__name">{row.name}</span>
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

function CategoryBreakdown({
  rows,
  hidden,
  onHide,
  onShow,
  onShowAll,
}: {
  rows: { name: string; count: number }[];
  hidden: string[];
  onHide: (name: string) => void;
  onShow: (name: string) => void;
  onShowAll: () => void;
}) {
  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const visible = rows.filter((row) => !hiddenSet.has(row.name));
  const visibleTotal = visible.reduce((sum, row) => sum + row.count, 0);
  const hiddenRows = hidden.map((name) => rows.find((row) => row.name === name) ?? { name, count: 0 });
  const [pick, setPick] = useState("");

  return (
    <Card>
      <CardTitle>By category</CardTitle>
      <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 13, margin: "8px 0 0" }}>
        Hide noisy labels from this chart. Counts stay in the sample total above. Hidden list is saved in this browser.
      </p>
      <div className="admin-toolbar" style={{ marginTop: "var(--ds-arena-space-3)" }}>
        <label className="admin-field">
          <span>Hide category</span>
          <select
            className="admin-select"
            value={pick}
            disabled={visible.length === 0}
            onChange={(event) => {
              const name = event.target.value;
              setPick("");
              if (name) onHide(name);
            }}
          >
            <option value="">Select…</option>
            {visible.map((row) => (
              <option key={row.name} value={row.name}>
                {row.name} ({row.count})
              </option>
            ))}
          </select>
        </label>
        {hiddenRows.length > 0 ? (
          <Button size="sm" variant="ghost" onClick={onShowAll}>
            Restore all
          </Button>
        ) : null}
      </div>
      <div style={{ marginTop: "var(--ds-arena-space-3)" }}>
        {visible.length === 0 ? (
          <p style={{ color: "var(--ds-arena-color-text-muted)" }}>
            {rows.length === 0 ? "No games in this window." : "All categories are hidden."}
          </p>
        ) : null}
        {visible.map((row) => (
          <div key={row.name} className="admin-bar-row admin-bar-row--filterable">
            <span className="admin-bar-row__name" title={row.name}>
              {row.name}
            </span>
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
                  width: `${visibleTotal ? (row.count / visibleTotal) * 100 : 0}%`,
                  background: "var(--ds-arena-color-lime)",
                }}
              />
            </span>
            <span style={{ textAlign: "right" }}>{row.count}</span>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Hide ${row.name}`}
              onClick={() => onHide(row.name)}
            >
              Hide
            </Button>
          </div>
        ))}
      </div>
      {hiddenRows.length > 0 ? (
        <>
          <CardLabel style={{ marginTop: "var(--ds-arena-space-4)" }}>Hidden</CardLabel>
          <div className="admin-hidden-list">
            {hiddenRows.map((row) => (
              <span key={row.name} className="admin-hidden-chip">
                <span title={row.name}>
                  {row.name} ({row.count})
                </span>
                <Button size="sm" variant="ghost" onClick={() => onShow(row.name)}>
                  Restore
                </Button>
              </span>
            ))}
          </div>
        </>
      ) : null}
    </Card>
  );
}

function AnalyticsPage() {
  const load = useServerFn(fetchGameAnalytics);
  const [days, setDays] = useState(7);
  const [hiddenCategories, setHiddenCategories] = useState<string[]>([]);
  const [hiddenReady, setHiddenReady] = useState(false);

  useEffect(() => {
    setHiddenCategories(readHiddenCategories());
    setHiddenReady(true);
  }, []);

  useEffect(() => {
    if (!hiddenReady) return;
    localStorage.setItem(HIDDEN_CATEGORIES_KEY, JSON.stringify(hiddenCategories));
  }, [hiddenCategories, hiddenReady]);

  const query = useQuery({
    queryKey: ["analytics", days],
    queryFn: () => load({ data: { since: since(days) } }),
    retry: false,
  });

  const data = query.data;

  function hideCategory(name: string) {
    setHiddenCategories((current) => (current.includes(name) ? current : [...current, name]));
  }

  function showCategory(name: string) {
    setHiddenCategories((current) => current.filter((value) => value !== name));
  }

  return (
    <>
      <PageHead
        title="Game analytics"
        description="Sample of users/*/game_history (collection group). Hide categories locally without changing stored data."
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
                Capped at 500 most recent documents. Shorten the window for exact counts.
              </p>
            ) : null}
            {!data.orderedNewestFirst ? (
              <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 13, margin: 0 }}>
                Newest-first index still building; sample order may not be chronological yet.
              </p>
            ) : null}
          </Card>
          <div className="admin-two-col">
            <Breakdown title="By mode" rows={data.byMode} total={data.total} />
            <Breakdown title="By match source" rows={data.byMatchSource} total={data.total} />
          </div>
          <div className="admin-two-col">
            <CategoryBreakdown
              rows={data.byCategory}
              hidden={hiddenCategories}
              onHide={hideCategory}
              onShow={showCategory}
              onShowAll={() => setHiddenCategories([])}
            />
            <Breakdown title="By difficulty" rows={data.byDifficulty} total={data.total} />
          </div>
          <div className="admin-two-col">
            <Breakdown title="Verified vs unverified" rows={data.byVerified} total={data.total} />
          </div>
        </>
      ) : null}
    </>
  );
}
