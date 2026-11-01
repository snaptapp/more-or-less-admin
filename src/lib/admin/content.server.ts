/**
 * Fact bank + moderation logic. Server-only: every export assumes the caller
 * has already been authorized with `requireAdmin()`.
 */
import { z } from "zod";
import {
  createDoc,
  countCollection,
  factId,
  getDoc,
  normalizeKey,
  patchDoc,
  runQuery,
  runTransaction,
  type FirestoreDoc,
  type Json,
  type QueryFilter,
} from "../firebase/firestore.server";
import { type PreparedAuditEntry } from "../firebase/audit.server";
import { type AdminUser } from "../firebase/verify.server";
import { GENRES } from "./taxonomy";
import { QK } from "./contract";
import { parseDerivationBlock, type FactDerivationBlock } from "./daily-blitz";
import { isDuplicateFlag, isNonDuplicateFlag } from "./quality-flags";
import {
  runPerItemBatch,
  type BatchItemOutcome,
  type BatchMutationResult,
} from "./batch-mutation-semantics";
import {
  buildPendingFact,
  PENDING_FACT_ORIGINS,
  parseQuantitySpec,
  type PendingFact,
  type PendingFactInput,
  type PendingFactOrigin,
  type QuantitySpec,
} from "./fact-admission";
import {
  FACT_STATUSES as CONTRACT_FACT_STATUSES,
  QUANTITY_KINDS as CONTRACT_QUANTITY_KINDS,
  STATUS_TRANSITIONS,
  type FactStatus,
  type QuantityKind,
} from "../../../shared/fact-lifecycle-contract.gen";
import {
  LINT_ENFORCEMENTS,
  LINT_SEVERITIES,
  type LintEnforcement,
  type LintSeverity,
} from "../../../shared/fact-lint-catalog.gen";
import {
  appendQualityReview,
  buildQualityReview,
  currentFindingIds,
  DISPUTE_CLEAR_PATHS,
  MATERIAL_EDIT_KEYS,
  MATERIAL_INVALIDATION_PATHS,
  materialEditHold,
  QUALITY_REVIEW_KINDS,
  QUALITY_REVIEW_SCHEMA,
  type QualityReviewRecord,
} from "./quality-review";

import { areFactsDuplicateCandidates } from "./duplicate-candidates.server";

export {
  areFactsDuplicateCandidates,
  ENGLISH_STOP_WORDS,
  extractEntityTokens,
  normalizeQuestion,
} from "./duplicate-candidates.server";

// Derived from the shared contract (Requirement 9.1): the canonical status set
// is owned by Main_Repository and consumed here, so no hand-written literal list
// declares fact statuses in Admin_Repository source.
export const FACT_STATUSES = CONTRACT_FACT_STATUSES;
export type { FactStatus, QuantityKind };

// Named fact-status constants derived from the shared contract (Requirement
// 9.9): `STATUS.active === "active"`, etc. Referencing these instead of writing
// the raw literal keeps the canonical status set single-sourced in the artifact
// while the Contract_Literal_Check scan stays green. No status literal is
// written here — the keys and values both come from CONTRACT_FACT_STATUSES.
export const STATUS: { [K in FactStatus]: K } = (() => {
  const out = {} as { [K in FactStatus]: K };
  for (const value of CONTRACT_FACT_STATUSES) out[value] = value as never;
  return out;
})();
export const CONTENT_RATINGS = ["standard", "after_dark"] as const;
export const REPORT_STATUSES = ["pending_review", "resolved", "rejected"] as const;

const DEPLOYED_BANK_SCHEMA = z.object({
  bank_version: z.string().trim().min(1),
  fact_count: z.number().int().nonnegative(),
  ddm_version: z.string().trim().min(1),
});

const BANK_VERSION_TIMEOUT_MS = 5_000;

/** The only user-facing explanation of how Firestore state reaches players. */
export const HYDRATION_EXPLANATION =
  "Firestore changes go live only after export, hydration PR merge, and Worker deployment.";

/**
 * The comparison shown beside the deployed endpoint. It intentionally compares
 * source lifecycle state with the embedded serving bank; it is not a claim that
 * every active Firestore row is export-eligible (after-dark, flagged, duplicate,
 * or malformed rows are filtered by the export projection).
 */
export const EXPORTED_DELTA_DEFINITION =
  "Firestore active lifecycle count minus deployed fact_count; export filters can make the populations differ.";

type DeployedBankKnown = {
  readonly state: "known";
  readonly stale: false;
  readonly bankVersion: string;
  readonly factCount: number;
  readonly ddmVersion: string;
};

type DeployedBankUnknown = {
  readonly state: "unknown";
  readonly stale: true;
  readonly reason: string;
};

export type DeployedBank = DeployedBankKnown | DeployedBankUnknown;

export interface BankObservability {
  readonly checkedAt: string;
  readonly deployed: DeployedBank;
  readonly firestore: {
    readonly lifecycle: Readonly<Record<FactStatus, number>>;
    readonly total: number;
    readonly active: number;
  };
  /** Active Firestore rows minus embedded Worker facts; null when deployment is unknown. */
  readonly exportedDelta: number | null;
  readonly exportedDeltaDefinition: string;
}

export interface BankObservabilityDependencies {
  readonly fetch?: typeof fetch;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function unknownDeployed(reason: string): DeployedBankUnknown {
  return { state: "unknown", stale: true, reason };
}

function workerUrl(env: Readonly<Record<string, string | undefined>>): URL | null {
  const raw = (env["GAME_WORKER_URL"] ?? "").trim().replace(/\/+$/, "");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return new URL("/api/bank/version", url);
  } catch {
    return null;
  }
}

/** Read the public deployment stamp, degrading to an explicit unknown state. */
export async function fetchDeployedBank(
  deps: BankObservabilityDependencies = {},
): Promise<DeployedBank> {
  const url = workerUrl(deps.env ?? process.env);
  if (!url) return unknownDeployed("GAME_WORKER_URL is not configured with a valid HTTP(S) URL.");

  const request = deps.fetch ?? fetch;
  let response: Response;
  try {
    response = await request(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(BANK_VERSION_TIMEOUT_MS),
    });
  } catch {
    return unknownDeployed("The Game Worker bank-version endpoint could not be reached.");
  }

  if (!response.ok) {
    return unknownDeployed(`The Game Worker bank-version endpoint returned HTTP ${response.status}.`);
  }

  const parsed = DEPLOYED_BANK_SCHEMA.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    return unknownDeployed("The Game Worker bank-version endpoint returned an invalid response.");
  }

  return {
    state: "known",
    stale: false,
    bankVersion: parsed.data.bank_version,
    factCount: parsed.data.fact_count,
    ddmVersion: parsed.data.ddm_version,
  };
}

function emptyLifecycle(): Record<FactStatus, number> {
  return Object.fromEntries(FACT_STATUSES.map((status) => [status, 0])) as Record<FactStatus, number>;
}

/** Build the deployed-versus-Firestore snapshot consumed by the facts page. */
export async function getBankObservability(
  deps: BankObservabilityDependencies = {},
): Promise<BankObservability> {
  const countsPromise = Promise.all(
    FACT_STATUSES.map(async (status) => ({
      status,
      count: await countCollection("fact_bank", [
        { field: "status", op: "EQUAL", value: status },
      ]),
    })),
  );
  const [deployed, counts] = await Promise.all([fetchDeployedBank(deps), countsPromise]);
  const lifecycle = emptyLifecycle();
  for (const row of counts) lifecycle[row.status] = row.count;
  const total = Object.values(lifecycle).reduce((sum, count) => sum + count, 0);
  const active = lifecycle[STATUS.active];

  return {
    checkedAt: new Date().toISOString(),
    deployed,
    firestore: { lifecycle, total, active },
    exportedDelta: deployed.state === "known" ? active - deployed.factCount : null,
    exportedDeltaDefinition: EXPORTED_DELTA_DEFINITION,
  };
}

/** User-facing copy for a report that enters the Foundry admission queue. */
export const PENDING_ADMISSION_COPY =
  "Saved as pending; the nightly Foundry audit promotes it.";

export const CATEGORIES = GENRES;

export interface FactRecord {
  id: string;
  subject: string;
  subject_key: string;
  angle: string;
  angle_key: string;
  true_number: number | null;
  unit: string;
  claim_template: string;
  context: string;
  question: string;
  surprise_factor: number | null;
  difficulty_hint: string | null;
  content_rating: string;
  // Derived from the shared contract (Requirement 9.1). The `string & {}` arm
  // keeps a persisted value absent from the contract representable verbatim
  // (Requirement 9.10) while the `FactStatus` arm carries the declared union.
  status: FactStatus | (string & {});
  previous_true_number: number | null;
  retired_reason: string | null;
  source_urls: string[];
  verifier_model: string;
  verified_at: string | null;
  served_count: number;
  last_served_at: string | null;
  category: string | null;
  derivation: FactDerivationBlock | null;
  quantity_kind: string;
  plausible_min: string | null;
  plausible_max: string | null;
  number_token: string;
  /** Canonical exact decimal truth token stamped by the Foundry decode path. */
  true_number_token: string;
  /** Proposed or approved quantity spec; the auditor owns its approval. */
  quantity_spec: QuantitySpec | null;
  as_of_year: number | null;
  quality_flags: string[];
  disputed_reason: string | null;
  disputed_at: string | null;
  lint_findings: Json[];
  lint_rules_revision: string | null;
  /** Stored content fingerprint stamped by a Go pipeline write; "" when absent. */
  content_fingerprint: string;
  /** Auditor-owned approval bound to a specific revision; revoked on material edits. */
  quality_receipt: { audit_id: string; content_fingerprint: string } | null;
  /** Present when the stored approval was revoked pending a fresh audit. */
  quality_hold: { audit_id: string; checked_at: string; reason: string } | null;
  quality_reviews: QualityReviewRecord[];
  number_pinned: boolean;
  pinned_reason: string | null;
  updateTime?: string;
}

function str(value: Json | undefined): string {
  return typeof value === "string" ? value : "";
}
function num(value: Json | undefined): number | null {
  return typeof value === "number" ? value : null;
}

