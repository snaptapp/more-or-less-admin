/**
 * Taxonomy, crawl queue, players, daily challenge and game analytics
 * using official Firebase Admin SDK. Server-only; callers authorize with `requireAdmin()`.
 */
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../firebase/admin.server";
import { logAdminAction } from "../firebase/audit.server";
import { normalizeKey } from "./content.server";
import type { AdminUser } from "../firebase/verify.server";

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function num(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/* --------------------------------- taxonomy -------------------------------- */

export interface SubjectRecord {
  id: string;
  subject: string;
  category: string;
  sub_category: string;
  aliases: string[];
  fact_count: number;
  last_crawled_at: string | null;
  crawl_notes: string;
}

function toSubject(id: string, d: Record<string, any>): SubjectRecord {
  return {
    id,
    subject: str(d["subject"]),
    category: str(d["category"]),
    sub_category: str(d["sub_category"]),
    aliases: strArray(d["aliases"]),
    fact_count: num(d["fact_count"]) ?? 0,
    last_crawled_at: d["last_crawled_at"]?.toDate ? d["last_crawled_at"].toDate().toISOString() : d["last_crawled_at"] || null,
    crawl_notes: str(d["crawl_notes"]),
  };
}

export async function listSubjects(input: { search?: string; category?: string }) {
  const snapshot = await adminDb.collection("fact_subjects").limit(500).get();
  let subjects = snapshot.docs.map((doc) => toSubject(doc.id, doc.data()));

  if (input.category) subjects = subjects.filter((s) => s.category === input.category);
  const term = input.search?.trim().toLowerCase();
  if (term) {
    subjects = subjects.filter((s) =>
      [s.subject, s.sub_category, ...s.aliases].join(" ").toLowerCase().includes(term)
    );
  }
  subjects.sort((a, b) => a.subject.localeCompare(b.subject));

  const coverage = new Map<string, { facts: number; subjects: number }>();
  for (const subject of subjects) {
    const entry = coverage.get(subject.category || "Uncategorised") ?? { facts: 0, subjects: 0 };
    entry.facts += subject.fact_count;
    entry.subjects += 1;
    coverage.set(subject.category || "Uncategorised", entry);
  }

  return {
    subjects,
    coverage: [...coverage.entries()].map(([category, stats]) => ({ category, ...stats })),
  };
}

export async function updateSubject(
  adminUser: AdminUser,
  input: {
    id: string;
    category?: string;
    sub_category?: string;
    aliases?: string[];
    crawl_notes?: string;
  }
): Promise<SubjectRecord> {
  const ref = adminDb.collection("fact_subjects").doc(input.id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Subject not found");

  const patch: Record<string, any> = { updated_at: FieldValue.serverTimestamp() };
  if (input.category !== undefined) patch["category"] = input.category;
  if (input.sub_category !== undefined) patch["sub_category"] = input.sub_category;
  if (input.aliases !== undefined) patch["aliases"] = input.aliases;
  if (input.crawl_notes !== undefined) patch["crawl_notes"] = input.crawl_notes;

  await ref.update(patch);

  await logAdminAction(adminUser, {
    action: "subject.update",
    targetType: "subject",
    targetId: input.id,
    details: `Updated taxonomy subject ${input.id}`,
    after: patch,
  });

  const updated = await ref.get();
  return toSubject(updated.id, updated.data()!);
}

/* ------------------------------- crawl queue ------------------------------- */

export interface CrawlRecord {
  id: string;
  subject: string;
  priority: number;
  status: string;
  requested_by: string;
  refresh: boolean;
  enqueued_at: string | null;
  completed_at: string | null;
}

function toCrawl(id: string, d: Record<string, any>): CrawlRecord {
  return {
    id,
    subject: str(d["subject"]),
    priority: num(d["priority"]) ?? 0,
    status: str(d["status"]) || "queued",
    requested_by: str(d["requested_by"]),
    refresh: d["refresh"] === true,
    enqueued_at: d["enqueued_at"]?.toDate ? d["enqueued_at"].toDate().toISOString() : d["enqueued_at"] || null,
    completed_at: d["completed_at"]?.toDate ? d["completed_at"].toDate().toISOString() : d["completed_at"] || null,
  };
}

export async function listCrawlQueue(input: { status?: string }) {
  let query: FirebaseFirestore.Query = adminDb.collection("crawl_queue");
  if (input.status) {
    query = query.where("status", "==", input.status);
  }

  const snapshot = await query.limit(200).get();
  const items = snapshot.docs.map((doc) => toCrawl(doc.id, doc.data()));
  items.sort(
    (a, b) => b.priority - a.priority || (b.enqueued_at ?? "").localeCompare(a.enqueued_at ?? "")
  );
  return items;
}

export async function enqueueCrawl(
  adminUser: AdminUser,
  input: {
    subject: string;
    priority: number;
    refresh: boolean;
  }
): Promise<CrawlRecord> {
  const subjectKey = normalizeKey(input.subject);
  const ref = adminDb.collection("crawl_queue").doc(subjectKey);

  const payload = {
    subject: input.subject,
    priority: input.priority,
    status: "queued",
    requested_by: adminUser.email || "admin_portal",
    refresh: input.refresh,
    enqueued_at: FieldValue.serverTimestamp(),
    completed_at: null,
  };

  await ref.set(payload, { merge: true });

  await logAdminAction(adminUser, {
    action: "crawl.enqueue",
    targetType: "crawl_job",
    targetId: subjectKey,
    details: `Enqueued crawl topic "${input.subject}" with priority ${input.priority}`,
    after: payload,
  });

  const updated = await ref.get();
  return toCrawl(updated.id, updated.data()!);
}

export async function setCrawlPriority(
  adminUser: AdminUser,
  input: {
    id: string;
    priority: number;
  }
): Promise<CrawlRecord> {
  const ref = adminDb.collection("crawl_queue").doc(input.id);
  await ref.update({ priority: input.priority, updated_at: FieldValue.serverTimestamp() });

  await logAdminAction(adminUser, {
    action: "crawl.set_priority",
    targetType: "crawl_job",
    targetId: input.id,
    details: `Set crawl priority to ${input.priority} for ${input.id}`,
    after: { priority: input.priority },
  });

  const updated = await ref.get();
  return toCrawl(updated.id, updated.data()!);
}

/** Dispatches the GitHub Actions Fact Foundry crawler workflow on demand */
export async function triggerFoundryWorkflow(adminUser: AdminUser): Promise<{ ok: boolean; message: string }> {
  const token = process.env["GITHUB_TOKEN"] || process.env["GH_TOKEN"];
  const repo = process.env["GITHUB_REPOSITORY"] || "the-og-more-or-less/more-or-less";

  if (!token) {
    return {
      ok: false,
      message: "GITHUB_TOKEN is not configured on the server. Topic is saved in queue for the nightly 02:00 UTC run.",
    };
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/fact-foundry.yml/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "more-or-less-admin",
      },
      body: JSON.stringify({ ref: "main" }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return { ok: false, message: `GitHub Action dispatch failed (${res.status}): ${errText.slice(0, 200)}` };
    }

    await logAdminAction(adminUser, {
      action: "crawl.dispatch_foundry",
      targetType: "crawl_job",
      targetId: "fact-foundry-workflow",
      details: "Dispatched manual Fact Foundry GitHub Action workflow",
    });

    return { ok: true, message: "Fact Foundry workflow triggered successfully on GitHub Actions." };
  } catch (err: any) {
    return { ok: false, message: err?.message || "Failed to trigger GitHub Action" };
  }
}

/* ---------------------------------- players -------------------------------- */

export interface PlayerRecord {
  id: string;
  displayName: string;
  email: string;
  isPremium: boolean;
  createdAt: string | null;
  stats: {
    totalGamesPlayed: number;
    totalCorrect: number;
    totalWrong: number;
    bestScore: number;
    lifetimePercentCorrect: number;
  } | null;
}

export async function findPlayers(input: { search?: string }): Promise<PlayerRecord[]> {
  const snapshot = await adminDb.collection("users").limit(200).get();
  const term = input.search?.trim().toLowerCase();

  const players = snapshot.docs
    .map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        displayName: str(d["displayName"]),
        email: str(d["email"]),
        isPremium: d["isPremium"] === true,
        createdAt: d["createdAt"]?.toDate ? d["createdAt"].toDate().toISOString() : d["createdAt"] || null,
        stats: null,
      };
    })
    .filter((player) =>
      term ? `${player.displayName} ${player.email} ${player.id}`.toLowerCase().includes(term) : true
    )
    .slice(0, 50);

  return players;
}

