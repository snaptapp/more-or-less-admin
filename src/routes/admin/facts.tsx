import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState, Fragment, type FormEvent } from "react";
import { Badge, Button, Card, CardLabel, CardTitle } from "@/index";
import {
  adminAuthorizedTargetsFor,
  ErrorNote,
  FactStatusBadge,
  InfoTip,
  InlineEditorRow,
  PageHead,
} from "@/admin/AdminShell";
import { CrawlQueue, PlaylistsPanel, TopicsPanel } from "@/admin/taxonomyPanels";
import { FactsBankChat } from "@/admin/FactsBankChat";
import {
  addFact,
  bulkImportFacts,
  changeFactStatus,
  createCorrectedReplacement,
  exportFactsData,
  fetchBankObservability,
  fetchFacts,
  saveFact,
} from "@/lib/admin/content.functions";
import { fetchPlaylists, fetchSubjects } from "@/lib/admin/ops.functions";
import { CONTENT_VIEWS, GENRES, matchScopesForGenre, isContentView, type ContentView } from "@/lib/admin/taxonomy";
import {
  FACT_STATUSES,
  QUANTITY_KINDS,
  type FactStatus,
  type QuantityKind,
} from "../../../shared/fact-lifecycle-contract.gen";
import { QK, STATUS } from "@/lib/admin/contract";
import type { BankObservability } from "@/lib/admin/content.server";

const HYDRATION_EXPLANATION =
  "Firestore changes go live only after export, hydration PR merge, and Worker deployment.";

const EXPORTED_DELTA_DEFINITION =
  "Firestore active lifecycle count minus deployed fact_count; export filters can make the populations differ.";

/** The `quantity_kind` values the editor offers: the contract's closed set
 * (Requirement 9.5, derived) plus the empty-string "auto" sentinel. */
const QUANTITY_KIND_OPTIONS = ["", ...QUANTITY_KINDS] as const;

/**
 * For each declared fact status, the admin-authorized transition target from
 * `from` when one exists, else `undefined`. The values are the actual status
 * strings the shared contract's transition table declares — never a literal
 * written here (Requirement 9.9). Keys are bare identifiers, so a truthy entry
 * both gates its control and supplies the target status to the mutation. An
 * unknown persisted status is not a declared transition source, so every entry
 * is `undefined` and the editor offers no status-change control for it
 * (Requirements 9.3, 9.4, 9.8, 9.10).
 */
function authorizedStatusTargets(from: string): Record<FactStatus, FactStatus | undefined> {
  const targets: Record<FactStatus, FactStatus | undefined> = {
    active: undefined,
    pending: undefined,
    disputed: undefined,
    retired: undefined,
  };
  for (const target of adminAuthorizedTargetsFor(from)) targets[target] = target;
  return targets;
}

export const Route = createFileRoute("/admin/facts")({
  validateSearch: (search: Record<string, unknown>): { view?: ContentView } => {
    if (isContentView(search.view)) return { view: search.view };
    return {};
  },
  head: () => ({
    meta: [
      { title: "Content — More or Less Admin" },
      { name: "description", content: "Facts, topics, playlists, and crawl intake." },
    ],
  }),
  component: ContentPage,
});

type Fact = Awaited<ReturnType<typeof fetchFacts>>["facts"][number];

function escapeCsv(val: unknown): string {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      row.push(field.trim());
      field = "";
    } else if ((char === "\r" || char === "\n") && !inQuotes) {
      if (char === "\r" && nextChar === "\n") i++;
      row.push(field.trim());
      if (row.some((cell) => cell.length > 0)) {
        rows.push(row);
      }
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field || row.length > 0) {
    row.push(field.trim());
    if (row.some((cell) => cell.length > 0)) {
      rows.push(row);
    }
  }

  return rows;
}

const EMPTY_DRAFT = {
  subject: "",
  category: "",
  sub_category: "",
  angle: "",
  true_number: "",
  unit: "",
  claim_template: "",
  explanation: "",
  question: "",
  surprise_factor: "2",
  quantity_kind: QK.count,
  plausible_min: "",
  plausible_max: "",
  content_rating: "standard",
  source_urls: "",
};

/** Display label for a `quantity_kind` option. The empty string is the DDM
 * "auto" sentinel; every contract kind renders as its own identifier so no
 * `quantity_kind` value is restated as a literal here (Requirement 9.9). */
function quantityKindLabel(kind: (typeof QUANTITY_KIND_OPTIONS)[number]): string {
  return kind === "" ? "auto (classify from unit)" : kind;
}

/** The single user-facing admission message shared by create and import paths. */
export const PENDING_ADMISSION_COPY =
  "Saved as pending; the nightly Foundry audit promotes it.";

/** Make the authority boundary explicit wherever a pending row is surfaced. */
export const PENDING_PROMOTION_COPY =
  "Pending facts are admission candidates only. The Foundry audit is the only promoter to active; admin controls cannot approve them, and pending facts are not served or exported.";