function firstStr(data: Record<string, Json>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * Read the canonical reveal copy while accepting the legacy context field.
 * The canonical field wins whenever it contains text; empty legacy values are
 * ignored so a partially migrated document remains readable.
 */
export function canonicalExplanation(
  data: Record<string, Json>,
  legacyAliases: readonly string[] = [],
): string {
  return firstStr(data, ["explanation", ...legacyAliases, "context"]);
}

export function toFact(doc: FirestoreDoc): FactRecord {
  const d = doc.data;
  return {
    id: doc.id,
    subject: str(d["subject"]),
    subject_key: str(d["subject_key"]),
    angle: str(d["angle"]),
    angle_key: str(d["angle_key"]),
    true_number: num(d["true_number"]),
    unit: str(d["unit"]),
    claim_template: str(d["claim_template"]),
    // FactRecord keeps the legacy `context` property for existing admin
    // consumers, but its value is always the canonical explanation projection.
    context: canonicalExplanation(d),
    question: str(d["question"]),
    surprise_factor: (() => {
      const raw = num(d["surprise_factor"]);
      if (raw === null || raw === undefined) return null;
      if (raw > 3) {
        return raw >= 8 ? 3 : raw >= 5 ? 2 : raw >= 3 ? 1 : 0;
      }
      return Math.min(3, Math.max(0, Math.round(raw)));
    })(),
    content_rating: str(d["content_rating"]) || "standard",
    difficulty_hint: (() => {
      const hint = str(d["difficulty_hint"]);
      return hint || null;
    })(),
    status: str(d["status"]) || STATUS.active,
    previous_true_number: num(d["previous_true_number"]),
    retired_reason: typeof d["retired_reason"] === "string" ? d["retired_reason"] : null,
    source_urls: Array.isArray(d["source_urls"])
      ? (d["source_urls"] as Json[]).filter((v): v is string => typeof v === "string")
      : [],
    verifier_model: str(d["verifier_model"]),
    verified_at: typeof d["verified_at"] === "string" ? d["verified_at"] : null,
    served_count: num(d["served_count"]) ?? 0,
    last_served_at: typeof d["last_served_at"] === "string" ? d["last_served_at"] : null,
    category: typeof d["category"] === "string" ? d["category"] : null,
    derivation: parseDerivationBlock(d["derivation"]),
    quantity_kind: str(d["quantity_kind"]),
    plausible_min: typeof d["plausible_min"] === "string" ? d["plausible_min"] : null,
    plausible_max: typeof d["plausible_max"] === "string" ? d["plausible_max"] : null,
    number_token: str(d["number_token"]),
    true_number_token: str(d["true_number_token"]),
    quantity_spec: parseQuantitySpec(d["quantity_spec"]),
    as_of_year: num(d["as_of_year"]),
    quality_flags: Array.isArray(d["quality_flags"])
      ? (d["quality_flags"] as Json[]).filter((v): v is string => typeof v === "string")
      : [],
    disputed_reason: typeof d["disputed_reason"] === "string" ? d["disputed_reason"] : null,
    disputed_at:
      typeof d["disputed_at"] === "string"
        ? d["disputed_at"]
        : typeof d["disputedAt"] === "string"
          ? (d["disputedAt"] as string)
          : null,
    lint_findings: Array.isArray(d["lint_findings"]) ? (d["lint_findings"] as Json[]) : [],
    lint_rules_revision:
      typeof d["lint_rules_revision"] === "string" ? d["lint_rules_revision"] : null,
    content_fingerprint:
      typeof d["content_fingerprint"] === "string" ? d["content_fingerprint"] : "",
    quality_receipt:
      d["quality_receipt"] && typeof d["quality_receipt"] === "object"
        ? {
            audit_id: str((d["quality_receipt"] as Record<string, Json>)["audit_id"]),
            content_fingerprint: str(
              (d["quality_receipt"] as Record<string, Json>)["content_fingerprint"],
            ),
          }
        : null,
    quality_hold:
      d["quality_hold"] && typeof d["quality_hold"] === "object"
        ? {
            audit_id: str((d["quality_hold"] as Record<string, Json>)["audit_id"]),
            checked_at: str((d["quality_hold"] as Record<string, Json>)["checked_at"]),
            reason: str((d["quality_hold"] as Record<string, Json>)["reason"]),
          }
        : null,
    quality_reviews: Array.isArray(d["quality_reviews"])
      ? d["quality_reviews"].flatMap((entry) => (isQualityReviewRecord(entry) ? [entry] : []))
      : [],
    number_pinned: asBool(d["number_pinned"]) ?? false,
    pinned_reason: typeof d["pinned_reason"] === "string" ? d["pinned_reason"] : null,
    updateTime: doc.updateTime,
  };
}

/** Text searched by both list and export paths, including canonical explanation. */
function factSearchText(fact: FactRecord): string {
  return [fact.subject, fact.angle, fact.question, fact.claim_template, fact.context]
    .join(" ")
    .toLowerCase();
}

export interface FactListInput {
  search?: string;
  category?: string;
  family?: string;
  playlistId?: string;
  subject?: string;
  angle?: string;
  status?: string;
  contentRating?: string;
  difficulty?: string;
  surpriseFactor?: number;
  minSurprise?: number;
  sortField?: "subject" | "angle" | "true_number" | "surprise_factor" | "served_count";
  sortOrder?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

async function applyTaxonomyFilters(
  facts: FactRecord[],
  input: Pick<FactListInput, "category" | "family" | "playlistId">,
): Promise<FactRecord[]> {
  let next = facts;
  if (input.category?.trim()) {
    const cat = input.category.trim().toLowerCase();
    const matchingSubjectDocs = await runQuery({
      collection: "fact_subjects",
      filters: [{ field: "category", op: "EQUAL", value: input.category.trim() }],
      limit: 1000,
    });
    const subjectMap = new Set(
      matchingSubjectDocs.map((d) => String(d.data.subject ?? d.id).toLowerCase()),
    );
    next = next.filter(
      (f) => (f.category && f.category.toLowerCase() === cat) || subjectMap.has(f.subject.toLowerCase()),
    );
  }
  if (input.family?.trim()) {
    const family = input.family.trim().toLowerCase();
    const matchingSubjectDocs = await runQuery({
      collection: "fact_subjects",
      filters: [{ field: "sub_category", op: "EQUAL", value: input.family.trim() }],
      limit: 1000,
    });
    const subjectMap = new Set(
      matchingSubjectDocs.map((d) => String(d.data.subject ?? d.id).toLowerCase()),
    );
    next = next.filter((f) => subjectMap.has(f.subject.toLowerCase()));
  }
  if (input.playlistId?.trim()) {
    const playlist = await getDoc(`fact_playlists/${input.playlistId.trim()}`);
    const keys = Array.isArray(playlist?.data["topic_keys"])
      ? playlist.data["topic_keys"].filter((v): v is string => typeof v === "string")
      : [];
    const keySet = new Set(keys.map((k) => k.toLowerCase()));
    next = next.filter(
      (f) => keySet.has(f.subject_key.toLowerCase()) || keySet.has(normalizeKey(f.subject)),
    );
  }
  return next;
}

/**
 * Firestore has no substring index, so filters that map to indexed equality
 * run server-side and the free-text search is applied to that result window.
 */
export async function listFacts(input: FactListInput) {
  const pageSize = Math.min(input.pageSize ?? 25, 1000);
  const page = Math.max(input.page ?? 1, 1);

  const filters: QueryFilter[] = [];
  if (input.status) filters.push({ field: "status", op: "EQUAL", value: input.status });
  if (input.contentRating) {
    filters.push({ field: "content_rating", op: "EQUAL", value: input.contentRating });
  }
  if (input.difficulty) {
    filters.push({ field: "difficulty_hint", op: "EQUAL", value: input.difficulty });
  }

  const window = await runQuery({
    collection: "fact_bank",
    filters,
    limit: 1000,
  });

  let facts = window.map(toFact);
  facts = await applyTaxonomyFilters(facts, input);
  if (input.subject?.trim()) {
    const sub = input.subject.trim().toLowerCase();
    facts = facts.filter((f) => f.subject.toLowerCase().includes(sub));
  }
  if (input.angle?.trim()) {
    const ang = input.angle.trim().toLowerCase();
    facts = facts.filter((f) => (f.angle || "").toLowerCase().includes(ang));
  }
  if (input.surpriseFactor !== undefined) {
    facts = facts.filter((f) => (f.surprise_factor ?? 2) === input.surpriseFactor);
  }
  if (input.minSurprise !== undefined) {
    facts = facts.filter((fact) => (fact.surprise_factor ?? 0) >= input.minSurprise!);
  }
  const term = input.search?.trim().toLowerCase();
  if (term) {
    facts = facts.filter((fact) => factSearchText(fact).includes(term));
  }

  const sortField = input.sortField || "subject";
  const sortDir = input.sortOrder === "desc" ? -1 : 1;
  facts.sort((a, b) => {
    let diff = 0;
    if (sortField === "subject") {
      diff = a.subject.localeCompare(b.subject) || a.angle.localeCompare(b.angle);
    } else if (sortField === "angle") {
      diff = a.angle.localeCompare(b.angle) || a.subject.localeCompare(b.subject);
    } else if (sortField === "true_number") {
      diff = (a.true_number ?? 0) - (b.true_number ?? 0);
    } else if (sortField === "surprise_factor") {
      diff = (a.surprise_factor ?? 2) - (b.surprise_factor ?? 2);
    } else if (sortField === "served_count") {
      diff = a.served_count - b.served_count;
    }
    return diff * sortDir;
  });

  const total = facts.length;
  const start = (page - 1) * pageSize;
  return {
    facts: facts.slice(start, start + pageSize),
    total,
    page,
    pageSize,
    windowed: window.length >= 1000,
  };
}

export async function exportFacts(input: FactListInput): Promise<FactRecord[]> {
  const filters: QueryFilter[] = [];
  if (input.status) filters.push({ field: "status", op: "EQUAL", value: input.status });
  if (input.contentRating) {
    filters.push({ field: "content_rating", op: "EQUAL", value: input.contentRating });
  }
  if (input.difficulty) {
    filters.push({ field: "difficulty_hint", op: "EQUAL", value: input.difficulty });
  }

  const window = await runQuery({
    collection: "fact_bank",
    filters,
    limit: 1000,
  });

  let facts = window.map(toFact);
  facts = await applyTaxonomyFilters(facts, input);
  if (input.subject?.trim()) {
    const sub = input.subject.trim().toLowerCase();
    facts = facts.filter((f) => f.subject.toLowerCase().includes(sub));
  }
  if (input.angle?.trim()) {
    const ang = input.angle.trim().toLowerCase();
    facts = facts.filter((f) => (f.angle || "").toLowerCase().includes(ang));
  }
  if (input.surpriseFactor !== undefined) {
    facts = facts.filter((f) => (f.surprise_factor ?? 2) === input.surpriseFactor);
  }
  if (input.minSurprise !== undefined) {
    facts = facts.filter((fact) => (fact.surprise_factor ?? 0) >= input.minSurprise!);
  }
  const term = input.search?.trim().toLowerCase();
  if (term) {
    facts = facts.filter((fact) => factSearchText(fact).includes(term));
  }

  const sortField = input.sortField || "subject";
  const sortDir = input.sortOrder === "desc" ? -1 : 1;
  facts.sort((a, b) => {
    let diff = 0;
    if (sortField === "subject") {
      diff = a.subject.localeCompare(b.subject) || a.angle.localeCompare(b.angle);
    } else if (sortField === "angle") {
      diff = a.angle.localeCompare(b.angle) || a.subject.localeCompare(b.subject);
    } else if (sortField === "true_number") {
      diff = (a.true_number ?? 0) - (b.true_number ?? 0);
    } else if (sortField === "surprise_factor") {
      diff = (a.surprise_factor ?? 2) - (b.surprise_factor ?? 2);
    } else if (sortField === "served_count") {
      diff = a.served_count - b.served_count;
    }
    return diff * sortDir;
  });
  return facts;
}

export interface ImportFactInput {
  subject: string;
  category?: string | null;
  sub_category?: string | null;
  angle: string;
  true_number: number;
  unit: string;
  claim_template?: string;
  context?: string | null;
  explanation?: string | null;
  question?: string;
  surprise_factor?: number;
  quantity_kind?: QuantityKind | "";
  plausible_min?: string | null;
  plausible_max?: string | null;
  number_pinned?: boolean;
  pinned_reason?: string | null;
  source_urls?: readonly string[];
  origin?: PendingFactOrigin;
  difficulty_hint?: "casual" | "medium" | "hard";
  content_rating?: "standard" | "after_dark";
}

function pendingCategory(value: string | null | undefined): PendingFactInput["category"] {
  return value?.trim() ? (value as PendingFactInput["category"]) : null;
}

function pendingQuantityKind(value: QuantityKind | "" | undefined): QuantityKind {
  return value === undefined || value === "" ? QK.count : value;
}

function pendingText(value: string | null | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

/** Build the one fact-bank payload that either manual admission path may persist. */
function buildAdmissionFact(
  input: ImportFactInput,
  origin: PendingFactOrigin,
  timestamp = new Date().toISOString(),
): PendingFact {
  const question = pendingText(input.question, `${input.subject} - ${input.angle}`.trim());
  const claim = pendingText(input.claim_template, `${question}: {n}`);
  const claimTemplate = claim.includes("{n}") ? claim : `${claim} {n}`;
  return buildPendingFact({
    subject: input.subject,
    category: pendingCategory(input.category),
    sub_category: input.sub_category ?? null,
    angle: input.angle,
    true_number: input.true_number,
    unit: input.unit,
    claim_template: claimTemplate,
    question,
    explanation: pendingText(input.explanation, pendingText(input.context, question)),
    source_urls: input.source_urls ?? [],
    surprise_factor: input.surprise_factor ?? 2,
    quantity_kind: pendingQuantityKind(input.quantity_kind),
    ...(input.plausible_min !== undefined ? { plausible_min: input.plausible_min } : {}),
    ...(input.plausible_max !== undefined ? { plausible_max: input.plausible_max } : {}),
    ...(input.number_pinned !== undefined ? { number_pinned: input.number_pinned } : {}),
    ...(input.pinned_reason !== undefined ? { pinned_reason: input.pinned_reason } : {}),
    ...(input.content_rating !== undefined ? { content_rating: input.content_rating } : {}),
    origin,
  });
}

export interface ImportFactAuditContext {
  readonly id: string;
  readonly index: number;
  readonly input: ImportFactInput;
}

/**
 * Builds the one audit entry that may commit with a CSV row. The server-function
 * boundary allocates its identity before the per-fact transaction starts, so a
 * transaction retry stages the same audit document id.
 */
export type ImportFactAuditFactory = (context: ImportFactAuditContext) => PreparedAuditEntry;

/** Canonical per-item import result plus the legacy counters consumed by the CSV UI. */
export type ImportFactsResult = Omit<BatchMutationResult, "operation"> & {
  readonly operation: "import";
  /** Number of facts committed with their audit entry. */
  readonly imported: number;
  /** Number of duplicate identities intentionally left unchanged. */
  readonly skipped: number;
  /** Human-readable failures aligned with `items[].index`. */
  readonly errors: readonly string[];
  /** Stable user-facing explanation of the non-atomic batch outcome. */
  readonly summary: string;
};

function importSummary(result: BatchMutationResult): string {
  const persisted = result.counts.persisted;
  const skipped = result.counts.skipped;
  const failed = result.counts.failed;
  const failedId = result.failedId ? ` at ${result.failedId}` : "";
  if (failed === 0) {
    return (
      `Imported ${persisted} fact(s) and skipped ${skipped} duplicate(s). ` +
      "Rows commit independently; this import is not batch-atomic."
    );
  }
  return (
    `Imported ${persisted} fact(s), skipped ${skipped} duplicate(s), and failed ${failed} row(s)${failedId}. ` +
    "Later rows were still attempted independently; this import is not batch-atomic."
  );
}

/**
 * Import CSV rows in input order with one fact-plus-audit transaction per row.
 * A duplicate is a skipped item and receives no audit. Every persisted item has
 * exactly one audit staged in the same transaction, while a row failure never
 * rolls back an earlier committed row.
 */
export async function importFactsBatch(
  facts: ImportFactInput[],
  auditFor: ImportFactAuditFactory,
): Promise<ImportFactsResult> {
  const prepared: Array<{ id: string; input: ImportFactInput; audit: PreparedAuditEntry }> = [];
  for (let index = 0; index < facts.length; index += 1) {
    const input = facts[index];
    const id = await factId(normalizeKey(input.subject), normalizeKey(input.angle));
    prepared.push({ id, input, audit: auditFor({ id, index, input }) });
  }

  const result = await runPerItemBatch(
    "import",
    prepared.map((entry) => entry.id),
    async (id, index): Promise<BatchItemOutcome> => {
      const entry = prepared[index];
      if (!entry) {
        return {
          status: "failed",
          failure: { code: "missing_import_entry", message: `Missing prepared import entry ${id}` },
        };
      }
      try {
        // Duplicate detection and both writes share this transaction. If another
        // writer creates the identity after our read, Firestore aborts and retries
        // the callback; the retry then observes the existing fact and skips it.
        const pendingFact = buildAdmissionFact(entry.input, PENDING_FACT_ORIGINS[1]);
        return await runTransaction(async (tx): Promise<BatchItemOutcome> => {
          const existing = await tx.get(`fact_bank/${id}`);
          if (existing) {
            return { status: "skipped", reason: "identity already exists" };
          }
          tx.set(`fact_bank/${id}`, pendingFact);
          stagePreparedAudit(tx, entry.audit);
          return { status: "persisted", auditCommitted: true };
        });
      } catch (error) {
        return {
          status: "failed",
          failure: {
            code: "item_execution_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
  );

  const errors = result.items.flatMap((item) => {
    if (item.status !== "failed") return [];
    const input = facts[item.index];
    const label = input ? `${input.subject} / ${input.angle}` : item.id;
    return [`${label} (${item.id}): ${item.failure?.message ?? "Import failed"}`];
  });

  return {
    ...result,
    operation: "import",
    imported: result.counts.persisted,
    skipped: result.counts.skipped,
    errors,
    summary: importSummary(result),
  };
}

export async function getFact(id: string): Promise<FactRecord | null> {
  const doc = await getDoc(`fact_bank/${id}`);
  return doc ? toFact(doc) : null;
}

export interface FactEditInput {
  id: string;
  subject?: string;
  category?: string;
  sub_category?: string;
  angle?: string;
  true_number?: number;
  unit?: string;
  claim_template?: string;
  /** Canonical reveal copy; `context` remains a legacy input alias. */
  explanation?: string;
  context?: string;
  question?: string;
  surprise_factor?: number;
  difficulty_hint?: string;
  content_rating?: string;
  source_urls?: string[];
  quantity_kind?: string;
  plausible_min?: string;
  plausible_max?: string;
}

// Semantic inputs the DDM consumes. When any of them change, the stored
// derivation blocks and input fingerprint are invalidated so the next
// precompute backfill regenerates under the corrected semantics rather than
// shipping a stale block.
const SEMANTIC_EDIT_KEYS: (keyof FactEditInput)[] = [
  "true_number",
  "unit",
  "claim_template",
  "surprise_factor",
  "quantity_kind",
  "plausible_min",
  "plausible_max",
];

/** The persisted fields that make a fact's identity deterministic. */
export type FactIdentityField = "subject" | "angle";

/**
 * A request tried to change a fact's identity through the ordinary edit path.
 * Subject and angle are part of the document's deterministic identity: changing
 * either would also require a new canonical key and document id. Corrections
 * must create a replacement instead, so this error is raised before any write.
 */
export class FactIdentityChangeError extends Error {
  readonly factId: string;
  readonly field: FactIdentityField;
  readonly current: string;
  readonly requested: string;

  constructor(factId: string, field: FactIdentityField, current: string, requested: string) {
    super(
      `Fact identity change rejected for fact ${factId}: ${field} is immutable ` +
        `(current "${current}", requested "${requested}").`,
    );
    this.name = "FactIdentityChangeError";
    this.factId = factId;
    this.field = field;
    this.current = current;
    this.requested = requested;
  }
}

/**
 * Identity fields may still be present in a legacy or full-form edit payload,
 * but only an exact stored value is a no-op. This comparison intentionally
 * happens after the current document read and before constructing any patch so
 * no caller path can re-key the fact or write an adjacent taxonomy document.
 */
function assertFactIdentityUnchanged(input: FactEditInput, existing: FactRecord): void {
  if (input.subject !== undefined && input.subject !== existing.subject) {
    throw new FactIdentityChangeError(input.id, "subject", existing.subject, input.subject);
  }
  if (input.angle !== undefined && input.angle !== existing.angle) {
    throw new FactIdentityChangeError(input.id, "angle", existing.angle, input.angle);
  }
}

/** Optional transaction-scoped audit input accepted by ordinary fact mutations. */
export interface FactMutationOptions {
  audit?: PreparedAuditEntry;
  /** Compatibility alias for callers that name the prebuilt entry explicitly. */
  auditEntry?: PreparedAuditEntry;
}

/**
 * A prepared entry can be passed directly, or wrapped in mutation options. The
 * direct form keeps the server module convenient for internal callers while the
 * wrapper makes the transaction contract explicit at server-function seams.
 */
export type FactMutationAudit = PreparedAuditEntry | FactMutationOptions;

function resolveAuditEntry(value: FactMutationAudit | undefined): PreparedAuditEntry | undefined {
  if (value === undefined) return undefined;
  if ("id" in value && "data" in value) return value;
  return value.audit ?? value.auditEntry;
}

function requireUpdateTime(doc: FirestoreDoc): string {
  if (doc.updateTime === undefined || doc.updateTime === "") {
    throw new Error(`Fact ${doc.id} cannot be updated without an exact updateTime precondition`);
  }
  return doc.updateTime;
}

function asJson(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => asJson(entry));
  if (typeof value === "object") {
    const output: { [key: string]: Json } = {};
    for (const [key, entry] of Object.entries(value)) output[key] = asJson(entry);
    return output;
  }
  return null;
}

function asJsonRecord(value: object): Record<string, Json> {
  const output: Record<string, Json> = {};
  for (const [key, entry] of Object.entries(value)) output[key] = asJson(entry);
  return output;
}

/** Spread a typed object into a plain record without asserting its shape:
 *  preserves entries verbatim (including absent optional fields left
 *  undefined) so Firestore writes see exactly the original object. */
function asPlainRecord(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value));
}

function isQualityReviewRecord(value: unknown): value is QualityReviewRecord {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  if (r["schema_version"] !== QUALITY_REVIEW_SCHEMA) return false;
  for (const key of [
    "review_id",
    "fact_id",
    "actor",
    "actor_role",
    "reason",
    "lint_rules_revision",
    "content_fingerprint",
    "update_time",
    "created_at",
  ]) {
    if (typeof r[key] !== "string") return false;
  }
  const isStringArray = (entry: unknown): entry is string[] =>
    Array.isArray(entry) && entry.every((item) => typeof item === "string");
  return (
    QUALITY_REVIEW_KINDS.some((kind) => kind === r["kind"]) &&
    isStringArray(r["reviewed_fields"]) &&
    isStringArray(r["finding_ids"])
  );
}

function mergedFactDoc(
  current: FirestoreDoc,
  patch: Record<string, unknown>,
  deletePaths?: readonly string[],
): FirestoreDoc {
  const data: Record<string, Json> = { ...current.data };
  for (const [key, value] of Object.entries(patch)) data[key] = asJson(value);
  for (const path of deletePaths ?? []) delete data[path];
  return { ...current, data };
}

function withoutVerificationMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => withoutVerificationMetadata(entry));
  if (value === null || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "verified_at" || key === "verifier_model") continue;
    output[key] = withoutVerificationMetadata(entry);
  }
  return output;
}

function auditAt(
  prepared: PreparedAuditEntry,
  current: FirestoreDoc,
  after?: unknown,
): PreparedAuditEntry {
  const data: Record<string, unknown> = {
    ...prepared.data,
    before: current.data,
  };
  if (after !== undefined) data["after"] = withoutVerificationMetadata(after);
  return { id: prepared.id, data };
}

function stagePreparedAudit(
  tx: import("../firebase/firestore.server").FirestoreTransaction,
  prepared: PreparedAuditEntry,
): void {
  tx.set(`admin_audit_logs/${prepared.id}`, prepared.data);
}

/**
 * Build the patch + invalidation for one fact edit against the transaction's
 * current snapshot. Shared by `updateFact` and the report-resolution edit
 * actions so a fix carried through moderation invalidates readiness exactly
 * like a direct portal edit.
 *
 * Material edits (any fingerprinted field) atomically revoke the approval
 * minted for the old revision: `quality_receipt` and the stored
 * `content_fingerprint` are deleted, stale lint evidence is cleared, and a
 * `quality_hold` records that the current revision awaits a fresh audit.
 * `verified_at`/`verifier_model` are never written and are left as historical
 * auditor metadata; the receipt, not the timestamp, is the live approval.
 * `quality_hold` is never deleted here: only a new receipt clears it.
 */
function buildFactEditPlan(
  currentDoc: FirestoreDoc,
  input: FactEditInput,
  now: string,
): {
  patch: Record<string, unknown>;
  deletePaths: string[] | undefined;
  semanticChanged: boolean;
  materialChanged: boolean;
} {
  const existing = toFact(currentDoc);
  const patch: Record<string, unknown> = {};
  // Subject and angle are deliberately absent: even an exact-value payload is
  // a no-op, and the persisted canonical keys/document id remain untouched.
  if (input.explanation !== undefined) {
    patch["explanation"] = input.explanation;
  } else if (input.context !== undefined) {
    patch["context"] = input.context;
    patch["explanation"] = input.context;
  }
  const assignable: (keyof FactEditInput)[] = [
    "category",
    "unit",
    "claim_template",
    "context",
    "question",
    "surprise_factor",
    "difficulty_hint",
    "content_rating",
    "source_urls",
    "quantity_kind",
    "plausible_min",
    "plausible_max",
  ];
  for (const key of assignable) {
    if (input[key] !== undefined) patch[key] = input[key];
  }

  // Changing the value preserves the old one for the reveal-diff history.
  const trueNumberChanged =
    input.true_number !== undefined && input.true_number !== existing.true_number;
  if (trueNumberChanged) {
    patch["previous_true_number"] = existing.true_number;
    patch["number_changed_at"] = now;
    patch["number_change_source"] = "admin_portal";
    patch["true_number"] = input.true_number;
  }

  // Semantic edits invalidate the stored derivation: delete the precomputed
  // blocks and input fingerprint so the next backfill regenerates under the
  // corrected semantics instead of exporting a stale block.
  const semanticChanged = SEMANTIC_EDIT_KEYS.some((key) => {
    if (input[key] === undefined) return false;
    const next = input[key];
    const prev = existing[key as keyof FactRecord];
    return String(next ?? "") !== String(prev ?? "");
  });

  // Material edits (any fingerprinted field) revoke the approval bound to
  // the old revision. `context` and `explanation` are the same canonical
  // field; comparing the written value against the stored explanation keeps
  // the legacy alias from slipping past the check.
  const materialChanged = MATERIAL_EDIT_KEYS.some((key) => {
    const written =
      key === "explanation"
        ? (patch["explanation"] ?? (key in input ? input[key] : undefined))
        : key === "context"
          ? patch["explanation"]
          : patch[key];
    if (written === undefined) return false;
    const prev =
      key === "explanation" || key === "context"
        ? existing.context
        : (existing[key as keyof FactRecord] as unknown);
    if (Array.isArray(written) || Array.isArray(prev)) {
      return JSON.stringify(written ?? null) !== JSON.stringify(prev ?? null);
    }
    return String(written ?? "") !== String(prev ?? "");
  });

  const deletePaths: string[] = semanticChanged
    ? ["derivation", "precomputed_derivation", "derivation_input_fingerprint"]
    : [];
  if (trueNumberChanged) {
    // The canonical token is a projection of the value, stamped by the
    // Foundry decode path. A raw-number correction cannot restamp it, so the
    // stale token is deleted atomically with the write rather than left to
    // trip true_number_token_mismatch on the next lint pass.
    deletePaths.push("true_number_token");
  }
  if (materialChanged) {
    deletePaths.push(...MATERIAL_INVALIDATION_PATHS);
    patch["quality_hold"] = materialEditHold({
      auditId: "admin_edit",
      reason: "Material fact edit: stored approval revoked pending a fresh audit",
      now,
    });
  }

  return {
    patch,
    deletePaths: deletePaths.length > 0 ? deletePaths : undefined,
    semanticChanged,
    materialChanged,
  };
}

/**
 * Apply one ordinary fact edit under an exact transaction CAS.
 * `auditInput`, when supplied, is staged in the same transaction and must be
 * prepared before the call so its identity survives transaction retries.
 */
export async function updateFact(
  input: FactEditInput,
  auditInput?: FactMutationAudit,
): Promise<FactRecord> {
  const audit = resolveAuditEntry(auditInput);
  const updatedAt = new Date().toISOString();

  return runTransaction(async (tx) => {
    // The fact read is inside the transaction callback. A contention retry
    // therefore rebuilds the decision from a fresh snapshot and fresh CAS token.
    const currentDoc = await tx.get(`fact_bank/${input.id}`);
    if (!currentDoc) throw new Error(`Fact ${input.id} not found`);
    const existing = toFact(currentDoc);
    assertFactIdentityUnchanged(input, existing);

    const { patch, deletePaths } = buildFactEditPlan(currentDoc, input, updatedAt);

    // Read the taxonomy document before queueing any write. This keeps the
    // subject-side linkage in the same transaction as the fact mutation when a
    // category is assigned, and derives its key only from the persisted fact.
    let subjectPath: string | null = null;
    let subjectDoc: FirestoreDoc | null = null;
    if (input.category && existing.subject) {
      const subject = existing.subject.trim();
      subjectPath = `fact_subjects/${normalizeKey(subject)}`;
      subjectDoc = await tx.get(subjectPath);
    }

    const hasFactChange = Object.keys(patch).length > 0 || deletePaths !== undefined;
    if (hasFactChange || audit !== undefined) {
      patch["updated_at"] = updatedAt;
      tx.update(`fact_bank/${input.id}`, patch, {
        updateTime: requireUpdateTime(currentDoc),
        ...(deletePaths ? { deletePaths } : {}),
      });
    }

    if (subjectPath !== null && subjectDoc !== null && input.category) {
      const subjectPatch: Record<string, unknown> = { category: input.category };
      if (input.sub_category) subjectPatch["sub_category"] = input.sub_category;
      tx.update(subjectPath, subjectPatch, {
        ...(subjectDoc.updateTime ? { updateTime: subjectDoc.updateTime } : {}),
      });
    } else if (subjectPath !== null && input.category) {
      const subject = existing.subject.trim();
      const subjectKey = normalizeKey(subject);
      tx.set(subjectPath, {
        subject,
        subject_key: subjectKey,
        category: input.category,
        ...(input.sub_category ? { sub_category: input.sub_category } : {}),
        aliases: [],
        playlist_ids: [],
        createdAt: updatedAt,
      });
    }

    if (audit !== undefined) {
      stagePreparedAudit(tx, auditAt(audit, currentDoc, input));
    }

    return toFact(mergedFactDoc(currentDoc, patch, deletePaths));
  });
}

/* ------------------------------- bulk update -------------------------------- */

/** Smallest batch `bulkUpdateFacts` accepts in one invocation. */
export const BULK_UPDATE_MIN_BATCH = 1;
/** Largest batch `bulkUpdateFacts` accepts in one invocation. */
export const BULK_UPDATE_MAX_BATCH = 200;

/**
 * The `quantity_kind` values the fact editor accepts: the contract's closed set
 * (Requirement 9.5, derived — never restated) plus the empty-string "auto"
 * sentinel that asks the DDM to classify the kind from the unit.
 */
export const QUANTITY_KIND_OPTIONS = [...CONTRACT_QUANTITY_KINDS, ""] as const;
export type QuantityKindOption = (typeof QUANTITY_KIND_OPTIONS)[number];

/**
 * The declared fact-edit schema. Mirrors the `editInput` validator the
 * `saveFact` / `bulkUpdateFacts` server functions apply, so a batch that
 * reaches this module by any other route is held to the same shape.
 */
export const factEditSchema = z.object({
  id: z.string().min(1),
  subject: z.string().optional(),
  category: z.union([z.enum(CATEGORIES), z.literal("")]).optional(),
  sub_category: z.string().optional(),
  angle: z.string().optional(),
  true_number: z.number().optional(),
  unit: z.string().optional(),
  claim_template: z.string().optional(),
  explanation: z.string().optional(),
  context: z.string().optional(),
  question: z.string().optional(),
  surprise_factor: z.number().int().min(0).max(3).optional(),
  content_rating: z.enum(CONTENT_RATINGS).optional(),
  source_urls: z.array(z.string()).optional(),
  quantity_kind: z.enum(QUANTITY_KIND_OPTIONS).optional(),
  plausible_min: z.string().optional(),
  plausible_max: z.string().optional(),
});

export type BulkUpdateResult = Omit<BatchMutationResult, "operation" | "failedId"> & {
  readonly operation: "bulk-update";
  /** Number of edits persisted. */
  readonly count: number;
  /** Fact ids persisted, in application order. */
  readonly editedIds: string[];
  /** Set only when the batch stopped early: the fact whose edit did not persist. */
  readonly failedId?: string;
};

function asBulkUpdateResult(result: BatchMutationResult): BulkUpdateResult {
  if (result.operation !== "bulk-update") {
    throw new Error(`Unexpected batch operation: ${result.operation}`);
  }
  return {
    ...result,
    operation: "bulk-update",
    count: result.counts.persisted,
    editedIds: [...result.persistedIds],
    failedId: result.failedId ?? undefined,
  };
}

/**
 * A batch rejected before any Firestore write. `rule` names the violated
 * validation rule; `index` locates the offending edit when the rule is
 * per-edit rather than per-batch.
 */
export class BulkUpdateValidationError extends Error {
  readonly rule: string;
  readonly index: number | null;

  constructor(rule: string, message: string, index: number | null = null) {
    super(message);
    this.name = "BulkUpdateValidationError";
    this.rule = rule;
    this.index = index;
  }
}

/**
 * A persistence failure part-way through a validated batch. Carries the
 * persisted prefix so the caller can record exactly the ids that landed and
 * no more.
 */
export class BulkUpdatePartialFailureError extends Error {
  readonly failedId: string;
  readonly result: BulkUpdateResult;

  constructor(failedId: string, result: BulkUpdateResult, cause: unknown) {
    super(
      `Bulk update stopped at fact ${failedId} after persisting ${result.count} edit(s): ` +
      (cause instanceof Error ? cause.message : String(cause)),
      { cause },
    );
    this.name = "BulkUpdatePartialFailureError";
    this.failedId = failedId;
    this.result = result;
  }
}

function auditTargetsFact(audit: PreparedAuditEntry, factIdValue: string): boolean {
  return audit.data["targetId"] === factIdValue;
}

function bulkFailure(error: unknown): BatchItemOutcome {
  return {
    status: "failed",
    failure: {
      code: "item_execution_failed",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

/**
 * Apply a bounded batch of fact edits with one fact-plus-audit transaction per
 * edit. The batch is deliberately not atomic: edits run in input order, the
 * first failed transaction stops the suffix, and the thrown partial-failure
 * result carries the exact persisted prefix and failed id.
 */
export async function bulkUpdateFacts(
  updates: FactEditInput[],
  audits: readonly PreparedAuditEntry[],
): Promise<BulkUpdateResult> {
  if (!Array.isArray(updates)) {
    throw new BulkUpdateValidationError(
      "batch must be an array of fact edits",
      "Bulk update rejected: batch must be an array of fact edits",
    );
  }
  if (updates.length < BULK_UPDATE_MIN_BATCH) {
    throw new BulkUpdateValidationError(
      `batch size >= ${BULK_UPDATE_MIN_BATCH}`,
      `Bulk update rejected: batch must contain at least ${BULK_UPDATE_MIN_BATCH} edit, received ${updates.length}`,
    );
  }
  if (updates.length > BULK_UPDATE_MAX_BATCH) {
    throw new BulkUpdateValidationError(
      `batch size <= ${BULK_UPDATE_MAX_BATCH}`,
      `Bulk update rejected: batch must contain at most ${BULK_UPDATE_MAX_BATCH} edits, received ${updates.length}`,
    );
  }
  if (!Array.isArray(audits) || audits.length !== updates.length) {
    throw new BulkUpdateValidationError(
      "one prepared audit per edit",
      `Bulk update rejected: expected ${updates.length} prepared audit entries, received ${Array.isArray(audits) ? audits.length : 0}`,
    );
  }
  for (let index = 0; index < updates.length; index++) {
    const parsed = factEditSchema.safeParse(updates[index]);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue.path.length > 0 ? issue.path.join(".") : "edit";
      const rule = `${field}: ${issue.message}`;
      throw new BulkUpdateValidationError(
        rule,
        `Bulk update rejected: edit at index ${index} violates the edit schema (${rule})`,
        index,
      );
    }
    const audit = audits[index];
    if (!audit || !auditTargetsFact(audit, updates[index].id)) {
      throw new BulkUpdateValidationError(
        "audit targetId matches edit id",
        `Bulk update rejected: prepared audit at index ${index} must target fact ${updates[index].id}`,
        index,
      );
    }
  }

  const firstIdentity: { current: FactIdentityChangeError | null } = { current: null };
  const firstFailure: { current: { id: string; error: unknown } | null } = { current: null };
  const result = await runPerItemBatch(
    "bulk-update",
    updates.map((update) => update.id),
    async (_id, index) => {
      try {
        await updateFact(updates[index], audits[index]);
        return { status: "persisted", auditCommitted: true } as const;
      } catch (error) {
        if (error instanceof FactIdentityChangeError && index === 0) {
          firstIdentity.current = error;
        } else {
          firstFailure.current ??= { id: updates[index].id, error };
        }
        return bulkFailure(error);
      }
    },
    "stop",
  );

  if (firstIdentity.current) throw firstIdentity.current;
  if (firstFailure.current) {
    throw new BulkUpdatePartialFailureError(
      firstFailure.current.id,
      asBulkUpdateResult(result),
      firstFailure.current.error,
    );
  }
  return asBulkUpdateResult(result);
}

/**
 * A `setFactStatus` call the shared contract does not permit. Raised before any
 * Firestore write, so the targeted document is left unchanged (Requirements
 * 9.3, 9.4). The message names both the fact's current status and the rejected
 * target status.
 */
export class FactStatusTransitionError extends Error {
  readonly factId: string;
  readonly from: string;
  readonly to: string;

  constructor(factId: string, from: string, to: string) {
    super(
      `Status change rejected for fact ${factId}: the transition from "${from}" to "${to}" ` +
      `is not admin-authorized by the shared fact-lifecycle contract.`,
    );
    this.name = "FactStatusTransitionError";
    this.factId = factId;
    this.from = from;
    this.to = to;
  }
}

/**
 * Whether the shared contract marks the current→requested status change as one
 * an admin may write. A pair the contract does not declare, or declares with
 * `adminAuthorized: false`, is not authorized; a status with no
 * admin-authorized outgoing target is displayable and filterable but has no
 * valid transition to offer and can never be written to (Requirement 9.8).
 */
function isAdminAuthorizedTransition(from: string, to: string): boolean {
  return STATUS_TRANSITIONS.some(
    (transition) =>
      transition.from === from && transition.to === to && transition.adminAuthorized,
  );
}

/**
 * The live status used when moderation reinstates a corrected fact. The value
 * comes from the generated contract's `active` member, while the transition
 * table must still prove that admins may enter and leave that status. Inferring
 * liveness from any non-terminal graph node would incorrectly select `disputed`
 * once pending → active became Foundry-only.
 */
function liveStatus(): FactStatus | null {
  const live = STATUS.active;
  const authorized = STATUS_TRANSITIONS.filter((transition) => transition.adminAuthorized);
  const hasAuthorizedTarget = authorized.some((transition) => transition.to === live);
  const hasAuthorizedSource = authorized.some((transition) => transition.from === live);
  return hasAuthorizedTarget && hasAuthorizedSource ? live : null;
}

/**
 * The status a fact currently in `from` should be reinstated to when its number
 * is corrected, or `null` when no such contract-authorized move exists (for
 * example the fact is already live, which has no self-transition).
 */
function reinstatementTargetFor(from: string): FactStatus | null {
  const target = liveStatus();
  if (target === null || from === target) return null;
  return isAdminAuthorizedTransition(from, target) ? target : null;
}

/**
 * The status patch for one contract-authorized transition, re-validated
 * against the current snapshot every call. Shared by `setFactStatus` and the
 * report-resolution paths so a reinstatement written inside a moderation
 * transaction is gated by exactly the same rules as a standalone transition.
 * Throws `FactStatusTransitionError` before any write when the contract does
 * not authorize the move; moderation can never write `pending` or `retired`
 * sources back to `active` through a stored prior status.
 */
function statusTransitionPatch(
  factIdValue: string,
  currentStatus: string,
  target: FactStatus,
  reason: string | undefined,
  now: string,
): Record<string, unknown> {
  if (!isAdminAuthorizedTransition(currentStatus, target)) {
    throw new FactStatusTransitionError(factIdValue, currentStatus, target);
  }
  const patch: Record<string, unknown> = { status: target, updated_at: now };
  if (target === STATUS.retired) {
    patch["retired_reason"] = reason ?? "Retired from admin portal";
  }
  if (target === STATUS.active) {
    // Reinstating a disputed fact clears only retirement state. Verification
    // timestamps/models are owned by the banked-fact auditor, never by this
    // admin transition path.
    patch["retired_reason"] = null;
  }
  return patch;
}

/**
 * Apply one contract-authorized lifecycle transition under an exact
 * transaction CAS. The optional prepared audit is committed with the fact and
 * is never used to grant verification authority.
 */
export async function setFactStatus(
  input: {
    id: string;
    status: (typeof FACT_STATUSES)[number];
    reason?: string;
    /** @deprecated Moderation transitions never write verifier metadata. */
    verifierModel?: string;
  },
  auditInput?: FactMutationAudit,
): Promise<FactRecord> {
  const audit = resolveAuditEntry(auditInput);
  const updatedAt = new Date().toISOString();

  return runTransaction(async (tx) => {
    // Read and revalidate on every transaction attempt. In particular, the
    // Foundry-only pending→active edge is never evaluated from a stale status.
    const currentDoc = await tx.get(`fact_bank/${input.id}`);
    if (!currentDoc) throw new Error(`Fact ${input.id} not found`);
    const existing = toFact(currentDoc);
    const patch = statusTransitionPatch(
      input.id,
      String(existing.status),
      input.status,
      input.reason,
      updatedAt,
    );

    tx.update(`fact_bank/${input.id}`, patch, {
      updateTime: requireUpdateTime(currentDoc),
    });
    if (audit !== undefined) {
      stagePreparedAudit(
        tx,
        auditAt(audit, currentDoc, {
          status: input.status,
          reason: input.reason ?? null,
        }),
      );
    }
    return toFact(mergedFactDoc(currentDoc, patch));
  });
}

/** Input for the one-fact-plus-retirement correction operation. */
export interface CorrectedReplacementInput {
  /** The immutable source document to retire. */
  originalId: string;
  /** Fields for the new fact; its subject/angle are never read from the source. */
  replacement: ImportFactInput;
  /** Human-readable reason persisted on the retired source. */
  reason?: string;
  /** Optional caller token used to reject a stale edit before any write. */
  originalUpdateTime?: string;
}

/** Both sides of a committed correction, returned after the transaction commits. */
export interface CorrectedReplacementResult {
  readonly original: FactRecord;
  readonly replacement: FactRecord;
}

export type CorrectedReplacementErrorCode =
  | "missing_original"
  | "stale_original"
  | "replacement_exists"
  | "replacement_identity_collision"
  | "missing_audit";

/** A correction rejection that is safe to surface to the moderation boundary. */
export class CorrectedReplacementError extends Error {
  override readonly name = "CorrectedReplacementError";
  readonly code: CorrectedReplacementErrorCode;
  readonly originalId: string;
  readonly replacementId?: string;

  constructor(
    code: CorrectedReplacementErrorCode,
    message: string,
    originalId: string,
    replacementId?: string,
  ) {
    super(message);
    this.code = code;
    this.originalId = originalId;
    this.replacementId = replacementId;
  }
}

/**
 * Commit a corrected fact and retire its source as one Firestore transaction.
 *
 * The source is updated with the exact `updateTime` returned by the transaction
 * read. Identity fields are intentionally absent from that patch: a correction
 * never re-keys the immutable source document. The replacement receives a fresh
 * canonical id and pending admission payload, while the prepared audit entry is
 * staged alongside both writes.
 */
export async function createCorrectedReplacement(
  input: CorrectedReplacementInput,
  auditInput?: FactMutationAudit,
): Promise<CorrectedReplacementResult> {
  const originalId = input.originalId.trim();
  if (!originalId) {
    throw new CorrectedReplacementError(
      "missing_original",
      "Corrected replacement requires an original fact id",
      input.originalId,
    );
  }

  const timestamp = new Date().toISOString();
  const origin = input.replacement.origin ?? PENDING_FACT_ORIGINS[0];
  const replacement = buildAdmissionFact(input.replacement, origin, timestamp);
  const replacementId = await factId(replacement.subject_key, replacement.angle_key);

  // A canonical id collision would turn a correction into an in-place overwrite
  // of the immutable source. Require a genuinely distinct replacement identity.
  if (replacementId === originalId) {
    throw new CorrectedReplacementError(
      "replacement_identity_collision",
      `Corrected replacement for fact ${originalId} resolves to the original document id; ` +
        "the replacement must have a distinct subject and angle identity",
      originalId,
      replacementId,
    );
  }

  const audit = resolveAuditEntry(auditInput);
  if (audit === undefined) {
    throw new CorrectedReplacementError(
      "missing_audit",
      "Corrected replacement requires one prepared audit entry",
      originalId,
      replacementId,
    );
  }

  const retirementReason = input.reason?.trim() || "Retired by corrected replacement";
  const expectedOriginalUpdateTime = input.originalUpdateTime?.trim();

  return runTransaction(async (tx) => {
    const originalDoc = await tx.get(`fact_bank/${originalId}`);
    if (!originalDoc) {
      throw new CorrectedReplacementError(
        "missing_original",
        `Fact ${originalId} not found`,
        originalId,
        replacementId,
      );
    }

    const original = toFact(originalDoc);
    if (
      expectedOriginalUpdateTime !== undefined &&
      expectedOriginalUpdateTime !== originalDoc.updateTime
    ) {
      throw new CorrectedReplacementError(
        "stale_original",
        `Fact ${originalId} changed since the correction was prepared`,
        originalId,
        replacementId,
      );
    }

    if (!isAdminAuthorizedTransition(original.status, STATUS.retired)) {
      throw new FactStatusTransitionError(originalId, original.status, STATUS.retired);
    }

    // Read the replacement path before queueing either write. A transaction
    // read plus the subsequent set is an atomic create-or-conflict boundary;
    // an existing identity must never be overwritten by a correction.
    const existingReplacement = await tx.get(`fact_bank/${replacementId}`);
    if (existingReplacement) {
      throw new CorrectedReplacementError(
        "replacement_exists",
        `A fact already exists at the canonical replacement id ${replacementId}`,
        originalId,
        replacementId,
      );
    }

    // Resolve the CAS token before queueing either write. A malformed snapshot
    // therefore cannot leave a replacement write waiting behind a thrown
    // validation error, even in a defensive transaction double.
    const originalUpdateTime = requireUpdateTime(originalDoc);
    const originalPatch: Record<string, unknown> = {
      status: STATUS.retired,
      retired_reason: retirementReason,
      updated_at: timestamp,
    };

    tx.set(`fact_bank/${replacementId}`, replacement);
    tx.update(`fact_bank/${originalId}`, originalPatch, {
      updateTime: originalUpdateTime,
    });
    stagePreparedAudit(
      tx,
      auditAt(audit, originalDoc, {
        operation: "corrected_replacement",
        originalId,
        replacementId,
        original: {
          status: STATUS.retired,
          retired_reason: retirementReason,
        },
        replacement,
      }),
    );

    return {
      original: toFact(mergedFactDoc(originalDoc, originalPatch)),
      replacement: toFact({
        id: replacementId,
        path: `fact_bank/${replacementId}`,
        data: asJsonRecord(replacement),
      }),
    };
  });
}

/** Backwards-compatible name for the correction operation. */
export const replaceFact = createCorrectedReplacement;

export async function createFact(input: ImportFactInput): Promise<FactRecord> {
  const pendingFact = buildAdmissionFact(input, input.origin ?? PENDING_FACT_ORIGINS[0]);
  const id = await factId(pendingFact.subject_key, pendingFact.angle_key);
  const factPath = `fact_bank/${id}`;
  const subjectPath = pendingFact.category
    ? `fact_subjects/${pendingFact.subject_key}`
    : null;

  return runTransaction(async (tx) => {
    // The existence check and the create are one transaction: the
    // `exists: false` precondition is the atomic create, so a concurrent
    // import can no longer slip a second document past a stale read.
    if (await tx.get(factPath)) {
      throw new Error("A fact with this subject and angle already exists");
    }
    const subjectDoc = subjectPath ? await tx.get(subjectPath) : null;

    tx.update(factPath, asPlainRecord(pendingFact), { exists: false });

    if (subjectPath) {
      const subjectPatch: Record<string, unknown> = { category: pendingFact.category };
      if (pendingFact.sub_category) subjectPatch["sub_category"] = pendingFact.sub_category;
      if (subjectDoc) {
        tx.update(subjectPath, subjectPatch, {
          ...(subjectDoc.updateTime ? { updateTime: subjectDoc.updateTime } : {}),
        });
      } else {
        tx.set(subjectPath, {
          subject: pendingFact.subject,
          subject_key: pendingFact.subject_key,
          ...subjectPatch,
          aliases: [],
          playlist_ids: [],
          // Coverage is maintained by the reconciler, not by admission.
          createdAt: pendingFact.created_at,
        });
      }
    }

    return toFact({
      id,
      path: factPath,
      data: asJsonRecord(pendingFact),
    });
  });
}

/* ---------------------------------- reports --------------------------------- */

export interface ReportRecord {
  id: string;
  topic: string;
  initialTopic?: string;
  claimStatement: string;
  explanation: string;
  presentedNumber: number | null;
  trueNumber: number | null;
  unit: string;
  reason: string;
  feedbackText: string;
  reporterUid: string;
  status: string;
  createdAt: string | null;
  resolutionNote: string | null;
  questionId?: string;
  reportSource?: string;
  factId?: string;
  factPreviousStatus?: string;
  telemetryDays?: number | null;
  playerGuess?: string;
  isPlayerCorrect?: boolean | null;
  ombudsmanVerdict?: string;
  ombudsmanAgreed?: boolean | null;
  ombudsmanRuling?: string;
  ombudsmanSources: string[];
  ombudsmanArbiter?: "gemini" | "edge_worker" | "unspecified";
  qualityFlags?: string[];
  lintFindings?: {
    id: string;
    severity?: LintSeverity;
    enforcement?: LintEnforcement;
    detail?: string;
    docIds?: string[];
  }[];
  lintRulesRevision?: string;
  duplicateFactIds?: string[];
}

function asNum(value: Json | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asBool(value: Json | undefined): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "true" || lowered === "yes") return true;
    if (lowered === "false" || lowered === "no") return false;
  }
  return null;
}

function asSources(value: Json | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object") {
        const row = item as Record<string, Json>;
        return (
          firstStr(row, ["title", "uri", "url", "source", "citation", "name"]) ||
          JSON.stringify(item)
        );
      }
      return "";
    })
    .filter(Boolean);
}

