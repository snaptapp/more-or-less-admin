import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { Button, Card, CardLabel, CardTitle } from "@/index";
import { ErrorNote, PageHead } from "@/admin/AdminShell";
import { fetchGameAnalytics, fetchQuestionTelemetry, flagQuestionTelemetry } from "@/lib/admin/ops.functions";

export const Route = createFileRoute("/admin/analytics")({
  head: () => ({
    meta: [
      { title: "Game Analytics — More or Less Admin" },
      { name: "description", content: "Breakdown of recent game_history by mode and category." },
    ],
  }),
  component: AnalyticsPage,
});

const RANGES = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
];

const DELETED_CATEGORIES_KEY = "admin.analytics.deletedCategories";
const LEGACY_HIDDEN_CATEGORIES_KEY = "admin.analytics.hiddenCategories";

function since(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function readStringList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string" && value.length > 0);
  } catch {
    return [];
  }
}

function readDeletedCategories(): string[] {
  if (typeof window === "undefined") return [];
  const current = readStringList(localStorage.getItem(DELETED_CATEGORIES_KEY));
  const legacy = readStringList(localStorage.getItem(LEGACY_HIDDEN_CATEGORIES_KEY));
  return [...new Set([...current, ...legacy])];
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
  deleted,
  onDelete,
  onRestore,
  onRestoreAll,
}: {
  rows: { name: string; count: number }[];
  deleted: string[];
  onDelete: (name: string) => void;
  onRestore: (name: string) => void;
  onRestoreAll: () => void;
}) {
  const deletedSet = useMemo(() => new Set(deleted), [deleted]);
  const visible = rows.filter((row) => !deletedSet.has(row.name));
  const visibleTotal = visible.reduce((sum, row) => sum + row.count, 0);
  const sampleTotal = rows.reduce((sum, row) => sum + row.count, 0);
  const deletedRows = deleted.map((name) => rows.find((row) => row.name === name) ?? { name, count: 0 });
  const [pick, setPick] = useState("");

  return (
    <Card>
      <CardTitle>By category</CardTitle>
      <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 13, margin: "8px 0 0" }}>
        Delete noisy labels from this chart. Stored game history is unchanged. Deleted labels stay off this chart in this
        browser.
      </p>
      <div className="admin-toolbar" style={{ marginTop: "var(--ds-arena-space-3)" }}>
        <label className="admin-field">
          <span>Delete category</span>
          <select
            className="admin-select"
            value={pick}
            disabled={visible.length === 0}
            onChange={(event) => {
              const name = event.target.value;
              setPick("");
              if (name) onDelete(name);
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
      </div>
      <div style={{ marginTop: "var(--ds-arena-space-3)" }}>
        {visible.length === 0 ? (
          <p style={{ color: "var(--ds-arena-color-text-muted)" }}>
            {rows.length === 0 ? "No games in this window." : "All categories are deleted from this chart."}
          </p>
        ) : deletedRows.length > 0 ? (
          <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 13, margin: "0 0 8px" }}>
            Showing {visibleTotal} of {sampleTotal} sampled games after {deletedRows.length} deleted.
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
              variant="danger"
              aria-label={`Delete ${row.name} from this chart`}
              onClick={() => onDelete(row.name)}
            >
              Delete
            </Button>
          </div>
        ))}
      </div>
      {deletedRows.length > 0 ? (
        <details className="admin-hidden-fold">
          <summary>
            {deletedRows.length} deleted
          </summary>
          <div className="admin-hidden-list">
            {deletedRows.map((row) => (
              <span key={row.name} className="admin-hidden-chip">
                <span title={row.name}>
                  {row.name}
                  <span className="admin-hidden-chip__count">{row.count}</span>
                </span>
                <button
                  type="button"
                  className="admin-hidden-restore"
                  aria-label={`Restore ${row.name}`}
                  onClick={() => onRestore(row.name)}
                >
                  undo
                </button>
              </span>
            ))}
            {deletedRows.length > 1 ? (
              <button type="button" className="admin-hidden-restore" onClick={onRestoreAll}>
                undo all
              </button>
            ) : null}
          </div>
        </details>
      ) : null}
    </Card>
  );
}

