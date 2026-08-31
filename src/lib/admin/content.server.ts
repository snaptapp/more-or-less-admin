/**
 * Fact bank + moderation logic using official Firebase Admin SDK.
 * Server-only: callers authorize with `requireAdmin()`.
 */
import { FieldValue } from "firebase-admin/firestore";
import * as crypto from "crypto";
import { adminDb } from "../firebase/admin.server";
import { logAdminAction } from "../firebase/audit.server";
import type { AdminUser } from "../firebase/verify.server";

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

export function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function factId(subjectKey: string, angleKey: string): string {
  return crypto
    .createHash("sha1")
    .update(`${subjectKey}|${angleKey}`)
    .digest("hex")
    .slice(0, 16);
}

function toFact(id: string, d: Record<string, any>, updateTime?: string): FactRecord {
  return {
    id,
    subject: String(d["subject"] || ""),
    subject_key: String(d["subject_key"] || ""),
    angle: String(d["angle"] || ""),
    angle_key: String(d["angle_key"] || ""),
    true_number: typeof d["true_number"] === "number" ? d["true_number"] : null,
    unit: String(d["unit"] || ""),
    claim_template: String(d["claim_template"] || ""),
    context: String(d["context"] || ""),
    question: String(d["question"] || ""),
    surprise_factor: typeof d["surprise_factor"] === "number" ? d["surprise_factor"] : null,
    difficulty_hint: String(d["difficulty_hint"] || "medium"),
    content_rating: String(d["content_rating"] || "standard"),
    status: String(d["status"] || "active"),
    previous_true_number: typeof d["previous_true_number"] === "number" ? d["previous_true_number"] : null,
    retired_reason: typeof d["retired_reason"] === "string" ? d["retired_reason"] : null,
    source_urls: Array.isArray(d["source_urls"])
      ? d["source_urls"].filter((v: unknown): v is string => typeof v === "string")
      : [],
    verifier_model: String(d["verifier_model"] || ""),
    verified_at: d["verified_at"]?.toDate ? d["verified_at"].toDate().toISOString() : d["verified_at"] || null,
    served_count: Number(d["served_count"] || 0),
    last_served_at: d["last_served_at"]?.toDate ? d["last_served_at"].toDate().toISOString() : d["last_served_at"] || null,
    category: typeof d["category"] === "string" ? d["category"] : null,
    updateTime,
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

export async function listFacts(input: FactListInput) {
  const pageSize = Math.min(input.pageSize ?? 25, 100);
  const page = Math.max(input.page ?? 1, 1);

  let query: FirebaseFirestore.Query = adminDb.collection("fact_bank");

  if (input.status) {
    query = query.where("status", "==", input.status);
  }
  if (input.contentRating) {
    query = query.where("content_rating", "==", input.contentRating);
  }
  if (input.difficulty) {
    query = query.where("difficulty_hint", "==", input.difficulty);
  }

  // Count total matches natively using Firestore count() aggregation
  const countSnapshot = await query.count().get();
  const totalCount = countSnapshot.data().count;

  // Retrieve window for pagination/sorting
  const snapshot = await query.limit(500).get();

  let facts = snapshot.docs.map((doc) =>
    toFact(doc.id, doc.data(), doc.updateTime?.toDate().toISOString())
  );

  if (input.minSurprise) {
    facts = facts.filter((fact) => (fact.surprise_factor ?? 0) >= input.minSurprise!);
  }
  const term = input.search?.trim().toLowerCase();
  if (term) {
    facts = facts.filter((fact) =>
      [fact.subject, fact.angle, fact.question, fact.claim_template]
        .join(" ")
        .toLowerCase()
        .includes(term)
    );
  }
  facts.sort((a, b) => a.subject.localeCompare(b.subject) || a.angle.localeCompare(b.angle));

  const total = term || input.minSurprise ? facts.length : totalCount;
  const start = (page - 1) * pageSize;

  return {
    facts: facts.slice(start, start + pageSize),
    total,
    page,
    pageSize,
    windowed: snapshot.docs.length >= 500,
  };
}

export async function getFact(id: string): Promise<FactRecord | null> {
  const doc = await adminDb.collection("fact_bank").doc(id).get();
  if (!doc.exists) return null;
  return toFact(doc.id, doc.data()!, doc.updateTime?.toDate().toISOString());
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

export async function updateFact(adminUser: AdminUser, input: FactEditInput): Promise<FactRecord> {
  const ref = adminDb.collection("fact_bank").doc(input.id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`Fact ${input.id} not found`);

  const existing = toFact(snap.id, snap.data()!);
  const patch: Record<string, any> = {};

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

  if (input.true_number !== undefined && input.true_number !== existing.true_number) {
    patch["previous_true_number"] = existing.true_number;
    patch["true_number"] = input.true_number;
  }

  if (Object.keys(patch).length > 0) {
    patch["updated_at"] = FieldValue.serverTimestamp();
    await ref.update(patch);

    await logAdminAction(adminUser, {
      action: "fact.update",
      targetType: "fact",
      targetId: input.id,
      details: `Updated fact ${existing.subject} - ${existing.angle}`,
      before: { true_number: existing.true_number, question: existing.question },
      after: patch,
    });
  }

  const updated = await ref.get();
  return toFact(updated.id, updated.data()!, updated.updateTime?.toDate().toISOString());
}

export async function setFactStatus(
  adminUser: AdminUser,
  input: {
    id: string;
    status: (typeof FACT_STATUSES)[number];
    reason?: string;
    verifierModel?: string;
  }
): Promise<FactRecord> {
  const ref = adminDb.collection("fact_bank").doc(input.id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`Fact ${input.id} not found`);

  const existing = toFact(snap.id, snap.data()!);
  const patch: Record<string, any> = {
    status: input.status,
    updated_at: FieldValue.serverTimestamp(),
  };

  if (input.status === "retired") {
    patch["retired_reason"] = input.reason ?? "Retired from admin portal";
  }
  if (input.status === "active") {
    patch["verified_at"] = FieldValue.serverTimestamp();
    patch["verifier_model"] = input.verifierModel ?? "admin_portal";
    patch["retired_reason"] = null;
  }

  await ref.update(patch);

  await logAdminAction(adminUser, {
    action: `fact.status_${input.status}`,
    targetType: "fact",
    targetId: input.id,
    details: `Changed status from ${existing.status} to ${input.status}`,
    before: { status: existing.status, retired_reason: existing.retired_reason },
    after: patch,
  });

  const updated = await ref.get();
  return toFact(updated.id, updated.data()!, updated.updateTime?.toDate().toISOString());
}

export async function createFact(
  adminUser: AdminUser,
  input: {
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
  }
): Promise<FactRecord> {
  const subject_key = normalizeKey(input.subject);
  const angle_key = normalizeKey(input.angle);
  const id = factId(subject_key, angle_key);

  const ref = adminDb.collection("fact_bank").doc(id);
  const existing = await ref.get();
  if (existing.exists) {
    throw new Error("A fact with this subject and angle already exists");
  }

  const payload = {
    ...input,
    subject_key,
    angle_key,
    status: "active",
    previous_true_number: null,
    retired_reason: null,
    verifier_model: "admin_portal",
    verified_at: FieldValue.serverTimestamp(),
    served_count: 0,
    last_served_at: null,
    createdAt: FieldValue.serverTimestamp(),
  };

  await ref.set(payload);

  await logAdminAction(adminUser, {
    action: "fact.create",
    targetType: "fact",
    targetId: id,
    details: `Created new fact ${input.subject} - ${input.angle} (${id})`,
    after: payload,
  });

  const created = await ref.get();
  return toFact(created.id, created.data()!, created.updateTime?.toDate().toISOString());
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

function toReport(id: string, d: Record<string, any>): ReportRecord {
  return {
    id,
    topic: String(d["topic"] || ""),
    claimStatement: String(d["claimStatement"] || ""),
    presentedNumber: typeof d["presentedNumber"] === "number" ? d["presentedNumber"] : null,
    trueNumber: typeof d["trueNumber"] === "number" ? d["trueNumber"] : null,
    unit: String(d["unit"] || ""),
    reason: String(d["reason"] || ""),
    feedbackText: String(d["feedbackText"] || ""),
    reporterUid: String(d["reporterUid"] || ""),
    status: String(d["status"] || "pending_review"),
    createdAt: d["createdAt"]?.toDate ? d["createdAt"].toDate().toISOString() : d["createdAt"] || null,
    resolutionNote: typeof d["resolutionNote"] === "string" ? d["resolutionNote"] : null,
  };
}

export async function listReports(input: { status?: string; limit?: number }) {
  let query: FirebaseFirestore.Query = adminDb.collection("trivia_reports");
  if (input.status) {
    query = query.where("status", "==", input.status);
  }

  const snapshot = await query.orderBy("createdAt", "desc").limit(input.limit ?? 100).get();
  return snapshot.docs.map((doc) => toReport(doc.id, doc.data()));
}

export async function findFactForReport(report: ReportRecord): Promise<FactRecord | null> {
  const topicKey = normalizeKey(report.topic);
  if (!topicKey) return null;

  const snapshot = await adminDb
    .collection("fact_bank")
    .where("subject_key", "==", topicKey)
    .limit(20)
    .get();

  const facts = snapshot.docs.map((doc) => toFact(doc.id, doc.data()));
  if (facts.length === 0) return null;

  const exact = facts.find((fact) => fact.true_number === report.trueNumber);
  return exact ?? facts[0];
}

async function notifyEdgeDisputeBlocklist(claimStatement: string): Promise<void> {
  const edgeUrl = process.env["EDGE_WORKER_URL"];
  if (!edgeUrl || !claimStatement) return;

  try {
    const internalSecret = process.env["EDGE_INTERNAL_SECRET"] || "";
    await fetch(`${edgeUrl.replace(/\/+$/, "")}/api/dispute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": internalSecret,
      },
      body: JSON.stringify({ claimStatement }),
    });
  } catch (err) {
    console.warn("[Edge Dispute Sync] Failed to notify edge worker:", err);
  }
}

export async function resolveReport(
  adminUser: AdminUser,
  input: {
    reportId: string;
    action: "retire_fact" | "fix_number" | "reject";
    factId?: string;
    correctedNumber?: number;
    note?: string;
    claimStatement?: string;
  }
): Promise<{ ok: true }> {
  const reportRef = adminDb.collection("trivia_reports").doc(input.reportId);

  await adminDb.runTransaction(async (transaction) => {
    const reportSnap = await transaction.get(reportRef);
    if (!reportSnap.exists) throw new Error("Report not found");

    if (input.action === "retire_fact") {
      if (!input.factId) throw new Error("A fact must be selected to retire");
      const factRef = adminDb.collection("fact_bank").doc(input.factId);
      const factSnap = await transaction.get(factRef);
      if (factSnap.exists) {
        transaction.update(factRef, {
          status: "retired",
          retired_reason: input.note ?? "Retired via player report",
          updated_at: FieldValue.serverTimestamp(),
        });
      }

      transaction.update(reportRef, {
        status: "resolved",
        resolutionNote: input.note ?? "Fact retired",
        resolved_at: FieldValue.serverTimestamp(),
      });

      await logAdminAction(
        adminUser,
        {
          action: "report.resolve_retire_fact",
          targetType: "report",
          targetId: input.reportId,
          details: `Resolved report ${input.reportId} and retired fact ${input.factId}`,
        },
        transaction
      );
      return;
    }

    if (input.action === "fix_number") {
      if (!input.factId || input.correctedNumber === undefined) {
        throw new Error("A fact and a corrected number are required");
      }
      const factRef = adminDb.collection("fact_bank").doc(input.factId);
      const factSnap = await transaction.get(factRef);
      if (factSnap.exists) {
        const factData = factSnap.data()!;
        transaction.update(factRef, {
          previous_true_number: factData["true_number"] ?? null,
          true_number: input.correctedNumber,
          status: "active",
          updated_at: FieldValue.serverTimestamp(),
        });
      }

      transaction.update(reportRef, {
        status: "resolved",
        resolutionNote: input.note ?? `Corrected to ${input.correctedNumber}`,
        resolved_at: FieldValue.serverTimestamp(),
      });

      await logAdminAction(
        adminUser,
        {
          action: "report.resolve_fix_number",
          targetType: "report",
          targetId: input.reportId,
          details: `Resolved report ${input.reportId} and updated fact ${input.factId} to ${input.correctedNumber}`,
        },
        transaction
      );
      return;
    }

    // Reject report
    transaction.update(reportRef, {
      status: "rejected",
      resolutionNote: input.note ?? "Report rejected",
      resolved_at: FieldValue.serverTimestamp(),
    });

    await logAdminAction(
      adminUser,
      {
        action: "report.reject",
        targetType: "report",
        targetId: input.reportId,
        details: `Rejected report ${input.reportId}`,
      },
      transaction
    );
  });

  // Edge Dispute Blocklist synchronization
  if (input.claimStatement && (input.action === "retire_fact" || input.action === "fix_number")) {
    void notifyEdgeDisputeBlocklist(input.claimStatement);
  }

  return { ok: true };
}
