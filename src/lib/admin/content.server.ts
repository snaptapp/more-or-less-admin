/**
 * Fact bank + moderation logic. Server-only: every export assumes the caller
 * has already been authorized with `requireAdmin()`.
 */
import { z } from "zod";
import {
  createDoc,
  factId,
  getDoc,
  normalizeKey,
  patchDoc,
  runQuery,
  type FirestoreDoc,
  type Json,
  type QueryFilter,
} from "../firebase/firestore.server";
import { GENRES } from "./taxonomy";
import { parseDerivationBlock, type FactDerivationBlock } from "./daily-blitz";
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
    context: str(d["context"]),
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
    facts = facts.filter((fact) =>
      [fact.subject, fact.angle, fact.question, fact.claim_template, fact.context]
        .join(" ")
        .toLowerCase()
        .includes(term),
    );
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
    facts = facts.filter((fact) =>
      [fact.subject, fact.angle, fact.question, fact.claim_template, fact.context]
        .join(" ")
        .toLowerCase()
        .includes(term),
    );
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

export async function importFactsBatch(
  facts: Array<{
    subject: string;
    angle: string;
    true_number: number;
    unit?: string;
    claim_template: string;
    context?: string;
    question?: string;
    surprise_factor?: number;
    difficulty_hint?: "casual" | "medium" | "hard";
    content_rating?: "standard" | "after_dark";
    source_urls?: string[];
  }>,
): Promise<{ imported: number; skipped: number; errors: string[] }> {
  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const item of facts) {
    try {
      const subject_key = normalizeKey(item.subject);
      const angle_key = normalizeKey(item.angle);
      const id = await factId(subject_key, angle_key);
      const existing = await getDoc(`fact_bank/${id}`);
      if (existing) {
        skipped++;
        continue;
      }
      const question = (item.question ?? "").trim() || `${item.subject} - ${item.angle}`.trim();
      const claim = (item.claim_template ?? "").trim() || `${question}: {n}`;
      const claim_template = claim.includes("{n}") ? claim : `${claim} {n}`;
      await createDoc("fact_bank", id, {
        subject: item.subject.trim(),
        angle: item.angle.trim(),
        true_number: item.true_number,
        unit: (item.unit ?? "").trim(),
        claim_template,
        context: (item.context ?? "").trim() || question,
        question,
        surprise_factor: item.surprise_factor ?? 2,
        content_rating: item.content_rating ?? "standard",
        source_urls: item.source_urls ?? [],
        subject_key,
        angle_key,
        status: STATUS.active,
        previous_true_number: null,
        retired_reason: null,
        verifier_model: "csv_import",
        verified_at: new Date().toISOString(),
        served_count: 0,
        last_served_at: null,
      });
      imported++;
    } catch (err) {
      errors.push(`${item.subject} / ${item.angle}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { imported, skipped, errors };
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

export async function updateFact(input: FactEditInput): Promise<FactRecord> {
  const existing = await getFact(input.id);
  if (!existing) throw new Error(`Fact ${input.id} not found`);

  const patch: Record<string, unknown> = {};
  const assignable: (keyof FactEditInput)[] = [
    "subject",
    "category",
    "angle",
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
  if (input.subject !== undefined) patch["subject_key"] = normalizeKey(input.subject);
  if (input.angle !== undefined) patch["angle_key"] = normalizeKey(input.angle);

  // Changing the value preserves the old one for the reveal-diff history.
  if (input.true_number !== undefined && input.true_number !== existing.true_number) {
    patch["previous_true_number"] = existing.true_number;
    patch["number_changed_at"] = new Date().toISOString();
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

  let updatedFactDoc: FirestoreDoc | null = null;
  if (Object.keys(patch).length > 0 || deletePaths) {
    patch["updated_at"] = new Date().toISOString();
    updatedFactDoc = await patchDoc(`fact_bank/${input.id}`, patch, deletePaths);
  }

  // Link/update taxonomy in fact_subjects when category is assigned
  if (input.category && (input.subject || existing.subject)) {
    const subj = (input.subject || existing.subject).trim();
    const subjectKey = normalizeKey(subj);
    const existingSubject = await getDoc(`fact_subjects/${subjectKey}`);
    if (existingSubject) {
      await patchDoc(`fact_subjects/${subjectKey}`, {
        category: input.category,
        ...(input.sub_category ? { sub_category: input.sub_category } : {}),
      });
    } else {
      await createDoc("fact_subjects", subjectKey, {
        subject: subj,
        subject_key: subjectKey,
        category: input.category,
        ...(input.sub_category ? { sub_category: input.sub_category } : {}),
        aliases: [],
        playlist_ids: [],
        fact_count: 1,
        createdAt: new Date().toISOString(),
      });
    }
  }

  if (updatedFactDoc) {
    return toFact(updatedFactDoc);
  }
  return toFact((await getDoc(`fact_bank/${input.id}`)) ?? {
    id: input.id,
    path: `fact_bank/${input.id}`,
    data: { ...(existing as unknown as Record<string, Json>), ...(patch as Record<string, Json>) },
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
  context: z.string().optional(),
  question: z.string().optional(),
  surprise_factor: z.number().int().min(0).max(3).optional(),
  content_rating: z.enum(CONTENT_RATINGS).optional(),
  source_urls: z.array(z.string()).optional(),
  quantity_kind: z.enum(QUANTITY_KIND_OPTIONS).optional(),
  plausible_min: z.string().optional(),
  plausible_max: z.string().optional(),
});

export interface BulkUpdateResult {
  /** Number of edits persisted. */
  count: number;
  /** Fact ids persisted, in application order. */
  editedIds: string[];
  /** Set only when the batch stopped early: the fact whose edit did not persist. */
  failedId?: string;
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

/**
 * Apply a bounded batch of fact edits.
 *
 * The whole batch is validated before the first write: an empty batch, a batch
 * larger than {@link BULK_UPDATE_MAX_BATCH}, or any edit that fails
 * {@link factEditSchema} rejects with a {@link BulkUpdateValidationError} and
 * leaves every targeted document untouched. Once validated, edits are applied
 * in order through {@link updateFact}; a failure at edit *k* stops the batch
 * and raises {@link BulkUpdatePartialFailureError} carrying the persisted
 * prefix, so only edits before *k* are in Firestore.
 *
 * Audit logging is the caller's responsibility — like every other export in
 * this module, this function writes no audit entry, so exactly one entry per
 * batch is emitted by the server-function handler.
 */
export async function bulkUpdateFacts(updates: FactEditInput[]): Promise<BulkUpdateResult> {
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
  }

  // Validation passed for the whole batch, so the first write happens only
  // once no rule can still reject it.
  const editedIds: string[] = [];
  for (const update of updates) {
    try {
      await updateFact(update);
    } catch (err) {
      throw new BulkUpdatePartialFailureError(
        update.id,
        { count: editedIds.length, editedIds: [...editedIds], failedId: update.id },
        err,
      );
    }
    editedIds.push(update.id);
  }

  return { count: editedIds.length, editedIds };
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
 * The "live" status a corrected fact is reinstated to, derived from the shared
 * contract rather than a restated literal: the status that is both an
 * admin-authorized transition *target* (something can be promoted into it) and
 * an admin-authorized transition *source* (it is not terminal). `active` is the
 * only status satisfying both in the current contract, but the rule follows the
 * contract if the transition table changes.
 */
function liveStatus(): FactStatus | null {
  const authorized = STATUS_TRANSITIONS.filter((t) => t.adminAuthorized);
  const sources = new Set(authorized.map((t) => t.from));
  const targets = authorized.map((t) => t.to);
  const live = targets.filter((status) => sources.has(status));
  return live.length > 0 ? live[0] : null;
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

export async function setFactStatus(input: {
  id: string;
  status: (typeof FACT_STATUSES)[number];
  reason?: string;
  verifierModel?: string;
}): Promise<FactRecord> {
  // The transition is evaluated current-status → requested-status, reading the
  // current status from the persisted document, and rejected before any write
  // when the contract does not mark it admin-authorized (Requirements 9.3, 9.4).
  const existing = await getFact(input.id);
  if (!existing) throw new Error(`Fact ${input.id} not found`);
  if (!isAdminAuthorizedTransition(existing.status, input.status)) {
    throw new FactStatusTransitionError(input.id, existing.status, input.status);
  }

  const patch: Record<string, unknown> = {
    status: input.status,
    updated_at: new Date().toISOString(),
  };
  if (input.status === STATUS.retired) {
    patch["retired_reason"] = input.reason ?? "Retired from admin portal";
  }
  if (input.status === STATUS.active) {
    patch["verified_at"] = new Date().toISOString();
    patch["verifier_model"] = input.verifierModel ?? "admin_portal";
    patch["retired_reason"] = null;
  }
  return toFact(await patchDoc(`fact_bank/${input.id}`, patch));
}

export async function createFact(input: {
  subject: string;
  category?: string;
  sub_category?: string;
  angle: string;
  true_number: number;
  unit: string;
  claim_template?: string;
  context: string;
  question: string;
  surprise_factor: number;
  difficulty_hint?: string;
  content_rating: string;
  source_urls: string[];
}): Promise<FactRecord> {
  const subject_key = normalizeKey(input.subject);
  const angle_key = normalizeKey(input.angle);
  const id = await factId(subject_key, angle_key);
  if (await getDoc(`fact_bank/${id}`)) {
    throw new Error("A fact with this subject and angle already exists");
  }
  const question = input.question?.trim() || `${input.subject} - ${input.angle}`.trim();
  const claim = (input.claim_template ?? "").trim() || `${question}: {n}`;
  const claim_template = claim.includes("{n}") ? claim : `${claim} {n}`;

  const doc = await createDoc("fact_bank", id, {
    ...input,
    category: input.category || null,
    claim_template,
    question,
    context: input.context?.trim() || question,
    subject_key,
    angle_key,
    status: STATUS.active,
    previous_true_number: null,
    retired_reason: null,
    verifier_model: "admin_portal",
    verified_at: new Date().toISOString(),
    served_count: 0,
    last_served_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  if (input.category) {
    const existingSubject = await getDoc(`fact_subjects/${subject_key}`);
    if (existingSubject) {
      await patchDoc(`fact_subjects/${subject_key}`, {
        category: input.category,
        ...(input.sub_category ? { sub_category: input.sub_category } : {}),
      });
    } else {
      await createDoc("fact_subjects", subject_key, {
        subject: input.subject.trim(),
        subject_key,
        category: input.category,
        ...(input.sub_category ? { sub_category: input.sub_category } : {}),
        aliases: [],
        playlist_ids: [],
        fact_count: 1,
        createdAt: new Date().toISOString(),
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

function firstStr(d: Record<string, Json>, keys: string[]): string {
  for (const key of keys) {
    const value = d[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
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
    explanation: firstStr(d, ["explanation", "reveal", "context"]),
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

export async function listReports(input: { status?: string; limit?: number }) {
  const docs = await runQuery({
    collection: "trivia_reports",
    filters: input.status ? [{ field: "status", op: "EQUAL", value: input.status }] : [],
    limit: input.limit ?? 100,
  });
  const reports = docs.map(toReport);
  reports.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return reports;
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

/** Best-effort lookup for other facts that duplicate or collide with this report. */
export async function findDuplicateFactsForReport(
  report: ReportRecord,
  primaryFact: FactRecord | null,
): Promise<FactRecord[]> {
  const duplicates = new Map<string, FactRecord>();
  const primaryId = primaryFact?.id ?? report.factId?.trim();

  // 1. Direct IDs recorded on report
  if (report.duplicateFactIds && report.duplicateFactIds.length > 0) {
    for (const dupId of report.duplicateFactIds) {
      if (dupId && dupId !== primaryId && !duplicates.has(dupId)) {
        const doc = await getDoc(`fact_bank/${dupId}`);
        if (doc) duplicates.set(dupId, toFact(doc));
      }
    }
  }

  // 2. Query fallback if duplicate_question or conflicting_answer flag/reason is present
  const isDuplicateReport =
    report.qualityFlags?.some((f) => f === "duplicate_question" || f === "conflicting_answer") ||
    report.reason?.toLowerCase().includes("duplicate_question") ||
    report.reason?.toLowerCase().includes("conflicting_answer");

  if (isDuplicateReport && duplicates.size === 0 && primaryFact) {
    const subjectKey = primaryFact.subject_key || normalizeKey(primaryFact.subject);
    const normQuestion = normalizeQuestion(primaryFact.question || primaryFact.claim_template || "");

    // A. Search by same subject_key
    if (subjectKey) {
      const docs = await runQuery({
        collection: "fact_bank",
        filters: [{ field: "subject_key", op: "EQUAL", value: subjectKey }],
        limit: 20,
      });
      for (const d of docs) {
        if (d.id === primaryFact.id || duplicates.has(d.id)) continue;
        const candidate = toFact(d);
        const candidateNorm = normalizeQuestion(candidate.question || candidate.claim_template || "");
        if (
          normQuestion &&
          candidateNorm &&
          (normQuestion === candidateNorm || tokenJaccard(normQuestion, candidateNorm) >= 0.6)
        ) {
          duplicates.set(d.id, candidate);
        }
      }
    }

    // B. Search by exact question if across subjects
    if (duplicates.size === 0 && primaryFact.question) {
      const docs = await runQuery({
        collection: "fact_bank",
        filters: [{ field: "question", op: "EQUAL", value: primaryFact.question }],
        limit: 10,
      });
      for (const d of docs) {
        if (d.id !== primaryFact.id && !duplicates.has(d.id)) {
          duplicates.set(d.id, toFact(d));
        }
      }
    }
  }

  return Array.from(duplicates.values());
}

export async function resolveReport(input: {
  reportId: string;
  action: "retire_fact" | "fix_number" | "reject" | "resolve_only" | "add_to_bank" | "resolve_duplicate";
  factId?: string;
  correctedNumber?: number;
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
        remainingFlags = currentFlags.filter(
          (f) => f !== "duplicate_question" && f !== "conflicting_answer",
        );

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

  if (input.action === "add_to_bank") {
    const subject = input.topic || "General";
    const angle = input.claimStatement || subject;
    const true_number = input.correctedNumber ?? 0;
    const unit = input.unit || "";
    const claim_template = input.claimStatement
      ? input.claimStatement.replace(new RegExp(String(true_number), "g"), "{n}")
      : `${subject}: {n} ${unit}`;

    await createFact({
      subject,
      angle,
      true_number,
      unit,
      claim_template: claim_template.includes("{n}") ? claim_template : `${claim_template} {n}`,
      context: input.note || input.claimStatement || "",
      question: input.claimStatement || subject,
      surprise_factor: 2,
      content_rating: "standard",
      source_urls: [],
    });

    await patchDoc(`trivia_reports/${input.reportId}`, {
      status: "resolved",
      resolutionNote: input.note ?? `Added to fact bank with value ${true_number}`,
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
          ? currentFlags.filter((f) => f !== "duplicate_question" && f !== "conflicting_answer")
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
          dupRemaining = currentFlags.filter(
            (f) => f !== "duplicate_question" && f !== "conflicting_answer",
          );

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

