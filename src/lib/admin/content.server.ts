/**
 * Fact bank + moderation logic. Server-only: every export assumes the caller
 * has already been authorized with `requireAdmin()`.
 */
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

export const FACT_STATUSES = ["active", "disputed", "retired"] as const;
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
  status: string;
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
    status: str(d["status"]) || "active",
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
        status: "active",
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

export async function setFactStatus(input: {
  id: string;
  status: (typeof FACT_STATUSES)[number];
  reason?: string;
  verifierModel?: string;
}): Promise<FactRecord> {
  const patch: Record<string, unknown> = {
    status: input.status,
    updated_at: new Date().toISOString(),
  };
  if (input.status === "retired") {
    patch["retired_reason"] = input.reason ?? "Retired from admin portal";
  }
  if (input.status === "active") {
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
    status: "active",
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

export async function resolveReport(input: {
  reportId: string;
  action: "retire_fact" | "fix_number" | "reject" | "resolve_only" | "add_to_bank";
  factId?: string;
  correctedNumber?: number;
  note?: string;
  topic?: string;
  claimStatement?: string;
  unit?: string;
}): Promise<{ ok: true }> {
  const now = new Date().toISOString();

  if (input.action === "retire_fact") {
    if (input.factId) {
      await setFactStatus({
        id: input.factId,
        status: "retired",
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
      await updateFact({ id: input.factId, true_number: input.correctedNumber });
      await setFactStatus({ id: input.factId, status: "active" });
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

  // Reject: restore a fact auto-disputed by signed telemetry. Flagging only
  // transitions active -> disputed, so a rejected false signal must reactivate
  // the fact instead of leaving it permanently excluded from active-only
  // consumers such as the daily picker.
  const reportDoc = await getDoc(`trivia_reports/${input.reportId}`);
  const reportData = reportDoc?.data ?? {};
  const storedFactId =
    typeof reportData["factId"] === "string" && reportData["factId"].trim()
      ? (reportData["factId"] as string).trim()
      : typeof reportData["questionId"] === "string" && (reportData["questionId"] as string).startsWith("fact:")
        ? ((reportData["questionId"] as string).slice("fact:".length).trim() || null)
        : null;
  if (storedFactId && reportData["reportSource"] === "round_telemetry") {
    const factDoc = await getDoc(`fact_bank/${storedFactId}`);
    if (factDoc && factDoc.data["status"] === "disputed") {
      const previous =
        typeof reportData["factPreviousStatus"] === "string" && reportData["factPreviousStatus"]
          ? (reportData["factPreviousStatus"] as string)
          : "active";
      await patchDoc(`fact_bank/${storedFactId}`, { status: previous });
    }
  }

  await patchDoc(`trivia_reports/${input.reportId}`, {
    status: "rejected",
    resolutionNote: input.note ?? "Report rejected",
    resolved_at: now,
  });
  return { ok: true };
}
