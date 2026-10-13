import { useEffect } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Badge, Button, Card, CardLabel } from "@/index";
import { CountBar, StatusPie } from "@/admin/charts";
import { ErrorNote, PageHead } from "@/admin/AdminShell";
import { useAdminAuth } from "@/admin/auth";
import { trackViewedAdminOverview } from "@/lib/amplitude";
import { fetchOverview } from "@/lib/admin/content.functions";

export const Route = createFileRoute("/admin/")({
  head: () => ({
    meta: [
      { title: "Admin Overview — More or Less" },
      { name: "description", content: "Ops dashboard: fact bank, moderation, crawl, and game health at a glance." },
      { property: "og:title", content: "Admin Overview — More or Less" },
      { property: "og:description", content: "Ops dashboard: fact bank, moderation, crawl, and game health at a glance." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: OverviewPage,
});

function OverviewPage() {
  const { user, ready } = useAdminAuth();
  const overview = useServerFn(fetchOverview);

  useEffect(() => {
    trackViewedAdminOverview();
  }, []);
  const { data, isLoading, error } = useQuery({
    queryKey: ["overview", user?.uid],
    queryFn: () => overview(),
    enabled: ready && !!user,
    retry: 1,
  });

  return (
    <>
      <PageHead
        title="Overview"
        description="Live counts and charts from Cloud Firestore."
        actions={data ? <Badge tone="lime">{data.user.email ?? data.user.uid}</Badge> : null}
      />
      <ErrorNote error={error} />
      {isLoading ? <p className="admin-empty">Loading dashboard…</p> : null}
      {data ? (
        <>
          <div className="admin-grid">
            <Card>
              <CardLabel>Active facts</CardLabel>
              <p className="admin-stat" data-tone="lime">
                {data.active}
              </p>
            </Card>
            <Card>
              <CardLabel>Pending facts</CardLabel>
              <p className="admin-stat" data-tone="amber">
                {data.pendingFacts}
              </p>
            </Card>
            <Card>
              <CardLabel>Disputed</CardLabel>
              <p className="admin-stat" data-tone="amber">
                {data.disputed}
              </p>
            </Card>
            <Card>
              <CardLabel>Retired</CardLabel>
              <p className="admin-stat" data-tone="red">
                {data.retired}
              </p>
            </Card>
            <Card>
              <CardLabel>Reports pending</CardLabel>
              <p className="admin-stat" data-tone="purple">
                {data.reportsPending}
              </p>
            </Card>
            <Card>
              <CardLabel>Crawl queued</CardLabel>
              <p className="admin-stat" data-tone="amber">
                {data.crawlQueued}
              </p>
            </Card>
            <Card>
              <CardLabel>Games (7d)</CardLabel>
              <p className="admin-stat">{data.games7d ?? "—"}</p>
              {data.gamesIndexUnavailable ? (
                <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 13, margin: 0 }}>
                  game_history index not enabled yet
                </p>
              ) : null}
            </Card>
            <Card>
              <CardLabel>Premium users</CardLabel>
              <p className="admin-stat" data-tone="purple">
                {data.premium}
              </p>
            </Card>
          </div>

          <Card>
            <CardLabel>Jump in</CardLabel>
            <div className="admin-toolbar" style={{ marginTop: "var(--ds-arena-space-3)" }}>
              <Link to="/admin/facts" style={{ textDecoration: "none" }}>
                <Button size="sm" variant="primary">
                  Curate the fact bank →
                </Button>
              </Link>
              <Link to="/admin/reports" style={{ textDecoration: "none" }}>
                <Button size="sm" variant="primary">
                  Clear moderation queue ({data.reportsPending}) →
                </Button>
              </Link>
              <Link to="/admin/analytics" style={{ textDecoration: "none" }}>
                <Button size="sm" variant="ghost">
                  Game analytics →
                </Button>
              </Link>
            </div>
          </Card>

          <div className="admin-chart-grid">
            <StatusPie title="Fact bank status" rows={data.series.factStatus} />
            <StatusPie title="Active content rating" rows={data.series.contentRating} />
            <CountBar title="Facts by genre" rows={data.series.categories} layout="horizontal" />
            <StatusPie title="Moderation mix" rows={data.series.reports} />
            <CountBar title="Crawl queue" rows={data.series.crawl} />
            <StatusPie
              title="Games by mode (7d)"
              rows={data.series.gamesByMode}
              footnote={
                data.gamesIndexUnavailable
                  ? "Approximate until the game_history playedAt collection-group index is Enabled in Firebase."
                  : data.gamesWindowed
                    ? `Sampled ${data.gamesSampled} games (capped at 500). Shorten the window on Game analytics for exact counts.`
                    : data.gamesSampled === 0
                      ? undefined
                      : `Based on ${data.gamesSampled} sampled games.`
              }
            />
          </div>
        </>
      ) : null}
    </>
  );
}
