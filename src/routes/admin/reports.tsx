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

const REASON_LABELS: Record<string, string> = {
  INCORRECT_NUMBER: "True number is incorrect",
  AMBIGUOUS_QUESTION: "Question claim is ambiguous",
  WRONG_UNIT: "Unit of measurement is wrong",
  OUTDATED_FACT: "Information is outdated",
};

const SOURCE_LABELS: Record<string, { label: string; tone: "lime" | "red" | "amber" | "purple" | "muted" }> = {
  fact_lint: { label: "Fact lint", tone: "amber" },
  fact_reverify: { label: "Re-verify number change", tone: "red" },
  round_telemetry: { label: "Player report (signed telemetry)", tone: "muted" },
};

function sourceLabel(source: string | undefined): { label: string; tone: "lime" | "red" | "amber" | "purple" | "muted" } {
  if (!source) return { label: "Player report", tone: "muted" };
  return SOURCE_LABELS[source] ?? { label: source, tone: "muted" };
}

function displayOrMissing(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "Not recorded";
}

function formatGuess(guess: string | undefined): string {
  if (!guess) return "Not recorded";
  switch (guess.toUpperCase()) {
    case "MORE":
      return "MORE";
    case "LESS":
      return "LESS";
    case "SKIP":
      return "Skipped";
    case "TIMEOUT":
      return "Timed out";
    default:
      return guess;
  }
}

function Pill({
  tone,
  children,
}: {
  tone: "lime" | "red" | "amber" | "purple" | "muted";
  children: string;
}) {
  const styles: Record<typeof tone, { background: string; color: string }> = {
    lime: { background: "rgba(16, 185, 129, 0.2)", color: "#10b981" },
    red: { background: "rgba(239, 68, 68, 0.2)", color: "#ef4444" },
    amber: { background: "rgba(246, 195, 68, 0.2)", color: "#f6c344" },
    purple: { background: "rgba(147, 51, 234, 0.2)", color: "#c084fc" },
    muted: { background: "rgba(107, 114, 128, 0.2)", color: "#9ca3af" },
  };
  return (
    <span className="admin-pill" style={styles[tone]}>
      {children}
    </span>
  );
}