function AnalyticsPage() {
  const load = useServerFn(fetchGameAnalytics);
  const loadQuestions = useServerFn(fetchQuestionTelemetry);
  const flagQuestion = useServerFn(flagQuestionTelemetry);
  const [days, setDays] = useState(7);
  const [deletedCategories, setDeletedCategories] = useState<string[]>([]);
  const [deletedReady, setDeletedReady] = useState(false);

  useEffect(() => {
    setDeletedCategories(readDeletedCategories());
    setDeletedReady(true);
  }, []);

  useEffect(() => {
    if (!deletedReady) return;
    localStorage.setItem(DELETED_CATEGORIES_KEY, JSON.stringify(deletedCategories));
    localStorage.removeItem(LEGACY_HIDDEN_CATEGORIES_KEY);
  }, [deletedCategories, deletedReady]);

  const query = useQuery({
    queryKey: ["analytics", days],
    queryFn: () => load({ data: { since: since(days) } }),
    retry: false,
  });
  const questions = useQuery({
    queryKey: ["question-telemetry", days],
    queryFn: () => loadQuestions({ data: { days: days as 7 | 30 | 90 } }),
    retry: false,
  });

  const data = query.data;

  function deleteCategory(name: string) {
    setDeletedCategories((current) => (current.includes(name) ? current : [...current, name]));
  }

  function restoreCategory(name: string) {
    setDeletedCategories((current) => current.filter((value) => value !== name));
  }

  return (
    <>
      <PageHead
        title="Game analytics"
        description="Sample of users/*/game_history (collection group). Delete categories from the chart locally without changing stored data."
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
            {data.indexUnavailable ? (
              <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 13, margin: 0 }}>
                Collection-group index on playedAt is not Enabled yet, so this sample is unordered.
                Click Save once in the Firebase index dialog, then wait until status is Enabled.
              </p>
            ) : null}
            {data.windowed ? (
              <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 13, margin: 0 }}>
                Capped at 500 most recent documents. Shorten the window for exact counts.
              </p>
            ) : null}
            {!data.orderedNewestFirst && !data.indexUnavailable ? (
              <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 13, margin: 0 }}>
                Newest-first index still building; sample order may not be chronological yet.
              </p>
            ) : null}
          </Card>
          <div className="admin-two-col">
            <Breakdown title="By mode" rows={data.byMode} total={data.total} />
            <Breakdown
              title="Classic / Cutthroat lobby"
              rows={data.byLobby}
              total={data.byLobby.reduce((sum, row) => sum + row.count, 0)}
            />
          </div>
          <Breakdown title="Verified vs unverified" rows={data.byVerified} total={data.total} />
          <CategoryBreakdown
            rows={data.byCategory}
            deleted={deletedCategories}
            onDelete={deleteCategory}
            onRestore={restoreCategory}
            onRestoreAll={() => setDeletedCategories([])}
          />
          <Card>
            <CardTitle>Question quality</CardTitle>
            <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 13 }}>
              Signed question identities; player outcomes are self-reported. Rows need at least 20 answered attempts.
            </p>
            {questions.isLoading ? <p className="admin-empty">Loading signed telemetry…</p> : null}
            <ErrorNote error={questions.error} />
            {questions.data?.length === 0 ? <p className="admin-empty">No actionable signed telemetry yet.</p> : null}
            {questions.data?.map((row) => (
              <div key={row.questionId} className="admin-bar-row" style={{ gridTemplateColumns: "minmax(0, 2fr) repeat(4, auto)" }}>
                <span title={row.claim}>{row.kind === "fact" ? "Fact" : "Generated"}: {row.claim || row.questionId}</span>
                <span>{row.answered} answered</span>
                <span>{Math.round(row.accuracy * 100)}% correct</span>
                <span>{Math.round(row.skipRate * 100)}% skipped</span>
                <Button size="sm" variant="danger" onClick={async () => { try { await flagQuestion({ data: { days: days as 7 | 30 | 90, questionId: row.questionId } }); await questions.refetch(); } catch (error) { console.error('Failed to flag question:', error); } }}>

                  Flag for review
                </Button>
              </div>
            ))}
          </Card>
        </>
      ) : null}
    </>
  );
}
