import {
  FACT_STATUSES,
  QUANTITY_KINDS,
  type FactStatus,
  type QuantityKind,
} from "../../../shared/fact-lifecycle-contract.gen";
import {
  FACT_QUALITY_REGISTRY,
  type FactQualityMeasure,
  type FactQualityUnit,
} from "../../../shared/fact-quality/fact-quality-units.gen";
import { normalizeKey } from "../firebase/firestore.server";
import { GENRES, type Genre } from "./taxonomy";

/**
 * The versioned quantity descriptor (Go QuantitySpecV1). Admin admission may
 * carry a proposed spec on a pending fact for the auditor; admission never
 * approves it. Field names mirror the Go contract byte for byte.
 */
export interface QuantitySpec {
  schema_version: number;
  entity_key: string;
  measure_key: string;
  relation: string;
  aggregation: string;
  unit_id: string;
  scale_numerator?: string;
  scale_denominator?: string;
  temporal?: {
    mode: string;
    start?: string;
    end?: string;
    observed_at?: string;
  };
  value_semantics: string;
  display_decimal_places: number;
  quantum_token?: string;
}

const STATUS: { [K in FactStatus]: K } = (() => {
  const statuses = {} as { [K in FactStatus]: K };
  for (const value of FACT_STATUSES) statuses[value] = value as never;
  return statuses;
})();

export const PENDING_FACT_STATUS = STATUS.pending;

export const PENDING_FACT_ORIGINS = [
  "admin_portal",
  "csv_import",
  "report_add",
] as const;

export type PendingFactOrigin = (typeof PENDING_FACT_ORIGINS)[number];

export const CONTENT_RATINGS = ["standard", "after_dark"] as const;
export type ContentRating = (typeof CONTENT_RATINGS)[number];
export const DEFAULT_CONTENT_RATING: ContentRating = "standard";

/** User- or import-supplied fields accepted by the admission builder. */
export interface PendingFactInput {
  subject: string;
  category?: Genre | null;
  sub_category?: string | null;
  angle: string;
  true_number: number;
  /** Optional exact decimal token for the truth; must project to true_number. */
  true_number_token?: string;
  /** Optional proposed quantity spec; the Foundry auditor owns approval. */
  quantity_spec?: QuantitySpec | null;
  /** Optional measurement/edition year kept separate from verification time. */
  as_of_year?: number | null;
  unit: string;
  claim_template: string;
  question: string;
  explanation?: string | null;
  /** Legacy input alias. The builder persists only canonical `explanation`. */
  context?: string | null;
  source_urls?: readonly string[];
  surprise_factor?: number;
  quantity_kind: QuantityKind;
  plausible_min?: string | null;
  plausible_max?: string | null;
  number_pinned?: boolean;
  pinned_reason?: string | null;
  /** Defaults to `standard` when omitted. */
  content_rating?: ContentRating;
  origin: PendingFactOrigin;
}

/** Exact Firestore payload emitted for auditor admission. */
export type PendingFact = {
  subject: string;
  subject_key: string;
  category: Genre | null;
  sub_category: string | null;
  angle: string;
  angle_key: string;
  true_number: number;
  true_number_token?: string;
  quantity_spec?: QuantitySpec;
  as_of_year?: number;
  unit: string;
  claim_template: string;
  question: string;
  explanation: string;
  source_urls: string[];
  surprise_factor: number;
  quantity_kind: QuantityKind;
  plausible_min?: string;
  plausible_max?: string;
  number_pinned?: boolean;
  pinned_reason?: string;
  content_rating: ContentRating;
  status: typeof PENDING_FACT_STATUS;
  origin: PendingFactOrigin;
  created_at: string;
  updated_at: string;
};

