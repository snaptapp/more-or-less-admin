import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Badge, Button, Card, CardLabel, CardTitle } from "@/index";
import { ErrorNote, PageHead } from "@/admin/AdminShell";
import { fetchDaily, moderateLeaderboardEntry } from "@/lib/admin/ops.functions";

export const Route = createFileRoute("/admin/daily")({
  head: () => ({
    meta: [
      { title: "Daily Challenge — More or Less Admin" },
      { name: "description", content: "Preview daily packs and their leaderboards." },
    ],
  }),
  component: DailyPage,
});

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function readField(round: unknown, key: string): string {
  if (round && typeof round === "object" && key in (round as Record<string, unknown>)) {
    const value = (round as Record<string, unknown>)[key];
    if (value === null || value === undefined) return "—";
    return String(value);
  }
  return "—";
}

function DailyPage() {
  const load = useServerFn(fetchDaily);
  const removeEntry = useServerFn(moderateLeaderboardEntry);
  const queryClient = useQueryClient();
  const [date, setDate] = useState(today);

  const query = useQuery({
    queryKey: ["daily", date],
    queryFn: () => load({ data: { date } }),
    retry: false,
  });

  const removeMutation = useMutation({
    mutationFn: (uid: string) => removeEntry({ data: { date, uid, reason: "Cheating/Invalid score" } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["daily", date] }),
  });

  const pack = query.data?.pack;
  const leaderboard = query.data?.leaderboard;

  return (
    <>
      <PageHead
        title="Daily challenge"
        description="Inspect the pack served on any date and the scores it produced."
        actions={
          <label className="admin-field">
            <span>Date</span>
            <input
              className="admin-input"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </label>
        }
      />
      <ErrorNote error={query.error} />
      {query.isLoading ? <p className="admin-empty">Loading pack…</p> : null}

      {query.data && !pack ? (
        <Card>
          <CardLabel>No pack</CardLabel>
          <p style={{ color: "var(--ds-arena-color-text-muted)" }}>
            No daily pack exists for {date} yet.
          </p>
        </Card>
      ) : null}

      {pack ? (
        <Card>
          <div className="admin-page-head">
            <CardTitle>Pack {pack.date}</CardTitle>
            <Badge tone="purple">{pack.category || "mixed"}</Badge>
          </div>
          <dl className="admin-kv">
            <dt>Seed</dt>
            <dd>{pack.seed || "—"}</dd>
            <dt>Created</dt>
            <dd>{pack.createdAt ?? "—"}</dd>
            <dt>Rounds</dt>
            <dd>{pack.rounds.length}</dd>
          </dl>
          <div className="admin-table-wrap" style={{ marginTop: "var(--ds-arena-space-4)" }}>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Claim</th>
                  <th>True number</th>
                  <th>Explanation</th>
                </tr>
              </thead>
              <tbody>
                {pack.rounds.map((round, index) => (
                  <tr key={index}>
                    <td>{index + 1}</td>
                    <td>
                      <strong>{readField(round, "claim")}</strong>
                    </td>
                    <td>{readField(round, "true_number")}</td>
                    <td>{readField(round, "explanation")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {leaderboard && leaderboard.entries.length > 0 ? (
        <Card>
          <CardTitle>Leaderboard</CardTitle>
          <div className="admin-table-wrap" style={{ marginTop: "var(--ds-arena-space-3)" }}>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Player</th>
                  <th>Score</th>
                  <th aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {leaderboard.entries.map((entry, index) => {
                  const uid = readField(entry, "uid");
                  return (
                    <tr key={index}>
                      <td>{index + 1}</td>
                      <td>
                        <strong>
                          {readField(entry, "displayName") !== "—"
                            ? readField(entry, "displayName")
                            : uid}
                        </strong>
                      </td>
                      <td>{readField(entry, "score")}</td>
                      <td className="admin-row-actions">
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={removeMutation.isPending || uid === "—"}
                          onClick={() => {
                            if (window.confirm(`Remove score entry for ${uid} from ${date} leaderboard?`)) {
                              removeMutation.mutate(uid);
                            }
                          }}
                        >
                          Remove
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </>
  );
}
