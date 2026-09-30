import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Badge, Button, Card, CardLabel, CardTitle } from "@/index";
import { ErrorNote, PageHead, statusTone } from "@/admin/AdminShell";
import { LintFindings, type LintEvidence } from "@/admin/LintFindings";
import { actOnReport, fetchFact, fetchReports, flushReports } from "@/lib/admin/content.functions";
import { runReportCopilot } from "@/lib/admin/report-copilot.functions";
import { isDuplicateFlag, isNonDuplicateFlag } from "@/lib/admin/quality-flags";
import { QUANTITY_KINDS } from "../../../shared/fact-lifecycle-contract.gen";

const QUANTITY_KIND_OPTIONS = ["", ...QUANTITY_KINDS] as const;

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

type CopilotResult = Awaited<ReturnType<typeof runReportCopilot>>;

const COPILOT_VERDICTS: Record<CopilotResult["verdict"], { label: string; tone: "lime" | "red" | "amber" | "purple" | "neutral" }> = {
  uphold_fact: { label: "Uphold fact", tone: "lime" },
  fix_number: { label: "Fix number", tone: "amber" },
  edit_fact: { label: "Edit fact", tone: "purple" },
  retire_fact: { label: "Retire fact", tone: "red" },
  unclear: { label: "Unclear", tone: "neutral" },
};