export interface PendingFactIssue {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export type PendingFactValidationResult =
  | { readonly ok: true; readonly fact: PendingFact; readonly issues: readonly [] }
  | {
      readonly ok: false;
      readonly fact: null;
      readonly issues: readonly PendingFactIssue[];
    };

const REQUIRED_FIELDS = [
  "subject",
  "subject_key",
  "category",
  "sub_category",
  "angle",
  "angle_key",
  "true_number",
  "unit",
  "claim_template",
  "question",
  "explanation",
  "source_urls",
  "surprise_factor",
  "quantity_kind",
  "content_rating",
  "status",
  "origin",
  "created_at",
  "updated_at",
] as const;

const OPTIONAL_FIELDS = [
  "plausible_min",
  "plausible_max",
  "number_pinned",
  "pinned_reason",
  "true_number_token",
  "quantity_spec",
  "as_of_year",
] as const;

const ALLOWED_FIELDS = new Set<string>([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);
const SAFE_MANTISSA = 9_007_199_254_740_991n;
const DECIMAL_TOKEN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function issue(
  issues: PendingFactIssue[],
  field: string,
  code: string,
  message: string,
): void {
  issues.push({ field, code, message });
}

function invalid(issues: readonly PendingFactIssue[]): PendingFactValidationResult {
  return { ok: false, fact: null, issues };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): unknown {
  return typeof value === "string" ? value.trim() : value;
}

function nonEmpty(
  record: Record<string, unknown>,
  field: string,
  issues: PendingFactIssue[],
): string | null {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    issue(issues, field, "required", "must be a non-empty string");
    return null;
  }
  return value.trim();
}

function nullableText(
  record: Record<string, unknown>,
  field: string,
  issues: PendingFactIssue[],
): string | null | undefined {
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== "string") {
    issue(issues, field, "type", "must be a string or null");
    return undefined;
  }
  return value.trim();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isSourceUrlArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.trim() !== "")
  );
}

function isQuantityKind(value: unknown): value is QuantityKind {
  return typeof value === "string" && QUANTITY_KINDS.some((kind) => kind === value);
}

function isPendingFactOrigin(value: unknown): value is PendingFactOrigin {
  return typeof value === "string" && PENDING_FACT_ORIGINS.some((origin) => origin === value);
}

function isContentRating(value: unknown): value is ContentRating {
  return typeof value === "string" && CONTENT_RATINGS.some((rating) => rating === value);
}

function isGenre(value: unknown): value is Genre {
  return typeof value === "string" && GENRES.some((genre) => genre === value);
}

function isQuantitySpec(value: unknown): value is QuantitySpec {
  if (!isRecord(value)) return false;
  const temporal = value["temporal"];
  return (
    value["schema_version"] === 1 &&
    isNonEmptyString(value["entity_key"]) &&
    isNonEmptyString(value["measure_key"]) &&
    isNonEmptyString(value["relation"]) &&
    isNonEmptyString(value["aggregation"]) &&
    isNonEmptyString(value["unit_id"]) &&
    isNonEmptyString(value["value_semantics"]) &&
    Number.isInteger(value["display_decimal_places"]) &&
    (temporal === undefined || isRecord(temporal)) &&
    (value["scale_numerator"] === undefined ||
      typeof value["scale_numerator"] === "string") &&
    (value["scale_denominator"] === undefined ||
      typeof value["scale_denominator"] === "string") &&
    (value["quantum_token"] === undefined || typeof value["quantum_token"] === "string")
  );
}

/**
 * Projection helper for consumers that need the spec off a stored doc. It is
 * structural only: closed-set membership lives in validatePendingFact.
 */
export function parseQuantitySpec(value: unknown): QuantitySpec | null {
  return isQuantitySpec(value) ? value : null;
}

function isPendingStatus(value: unknown): value is typeof PENDING_FACT_STATUS {
  return value === PENDING_FACT_STATUS;
}

function isCanonicalSurprise(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3;
}