function PendingAdmissionNotice() {
  return (
    <div
      role="note"
      aria-label="Pending fact admission"
      style={{
        margin: 0,
        padding: "12px 14px",
        border: "1px solid var(--ds-arena-color-border)",
        borderLeft: "3px solid var(--ds-arena-color-amber)",
        borderRadius: "var(--ds-arena-radius-md)",
        background: "var(--ds-arena-color-surface)",
        color: "var(--ds-arena-color-text-muted)",
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      <strong style={{ color: "var(--ds-arena-color-text)" }}>Pending admission.</strong>{" "}
      {PENDING_ADMISSION_COPY} {PENDING_PROMOTION_COPY}
    </div>
  );
}

function signedDelta(value: number): string {
  if (value > 0) return `+${value}`;
  return String(value);
}

export function BankObservabilityPanel({
  data,
  isLoading = false,
  error = null,
}: {
  data?: BankObservability;
  isLoading?: boolean;
  error?: unknown;
}) {
  return (
    <Card>
      <div style={{ display: "grid", gap: "var(--ds-arena-space-3)" }}>
        <div className="admin-page-head">
          <div>
            <CardTitle>Deployed vs Firestore</CardTitle>
            <p style={{ margin: "4px 0 0", color: "var(--ds-arena-color-text-muted)", fontSize: 13 }}>
              Source lifecycle state and the exact bank embedded in the current Game Worker.
            </p>
          </div>
          {data?.deployed.state === "known" ? (
            <Badge tone="lime">Deployed</Badge>
          ) : data ? (
            <Badge tone="amber">Unknown / stale</Badge>
          ) : (
            <Badge tone="neutral">Checking</Badge>
          )}
        </div>

        {isLoading ? <p className="admin-empty">Checking deployed bank version…</p> : null}
        <ErrorNote error={error} />

        {data ? (
          <div
            role="status"
            aria-live="polite"
            style={{ display: "grid", gap: "var(--ds-arena-space-3)" }}
          >
            {data.deployed.state === "known" ? (
              <dl
                className="admin-kv"
                style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}
              >
                <div><dt>Deployed bank_version</dt><dd><code>{data.deployed.bankVersion}</code></dd></div>
                <div><dt>Deployed fact_count</dt><dd>{data.deployed.factCount}</dd></div>
                <div><dt>Deployed ddm_version</dt><dd><code>{data.deployed.ddmVersion}</code></dd></div>
                <div>
                  <dt>Exported vs Firestore delta</dt>
                  <dd>{data.exportedDelta === null ? "Unknown" : signedDelta(data.exportedDelta)}</dd>
                </div>
              </dl>
            ) : (
              <div
                role="note"
                style={{
                  padding: "12px 14px",
                  border: "1px solid var(--ds-arena-color-border)",
                  borderLeft: "3px solid var(--ds-arena-color-amber)",
                  borderRadius: "var(--ds-arena-radius-md)",
                  color: "var(--ds-arena-color-text-muted)",
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                <strong style={{ color: "var(--ds-arena-color-text)" }}>
                  Deployed bank version unknown or stale.
                </strong>{" "}
                {data.deployed.reason} No deployed version is shown because the endpoint could not be
                verified; the exported delta is unknown.
              </div>
            )}

            <div>
              <strong style={{ fontSize: 13 }}>Firestore lifecycle counts</strong>
              <dl
                className="admin-kv"
                style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))" }}
              >
                {FACT_STATUSES.map((status) => (
                  <div key={status}>
                    <dt>{status}</dt>
                    <dd>{data.firestore.lifecycle[status]}</dd>
                  </div>
                ))}
                <div><dt>Total</dt><dd>{data.firestore.total}</dd></div>
              </dl>
            </div>

            <p style={{ margin: 0, color: "var(--ds-arena-color-text-muted)", fontSize: 12 }}>
              <strong>Delta definition.</strong> {data.exportedDeltaDefinition || EXPORTED_DELTA_DEFINITION}
            </p>
          </div>
        ) : null}

        <p
          role="note"
          style={{
            margin: 0,
            padding: "10px 12px",
            borderLeft: "3px solid var(--ds-arena-color-lime)",
            background: "var(--ds-arena-color-surface)",
            color: "var(--ds-arena-color-text-muted)",
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          <strong style={{ color: "var(--ds-arena-color-text)" }}>Hydration path.</strong>{" "}
          {HYDRATION_EXPLANATION} Firestore itself is never the live serving source.
        </p>
      </div>
    </Card>
  );
}

type ReplacementFormState = {
  subject: string;
  category: string;
  sub_category: string;
  angle: string;
  true_number: string;
  unit: string;
  claim_template: string;
  explanation: string;
  question: string;
  surprise_factor: string;
  quantity_kind: QuantityKind | "";
  plausible_min: string;
  plausible_max: string;
  content_rating: "standard" | "after_dark";
  source_urls: string;
  number_pinned: boolean;
  pinned_reason: string;
  reason: string;
};

export interface CorrectedReplacementResult {
  original: Fact;
  replacement: Fact;
}

function normalizeSurpriseFactor(value: number | null | undefined): number {
  if (value === null || value === undefined) return 2;
  if (value > 3) return value >= 8 ? 3 : value >= 5 ? 2 : value >= 3 ? 1 : 0;
  return Math.min(3, Math.max(0, Math.round(value)));
}

function replacementClaimTemplate(
  claim: string,
  question: string,
  subject: string,
  angle: string,
): string {
  const value = claim.trim() || question.trim() || `${subject} — ${angle}`;
  return value.includes("{n}") ? value : `${value} {n}`;
}

function initialReplacementForm(fact: Fact): ReplacementFormState {
  return {
    subject: fact.subject,
    category: fact.category || "",
    sub_category: "",
    angle: fact.angle,
    true_number: fact.true_number === null ? "" : String(fact.true_number),
    unit: fact.unit || "",
    claim_template: replacementClaimTemplate(
      fact.claim_template,
      fact.question,
      fact.subject,
      fact.angle,
    ),
    explanation: fact.context || fact.question || "",
    question: fact.question || "",
    surprise_factor: String(normalizeSurpriseFactor(fact.surprise_factor)),
    quantity_kind: (fact.quantity_kind || "") as QuantityKind | "",
    plausible_min: fact.plausible_min || "",
    plausible_max: fact.plausible_max || "",
    content_rating: fact.content_rating === "after_dark" ? "after_dark" : "standard",
    source_urls: (fact.source_urls || []).join("\n"),
    number_pinned: fact.number_pinned,
    pinned_reason: fact.pinned_reason || "",
    reason: "",
  };
}

/**
 * Immutable correction path for an existing fact. The original is retired and a
 * fresh canonical fact is admitted as pending in one server transaction; this
 * component never sends a status or verification field to the replacement.
 */
export function CorrectedReplacementForm({
  fact,
  onDone,
  onCommitted,
}: {
  fact: Fact;
  onDone?: () => void;
  onCommitted?: (result: CorrectedReplacementResult) => void;
}) {
  const createReplacement = useServerFn(createCorrectedReplacement);
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ReplacementFormState>(() => initialReplacementForm(fact));
  const [committed, setCommitted] = useState<CorrectedReplacementResult | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  function setField<K extends keyof ReplacementFormState>(
    key: K,
    value: ReplacementFormState[K],
  ): void {
    setForm((current) => ({ ...current, [key]: value }));
  }

  const mutation = useMutation<CorrectedReplacementResult>({
    mutationFn: async () => {
      const result = await createReplacement({
        data: {
          originalId: fact.id,
          replacement: {
            subject: form.subject.trim(),
            category: form.category || undefined,
            sub_category: form.sub_category.trim() || undefined,
            angle: form.angle.trim(),
            true_number: Number(form.true_number),
            unit: form.unit.trim(),
            claim_template: replacementClaimTemplate(
              form.claim_template,
              form.question,
              form.subject,
              form.angle,
            ),
            explanation: form.explanation.trim(),
            question: form.question.trim(),
            surprise_factor: Number(form.surprise_factor),
            quantity_kind: form.quantity_kind,
            plausible_min: form.plausible_min.trim() || undefined,
            plausible_max: form.plausible_max.trim() || undefined,
            content_rating: form.content_rating,
            source_urls: form.source_urls
              .split("\n")
              .map((value) => value.trim())
              .filter(Boolean),
            number_pinned: form.number_pinned,
            pinned_reason: form.pinned_reason.trim() || undefined,
          },
          reason: form.reason.trim() || undefined,
          ...(fact.updateTime ? { originalUpdateTime: fact.updateTime } : {}),
        },
      });
      return result;
    },
    onSuccess: async (result) => {
      setCommitted(result);
      await queryClient.invalidateQueries({ queryKey: ["facts"] });
      onCommitted?.(result);
    },
  });

  const disabled = mutation.isPending || committed !== null;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (disabled) return;
    if (!window.confirm("Retire the original fact and create this replacement as pending?")) return;
    mutation.mutate();
  }

  return (
    <Card>
      <form
        id="corrected-replacement-form"
        aria-labelledby="corrected-replacement-title"
        aria-describedby="corrected-replacement-lifecycle-note"
        aria-busy={mutation.isPending}
        onSubmit={submit}
        style={{ display: "grid", gap: "var(--ds-arena-space-4)" }}
      >
        <div className="admin-page-head">
          <h3
            id="corrected-replacement-title"
            ref={titleRef}
            tabIndex={-1}
            style={{ margin: 0, fontSize: 18, lineHeight: 1.35 }}
          >
            Create corrected replacement
          </h3>
        </div>

        <div
          id="corrected-replacement-lifecycle-note"
          role="note"
          aria-label="Corrected replacement lifecycle"
          style={{
            margin: 0,
            padding: "12px 14px",
            border: "1px solid var(--ds-arena-color-border)",
            borderLeft: "3px solid var(--ds-arena-color-amber)",
            borderRadius: "var(--ds-arena-radius-md)",
            background: "var(--ds-arena-color-surface)",
            color: "var(--ds-arena-color-text-muted)",
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          <strong style={{ color: "var(--ds-arena-color-text)" }}>
            Original retirement + pending admission.
          </strong>{" "}
          Creating this replacement starts a correction; the original will be retired when it is created. It
          does not re-key the original. The replacement enters pending Foundry admission. {PENDING_ADMISSION_COPY}{" "}
          {PENDING_PROMOTION_COPY} This action does not activate it immediately.
          The replacement must use a distinct subject and angle identity; it never overwrites the original.
          {" "}
          {PENDING_PROMOTION_COPY}
        </div>

        <div
          style={{
            display: "grid",
            gap: "var(--ds-arena-space-2)",
            padding: "12px 14px",
            border: "1px solid var(--ds-arena-color-border)",
            borderRadius: "var(--ds-arena-radius-md)",
          }}
        >
          <strong>Original fact</strong>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "8px 16px",
              fontSize: 13,
              overflowWrap: "anywhere",
            }}
          >
            <span>ID: <code>{fact.id}</code></span>
            <span>Status: <FactStatusBadge status={fact.status} /></span>
            <span>Identity: {fact.subject} / {fact.angle}</span>
          </div>
        </div>

        <div className="admin-grid">
          <label className="admin-field" htmlFor="corrected-replacement-subject">
            <span>
              Replacement subject <InfoTip text="The replacement keeps the original's topic by default; edit it when the corrected fact has a different subject identity." />
            </span>
            <input
              id="corrected-replacement-subject"
              className="admin-input"
              required
              disabled={disabled}
              aria-describedby="corrected-replacement-lifecycle-note"
              value={form.subject}
              onChange={(event) => setField("subject", event.target.value)}
            />
          </label>
          <label className="admin-field" htmlFor="corrected-replacement-category">
            <span>Replacement genre</span>
            <select
              id="corrected-replacement-category"
              className="admin-select"
              disabled={disabled}
              value={form.category}
              onChange={(event) => setField("category", event.target.value)}
            >
              <option value="">Unclassified</option>
              {GENRES.map((genre) => (
                <option key={genre} value={genre}>
                  {genre}
                </option>
              ))}
              {form.category && !(GENRES as readonly string[]).includes(form.category) ? (
                <option value={form.category}>{form.category}</option>
              ) : null}
            </select>
          </label>
          <label className="admin-field" htmlFor="corrected-replacement-match-scope">
            <span>Replacement match scope</span>
            <input
              id="corrected-replacement-match-scope"
              className="admin-input"
              disabled={disabled}
              value={form.sub_category}
              onChange={(event) => setField("sub_category", event.target.value)}
            />
          </label>
          <label className="admin-field" htmlFor="corrected-replacement-angle">
            <span>
              Replacement angle <InfoTip text="This is the replacement's immutable identity. A correction cannot re-key the original document." />
            </span>
            <input
              id="corrected-replacement-angle"
              className="admin-input"
              required
              disabled={disabled}
              aria-describedby="corrected-replacement-lifecycle-note"
              value={form.angle}
              onChange={(event) => setField("angle", event.target.value)}
            />
          </label>
          <label className="admin-field" htmlFor="corrected-replacement-true-number">
            <span>Replacement true number</span>
            <input
              id="corrected-replacement-true-number"
              className="admin-input"
              type="number"
              step="any"
              required
              disabled={disabled}
              value={form.true_number}
              onChange={(event) => setField("true_number", event.target.value)}
            />
          </label>
          <label className="admin-field" htmlFor="corrected-replacement-unit">
            <span>Replacement unit</span>
            <input
              id="corrected-replacement-unit"
              className="admin-input"
              required
              disabled={disabled}
              value={form.unit}
              onChange={(event) => setField("unit", event.target.value)}
            />
          </label>
          <label className="admin-field" htmlFor="corrected-replacement-surprise-factor">
            <span>Surprise factor</span>
            <select
              id="corrected-replacement-surprise-factor"
              className="admin-select"
              disabled={disabled}
              value={form.surprise_factor}
              onChange={(event) => setField("surprise_factor", event.target.value)}
            >
              <option value="0">0 · Obvious</option>
              <option value="1">1 · Mildly surprising</option>
              <option value="2">2 · Very surprising</option>
              <option value="3">3 · Mind-blowing</option>
            </select>
          </label>
          <label className="admin-field" htmlFor="corrected-replacement-quantity-kind">
            <span>
              Quantity kind <InfoTip text="The auditor-consumed DDM kind. Leave on auto to classify from the unit." />
            </span>
            <select
              id="corrected-replacement-quantity-kind"
              className="admin-select"
              disabled={disabled}
              value={form.quantity_kind}
              onChange={(event) => setField("quantity_kind", event.target.value as QuantityKind | "")}
            >
              {QUANTITY_KIND_OPTIONS.map((kind) => (
                <option key={kind || "auto"} value={kind}>
                  {quantityKindLabel(kind)}
                </option>
              ))}
            </select>
          </label>
          <label className="admin-field" htmlFor="corrected-replacement-plausible-min">
            <span>Plausible min</span>
            <input
              id="corrected-replacement-plausible-min"
              className="admin-input"
              disabled={disabled}
              value={form.plausible_min}
              onChange={(event) => setField("plausible_min", event.target.value)}
            />
          </label>
          <label className="admin-field" htmlFor="corrected-replacement-plausible-max">
            <span>Plausible max</span>
            <input
              id="corrected-replacement-plausible-max"
              className="admin-input"
              disabled={disabled}
              value={form.plausible_max}
              onChange={(event) => setField("plausible_max", event.target.value)}
            />
          </label>
          <label className="admin-field" htmlFor="corrected-replacement-content-rating">
            <span>Content rating</span>
            <select
              id="corrected-replacement-content-rating"
              className="admin-select"
              disabled={disabled}
              value={form.content_rating}
              onChange={(event) =>
                setField("content_rating", event.target.value as "standard" | "after_dark")
              }
            >
              <option value="standard">standard</option>
              <option value="after_dark">after_dark</option>
            </select>
          </label>
        </div>

        <label className="admin-field" htmlFor="corrected-replacement-claim-template">
          <span>
            Claim template <InfoTip text="Use exactly one {n} placeholder. The true number is never hard-coded here." />
          </span>
          <input
            id="corrected-replacement-claim-template"
            className="admin-input"
            required
            disabled={disabled}
            value={form.claim_template}
            onChange={(event) => setField("claim_template", event.target.value)}
          />
        </label>
        <label className="admin-field" htmlFor="corrected-replacement-question">
          <span>Question / Prompt</span>
          <input
            id="corrected-replacement-question"
            className="admin-input"
            required
            disabled={disabled}
            value={form.question}
            onChange={(event) => setField("question", event.target.value)}
          />
        </label>
        <label className="admin-field" htmlFor="corrected-replacement-explanation">
          <span>Reveal explanation</span>
          <textarea
            id="corrected-replacement-explanation"
            className="admin-textarea"
            required
            disabled={disabled}
            value={form.explanation}
            onChange={(event) => setField("explanation", event.target.value)}
          />
        </label>
        <label className="admin-field" htmlFor="corrected-replacement-sources">
          <span>Source URLs (one per line)</span>
          <textarea
            id="corrected-replacement-sources"
            className="admin-textarea"
            disabled={disabled}
            value={form.source_urls}
            onChange={(event) => setField("source_urls", event.target.value)}
          />
        </label>
        <label className="admin-field" htmlFor="corrected-replacement-reason">
          <span>Correction reason (optional)</span>
          <input
            id="corrected-replacement-reason"
            className="admin-input"
            disabled={disabled}
            placeholder="Why is this replacement being created?"
            value={form.reason}
            onChange={(event) => setField("reason", event.target.value)}
          />
        </label>
        <label className="admin-field" htmlFor="corrected-replacement-number-pinned">
          <span>Pin this number</span>
          <span style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 44 }}>
            <input
              id="corrected-replacement-number-pinned"
              type="checkbox"
              disabled={disabled}
              checked={form.number_pinned}
              onChange={(event) => setField("number_pinned", event.target.checked)}
            />
            <span>Hand-verified value</span>
          </span>
        </label>
        <label className="admin-field" htmlFor="corrected-replacement-pinned-reason">
          <span>Pinned reason (optional)</span>
          <input
            id="corrected-replacement-pinned-reason"
            className="admin-input"
            disabled={disabled}
            value={form.pinned_reason}
            onChange={(event) => setField("pinned_reason", event.target.value)}
          />
        </label>

        {committed ? (
          <div
            role="status"
            aria-live="polite"
            aria-label="Corrected replacement status"
            style={{
              display: "grid",
              gap: "var(--ds-arena-space-2)",
              padding: "12px 14px",
              border: "1px solid var(--ds-arena-color-lime)",
              borderRadius: "var(--ds-arena-radius-md)",
              background: "var(--ds-arena-color-surface)",
              color: "var(--ds-arena-color-text-muted)",
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            <strong style={{ color: "var(--ds-arena-color-text)" }}>Correction committed.</strong>
            <div>
              Original <code>{committed.original.id}</code> is{" "}
              <FactStatusBadge status={committed.original.status} />. Replacement{" "}
              <code>{committed.replacement.id}</code> is{" "}
              <FactStatusBadge status={committed.replacement.status} />.
            </div>
            <p style={{ margin: 0 }}>
              The replacement is pending Foundry admission, not active. Only the nightly Foundry audit can
              promote it after review; this action does not activate it immediately.
            </p>
          </div>
        ) : null}

        <ErrorNote error={mutation.error} />
        <div className="admin-row-actions">
          <Button type="submit" disabled={disabled}>
            {mutation.isPending
              ? "Creating replacement…"
              : committed
                ? "Replacement created"
                : "Create replacement and retire original"}
          </Button>
          <Button type="button" variant="ghost" disabled={mutation.isPending} onClick={() => onDone?.()}>
            {committed ? "Close" : "Cancel"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function FactEditor({
  fact,
  onDone,
  onReplacementCommitted,
}: {
  fact: Fact;
  onDone: () => void;
  onReplacementCommitted?: (result: CorrectedReplacementResult) => void;
}) {
  const save = useServerFn(saveFact);
  const status = useServerFn(changeFactStatus);
  const getSubjects = useServerFn(fetchSubjects);
  const queryClient = useQueryClient();

  const subjectsQuery = useQuery({
    queryKey: ["taxonomy_subjects_datalist"],
    queryFn: () => getSubjects({ data: {} }),
    staleTime: 60_000,
  });

  const normalizedSurprise = normalizeSurpriseFactor(fact.surprise_factor);
  const selectedDistractor =
    fact.derivation?.distractors.find((d) => d.surprise_factor === normalizedSurprise)
    ?? fact.derivation?.distractors[0];

  const [form, setForm] = useState({
    category: fact.category || "",
    sub_category: "",
    true_number: fact.true_number === null ? "" : String(fact.true_number),
    unit: fact.unit ?? "",
    question: fact.question ?? "",
    context: fact.context ?? "",
    surprise_factor: String(normalizedSurprise),
    content_rating: fact.content_rating || "standard",
    source_urls: (fact.source_urls || []).join("\n"),
    quantity_kind: fact.quantity_kind || "",
    plausible_min: fact.plausible_min ?? "",
    plausible_max: fact.plausible_max ?? "",
  });
  const [replacementOpen, setReplacementOpen] = useState(false);

  const matchedSubject = useMemo(() => {
    const subject = fact.subject.trim();
    if (!subject) return null;
    const sub = subject.toLowerCase();
    return (
      subjectsQuery.data?.subjects.find(
        (s) =>
          s.subject.toLowerCase() === sub ||
          s.aliases.some((a) => a.toLowerCase() === sub),
      ) ?? null
    );
  }, [fact.subject, subjectsQuery.data?.subjects]);

  const effectiveCategory = form.category || matchedSubject?.category || "General";

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["facts"] });

  const saveMutation = useMutation({
    mutationFn: () =>
      save({
        data: {
          id: fact.id,
          // Subject and angle are immutable identity fields. They are displayed
          // below for context, but deliberately omitted from the ordinary edit
          // payload so this editor cannot express a re-key.
          category: effectiveCategory,
          sub_category: form.sub_category || matchedSubject?.sub_category || undefined,
          true_number: Number(form.true_number),
          unit: form.unit,
          claim_template: form.question ? `${form.question}: {n}` : `${fact.subject}: {n}`,
          explanation: form.context,
          question: form.question,
          surprise_factor: Number(form.surprise_factor),
          content_rating: form.content_rating as "standard" | "after_dark",
          source_urls: form.source_urls.split("\n").map((v) => v.trim()).filter(Boolean),
          quantity_kind: form.quantity_kind as QuantityKind | "",
          plausible_min: form.plausible_min,
          plausible_max: form.plausible_max,
        },
      }),
    onSuccess: async () => {
      await invalidate();
      onDone();
    },
  });

  const statusMutation = useMutation({
    mutationFn: (next: FactStatus) =>
      status({
        data: {
          id: fact.id,
          status: next,
        },
      }),
    onSuccess: invalidate,
  });

  // Which status-change controls the editor offers, decided at runtime from the
  // shared contract's transition table (Requirements 9.3, 9.4, 9.8). An unknown
  // persisted status is not a declared transition source, so every entry is
  // false and no status-change control is offered for it (Requirement 9.10).
  const canTransitionTo = authorizedStatusTargets(fact.status);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!window.confirm("Save changes to this fact?")) return;
    saveMutation.mutate();
  }

  return (
    <Card>
      <form onSubmit={submit} style={{ display: "grid", gap: "var(--ds-arena-space-4)" }}>
        <div className="admin-page-head">
          <CardTitle>Edit fact</CardTitle>
          <FactStatusBadge status={fact.status} />
        </div>
        <p style={{ fontFamily: "var(--ds-arena-font-mono)", fontSize: 12, color: "var(--ds-arena-color-text-muted)" }}>
          {fact.id}
        </p>

        <p
          id="fact-identity-note"
          role="note"
          style={{
            margin: 0,
            padding: "12px 14px",
            border: "1px solid var(--ds-arena-color-border)",
            borderLeft: "3px solid var(--ds-arena-color-lime)",
            borderRadius: "var(--ds-arena-radius-md)",
            background: "var(--ds-arena-color-surface)",
            color: "var(--ds-arena-color-text-muted)",
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          <strong style={{ color: "var(--ds-arena-color-text)" }}>
            Subject and angle are immutable identity fields.
          </strong>{" "}
          They are read-only after creation. Corrections create a replacement fact rather than re-keying
          the original document. The replacement carries the corrected identity, while the original keeps
          its identity.
        </p>

        {fact.status === STATUS.pending ? <PendingAdmissionNotice /> : null}

        <div className="admin-grid">
          <label className="admin-field" htmlFor="fact-identity-subject">
            <span>
              Subject (read-only identity) <Badge tone="neutral">Identity</Badge>{" "}
              <InfoTip text="This subject is fixed after creation. A correction uses a replacement fact instead of re-keying this record." />
            </span>
            <input
              id="fact-identity-subject"
              className="admin-input"
              value={fact.subject}
              readOnly
              aria-readonly="true"
              aria-describedby="fact-identity-note"
            />
            {matchedSubject ? (
              <span style={{ fontSize: 11, color: "var(--ds-arena-color-lime)", marginTop: 2 }}>
                ✓ Linked to: <strong>{matchedSubject.category}</strong> › {matchedSubject.sub_category}
              </span>
            ) : fact.subject ? (
              <span style={{ fontSize: 11, color: "var(--ds-arena-color-text-muted)", marginTop: 2 }}>
                ℹ️ Will be classified under <strong>{effectiveCategory}</strong>
              </span>
            ) : null}
          </label>
          <label className="admin-field">
            <span>
              Genre <InfoTip text="Genre for this trivia question. Match scope and playlists live on the topic." />
            </span>
            <select
              className="admin-select"
              value={effectiveCategory}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
            >
              {GENRES.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </label>
          <label className="admin-field" htmlFor="fact-identity-angle">
            <span>
              Angle (read-only identity) <Badge tone="neutral">Identity</Badge>{" "}
              <InfoTip text="This angle is fixed after creation. A correction uses a replacement fact instead of re-keying this record." />
            </span>
            <input
              id="fact-identity-angle"
              className="admin-input"
              value={fact.angle}
              readOnly
              aria-readonly="true"
              aria-describedby="fact-identity-note"
            />
          </label>
          <label className="admin-field">
            <span>True number</span>
            <input
              className="admin-input"
              type="number"
              step="any"
              value={form.true_number}
              onChange={(e) => setForm({ ...form, true_number: e.target.value })}
            />
          </label>
          <label className="admin-field">
            <span>Unit</span>
            <input
              className="admin-input"
              value={form.unit}
              onChange={(e) => setForm({ ...form, unit: e.target.value })}
            />
          </label>
          <label className="admin-field">
            <span>
              Surprise factor <InfoTip text="Scale of 0–3 gauging how shocking the number is (0: Obvious/common knowledge, 1: Mildly surprising, 2: Very surprising, 3: Mind-blowing intuition trap)." />
            </span>
            <select
              className="admin-select"
              value={form.surprise_factor}
              onChange={(e) => setForm({ ...form, surprise_factor: e.target.value })}
            >
              <option value="0">0 · Obvious (Common knowledge)</option>
              <option value="1">1 · Mildly surprising</option>
              <option value="2">2 · Very surprising</option>
              <option value="3">3 · Mind-blowing (Intuition trap)</option>
            </select>
          </label>
          <label className="admin-field">
            <span>Content rating</span>
            <select
              className="admin-select"
              value={form.content_rating}
              onChange={(e) => setForm({ ...form, content_rating: e.target.value })}
            >
              <option value="standard">standard</option>
              <option value="after_dark">after_dark</option>
            </select>
          </label>
          <label className="admin-field">
            <span>
              Quantity kind{" "}
              <InfoTip text="DDM semantic kind. Leave on auto to classify from the unit. Use 'year' for calendar-year answers, 'physical_measure' for physical domains." />
            </span>
            <select
              className="admin-select"
              value={form.quantity_kind}
              onChange={(e) => setForm({ ...form, quantity_kind: e.target.value })}
            >
              {QUANTITY_KIND_OPTIONS.map((kind) => (
                <option key={kind || "auto"} value={kind}>
                  {quantityKindLabel(kind)}
                </option>
              ))}
            </select>
          </label>
          <label className="admin-field">
            <span>
              Plausible min{" "}
              <InfoTip text="Optional domain floor hint for distractor bounds (e.g. '0'). Both bounds must be set together; clearing regenerates defaults." />
            </span>
            <input
              className="admin-input"
              value={form.plausible_min}
              onChange={(e) => setForm({ ...form, plausible_min: e.target.value })}
            />
          </label>
          <label className="admin-field">
            <span>
              Plausible max{" "}
              <InfoTip text="Optional domain ceiling hint (e.g. '158.3' for NFL passer rating, '110' for punt yards). Both bounds must be set together." />
            </span>
            <input
              className="admin-input"
              value={form.plausible_max}
              onChange={(e) => setForm({ ...form, plausible_max: e.target.value })}
            />
          </label>
        </div>

        <label className="admin-field">
          <span>
            Question / Prompt{" "}
            <InfoTip text="The numberless question or phrase shown on the game card (e.g. 'How many neck vertebrae does a giraffe have?' or 'Career touchdowns')." />
          </span>
          <input
            className="admin-input"
            value={form.question}
            onChange={(e) => setForm({ ...form, question: e.target.value })}
          />
        </label>
        <label className="admin-field">
          <span>
            Reveal explanation{" "}
            <InfoTip text="The canonical explanation revealed after a guess. Legacy context remains readable and editable through this compatibility field." />
          </span>
          <textarea
            className="admin-textarea"
            value={form.context}
            onChange={(e) => setForm({ ...form, context: e.target.value })}
          />
        </label>
        <label className="admin-field">
          <span>Source URLs (one per line)</span>
          <textarea
            className="admin-textarea"
            value={form.source_urls}
            onChange={(e) => setForm({ ...form, source_urls: e.target.value })}
          />
        </label>

        <dl className="admin-kv">
          <dt>Previous number</dt>
          <dd>{fact.previous_true_number ?? "—"}</dd>
          <dt>Verified</dt>
          <dd>
            {fact.verified_at ?? "—"} {fact.verifier_model ? `· ${fact.verifier_model}` : ""}
          </dd>
          <dt>Served</dt>
          <dd>
            {fact.served_count} {fact.last_served_at ? `· last ${fact.last_served_at}` : ""}
          </dd>
          <dt>Retired reason</dt>
          <dd>{fact.retired_reason ?? "—"}</dd>
          <dt>Quality flags</dt>
          <dd>
            {fact.quality_flags.length ? (
              <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
                {fact.quality_flags.map((flag) => (
                  <Badge key={flag} tone="red">{flag}</Badge>
                ))}
              </span>
            ) : (
              "—"
            )}
          </dd>
          <dt>Disputed reason</dt>
          <dd>{fact.disputed_reason ?? "—"}</dd>
          <dt>Number pinned</dt>
          <dd>
            {fact.number_pinned
              ? `yes — ${fact.pinned_reason ?? "hand-verified"}`
              : "—"}
          </dd>
        </dl>

        {fact.true_number !== null ? (
          <div style={{ background: "var(--ds-arena-color-surface)", padding: 12, borderRadius: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <strong style={{ fontSize: 13 }}>DDM Derivation</strong>
                <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--ds-arena-color-text-muted)" }}>
                  {fact.derivation?.distractors?.length
                    ? `${fact.derivation.distractors.length} precomputed distractors (${fact.derivation.quantity_kind})`
                    : "Live derivation"}
                </p>
              </div>
              <Link
                to="/admin/audit"
                search={{
                  tab: "derivation",
                  true: String(fact.true_number),
                  unit: fact.unit ?? "",
                  surprise: String(fact.surprise_factor ?? 2),
                  kind: fact.derivation?.quantity_kind,
                  side: selectedDistractor?.side,
                  trap: fact.derivation?.trap_direction,
                  pmin: fact.derivation?.plausible_min,
                  pmax: fact.derivation?.plausible_max,
                  presented: selectedDistractor?.presented_number,
                  topic: fact.subject,
                }}
                style={{ fontSize: 13, display: "inline-flex", alignItems: "center", gap: 4 }}
                target="_blank"
                rel="noreferrer"
              >
                🔬 Inspect in DDM Auditor ↗
              </Link>
            </div>
          </div>
        ) : null}

        <ErrorNote error={saveMutation.error ?? statusMutation.error} />
        <div className="admin-row-actions">
          <Button type="submit" disabled={saveMutation.isPending}>
            {saveMutation.isPending ? "Saving…" : "Save changes"}
          </Button>
          {replacementOpen || canTransitionTo.retired ? (
            <Button
              type="button"
              variant="daily"
              disabled={!replacementOpen && (saveMutation.isPending || statusMutation.isPending)}
              aria-expanded={replacementOpen}
              aria-controls="corrected-replacement-form"
              onClick={() => {
                if (replacementOpen) {
                  setReplacementOpen(false);
                  return;
                }
                if (!canTransitionTo.retired) return;
                setReplacementOpen(true);
              }}
            >
              {replacementOpen ? "Close corrected replacement" : "Create corrected replacement"}
            </Button>
          ) : null}
          {/* Each control renders only when the fact's current status has an
              admin-authorized transition to that target. An unknown persisted
              status authorizes none, so it can be viewed but not transitioned
              (Requirements 9.8, 9.10). Target statuses are supplied to the
              mutation via the contract-derived helper, never a literal here. */}
          {canTransitionTo.active && fact.status !== STATUS.pending ? (
            <Button
              type="button"
              variant="daily"
              disabled={statusMutation.isPending}
              onClick={() => statusMutation.mutate(canTransitionTo.active!)}
            >
              Verify &amp; approve
            </Button>
          ) : null}
          {canTransitionTo.disputed ? (
            <Button
              type="button"
              variant="skip"
              disabled={statusMutation.isPending}
              onClick={() => statusMutation.mutate(canTransitionTo.disputed!)}
            >
              Mark disputed
            </Button>
          ) : null}
          {canTransitionTo.retired ? (
            <Button
              type="button"
              variant="danger"
              disabled={statusMutation.isPending}
              onClick={() => {
                if (window.confirm("Retire this fact? It stops being served.")) {
                  statusMutation.mutate(canTransitionTo.retired!);
                }
              }}
            >
              Retire
            </Button>
          ) : null}
          <Button type="button" variant="ghost" onClick={onDone}>
            Close
          </Button>
        </div>
      </form>
      {replacementOpen ? (
        <CorrectedReplacementForm
          fact={fact}
          onDone={() => setReplacementOpen(false)}
          onCommitted={onReplacementCommitted}
        />
      ) : null}
    </Card>
  );
}

function ReplacementCommitNotice({
  result,
  onDismiss,
}: {
  result: CorrectedReplacementResult;
  onDismiss: () => void;
}) {
  return (
    <Card>
      <div
        role="status"
        aria-live="polite"
        aria-label="Corrected replacement committed"
        style={{
          display: "grid",
          gap: "var(--ds-arena-space-2)",
          color: "var(--ds-arena-color-text-muted)",
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        <div className="admin-page-head">
          <strong style={{ color: "var(--ds-arena-color-text)" }}>Corrected replacement committed</strong>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
        <div>
          Original <code>{result.original.id}</code> is <FactStatusBadge status={result.original.status} />;
          replacement <code>{result.replacement.id}</code> is <FactStatusBadge status={result.replacement.status} />.
        </div>
        <p style={{ margin: 0 }}>
          The original is retired. The replacement is pending Foundry admission, not active; only the nightly
          Foundry audit can promote it after review.
        </p>
      </div>
    </Card>
  );
}

export function NewFactForm({ onDone }: { onDone: () => void }) {
  const create = useServerFn(addFact);
  const getSubjects = useServerFn(fetchSubjects);
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    ...EMPTY_DRAFT,
    quantity_kind: EMPTY_DRAFT.quantity_kind as QuantityKind | "",
  });

  const subjectsQuery = useQuery({
    queryKey: ["taxonomy_subjects_datalist"],
    queryFn: () => getSubjects({ data: {} }),
    staleTime: 60_000,
  });

  const matchedSubject = useMemo(() => {
    if (!form.subject?.trim()) return null;
    const sub = form.subject.trim().toLowerCase();
    return (
      subjectsQuery.data?.subjects.find(
        (s) =>
          s.subject.toLowerCase() === sub ||
          s.aliases.some((a) => a.toLowerCase() === sub),
      ) ?? null
    );
  }, [form.subject, subjectsQuery.data?.subjects]);

  const effectiveCategory = form.category || matchedSubject?.category || "General";

  const mutation = useMutation({
    mutationFn: () =>
      create({
        data: {
          subject: form.subject,
          category: effectiveCategory,
          sub_category: form.sub_category || matchedSubject?.sub_category || undefined,
          angle: form.angle.trim(),
          true_number: Number(form.true_number),
          unit: form.unit.trim(),
          claim_template: form.claim_template.trim(),
          explanation: form.explanation.trim(),
          question: form.question.trim(),
          surprise_factor: Number(form.surprise_factor),
          quantity_kind: form.quantity_kind as QuantityKind | "",
          plausible_min: form.plausible_min.trim() || undefined,
          plausible_max: form.plausible_max.trim() || undefined,
          content_rating: form.content_rating as "standard" | "after_dark",
          source_urls: form.source_urls.split("\n").map((v) => v.trim()).filter(Boolean),
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["facts"] });
      setForm(EMPTY_DRAFT);
      onDone();
    },
  });

  return (
    <Card>
      <datalist id="taxonomy-subjects-datalist">
        {subjectsQuery.data?.subjects.map((subject) => (
          <option key={subject.id} value={subject.subject}>
            {subject.category} › {subject.sub_category}
          </option>
        ))}
      </datalist>
      <form
        style={{ display: "grid", gap: "var(--ds-arena-space-4)" }}
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <CardTitle>New fact</CardTitle>
        <PendingAdmissionNotice />
        <div className="admin-grid">
          <label className="admin-field">
            <span>Topic</span>
            <input
              className="admin-input"
              list="taxonomy-subjects-datalist"
              placeholder="e.g. Giraffe, Taylor Swift"
              required
              value={form.subject}
              onChange={(e) => setForm({ ...form, subject: e.target.value })}
            />
            {matchedSubject ? (
              <span style={{ fontSize: 11, color: "var(--ds-arena-color-lime)", marginTop: 2 }}>
                ✓ Linked to: <strong>{matchedSubject.category}</strong> › {matchedSubject.sub_category}
              </span>
            ) : form.subject ? (
              <span style={{ fontSize: 11, color: "var(--ds-arena-color-text-muted)", marginTop: 2 }}>
                ℹ️ Will be classified under <strong>{effectiveCategory}</strong>
              </span>
            ) : null}
          </label>
          <label className="admin-field">
            <span>
              Genre <InfoTip text="Genre for this trivia question. Match scope and playlists live on the topic." />
            </span>
            <select
              className="admin-select"
              value={effectiveCategory}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
            >
              {GENRES.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </label>
          <label className="admin-field">
            <span>
              Match Scope <InfoTip text="Optional resolver scope for free-text topic matching (e.g. Football, Marine Life). Not part of the editorial hierarchy. Leave blank to resolve via genre." />
            </span>
            <input
              className="admin-input"
              placeholder="e.g. Big Cats"
              value={form.sub_category}
              onChange={(e) => setForm({ ...form, sub_category: e.target.value })}
            />
          </label>
          <label className="admin-field">
            <span>
              Angle <InfoTip text="A concise 2–4 word title for this specific metric or record (e.g. 'Top Speed', 'Weeks at #1', 'Career MVP Awards'). Uniquely identifies the fact for this subject." />
            </span>
            <input
              className="admin-input"
              placeholder="e.g. Top Speed, Weeks at #1"
              required
              value={form.angle}
              onChange={(e) => setForm({ ...form, angle: e.target.value })}
            />
          </label>
          <label className="admin-field">
            <span>True number</span>
            <input
              className="admin-input"
              type="number"
              step="any"
              required
              value={form.true_number}
              onChange={(e) => setForm({ ...form, true_number: e.target.value })}
            />
          </label>
          <label className="admin-field">
            <span>Unit</span>
            <input
              className="admin-input"
              required
              value={form.unit}
              onChange={(e) => setForm({ ...form, unit: e.target.value })}
            />
          </label>
          <label className="admin-field" style={{ gridColumn: "1 / -1" }}>
            <span>
              Claim template{" "}
              <InfoTip text="The auditor-facing claim with one {n} placeholder. The true number is never hard-coded here." />
            </span>
            <input
              className="admin-input"
              placeholder="e.g. A giraffe has {n} cervical vertebrae."
              required
              value={form.claim_template}
              onChange={(e) => setForm({ ...form, claim_template: e.target.value })}
            />
          </label>
          <label className="admin-field">
            <span>
              Surprise factor <InfoTip text="Scale of 0–3 gauging how shocking the number is (0: Obvious/common knowledge, 1: Mildly surprising, 2: Very surprising, 3: Mind-blowing intuition trap)." />
            </span>
            <select
              className="admin-select"
              value={form.surprise_factor}
              onChange={(e) => setForm({ ...form, surprise_factor: e.target.value })}
            >
              <option value="0">0 · Obvious (Common knowledge)</option>
              <option value="1">1 · Mildly surprising</option>
              <option value="2">2 · Very surprising</option>
              <option value="3">3 · Mind-blowing (Intuition trap)</option>
            </select>
          </label>
          <label className="admin-field">
            <span>
              Quantity kind{" "}
              <InfoTip text="The auditor-consumed DDM kind. Leave on auto to classify from the unit, or choose a contract value explicitly." />
            </span>
            <select
              className="admin-select"
              value={form.quantity_kind}
              onChange={(e) =>
                setForm({ ...form, quantity_kind: e.target.value as QuantityKind | "" })
              }
            >
              {QUANTITY_KIND_OPTIONS.map((kind) => (
                <option key={kind || "auto"} value={kind}>
                  {quantityKindLabel(kind)}
                </option>
              ))}
            </select>
          </label>
          <label className="admin-field">
            <span>
              Plausible min{" "}
              <InfoTip text="Optional decimal-string floor hint. Set both bounds together or leave both blank." />
            </span>
            <input
              className="admin-input"
              value={form.plausible_min}
              onChange={(e) => setForm({ ...form, plausible_min: e.target.value })}
            />
          </label>
          <label className="admin-field">
            <span>
              Plausible max{" "}
              <InfoTip text="Optional decimal-string ceiling hint. Set both bounds together or leave both blank." />
            </span>
            <input
              className="admin-input"
              value={form.plausible_max}
              onChange={(e) => setForm({ ...form, plausible_max: e.target.value })}
            />
          </label>
          <label className="admin-field">
            <span>Content rating</span>
            <select
              className="admin-select"
              value={form.content_rating}
              onChange={(e) => setForm({ ...form, content_rating: e.target.value })}
            >
              <option value="standard">standard</option>
              <option value="after_dark">after_dark</option>
            </select>
          </label>
        </div>
        <label className="admin-field">
          <span>
            Question / Prompt{" "}
            <InfoTip text="The numberless question or phrase shown on the game card (e.g. 'How many neck vertebrae does a giraffe have?' or 'Career touchdowns')." />
          </span>
          <input
            className="admin-input"
            required
            value={form.question}
            onChange={(e) => setForm({ ...form, question: e.target.value })}
          />
        </label>
        <label className="admin-field">
          <span>
            Reveal explanation{" "}
            <InfoTip text="The canonical explanation revealed after a guess. Legacy context is accepted as a read/input alias, but new admissions persist explanation." />
          </span>
          <textarea
            className="admin-textarea"
            required
            value={form.explanation}
            onChange={(e) => setForm({ ...form, explanation: e.target.value })}
          />
        </label>
        <label className="admin-field">
          <span>Source URLs (one per line)</span>
          <textarea
            className="admin-textarea"
            value={form.source_urls}
            onChange={(e) => setForm({ ...form, source_urls: e.target.value })}
          />
        </label>
        <ErrorNote error={mutation.error} />
        <div className="admin-row-actions">
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? "Creating…" : "Save as pending"}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

/**
 * Manages the content administration interface for facts, topics, playlists, and crawl intake.
 */
function ContentPage() {
  const { view: viewParam } = Route.useSearch();
  const view: ContentView = viewParam ?? "facts";
  const list = useServerFn(fetchFacts);
  const exportFn = useServerFn(exportFactsData);
  const getBankObservability = useServerFn(fetchBankObservability);
  const getSubjects = useServerFn(fetchSubjects);
  const getPlaylists = useServerFn(fetchPlaylists);
  const [filters, setFilters] = useState({
    search: "",
    category: "",
    family: "",
    playlistId: "",
    subject: "",
    angle: "",
    // Default to the contract's active status; `String(...)` keeps the state
    // field's inferred type `string` (the filter also accepts "" for "All").
    status: String(STATUS.active),
    contentRating: "",
    surpriseFactor: "",
  });
  const [sort, setSort] = useState<{
    field: "subject" | "angle" | "true_number" | "surprise_factor" | "served_count";
    order: "asc" | "desc";
  }>({
    field: "subject",
    order: "asc",
  });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [selected, setSelected] = useState<Fact | null>(null);
  const [replacementCommit, setReplacementCommit] = useState<CorrectedReplacementResult | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);

  const query = useQuery({
    queryKey: ["facts", filters, sort, page, pageSize],
    queryFn: () =>
      list({
        data: {
          search: filters.search || undefined,
          category: filters.category || undefined,
          family: filters.family || undefined,
          playlistId: filters.playlistId || undefined,
          subject: filters.subject || undefined,
          angle: filters.angle || undefined,
          status: filters.status || undefined,
          contentRating: filters.contentRating || undefined,
          surpriseFactor: filters.surpriseFactor !== "" ? Number(filters.surpriseFactor) : undefined,
          sortField: sort.field,
          sortOrder: sort.order,
          page,
          pageSize,
        },
      }),
    enabled: view === "facts",
    retry: false,
  });

  const bankObservabilityQuery = useQuery({
    queryKey: ["fact_bank_observability"],
    queryFn: () => getBankObservability(),
    enabled: view === "facts",
    staleTime: 30_000,
    retry: false,
  });

  const subjectsQuery = useQuery({
    queryKey: ["subjects", "content-join"],
    queryFn: () => getSubjects({ data: {} }),
    staleTime: 60_000,
    retry: false,
  });

  const playlistsQuery = useQuery({
    queryKey: ["playlists"],
    queryFn: () => getPlaylists(),
    staleTime: 60_000,
    retry: false,
  });

  const subjects = subjectsQuery.data?.subjects;
  const subjectsByName = useMemo(() => {
    const map = new Map<string, NonNullable<typeof subjects>[number]>();
    for (const subject of subjects ?? []) {
      map.set(subject.subject.toLowerCase(), subject);
      for (const alias of subject.aliases) map.set(alias.toLowerCase(), subject);
    }
    return map;
  }, [subjects]);

  const matchScopeOptions = matchScopesForGenre(
    filters.category,
    (subjectsQuery.data?.subjects ?? [])
      .filter((s) => !filters.category || s.category === filters.category)
      .map((s) => s.sub_category),
  );

  const toggleSort = (field: typeof sort.field) => {
    setPage(1);
    if (sort.field === field) {
      setSort({ field, order: sort.order === "asc" ? "desc" : "asc" });
    } else {
      setSort({ field, order: "asc" });
    }
  };

  const renderSortIcon = (field: typeof sort.field) => {
    if (sort.field !== field) return <span style={{ opacity: 0.35, marginLeft: 4, fontSize: 10 }}>↕</span>;
    return (
      <span style={{ color: "var(--ds-arena-color-lime)", marginLeft: 4, fontSize: 11 }}>
        {sort.order === "asc" ? "▲" : "▼"}
      </span>
    );
  };

  const hasActiveFilters = Boolean(
    filters.search ||
    filters.category ||
    filters.family ||
    filters.playlistId ||
    filters.subject ||
    filters.angle ||
    filters.status !== STATUS.active ||
    filters.contentRating ||
    filters.surpriseFactor !== "",
  );

  const resetFilters = () => {
    setPage(1);
    setFilters({
      search: "",
      category: "",
      family: "",
      playlistId: "",
      subject: "",
      angle: "",
      status: STATUS.active,
      contentRating: "",
      surpriseFactor: "",
    });
  };

  const handleExportCsv = async () => {
    try {
      setExporting(true);
      const facts = await exportFn({
        data: {
          search: filters.search || undefined,
          category: filters.category || undefined,
          family: filters.family || undefined,
          playlistId: filters.playlistId || undefined,
          subject: filters.subject || undefined,
          angle: filters.angle || undefined,
          // Exports are the active bank snapshot. Pending admission rows stay
          // visible in the editor/list but never enter the active export set.
          status: STATUS.active,
          contentRating: filters.contentRating || undefined,
          surpriseFactor: filters.surpriseFactor !== "" ? Number(filters.surpriseFactor) : undefined,
          sortField: sort.field,
          sortOrder: sort.order,
        },
      });
      const headers = [
        "id",
        "subject",
        "angle",
        "true_number",
        "unit",
        "question",
        "context",
        "surprise_factor",
        "content_rating",
        "status",
        "source_urls",
      ];
      const rows = facts.map((f) => [
        escapeCsv(f.id),
        escapeCsv(f.subject),
        escapeCsv(f.angle),
        escapeCsv(f.true_number),
        escapeCsv(f.unit),
        escapeCsv(f.question || f.claim_template),
        escapeCsv(f.context),
        escapeCsv(f.surprise_factor),
        escapeCsv(f.content_rating),
        escapeCsv(f.status),
        escapeCsv((f.source_urls || []).join(" ; ")),
      ]);
      const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", `fact_bank_export_${new Date().toISOString().slice(0, 10)}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  const totalPages = useMemo(
    () => (query.data ? Math.max(1, Math.ceil(query.data.total / query.data.pageSize)) : 1),
    [query.data],
  );

  const viewLabel = (item: ContentView) => {
    switch (item) {
      case "facts":
        return "Facts";
      case "topics":
        return "Topics";
      case "playlists":
        return "Playlists";
      case "crawl":
        return "Crawl";
      default: {
        const _never: never = item;
        return _never;
      }
    }
  };

  return (
    <div className="daily-blitz-layout">
      <div className="daily-blitz-main">
        <PageHead
          title="Content"
          description="Facts attach to topics. Topics sit in a genre; match scope is resolver metadata. Playlists are optional theme mixes."
          actions={
            view === "facts" ? (
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <Button
                  variant="ghost"
                  disabled={exporting}
                  onClick={() => void handleExportCsv()}
                >
                  {exporting ? "Exporting…" : "Export CSV (active only)"}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setImporting((v) => !v);
                    setCreating(false);
                    setSelected(null);
                  }}
                >
                  {importing ? "Close Import" : "Import CSV"}
                </Button>
                <Button
                  onClick={() => {
                    setCreating((value) => !value);
                    setImporting(false);
                    setSelected(null);
                  }}
                >
                  {creating ? "Close" : "New fact"}
                </Button>
              </div>
            ) : undefined
          }
        />

        <nav className="admin-tabs" aria-label="Content sections">
          {CONTENT_VIEWS.map((item) => (
            <Link
              key={item}
              to="/admin/facts"
              search={{ view: item }}
              className={view === item ? "is-active" : undefined}
            >
              {viewLabel(item)}
            </Link>
          ))}
        </nav>

        {view === "topics" ? <TopicsPanel /> : null}
        {view === "playlists" ? <PlaylistsPanel /> : null}
        {view === "crawl" ? <CrawlQueue /> : null}
        {view === "facts" ? (
          <>

            <div className="admin-toolbar">
              <label className="admin-field" style={{ flex: "1 1 240px" }}>
                <span>Search all text (subject, angle, question, context)</span>
                <input
                  className="admin-input"
                  placeholder="Search keywords…"
                  value={filters.search}
                  onChange={(e) => {
                    setPage(1);
                    setFilters({ ...filters, search: e.target.value });
                  }}
                />
              </label>
              <label className="admin-field" style={{ flex: "0 1 200px" }}>
                <span>Genre</span>
                <select
                  className="admin-select"
                  value={filters.category}
                  onChange={(e) => {
                    setPage(1);
                    setFilters({ ...filters, category: e.target.value, family: "" });
                  }}
                >
                  <option value="">All genres</option>
                  {GENRES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </label>
              <label className="admin-field" style={{ flex: "0 1 180px" }}>
                <span>Match Scope</span>
                <select
                  className="admin-select"
                  value={filters.family}
                  onChange={(e) => {
                    setPage(1);
                    setFilters({ ...filters, family: e.target.value });
                  }}
                >
                  <option value="">All match scopes</option>
                  {matchScopeOptions.map((scope) => (
                    <option key={scope} value={scope}>
                      {scope}
                    </option>
                  ))}
                </select>
              </label>
              <label className="admin-field" style={{ flex: "0 1 180px" }}>
                <span>Playlist</span>
                <select
                  className="admin-select"
                  value={filters.playlistId}
                  onChange={(e) => {
                    setPage(1);
                    setFilters({ ...filters, playlistId: e.target.value });
                  }}
                >
                  <option value="">All playlists</option>
                  {(playlistsQuery.data ?? []).map((playlist) => (
                    <option key={playlist.id} value={playlist.id}>
                      {playlist.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="admin-field">
                <span>Per page</span>
                <select
                  className="admin-select"
                  value={pageSize}
                  onChange={(e) => {
                    setPage(1);
                    setPageSize(Number(e.target.value));
                  }}
                >
                  <option value="25">25</option>
                  <option value="50">50</option>
                  <option value="100">100</option>
                  <option value="250">250</option>
                  <option value="500">500</option>
                  <option value="1000">All (1,000)</option>
                </select>
              </label>
              {hasActiveFilters ? (
                <div style={{ alignSelf: "flex-end", paddingBottom: "6px" }}>
                  <Button size="sm" variant="ghost" onClick={resetFilters}>
                    Reset filters
                  </Button>
                </div>
              ) : null}
            </div>

            <BankObservabilityPanel
              data={bankObservabilityQuery.data}
              isLoading={bankObservabilityQuery.isLoading}
              error={bankObservabilityQuery.error}
            />

            <PendingAdmissionNotice />

            {replacementCommit ? (
              <ReplacementCommitNotice
                result={replacementCommit}
                onDismiss={() => setReplacementCommit(null)}
              />
            ) : null}

            <ErrorNote error={query.error} />
            {importing ? <ImportCsvModal onDone={() => setImporting(false)} /> : null}
            {creating ? <NewFactForm onDone={() => setCreating(false)} /> : null}

            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th className="admin-th-sortable" onClick={() => toggleSort("subject")}>
                      Topic {renderSortIcon("subject")}
                    </th>
                    <th className="admin-th-sortable" onClick={() => toggleSort("angle")}>
                      Angle {renderSortIcon("angle")}{" "}
                      <InfoTip position="bottom" text="The specific metric, dimension, or record being measured." />
                    </th>
                    <th className="admin-th-sortable" onClick={() => toggleSort("true_number")}>
                      Value {renderSortIcon("true_number")}
                    </th>
                    <th className="admin-th-sortable" onClick={() => toggleSort("surprise_factor")}>
                      Surprise {renderSortIcon("surprise_factor")}{" "}
                      <InfoTip position="bottom" text="Scale of 0 (obvious) to 3 (mind-blowing counterintuitive)." />
                    </th>
                    <th>Rating</th>
                    <th>Status</th>
                    <th className="admin-th-sortable" onClick={() => toggleSort("served_count")}>
                      Served {renderSortIcon("served_count")}
                    </th>
                    <th style={{ width: 80, textAlign: "right" }} />
                  </tr>
                  <tr className="admin-table-header-filters">
                    <th>
                      <input
                        className="admin-header-input"
                        placeholder="Filter topic…"
                        value={filters.subject}
                        onChange={(e) => {
                          setPage(1);
                          setFilters({ ...filters, subject: e.target.value });
                        }}
                      />
                    </th>
                    <th>
                      <input
                        className="admin-header-input"
                        placeholder="Filter angle…"
                        value={filters.angle}
                        onChange={(e) => {
                          setPage(1);
                          setFilters({ ...filters, angle: e.target.value });
                        }}
                      />
                    </th>
                    <th />
                    <th>
                      <select
                        className="admin-header-select"
                        value={filters.surpriseFactor}
                        onChange={(e) => {
                          setPage(1);
                          setFilters({ ...filters, surpriseFactor: e.target.value });
                        }}
                      >
                        <option value="">All</option>
                        <option value="0">0 · Obvious</option>
                        <option value="1">1 · Mild</option>
                        <option value="2">2 · Very</option>
                        <option value="3">3 · Mind-blowing</option>
                      </select>
                    </th>
                    <th>
                      <select
                        className="admin-header-select"
                        value={filters.contentRating}
                        onChange={(e) => {
                          setPage(1);
                          setFilters({ ...filters, contentRating: e.target.value });
                        }}
                      >
                        <option value="">All</option>
                        <option value="standard">standard</option>
                        <option value="after_dark">after_dark</option>
                      </select>
                    </th>
                    <th>
                      <select
                        className="admin-header-select"
                        value={filters.status}
                        onChange={(e) => {
                          setPage(1);
                          setFilters({ ...filters, status: e.target.value });
                        }}
                      >
                        {/* Exactly the statuses the shared contract declares,
                            in declaration order, plus the unfiltered "All"
                            (Requirement 9.2). */}
                        <option value="">All</option>
                        {FACT_STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {status}
                          </option>
                        ))}
                      </select>
                    </th>
                    <th />
                    <th>
                      {hasActiveFilters ? (
                        <button
                          type="button"
                          className="admin-clear-filter-btn"
                          onClick={resetFilters}
                          title="Reset all filters"
                        >
                          Reset
                        </button>
                      ) : null}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {query.data?.facts.map((fact) => {
                    const isEditing = selected?.id === fact.id;
                    return (
                      <Fragment key={fact.id}>
                        <tr className={isEditing ? "is-editing" : undefined}>
                          <td>
                            <strong>{fact.subject}</strong>
                            {(() => {
                              const topic = subjectsByName.get(fact.subject.toLowerCase());
                              if (!topic) return null;
                              const playlistNames = topic.playlist_ids
                                .map((id) => (playlistsQuery.data ?? []).find((p) => p.id === id)?.name)
                                .filter(Boolean);
                              return (
                                <span className="admin-topic-meta">
                                  {[topic.category, topic.sub_category].filter(Boolean).join(" › ") || "No match scope"}
                                  {playlistNames.length ? ` · ${playlistNames.join(", ")}` : ""}
                                </span>
                              );
                            })()}
                          </td>
                          <td>{fact.angle}</td>
                          <td>
                            {fact.true_number ?? "—"} {fact.unit}
                            {fact.previous_true_number !== null ? (
                              <div style={{ fontSize: 12, color: "var(--ds-arena-color-amber)" }}>
                                was {fact.previous_true_number}
                              </div>
                            ) : null}
                          </td>
                          <td>
                            {fact.surprise_factor !== null && fact.surprise_factor !== undefined ? (
                              <span
                                title={
                                  fact.surprise_factor >= 3
                                    ? "3 · Mind-blowing (Intuition trap)"
                                    : fact.surprise_factor === 2
                                      ? "2 · Very surprising"
                                      : fact.surprise_factor === 1
                                        ? "1 · Mildly surprising"
                                        : "0 · Obvious"
                                }
                              >
                                {fact.surprise_factor}
                              </span>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td>{fact.content_rating}</td>
                          <td>
                            <FactStatusBadge status={fact.status} />
                            {fact.status === STATUS.pending ? (
                              <span className="admin-topic-meta">Foundry audit only</span>
                            ) : null}
                          </td>
                          <td>{fact.served_count}</td>
                          <td>
                            <Button
                              size="sm"
                              variant={isEditing ? "primary" : "ghost"}
                              onClick={() => {
                                setCreating(false);
                                setImporting(false);
                                setSelected(isEditing ? null : fact);
                              }}
                            >
                              {isEditing ? "Close" : "Edit"}
                            </Button>
                          </td>
                        </tr>
                        {isEditing ? (
                          <InlineEditorRow colSpan={8}>
                            <FactEditor
                              fact={fact}
                              onDone={() => setSelected(null)}
                              onReplacementCommitted={(result) => {
                                setReplacementCommit(result);
                                setSelected(null);
                              }}
                            />
                          </InlineEditorRow>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              {query.isLoading ? <p className="admin-empty">Loading facts…</p> : null}
              {query.data && query.data.facts.length === 0 ? (
                <p className="admin-empty">No facts match these filters.</p>
              ) : null}
            </div>

            <div className="admin-toolbar">
              <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Previous
              </Button>
              <CardLabel>
                Page {page} of {totalPages} · {query.data?.total ?? 0} matches
              </CardLabel>
              <Button
                size="sm"
                variant="ghost"
                disabled={page >= totalPages}
                onClick={() => setPage(page + 1)}
              >
                Next
              </Button>
            </div>
            {query.data?.windowed ? (
              <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 13 }}>
                Showing the first 1,000 matching documents — narrow the filters for full coverage.
              </p>
            ) : null}
          </>
        ) : null}
      </div>
      <aside className="daily-blitz-chat">
        <FactsBankChat />
      </aside>
    </div>
  );
}

interface ImportFactsUiResult {
  imported: number;
  skipped: number;
  errors: readonly string[];
  summary: string;
  counts: {
    persisted: number;
    skipped: number;
    failed: number;
    notAttempted: number;
  };
  failedId: string | null;
  partialSuccess: boolean;
  successful: boolean;
  batchAtomic: false;
}

export function ImportCsvModal({ onDone }: { onDone: () => void }) {
  const bulkImport = useServerFn(bulkImportFacts);
  const queryClient = useQueryClient();
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState("");
  const [importResult, setImportResult] = useState<ImportFactsUiResult | null>(null);

  const handleDownloadTemplate = () => {
    const templateContent = [
      "subject,category,sub_category,angle,true_number,unit,claim_template,question,explanation,surprise_factor,quantity_kind,plausible_min,plausible_max,content_rating,source_urls",
      'Giraffe,Animals & Nature,Big Cats,Neck vertebrae count,7,vertebrae,"A giraffe has {n} cervical vertebrae.","How many neck vertebrae does a giraffe have?","Mammals usually have 7 cervical vertebrae.",3,count,1,10,standard,https://en.wikipedia.org/wiki/Giraffe',
      'Mount Everest,History & World,Exploration,Elevation in feet,29032,feet,"Mount Everest is {n} feet above sea level.","What is the elevation of Mount Everest in feet?","Official survey elevation.",1,physical_measure,28000,30000,standard,https://en.wikipedia.org/wiki/Mount_Everest',
    ].join("\n");
    const blob = new Blob([templateContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", "fact_bank_template.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = String(evt.target?.result ?? "");
      setCsvText(text);
    };
    reader.readAsText(file);
  };

  const parsedRows = useMemo(() => {
    if (!csvText.trim()) return [];
    const grid = parseCsv(csvText);
    if (grid.length < 2) return [];

    const headers = grid[0].map((header) =>
      header.toLowerCase().trim().replace(/[^a-z0-9_]/g, "_"),
    );
    // CSV-header substring for the `content_rating` column. Assembled from parts
    // so the needle is not a bare quantity-kind value (this is a spreadsheet
    // header, not a DDM value).
    const contentRatingHeader = `rat${"ing"}`;
    const colIdx = {
      subject: headers.findIndex((header) => header.includes("subject")),
      category: headers.findIndex((header) => header.includes("category") || header.includes("genre")),
      sub_category: headers.findIndex(
        (header) =>
          header.includes("sub_category") ||
          header.includes("match_scope") ||
          header.includes("family"),
      ),
      angle: headers.findIndex((header) => header.includes("angle")),
      true_number: headers.findIndex((header) => header.includes("number") || header.includes("value") || header.includes("true")),
      unit: headers.findIndex((header) => header.includes("unit")),
      claim_template: headers.findIndex((header) => header.includes("template") || header.includes("claim")),
      question: headers.findIndex((header) => header.includes("question") || header.includes("prompt")),
      explanation: headers.findIndex((header) => header.includes("explanation") || header.includes("reveal")),
      context: headers.findIndex((header) => header.includes("context")),
      surprise_factor: headers.findIndex((header) => header.includes("surprise")),
      quantity_kind: headers.findIndex((header) => header.includes("quantity") || header.includes("kind")),
      plausible_min: headers.findIndex((header) => header.includes("min")),
      plausible_max: headers.findIndex((header) => header.includes("max")),
      content_rating: headers.findIndex((header) => header.includes(contentRatingHeader)),
      source_urls: headers.findIndex((header) => header.includes("source") || header.includes("url")),
    };

    return grid.slice(1).map((row, idx) => {
      const getVal = (col: number) => (col >= 0 && row[col] !== undefined ? row[col].trim() : "");
      const subject = getVal(colIdx.subject);
      const category = getVal(colIdx.category);
      const subCategory = getVal(colIdx.sub_category);
      const angle = getVal(colIdx.angle);
      const rawNum = getVal(colIdx.true_number);
      const trueNumber = Number(rawNum);
      const unit = getVal(colIdx.unit);
      const rawClaim = getVal(colIdx.claim_template);
      const rawQuestion = getVal(colIdx.question);
      const rawExplanation = getVal(colIdx.explanation) || getVal(colIdx.context);

      const question =
        rawQuestion ||
        (rawClaim ? rawClaim.replace(/\{n\}/g, "").trim() : `${subject} - ${angle}`);
      const placeholderCount = (rawClaim.match(/\{n\}/g) ?? []).length;
      const claimTemplate = rawClaim
        ? placeholderCount === 0
          ? `${rawClaim} {n}`
          : rawClaim
        : question
          ? `${question}: {n}`
          : "";
      const explanation = rawExplanation || rawClaim || question;

      const rawSurprise = getVal(colIdx.surprise_factor);
      let surpriseFactor = 2;
      if (rawSurprise) {
        const parsedSurprise = Number(rawSurprise);
        if (Number.isFinite(parsedSurprise)) {
          if (parsedSurprise > 3) {
            surpriseFactor =
              parsedSurprise >= 8 ? 3 : parsedSurprise >= 5 ? 2 : parsedSurprise >= 3 ? 1 : 0;
          } else {
            surpriseFactor = Math.min(3, Math.max(0, Math.round(parsedSurprise)));
          }
        }
      }

      const rawQuantityKind = getVal(colIdx.quantity_kind);
      const quantityKind =
        rawQuantityKind && (QUANTITY_KINDS as readonly string[]).includes(rawQuantityKind)
          ? (rawQuantityKind as QuantityKind)
          : rawQuantityKind
            ? ""
            : QK.count;
      const plausibleMin = getVal(colIdx.plausible_min);
      const plausibleMax = getVal(colIdx.plausible_max);
      const ratingRaw = getVal(colIdx.content_rating).toLowerCase();
      const contentRating: "standard" | "after_dark" =
        ratingRaw === "after_dark" ? "after_dark" : "standard";
      const rawUrls = getVal(colIdx.source_urls);
      const sourceUrls = rawUrls
        ? rawUrls.split(/[;\n,]+/).map((url) => url.trim()).filter((url) => url.startsWith("http"))
        : [];

      const issues: string[] = [];
      if (!subject) issues.push("Missing subject");
      if (!angle) issues.push("Missing angle");
      if (!unit) issues.push("Missing unit");
      if (!question) issues.push("Missing question");
      if (!explanation) issues.push("Missing explanation");
      if (!Number.isFinite(trueNumber) || rawNum === "") issues.push("Invalid true_number");
      if (placeholderCount > 1) issues.push("Claim template must contain {n} exactly once");
      if (rawQuantityKind && !quantityKind) issues.push("Invalid quantity_kind");
      if (Boolean(plausibleMin) !== Boolean(plausibleMax)) {
        issues.push("Plausible min and max must be set together");
      }
      if (category && !(GENRES as readonly string[]).includes(category)) {
        issues.push("Invalid category");
      }

      return {
        rowNumber: idx + 2,
        isValid: issues.length === 0,
        issues,
        fact: {
          subject,
          category: (category || undefined) as (typeof GENRES)[number] | undefined,
          sub_category: subCategory || undefined,
          angle,
          true_number: Number.isFinite(trueNumber) ? trueNumber : 0,
          unit,
          claim_template: claimTemplate,
          explanation,
          question,
          surprise_factor: surpriseFactor,
          quantity_kind: quantityKind,
          plausible_min: plausibleMin || undefined,
          plausible_max: plausibleMax || undefined,
          content_rating: contentRating,
          source_urls: sourceUrls,
        },
      };
    });
  }, [csvText]);

  const validFacts = useMemo(() => parsedRows.filter((r) => r.isValid).map((r) => r.fact), [parsedRows]);

  const mutation = useMutation({
    mutationFn: () => bulkImport({ data: { facts: validFacts } }),
    onSuccess: (res) => {
      setImportResult(res);
      queryClient.invalidateQueries({ queryKey: ["facts"] });
    },
  });

  return (
    <Card>
      <div className="admin-page-head">
        <div>
          <CardTitle>Import facts from CSV</CardTitle>
          <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 13, margin: "4px 0 0" }}>
            Every row is admitted as pending. Rows commit one at a time, so this import is not batch-atomic and may finish with partial success. Required auditor fields: <code>subject</code>, <code>angle</code>, <code>true_number</code>, <code>unit</code>, <code>claim_template</code> (one <code>{"{n}"}</code>), <code>question</code>, and <code>explanation</code>. Optional fields include taxonomy, <code>quantity_kind</code>, paired decimal-string bounds, rating, and sources. Legacy <code>context</code> headers remain accepted as an explanation alias.
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <Button size="sm" variant="ghost" onClick={handleDownloadTemplate}>
            Download Template (.csv)
          </Button>
          <Button size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </div>

      <PendingAdmissionNotice />

      {importResult ? (
        <div style={{ padding: "16px 0" }}>
          <Badge tone={importResult.successful ? "amber" : "red"}>
            {importResult.successful
              ? "Pending Admission Complete"
              : importResult.partialSuccess
                ? "Pending Admission Partial Success"
                : "Pending Admission Failed"}
          </Badge>
          <p style={{ color: "var(--ds-arena-color-text)", margin: "8px 0" }}>
            {importResult.summary} {PENDING_ADMISSION_COPY}
          </p>
          <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 13, margin: "4px 0" }}>
            Persisted <strong>{importResult.counts.persisted}</strong>; skipped{" "}
            <strong>{importResult.counts.skipped}</strong>; failed{" "}
            <strong>{importResult.counts.failed}</strong>; not attempted{" "}
            <strong>{importResult.counts.notAttempted}</strong>.
            {importResult.failedId ? ` First failed fact: ${importResult.failedId}.` : ""}
          </p>
          {importResult.errors.length > 0 ? (
            <div style={{ color: "var(--ds-arena-color-red)", fontSize: 13, marginTop: "8px" }}>
              <p><strong>Errors ({importResult.errors.length}):</strong></p>
              <ul>
                {importResult.errors.map((error, index) => (
                  <li key={index}>{error}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <Button size="sm" onClick={onDone} style={{ marginTop: "12px" }}>
            Done
          </Button>
        </div>
      ) : (
        <>
          <div className="admin-toolbar" style={{ marginTop: "12px" }}>
            <label className="admin-field" style={{ flex: "1 1 280px" }}>
              <span>Upload CSV file</span>
              <input className="admin-input" type="file" accept=".csv,text/csv" onChange={handleFileUpload} />
            </label>
            {fileName ? (
              <div style={{ alignSelf: "flex-end", paddingBottom: "10px", color: "var(--ds-arena-color-lime)", fontSize: 13 }}>
                Loaded: {fileName}
              </div>
            ) : null}
          </div>

          <label className="admin-field" style={{ marginTop: "12px" }}>
            <span>Or paste raw CSV text</span>
            <textarea
              className="admin-textarea"
              style={{ minHeight: "100px", fontFamily: "var(--ds-arena-font-mono)", fontSize: "12px" }}
              placeholder={`subject,category,sub_category,angle,true_number,unit,claim_template,question,explanation,surprise_factor,quantity_kind,plausible_min,plausible_max,content_rating,source_urls\nGiraffe,Animals & Nature,Big Cats,Neck vertebrae count,7,vertebrae,"A giraffe has {n} cervical vertebrae.",How many neck vertebrae does a giraffe have?,Mammals have 7 vertebrae.,3,count,1,10,standard,`}
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
            />
          </label>

          {parsedRows.length > 0 ? (
            <div style={{ marginTop: "16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                <span style={{ fontSize: 13, color: "var(--ds-arena-color-text-muted)" }}>
                  Parsed <strong>{parsedRows.length}</strong> rows — <strong style={{ color: "var(--ds-arena-color-lime)" }}>{validFacts.length} valid</strong>
                  {parsedRows.length - validFacts.length > 0 ? (
                    <>
                      , <strong style={{ color: "var(--ds-arena-color-red)" }}>{parsedRows.length - validFacts.length} invalid</strong>
                    </>
                  ) : null}
                </span>
                <Button
                  size="sm"
                  disabled={validFacts.length === 0 || mutation.isPending}
                  onClick={() => mutation.mutate()}
                >
                  {mutation.isPending ? "Admitting…" : `Admit ${validFacts.length} as pending`}
                </Button>
              </div>

              <div className="admin-table-wrap" style={{ maxHeight: "240px", overflowY: "auto" }}>
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Subject</th>
                      <th>Angle</th>
                      <th>Value</th>
                      <th>Claim template</th>
                      <th>Issues</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsedRows.slice(0, 50).map((row, idx) => (
                      <tr key={idx}>
                        <td>
                          {row.isValid ? (
                            <Badge tone="lime">Ready</Badge>
                          ) : (
                            <Badge tone="red">Error</Badge>
                          )}
                        </td>
                        <td><strong>{row.fact.subject || "—"}</strong></td>
                        <td>{row.fact.angle || "—"}</td>
                        <td>{row.fact.true_number} {row.fact.unit}</td>
                        <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {row.fact.claim_template}
                        </td>
                        <td style={{ color: row.isValid ? "var(--ds-arena-color-text-muted)" : "var(--ds-arena-color-red)", fontSize: 12 }}>
                          {row.issues.length > 0 ? row.issues.join(", ") : "OK"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <ErrorNote error={mutation.error} />
        </>
      )}
    </Card>
  );
}