/**
 * Parse the structured lint findings persisted by `foundry -lint-apply`.
 * Entries missing a non-empty `id` are dropped; everything else is passed
 * through verbatim because the producer owns finding semantics.
 */
function asLintFindings(value: Json | undefined): ReportRecord["lintFindings"] {
  if (!Array.isArray(value)) return undefined;
  const severities = new Set<string>(LINT_SEVERITIES);
  const enforcements = new Set<string>(LINT_ENFORCEMENTS);
  const findings: NonNullable<ReportRecord["lintFindings"]> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, Json>;
    const id = typeof row["id"] === "string" ? row["id"].trim() : "";
    if (!id) continue;
    const docIds = Array.isArray(row["docIds"])
      ? row["docIds"].filter((v): v is string => typeof v === "string" && v.trim() !== "")
      : undefined;
    findings.push({
      id,
      severity: severities.has(row["severity"] as string) ? (row["severity"] as LintSeverity) : undefined,
      enforcement: enforcements.has(row["enforcement"] as string) ? (row["enforcement"] as LintEnforcement) : undefined,
      detail: typeof row["detail"] === "string" ? row["detail"] : undefined,
      docIds: docIds && docIds.length ? docIds : undefined,
    });
  }
  return findings.length ? findings : undefined;
}

function toReport(doc: FirestoreDoc): ReportRecord {
  const d = doc.data;
  const sources = [
    ...asSources(d["ombudsmanSources"]),
    ...asSources(d["groundingSources"]),
    ...asSources(d["citations"]),
  ].filter((source, index, all) => all.indexOf(source) === index);

  const ruling =
    firstStr(d, ["ombudsmanRuling", "ombudsman_ruling", "ruling"]) || "";
  const explicitArbiter = firstStr(d, ["ombudsmanArbiter", "ombudsman_arbiter", "arbiter"]).toLowerCase();
  let arbiter: "gemini" | "edge_worker" | "unspecified" = "unspecified";
  if (explicitArbiter === "gemini" || explicitArbiter === "vertex" || explicitArbiter === "google") {
    arbiter = "gemini";
  } else if (
    explicitArbiter === "edge_worker" ||
    explicitArbiter === "edge" ||
    explicitArbiter === "worker"
  ) {
    arbiter = "edge_worker";
  } else if (
    sources.some((s) => /google|vertex|gemini/i.test(s)) ||
    /gemini|vertex|google search grounding/i.test(ruling)
  ) {
    arbiter = "gemini";
  } else if (sources.some((s) => /edge/i.test(s)) || /edge ombudsman/i.test(ruling)) {
    arbiter = "edge_worker";
  }

  const rawVerdict = firstStr(d, ["ombudsmanVerdict", "ombudsman_verdict", "verdict"]);
  const agreedFlag = asBool(d["ombudsmanAgreed"]) ?? asBool(d["ombudsman_agreed"]);
  const agreed =
    agreedFlag !== null
      ? agreedFlag
      : rawVerdict === "DEBUNKED_AND_EVICTED" || rawVerdict === "AMBIGUOUS_UNIT"
        ? true
        : rawVerdict === "VERIFIED_CANONICAL"
          ? false
          : null;

  return {
    id: doc.id,
    topic: firstStr(d, ["topic", "questionTopic", "question_topic"]),
    initialTopic: firstStr(d, ["initialTopic", "initial_topic", "selectedTopic", "category"]) || undefined,
    claimStatement: firstStr(d, ["claimStatement", "claim_statement", "claim", "question"]),
    explanation: canonicalExplanation(d, ["reveal"]),
    presentedNumber: asNum(d["presentedNumber"]) ?? asNum(d["presented_number"]),
    trueNumber: asNum(d["trueNumber"]) ?? asNum(d["true_number"]),
    unit: firstStr(d, ["unit"]),
    reason: firstStr(d, ["reason", "disputeReason", "dispute_reason"]),
    feedbackText: firstStr(d, ["feedbackText", "feedback_text", "feedback"]),
    reporterUid: firstStr(d, ["reporterUid", "reporter_uid", "uid"]),
    status: firstStr(d, ["status"]) || "pending_review",
    createdAt: typeof d["createdAt"] === "string" ? d["createdAt"] : typeof d["created_at"] === "string" ? d["created_at"] : null,
    resolutionNote: typeof d["resolutionNote"] === "string" ? d["resolutionNote"] : null,
    questionId: firstStr(d, ["questionId", "question_id"]) || undefined,
    reportSource: firstStr(d, ["reportSource", "report_source"]) || undefined,
    factId: firstStr(d, ["factId", "fact_id"]) || undefined,
    factPreviousStatus: firstStr(d, ["factPreviousStatus", "fact_previous_status"]) || undefined,
    telemetryDays: asNum(d["telemetryDays"]) ?? asNum(d["telemetry_days"]),
    playerGuess: firstStr(d, ["playerGuess", "player_guess", "guess", "choice"]) || undefined,
    isPlayerCorrect: asBool(d["isPlayerCorrect"]) ?? asBool(d["is_player_correct"]),
    ombudsmanVerdict: rawVerdict || undefined,
    ombudsmanAgreed: agreed,
    ombudsmanRuling: ruling || undefined,
    ombudsmanSources: sources,
    ombudsmanArbiter: arbiter,
    qualityFlags: asSources(d["qualityFlags"]).length
      ? asSources(d["qualityFlags"])
      : asSources(d["quality_flags"]),
    lintFindings: asLintFindings(d["lintFindings"] ?? d["lint_findings"]),
    lintRulesRevision:
      typeof d["lintRulesRevision"] === "string"
        ? d["lintRulesRevision"]
        : typeof d["lint_rules_revision"] === "string"
          ? d["lint_rules_revision"]
          : undefined,
    duplicateFactIds: asSources(d["duplicateFactIds"]).length
      ? asSources(d["duplicateFactIds"])
      : asSources(d["duplicate_fact_ids"]),
  };
}