/** Structural type guard for the exact payload after semantic validation. */
function isPendingFactRecord(value: Record<string, unknown>): value is PendingFact {
  const createdAt = value["created_at"];
  const updatedAt = value["updated_at"];
  const category = value["category"];
  const subCategory = value["sub_category"];
  return (
    isNonEmptyString(value["subject"]) &&
    isNonEmptyString(value["subject_key"]) &&
    isNonEmptyString(value["angle"]) &&
    isNonEmptyString(value["angle_key"]) &&
    isNonEmptyString(value["unit"]) &&
    isNonEmptyString(value["claim_template"]) &&
    isNonEmptyString(value["question"]) &&
    isNonEmptyString(value["explanation"]) &&
    (category === null || isGenre(category)) &&
    (subCategory === null || typeof subCategory === "string") &&
    typeof value["true_number"] === "number" &&
    Number.isFinite(value["true_number"]) &&
    isSourceUrlArray(value["source_urls"]) &&
    isCanonicalSurprise(value["surprise_factor"]) &&
    isQuantityKind(value["quantity_kind"]) &&
    isContentRating(value["content_rating"]) &&
    isPendingStatus(value["status"]) &&
    isPendingFactOrigin(value["origin"]) &&
    typeof createdAt === "string" &&
    isCanonicalTimestamp(createdAt) &&
    typeof updatedAt === "string" &&
    isCanonicalTimestamp(updatedAt) &&
    (value["plausible_min"] === undefined || typeof value["plausible_min"] === "string") &&
    (value["plausible_max"] === undefined || typeof value["plausible_max"] === "string") &&
    (value["number_pinned"] === undefined || typeof value["number_pinned"] === "boolean") &&
    (value["pinned_reason"] === undefined || typeof value["pinned_reason"] === "string") &&
    (value["true_number_token"] === undefined ||
      typeof value["true_number_token"] === "string") &&
    (value["quantity_spec"] === undefined || isQuantitySpec(value["quantity_spec"])) &&
    (value["as_of_year"] === undefined || typeof value["as_of_year"] === "number")
  );
}

function canonicalSurpriseFactor(value: unknown): unknown {
  if (typeof value !== "number" || !Number.isInteger(value)) return value;
  if (value <= 3) return Math.max(0, value);
  if (value >= 8) return 3;
  if (value >= 5) return 2;
  return 1;
}

function categoryMatchKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
    .replaceAll(" & ", " and ");
}

function canonicalCategory(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  const candidate = categoryMatchKey(value);
  return GENRES.find((genre) => categoryMatchKey(genre) === candidate) ?? value.trim();
}

function sourceUrls(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value
    .map((item) => (typeof item === "string" ? item.trim() : item))
    .filter((item) => typeof item !== "string" || item.length > 0);
}

function explanation(input: PendingFactInput): unknown {
  const canonical = text(input.explanation);
  if (typeof canonical === "string" && canonical !== "") return canonical;
  return text(input.context) ?? "";
}

function hasBound(value: string | null | undefined): boolean {
  return value !== undefined && value !== null;
}

function candidate(input: PendingFactInput, timestamp: string): Record<string, unknown> {
  const subject = text(input.subject);
  const angle = text(input.angle);
  const value: Record<string, unknown> = {
    subject,
    subject_key: typeof subject === "string" ? normalizeKey(subject) : "",
    category: canonicalCategory(input.category),
    sub_category: input.sub_category == null ? null : text(input.sub_category),
    angle,
    angle_key: typeof angle === "string" ? normalizeKey(angle) : "",
    true_number: input.true_number,
    unit: text(input.unit),
    claim_template: text(input.claim_template),
    question: text(input.question),
    explanation: explanation(input),
    source_urls: input.source_urls === undefined ? [] : sourceUrls(input.source_urls),
    surprise_factor: canonicalSurpriseFactor(
      input.surprise_factor === undefined ? 2 : input.surprise_factor,
    ),
    quantity_kind: text(input.quantity_kind),
    content_rating: input.content_rating ?? DEFAULT_CONTENT_RATING,
    status: PENDING_FACT_STATUS,
    origin: input.origin,
    created_at: timestamp,
    updated_at: timestamp,
  };

  if (hasBound(input.plausible_min) || hasBound(input.plausible_max)) {
    value["plausible_min"] = text(input.plausible_min);
    value["plausible_max"] = text(input.plausible_max);
  }
  if (input.number_pinned !== undefined) value["number_pinned"] = input.number_pinned;
  if (hasBound(input.pinned_reason)) value["pinned_reason"] = text(input.pinned_reason);
  if (input.true_number_token !== undefined) {
    value["true_number_token"] = text(input.true_number_token);
  }
  if (input.quantity_spec !== undefined && input.quantity_spec !== null) {
    value["quantity_spec"] = input.quantity_spec;
  }
  if (input.as_of_year !== undefined && input.as_of_year !== null) {
    value["as_of_year"] = input.as_of_year;
  }
  return value;
}