export async function getPlayer(id: string): Promise<PlayerRecord | null> {
  const doc = await adminDb.collection("users").doc(id).get();
  if (!doc.exists) return null;
  const d = doc.data()!;

  const summaryDoc = await adminDb.collection("users").doc(id).collection("stats").doc("summary").get();
  const sumData = summaryDoc.exists ? summaryDoc.data()! : null;

  return {
    id: doc.id,
    displayName: str(d["displayName"]),
    email: str(d["email"]),
    isPremium: d["isPremium"] === true,
    createdAt: d["createdAt"]?.toDate ? d["createdAt"].toDate().toISOString() : d["createdAt"] || null,
    stats: sumData
      ? {
          totalGamesPlayed: num(sumData["totalGamesPlayed"]) ?? 0,
          totalCorrect: num(sumData["totalCorrect"]) ?? 0,
          totalWrong: num(sumData["totalWrong"]) ?? 0,
          bestScore: num(sumData["bestScore"]) ?? 0,
          lifetimePercentCorrect: num(sumData["lifetimePercentCorrect"]) ?? 0,
        }
      : null,
  };
}

export async function setPremium(adminUser: AdminUser, input: { id: string; isPremium: boolean }) {
  const ref = adminDb.collection("users").doc(input.id);
  await ref.update({ isPremium: input.isPremium, updatedAt: FieldValue.serverTimestamp() });

  await logAdminAction(adminUser, {
    action: input.isPremium ? "player.grant_premium" : "player.revoke_premium",
    targetType: "user",
    targetId: input.id,
    details: `${input.isPremium ? "Granted" : "Revoked"} premium entitlement for user ${input.id}`,
    after: { isPremium: input.isPremium },
  });

  return { ok: true as const };
}