export async function listReports(input: { status?: string; limit?: number; offset?: number }) {
  const docs = await runQuery({
    collection: "trivia_reports",
    filters: input.status ? [{ field: "status", op: "EQUAL", value: input.status }] : [],
    limit: input.limit ?? 100,
    offset: input.offset,
  });
  const reports = docs.map(toReport);
  reports.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return reports;
}

export async function getReport(id: string): Promise<ReportRecord | null> {
  const trimmed = id.trim();
  if (!trimmed) return null;
  const doc = await getDoc(`trivia_reports/${trimmed}`);
  return doc ? toReport(doc) : null;
}

/** Best-effort match from a report back to its fact-bank record. */
export async function findFactForReport(report: ReportRecord): Promise<FactRecord | null> {
  // 0. Direct match for signed-telemetry reports (fact:<docId> question ids).
  const directId =
    report.factId?.trim() ||
    (report.questionId?.startsWith("fact:")
      ? report.questionId.slice("fact:".length).trim()
      : "");
  if (directId) {
    const direct = await getDoc(`fact_bank/${directId}`);
    if (direct) return toFact(direct);
  }

  const topicKey = normalizeKey(report.topic);
  if (!topicKey) return null;

  // 1. Try matching by subject_key
  const subjectDocs = await runQuery({
    collection: "fact_bank",
    filters: [{ field: "subject_key", op: "EQUAL", value: topicKey }],
    limit: 20,
  });
  if (subjectDocs.length > 0) {
    const facts = subjectDocs.map(toFact);
    const exact = facts.find((fact) => fact.true_number === report.trueNumber);
    return exact ?? facts[0];
  }

  // 2. Try matching by angle_key
  const angleDocs = await runQuery({
    collection: "fact_bank",
    filters: [{ field: "angle_key", op: "EQUAL", value: topicKey }],
    limit: 20,
  });
  if (angleDocs.length > 0) {
    const facts = angleDocs.map(toFact);
    const exact = facts.find((fact) => fact.true_number === report.trueNumber);
    return exact ?? facts[0];
  }

  return null;
}