/** Parse a JSON decimal into the DDM's scale-3 exact comparison space. */
function ingestDecimal(token: string): bigint | null {
  if (token.length > 128 || !DECIMAL_TOKEN.test(token)) return null;
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match) return null;

  const exponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1_000_000) return null;
  const fractionLength = match[3]?.length ?? 0;
  const shift = exponent - fractionLength + 3;
  if (shift < -43) return 0n;

  const digits = `${match[2]}${match[3] ?? ""}`;
  const coefficient = BigInt(digits);
  let magnitude: bigint;
  if (shift >= 0) {
    if (shift > 64) return null;
    magnitude = coefficient * 10n ** BigInt(shift);
  } else {
    const divisor = 10n ** BigInt(-shift);
    magnitude = coefficient / divisor;
    const remainder = coefficient % divisor;
    if (remainder * 2n >= divisor) magnitude += 1n;
  }

  if (magnitude > SAFE_MANTISSA) return null;
  return match[1] === "-" ? -magnitude : magnitude;
}

function isCanonicalTimestamp(value: string | null): value is string {
  if (value === null) return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function validateUnknownFields(
  record: Record<string, unknown>,
  issues: PendingFactIssue[],
): void {
  for (const field of Object.keys(record)) {
    if (ALLOWED_FIELDS.has(field)) continue;
    const code = field === "verified_at" || field === "verifier_model" ? "forbidden" : "unknown";
    issue(issues, field, code, "is not part of the pending admission schema");
  }
}

function validateTaxonomy(
  subject: string | null,
  category: string | null | undefined,
  subCategory: string | null | undefined,
  issues: PendingFactIssue[],
): void {
  const levels = [
    { field: "category", value: category },
    { field: "sub_category", value: subCategory },
    { field: "subject", value: subject },
  ].filter(
    (level): level is { field: string; value: string } =>
      typeof level.value === "string" && level.value !== "",
  );
  for (let left = 0; left < levels.length; left += 1) {
    for (let right = left + 1; right < levels.length; right += 1) {
      if (normalizeKey(levels[left].value) === normalizeKey(levels[right].value)) {
        issue(
          issues,
          levels[right].field,
          "taxonomy",
          `must differ from ${levels[left].field}`,
        );
      }
    }
  }
}

function validateSourceUrls(record: Record<string, unknown>, issues: PendingFactIssue[]): void {
  const value = record["source_urls"];
  if (!Array.isArray(value)) {
    issue(issues, "source_urls", "type", "must be an array of source URL strings");
    return;
  }
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.trim() === "") {
      issue(issues, `source_urls.${index}`, "type", "must be a non-empty string");
    }
  }
}

function validateQuantityKind(record: Record<string, unknown>, issues: PendingFactIssue[]): void {
  const kind = nonEmpty(record, "quantity_kind", issues);
  if (kind === null) return;
  if (!(QUANTITY_KINDS as readonly string[]).includes(kind)) {
    issue(issues, "quantity_kind", "closed_set", "must be a member of the shared contract");
  }
}

