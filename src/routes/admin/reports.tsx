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
    mutationFn: (action: "retire_fact" | "fix_number" | "reject" | "resolve_only" | "add_to_bank") =>
      act({
        data: {
          reportId: entry.report.id,
          action,
          factId: entry.fact?.id,
          correctedNumber: corrected ? Number(corrected) : undefined,
          note: note || undefined,
          topic: entry.report.topic,
          claimStatement: entry.report.claimStatement,
          unit: entry.report.unit,
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
        {entry.report.initialTopic && entry.report.initialTopic !== entry.report.topic ? (
          <>
            <dt>Selected Topic</dt>
            <dd>{entry.report.initialTopic}</dd>
          </>
        ) : null}
        <dt>Exact Question</dt>
        <dd style={{ fontWeight: 600 }}>{entry.report.claimStatement}</dd>
        <dt>Presented</dt>
        <dd>
          {entry.report.presentedNumber ?? "—"} {entry.report.unit}
        </dd>
        <dt>Stored true</dt>
        <dd>
          {entry.report.trueNumber ?? "—"} {entry.report.unit}
        </dd>
        {entry.report.playerGuess ? (
          <>
            <dt>Player Guess</dt>
            <dd>
              <strong>{entry.report.playerGuess}</strong>
              {entry.report.isPlayerCorrect !== null && entry.report.isPlayerCorrect !== undefined ? (
                <span
                  style={{
                    marginLeft: 8,
                    fontSize: "0.85em",
                    padding: "2px 6px",
                    borderRadius: 4,
                    background: entry.report.isPlayerCorrect ? "rgba(16, 185, 129, 0.2)" : "rgba(239, 68, 68, 0.2)",
                    color: entry.report.isPlayerCorrect ? "#10b981" : "#ef4444",
                  }}
                >
                  {entry.report.isPlayerCorrect ? "CORRECT" : "WRONG"}
                </span>
              ) : null}
            </dd>
          </>
        ) : null}
        <dt>Dispute Reason</dt>
        <dd>{entry.report.reason || "—"}</dd>
        <dt>Player Feedback</dt>
        <dd>{entry.report.feedbackText || "—"}</dd>
        <dt>Ombudsman Ruling</dt>
        <dd>
          {entry.report.ombudsmanRuling ? (
            <div>
              <div style={{ marginBottom: 4 }}>{entry.report.ombudsmanRuling}</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                {entry.report.ombudsmanArbiter ? (
                  <span
                    style={{
                      fontSize: "0.8em",
                      padding: "2px 6px",
                      borderRadius: 4,
                      background: entry.report.ombudsmanArbiter === "gemini" ? "rgba(147, 51, 234, 0.2)" : "rgba(107, 114, 128, 0.2)",
                      color: entry.report.ombudsmanArbiter === "gemini" ? "#c084fc" : "#9ca3af",
                    }}
                  >
                    Arbiter: {entry.report.ombudsmanArbiter === "gemini" ? "Gemini (Vertex AI Grounding)" : "Edge Worker (Fallback Review)"}
                  </span>
                ) : null}
                {entry.report.ombudsmanAgreed !== null && entry.report.ombudsmanAgreed !== undefined ? (
                  <span
                    style={{
                      fontSize: "0.8em",
                      padding: "2px 6px",
                      borderRadius: 4,
                      background: entry.report.ombudsmanAgreed ? "rgba(16, 185, 129, 0.2)" : "rgba(239, 68, 68, 0.2)",
                      color: entry.report.ombudsmanAgreed ? "#10b981" : "#ef4444",
                    }}
                  >
                    {entry.report.ombudsmanAgreed ? "Agreed with player" : "Rejected dispute"}
                  </span>
                ) : null}
              </div>
            </div>
          ) : (
            "—"
          )}
        </dd>
        {entry.report.ombudsmanSources && entry.report.ombudsmanSources.length > 0 ? (
          <>
            <dt>Grounding Sources</dt>
            <dd>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {entry.report.ombudsmanSources.map((source, idx) => (
                  <li key={idx} style={{ fontSize: "0.9em", color: "var(--ds-arena-color-text-muted)" }}>
                    {source}
                  </li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
        <dt>Reporter</dt>
        <dd>{entry.report.reporterUid || "anonymous"}</dd>
        <dt>Created</dt>
        <dd>{entry.report.createdAt ?? "—"}</dd>
        <dt>Matched fact</dt>
        <dd>
          {entry.fact ? `${entry.fact.subject} — ${entry.fact.angle} (${entry.fact.id})` : "none found (AI-generated claim)"}
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
            {entry.fact ? (
              <>
                <Button
                  variant="danger"
                  disabled={mutation.isPending}
                  onClick={() => {
                    if (window.confirm("Retire the matched fact and resolve this report?")) {
                      mutation.mutate("retire_fact");
                    }
                  }}
                >
                  Accept &amp; retire fact
                </Button>
                <Button
                  variant="primary"
                  disabled={!corrected || mutation.isPending}
                  onClick={() => mutation.mutate("fix_number")}
                >
                  Accept &amp; fix number
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="primary"
                  disabled={mutation.isPending}
                  onClick={() => {
                    if (window.confirm("Accept and resolve this AI claim report?")) {
                      mutation.mutate("resolve_only");
                    }
                  }}
                >
                  Accept &amp; resolve report
                </Button>
                {corrected ? (
                  <Button
                    variant="daily"
                    disabled={mutation.isPending}
                    onClick={() => {
                      if (window.confirm("Add this corrected fact to the fact bank?")) {
                        mutation.mutate("add_to_bank");
                      }
                    }}
                  >
                    Accept &amp; add to fact bank
                  </Button>
                ) : null}
              </>
            )}
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