type DuplicateRefFact = Parameters<typeof areFactsDuplicateCandidates>[0];

function isDuplicateReportRecord(record: ReportRecord): boolean {
  const reason = record.reason?.toLowerCase() ?? "";
  return (
    Boolean(record.qualityFlags?.some(isDuplicateFlag)) ||
    reason.includes("duplicate_question") ||
    reason.includes("conflicting_answer")
  );
}

function reportRefFact(factId: string | undefined, record: ReportRecord): DuplicateRefFact {
  return {
    id: factId,
    question: record.claimStatement,
    claim_template: record.claimStatement,
    subject: record.topic,
    subject_key: normalizeKey(record.topic || ""),
  };
}

async function backfillDuplicateIds(report: ReportRecord, duplicates: Map<string, FactRecord>): Promise<void> {
  const mergedIds = Array.from(new Set([...(report.duplicateFactIds || []), ...duplicates.keys()]));
  await patchDoc(`trivia_reports/${report.id}`, { duplicateFactIds: mergedIds }).catch(() => {});
}

/** Adds the normalized first two words of `text`, when it has at least two. */
function addLeadingPairKey(keys: Set<string>, text: string): void {
  const words = text.trim().split(/\s+/);
  if (words.length >= 2) keys.add(normalizeKey(`${words[0]} ${words[1]}`));
}

