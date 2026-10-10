import { describe, expect, it } from "vitest";

import {
  buildPendingFact,
  isValidPendingFact,
  PENDING_FACT_ORIGINS,
  PENDING_FACT_STATUS,
  PendingFactValidationError,
  validatePendingFact,
  type PendingFact,
  type PendingFactInput,
} from "@/lib/admin/fact-admission";
import { QUANTITY_KINDS, type QuantityKind } from "../shared/fact-lifecycle-contract.gen";
import { GENRES } from "@/lib/admin/taxonomy";
import { blockedNetworkAttempts } from "./setup";

const TIMESTAMP = "2026-09-24T12:00:00.000Z";
const QUANTITY_KIND = QUANTITY_KINDS[0];
const CATEGORY = GENRES[7];

function input(overrides: Partial<PendingFactInput> = {}): PendingFactInput {
  return {
    subject: "  Mount Everest  ",
    category: CATEGORY,
    sub_category: "  Exploration  ",
    angle: "  First ascent year  ",
    true_number: 1953,
    unit: "year",
    claim_template: "Mount Everest was first climbed in {n}.",
    question: "When was Mount Everest first climbed?",
    explanation: "Tenzing Norgay and Edmund Hillary made the first confirmed ascent.",
    source_urls: [" https://example.com/everest "],
    surprise_factor: 2,
    quantity_kind: QUANTITY_KIND,
    origin: PENDING_FACT_ORIGINS[0],
    ...overrides,
  };
}

function issueFields(value: unknown): string[] {
  const result = validatePendingFact(value);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected pending fact validation to fail");
  return result.issues.map((item) => item.field);
}

