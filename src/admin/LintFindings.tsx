import { Badge } from "@/index";
import {
  LINT_RULES_BY_ID,
  type LintEnforcement,
  type LintSeverity,
} from "../../shared/fact-lint-catalog.gen";

/**
 * One structured finding as persisted by `foundry -lint-apply`
 * (trivia_reports.lintFindings / fact_bank.lint_findings). `id` is the only
 * required member; older reports carry only the flag-id list in
 * `qualityFlags`.
 */
export interface LintFinding {
  id: string;
  severity?: LintSeverity;
  enforcement?: LintEnforcement;
  detail?: string;
  docIds?: string[];
}

export interface LintEvidence {
  subject?: string | null;
  question?: string | null;
  claim_template?: string | null;
  unit?: string | null;
  true_number?: string | number | null;
  number_token?: string | null;
  quantity_kind?: string | null;
  plausible_min?: string | null;
  plausible_max?: string | null;
  derivation?: unknown;
  precomputed_derivation?: unknown;
  derivation_input_fingerprint?: string | null;
  surprise_factor?: string | number | null;
  source_urls?: string[] | null;
  verified_at?: string | null;
  as_of_year?: string | number | null;
}

/**
 * Human labels for the fact fields the catalog rules inspect. Field names are
 * producer-declared strings; unknown future fields fall back to their raw
 * name rather than being dropped.
 */
const FIELD_LABELS: Record<string, string> = {
  subject: "subject",
  question: "question",
  claim_template: "claim_template",
  unit: "unit",
  true_number: "true_number",
  number_token: "number_token",
  quantity_kind: "quantity_kind",
  plausible_min: "plausible_min",
  plausible_max: "plausible_max",
  derivation: "derivation",
  precomputed_derivation: "precomputed_derivation",
  derivation_input_fingerprint: "derivation_input_fingerprint",
  surprise_factor: "surprise_factor",
  source_urls: "source_urls",
  verified_at: "verified_at",
  as_of_year: "as_of_year",
};

const ENFORCEMENT_LABELS: Record<LintEnforcement, string> = {
  block: "Severe · export blocker",
  review_required: "Review · human decision required",
  advisory: "Warning · does not quarantine by itself",
};

const SEVERITY_TONES: Record<LintSeverity, "red" | "amber"> = {
  severe: "red",
  review: "amber",
  warn: "amber",
};

function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

function displayValue(field: string, value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (field === "source_urls" && Array.isArray(value)) {
    const urls = value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
    return urls.length ? urls.join("\n") : null;
  }
  if (field === "derivation" || field === "precomputed_derivation") {
    return value && typeof value === "object" ? "Stored block is present" : null;
  }
  return null;
}

/**
 * Render quality findings against the canonical lint catalog generated from
 * agent-go/factlint_rules.go (shared/fact-lint-catalog.gen.ts). The local
 * hand-written catalog is gone on purpose: rule titles, severities, field
 * mappings, and guidance are producer-authored so Admin cannot drift from Go.
 * When the report carries structured lintFindings, the producer's own detail
 * string and related fact IDs are rendered verbatim.
 */
export function LintFindings({
  flags,
  findings,
  evidence,
}: {
  flags?: string[];
  findings?: LintFinding[];
  evidence?: LintEvidence;
}) {
  const entries: LintFinding[] =
    findings && findings.length > 0
      ? findings
      : (flags ?? [])
          .map((flag) => flag.trim())
          .filter(Boolean)
          .map((id) => ({ id }));
  const unique = [
    ...new Map(entries.map((entry) => [entry.id, entry])).values(),
  ];
  if (unique.length === 0) return null;
  const hasStructuredFindings = Boolean(findings && findings.length > 0);

  return (
    <section className="admin-lint-findings" aria-label="Fact Foundry quality findings">
      <p className="admin-lint-findings__intro">
        {hasStructuredFindings
          ? "Findings recorded by the fact linter for this revision. Rule text comes from the canonical Go catalog."
          : "This report carries flag IDs only (recorded before structured findings existed). Rule text comes from the canonical Go catalog; field values below come from the current fact or report snapshot."}
      </p>
      <div className="admin-lint-findings__list">
        {unique.map((finding, index) => {
          const rule = LINT_RULES_BY_ID.get(finding.id);
          const severity = finding.severity ?? rule?.severity;
          const enforcement = finding.enforcement ?? rule?.enforcement;
          const evidenceFields = rule?.fields.flatMap((field) => {
            const value = displayValue(field, evidence?.[field as keyof LintEvidence]);
            return value ? [{ field, value }] : [];
          }) ?? [];

          return (
            <article
              key={`${finding.id}-${index}`}
              className={`admin-lint-finding${severity ? ` admin-lint-finding--${severity}` : " admin-lint-finding--unknown"}`}
              aria-labelledby={`admin-lint-finding-title-${index}`}
            >
              <header className="admin-lint-finding__header">
                <div>
                  <h4 id={`admin-lint-finding-title-${index}`}>
                    {rule?.title ?? "Unrecognized quality flag"}
                  </h4>
                  <code>{finding.id}</code>
                </div>
                <Badge tone={severity ? SEVERITY_TONES[severity] : "neutral"}>
                  {enforcement ? ENFORCEMENT_LABELS[enforcement] : "Severity unknown"}
                </Badge>
              </header>

              {rule ? (
                <>
                  {finding.detail ? (
                    <div className="admin-lint-finding__copy">
                      <div>
                        <strong>What the linter found</strong>
                        <p>{finding.detail}</p>
                      </div>
                    </div>
                  ) : null}
                  {finding.docIds && finding.docIds.length > 0 ? (
                    <div className="admin-lint-finding__fields">
                      <strong>Related fact IDs</strong>
                      <div>
                        {finding.docIds.map((docId) => (
                          <code key={docId}>{docId}</code>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <div className="admin-lint-finding__fields">
                    <strong>Fields to inspect</strong>
                    <div>
                      {rule.fields.map((field) => (
                        <code key={field}>{fieldLabel(field)}</code>
                      ))}
                    </div>
                  </div>
                  <div className="admin-lint-finding__copy">
                    <div>
                      <strong>What the linter checks</strong>
                      <p>{rule.check}</p>
                    </div>
                    <div>
                      <strong>Review direction</strong>
                      <p>{rule.remediation}</p>
                    </div>
                  </div>
                  {evidenceFields.length > 0 ? (
                    <div className="admin-lint-finding__evidence">
                      <strong>Current field values</strong>
                      <dl>
                        {evidenceFields.map(({ field, value }) => (
                          <div key={field}>
                            <dt><code>{fieldLabel(field)}</code></dt>
                            <dd>{value}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  ) : null}
                  {severity === "warn" ? (
                    <p className="admin-lint-finding__warning">
                      Warning-only flags are review heuristics; by themselves they do not prove the fact is wrong.
                    </p>
                  ) : null}
                </>
              ) : (
                <div className="admin-lint-finding__copy">
                  <div>
                    <strong>What the linter checks</strong>
                    <p>No catalog entry is registered for this flag ID; it may predate the canonical catalog.</p>
                  </div>
                  <div>
                    <strong>Review direction</strong>
                    <p>Keep the ID visible and inspect the matched fact and its fields before deciding what to change.</p>
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