function SourceList({ sources }: { sources: string[] }) {
  if (sources.length === 0) return <>Not recorded</>;
  return (
    <ul style={{ margin: 0, paddingLeft: 18 }}>
      {sources.map((source, idx) => {
        const href = /^https?:\/\//i.test(source) ? source : null;
        return (
          <li key={`${source}-${idx}`} style={{ fontSize: "0.9em" }}>
            {href ? (
              <a href={href} target="_blank" rel="noreferrer">
                {source}
              </a>
            ) : (
              source
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ReportCard({ entry }: { entry: Entry }) {
  const act = useServerFn(actOnReport);
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [corrected, setCorrected] = useState(
    entry.report.trueNumber === null ? "" : String(entry.report.trueNumber),
  );

  const mutation = useMutation({
    mutationFn: (
      params:
        | "retire_fact"
        | "fix_number"
        | "reject"
        | "resolve_only"
        | "add_to_bank"
        | {
            action:
              | "retire_fact"
              | "fix_number"
              | "reject"
              | "resolve_only"
              | "add_to_bank"
              | "resolve_duplicate";
            keepFactId?: string;
            retireFactId?: string;
            retireFactIds?: string[];
            note?: string;
            correctedNumber?: number;
          },
    ) => {
      const isObj = typeof params === "object";
      const action = isObj ? params.action : params;
      return act({
        data: {
          reportId: entry.report.id,
          action,
          factId: entry.fact?.id,
          correctedNumber: corrected ? Number(corrected) : undefined,
          note: (isObj && params.note) || note || undefined,
          topic: entry.report.topic,
          claimStatement: entry.report.claimStatement,
          unit: entry.report.unit,
          keepFactId: isObj ? params.keepFactId : undefined,
          retireFactId: isObj ? params.retireFactId : undefined,
          retireFactIds: isObj ? params.retireFactIds : undefined,
        },
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["reports"] }),
  });

  const pending = entry.report.status === "pending_review";
  const report = entry.report;
  const chosenTopic = report.initialTopic || report.topic;
  const questionTopic = report.topic;
  const guess = report.playerGuess?.toUpperCase();
  const outcome =
    guess === "SKIP"
      ? { label: "Skipped", tone: "amber" as const }
      : guess === "TIMEOUT"
        ? { label: "Timed out", tone: "amber" as const }
        : report.isPlayerCorrect === true
          ? { label: "Correct", tone: "lime" as const }
          : report.isPlayerCorrect === false
            ? { label: "Wrong", tone: "red" as const }
            : null;
  const arbiter = report.ombudsmanArbiter;
  const arbiterLabel =
    arbiter === "gemini"
      ? "Gemini (Vertex AI grounding)"
      : arbiter === "edge_worker"
        ? "Edge worker (rule-based fallback)"
        : "Not recorded";

  return (
    <Card>
      <div className="admin-page-head">
        <CardTitle>{chosenTopic || "Untitled topic"}</CardTitle>
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <Pill tone={sourceLabel(report.reportSource).tone}>
            {sourceLabel(report.reportSource).label}
          </Pill>
          <Badge tone={statusTone(report.status)}>{report.status}</Badge>
        </span>
      </div>
      <dl className="admin-kv" style={{ marginTop: "var(--ds-arena-space-3)" }}>
        <dt>Topic chosen</dt>
        <dd>{displayOrMissing(chosenTopic)}</dd>
        {questionTopic && chosenTopic && questionTopic !== chosenTopic ? (
          <>
            <dt>Question topic</dt>
            <dd>{questionTopic}</dd>
          </>
        ) : null}
        <dt>Exact question</dt>
        <dd style={{ fontWeight: 600, color: "var(--ds-arena-color-text)" }}>
          {displayOrMissing(report.claimStatement)}
        </dd>
        <dt>Presented</dt>
        <dd>
          {report.presentedNumber ?? "Not recorded"} {report.unit}
        </dd>
        <dt>Stored true</dt>
        <dd>
          {report.trueNumber ?? "Not recorded"} {report.unit}
        </dd>
        <dt>Player guess</dt>
        <dd>
          <strong>{formatGuess(report.playerGuess)}</strong>
          {outcome ? (
            <>
              {" "}
              <Pill tone={outcome.tone}>{outcome.label}</Pill>
            </>
          ) : null}
        </dd>
        <dt>Dispute reason</dt>
        <dd>{REASON_LABELS[report.reason] ?? displayOrMissing(report.reason)}</dd>
        {report.qualityFlags?.length ? (
          <>
            <dt>Quality flags</dt>
            <dd>
              <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
                {report.qualityFlags.map((flag) => (
                  <Badge key={flag} tone="amber">{flag}</Badge>
                ))}
              </span>
            </dd>
          </>
        ) : null}
        <dt>Player feedback</dt>
        <dd>{displayOrMissing(report.feedbackText)}</dd>
        <dt>Reveal text</dt>
        <dd>{displayOrMissing(report.explanation)}</dd>
        <dt>Ombudsman arbiter</dt>
        <dd>
          <Pill tone={arbiter === "gemini" ? "purple" : arbiter === "edge_worker" ? "muted" : "amber"}>
            {arbiterLabel}
          </Pill>
        </dd>
        <dt>Agreed with player</dt>
        <dd>
          {report.ombudsmanAgreed === true ? (
            <Pill tone="lime">Yes, sided with the reporter</Pill>
          ) : report.ombudsmanAgreed === false ? (
            <Pill tone="red">No, upheld the fact</Pill>
          ) : (
            "Not recorded"
          )}
        </dd>
        <dt>Ombudsman verdict</dt>
        <dd>{displayOrMissing(report.ombudsmanVerdict)}</dd>
        <dt>Ombudsman ruling</dt>
        <dd style={{ color: "var(--ds-arena-color-text)" }}>
          {displayOrMissing(report.ombudsmanRuling)}
        </dd>
        <dt>Grounding citations</dt>
        <dd>
          <SourceList sources={report.ombudsmanSources} />
        </dd>
        <dt>Reporter</dt>
        <dd>{report.reporterUid || "anonymous"}</dd>
        <dt>Created</dt>
        <dd>{report.createdAt ?? "Not recorded"}</dd>
        <dt>Matched fact</dt>
        <dd>
          {entry.fact
            ? `${entry.fact.subject} / ${entry.fact.angle} (${entry.fact.id})`
            : "none found (AI-generated claim)"}
        </dd>
        {report.resolutionNote ? (
          <>
            <dt>Resolution</dt>
            <dd>{report.resolutionNote}</dd>
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
                placeholder="Optional resolution note..."
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
          </div>
          <ErrorNote error={mutation.error} />
        </>
      ) : null}

      {entry.duplicateFacts && entry.duplicateFacts.length > 0 && entry.fact ? (
        <div
          style={{
            marginTop: "var(--ds-arena-space-3)",
            padding: "var(--ds-arena-space-3)",
            background: "rgba(246, 195, 68, 0.05)",
            border: "1px solid rgba(246, 195, 68, 0.25)",
            borderRadius: "var(--ds-arena-radius-md)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "var(--ds-arena-space-2)",
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            <h4 style={{ margin: 0, color: "#f6c344", fontSize: "0.95em", fontWeight: 700 }}>
              Duplicate Fact Collisions ({entry.duplicateFacts.length + 1} facts)
            </h4>
            <span style={{ fontSize: "0.8em", color: "var(--ds-arena-color-text-muted)" }}>
              Compare versions below: pick one to keep active (applies any corrected number/note above); the other will be retired.
            </span>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: "var(--ds-arena-space-3)",
            }}
          >
            {/* Primary fact card */}
            <div
              style={{
                background: "var(--ds-arena-color-surface-elevated, rgba(255, 255, 255, 0.03))",
                padding: "var(--ds-arena-space-3)",
                borderRadius: "var(--ds-arena-radius-sm)",
                border: "1px solid var(--ds-arena-color-border)",
                display: "flex",
                flexDirection: "column",
                gap: "var(--ds-arena-space-2)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 700, fontSize: "0.85em", color: "#10b981" }}>
                  Reported Fact (A)
                </span>
                <Badge tone={statusTone(entry.fact.status)}>{entry.fact.status}</Badge>
              </div>
              <div style={{ fontSize: "0.85em", color: "var(--ds-arena-color-text-muted)" }}>
                ID: <code>{entry.fact.id}</code>
              </div>
              {entry.fact.quality_flags?.length ? (
                <div>
                  <strong style={{ fontSize: "0.85em" }}>Quality flags:</strong>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 2 }}>
                    {entry.fact.quality_flags.map((flag) => {
                      const isDup = flag === "duplicate_question" || flag === "conflicting_answer";
                      return (
                        <Badge key={flag} tone={isDup ? "amber" : "red"}>
                          {flag}
                        </Badge>
                      );
                    })}
                  </div>
                  {entry.fact.quality_flags.some((f) => f !== "duplicate_question" && f !== "conflicting_answer") ? (
                    <div style={{ fontSize: "0.8em", color: "#f87171", marginTop: 2 }}>
                      ⚠ Has other issue: {entry.fact.quality_flags.filter((f) => f !== "duplicate_question" && f !== "conflicting_answer").join(", ")}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div>
                <strong style={{ fontSize: "0.85em" }}>Subject / Angle:</strong>
                <div>{entry.fact.subject} &mdash; <em>{entry.fact.angle}</em></div>
              </div>
              <div>
                <strong style={{ fontSize: "0.85em" }}>Question:</strong>
                <div style={{ color: "var(--ds-arena-color-text)", fontWeight: 500 }}>
                  {entry.fact.question || entry.fact.claim_template}
                </div>
              </div>
              <div>
                <strong style={{ fontSize: "0.85em" }}>Claim template:</strong>
                <div style={{ fontSize: "0.85em", color: "var(--ds-arena-color-text-muted)" }}>
                  {entry.fact.claim_template}
                </div>
              </div>
              <div>
                <strong style={{ fontSize: "0.85em" }}>True Answer:</strong>{" "}
                <span style={{ fontSize: "1.1em", fontWeight: 700, color: "var(--ds-arena-color-text)" }}>
                  {entry.fact.true_number} {entry.fact.unit}
                </span>
              </div>
              {entry.fact.source_urls?.length ? (
                <div>
                  <strong style={{ fontSize: "0.85em" }}>Sources:</strong>
                  <SourceList sources={entry.fact.source_urls} />
                </div>
              ) : null}
              {pending ? (
                <div style={{ marginTop: "auto", paddingTop: "var(--ds-arena-space-2)" }}>
                  <Button
                    variant="primary"
                    disabled={mutation.isPending}
                    onClick={() => {
                      if (window.confirm(`Keep Fact A (${entry.fact!.id}) and retire the other duplicate(s)?`)) {
                        mutation.mutate({
                          action: "resolve_duplicate",
                          keepFactId: entry.fact!.id,
                          retireFactIds: entry.duplicateFacts.map((d) => d.id),
                          note: note.trim() || undefined,
                          correctedNumber: corrected ? Number(corrected) : undefined,
                        });
                      }
                    }}
                  >
                    Keep Fact A &amp; Retire Other(s)
                  </Button>
                </div>
              ) : null}
            </div>

            {/* Duplicate facts */}
            {entry.duplicateFacts.map((dupFact, idx) => (
              <div
                key={dupFact.id}
                style={{
                  background: "var(--ds-arena-color-surface-elevated, rgba(255, 255, 255, 0.03))",
                  padding: "var(--ds-arena-space-3)",
                  borderRadius: "var(--ds-arena-radius-sm)",
                  border: "1px solid var(--ds-arena-color-border)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--ds-arena-space-2)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 700, fontSize: "0.85em", color: "#f6c344" }}>
                    Duplicate Fact ({String.fromCharCode(66 + idx)})
                  </span>
                  <Badge tone={statusTone(dupFact.status)}>{dupFact.status}</Badge>
                </div>
                <div style={{ fontSize: "0.85em", color: "var(--ds-arena-color-text-muted)" }}>
                  ID: <code>{dupFact.id}</code>
                </div>
                {dupFact.quality_flags?.length ? (
                  <div>
                    <strong style={{ fontSize: "0.85em" }}>Quality flags:</strong>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 2 }}>
                      {dupFact.quality_flags.map((flag) => {
                        const isDup = flag === "duplicate_question" || flag === "conflicting_answer";
                        return (
                          <Badge key={flag} tone={isDup ? "amber" : "red"}>
                            {flag}
                          </Badge>
                        );
                      })}
                    </div>
                    {dupFact.quality_flags.some((f) => f !== "duplicate_question" && f !== "conflicting_answer") ? (
                      <div style={{ fontSize: "0.8em", color: "#f87171", marginTop: 2 }}>
                        ⚠ Has other issue: {dupFact.quality_flags.filter((f) => f !== "duplicate_question" && f !== "conflicting_answer").join(", ")}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div>
                  <strong style={{ fontSize: "0.85em" }}>Subject / Angle:</strong>
                  <div>{dupFact.subject} &mdash; <em>{dupFact.angle}</em></div>
                </div>
                <div>
                  <strong style={{ fontSize: "0.85em" }}>Question:</strong>
                  <div style={{ color: "var(--ds-arena-color-text)", fontWeight: 500 }}>
                    {dupFact.question || dupFact.claim_template}
                  </div>
                </div>
                <div>
                  <strong style={{ fontSize: "0.85em" }}>Claim template:</strong>
                  <div style={{ fontSize: "0.85em", color: "var(--ds-arena-color-text-muted)" }}>
                    {dupFact.claim_template}
                  </div>
                </div>
                <div>
                  <strong style={{ fontSize: "0.85em" }}>True Answer:</strong>{" "}
                  <span style={{ fontSize: "1.1em", fontWeight: 700, color: "var(--ds-arena-color-text)" }}>
                    {dupFact.true_number} {dupFact.unit}
                  </span>
                </div>
                {dupFact.source_urls?.length ? (
                  <div>
                    <strong style={{ fontSize: "0.85em" }}>Sources:</strong>
                    <SourceList sources={dupFact.source_urls} />
                  </div>
                ) : null}
                {pending ? (
                  <div style={{ marginTop: "auto", paddingTop: "var(--ds-arena-space-2)" }}>
                    <Button
                      variant="primary"
                      disabled={mutation.isPending}
                      onClick={() => {
                        if (window.confirm(`Keep Duplicate (${dupFact.id}) and retire Fact A (${entry.fact!.id})?`)) {
                          const otherRetires = [
                            entry.fact!.id,
                            ...entry.duplicateFacts.filter((d) => d.id !== dupFact.id).map((d) => d.id),
                          ];
                          mutation.mutate({
                            action: "resolve_duplicate",
                            keepFactId: dupFact.id,
                            retireFactIds: otherRetires,
                            note: note.trim() || undefined,
                            correctedNumber: corrected ? Number(corrected) : undefined,
                          });
                        }
                      }}
                    >
                      Keep Fact {String.fromCharCode(66 + idx)} &amp; Retire Other(s)
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          {pending ? (
            <div style={{ display: "flex", gap: "var(--ds-arena-space-2)", marginTop: "var(--ds-arena-space-3)", flexWrap: "wrap" }}>
              <Button
                variant="danger"
                disabled={mutation.isPending}
                onClick={() => {
                  if (window.confirm("Retire ALL duplicate facts involved in this collision?")) {
                    mutation.mutate({
                      action: "resolve_duplicate",
                      retireFactIds: [entry.fact!.id, ...entry.duplicateFacts.map((d) => d.id)],
                      note: note.trim() || "All duplicate facts retired via moderation",
                    });
                  }
                }}
              >
                Retire all duplicates
              </Button>
              <Button
                variant="ghost"
                disabled={mutation.isPending}
                onClick={() => {
                  if (window.confirm("Reject report and keep all facts active (not duplicates)?")) {
                    mutation.mutate({ action: "reject", note: note.trim() || "Not a duplicate - kept all active" });
                  }
                }}
              >
                Reject report (Keep all active)
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {pending ? (
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
                onClick={() => {
                  if (entry.duplicateFacts?.length) {
                    window.alert(
                      "This fact has duplicate conflicts. To fix the number and resolve the collision, use 'Keep Fact A' or 'Keep Fact B' above with your corrected number.",
                    );
                    return;
                  }
                  mutation.mutate("fix_number");
                }}
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
