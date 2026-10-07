import { Badge } from "@/index";

type LintSeverity = "severe" | "review" | "warn";

type LintField =
  | "subject"
  | "question"
  | "claim_template"
  | "unit"
  | "true_number"
  | "number_token"
  | "quantity_kind"
  | "plausible_min"
  | "plausible_max"
  | "derivation"
  | "precomputed_derivation"
  | "derivation_input_fingerprint"
  | "surprise_factor";

interface LintRule {
  title: string;
  severity: LintSeverity;
  fields: LintField[];
  check: string;
  guidance: string;
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
}

const FIELD_LABELS: Record<LintField, string> = {
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
};

/**
 * Summaries of the stable rules in agent-go/factlint.go. The Foundry detail
 * string is not persisted to admin reports, so this catalog describes rule
 * semantics and never presents a per-run linter message as report data.
 */
const LINT_RULES: Record<string, LintRule> = {
  year_kind_mismatch: {
    title: "Year question uses a non-year kind or unit",
    severity: "severe",
    fields: ["question", "claim_template", "unit", "quantity_kind", "true_number"],
    check: "The question or claim reads as asking for a calendar year, but the fact is not classified or measured as a year.",
    guidance: "Confirm the question asks for a calendar year. If it does, use a year unit and quantity kind; otherwise rewrite the question so it asks for the stored quantity.",
  },
  year_number_mismatch: {
    title: "Year question has a non-calendar answer",
    severity: "severe",
    fields: ["question", "claim_template", "true_number"],
    check: "The question strongly reads as asking for a year, while true_number is outside the accepted calendar-year range.",
    guidance: "Check the source and true_number, then confirm the question really asks for a year. Correct the fact or reword the question to match the intended answer.",
  },
  year_future_decoy: {
    title: "Historical year fact has a future bound or distractor",
    severity: "severe",
    fields: ["true_number", "unit", "quantity_kind", "plausible_max", "derivation", "precomputed_derivation"],
    check: "For a past year fact, a stored upper bound or generated presented number exceeds the retrospective year ceiling, or cannot be read as a year.",
    guidance: "Verify the historical answer and inspect plausible_max plus the stored derivation block. Correct the bound or regenerate the block so no distractor is later than the retrospective ceiling.",
  },
  one_sided_block: {
    title: "Derivation has distractors on only one side",
    severity: "severe",
    fields: ["true_number", "derivation", "precomputed_derivation"],
    check: "The stored derivation block has MORE distractors or LESS distractors, but not both (apart from the canonical-zero exception).",
    guidance: "Check the true answer and regenerate the derivation block so the fact has usable choices on both sides.",
  },
  label_unit: {
    title: "Unit looks like a label, not a measurement",
    severity: "review",
    fields: ["unit", "subject"],
    check: "The unit value looks like a category, label, or fragment of the subject rather than a measurement unit.",
    guidance: "Use the quantity being counted or measured as unit (for example, a count or physical unit), not the subject name or category.",
  },
  question_leaks_number: {
    title: "Question reveals the stored answer",
    severity: "review",
    fields: ["question", "true_number"],
    check: "The question text contains the fact's true_number, which can give away the answer before the guess.",
    guidance: "Rewrite the question to ask for the quantity without stating the answer number.",
  },
  invalid_true_number: {
    title: "True number is missing or not usable",
    severity: "review",
    fields: ["true_number"],
    check: "true_number is missing, non-finite, or cannot be ingested as a supported numeric value.",
    guidance: "Verify the source value and store a finite number in the supported numeric format.",
  },
  malformed_claim_template: {
    title: "Claim template must have one answer slot",
    severity: "review",
    fields: ["claim_template"],
    check: "A non-empty claim_template has no {n} slot or contains {n} more than once.",
    guidance: "Rewrite claim_template so it includes exactly one {n} where the true number belongs.",
  },
  number_token_mismatch: {
    title: "Number token disagrees with true number",
    severity: "review",
    fields: ["number_token", "true_number"],
    check: "The stored number_token parses to a different value than true_number.",
    guidance: "Verify the source answer, then correct the mismatching token or true_number so both represent the same value.",
  },
  invalid_quantity_kind: {
    title: "Quantity kind is not supported",
    severity: "review",
    fields: ["quantity_kind"],
    check: "A non-empty quantity_kind is not in the supported closed set.",
    guidance: "Choose a supported quantity kind for this fact, or clear an unintended stored override so it can be classified.",
  },
  kind_domain_mismatch: {
    title: "True number falls outside the quantity kind's domain",
    severity: "review",
    fields: ["quantity_kind", "true_number"],
    check: "The stored quantity_kind does not allow the fact's true_number, such as a percentage outside 0–100.",
    guidance: "Check the source answer and whether quantity_kind describes it correctly; correct whichever value is wrong.",
  },
  bounds_incoherent: {
    title: "Plausible bounds are incomplete or inconsistent",
    severity: "review",
    fields: ["plausible_min", "plausible_max", "true_number"],
    check: "Only one plausible bound is set, or the bounds are invalid, reversed, or exclude true_number.",
    guidance: "Set both bounds in ascending order and make sure the true answer is inside them, or clear both if no hint is intended.",
  },
  bounds_over_ceiling: {
    title: "Plausible maximum exceeds the unit ceiling",
    severity: "review",
    fields: ["unit", "plausible_max", "derivation", "precomputed_derivation"],
    check: "A stored plausible_max hint or derivation bound exceeds the known maximum for this unit.",
    guidance: "Verify the unit and its known range. Correct the maximum and refresh the derivation block if its stored bound is also too high.",
  },
  unusable_block: {
    title: "Derivation block has no distractors",
    severity: "review",
    fields: ["derivation", "precomputed_derivation"],
    check: "The stored derivation block contains zero distractors.",
    guidance: "Regenerate the derivation block and confirm it contains playable alternatives.",
  },
  conflicting_answer: {
    title: "Same or similar question has conflicting answers",
    severity: "review",
    fields: ["question", "subject", "true_number"],
    check: "An exact or near-matching question appears on another fact with a different true_number.",
    guidance: "Compare the matched facts and verify their sources and scope. Correct the wrong answer or make the questions distinct if they ask different things.",
  },
  question_not_statement: {
    title: "Question is phrased as a question rather than a statement",
    severity: "review",
    fields: ["question"],
    check: "The question contains a question mark or is phrased as an interrogative question rather than a declarative prompt or statement.",
    guidance: "Rewrite the prompt as a declarative statement or noun phrase (e.g. 'Calvin Johnson single-season receiving yards record' instead of 'How many receiving yards did Calvin Johnson gain...?').",
  },
  duplicate_question: {
    title: "Question duplicates another fact",
    severity: "review",
    fields: ["question", "subject", "true_number"],
    check: "An exact or near-matching question appears on another fact with the same true_number.",
    guidance: "Use the existing duplicate comparison below to confirm whether these are truly redundant, then keep the canonical fact and resolve the duplicate report.",
  },
  shared_generic_question: {
    title: "Generic question is shared across subjects",
    severity: "review",
    fields: ["question", "subject", "claim_template"],
    check: "The same normalized question is attached to facts for multiple subjects.",
    guidance: "Make each question identify the specific subject or entity it asks about.",
  },
  question_missing_entity: {
    title: "Question may not identify its subject",
    severity: "warn",
    fields: ["question", "subject", "claim_template"],
    check: "The question has little distinctive wording in common with the subject or claim entity, or uses only a generic role.",
    guidance: "Check that a player can tell which entity the question is about; add the name or a distinctive identifier when needed.",
  },
  question_measure_mismatch: {
    title: "Question measure may not match its answer",
    severity: "warn",
    fields: ["question", "claim_template", "unit"],
    check: "Measure word(s) in question are absent from both unit and the claim context around its {n} answer slot.",
    guidance: "Compare the measure asked for in question with unit and the wording around {n} in claim_template. If they describe different quantities, align all three fields. This warning is a heuristic signal, not proof that the fact is wrong.",
  },
  question_scope_mismatch: {
    title: "Question scope may not match the claim",
    severity: "warn",
    fields: ["question", "claim_template"],
    check: "The question may ask for an aggregate while the claim describes one instance, or the claim may name a statistic the question does not ask for.",
    guidance: "Check whether both texts ask about the same scope and statistic; rewrite the question or claim to make them agree.",
  },
  bounds_chart_position: {
    title: "Chart-position bounds may be out of range",
    severity: "review",
    fields: ["unit", "question", "claim_template", "plausible_min", "plausible_max"],
    check: "A chart position starts below 1, or its plausible maximum exceeds a chart size identified by the question or claim.",
    guidance: "Confirm the chart and rank. Set the minimum to at least 1 and keep the maximum within the identified chart's size.",
  },
  missing_block: {
    title: "Fact has no stored derivation block",
    severity: "warn",
    fields: ["derivation", "precomputed_derivation"],
    check: "Neither derivation nor precomputed_derivation is present on the fact.",
    guidance: "Check whether Foundry should generate the missing block. This warning alone does not say the fact's answer is wrong.",
  },
  stale_block: {
    title: "Stored derivation may be stale",
    severity: "warn",
    fields: ["derivation", "precomputed_derivation", "derivation_input_fingerprint", "true_number", "unit", "quantity_kind", "plausible_min", "plausible_max", "surprise_factor"],
    check: "The derivation block uses a different model version or its stored input fingerprint differs from the current fact inputs.",
    guidance: "Check whether answer, unit, kind, bounds, or surprise factor changed after the block was generated; refresh the derivation if inputs have changed.",
  },
  missing_bounds_hint: {
    title: "Fact has no persisted plausible bounds",
    severity: "warn",
    fields: ["quantity_kind", "plausible_min", "plausible_max"],
    check: "A count, physical measure, money, or duration fact has no persisted plausible_min hint.",
    guidance: "Consider adding a plausible range when it would constrain distractors usefully. This is informational and does not mean the answer is wrong.",
  },
  missing_source: {
    title: "Fact is missing source URLs",
    severity: "severe",
    fields: ["question", "claim_template"],
    check: "The fact document has no verified source URLs.",
    guidance: "Provide at least one verified source URL supporting the fact's true number before promotion.",
  },
  reverify_weak_sourcing: {
    title: "Re-verified number changed without supporting source or context",
    severity: "severe",
    fields: ["true_number", "question", "claim_template"],
    check: "Re-verification moved true_number but lacks a supporting source URL or explanatory revision context.",
    guidance: "Add a source URL supporting the new number and explain the revision (or timestamped reference) in the fact explanation.",
  },
  moving_target_stale_risk: {
    title: "Claim implies a moving target or current record without a time bound",
    severity: "review",
    fields: ["claim_template", "question"],
    check: "The claim implies a current record, world record, or superlative ('most ever') without an explicit temporal bound.",
    guidance: "Add bounded phrasing (e.g. 'as of the end of the 2025 season') or rephrase the claim to be non-time-sensitive.",
  },
};

