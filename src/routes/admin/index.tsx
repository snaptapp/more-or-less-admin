import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Badge, Card, CardLabel, StatValue } from "@/index";
import { ErrorNote, PageHead } from "@/admin/AdminShell";
import { fetchOverview } from "@/lib/admin/content.functions";

export const Route = createFileRoute("/admin/")({
  head: () => ({
    meta: [
      { title: "Admin Overview — More or Less" },
      { name: "description", content: "Fact bank health and moderation queue at a glance." },
    ],
  }),
  component: OverviewPage,
});

function OverviewPage() {
  const overview = useServerFn(fetchOverview);
  const { data, isLoading, error } = useQuery({
    queryKey: ["overview"],
    queryFn: () => overview(),
    retry: false,
  });

  return (
    <>
      <PageHead
        title="Overview"
        description="Live counts straight from Cloud Firestore."
        actions={data ? <Badge tone="lime">{data.user.email ?? data.user.uid}</Badge> : null}
      />
      <ErrorNote error={error} />
      {isLoading ? <p className="admin-empty">Loading counts…</p> : null}
      {data ? (
        <>
          <div className="admin-grid">
            <Card>
              <CardLabel>Active facts</CardLabel>
              <StatValue value={String(data.active)} tone="lime" />
            </Card>
            <Card>
              <CardLabel>Disputed</CardLabel>
              <StatValue value={String(data.disputed)} tone="amber" />
            </Card>
            <Card>
              <CardLabel>Retired</CardLabel>
              <StatValue value={String(data.retired)} tone="red" />
            </Card>
            <Card>
              <CardLabel>Reports pending</CardLabel>
              <StatValue value={String(data.pending)} tone="purple" />
            </Card>
          </div>
          <Card>
            <CardLabel>Jump in</CardLabel>
            <div className="admin-toolbar">
              <Link className="admin-nav" to="/admin/facts">
                Curate the fact bank
              </Link>
              <Link className="admin-nav" to="/admin/reports">
                Clear the moderation queue
              </Link>
            </div>
          </Card>
        </>
      ) : null}
    </>
  );
}