describe("pending fact admission", () => {
  it("builds the exact auditor-facing payload with canonical keys and no verification metadata", () => {
    const fact = buildPendingFact(
      input({
        surprise_factor: 8,
        plausible_min: "1900",
        plausible_max: "2000",
        number_pinned: true,
        pinned_reason: "Confirmed against the expedition record.",
      }),
      TIMESTAMP,
    );

    expect(fact).toEqual({
      subject: "Mount Everest",
      subject_key: "mount everest",
      category: CATEGORY,
      sub_category: "Exploration",
      angle: "First ascent year",
      angle_key: "first ascent year",
      true_number: 1953,
      unit: "year",
      claim_template: "Mount Everest was first climbed in {n}.",
      question: "When was Mount Everest first climbed?",
      explanation: "Tenzing Norgay and Edmund Hillary made the first confirmed ascent.",
      source_urls: ["https://example.com/everest"],
      surprise_factor: 3,
      quantity_kind: QUANTITY_KIND,
      plausible_min: "1900",
      plausible_max: "2000",
      number_pinned: true,
      pinned_reason: "Confirmed against the expedition record.",
      content_rating: "standard",
      status: PENDING_FACT_STATUS,
      origin: PENDING_FACT_ORIGINS[0],
      created_at: TIMESTAMP,
      updated_at: TIMESTAMP,
    });
    expect(Object.keys(fact).sort()).toEqual(
      [
        "angle",
        "angle_key",
        "category",
        "claim_template",
        "content_rating",
        "created_at",
        "explanation",
        "number_pinned",
        "origin",
        "pinned_reason",
        "plausible_max",
        "plausible_min",
        "question",
        "quantity_kind",
        "source_urls",
        "status",
        "subject",
        "subject_key",
        "sub_category",
        "surprise_factor",
        "true_number",
        "unit",
        "updated_at",
      ].sort(),
    );
    expect(fact).not.toHaveProperty("verified_at");
    expect(fact).not.toHaveProperty("verifier_model");
  });

  it("accepts every declared origin and always lands in the pending state", () => {
    for (const origin of PENDING_FACT_ORIGINS) {
      const fact = buildPendingFact(input({ origin }), TIMESTAMP);
      expect(fact.origin).toBe(origin);
      expect(fact.status).toBe(PENDING_FACT_STATUS);
    }
  });

  it("defaults content_rating to standard and persists after_dark when supplied", () => {
    expect(buildPendingFact(input(), TIMESTAMP).content_rating).toBe("standard");
    expect(
      buildPendingFact(input({ content_rating: "after_dark" }), TIMESTAMP).content_rating,
    ).toBe("after_dark");
    expect(
      issueFields({ ...buildPendingFact(input(), TIMESTAMP), content_rating: "spicy" }),
    ).toContain("content_rating");
  });

  it("uses legacy context only as an input alias and persists canonical explanation", () => {
    const legacy = buildPendingFact(
      input({ explanation: undefined, context: "  Legacy reveal copy.  " }),
      TIMESTAMP,
    );
    const canonical = buildPendingFact(
      input({ explanation: "Canonical reveal copy.", context: "Legacy reveal copy." }),
      TIMESTAMP,
    );

    expect(legacy.explanation).toBe("Legacy reveal copy.");
    expect(legacy).not.toHaveProperty("context");
    expect(canonical.explanation).toBe("Canonical reveal copy.");
    expect(canonical).not.toHaveProperty("context");
  });

  it("omits absent bounds and pinned metadata as a pair", () => {
    const fact = buildPendingFact(input(), TIMESTAMP);

    expect(fact).not.toHaveProperty("plausible_min");
    expect(fact).not.toHaveProperty("plausible_max");
    expect(fact).not.toHaveProperty("number_pinned");
    expect(fact).not.toHaveProperty("pinned_reason");
  });

  it("canonicalizes the Go legacy surprise bands into 0 through 3", () => {
    const expected = [0, 1, 2, 3, 1, 2, 2, 2, 3, 3, 3];
    for (const [raw, canonical] of expected.entries()) {
      expect(buildPendingFact(input({ surprise_factor: raw }), TIMESTAMP).surprise_factor).toBe(
        canonical,
      );
    }
  });

  it("copies source URLs so later input mutation cannot alter the built fact", () => {
    const sourceUrls = ["https://example.com/one", "https://example.com/two"];
    const fact = buildPendingFact(input({ source_urls: sourceUrls }), TIMESTAMP);
    sourceUrls[0] = "https://example.com/mutated";

    expect(fact.source_urls).toEqual([
      "https://example.com/one",
      "https://example.com/two",
    ]);
    expect(fact.source_urls).not.toBe(sourceUrls);
  });

  it("validates a built payload without mutating it", () => {
    const fact = buildPendingFact(input(), TIMESTAMP);
    const before = structuredClone(fact);
    const result = validatePendingFact(fact);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected pending fact validation to pass");
    expect(result.fact).toBe(fact);
    expect(fact).toEqual(before);
    expect(isValidPendingFact(fact)).toBe(true);
  });

  it.each(["angle", "unit", "question", "explanation"] as const)(
    "rejects a missing %s at the admission boundary",
    (field) => {
      const candidate = { ...buildPendingFact(input(), TIMESTAMP), [field]: "" };
      expect(issueFields(candidate)).toContain(field);
      expect(() => buildPendingFact(input({ [field]: "" }), TIMESTAMP)).toThrow(
        PendingFactValidationError,
      );
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite true_number %s",
    (trueNumber) => {
      const candidate = { ...buildPendingFact(input(), TIMESTAMP), true_number: trueNumber };
      expect(issueFields(candidate)).toContain("true_number");
      expect(() => buildPendingFact(input({ true_number: trueNumber }), TIMESTAMP)).toThrow(
        /true_number/,
      );
    },
  );

  it.each([
    "Mount Everest was first climbed in 1953.",
    "Mount Everest was {n} metres high after {n} expeditions.",
  ])("rejects claim template without exactly one {n}: %s", (claimTemplate) => {
    expect(issueFields({ ...buildPendingFact(input(), TIMESTAMP), claim_template: claimTemplate })).toContain(
      "claim_template",
    );
  });

  it("rejects a quantity kind outside the generated closed set", () => {
    const invalidKind = "not-a-contract-kind" as QuantityKind;
    expect(issueFields({ ...buildPendingFact(input(), TIMESTAMP), quantity_kind: invalidKind })).toContain(
      "quantity_kind",
    );
  });

  it.each([
    { plausible_min: "1900" },
    { plausible_max: "2000" },
    { plausible_min: "2000", plausible_max: "1900" },
    { plausible_min: "1954", plausible_max: "2000" },
    { plausible_min: "not-a-number", plausible_max: "2000" },
  ])("rejects incoherent decimal-string bounds: %j", (bounds) => {
    const candidate = { ...buildPendingFact(input(), TIMESTAMP), ...bounds };
    expect(issueFields(candidate)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^plausible_(min|max)$/)]),
    );
  });

  it("rejects the rows the Go auditor decoder would silently skip", () => {
    expect(issueFields({})).toEqual(
      expect.arrayContaining([
        "angle",
        "angle_key",
        "true_number",
        "explanation",
        "question",
        "unit",
        "status",
        "origin",
      ]),
    );
    expect(issueFields({ ...buildPendingFact(input(), TIMESTAMP), angle: "   " })).toContain("angle");
    expect(
      issueFields({
        ...buildPendingFact(input(), TIMESTAMP),
        true_number: "1953",
      }),
    ).toContain("true_number");
  });

  it("rejects forged canonical keys, non-pending status, and invalid origin", () => {
    const fact = buildPendingFact(input(), TIMESTAMP);

    expect(issueFields({ ...fact, subject_key: "mount_everest" })).toContain("subject_key");
    expect(issueFields({ ...fact, angle_key: "first-ascent-year" })).toContain("angle_key");
    expect(issueFields({ ...fact, status: "active" })).toContain("status");
    expect(issueFields({ ...fact, origin: "unknown_origin" })).toContain("origin");
  });

  it("rejects false verification metadata even when a candidate carries it", () => {
    const fact = buildPendingFact(input(), TIMESTAMP);
    const verified = { ...fact, verified_at: TIMESTAMP };
    const attributed = { ...fact, verifier_model: "admin_portal" };

    expect(issueFields(verified)).toContain("verified_at");
    expect(issueFields(attributed)).toContain("verifier_model");
  });

  it("requires canonical category values and distinct taxonomy levels", () => {
    const fact = buildPendingFact(input(), TIMESTAMP);
    expect(issueFields({ ...fact, category: "history" })).toContain("category");
    expect(issueFields({ ...fact, sub_category: "Mount Everest" })).toContain("subject");
  });

  it("accepts independent optional pin metadata and rejects wrong field types", () => {
    const fact = buildPendingFact(input(), TIMESTAMP);
    expect(validatePendingFact({ ...fact, number_pinned: true }).ok).toBe(true);
    expect(validatePendingFact({ ...fact, number_pinned: false }).ok).toBe(true);
    expect(validatePendingFact({ ...fact, pinned_reason: "Reviewed" }).ok).toBe(true);
    expect(issueFields({ ...fact, number_pinned: "true" })).toContain("number_pinned");
    expect(issueFields({ ...fact, pinned_reason: 42 })).toContain("pinned_reason");
  });

  it("performs no network or persistence I/O", () => {
    buildPendingFact(input(), TIMESTAMP);
    expect(blockedNetworkAttempts()).toEqual([]);
  });
});

