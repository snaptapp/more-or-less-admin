import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Badge, Button, Card, CardLabel, CardTitle } from "@/index";
import { ErrorNote, PageHead, statusTone } from "@/admin/AdminShell";
import { actOnReport, fetchReports } from "@/lib/admin/content.functions";

export const Route = createFileRoute("/admin/reports")({
  head: () => ({
    meta: [
      { title: "Moderation Inbox — More or Less Admin" },
      { name: "description", content: "Review player disputes and correct or retire facts." },
    ],
  }),
  component: ReportsPage,
});

type Entry = Awaited<ReturnType<typeof fetchReports>>[number];

function ReportCard({ entry }: { entry: Entry }) {
  const act = useServerFn(actOnReport);
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [corrected, setCorrected] = useState(
    entry.report.trueNumber === null ? "" : String(entry.report.trueNumber),
  );

  const mutation = useMutation({
    mutationFn: (action: "retire_fact" | "fix_number" | "reject") =>
      act({
        data: {
          reportId: entry.report.id,
          action,
          factId: entry.fact?.id,
          correctedNumber: action === "fix_number" ? Number(corrected) : undefined,
          note: note || undefined,
          claimStatement: entry.report.claimStatement,
        },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["reports"] }),
  });

  const pending = entry.report.status === "pending_review";

  return (
    <Card>
      <div className="admin-page-head">
        <CardTitle>{entry.report.topic || "Untitled topic"}</CardTitle>
        <Badge tone={statusTone(entry.report.status)}>{entry.report.status}</Badge>
      </div>
      <p style={{ color: "var(--ds-arena-color-text)", margin: "8px 0" }}>{entry.report.claimStatement}</p>
      <dl className="admin-kv">
        <dt>Presented</dt>
        <dd>
          {entry.report.presentedNumber ?? "—"} {entry.report.unit}
        </dd>
        <dt>Stored true</dt>
        <dd>
          {entry.report.trueNumber ?? "—"} {entry.report.unit}
        </dd>
        <dt>Reason</dt>
        <dd>{entry.report.reason || "—"}</dd>
        <dt>Feedback</dt>
        <dd>{entry.report.feedbackText || "—"}</dd>
        <dt>Reporter</dt>
        <dd>{entry.report.reporterUid || "anonymous"}</dd>
        <dt>Created</dt>
        <dd>{entry.report.createdAt ?? "—"}</dd>
        <dt>Matched fact</dt>
        <dd>
          {entry.fact ? `${entry.fact.subject} — ${entry.fact.angle} (${entry.fact.id})` : "none found"}
        </dd>
        {entry.report.resolutionNote ? (
          <>
            <dt>Resolution</dt>
            <dd>{entry.report.resolutionNote}</dd>
          </>
        ) : null}
      </dl>

      {pending ? (
        <>
          <div className="admin-toolbar" style={{ marginTop: "var(--ds-arena-space-4)" }}>
            <label className="admin-field">
              <span>Corrected number</span>
              <input
                className="admin-input"
                type="number"
                step="any"
                value={corrected}
                onChange={(event) => setCorrected(event.target.value)}
              />
            </label>
            <label className="admin-field" style={{ flex: "1 1 240px" }}>
              <span>Resolution note</span>
              <input
                className="admin-input"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
          </div>
          <ErrorNote error={mutation.error} />
          <div className="admin-row-actions" style={{ marginTop: "var(--ds-arena-space-3)" }}>
            <Button
              variant="danger"
              disabled={!entry.fact || mutation.isPending}
              onClick={() => {
                if (window.confirm("Retire the matched fact and resolve this report?")) {
                  mutation.mutate("retire_fact");
                }
              }}
            >
              Accept &amp; retire fact
            </Button>
            <Button
              disabled={!entry.fact || !corrected || mutation.isPending}
              onClick={() => mutation.mutate("fix_number")}
            >
              Accept &amp; fix number
            </Button>
            <Button variant="ghost" disabled={mutation.isPending} onClick={() => mutation.mutate("reject")}>
              Reject report
            </Button>
          </div>
        </>
      ) : null}
    </Card>
  );
}

function ReportsPage() {
  const list = useServerFn(fetchReports);
  const [status, setStatus] = useState("pending_review");

  const query = useQuery({
    queryKey: ["reports", status],
    queryFn: () => list({ data: { status: status || undefined } }),
    retry: false,
  });

  return (
    <>
      <PageHead
        title="Moderation inbox"
        description="Player-reported trivia disputes, matched back to the fact bank."
        actions={
          <label className="admin-field">
            <span>Status</span>
            <select
              className="admin-select"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="pending_review">pending_review</option>
              <option value="resolved">resolved</option>
              <option value="rejected">rejected</option>
              <option value="">All</option>
            </select>
          </label>
        }
      />
      <ErrorNote error={query.error} />
      {query.isLoading ? <p className="admin-empty">Loading reports…</p> : null}
      {query.data?.length === 0 ? (
        <Card>
          <CardLabel>Inbox zero</CardLabel>
          <p style={{ color: "var(--ds-arena-color-text-muted)" }}>Nothing to review here.</p>
        </Card>
      ) : null}
      {query.data?.map((entry) => <ReportCard key={entry.report.id} entry={entry} />)}
    </>
  );
}