function CopilotPanel({
  reportId,
  hasFact,
  onPrefill,
}: {
  reportId: string;
  hasFact: boolean;
  onPrefill: (review: CopilotResult) => void;
}) {
  const run = useServerFn(runReportCopilot);
  const mutation = useMutation({ mutationFn: () => run({ data: { reportId } }) });
  const review = mutation.data;
  const s = review?.suggested;
  const changes = s
    ? ([
        ["True number", s.true_number],
        ["Unit", s.unit],
        ["Question", s.question],
        ["Claim template", s.claim_template],
        ["Context", s.context],
      ] as const).filter(([, v]) => v !== undefined && v !== "")
    : [];

  return (
    <section
      aria-label="Copilot review"
      style={{
        marginTop: "var(--ds-arena-space-3)",
        padding: "var(--ds-arena-space-3)",
        border: "1px solid var(--ds-arena-color-border)",
        borderInlineStart: "3px solid var(--ds-arena-color-purple)",
        borderRadius: "var(--ds-arena-radius-sm)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--ds-arena-space-2)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
          <CardLabel>Copilot review</CardLabel>
          {review ? (
            <>
              <Badge tone={COPILOT_VERDICTS[review.verdict].tone}>{COPILOT_VERDICTS[review.verdict].label}</Badge>
              <Badge>{`${review.confidence} confidence`}</Badge>
            </>
          ) : null}
        </span>
        <Button variant="ghost" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          {mutation.isPending ? "Checking sources…" : review ? "Re-run" : "Run copilot"}
        </Button>
      </div>
      <ErrorNote error={mutation.error} />
      {review ? (
        <>
          <p style={{ margin: 0, color: "var(--ds-arena-color-text)" }}>{review.rationale}</p>
          {changes.length ? (
            <dl className="admin-kv">
              {changes.map(([label, value]) => (
                <>
                  <dt key={`${label}-t`}>Suggested {label.toLowerCase()}</dt>
                  <dd key={`${label}-d`}>{String(value)}</dd>
                </>
              ))}
            </dl>
          ) : null}
          <div>
            <strong style={{ fontSize: "0.85em" }}>Sources</strong>
            {review.sources.length ? (
              <ul style={{ margin: "4px 0 0", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
                {review.sources.map((src) => (
                  <li key={src.url} style={{ fontSize: "0.9em" }}>
                    <a href={src.url} target="_blank" rel="noreferrer">{src.title}</a>
                    {src.excerpts.map((ex, i) => (
                      <blockquote
                        key={i}
                        style={{
                          margin: "4px 0 0",
                          paddingInlineStart: 8,
                          borderInlineStart: "2px solid var(--ds-arena-color-border)",
                          color: "var(--ds-arena-color-text-muted)",
                        }}
                      >
                        “{ex}”
                      </blockquote>
                    ))}
                  </li>
                ))}
              </ul>
            ) : (
              <p style={{ margin: 0, color: "var(--ds-arena-color-text-muted)" }}>No sources returned — treat verdict as unverified.</p>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Button variant="daily" size="sm" onClick={() => onPrefill(review)}>
              Prefill Apply &amp; Resolve
            </Button>
            <span style={{ fontSize: "0.8em", color: "var(--ds-arena-color-text-muted)" }}>
              {hasFact
                ? "Fills the editor only. Review every field, then save."
                : "Fills the corrected number and note. Nothing is saved until you act."}
            </span>
          </div>
        </>
      ) : null}
    </section>
  );
}


function ReportCard({ entry }: { entry: Entry }) {
  const act = useServerFn(actOnReport);
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [corrected, setCorrected] = useState(
    entry.report.trueNumber === null ? "" : String(entry.report.trueNumber),
  );
  const [showEditor, setShowEditor] = useState(false);
  const [editForm, setEditForm] = useState({
    question: entry.fact?.question || entry.fact?.claim_template || "",
    claim_template: entry.fact?.claim_template || "",
    true_number:
      entry.fact?.true_number !== undefined && entry.fact?.true_number !== null
        ? String(entry.fact.true_number)
        : entry.report.trueNumber !== null && entry.report.trueNumber !== undefined
          ? String(entry.report.trueNumber)
          : "",
    unit: entry.fact?.unit || entry.report.unit || "",
    plausible_min: entry.fact?.plausible_min || "",
    plausible_max: entry.fact?.plausible_max || "",
    quantity_kind: entry.fact?.quantity_kind || "",
    context: entry.fact?.context || entry.report.explanation || "",
  });

  const mutation = useMutation({
    mutationFn: (
      params:
        | "retire_fact"
        | "fix_number"
        | "reject"
        | "resolve_only"
        | "add_to_bank"
        | "resolve_as_is"
        | {
            action:
              | "retire_fact"
              | "fix_number"
              | "reject"
              | "resolve_only"
              | "add_to_bank"
              | "resolve_duplicate"
              | "edit_fact"
              | "resolve_as_is";
            factId?: string;
            keepFactId?: string;
            retireFactId?: string;
            retireFactIds?: string[];
            factUpdates?: {
              question?: string;
              true_number?: number;
              unit?: string;
              plausible_min?: string;
              plausible_max?: string;
              quantity_kind?: string;
              context?: string;
              surprise_factor?: number;
              claim_template?: string;
            };
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
          correctedNumber:
            isObj && params.correctedNumber !== undefined
              ? params.correctedNumber
              : action === "fix_number" || action === "add_to_bank"
                ? (corrected ? Number(corrected) : undefined)
                : undefined,
          factUpdates: isObj ? params.factUpdates : undefined,
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reports"] });
      queryClient.invalidateQueries({ queryKey: ["facts"] });
    },
  });

  const pending = entry.report.status === "pending_review";
  const report = entry.report;
  const isDuplicate =
    entry.report.qualityFlags?.some(isDuplicateFlag) ||
    entry.report.reason?.toLowerCase().includes("duplicate_question") ||
    entry.report.reason?.toLowerCase().includes("conflicting_answer") ||
    Boolean(entry.fact?.quality_flags?.some(isDuplicateFlag));

  const [manualCandidateId, setManualCandidateId] = useState("");
  const [manualCandidate, setManualCandidate] = useState<NonNullable<Entry["fact"]> | null>(null);
  const [manualLoading, setManualLoading] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const fetchFactFn = useServerFn(fetchFact);

  const duplicateFactsList = [
    ...(entry.duplicateFacts || []),
    ...(manualCandidate && !entry.duplicateFacts?.some((d) => d.id === manualCandidate.id) ? [manualCandidate] : []),
  ];

  const chosenTopic = report.initialTopic || report.topic;
  const questionTopic = report.topic;
  const isFactLintReport = report.reportSource === "fact_lint";
  const lintFlags = [...new Set([...(report.qualityFlags ?? []), ...(entry.fact?.quality_flags ?? [])])];
  const lintEvidence: LintEvidence = {
    subject: entry.fact?.subject,
    question: entry.fact?.question,
    claim_template: entry.fact?.claim_template || (isFactLintReport ? report.claimStatement : undefined),
    unit: entry.fact?.unit || report.unit,
    true_number: entry.fact?.true_number ?? report.trueNumber,
    quantity_kind: entry.fact?.quantity_kind,
    plausible_min: entry.fact?.plausible_min,
    plausible_max: entry.fact?.plausible_max,
    derivation: entry.fact?.derivation,
    surprise_factor: entry.fact?.surprise_factor,
  };
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
        <dt>{isFactLintReport ? "Fact question" : "Exact question"}</dt>
        <dd style={{ fontWeight: 600, color: "var(--ds-arena-color-text)" }}>
          {displayOrMissing(isFactLintReport ? entry.fact?.question : report.claimStatement)}
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
        {!isFactLintReport ? (
          <>
            <dt>Dispute reason</dt>
            <dd>{REASON_LABELS[report.reason] ?? displayOrMissing(report.reason)}</dd>
          </>
        ) : null}
        {lintFlags.length ? (
          <>
            <dt>Fact Foundry findings</dt>
            <dd>
              <LintFindings flags={lintFlags} evidence={lintEvidence} />
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
          {entry.fact ? (
            <span style={{ display: "inline-flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span>{`${entry.fact.subject} / ${entry.fact.angle} (${entry.fact.id})`}</span>
              <a
                href={`/admin/facts?search=${entry.fact.id}`}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: "0.85em", color: "#10b981", textDecoration: "underline" }}
              >
                Open in Fact Bank ↗
              </a>
            </span>
          ) : (
            "none found (AI-generated claim)"
          )}
        </dd>
        {report.resolutionNote ? (
          <>
            <dt>Resolution</dt>
            <dd>{report.resolutionNote}</dd>
          </>
        ) : null}
      </dl>

      {pending ? (
        <CopilotPanel
          reportId={report.id}
          hasFact={Boolean(entry.fact)}
          onPrefill={(review) => {
            const s = review.suggested;
            if (s.true_number !== undefined) setCorrected(String(s.true_number));
            const autoNote = s.note || `Copilot: ${COPILOT_VERDICTS[review.verdict].label}. Human-reviewed.`;
            setNote(autoNote);
            if (entry.fact) {
              setEditForm((prev) => ({
                ...prev,
                true_number: s.true_number !== undefined ? String(s.true_number) : prev.true_number,
                unit: s.unit ?? prev.unit,
                question: s.question ?? prev.question,
                claim_template: s.claim_template ?? prev.claim_template,
                context: s.context ?? prev.context,
              }));
              setShowEditor(true);
            }
          }}
        />
      ) : null}

      {pending && duplicateFactsList.length === 0 && entry.fact?.quality_flags?.some(isNonDuplicateFlag) ? (
        <div
          style={{
            marginTop: "var(--ds-arena-space-3)",
            padding: "var(--ds-arena-space-2) var(--ds-arena-space-3)",
            background: "rgba(168, 85, 247, 0.08)",
            border: "1px solid rgba(168, 85, 247, 0.3)",
            borderRadius: "var(--ds-arena-radius-sm)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Badge tone="purple">Stage 2: Fact Moderation</Badge>
            <span style={{ fontSize: "0.85em", color: "var(--ds-arena-color-text-muted)" }}>
              Review remaining quality flags ({entry.fact.quality_flags.filter(isNonDuplicateFlag).join(", ")}): edit fields below, accept as-is, or retire if invalid.
            </span>
          </div>
          {!showEditor ? (
            <Button variant="ghost" onClick={() => setShowEditor(true)}>
              ✏️ Edit Fact Details
            </Button>
          ) : null}
        </div>
      ) : null}

      {pending && duplicateFactsList.length === 0 && !showEditor ? (
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

      {pending && duplicateFactsList.length === 0 && showEditor && entry.fact ? (
        <div
          style={{
            marginTop: "var(--ds-arena-space-3)",
            padding: "var(--ds-arena-space-3)",
            background: "var(--ds-arena-color-surface-elevated, rgba(255, 255, 255, 0.03))",
            border: "1px solid rgba(168, 85, 247, 0.4)",
            borderRadius: "var(--ds-arena-radius-md)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--ds-arena-space-3)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontWeight: 700, fontSize: "0.95em", color: "#c084fc" }}>
                ✏️ Edit Fact Details &amp; Resolve
              </span>
              <span style={{ fontSize: "0.8em", color: "var(--ds-arena-color-text-muted)" }}>
                ID: <code>{entry.fact.id}</code>
              </span>
            </div>
            <Button variant="ghost" onClick={() => setShowEditor(false)}>
              ✕ Close Editor
            </Button>
          </div>

          <div className="admin-grid">
            <label className="admin-field" style={{ gridColumn: "1 / -1" }}>
              <span>Question / Prompt</span>
              <input
                className="admin-input"
                value={editForm.question}
                onChange={(e) => setEditForm({ ...editForm, question: e.target.value })}
              />
            </label>
            <label className="admin-field" style={{ gridColumn: "1 / -1" }}>
              <span>Claim template (use {"{n}"} for the answer)</span>
              <textarea
                className="admin-textarea"
                rows={2}
                value={editForm.claim_template}
                onChange={(e) => setEditForm({ ...editForm, claim_template: e.target.value })}
              />
            </label>
            <label className="admin-field">
              <span>True number</span>
              <input
                className="admin-input"
                type="number"
                step="any"
                value={editForm.true_number}
                onChange={(e) => setEditForm({ ...editForm, true_number: e.target.value })}
              />
            </label>
            <label className="admin-field">
              <span>Unit (e.g. awards, meters)</span>
              <input
                className="admin-input"
                value={editForm.unit}
                onChange={(e) => setEditForm({ ...editForm, unit: e.target.value })}
              />
            </label>
            <label className="admin-field">
              <span>Quantity kind</span>
              <select
                className="admin-select"
                value={editForm.quantity_kind}
                onChange={(e) => setEditForm({ ...editForm, quantity_kind: e.target.value })}
              >
                {QUANTITY_KIND_OPTIONS.map((kind) => (
                  <option key={kind || "auto"} value={kind}>
                    {kind === "" ? "auto (classify from unit)" : kind}
                  </option>
                ))}
              </select>
            </label>
            <label className="admin-field">
              <span>Plausible min (Bounds hint)</span>
              <input
                className="admin-input"
                placeholder="e.g. 0"
                value={editForm.plausible_min}
                onChange={(e) => setEditForm({ ...editForm, plausible_min: e.target.value })}
              />
            </label>
            <label className="admin-field">
              <span>Plausible max (Bounds hint)</span>
              <input
                className="admin-input"
                placeholder="e.g. 50"
                value={editForm.plausible_max}
                onChange={(e) => setEditForm({ ...editForm, plausible_max: e.target.value })}
              />
            </label>
            <label className="admin-field">
              <span>Angle (immutable identity)</span>
              <input
                id="moderation-fact-identity-angle"
                className="admin-input"
                value={entry.fact.angle}
                readOnly
                aria-readonly="true"
                aria-describedby="moderation-fact-identity-guidance"
              />
            </label>
            <label className="admin-field" style={{ gridColumn: "1 / -1" }}>
              <span>Reveal explanation (Context)</span>
              <textarea
                className="admin-textarea"
                rows={2}
                value={editForm.context}
                onChange={(e) => setEditForm({ ...editForm, context: e.target.value })}
              />
            </label>
            <label className="admin-field" style={{ gridColumn: "1 / -1" }}>
              <span>Resolution note</span>
              <input
                className="admin-input"
                placeholder="Optional resolution note explaining the fix..."
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
          </div>

          <div
            id="moderation-fact-identity-guidance"
            role="note"
            style={{
              padding: "var(--ds-arena-space-3)",
              border: "1px solid var(--ds-arena-color-border)",
              borderInlineStart: "3px solid var(--ds-arena-color-amber)",
              borderRadius: "var(--ds-arena-radius-sm)",
              color: "var(--ds-arena-color-text-muted)",
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            <strong style={{ color: "var(--ds-arena-color-text)" }}>
              Subject and angle are immutable identity fields.
            </strong>{" "}
            If either needs correction, create a corrected replacement in the Fact Bank; that retires the original and sends the replacement to pending Foundry admission.{" "}
            <a href={`/admin/facts?search=${encodeURIComponent(entry.fact.id)}`} target="_blank" rel="noreferrer">
              Open Fact Bank ↗
            </a>
          </div>

          <div style={{ display: "flex", gap: "var(--ds-arena-space-2)", alignItems: "center", flexWrap: "wrap" }}>
            <Button
              variant="primary"
              disabled={mutation.isPending}
              onClick={() => {
                if (!window.confirm("Save changes to this fact and resolve the report?")) return;
                mutation.mutate({
                  action: "edit_fact",
                  factId: entry.fact!.id,
                  factUpdates: {
                    question: editForm.question.trim() || undefined,
                    claim_template: editForm.claim_template.trim() || undefined,
                    true_number: editForm.true_number ? Number(editForm.true_number) : undefined,
                    unit: editForm.unit.trim() || undefined,
                    plausible_min: editForm.plausible_min.trim() || undefined,
                    plausible_max: editForm.plausible_max.trim() || undefined,
                    quantity_kind: editForm.quantity_kind || undefined,
                    context: editForm.context.trim() || undefined,
                  },
                  note: note.trim() || undefined,
                });
              }}
            >
              Save Fact &amp; Resolve Report
            </Button>
            <Button
              variant="ghost"
              disabled={mutation.isPending}
              onClick={() => setShowEditor(false)}
            >
              Cancel
            </Button>
          </div>
          <ErrorNote error={mutation.error} />
        </div>
      ) : null}

      {duplicateFactsList.length > 0 && entry.fact ? (
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
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Badge tone="amber">
                {entry.fact?.quality_flags?.some(isNonDuplicateFlag)
                  ? "Stage 1 of 2: Duplicate Collision"
                  : "Duplicate Collision"}
              </Badge>
              <h4 style={{ margin: 0, color: "#f6c344", fontSize: "0.95em", fontWeight: 700 }}>
                {duplicateFactsList.length + 1} Conflicting Facts
              </h4>
            </div>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <span style={{ fontSize: "0.8em", color: "var(--ds-arena-color-text-muted)" }}>
                {entry.fact?.quality_flags?.some(isNonDuplicateFlag)
                  ? "Step 1 of 2: Pick which fact to keep active. Secondary quality flags on the kept fact will be reviewed in Step 2."
                  : "Compare versions below: pick one to keep active; the other will be retired."}
              </span>
              {manualCandidate ? (
                <button
                  type="button"
                  style={{
                    background: "none",
                    border: "none",
                    color: "#f87171",
                    fontSize: "0.8em",
                    cursor: "pointer",
                    textDecoration: "underline",
                  }}
                  onClick={() => {
                    setManualCandidate(null);
                    setManualCandidateId("");
                  }}
                >
                  Remove manual ({manualCandidate.id})
                </button>
              ) : null}
            </div>
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
                      const isDup = isDuplicateFlag(flag);
                      return (
                        <Badge key={flag} tone={isDup ? "amber" : "red"}>
                          {flag}
                        </Badge>
                      );
                    })}
                  </div>
                  {entry.fact.quality_flags.some(isNonDuplicateFlag) ? (
                    <div style={{ fontSize: "0.8em", color: "#f87171", marginTop: 2 }}>
                      ⚠ Has other issue: {entry.fact.quality_flags.filter(isNonDuplicateFlag).join(", ")}
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
                      const otherLabel = duplicateFactsList.length === 1 ? "Fact B" : "other duplicate(s)";
                      if (window.confirm(`Keep Fact A (${entry.fact!.id}) and retire ${otherLabel}?`)) {
                        mutation.mutate({
                          action: "resolve_duplicate",
                          keepFactId: entry.fact!.id,
                          retireFactIds: duplicateFactsList.map((d) => d.id),
                          note: note.trim() || undefined,
                        });
                      }
                    }}
                  >
                    Keep Fact A &amp; Retire {duplicateFactsList.length === 1 ? "Fact B" : "Other(s)"}
                  </Button>
                </div>
              ) : null}
            </div>

            {/* Duplicate facts */}
            {duplicateFactsList.map((dupFact, idx) => (
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
                        const isDup = isDuplicateFlag(flag);
                        return (
                          <Badge key={flag} tone={isDup ? "amber" : "red"}>
                            {flag}
                          </Badge>
                        );
                      })}
                    </div>
                    {dupFact.quality_flags.some(isNonDuplicateFlag) ? (
                      <div style={{ fontSize: "0.8em", color: "#f87171", marginTop: 2 }}>
                        ⚠ Has other issue: {dupFact.quality_flags.filter(isNonDuplicateFlag).join(", ")}
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
                        const targetLetter = String.fromCharCode(66 + idx);
                        const otherLabel =
                          duplicateFactsList.length === 1
                            ? "Fact A"
                            : "Fact A and other duplicates";
                        if (window.confirm(`Keep Duplicate Fact ${targetLetter} (${dupFact.id}) and retire ${otherLabel}?`)) {
                          const otherRetires = [
                            entry.fact!.id,
                            ...duplicateFactsList.filter((d) => d.id !== dupFact.id).map((d) => d.id),
                          ];
                          mutation.mutate({
                            action: "resolve_duplicate",
                            keepFactId: dupFact.id,
                            retireFactIds: otherRetires,
                            note: note.trim() || undefined,
                          });
                        }
                      }}
                    >
                      Keep Fact {String.fromCharCode(66 + idx)} &amp; Retire {duplicateFactsList.length === 1 ? "Fact A" : "Other(s)"}
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          {pending ? (
            <div
              style={{
                marginTop: "var(--ds-arena-space-3)",
                paddingTop: "var(--ds-arena-space-3)",
                borderTop: "1px dashed rgba(246, 195, 68, 0.2)",
                display: "flex",
                flexDirection: "column",
                gap: "var(--ds-arena-space-2)",
              }}
            >
              <div style={{ display: "flex", gap: "var(--ds-arena-space-2)", alignItems: "center", flexWrap: "wrap" }}>
                <input
                  className="admin-input"
                  style={{ flex: "1 1 240px", fontSize: "0.85em" }}
                  placeholder="Optional duplicate resolution note..."
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <Button
                  variant="danger"
                  disabled={mutation.isPending}
                  onClick={() => {
                    if (window.confirm("Retire ALL duplicate facts involved in this collision?")) {
                      mutation.mutate({
                        action: "resolve_duplicate",
                        retireFactIds: [entry.fact!.id, ...duplicateFactsList.map((d) => d.id)],
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
              <ErrorNote error={mutation.error} />
            </div>
          ) : null}
        </div>
      ) : isDuplicate && entry.fact && pending ? (
        <div
          style={{
            marginTop: "var(--ds-arena-space-3)",
            padding: "var(--ds-arena-space-3)",
            background: "rgba(246, 195, 68, 0.05)",
            border: "1px dashed rgba(246, 195, 68, 0.35)",
            borderRadius: "var(--ds-arena-radius-md)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--ds-arena-space-2)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: "#f6c344", fontWeight: 600, fontSize: "0.9em" }}>
              ⚠ Flagged as duplicate/conflicting, but no counterpart candidate was automatically matched.
            </span>
          </div>
          <p style={{ margin: 0, fontSize: "0.85em", color: "var(--ds-arena-color-text-muted)" }}>
            If you know the conflicting fact ID, paste it below to load and compare them side-by-side:
          </p>
          <div style={{ display: "flex", gap: "var(--ds-arena-space-2)", alignItems: "center", flexWrap: "wrap" }}>
            <input
              className="admin-input"
              style={{ maxWidth: 300, fontSize: "0.85em" }}
              placeholder="Candidate Fact ID (e.g. grammys_stevie_...)"
              value={manualCandidateId}
              onChange={(e) => {
                setManualCandidateId(e.target.value);
                setManualError(null);
              }}
            />
            <Button
              variant="ghost"
              disabled={!manualCandidateId.trim() || manualLoading}
              onClick={async () => {
                const id = manualCandidateId.trim();
                if (!id) return;
                setManualLoading(true);
                setManualError(null);
                try {
                  const res = await fetchFactFn({ data: { factId: id } });
                  if (res) {
                    setManualCandidate(res as NonNullable<Entry["fact"]>);
                  } else {
                    setManualError(`Fact "${id}" not found.`);
                  }
                } catch (err) {
                  setManualError(err instanceof Error ? err.message : "Failed to load fact.");
                } finally {
                  setManualLoading(false);
                }
              }}
            >
              {manualLoading ? "Searching..." : "Load Fact to Compare"}
            </Button>
            {manualError ? (
              <span style={{ color: "#f87171", fontSize: "0.85em" }}>{manualError}</span>
            ) : null}
          </div>
        </div>
      ) : null}

      {pending && duplicateFactsList.length === 0 && !showEditor ? (
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
                  mutation.mutate("fix_number");
                }}
              >
                Accept &amp; fix number
              </Button>
              <Button
                variant="ghost"
                disabled={mutation.isPending}
                onClick={() => setShowEditor(true)}
              >
                ✏️ Edit Fact Details
              </Button>
              {entry.fact.quality_flags?.length || entry.report.qualityFlags?.length ? (
                <Button
                  variant="ghost"
                  style={{ color: "#10b981", borderColor: "rgba(16, 185, 129, 0.4)" }}
                  disabled={mutation.isPending}
                  onClick={() => {
                    if (window.confirm("Accept this fact as-is and clear its quality flags?")) {
                      mutation.mutate({
                        action: "resolve_as_is",
                        factId: entry.fact!.id,
                        note: note.trim() || "Accepted fact as-is via moderation",
                      });
                    }
                  }}
                >
                  Accept As-Is (Clear Flags)
                </Button>
              ) : null}
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
  const queryClient = useQueryClient();
  const list = useServerFn(fetchReports);
  const flush = useServerFn(flushReports);
  const [status, setStatus] = useState("pending_review");
  const [flushMessage, setFlushMessage] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["reports", status],
    queryFn: () => list({ data: { status: status || undefined } }),
    retry: false,
  });

  const flushMutation = useMutation({
    mutationFn: () => flush({ data: {} }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["reports"] });
      setFlushMessage(`Flushed ${result.flushed} stale report(s) (checked ${result.totalChecked}).`);
    },
  });

  return (
    <>
      <PageHead
        title="Moderation inbox"
        description="Player-reported trivia disputes, matched back to the fact bank."
        actions={
          <div style={{ display: "flex", gap: "var(--ds-arena-space-2)", alignItems: "flex-end", flexWrap: "wrap" }}>
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
            <Button
              variant="ghost"
              disabled={flushMutation.isPending}
              onClick={() => {
                if (window.confirm("Sweep and auto-resolve reports for facts that are already clean/active, retired, or deleted?")) {
                  flushMutation.mutate();
                }
              }}
            >
              {flushMutation.isPending ? "Flushing…" : "Flush Stale Reports"}
            </Button>
          </div>
        }
      />
      {flushMessage ? (
        <div
          style={{
            padding: "8px 12px",
            background: "rgba(16, 185, 129, 0.1)",
            border: "1px solid #10b981",
            borderRadius: 6,
            color: "#10b981",
            fontSize: "0.85em",
            marginBottom: 12,
          }}
        >
          {flushMessage}
        </div>
      ) : null}
      <ErrorNote error={flushMutation.error || query.error} />
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
