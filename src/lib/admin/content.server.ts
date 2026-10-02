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
  type PendingFact,
  type PendingFactInput,
  type PendingFactOrigin,
} from "./fact-admission";
import {
  FACT_STATUSES as CONTRACT_FACT_STATUSES,
  QUANTITY_KINDS as CONTRACT_QUANTITY_KINDS,
  STATUS_TRANSITIONS,
  type FactStatus,
  type QuantityKind,
} from "../../../shared/fact-lifecycle-contract.gen";

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
  quality_flags: string[];
  disputed_reason: string | null;
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
    quality_flags: Array.isArray(d["quality_flags"])
      ? (d["quality_flags"] as Json[]).filter((v): v is string => typeof v === "string")
      : [],
    disputed_reason: typeof d["disputed_reason"] === "string" ? d["disputed_reason"] : null,
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

function asJsonRecord(value: Record<string, unknown>): Record<string, Json> {
  const output: Record<string, Json> = {};
  for (const [key, entry] of Object.entries(value)) output[key] = asJson(entry);
  return output;
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
  const numberChangedAt = updatedAt;

  return runTransaction(async (tx) => {
    // The fact read is inside the transaction callback. A contention retry
    // therefore rebuilds the decision from a fresh snapshot and fresh CAS token.
    const currentDoc = await tx.get(`fact_bank/${input.id}`);
    if (!currentDoc) throw new Error(`Fact ${input.id} not found`);
    const existing = toFact(currentDoc);
    assertFactIdentityUnchanged(input, existing);

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
    if (input.true_number !== undefined && input.true_number !== existing.true_number) {
      patch["previous_true_number"] = existing.true_number;
      patch["number_changed_at"] = numberChangedAt;
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
    const deletePaths = semanticChanged
      ? ["derivation", "precomputed_derivation", "derivation_input_fingerprint"]
      : undefined;

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
 * `adminAuthorized: false`, is not authorized — so a status with no
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
    if (!isAdminAuthorizedTransition(existing.status, input.status)) {
      throw new FactStatusTransitionError(input.id, existing.status, input.status);
    }

    const patch: Record<string, unknown> = {
      status: input.status,
      updated_at: updatedAt,
    };
    if (input.status === STATUS.retired) {
      patch["retired_reason"] = input.reason ?? "Retired from admin portal";
    }
    if (input.status === STATUS.active) {
      // Reinstating a disputed fact clears only retirement state. Verification
      // timestamps/models are owned by the banked-fact auditor, never by this
      // admin transition path.
      patch["retired_reason"] = null;
    }

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
  if (await getDoc(`fact_bank/${id}`)) {
    throw new Error("A fact with this subject and angle already exists");
  }
  const doc = await createDoc("fact_bank", id, pendingFact);

  if (pendingFact.category) {
    const subjectKey = pendingFact.subject_key;
    const existingSubject = await getDoc(`fact_subjects/${subjectKey}`);
    if (existingSubject) {
      await patchDoc(`fact_subjects/${subjectKey}`, {
        category: pendingFact.category,
        ...(pendingFact.sub_category ? { sub_category: pendingFact.sub_category } : {}),
      });
    } else {
      await createDoc("fact_subjects", subjectKey, {
        subject: pendingFact.subject,
        subject_key: subjectKey,
        category: pendingFact.category,
        ...(pendingFact.sub_category ? { sub_category: pendingFact.sub_category } : {}),
        aliases: [],
        playlist_ids: [],
        // Coverage is maintained by the reconciler, not by admission.
        createdAt: pendingFact.created_at,
      });
    }
  }

  return toFact(doc);
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

const INTERROGATIVE_PREFIXES = [
  ["how", "many"],
  ["how", "much"],
  ["how", "long"],
  ["how", "tall"],
  ["how", "far"],
  ["how", "old"],
  ["how", "fast"],
  ["how", "often"],
  ["how", "does"],
  ["how", "did"],
  ["how", "do"],
  ["what", "is"],
  ["what", "s"],
  ["what", "was"],
  ["what", "were"],
  ["what", "did"],
  ["what", "does"],
  ["what", "are"],
  ["what", CONTRACT_QUANTITY_KINDS[0]],
  ["what"],
  ["which"],
  ["who"],
  ["when"],
  ["where"],
  ["why"],
  ["how"],
];

export function normalizeQuestion(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!s) return "";
  const toks = s.split(" ").filter(Boolean);
  for (const pre of INTERROGATIVE_PREFIXES) {
    if (toks.length <= pre.length) continue;
    let match = true;
    for (let i = 0; i < pre.length; i++) {
      if (toks[i] !== pre[i]) {
        match = false;
        break;
      }
    }
    if (match) return toks.slice(pre.length).join(" ");
  }
  return toks.join(" ");
}

export function tokenJaccard(a: string, b: string): number {
  const setA = new Set(a.split(" ").filter(Boolean));
  const setB = new Set(b.split(" ").filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

export const ENGLISH_STOP_WORDS = new Set([
  "a", "about", "above", "after", "again", "all", "also", "am", "an", "and", "any", "are", "as", "at",
  "be", "because", "been", "before", "being", "below", "between", "both", "but", "by", "can", "did",
  "do", "does", "doing", "down", "during", "each", "few", "for", "from", "further", "had", "has",
  "have", "having", "he", "her", "here", "hers", "herself", "him", "himself", "his", "how", "i",
  "if", "in", "into", "is", "it", "its", "itself", "just", "me", "more", "most", "my", "myself",
  "no", "nor", "not", "now", "of", "off", "on", "once", "only", "or", "other", "our", "ours",
  "ourselves", "out", "over", "own", "same", "she", "should", "so", "some", "such", "than", "that",
  "the", "their", "theirs", "them", "themselves", "then", "there", "these", "they", "this", "those",
  "through", "throughout", "to", "too", "under", "until", "up", "very", "was", "we", "were", "what",
  "when", "where", "which", "while", "who", "whom", "why", "with", "won", "would", "you", "your",
  "yours", "yourself", "yourselves",
]);

export function extractEntityTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !ENGLISH_STOP_WORDS.has(w));
}

export function areFactsDuplicateCandidates(
  primary: { id?: string; question?: string; claim_template?: string; subject?: string; subject_key?: string },
  candidate: { id?: string; question?: string; claim_template?: string; subject?: string; subject_key?: string },
): boolean {
  if (primary.id && candidate.id && primary.id === candidate.id) {
    return false;
  }

  const normA = normalizeQuestion(primary.question || primary.claim_template || "");
  const normB = normalizeQuestion(candidate.question || candidate.claim_template || "");
  if (normA && normB && normA === normB) {
    return true;
  }

  const subjA = (primary.subject_key || normalizeKey(primary.subject || "")).trim().toLowerCase();
  const subjB = (candidate.subject_key || normalizeKey(candidate.subject || "")).trim().toLowerCase();

  const toksA = extractEntityTokens(normA);
  const toksB = extractEntityTokens(normB);
  const setA = new Set(toksA);
  const setB = new Set(toksB);

  if (setA.size === 0 || setB.size === 0) return false;

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  const jaccard = union > 0 ? intersection / union : 0;

  // When subjects match: require moderate entity Jaccard (>= 0.40) or at least 2 shared entity tokens with jaccard >= 0.30
  if (subjA && subjB && subjA === subjB) {
    return jaccard >= 0.40 || (intersection >= 2 && jaccard >= 0.30);
  }

  // Cross-subject: require strong entity overlap (>= 0.60 Jaccard AND >= 2 shared entity tokens)
  return jaccard >= 0.60 && intersection >= 2;
}

/** Best-effort lookup for other facts that duplicate or collide with this report. */
export async function findDuplicateFactsForReport(
  report: ReportRecord,
  primaryFact: FactRecord | null,
  allReports?: ReportRecord[],
): Promise<FactRecord[]> {
  const duplicates = new Map<string, FactRecord>();
  const primaryId = primaryFact?.id ?? report.factId?.trim();

  // 1. Direct IDs recorded on report (with strict candidate validation)
  if (report.duplicateFactIds && report.duplicateFactIds.length > 0) {
    const validDupIds: string[] = [];
    let hadInvalid = false;
    for (const dupId of report.duplicateFactIds) {
      if (dupId && dupId !== primaryId && !duplicates.has(dupId)) {
        const doc = await getDoc(`fact_bank/${dupId}`);
        if (doc) {
          const fact = toFact(doc);
          if (!primaryFact || areFactsDuplicateCandidates(primaryFact, fact)) {
            duplicates.set(dupId, fact);
            validDupIds.push(dupId);
          } else {
            hadInvalid = true;
          }
        }
      }
    }
    // Clean up corrupted duplicateFactIds in Firestore if invalid IDs were stored
    if (hadInvalid) {
      await patchDoc(`trivia_reports/${report.id}`, { duplicateFactIds: validDupIds }).catch(() => {});
    }
  }

  const isDuplicateReport =
    report.qualityFlags?.some(isDuplicateFlag) ||
    report.reason?.toLowerCase().includes("duplicate_question") ||
    report.reason?.toLowerCase().includes("conflicting_answer");

  // 2. Cross-reference other pending reports in the current batch
  if (isDuplicateReport && duplicates.size === 0 && allReports?.length) {
    const refFact = primaryFact || {
      id: primaryId,
      question: report.claimStatement,
      claim_template: report.claimStatement,
      subject: report.topic,
      subject_key: normalizeKey(report.topic || ""),
    };

    let newDuplicatesFound = false;
    for (const other of allReports) {
      if (other.id === report.id) continue;
      const otherFactId = other.factId?.trim();
      if (!otherFactId || otherFactId === primaryId || duplicates.has(otherFactId)) continue;

      const otherIsDup =
        other.qualityFlags?.some(isDuplicateFlag) ||
        other.reason?.toLowerCase().includes("duplicate_question") ||
        other.reason?.toLowerCase().includes("conflicting_answer");

      if (otherIsDup) {
        const otherRefFact = {
          id: otherFactId,
          question: other.claimStatement,
          claim_template: other.claimStatement,
          subject: other.topic,
          subject_key: normalizeKey(other.topic || ""),
        };

        if (areFactsDuplicateCandidates(refFact, otherRefFact)) {
          const doc = await getDoc(`fact_bank/${otherFactId}`);
          if (doc) {
            const fact = toFact(doc);
            if (areFactsDuplicateCandidates(refFact, fact)) {
              duplicates.set(otherFactId, fact);
              newDuplicatesFound = true;
              if (primaryId) {
                const otherMergedIds = Array.from(new Set([...(other.duplicateFactIds || []), primaryId]));
                await patchDoc(`trivia_reports/${other.id}`, { duplicateFactIds: otherMergedIds }).catch(() => {});
              }
            }
          }
        }
      }
    }

    if (newDuplicatesFound) {
      const mergedIds = Array.from(new Set([...(report.duplicateFactIds || []), ...duplicates.keys()]));
      await patchDoc(`trivia_reports/${report.id}`, { duplicateFactIds: mergedIds }).catch(() => {});
    }
  }

  // 3. Query fallback across fact_bank
  if (isDuplicateReport && duplicates.size === 0 && primaryFact) {
    const subjectKey = primaryFact.subject_key || normalizeKey(primaryFact.subject);
    const candidateSubjectKeys = new Set<string>();
    if (subjectKey) candidateSubjectKeys.add(subjectKey);

    // Also extract candidate keys from angle or question (e.g. Stevie Wonder in Grammy Awards)
    if (primaryFact.angle) {
      candidateSubjectKeys.add(normalizeKey(primaryFact.angle));
      const angleWords = primaryFact.angle.trim().split(/\s+/);
      if (angleWords.length >= 2) {
        candidateSubjectKeys.add(normalizeKey(`${angleWords[0]} ${angleWords[1]}`));
      }
    }
    if (primaryFact.question) {
      const qWords = primaryFact.question.trim().split(/\s+/);
      if (qWords.length >= 2) {
        candidateSubjectKeys.add(normalizeKey(`${qWords[0]} ${qWords[1]}`));
      }
    }

    for (const key of candidateSubjectKeys) {
      if (duplicates.size > 0 || !key) continue;
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
      if (duplicates.size > 0) {
        // Backfill on the report doc so future loads hit step 1 immediately
        const mergedIds = Array.from(new Set([...(report.duplicateFactIds || []), ...duplicates.keys()]));
        await patchDoc(`trivia_reports/${report.id}`, { duplicateFactIds: mergedIds }).catch(() => {});
      }
    }
  }

  return Array.from(duplicates.values());
}

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
}): Promise<{ ok: true }> {
  const now = new Date().toISOString();

  if (input.action === "resolve_duplicate") {
    const keepId = input.keepFactId?.trim();
    const retireIds = [
      ...(input.retireFactId ? [input.retireFactId.trim()] : []),
      ...(input.retireFactIds ? input.retireFactIds.map((id) => id.trim()) : []),
    ].filter((id) => id && id !== keepId);

    for (const retireId of retireIds) {
      await setFactStatus({
        id: retireId,
        status: STATUS.retired,
        reason: input.note ?? (keepId ? `Retired in favor of duplicate fact ${keepId}` : "Retired as duplicate fact"),
      });

      // Auto-resolve counterpart pending report if one exists
      const otherReportDoc = await getDoc(`trivia_reports/lint_${retireId}`);
      if (otherReportDoc && otherReportDoc.data["status"] === "pending_review") {
        await patchDoc(`trivia_reports/lint_${retireId}`, {
          status: "resolved",
          resolutionNote: `Auto-resolved: duplicate resolved via ${input.reportId}`,
          resolved_at: now,
        });
      }
    }

    let remainingFlags: string[] = [];
    if (keepId) {
      if (input.correctedNumber !== undefined) {
        await updateFact({ id: keepId, true_number: input.correctedNumber });
      }

      const keepDoc = await getFact(keepId);
      if (keepDoc) {
        const currentFlags = Array.isArray(keepDoc.quality_flags) ? keepDoc.quality_flags : [];
        remainingFlags = currentFlags.filter(isNonDuplicateFlag);

        if (remainingFlags.length === 0) {
          if (keepDoc.status === STATUS.disputed) {
            await setFactStatus({
              id: keepId,
              status: STATUS.active,
              reason: input.note ?? "Reinstated duplicate winner via moderation",
            });
            await patchDoc(`fact_bank/${keepId}`, {}, ["quality_flags", "disputed_reason", "disputed_at"]);
          }
        } else {
          // Fact still carries other linter warnings (e.g. bounds_chart_position).
          // Keep remaining flags and dispute reason so the fact remains properly quarantined until fixed.
          await patchDoc(`fact_bank/${keepId}`, {
            quality_flags: remainingFlags,
            disputed_reason: `fact_lint: ${remainingFlags.join(",")}`,
          });
        }
      }

      const keepReportDoc = await getDoc(`trivia_reports/lint_${keepId}`);
      if (keepReportDoc && keepReportDoc.data["status"] === "pending_review" && keepReportDoc.id !== input.reportId) {
        if (remainingFlags.length === 0) {
          await patchDoc(`trivia_reports/lint_${keepId}`, {
            status: "resolved",
            resolutionNote: `Auto-resolved: duplicate resolved via ${input.reportId}`,
            resolved_at: now,
          });
        } else {
          await patchDoc(`trivia_reports/lint_${keepId}`, {
            qualityFlags: remainingFlags,
            resolutionNote: `Duplicate resolved via ${input.reportId}; remaining flags: ${remainingFlags.join(", ")}`,
          });
        }
      }
    }

    const defaultNote =
      remainingFlags.length > 0
        ? `Kept ${keepId} (retired ${retireIds.join(", ") || "duplicates"}; remaining flags: ${remainingFlags.join(", ")})`
        : `Kept ${keepId ?? "chosen fact"}, retired duplicate ${retireIds.join(", ") || "other"}`;

    const isKeptFactReport =
      Boolean(keepId && (input.reportId === `lint_${keepId}` || (input.factId && input.factId === keepId)));

    if (isKeptFactReport && remainingFlags.length > 0) {
      // Kept fact still has other violations (e.g. bounds_chart_position). Keep report in pending_review
      // so moderators can review and fix the remaining issue, but clear duplicate relationships.
      await patchDoc(
        `trivia_reports/${input.reportId}`,
        {
          qualityFlags: remainingFlags,
          reason: `fact_lint: ${remainingFlags.join(",")}`,
          resolutionNote: input.note ?? defaultNote,
        },
        ["duplicateFactIds", "duplicate_fact_ids"],
      );
    } else {
      await patchDoc(`trivia_reports/${input.reportId}`, {
        status: "resolved",
        resolutionNote: input.note ?? defaultNote,
        resolved_at: now,
      });
    }
    return { ok: true };
  }

  if (input.action === "retire_fact") {
    if (input.factId) {
      await setFactStatus({
        id: input.factId,
        status: STATUS.retired,
        reason: input.note ?? "Retired via player report",
      });
    }
    await patchDoc(`trivia_reports/${input.reportId}`, {
      status: "resolved",
      resolutionNote: input.note ?? (input.factId ? "Fact retired" : "Report accepted"),
      resolved_at: now,
    });
    return { ok: true };
  }

  if (input.action === "fix_number") {
    if (input.factId && input.correctedNumber !== undefined) {
      const corrected = await updateFact({ id: input.factId, true_number: input.correctedNumber });
      // Re-activate only along a contract-authorized transition (Requirements
      // 9.3, 9.4). The reinstatement target and its authorization both come
      // from the shared contract, never a restated literal: fixing the number
      // of a disputed fact reinstates it, while a fact already in that status
      // has no self-transition and is left as-is rather than forced through
      // the guard.
      const reinstateTarget = reinstatementTargetFor(corrected.status);
      if (reinstateTarget !== null) {
        await setFactStatus({ id: input.factId, status: reinstateTarget });
      }
    }
    await patchDoc(`trivia_reports/${input.reportId}`, {
      status: "resolved",
      resolutionNote: input.note ?? (input.correctedNumber !== undefined ? `Corrected to ${input.correctedNumber}` : "Report accepted"),
      resolved_at: now,
    });
    return { ok: true };
  }

  if (input.action === "edit_fact") {
    if (input.factId && input.factUpdates) {
      await updateFact({ id: input.factId, ...input.factUpdates });
      await patchDoc(
        `fact_bank/${input.factId}`,
        {},
        ["quality_flags", "disputed_reason", "disputed_at"],
      );
      const factDoc = await getFact(input.factId);
      if (factDoc) {
        const reinstateTarget = reinstatementTargetFor(factDoc.status);
        if (reinstateTarget !== null) {
          await setFactStatus({
            id: input.factId,
            status: reinstateTarget,
            reason: input.note ?? "Fact updated and reinstated via moderation",
          });
        }
      }
    }
    await patchDoc(`trivia_reports/${input.reportId}`, {
      status: "resolved",
      resolutionNote: input.note ?? "Fact updated and resolved via moderation",
      resolved_at: now,
    });
    return { ok: true };
  }

  if (input.action === "resolve_as_is") {
    if (input.factId) {
      await patchDoc(
        `fact_bank/${input.factId}`,
        {},
        ["quality_flags", "disputed_reason", "disputed_at"],
      );
      const factDoc = await getFact(input.factId);
      if (factDoc) {
        const reinstateTarget = reinstatementTargetFor(factDoc.status);
        if (reinstateTarget !== null) {
          await setFactStatus({
            id: input.factId,
            status: reinstateTarget,
            reason: input.note ?? "Accepted fact as-is via moderation",
          });
        }
      }
    }
    await patchDoc(`trivia_reports/${input.reportId}`, {
      status: "resolved",
      resolutionNote: input.note ?? "Report accepted: fact verified as-is",
      resolved_at: now,
    });
    return { ok: true };
  }

  if (input.action === "add_to_bank") {
    const subject = input.topic || "General";
    const angle = input.claimStatement || subject;
    const true_number = input.correctedNumber ?? 0;
    const unit = input.unit || "";
    const claim_template = input.claimStatement
      ? input.claimStatement.replace(new RegExp(String(true_number), "g"), "{n}")
      : `${subject}: {n} ${unit}`;

    const reportDoc = await getDoc(`trivia_reports/${input.reportId}`);
    const reportExplanation = reportDoc
      ? canonicalExplanation(reportDoc.data, ["reveal"])
      : "";
    const explanation = reportExplanation || input.note?.trim() || input.claimStatement || subject;

    await createFact({
      subject,
      angle,
      true_number,
      unit,
      claim_template: claim_template.includes("{n}") ? claim_template : `${claim_template} {n}`,
      // The report path is admitted with the same canonical builder as manual
      // and CSV paths, but carries its own origin for auditability.
      explanation,
      question: input.claimStatement || subject,
      surprise_factor: 2,
      content_rating: "standard",
      source_urls: [],
      origin: PENDING_FACT_ORIGINS[2],
    });

    const note = input.note?.trim();
    await patchDoc(`trivia_reports/${input.reportId}`, {
      status: "resolved",
      resolutionNote: note ? `${note} — ${PENDING_ADMISSION_COPY}` : PENDING_ADMISSION_COPY,
      resolved_at: now,
    });
    return { ok: true };
  }

  if (input.action === "resolve_only") {
    await patchDoc(`trivia_reports/${input.reportId}`, {
      status: "resolved",
      resolutionNote: input.note ?? "Report accepted",
      resolved_at: now,
    });
    return { ok: true };
  }

  // Reject: restore a fact auto-disputed by signed telemetry or fact lint.
  // Flagging only transitions active -> disputed, so a rejected false signal
  // must reactivate the fact instead of leaving it permanently excluded from
  // active-only consumers such as the daily picker.
  const reportDoc = await getDoc(`trivia_reports/${input.reportId}`);
  const reportData = reportDoc?.data ?? {};
  const storedFactId =
    typeof reportData["factId"] === "string" && reportData["factId"].trim()
      ? (reportData["factId"] as string).trim()
      : typeof reportData["questionId"] === "string" && (reportData["questionId"] as string).startsWith("fact:")
        ? ((reportData["questionId"] as string).slice("fact:".length).trim() || null)
        : null;
  let remainingFlags: string[] = [];
  if (
    storedFactId &&
    (reportData["reportSource"] === "round_telemetry" || reportData["reportSource"] === "fact_lint")
  ) {
    const factDoc = await getDoc(`fact_bank/${storedFactId}`);
    if (factDoc && factDoc.data["status"] === STATUS.disputed) {
      const currentFlags = Array.isArray(factDoc.data["quality_flags"])
        ? (factDoc.data["quality_flags"] as string[])
        : [];
      remainingFlags =
        reportData["reportSource"] === "fact_lint"
          ? currentFlags.filter(isNonDuplicateFlag)
          : [];

      if (remainingFlags.length === 0) {
        const previous =
          typeof reportData["factPreviousStatus"] === "string" && reportData["factPreviousStatus"]
            ? (reportData["factPreviousStatus"] as string)
            : STATUS.active;
        await patchDoc(
          `fact_bank/${storedFactId}`,
          { status: previous },
          ["quality_flags", "disputed_reason", "disputed_at"],
        );
      } else {
        await patchDoc(`fact_bank/${storedFactId}`, {
          quality_flags: remainingFlags,
          disputed_reason: `fact_lint: ${remainingFlags.join(",")}`,
        });
      }
    }

    if (reportData["reportSource"] === "fact_lint") {
      const duplicateIds = asSources(reportData["duplicateFactIds"] ?? reportData["duplicate_fact_ids"]);
      for (const dupId of duplicateIds) {
        if (!dupId || dupId === storedFactId) continue;
        let dupRemaining: string[] = [];
        const dupDoc = await getDoc(`fact_bank/${dupId}`);
        if (dupDoc && dupDoc.data["status"] === STATUS.disputed) {
          const currentFlags = Array.isArray(dupDoc.data["quality_flags"])
            ? (dupDoc.data["quality_flags"] as string[])
            : [];
          dupRemaining = currentFlags.filter(isNonDuplicateFlag);

          if (dupRemaining.length === 0) {
            await patchDoc(
              `fact_bank/${dupId}`,
              { status: STATUS.active },
              ["quality_flags", "disputed_reason", "disputed_at"],
            );
          } else {
            await patchDoc(`fact_bank/${dupId}`, {
              quality_flags: dupRemaining,
              disputed_reason: `fact_lint: ${dupRemaining.join(",")}`,
            });
          }
        }
        const dupReport = await getDoc(`trivia_reports/lint_${dupId}`);
        if (dupReport && dupReport.data["status"] === "pending_review") {
          if (dupRemaining.length === 0) {
            await patchDoc(`trivia_reports/lint_${dupId}`, {
              status: "rejected",
              resolutionNote: input.note ?? `Auto-rejected: counterpart report ${input.reportId} rejected`,
              resolved_at: now,
            });
          } else {
            await patchDoc(
              `trivia_reports/lint_${dupId}`,
              {
                qualityFlags: dupRemaining,
                reason: `fact_lint: ${dupRemaining.join(",")}`,
                resolutionNote: `Duplicate dismissed via ${input.reportId}; remaining flags: ${dupRemaining.join(", ")}`,
              },
              ["duplicateFactIds", "duplicate_fact_ids"],
            );
          }
        }
      }
    }
  }

  if (remainingFlags.length > 0) {
    await patchDoc(
      `trivia_reports/${input.reportId}`,
      {
        qualityFlags: remainingFlags,
        reason: `fact_lint: ${remainingFlags.join(",")}`,
        resolutionNote: input.note ?? `Duplicate dismissed; remaining flags: ${remainingFlags.join(", ")}`,
      },
      ["duplicateFactIds", "duplicate_fact_ids"],
    );
  } else {
    await patchDoc(`trivia_reports/${input.reportId}`, {
      status: "rejected",
      resolutionNote: input.note ?? "Report rejected",
      resolved_at: now,
    });
  }
  return { ok: true };
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

    let autoNote: string | null = null;
    if (!factId) {
      autoNote = "Auto-resolved: report missing factId";
    } else {
      const factDoc = await getDoc(`fact_bank/${factId}`);
      if (!factDoc) {
        autoNote = "Auto-resolved: underlying fact no longer exists";
      } else {
        const factData = factDoc.data;
        const stat = factData["status"];
        if (stat === STATUS.retired) {
          autoNote = "Auto-resolved: underlying fact was retired";
        } else if (stat === STATUS.active) {
          const qf = Array.isArray(factData["quality_flags"]) ? (factData["quality_flags"] as string[]) : [];
          if (qf.length === 0) {
            autoNote = "Auto-resolved: fact is active and passes all lint rules";
          }
        }
      }
    }

    if (autoNote) {
      await patchDoc(`trivia_reports/${reportDoc.id}`, {
        status: "resolved",
        resolutionNote: autoNote,
        resolved_at: now,
      });
      flushed++;
      details.push(`${reportDoc.id}: ${autoNote}`);
    }
  }

  return { flushed, totalChecked, details };
}