function validateBounds(
  record: Record<string, unknown>,
  truth: bigint | null,
  issues: PendingFactIssue[],
): void {
  const hasMin = Object.hasOwn(record, "plausible_min");
  const hasMax = Object.hasOwn(record, "plausible_max");
  if (!hasMin && !hasMax) return;
  if (!hasMin || !hasMax) {
    issue(
      issues,
      hasMin ? "plausible_max" : "plausible_min",
      "bounds_pair",
      "must be set together with the opposite bound",
    );
    return;
  }

  const minToken = nonEmpty(record, "plausible_min", issues);
  const maxToken = nonEmpty(record, "plausible_max", issues);
  if (minToken === null || maxToken === null) return;
  const min = ingestDecimal(minToken);
  const max = ingestDecimal(maxToken);
  if (min === null || max === null) {
    issue(issues, "plausible_min", "bounds_numeric", "bounds must be finite JSON decimal strings");
    return;
  }
  if (truth === null || min > max || truth < min || truth > max) {
    issue(
      issues,
      "plausible_min",
      "bounds_coherence",
      "bounds must be ordered and contain true_number",
    );
  }
}

/**
 * A stored token must project to the same value as the float field. Admission
 * compares at the shared scale-3 projection the DDM stores; the Go evaluator
 * re-checks the token against the exact rational at audit time, so a token
 * that disagrees only below the envelope still fails the audit, never here.
 */
function validateTrueNumberToken(
  record: Record<string, unknown>,
  truth: bigint | null,
  issues: PendingFactIssue[],
): void {
  if (!Object.hasOwn(record, "true_number_token")) return;
  const token = record["true_number_token"];
  if (typeof token !== "string" || !DECIMAL_TOKEN.test(token.trim())) {
    issue(issues, "true_number_token", "token", "must be an exact JSON decimal token");
    return;
  }
  if (truth === null) return;
  const ingested = ingestDecimal(token.trim());
  if (ingested === null || ingested !== truth) {
    issue(
      issues,
      "true_number_token",
      "token_mismatch",
      "must project to the same value as true_number",
    );
  }
}

/**
 * Structural plus closed-set validation of a proposed quantity spec using the
 * generated unit registry. Admission validates membership and measure/unit
 * compatibility; it never approves the spec (the Foundry auditor owns that).
 */
