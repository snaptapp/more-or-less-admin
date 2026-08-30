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

export const FACT_STATUSES = ["active", "disputed", "retired"] as const;
export const CONTENT_RATINGS = ["standard", "after_dark"] as const;
export const DIFFICULTY_HINTS = ["casual", "medium", "hard"] as const;
export const REPORT_STATUSES = ["pending_review", "resolved", "rejected"] as const;

export const CATEGORIES = [
  "Animals & Nature",
  "Science & Space",
  "Sports",
  "Music",
  "Movies & TV",
  "Pop Culture & Records",
  "History & World",
  "Food & Drink",
  "Technology",
  "Money & Business",
  "General",
] as const;

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
  difficulty_hint: string;
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
    surprise_factor: num(d["surprise_factor"]),
    difficulty_hint: str(d["difficulty_hint"]),
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
    updateTime: doc.updateTime,
  };
}

export interface FactListInput {
  search?: string;
  status?: string;
  contentRating?: string;
  difficulty?: string;
  minSurprise?: number;
  page?: number;
  pageSize?: number;
}

/**
 * Firestore has no substring index, so filters that map to indexed equality
 * run server-side and the free-text search is applied to that result window.
 */
export async function listFacts(input: FactListInput) {
  const pageSize = Math.min(input.pageSize ?? 25, 100);
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
    limit: 500,
  });

  let facts = window.map(toFact);
  if (input.minSurprise) {
    facts = facts.filter((fact) => (fact.surprise_factor ?? 0) >= input.minSurprise!);
  }
  const term = input.search?.trim().toLowerCase();
  if (term) {
    facts = facts.filter((fact) =>
      [fact.subject, fact.angle, fact.question, fact.claim_template]
        .join(" ")
        .toLowerCase()
        .includes(term),
    );
  }
  facts.sort((a, b) => a.subject.localeCompare(b.subject) || a.angle.localeCompare(b.angle));

  const total = facts.length;
  const start = (page - 1) * pageSize;
  return {
    facts: facts.slice(start, start + pageSize),
    total,
    page,
    pageSize,
    windowed: window.length >= 500,
  };
}

export async function getFact(id: string): Promise<FactRecord | null> {
  const doc = await getDoc(`fact_bank/${id}`);
  return doc ? toFact(doc) : null;
}

export interface FactEditInput {
  id: string;
  subject?: string;
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
}

export async function updateFact(input: FactEditInput): Promise<FactRecord> {
  const existing = await getFact(input.id);
  if (!existing) throw new Error(`Fact ${input.id} not found`);

  const patch: Record<string, unknown> = {};
  const assignable: (keyof FactEditInput)[] = [
    "subject",
    "angle",
    "unit",
    "claim_template",
    "context",
    "question",
    "surprise_factor",
    "difficulty_hint",
    "content_rating",
    "source_urls",
  ];
  for (const key of assignable) {
    if (input[key] !== undefined) patch[key] = input[key];
  }
  if (input.subject !== undefined) patch["subject_key"] = normalizeKey(input.subject);
  if (input.angle !== undefined) patch["angle_key"] = normalizeKey(input.angle);

  // Changing the value preserves the old one for the reveal-diff history.
  if (input.true_number !== undefined && input.true_number !== existing.true_number) {
    patch["previous_true_number"] = existing.true_number;
    patch["true_number"] = input.true_number;
  }

  if (Object.keys(patch).length === 0) return existing;
  patch["updated_at"] = new Date().toISOString();
  return toFact(await patchDoc(`fact_bank/${input.id}`, patch));
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
  angle: string;
  true_number: number;
  unit: string;
  claim_template: string;
  context: string;
  question: string;
  surprise_factor: number;
  difficulty_hint: string;
  content_rating: string;
  source_urls: string[];
}): Promise<FactRecord> {
  const subject_key = normalizeKey(input.subject);
  const angle_key = normalizeKey(input.angle);
  const id = await factId(subject_key, angle_key);
  if (await getDoc(`fact_bank/${id}`)) {
    throw new Error("A fact with this subject and angle already exists");
  }
  const doc = await createDoc("fact_bank", id, {
    ...input,
    subject_key,
    angle_key,
    status: "active",
    previous_true_number: null,
    retired_reason: null,
    verifier_model: "admin_portal",
    verified_at: new Date().toISOString(),
    served_count: 0,
    last_served_at: null,
  });
  return toFact(doc);
}

/* ---------------------------------- reports --------------------------------- */

export interface ReportRecord {
  id: string;
  topic: string;
  claimStatement: string;
  presentedNumber: number | null;
  trueNumber: number | null;
  unit: string;
  reason: string;
  feedbackText: string;
  reporterUid: string;
  status: string;
  createdAt: string | null;
  resolutionNote: string | null;
}

function toReport(doc: FirestoreDoc): ReportRecord {
  const d = doc.data;
  return {
    id: doc.id,
    topic: str(d["topic"]),
    claimStatement: str(d["claimStatement"]),
    presentedNumber: num(d["presentedNumber"]),
    trueNumber: num(d["trueNumber"]),
    unit: str(d["unit"]),
    reason: str(d["reason"]),
    feedbackText: str(d["feedbackText"]),
    reporterUid: str(d["reporterUid"]),
    status: str(d["status"]) || "pending_review",
    createdAt: typeof d["createdAt"] === "string" ? d["createdAt"] : null,
    resolutionNote: typeof d["resolutionNote"] === "string" ? d["resolutionNote"] : null,
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
  const topicKey = normalizeKey(report.topic);
  if (!topicKey) return null;
  const docs = await runQuery({
    collection: "fact_bank",
    filters: [{ field: "subject_key", op: "EQUAL", value: topicKey }],
    limit: 20,
  });
  const facts = docs.map(toFact);
  if (facts.length === 0) return null;
  const exact = facts.find((fact) => fact.true_number === report.trueNumber);
  return exact ?? facts[0];
}

export async function resolveReport(input: {
  reportId: string;
  action: "retire_fact" | "fix_number" | "reject";
  factId?: string;
  correctedNumber?: number;
  note?: string;
}): Promise<{ ok: true }> {
  const now = new Date().toISOString();

  if (input.action === "retire_fact") {
    if (!input.factId) throw new Error("A fact must be selected to retire");
    await setFactStatus({
      id: input.factId,
      status: "retired",
      reason: input.note ?? "Retired via player report",
    });
    await patchDoc(`trivia_reports/${input.reportId}`, {
      status: "resolved",
      resolutionNote: input.note ?? "Fact retired",
      resolved_at: now,
    });
    return { ok: true };
  }

  if (input.action === "fix_number") {
    if (!input.factId || input.correctedNumber === undefined) {
      throw new Error("A fact and a corrected number are required");
    }
    await updateFact({ id: input.factId, true_number: input.correctedNumber });
    await setFactStatus({ id: input.factId, status: "active" });
    await patchDoc(`trivia_reports/${input.reportId}`, {
      status: "resolved",
      resolutionNote: input.note ?? `Corrected to ${input.correctedNumber}`,
      resolved_at: now,
    });
    return { ok: true };
  }

  await patchDoc(`trivia_reports/${input.reportId}`, {
    status: "rejected",
    resolutionNote: input.note ?? "Report rejected",
    resolved_at: now,
  });
  return { ok: true };
}