const SEVERITY_LABELS: Record<LintSeverity, string> = {
  severe: "Severe · export blocker",
  review: "Review · human decision required",
  warn: "Warning · does not quarantine by itself",
};

const SEVERITY_TONES: Record<LintSeverity, "red" | "amber"> = {
  severe: "red",
  review: "amber",
  warn: "amber",
};

function displayValue(field: LintField, value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (field === "derivation" || field === "precomputed_derivation") {
    return value && typeof value === "object" ? "Stored block is present" : null;
  }
  return null;
}

export function LintFindings({
  flags,
  evidence,
}: {
  flags: string[];
  evidence?: LintEvidence;
}) {
  const uniqueFlags = [...new Set(flags.map((flag) => flag.trim()).filter(Boolean))];
  if (uniqueFlags.length === 0) return null;

  return (
    <section className="admin-lint-findings" aria-label="Fact Foundry quality findings">
      <p className="admin-lint-findings__intro">
        Foundry’s per-run detail is not saved in this report. These summaries explain each rule; field values below come from the current fact or report snapshot.
      </p>
      <div className="admin-lint-findings__list">
        {uniqueFlags.map((flag, index) => {
          const rule = LINT_RULES[flag];
          const evidenceFields = rule?.fields.flatMap((field) => {
            const value = displayValue(field, evidence?.[field]);
            return value ? [{ field, value }] : [];
          }) ?? [];

          return (
            <article
              key={`${flag}-${index}`}
              className={`admin-lint-finding${rule ? ` admin-lint-finding--${rule.severity}` : " admin-lint-finding--unknown"}`}
              aria-labelledby={`admin-lint-finding-title-${index}`}
            >
              <header className="admin-lint-finding__header">
                <div>
                  <h4 id={`admin-lint-finding-title-${index}`}>
                    {rule?.title ?? "Unrecognized quality flag"}
                  </h4>
                  <code>{flag}</code>
                </div>
                <Badge tone={rule ? SEVERITY_TONES[rule.severity] : "neutral"}>
                  {rule ? SEVERITY_LABELS[rule.severity] : "Severity unknown"}
                </Badge>
              </header>

              {rule ? (
                <>
                  <div className="admin-lint-finding__fields">
                    <strong>Fields to inspect</strong>
                    <div>
                      {rule.fields.map((field) => (
                        <code key={field}>{FIELD_LABELS[field]}</code>
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
                      <p>{rule.guidance}</p>
                    </div>
                  </div>
                  {evidenceFields.length > 0 ? (
                    <div className="admin-lint-finding__evidence">
                      <strong>Current field values</strong>
                      <dl>
                        {evidenceFields.map(({ field, value }) => (
                          <div key={field}>
                            <dt><code>{FIELD_LABELS[field]}</code></dt>
                            <dd>{value}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  ) : null}
                  {rule.severity === "warn" ? (
                    <p className="admin-lint-finding__warning">
                      Warning-only flags are review heuristics; by themselves they do not prove the fact is wrong.
                    </p>
                  ) : null}
                </>
              ) : (
                <div className="admin-lint-finding__copy">
                  <div>
                    <strong>What the linter checks</strong>
                    <p>No local explanation is registered for this flag ID.</p>
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