function validateQuantitySpec(
  record: Record<string, unknown>,
  issues: PendingFactIssue[],
): void {
  if (!Object.hasOwn(record, "quantity_spec")) return;
  const spec = record["quantity_spec"];
  if (!isRecord(spec)) {
    issue(issues, "quantity_spec", "type", "must be an object");
    return;
  }
  if (spec["schema_version"] !== 1) {
    issue(issues, "quantity_spec.schema_version", "closed_set", "must be 1");
  }
  for (const key of ["entity_key", "measure_key", "relation", "aggregation", "unit_id", "value_semantics"]) {
    if (typeof spec[key] !== "string" || (spec[key] as string).trim() === "") {
      issue(issues, `quantity_spec.${key}`, "required", "must be a non-empty string");
    }
  }
  const relation = spec["relation"];
  if (typeof relation === "string" && !FACT_QUALITY_REGISTRY.relations.includes(relation)) {
    issue(issues, "quantity_spec.relation", "closed_set", "must be a registry relation");
  }
  const aggregation = spec["aggregation"];
  if (
    typeof aggregation === "string" &&
    !FACT_QUALITY_REGISTRY.aggregations.includes(aggregation)
  ) {
    issue(issues, "quantity_spec.aggregation", "closed_set", "must be a registry aggregation");
  }
  const valueSemantics = spec["value_semantics"];
  if (
    typeof valueSemantics === "string" &&
    !FACT_QUALITY_REGISTRY.value_semantics.includes(valueSemantics)
  ) {
    issue(issues, "quantity_spec.value_semantics", "closed_set", "must be a registry semantics");
  }
  const unitId = spec["unit_id"];
  const unit: FactQualityUnit | undefined =
    typeof unitId === "string" ? FACT_QUALITY_REGISTRY.units[unitId] : undefined;
  if (typeof unitId === "string" && unit === undefined) {
    issue(issues, "quantity_spec.unit_id", "closed_set", "must be a registry unit id");
  }
  const measureKey = spec["measure_key"];
  const measure: FactQualityMeasure | undefined =
    typeof measureKey === "string" ? FACT_QUALITY_REGISTRY.measures[measureKey] : undefined;
  if (typeof measureKey === "string" && measure === undefined) {
    issue(issues, "quantity_spec.measure_key", "closed_set", "must be a registry measure");
  }
  if (unit !== undefined && measure !== undefined) {
    if (!measure.bases.includes(unit.base)) {
      issue(
        issues,
        "quantity_spec.unit_id",
        "spec_coherence",
        `unit base ${unit.base} is not declared by measure ${String(measureKey)}`,
      );
    }
    if (
      typeof aggregation === "string" &&
      !measure.aggregations.includes(aggregation)
    ) {
      issue(
        issues,
        "quantity_spec.aggregation",
        "spec_coherence",
        `aggregation is not declared by measure ${String(measureKey)}`,
      );
    }
  }
  const temporal = spec["temporal"];
  if (temporal !== undefined) {
    if (!isRecord(temporal)) {
      issue(issues, "quantity_spec.temporal", "type", "must be an object");
    } else {
      const mode = temporal["mode"];
      if (typeof mode !== "string" || !FACT_QUALITY_REGISTRY.temporal_modes.includes(mode)) {
        issue(issues, "quantity_spec.temporal.mode", "closed_set", "must be a registry mode");
      }
      for (const bound of ["start", "end", "observed_at"] as const) {
        const member = temporal[bound];
        if (member !== undefined && typeof member !== "string") {
          issue(issues, `quantity_spec.temporal.${bound}`, "type", "must be a string");
        }
      }
    }
  }
  const places = spec["display_decimal_places"];
  if (
    typeof places !== "number" ||
    !Number.isInteger(places) ||
    places < 0 ||
    places > 3
  ) {
    issue(issues, "quantity_spec.display_decimal_places", "range", "must be an integer 0..3");
  }
}

function validateAsOfYear(record: Record<string, unknown>, issues: PendingFactIssue[]): void {
  if (!Object.hasOwn(record, "as_of_year")) return;
  const value = record["as_of_year"];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    issue(issues, "as_of_year", "type", "must be an integer measurement or edition year");
  }
}

function validatePinnedFields(record: Record<string, unknown>, issues: PendingFactIssue[]): void {
  if (Object.hasOwn(record, "number_pinned") && typeof record["number_pinned"] !== "boolean") {
    issue(issues, "number_pinned", "type", "must be a boolean");
  }
  if (Object.hasOwn(record, "pinned_reason") && typeof record["pinned_reason"] !== "string") {
    issue(issues, "pinned_reason", "type", "must be a string");
  }
}