/* ------------------------------ daily challenge ---------------------------- */

export interface DailyPack {
  date: string;
  seed: string;
  category: string;
  rounds: any[];
  createdAt: string | null;
}

export async function getDailyPack(date: string): Promise<DailyPack | null> {
  const doc = await adminDb.collection("daily_packs").doc(date).get();
  if (!doc.exists) return null;
  const d = doc.data()!;
  return {
    date,
    seed: str(d["seed"]),
    category: str(d["category"]),
    rounds: Array.isArray(d["rounds"]) ? d["rounds"] : [],
    createdAt: d["createdAt"]?.toDate ? d["createdAt"].toDate().toISOString() : d["createdAt"] || null,
  };
}

export async function scheduleDailyPack(
  adminUser: AdminUser,
  input: {
    date: string;
    category: string;
    rounds: any[];
  }
): Promise<DailyPack> {
  const ref = adminDb.collection("daily_packs").doc(input.date);
  const payload = {
    date: input.date,
    seed: `admin_scheduled_${input.date}`,
    category: input.category,
    rounds: input.rounds,
    is_valid: true,
    total_rounds: input.rounds.length,
    status_message: "Admin pre-scheduled daily pack",
    createdAt: FieldValue.serverTimestamp(),
  };

  await ref.set(payload);

  await logAdminAction(adminUser, {
    action: "daily.schedule_pack",
    targetType: "daily_pack",
    targetId: input.date,
    details: `Pre-scheduled daily pack for date ${input.date} with category "${input.category}" (${input.rounds.length} rounds)`,
    after: payload,
  });

  return {
    date: input.date,
    seed: payload.seed,
    category: payload.category,
    rounds: payload.rounds,
    createdAt: new Date().toISOString(),
  };
}

export async function getDailyLeaderboard(date: string) {
  const doc = await adminDb.collection("daily_leaderboards").doc(date).get();
  if (!doc.exists) return { date, entries: [] as any[], raw: null };
  const d = doc.data()!;
  const entries = Array.isArray(d["entries"]) ? d["entries"] : [];
  return { date, entries, raw: d };
}

export async function removeDailyLeaderboardEntry(
  adminUser: AdminUser,
  input: {
    date: string;
    uid: string;
    reason?: string;
  }
): Promise<{ ok: boolean }> {
  const ref = adminDb.collection("daily_leaderboards").doc(input.date);

  await adminDb.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) return;
    const data = snap.data()!;
    const entries = Array.isArray(data["entries"]) ? data["entries"] : [];
    const filtered = entries.filter((e: any) => e.uid !== input.uid);

    transaction.update(ref, {
      entries: filtered,
      updatedAt: FieldValue.serverTimestamp(),
    });

    await logAdminAction(
      adminUser,
      {
        action: "daily.moderate_leaderboard_entry",
        targetType: "leaderboard",
        targetId: `${input.date}:${input.uid}`,
        details: `Removed user ${input.uid} from daily leaderboard for ${input.date}. Reason: ${input.reason || "Administrative removal"}`,
      },
      transaction
    );
  });

  return { ok: true };
}

/* --------------------------------- analytics ------------------------------- */

export async function getGameAnalytics(input: { since?: string }) {
  let query: FirebaseFirestore.Query = adminDb.collection("games");
  if (input.since) {
    query = query.where("startedAt", ">=", input.since);
  }

  const snapshot = await query.limit(500).get();
  const docs = snapshot.docs.map((d) => d.data());

  const tally = (key: string) => {
    const counts = new Map<string, number>();
    for (const d of docs) {
      const value = str(d[key]) || "unknown";
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  };

  return {
    total: docs.length,
    windowed: docs.length >= 500,
    byMode: tally("gameMode"),
    byCategory: tally("category"),
    byDifficulty: tally("difficulty"),
    byPace: tally("pace"),
  };
}