function candidateSubjectKeys(primaryFact: FactRecord): Set<string> {
  const keys = new Set<string>();
  const subjectKey = primaryFact.subject_key || normalizeKey(primaryFact.subject);
  if (subjectKey) keys.add(subjectKey);

  // Also extract candidate keys from angle or question (e.g. Stevie Wonder in Grammy Awards)
  if (primaryFact.angle) {
    keys.add(normalizeKey(primaryFact.angle));
    addLeadingPairKey(keys, primaryFact.angle);
  }
  if (primaryFact.question) {
    addLeadingPairKey(keys, primaryFact.question);
  }
  return keys;
}

/** State shared by the duplicate lookup steps: the report under review and the duplicates found so far. */
type DuplicateLookup = {
  report: ReportRecord;
  primaryId: string | undefined;
  duplicates: Map<string, FactRecord>;
};

/** A fact ID still worth checking: non-empty, not the primary fact, and not already found. */
function isNewDuplicateId(lookup: DuplicateLookup, factId: string): boolean {
  return Boolean(factId) && factId !== lookup.primaryId && !lookup.duplicates.has(factId);
}

/** The fact ID a batch sibling points at, when that sibling is an unaccounted-for duplicate report. */
function batchSiblingFactId(lookup: DuplicateLookup, other: ReportRecord): string | null {
  if (other.id === lookup.report.id) return null;
  const factId = other.factId?.trim();
  if (!factId) return null;
  if (!isNewDuplicateId(lookup, factId)) return null;
  return isDuplicateReportRecord(other) ? factId : null;
}

/** Loads a fact by ID, returning it only when it is a duplicate candidate of `refFact`. */
async function loadMatchingFact(factId: string, refFact: DuplicateRefFact): Promise<FactRecord | null> {
  const doc = await getDoc(`fact_bank/${factId}`);
  if (!doc) return null;
  const fact = toFact(doc);
  return areFactsDuplicateCandidates(refFact, fact) ? fact : null;
}

async function linkSiblingToPrimary(sibling: ReportRecord, primaryId: string): Promise<void> {
  const mergedIds = Array.from(new Set([...(sibling.duplicateFactIds || []), primaryId]));
  await patchDoc(`trivia_reports/${sibling.id}`, { duplicateFactIds: mergedIds }).catch(() => {});
}

/** Step 1: duplicate IDs already recorded on the report, kept only when they validate. */
async function collectRecordedDuplicates(lookup: DuplicateLookup, primaryFact: FactRecord | null): Promise<void> {
  const validDupIds: string[] = [];
  let hadInvalid = false;
  for (const dupId of lookup.report.duplicateFactIds ?? []) {
    if (!isNewDuplicateId(lookup, dupId)) continue;
    const doc = await getDoc(`fact_bank/${dupId}`);
    if (!doc) continue;

    const fact = toFact(doc);
    if (primaryFact && !areFactsDuplicateCandidates(primaryFact, fact)) {
      hadInvalid = true;
      continue;
    }
    lookup.duplicates.set(dupId, fact);
    validDupIds.push(dupId);
  }
  // Clean up corrupted duplicateFactIds in Firestore if invalid IDs were stored
  if (hadInvalid) {
    await patchDoc(`trivia_reports/${lookup.report.id}`, { duplicateFactIds: validDupIds }).catch(() => {});
  }
}

/** Step 2: other pending duplicate reports in the same batch that point at a matching fact. */
async function collectBatchDuplicates(
  lookup: DuplicateLookup,
  refFact: DuplicateRefFact,
  allReports: ReportRecord[],
): Promise<void> {
  let newDuplicatesFound = false;
  for (const other of allReports) {
    const otherFactId = batchSiblingFactId(lookup, other);
    if (!otherFactId) continue;
    if (!areFactsDuplicateCandidates(refFact, reportRefFact(otherFactId, other))) continue;

    const fact = await loadMatchingFact(otherFactId, refFact);
    if (!fact) continue;
    lookup.duplicates.set(otherFactId, fact);
    newDuplicatesFound = true;
    if (lookup.primaryId) await linkSiblingToPrimary(other, lookup.primaryId);
  }

  if (newDuplicatesFound) {
    await backfillDuplicateIds(lookup.report, lookup.duplicates);
  }
}

/** Adds the fact_bank documents under one subject key that duplicate `primaryFact`. */
async function collectQueriedKey(
  key: string,
  primaryFact: FactRecord,
  duplicates: Map<string, FactRecord>,
): Promise<void> {
  const docs = await runQuery({
    collection: "fact_bank",
    filters: [{ field: "subject_key", op: "EQUAL", value: key }],
    limit: 100,
  });
  for (const d of docs) {
    if (d.id === primaryFact.id || duplicates.has(d.id)) continue;
    const candidate = toFact(d);
    if (areFactsDuplicateCandidates(primaryFact, candidate)) {
      duplicates.set(d.id, candidate);
    }
  }
}

/** Step 3: query fact_bank by candidate subject key, stopping at the first key with a match. */
async function collectQueriedDuplicates(lookup: DuplicateLookup, primaryFact: FactRecord): Promise<void> {
  for (const key of candidateSubjectKeys(primaryFact)) {
    if (!key) continue;
    await collectQueriedKey(key, primaryFact, lookup.duplicates);
    if (lookup.duplicates.size > 0) {
      // Backfill on the report doc so future loads hit step 1 immediately
      await backfillDuplicateIds(lookup.report, lookup.duplicates);
      return;
    }
  }
}

/** Best-effort lookup for other facts that duplicate or collide with this report. */
export async function findDuplicateFactsForReport(
  report: ReportRecord,
  primaryFact: FactRecord | null,
  allReports?: ReportRecord[],
): Promise<FactRecord[]> {
  const lookup: DuplicateLookup = {
    report,
    primaryId: primaryFact?.id ?? report.factId?.trim(),
    duplicates: new Map<string, FactRecord>(),
  };

  await collectRecordedDuplicates(lookup, primaryFact);

  // Later steps only run for duplicate-flagged reports that have found nothing yet.
  if (!isDuplicateReportRecord(report) || lookup.duplicates.size > 0) {
    return Array.from(lookup.duplicates.values());
  }

  if (allReports?.length) {
    await collectBatchDuplicates(lookup, primaryFact ?? reportRefFact(lookup.primaryId, report), allReports);
  }

  if (lookup.duplicates.size === 0 && primaryFact) {
    await collectQueriedDuplicates(lookup, primaryFact);
  }

  return Array.from(lookup.duplicates.values());
}