/** Validate an exact built payload without mutating it. */
export function validatePendingFact(value: unknown): PendingFactValidationResult {
  if (!isRecord(value)) {
    return invalid([{ field: "fact", code: "type", message: "must be an object" }]);
  }

  const issues: PendingFactIssue[] = [];
  validateUnknownFields(value, issues);
  const subject = nonEmpty(value, "subject", issues);
  const subjectKey = nonEmpty(value, "subject_key", issues);
  const angle = nonEmpty(value, "angle", issues);
  const angleKey = nonEmpty(value, "angle_key", issues);
  nonEmpty(value, "unit", issues);
  const claimTemplate = nonEmpty(value, "claim_template", issues);
  nonEmpty(value, "question", issues);
  nonEmpty(value, "explanation", issues);
  const category = nullableText(value, "category", issues);
  const subCategory = nullableText(value, "sub_category", issues);

  if (subject !== null && subjectKey !== normalizeKey(subject)) {
    issue(issues, "subject_key", "canonical_key", "must match the canonical subject key");
  }
  if (angle !== null && angleKey !== normalizeKey(angle)) {
    issue(issues, "angle_key", "canonical_key", "must match the canonical angle key");
  }
  if (claimTemplate !== null && claimTemplate.split("{n}").length - 1 !== 1) {
    issue(issues, "claim_template", "placeholder_count", "must contain {n} exactly once");
  }

  const trueNumber = value["true_number"];
  let truth: bigint | null = null;
  if (typeof trueNumber !== "number" || !Number.isFinite(trueNumber)) {
    issue(issues, "true_number", "finite", "must be a finite number");
  } else {
    truth = ingestDecimal(String(trueNumber));
    if (truth === null) {
      issue(issues, "true_number", "numeric_ingest", "must be ingestable by the Go DDM");
    }
  }

  const surpriseFactor = value["surprise_factor"];
  if (
    typeof surpriseFactor !== "number" ||
    !Number.isInteger(surpriseFactor) ||
    surpriseFactor < 0 ||
    surpriseFactor > 3
  ) {
    issue(issues, "surprise_factor", "range", "must be a canonical integer from 0 through 3");
  }

  if (typeof category === "string" && !(GENRES as readonly string[]).includes(category)) {
    issue(issues, "category", "closed_set", "must be a canonical category");
  }
  validateTaxonomy(subject, category, subCategory, issues);
  validateSourceUrls(value, issues);
  validateQuantityKind(value, issues);
  validateBounds(value, truth, issues);
  validateTrueNumberToken(value, truth, issues);
  validateQuantitySpec(value, issues);
  validateAsOfYear(value, issues);
  validatePinnedFields(value, issues);

  if (!isContentRating(value["content_rating"])) {
    issue(issues, "content_rating", "closed_set", "must be standard or after_dark");
  }
  if (value["status"] !== PENDING_FACT_STATUS) {
    issue(issues, "status", "status", "must be the pending lifecycle status");
  }
  if (!(PENDING_FACT_ORIGINS as readonly string[]).includes(String(value["origin"]))) {
    issue(issues, "origin", "closed_set", "must be a declared admission origin");
  }
  const createdAt = nonEmpty(value, "created_at", issues);
  const updatedAt = nonEmpty(value, "updated_at", issues);
  if (!isCanonicalTimestamp(createdAt)) {
    issue(issues, "created_at", "timestamp", "must be a canonical ISO-8601 timestamp");
  }
  if (!isCanonicalTimestamp(updatedAt)) {
    issue(issues, "updated_at", "timestamp", "must be a canonical ISO-8601 timestamp");
  }
  if (
    isCanonicalTimestamp(createdAt) &&
    isCanonicalTimestamp(updatedAt) &&
    Date.parse(createdAt) > Date.parse(updatedAt)
  ) {
    issue(issues, "updated_at", "timestamp_order", "must not precede created_at");
  }

  if (issues.length > 0) return invalid(issues);
  if (!isPendingFactRecord(value)) {
    return invalid([{ field: "fact", code: "incomplete", message: "is incomplete" }]);
  }
  return { ok: true, fact: value, issues: [] };
}

export class PendingFactValidationError extends Error {
  override readonly name = "PendingFactValidationError";
  readonly issues: readonly PendingFactIssue[];

  constructor(issues: readonly PendingFactIssue[]) {
    super(
      `Pending fact admission rejected: ${issues
        .map((item) => `${item.field} ${item.message}`)
        .join("; ")}`,
    );
    this.issues = [...issues];
  }
}

/** Build one exact, auditor-consumable pending fact without persistence or I/O. */
export function buildPendingFact(
  input: PendingFactInput,
  timestamp = new Date().toISOString(),
): PendingFact {
  const result = validatePendingFact(candidate(input, timestamp));
  if (!result.ok) throw new PendingFactValidationError(result.issues);
  return result.fact;
}

export function isValidPendingFact(value: unknown): value is PendingFact {
  return validatePendingFact(value).ok;
}