describe("pending fact admission: exact-token and quality-spec fields", () => {
  const SPEC = {
    schema_version: 1,
    entity_key: "mount-everest",
    measure_key: "calendar_year_of_event",
    relation: "first_occurrence",
    aggregation: "single_event",
    unit_id: "calendar_year",
    temporal: { mode: "historical_event", observed_at: "1953" },
    value_semantics: "exact",
    display_decimal_places: 0,
  };

  it("carries an agreeing true_number_token onto the pending payload", () => {
    const fact = buildPendingFact(
      input({ true_number_token: "1953" }),
      TIMESTAMP,
    );
    expect(fact.true_number_token).toBe("1953");
    expect(validatePendingFact({ ...fact, true_number_token: "1.953e3" }).ok).toBe(true);
  });

  it("rejects a token that does not project to true_number", () => {
    expect(
      issueFields({ ...buildPendingFact(input(), TIMESTAMP), true_number_token: "1954" }),
    ).toContain("true_number_token");
    expect(
      issueFields({ ...buildPendingFact(input(), TIMESTAMP), true_number_token: "abc" }),
    ).toContain("true_number_token");
    expect(() => buildPendingFact(input({ true_number_token: "1954" }), TIMESTAMP)).toThrow(
      PendingFactValidationError,
    );
  });

  it("accepts a coherent proposed quantity_spec", () => {
    const fact = buildPendingFact(input({ quantity_spec: SPEC }), TIMESTAMP);
    expect(fact.quantity_spec).toEqual(SPEC);
    expect(validatePendingFact(fact).ok).toBe(true);
  });

  it("rejects specs outside the registry closed sets", () => {
    const bad = (patch: Record<string, unknown>) =>
      issueFields({
        ...buildPendingFact(input({ quantity_spec: SPEC }), TIMESTAMP),
        quantity_spec: { ...SPEC, ...patch },
      });
    expect(bad({ relation: "kind_of" })).toContain("quantity_spec.relation");
    expect(bad({ aggregation: "nope" })).toContain("quantity_spec.aggregation");
    expect(bad({ value_semantics: "vibes" })).toContain("quantity_spec.value_semantics");
    expect(bad({ unit_id: "smoots" })).toContain("quantity_spec.unit_id");
    expect(bad({ measure_key: "unknown_measure" })).toContain("quantity_spec.measure_key");
    expect(bad({ schema_version: 2 })).toContain("quantity_spec.schema_version");
    expect(bad({ display_decimal_places: 4 })).toContain(
      "quantity_spec.display_decimal_places",
    );
    expect(
      bad({ temporal: { mode: "sometime" } }),
    ).toContain("quantity_spec.temporal.mode");
  });

  it("rejects non-string temporal bound members", () => {
    const bad = (temporal: Record<string, unknown>) =>
      issueFields({
        ...buildPendingFact(input({ quantity_spec: SPEC }), TIMESTAMP),
        quantity_spec: { ...SPEC, temporal },
      });
    expect(bad({ mode: "historical_event", observed_at: 123 })).toContain(
      "quantity_spec.temporal.observed_at",
    );
    expect(bad({ mode: "historical_event", start: 1900 })).toContain(
      "quantity_spec.temporal.start",
    );
    expect(bad({ mode: "historical_event", end: null })).toContain(
      "quantity_spec.temporal.end",
    );
    // String bounds still validate.
    const fact = buildPendingFact(input({ quantity_spec: SPEC }), TIMESTAMP);
    expect(validatePendingFact(fact).ok).toBe(true);
  });

  it("rejects a spec whose measure cannot describe the unit's base quantity", () => {
    const spec = {
      ...SPEC,
      measure_key: "net_worth", // money base cannot pair with calendar_year
    };
    expect(
      issueFields({
        ...buildPendingFact(input({ quantity_spec: SPEC }), TIMESTAMP),
        quantity_spec: spec,
      }),
    ).toContain("quantity_spec.unit_id");
  });

  it("rejects a spec whose aggregation the measure does not declare", () => {
    const spec = {
      ...SPEC,
      measure_key: "calendar_year_of_event",
      aggregation: "mean", // calendar_year_of_event declares single_event only
    };
    expect(
      issueFields({
        ...buildPendingFact(input({ quantity_spec: SPEC }), TIMESTAMP),
        quantity_spec: spec,
      }),
    ).toContain("quantity_spec.aggregation");
  });

  it("carries an integer as_of_year and rejects non-integer values", () => {
    const fact = buildPendingFact(input({ as_of_year: 1989 }), TIMESTAMP);
    expect(fact.as_of_year).toBe(1989);
    expect(
      issueFields({ ...buildPendingFact(input(), TIMESTAMP), as_of_year: 1989.5 }),
    ).toContain("as_of_year");
    expect(
      issueFields({ ...buildPendingFact(input(), TIMESTAMP), as_of_year: "1989" }),
    ).toContain("as_of_year");
  });

  it("still rejects server-owned quality fields as unknown", () => {
    const fact = buildPendingFact(input(), TIMESTAMP);
    expect(issueFields({ ...fact, quality_receipt: {} })).toContain("quality_receipt");
    expect(issueFields({ ...fact, source_evidence: [] })).toContain("source_evidence");
    expect(issueFields({ ...fact, answer_uncertainty: {} })).toContain(
      "answer_uncertainty",
    );
  });
});