/**
 * Apply one moderation action as a single transaction: the report, the fact
 * documents it touches, any counterpart lint reports, and the staged audit
 * entry all commit together, each guarded by the update time read inside the
 * transaction. A concurrent edit therefore aborts and retries the whole
 * resolution rather than letting a stale flag list or status slip through.
 *
 * Lifecycle rules enforced here (contract-derived, never restated):
 *  - Status moves go through `statusTransitionPatch`, which re-checks the
 *    shared contract inside the transaction. Nothing restores a stored
 *    `factPreviousStatus` verbatim; `pending` and `retired` facts can never
 *    be reinstated by rejecting or resolving a report.
 *  - Material edits (`fix_number`, `edit_fact`, duplicate `correctedNumber`)
 *    revoke the stored approval via `buildFactEditPlan`: receipt and content
 *    fingerprint are deleted, lint evidence cleared, and `quality_hold` marks
 *    the revision as awaiting a fresh audit. `verified_at`/`verifier_model`
 *    stay auditor-owned. A fact reinstated to `active` here is still not
 *    playable: publication is bound to the Go export's `ready_ids` and the
 *    deployed manifest row, which require a current-revision receipt, not the
 *    lifecycle status. The hold clears only when a fresh audit mints one.
 *  - Clearing flag findings appends an append-only `quality_reviews` record
 *    bound to the revision reviewed (stored fingerprint + update time +
 *    lint rules revision). `resolve_as_is` and lint-report rejections record
 *    `finding_accepted`; corrections record `finding_cleared`.
 *  - A lint report that carries `fact_update_time` only restores a fact whose
 *    revision still matches; a stale binding resolves the report but leaves
 *    the fact untouched.
 */
export async function resolveReport(input: {
  reportId: string;
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
  correctedNumber?: number;
  factUpdates?: Partial<FactEditInput>;
  note?: string;
  topic?: string;
  claimStatement?: string;
  unit?: string;
  keepFactId?: string;
  retireFactId?: string;
  retireFactIds?: string[];
  /** Moderator performing the action; recorded on review records. */
  admin?: AdminUser;
  /** Prepared audit entry staged into the same transaction. */
  audit?: PreparedAuditEntry;
  /** Caller-supplied payload recorded as the staged audit's `after`. */
  auditAfter?: Record<string, unknown>;
}): Promise<{ ok: true }> {
  const now = new Date().toISOString();
  const actor = input.admin?.email ?? input.admin?.uid ?? "system";

  // The add_to_bank fact is built inside the transaction, after the report is
  // read, so its explanation is the report's canonical explanation rather than
  // a moderator note. `factId` is a pure hash, safe on transaction retries.

  const result = await runTransaction<{ ok: true }>(async (tx) => {
    const reportPath = `trivia_reports/${input.reportId}`;
    const reportDoc = await tx.get(reportPath);
    if (!reportDoc) throw new Error(`Report ${input.reportId} not found`);
    const reportData = reportDoc.data;
    const resolveReportDoc = (note: string, extra?: Record<string, unknown>, deletes?: string[]) => {
      tx.update(
        reportPath,
        { status: "resolved", resolutionNote: note, resolved_at: now, ...extra },
        { updateTime: requireUpdateTime(reportDoc), ...(deletes?.length ? { deletePaths: deletes } : {}) },
      );
    };
    const stageAudit = (after: unknown, before: FirestoreDoc | null = null) => {
      if (input.audit) {
        const payload =
          input.auditAfter === undefined
            ? after
            : {
                ...(typeof after === "object" && after !== null
                  ? (after as Record<string, unknown>)
                  : { result: after }),
                ...input.auditAfter,
              };
        stagePreparedAudit(tx, auditAt(input.audit, before ?? reportDoc, payload));
      }
    };

    const clearDisputeWithReview = (
      factDoc: FirestoreDoc,
      kind: "finding_accepted" | "finding_cleared",
      reason: string,
      extraDeletes: string[] = [],
    ): { patch: Record<string, unknown>; deletePaths: string[] } => {
      const findingIds = currentFindingIds(factDoc.data);
      const patch: Record<string, unknown> = {};
      const review = buildQualityReview({
        factId: factDoc.id,
        kind,
        actor,
        reason,
        findingIds,
        doc: factDoc,
        now,
      });
      patch["quality_reviews"] = appendQualityReview(factDoc.data["quality_reviews"], review);
      return { patch, deletePaths: [...DISPUTE_CLEAR_PATHS, ...extraDeletes] };
    };

    const reportBoundRevisionStale = (factDoc: FirestoreDoc): boolean => {
      // A telemetry report that wrote its own dispute binds the `disputed_at`
      // stamp it produced: the pre-write updateTime is invalidated by that
      // very commit. Lint and untouched-fact telemetry reports bind the
      // fact's updateTime revision directly.
      const boundDispute = reportData["fact_disputed_at"];
      if (typeof boundDispute === "string" && boundDispute.length > 0) {
        return factDoc.data["disputed_at"] !== boundDispute;
      }
      const bound = reportData["fact_update_time"];
      return typeof bound === "string" && bound.length > 0 && bound !== factDoc.updateTime;
    };

    // ------------------------------------------------------------------
    if (input.action === "resolve_duplicate") {
      const keepId = input.keepFactId?.trim() || null;
      const retireIds = [
        ...(input.retireFactId ? [input.retireFactId.trim()] : []),
        ...(input.retireFactIds ? input.retireFactIds.map((id) => id.trim()) : []),
      ].filter((id) => id && id !== keepId);

      const loserDocs: FirestoreDoc[] = [];
      const loserReports: (FirestoreDoc | null)[] = [];
      for (const retireId of retireIds) {
        const doc = await tx.get(`fact_bank/${retireId}`);
        if (!doc) throw new Error(`Fact ${retireId} not found`);
        loserDocs.push(doc);
        loserReports.push(await tx.get(`trivia_reports/lint_${retireId}`));
      }
      const keepDoc = keepId ? await tx.get(`fact_bank/${keepId}`) : null;
      const keepReportDoc =
        keepId && `lint_${keepId}` !== input.reportId
          ? await tx.get(`trivia_reports/lint_${keepId}`)
          : null;

      for (const doc of loserDocs) {
        const loser = toFact(doc);
        tx.update(
          `fact_bank/${doc.id}`,
          statusTransitionPatch(
            doc.id,
            String(loser.status),
            STATUS.retired,
            input.note ?? (keepId ? `Retired in favor of duplicate fact ${keepId}` : "Retired as duplicate fact"),
            now,
          ),
          { updateTime: requireUpdateTime(doc) },
        );
      }
      loserReports.forEach((loserReport, i) => {
        if (loserReport && loserReport.data["status"] === "pending_review") {
          tx.update(
            `trivia_reports/lint_${retireIds[i]}`,
            {
              status: "resolved",
              resolutionNote: `Auto-resolved: duplicate resolved via ${input.reportId}`,
              resolved_at: now,
            },
            { updateTime: requireUpdateTime(loserReport) },
          );
        }
      });

      let remainingFlags: string[] = [];
      if (keepDoc) {
        const keepFact = toFact(keepDoc);
        let patch: Record<string, unknown> = {};
        let deletePaths: string[] = [];
        if (input.correctedNumber !== undefined) {
          const plan = buildFactEditPlan(
            keepDoc,
            { id: keepDoc.id, true_number: input.correctedNumber },
            now,
          );
          patch = { ...patch, ...plan.patch };
          deletePaths = [...deletePaths, ...(plan.deletePaths ?? [])];
        }
        const currentFlags = keepFact.quality_flags;
        remainingFlags = currentFlags.filter(isNonDuplicateFlag);
        if (remainingFlags.length === 0) {
          const cleared = clearDisputeWithReview(
            keepDoc,
            "finding_cleared",
            input.note ?? "Duplicate resolved; remaining findings cleared",
          );
          patch = { ...patch, ...cleared.patch };
          deletePaths = [...deletePaths, ...cleared.deletePaths];
          if (String(keepFact.status) === STATUS.disputed) {
            patch = {
              ...patch,
              ...statusTransitionPatch(
                keepDoc.id,
                STATUS.disputed,
                STATUS.active,
                input.note ?? "Reinstated duplicate winner via moderation",
                now,
              ),
            };
          }
        } else {
          patch["quality_flags"] = remainingFlags;
          patch["disputed_reason"] = `fact_lint: ${remainingFlags.join(",")}`;
        }
        patch["updated_at"] = now;
        tx.update(`fact_bank/${keepDoc.id}`, patch, {
          updateTime: requireUpdateTime(keepDoc),
          deletePaths,
        });

        if (keepReportDoc && keepReportDoc.data["status"] === "pending_review") {
          tx.update(
            `trivia_reports/lint_${keepId}`,
            remainingFlags.length === 0
              ? {
                  status: "resolved",
                  resolutionNote: `Auto-resolved: duplicate resolved via ${input.reportId}`,
                  resolved_at: now,
                }
              : {
                  qualityFlags: remainingFlags,
                  resolutionNote: `Duplicate resolved via ${input.reportId}; remaining flags: ${remainingFlags.join(", ")}`,
                },
            { updateTime: requireUpdateTime(keepReportDoc) },
          );
        }
      }

      const defaultNote =
        remainingFlags.length > 0
          ? `Kept ${keepId} (retired ${retireIds.join(", ") || "duplicates"}; remaining flags: ${remainingFlags.join(", ")})`
          : `Kept ${keepId ?? "chosen fact"}, retired duplicate ${retireIds.join(", ") || "other"}`;
      const isKeptFactReport = Boolean(
        keepId && (input.reportId === `lint_${keepId}` || input.factId === keepId),
      );
      if (isKeptFactReport && remainingFlags.length > 0) {
        tx.update(
          reportPath,
          {
            qualityFlags: remainingFlags,
            reason: `fact_lint: ${remainingFlags.join(",")}`,
            resolutionNote: input.note ?? defaultNote,
          },
          {
            updateTime: requireUpdateTime(reportDoc),
            deletePaths: ["duplicateFactIds", "duplicate_fact_ids"],
          },
        );
      } else {
        resolveReportDoc(input.note ?? defaultNote);
      }
      stageAudit({ action: input.action, keepFactId: keepId, retireFactIds: retireIds });
      return { ok: true };
    }

    // ------------------------------------------------------------------
    if (input.action === "retire_fact") {
      const factDoc = input.factId ? await tx.get(`fact_bank/${input.factId}`) : null;
      if (factDoc) {
        const existing = toFact(factDoc);
        tx.update(
          `fact_bank/${factDoc.id}`,
          statusTransitionPatch(
            factDoc.id,
            String(existing.status),
            STATUS.retired,
            input.note ?? "Retired via player report",
            now,
          ),
          { updateTime: requireUpdateTime(factDoc) },
        );
      }
      resolveReportDoc(input.note ?? (input.factId ? "Fact retired" : "Report accepted"));
      stageAudit({ action: input.action });
      return { ok: true };
    }

    // ------------------------------------------------------------------
    if (input.action === "fix_number" || input.action === "edit_fact") {
      const factDoc = input.factId ? await tx.get(`fact_bank/${input.factId}`) : null;
      const editInput: FactEditInput | null =
        input.action === "fix_number"
          ? input.correctedNumber !== undefined
            ? { id: input.factId ?? "", true_number: input.correctedNumber }
            : null
          : input.factUpdates
            ? { id: input.factId ?? "", ...input.factUpdates }
            : null;
      if (factDoc && editInput) {
        const existing = toFact(factDoc);
        assertFactIdentityUnchanged(editInput, existing);
        const plan = buildFactEditPlan(factDoc, editInput, now);
        const cleared = clearDisputeWithReview(
          factDoc,
          "finding_cleared",
          input.note ?? "Fact corrected via moderation",
          plan.deletePaths ?? [],
        );
        let patch = { ...plan.patch, ...cleared.patch };
        const reinstateTarget = reinstatementTargetFor(String(existing.status));
        if (reinstateTarget !== null) {
          patch = {
            ...patch,
            ...statusTransitionPatch(
              factDoc.id,
              String(existing.status),
              reinstateTarget,
              input.note ?? "Fact updated and reinstated via moderation",
              now,
            ),
          };
        }
        patch["updated_at"] = now;
        tx.update(`fact_bank/${factDoc.id}`, patch, {
          updateTime: requireUpdateTime(factDoc),
          deletePaths: cleared.deletePaths,
        });
      }
      resolveReportDoc(
        input.note ??
          (input.correctedNumber !== undefined
            ? `Corrected to ${input.correctedNumber}`
            : input.action === "fix_number"
              ? "Report accepted"
              : "Fact updated and resolved via moderation"),
      );
      stageAudit({ action: input.action, edit: editInput ?? null });
      return { ok: true };
    }

    // ------------------------------------------------------------------
    if (input.action === "resolve_as_is") {
      const factDoc = input.factId ? await tx.get(`fact_bank/${input.factId}`) : null;
      if (factDoc) {
        const existing = toFact(factDoc);
        const cleared = clearDisputeWithReview(
          factDoc,
          "finding_accepted",
          input.note ?? "Accepted fact as-is via moderation",
        );
        let patch = cleared.patch;
        const reinstateTarget = reinstatementTargetFor(String(existing.status));
        if (reinstateTarget !== null) {
          patch = {
            ...patch,
            ...statusTransitionPatch(
              factDoc.id,
              String(existing.status),
              reinstateTarget,
              input.note ?? "Accepted fact as-is via moderation",
              now,
            ),
          };
        }
        patch["updated_at"] = now;
        tx.update(`fact_bank/${factDoc.id}`, patch, {
          updateTime: requireUpdateTime(factDoc),
          deletePaths: cleared.deletePaths,
        });
      }
      resolveReportDoc(input.note ?? "Report accepted: fact verified as-is");
      stageAudit({ action: input.action });
      return { ok: true };
    }

    // ------------------------------------------------------------------
    if (input.action === "add_to_bank") {
      const addToBankFact = buildAddToBankFact({
        ...input,
        reportExplanation: canonicalExplanation(reportData) || undefined,
      });
      const addToBankId = await factId(addToBankFact.subject_key, addToBankFact.angle_key);
      const factPath = `fact_bank/${addToBankId}`;
      const existingFact = await tx.get(factPath);
      if (existingFact) throw new Error("A fact with this subject and angle already exists");
      let subjectDoc: FirestoreDoc | null = null;
      const subjectPath = addToBankFact.category
        ? `fact_subjects/${addToBankFact.subject_key}`
        : null;
      if (subjectPath) subjectDoc = await tx.get(subjectPath);

      tx.update(factPath, asPlainRecord(addToBankFact), { exists: false });
      if (subjectPath) {
        const subjectPatch: Record<string, unknown> = { category: addToBankFact.category };
        if (addToBankFact.sub_category) subjectPatch["sub_category"] = addToBankFact.sub_category;
        if (subjectDoc) {
          tx.update(subjectPath, subjectPatch, {
            ...(subjectDoc.updateTime ? { updateTime: subjectDoc.updateTime } : {}),
          });
        } else {
          tx.set(subjectPath, {
            subject: addToBankFact.subject,
            subject_key: addToBankFact.subject_key,
            ...subjectPatch,
            aliases: [],
            playlist_ids: [],
            createdAt: addToBankFact.created_at,
          });
        }
      }
      const note = input.note?.trim();
      resolveReportDoc(note ? `${note} — ${PENDING_ADMISSION_COPY}` : PENDING_ADMISSION_COPY);
      stageAudit({ action: input.action, createdFactId: addToBankId });
      return { ok: true };
    }

    // ------------------------------------------------------------------
    if (input.action === "resolve_only") {
      resolveReportDoc(input.note ?? "Report accepted");
      stageAudit({ action: input.action });
      return { ok: true };
    }

    // ------------------------------------------------------------------
    // Reject: restore a fact auto-disputed by signed telemetry or fact lint,
    // but only along a contract-authorized transition. `factPreviousStatus`
    // on the report is never written back: it is metadata recorded for
    // context, and only `disputed -> active` is reachable from here, so a
    // `pending`/`retired` fact can never be reinstated through a stale or
    // forged report field.
    const storedFactId =
      typeof reportData["factId"] === "string" && reportData["factId"].trim()
        ? (reportData["factId"] as string).trim()
        : typeof reportData["questionId"] === "string" && (reportData["questionId"] as string).startsWith("fact:")
          ? ((reportData["questionId"] as string).slice("fact:".length).trim() || null)
          : null;
    const isLintSource = reportData["reportSource"] === "fact_lint";
    const isTelemetrySource = reportData["reportSource"] === "round_telemetry";
    let remainingFlags: string[] = [];
    if (storedFactId && (isLintSource || isTelemetrySource)) {
      // Read phase: every document this action may touch is read before any
      // write is queued, so the transaction applies reads-before-writes and
      // retries stay legal.
      const factDoc = await tx.get(`fact_bank/${storedFactId}`);
      const duplicateIds = isLintSource
        ? asSources(reportData["duplicateFactIds"] ?? reportData["duplicate_fact_ids"])
        : [];
      const dupDocs: (FirestoreDoc | null)[] = [];
      const dupReports: (FirestoreDoc | null)[] = [];
      for (const dupId of duplicateIds) {
        if (!dupId || dupId === storedFactId) {
          dupDocs.push(null);
          dupReports.push(null);
          continue;
        }
        dupDocs.push(await tx.get(`fact_bank/${dupId}`));
        dupReports.push(await tx.get(`trivia_reports/lint_${dupId}`));
      }

      // Write phase.
      const recordedReason = factDoc ? String(factDoc.data["disputed_reason"] ?? "") : "";
      const disputeOwnedBySource = factDoc
        ? isLintSource
          // Legacy disputes predate `disputed_reason`; a fact_lint report still
          // owns the dispute when no other owner is recorded.
          ? !recordedReason || recordedReason.startsWith("fact_lint:")
          // Symmetric guard: a telemetry report rejection cannot clear a
          // lint-owned dispute.
          : !recordedReason || recordedReason.startsWith("round_telemetry")
        : false;
      if (
        factDoc &&
        factDoc.data["status"] === STATUS.disputed &&
        disputeOwnedBySource &&
        !reportBoundRevisionStale(factDoc)
      ) {
        const currentFlags = Array.isArray(factDoc.data["quality_flags"])
          ? (factDoc.data["quality_flags"] as string[])
          : [];
        remainingFlags = isLintSource ? currentFlags.filter(isNonDuplicateFlag) : [];
        if (remainingFlags.length === 0) {
          const cleared = clearDisputeWithReview(
            factDoc,
            "finding_accepted",
            input.note ?? "Report rejected; findings dismissed",
          );
          const patch = {
            ...cleared.patch,
            ...statusTransitionPatch(
              factDoc.id,
              STATUS.disputed,
              STATUS.active,
              input.note ?? "Reinstated after rejected report",
              now,
            ),
          };
          tx.update(`fact_bank/${factDoc.id}`, patch, {
            updateTime: requireUpdateTime(factDoc),
            deletePaths: cleared.deletePaths,
          });
        } else {
          tx.update(
            `fact_bank/${factDoc.id}`,
            {
              quality_flags: remainingFlags,
              disputed_reason: `fact_lint: ${remainingFlags.join(",")}`,
              updated_at: now,
            },
            { updateTime: requireUpdateTime(factDoc) },
          );
        }
      }

      for (let i = 0; i < duplicateIds.length; i++) {
        const dupDoc = dupDocs[i];
        const dupReport = dupReports[i];
        if (!dupDoc) continue;
        let dupRemaining: string[] = [];
        if (dupDoc.data["status"] === STATUS.disputed) {
          const currentFlags = Array.isArray(dupDoc.data["quality_flags"])
            ? (dupDoc.data["quality_flags"] as string[])
            : [];
          dupRemaining = currentFlags.filter(isNonDuplicateFlag);
          if (dupRemaining.length === 0) {
            const cleared = clearDisputeWithReview(
              dupDoc,
              "finding_accepted",
              `Counterpart report ${input.reportId} rejected; findings dismissed`,
            );
            const patch = {
              ...cleared.patch,
              ...statusTransitionPatch(
                dupDoc.id,
                STATUS.disputed,
                STATUS.active,
                input.note ?? "Reinstated duplicate counterpart via moderation",
                now,
              ),
            };
            tx.update(`fact_bank/${dupDoc.id}`, patch, {
              updateTime: requireUpdateTime(dupDoc),
              deletePaths: cleared.deletePaths,
            });
          } else {
            tx.update(
              `fact_bank/${dupDoc.id}`,
              {
                quality_flags: dupRemaining,
                disputed_reason: `fact_lint: ${dupRemaining.join(",")}`,
                updated_at: now,
              },
              { updateTime: requireUpdateTime(dupDoc) },
            );
          }
        }
        if (dupReport && dupReport.data["status"] === "pending_review") {
          tx.update(
            `trivia_reports/lint_${duplicateIds[i]}`,
            dupRemaining.length === 0
              ? {
                  status: "rejected",
                  resolutionNote: input.note ?? `Auto-rejected: counterpart report ${input.reportId} rejected`,
                  resolved_at: now,
                }
              : {
                  qualityFlags: dupRemaining,
                  reason: `fact_lint: ${dupRemaining.join(",")}`,
                  resolutionNote: `Duplicate dismissed via ${input.reportId}; remaining flags: ${dupRemaining.join(", ")}`,
                },
            {
              updateTime: requireUpdateTime(dupReport),
              ...(dupRemaining.length > 0
                ? { deletePaths: ["duplicateFactIds", "duplicate_fact_ids"] }
                : {}),
            },
          );
        }
      }
    }

    if (remainingFlags.length > 0) {
      tx.update(
        reportPath,
        {
          qualityFlags: remainingFlags,
          reason: `fact_lint: ${remainingFlags.join(",")}`,
          resolutionNote: input.note ?? `Duplicate dismissed; remaining flags: ${remainingFlags.join(", ")}`,
        },
        {
          updateTime: requireUpdateTime(reportDoc),
          deletePaths: ["duplicateFactIds", "duplicate_fact_ids"],
        },
      );
    } else {
      tx.update(
        reportPath,
        {
          status: "rejected",
          resolutionNote: input.note ?? "Report rejected",
          resolved_at: now,
        },
        { updateTime: requireUpdateTime(reportDoc) },
      );
    }
    stageAudit({ action: input.action, factId: storedFactId });
    return { ok: true };
  });

  return result;
}

