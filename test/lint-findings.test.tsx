import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LintFindings } from "@/admin/LintFindings";
import {
  LINT_ENFORCEMENTS,
  LINT_RULES,
  LINT_RULES_BY_ID,
  LINT_SEVERITIES,
} from "../shared/fact-lint-catalog.gen";

function renderFindings(
  flags: string[],
  evidence?: Parameters<typeof LintFindings>[0]["evidence"],
  findings?: Parameters<typeof LintFindings>[0]["findings"],
): string {
  return renderToStaticMarkup(createElement(LintFindings, { flags, evidence, findings }));
}

describe("canonical lint catalog artifact", () => {
  it("is complete, sorted, and self-consistent", () => {
    expect(LINT_RULES.length).toBeGreaterThan(20);
    const ids = LINT_RULES.map((rule) => rule.id);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(LINT_RULES_BY_ID.size).toBe(LINT_RULES.length);
    for (const rule of LINT_RULES) {
      expect(LINT_SEVERITIES).toContain(rule.severity);
      expect(LINT_ENFORCEMENTS).toContain(rule.enforcement);
      expect(rule.title).toBeTruthy();
      expect(rule.check).toBeTruthy();
      expect(rule.remediation).toBeTruthy();
      expect(rule.fields.length).toBeGreaterThan(0);
      expect(typeof rule.overridable).toBe("boolean");
      expect(LINT_RULES_BY_ID.get(rule.id)).toBe(rule);
    }
  });

  it("carries Go's true severities for the rules the hand-written catalog had wrong", () => {
    // These drifted in the old hand-maintained catalog (year_future_decoy,
    // missing_source, and reverify_weak_sourcing were shown as severe;
    // label_unit as review). The generated catalog keeps Go authoritative.
    expect(LINT_RULES_BY_ID.get("year_future_decoy")?.severity).toBe("warn");
    expect(LINT_RULES_BY_ID.get("missing_source")?.severity).toBe("review");
    expect(LINT_RULES_BY_ID.get("reverify_weak_sourcing")?.severity).toBe("review");
    expect(LINT_RULES_BY_ID.get("label_unit")?.severity).toBe("warn");
  });

  it("declares the noun-phrase prompt contract as a blocking severe rule", () => {
    const rule = LINT_RULES_BY_ID.get("prompt_not_statement");
    expect(rule).toBeDefined();
    expect(rule?.severity).toBe("severe");
    expect(rule?.enforcement).toBe("block");
    expect(rule?.fields).toContain("question");
  });
});

describe("Fact Foundry lint findings", () => {
  it("explains question_not_statement and shows the inspected claim field", () => {
    const html = renderFindings(["question_not_statement"], {
      claim_template: "How many receiving yards did Calvin Johnson gain in the 2012 NFL season?",
    });

    expect(html).toContain("Claim is phrased as a question rather than a statement");
    expect(html).toContain("Review · human decision required");
    expect(html).toContain("claim_template");
    expect(html).toContain("How many receiving yards did Calvin Johnson gain");
  });

  it("explains prompt_not_statement as a blocking finding", () => {
    const html = renderFindings(["prompt_not_statement"], {
      question: "What year did the Titanic sink?",
    });

    expect(html).toContain("Prompt is phrased as an interrogative question");
    expect(html).toContain("Severe · export blocker");
    expect(html).toContain("noun phrase");
    expect(html).toContain("What year did the Titanic sink?");
  });

  it("renders producer-authored detail and related fact IDs from structured findings", () => {
    const html = renderFindings(
      [],
      undefined,
      [
        {
          id: "conflicting_answer",
          severity: "review",
          enforcement: "review_required",
          detail: "same-fact identity conflict with abc123, answers 1989 vs 1956",
          docIds: ["abc123"],
        },
      ],
    );

    expect(html).toContain("same-fact identity conflict with abc123");
    expect(html).toContain("Related fact IDs");
    expect(html).toContain("abc123");
    expect(html).toContain("Findings recorded by the fact linter");
  });

  it("explains question_measure_mismatch and shows the current question, claim, and unit", () => {
    const html = renderFindings(["question_measure_mismatch"], {
      question: "How many interception return yards did the player have?",
      claim_template: "The player recorded {n} career interceptions.",
      unit: "interceptions",
    });

    expect(html).toContain("Question measure may not match its answer");
    expect(html).toContain("Warning · does not quarantine by itself");
    expect(html).toContain("claim_template");
    expect(html).toContain("Warning-only flags are review heuristics");
    expect(html).toContain("How many interception return yards did the player have?");
    expect(html).toContain("The player recorded {n} career interceptions.");
    expect(html).toContain("interceptions</dd>");
    expect(html).toContain("flag IDs only");
  });

  it("keeps duplicate guidance visible for the duplicate_question rule", () => {
    const html = renderFindings(["duplicate_question"]);

    expect(html).toContain("Question duplicates another fact");
    expect(html).toContain("duplicate_question");
  });

  it("preserves unrecognized IDs and does not infer their severity", () => {
    const html = renderFindings(["future_rule_id"]);

    expect(html).toContain("future_rule_id");
    expect(html).toContain("Unrecognized quality flag");
    expect(html).toContain("Severity unknown");
    expect(html).toContain("No catalog entry is registered");
  });

  it("has a catalog entry for every rule ID the catalog declares", () => {
    const html = renderFindings(LINT_RULES.map((rule) => rule.id));

    expect(html).not.toContain("Unrecognized quality flag");
    expect(html.match(/class="admin-lint-finding /g)).toHaveLength(LINT_RULES.length);
  });
});
