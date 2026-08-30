import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Badge, Button, Card, CardTitle } from "@/index";
import { ErrorNote, PageHead } from "@/admin/AdminShell";
import { fetchPlayer, fetchPlayers, togglePremium } from "@/lib/admin/ops.functions";

export const Route = createFileRoute("/admin/players")({
  head: () => ({
    meta: [
      { title: "Players — More or Less Admin" },
      { name: "description", content: "Look up players, inspect lifetime stats and premium status." },
    ],
  }),
  component: PlayersPage,
});

function PlayerDetail({ id, onDone }: { id: string; onDone: () => void }) {
  const load = useServerFn(fetchPlayer);
  const premium = useServerFn(togglePremium);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["player", id],
    queryFn: () => load({ data: { id } }),
    retry: false,
  });

  const mutation = useMutation({
    mutationFn: (isPremium: boolean) => premium({ data: { id, isPremium } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["player", id] });
      await queryClient.invalidateQueries({ queryKey: ["players"] });
    },
  });

  const player = query.data;

  return (
    <Card>
      <div className="admin-page-head">
        <CardTitle>{player?.displayName || player?.email || id}</CardTitle>
        {player?.isPremium ? <Badge tone="purple">Premium</Badge> : <Badge>Free</Badge>}
      </div>
      <ErrorNote error={query.error ?? mutation.error} />
      {query.isLoading ? <p className="admin-empty">Loading player…</p> : null}
      {player ? (
        <>
          <dl className="admin-kv">
            <dt>UID</dt>
            <dd>{player.id}</dd>
            <dt>Email</dt>
            <dd>{player.email || "—"}</dd>
            <dt>Joined</dt>
            <dd>{player.createdAt ?? "—"}</dd>
            <dt>Games played</dt>
            <dd>{player.stats?.totalGamesPlayed ?? "—"}</dd>
            <dt>Correct / wrong</dt>
            <dd>
              {player.stats ? `${player.stats.totalCorrect} / ${player.stats.totalWrong}` : "—"}
            </dd>
            <dt>Best score</dt>
            <dd>{player.stats?.bestScore ?? "—"}</dd>
            <dt>Lifetime accuracy</dt>
            <dd>
              {player.stats ? `${Math.round(player.stats.lifetimePercentCorrect)}%` : "—"}
            </dd>
          </dl>
          <div className="admin-row-actions" style={{ marginTop: "var(--ds-arena-space-4)" }}>
            <Button
              variant={player.isPremium ? "skip" : "daily"}
              disabled={mutation.isPending}
              onClick={() => {
                if (window.confirm(`Set premium to ${!player.isPremium}?`)) {
                  mutation.mutate(!player.isPremium);
                }
              }}
            >
              {player.isPremium ? "Remove premium" : "Grant premium"}
            </Button>
            <Button variant="ghost" onClick={onDone}>
              Close
            </Button>
          </div>
        </>
      ) : null}
    </Card>
  );
}

function PlayersPage() {
  const list = useServerFn(fetchPlayers);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["players", search],
    queryFn: () => list({ data: { search: search || undefined } }),
    retry: false,
  });

  return (
    <>
      <PageHead title="Players" description="Account lookup and lifetime stats." />
      <div className="admin-toolbar">
        <label className="admin-field" style={{ flex: "1 1 280px" }}>
          <span>Search name, email or UID</span>
          <input
            className="admin-input"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>
      <ErrorNote error={query.error} />
      {selected ? <PlayerDetail id={selected} onDone={() => setSelected(null)} /> : null}
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Display name</th>
              <th>Email</th>
              <th>Premium</th>
              <th>Joined</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {query.data?.map((player) => (
              <tr key={player.id}>
                <td>
                  <strong>{player.displayName || "—"}</strong>
                </td>
                <td>{player.email || "—"}</td>
                <td>{player.isPremium ? "Yes" : "No"}</td>
                <td>{player.createdAt ?? "—"}</td>
                <td>
                  <Button size="sm" variant="ghost" onClick={() => setSelected(player.id)}>
                    Inspect
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {query.isLoading ? <p className="admin-empty">Loading players…</p> : null}
        {query.data?.length === 0 ? <p className="admin-empty">No players matched.</p> : null}
      </div>
    </>
  );
}
