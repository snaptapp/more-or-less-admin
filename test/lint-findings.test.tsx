import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LintFindings } from "@/admin/LintFindings";

const FOUNDRY_FLAG_IDS = [
  "year_kind_mismatch",
  "year_number_mismatch",
  "year_future_decoy",
  "one_sided_block",
  "label_unit",
  "question_leaks_number",
  "invalid_true_number",
  "malformed_claim_template",
  "number_token_mismatch",
  "invalid_quantity_kind",
  "kind_domain_mismatch",
  "bounds_incoherent",
  "bounds_over_ceiling",
  "unusable_block",
  "conflicting_answer",
  "duplicate_question",
  "shared_generic_question",
  "question_missing_entity",
  "question_measure_mismatch",
  "question_scope_mismatch",
  "bounds_chart_position",
  "missing_block",
  "stale_block",
  "missing_bounds_hint",
];

function renderFindings(flags: string[], evidence?: Parameters<typeof LintFindings>[0]["evidence"]): string {
  return renderToStaticMarkup(createElement(LintFindings, { flags, evidence }));
}

describe("Fact Foundry lint findings", () => {
  it("explains question_measure_mismatch and shows the current question, claim, and unit", () => {
    const html = renderFindings(["question_measure_mismatch"], {
      question: "How many interception return yards did the player have?",
      claim_template: "The player recorded {n} career interceptions.",
      unit: "interceptions",
    });

    expect(html).toContain("Question measure may not match its answer");
    expect(html).toContain("Warning · does not quarantine by itself");
    expect(html).toContain("Measure word(s) in question are absent from both unit");
    expect(html).toContain("claim_template");
    expect(html).toContain("Warning-only flags are review heuristics");
    expect(html).toContain("How many interception return yards did the player have?");
    expect(html).toContain("The player recorded {n} career interceptions.");
    expect(html).toContain("interceptions</dd>");
    expect(html).toContain("align all three fields");
    expect(html).toContain("per-run detail is not saved");
  });

  it("keeps duplicate guidance visible alongside the existing compare-and-resolve path", () => {
    const html = renderFindings(["duplicate_question"]);

    expect(html).toContain("Question duplicates another fact");
    expect(html).toContain("existing duplicate comparison below");
    expect(html).toContain("duplicate_question");
  });

  it("preserves unrecognized IDs and does not infer their severity", () => {
    const html = renderFindings(["future_rule_id"]);

    expect(html).toContain("future_rule_id");
    expect(html).toContain("Unrecognized quality flag");
    expect(html).toContain("Severity unknown");
    expect(html).toContain("No local explanation is registered");
  });

  it("has a summary for every current Foundry rule ID", () => {
    const html = renderFindings(FOUNDRY_FLAG_IDS);

    expect(html).not.toContain("Unrecognized quality flag");
    expect(html.match(/class="admin-lint-finding /g)).toHaveLength(FOUNDRY_FLAG_IDS.length);
  });
});