/**
 * Build the pending admission document for the report `add_to_bank` action.
 * The report path is admitted with the same canonical builder as manual and
 * CSV paths, but carries its own origin for auditability.
 */
function buildAddToBankFact(input: {
  topic?: string;
  claimStatement?: string;
  correctedNumber?: number;
  unit?: string;
  note?: string;
  reportExplanation?: string;
}): PendingFact {
  const subject = input.topic || "General";
  const angle = input.claimStatement || subject;
  const true_number = input.correctedNumber ?? 0;
  const unit = input.unit || "";
  const claim_template = input.claimStatement
    ? input.claimStatement.replace(new RegExp(String(true_number), "g"), "{n}")
    : `${subject}: {n} ${unit}`;
  const explanation =
    input.reportExplanation || input.note?.trim() || input.claimStatement || subject;
  return buildAdmissionFact(
    {
      subject,
      angle,
      true_number,
      unit,
      claim_template: claim_template.includes("{n}")
        ? claim_template
        : `${claim_template} {n}`,
      explanation,
      question: input.claimStatement || subject,
      surprise_factor: 2,
      content_rating: "standard",
      source_urls: [],
      origin: PENDING_FACT_ORIGINS[2],
    },
    PENDING_FACT_ORIGINS[2],
  );
}

/**
 * Reconciles and auto-resolves pending `fact_lint` moderation reports whose underlying
 * facts are already active and clean, retired, or deleted.
 */
export async function flushStaleReports(limit = 200): Promise<{
  flushed: number;
  totalChecked: number;
  details: string[];
}> {
  const now = new Date().toISOString();
  const reports = await runQuery({
    collection: "trivia_reports",
    filters: [{ field: "status", op: "EQUAL", value: "pending_review" }],
    limit,
  });

  let flushed = 0;
  let totalChecked = 0;
  const details: string[] = [];

  for (const reportDoc of reports) {
    const data = reportDoc.data;
    if (data["reportSource"] !== "fact_lint") continue;
    totalChecked++;

    const factId =
      typeof data["factId"] === "string" && data["factId"].trim()
        ? (data["factId"] as string).trim()
        : null;
    if (!factId) {
      details.push(`${reportDoc.id}: Auto-resolved: report missing factId`);
      flushed++;
      await runTransaction(async (tx) => {
        const current = await tx.get(`trivia_reports/${reportDoc.id}`);
        if (!current || current.data["status"] !== "pending_review") return;
        tx.update(
          `trivia_reports/${reportDoc.id}`,
          { status: "resolved", resolutionNote: "Auto-resolved: report missing factId", resolved_at: now },
          { updateTime: requireUpdateTime(current) },
        );
      });
      continue;
    }

    // The fact read and the report resolution share one transaction: a fact
    // re-disputed between the check and the write aborts the resolution and
    // the retried callback re-evaluates the fresh snapshot instead of
    // clearing a live dispute's report.
    const note = await runTransaction(async (tx) => {
      const current = await tx.get(`trivia_reports/${reportDoc.id}`);
      if (!current || current.data["status"] !== "pending_review") return null;
      const factDoc = await tx.get(`fact_bank/${factId}`);
      let autoNote: string | null = null;
      if (!factDoc) {
        autoNote = "Auto-resolved: underlying fact no longer exists";
      } else {
        const stat = factDoc.data["status"];
        if (stat === STATUS.retired) {
          autoNote = "Auto-resolved: underlying fact was retired";
        } else if (stat === STATUS.active) {
          const qf = Array.isArray(factDoc.data["quality_flags"])
            ? (factDoc.data["quality_flags"] as string[])
            : [];
          if (qf.length === 0) {
            autoNote = "Auto-resolved: fact is active and passes all lint rules";
          }
        }
      }
      if (!autoNote) return null;
      tx.update(
        `trivia_reports/${reportDoc.id}`,
        { status: "resolved", resolutionNote: autoNote, resolved_at: now },
        { updateTime: requireUpdateTime(current) },
      );
      return autoNote;
    });
    if (note) {
      flushed++;
      details.push(`${reportDoc.id}: ${note}`);
    }
  }

  return { flushed, totalChecked, details };
}

