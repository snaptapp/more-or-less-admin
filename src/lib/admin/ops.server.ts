/**
 * Taxonomy, crawl queue, players, daily challenge and game analytics.
 * Server-only; callers authorize with `requireAdmin()` first.
 */
import {
  createDoc,
  getDoc,
  listDocs,
  normalizeKey,
  patchDoc,
  runQuery,
  type FirestoreDoc,
  type Json,
} from "../firebase/firestore.server";
import type { AdminUser } from "../firebase/verify.server";

function str(value: Json | undefined): string {
  return typeof value === "string" ? value : "";
}
function num(value: Json | undefined): number | null {
  return typeof value === "number" ? value : null;
}
function strArray(value: Json | undefined): string[] {
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

function toSubject(doc: FirestoreDoc): SubjectRecord {
  const d = doc.data;
  return {
    id: doc.id,
    subject: str(d["subject"]),
    category: str(d["category"]),
    sub_category: str(d["sub_category"]),
    aliases: strArray(d["aliases"]),
    fact_count: num(d["fact_count"]) ?? 0,
    last_crawled_at: typeof d["last_crawled_at"] === "string" ? d["last_crawled_at"] : null,
    crawl_notes: str(d["crawl_notes"]),
  };
}

export async function listSubjects(input: { search?: string; category?: string }) {
  const { docs } = await listDocs("fact_subjects", { pageSize: 300 });
  let subjects = docs.map(toSubject);
  if (input.category) subjects = subjects.filter((s) => s.category === input.category);
  const term = input.search?.trim().toLowerCase();
  if (term) {
    subjects = subjects.filter((s) =>
      [s.subject, s.sub_category, ...s.aliases].join(" ").toLowerCase().includes(term),
    );
  }
  subjects.sort((a, b) => a.subject.localeCompare(b.subject));

  const coverage = new Map<string, { facts: number; subjects: number }>();
  for (const subject of docs.map(toSubject)) {
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

export async function updateSubject(input: {
  id: string;
  category?: string;
  sub_category?: string;
  aliases?: string[];
  crawl_notes?: string;
}): Promise<SubjectRecord> {
  const patch: Record<string, unknown> = {};
  if (input.category !== undefined) patch["category"] = input.category;
  if (input.sub_category !== undefined) patch["sub_category"] = input.sub_category;
  if (input.aliases !== undefined) patch["aliases"] = input.aliases;
  if (input.crawl_notes !== undefined) patch["crawl_notes"] = input.crawl_notes;
  return toSubject(await patchDoc(`fact_subjects/${input.id}`, patch));
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

function toCrawl(doc: FirestoreDoc): CrawlRecord {
  const d = doc.data;
  return {
    id: doc.id,
    subject: str(d["subject"]),
    priority: num(d["priority"]) ?? 0,
    status: str(d["status"]) || "queued",
    requested_by: str(d["requested_by"]),
    refresh: d["refresh"] === true,
    enqueued_at: typeof d["enqueued_at"] === "string" ? d["enqueued_at"] : null,
    completed_at: typeof d["completed_at"] === "string" ? d["completed_at"] : null,
  };
}

export async function listCrawlQueue(input: { status?: string }) {
  const docs = input.status
    ? await runQuery({
        collection: "crawl_queue",
        filters: [{ field: "status", op: "EQUAL", value: input.status }],
        limit: 200,
      })
    : (await listDocs("crawl_queue", { pageSize: 200 })).docs;
  const items = docs.map(toCrawl);
  items.sort(
    (a, b) => b.priority - a.priority || (b.enqueued_at ?? "").localeCompare(a.enqueued_at ?? ""),
  );
  return items;
}

export async function enqueueCrawl(input: {
  subject: string;
  priority: number;
  refresh: boolean;
}): Promise<CrawlRecord> {
  const subjectKey = normalizeKey(input.subject);
  const payload = {
    subject: input.subject,
    priority: input.priority,
    status: "queued",
    requested_by: "manual",
    refresh: input.refresh,
    enqueued_at: new Date().toISOString(),
    completed_at: null,
  };
  const existing = await getDoc(`crawl_queue/${subjectKey}`);
  if (existing) return toCrawl(await patchDoc(`crawl_queue/${subjectKey}`, payload));
  return toCrawl(await createDoc("crawl_queue", subjectKey, payload));
}

export async function setCrawlPriority(input: {
  id: string;
  priority: number;
}): Promise<CrawlRecord> {
  return toCrawl(await patchDoc(`crawl_queue/${input.id}`, { priority: input.priority }));
}

export async function triggerFoundryWorkflow(adminUser?: AdminUser): Promise<{ ok: boolean; message: string }> {
  const token = process.env["GITHUB_TOKEN"] || process.env["GH_TOKEN"];
  const repo = process.env["GITHUB_REPOSITORY"] || "the-og-more-or-less/more-or-less";

  if (!token) {
    return {
      ok: false,
      message: "GITHUB_TOKEN is not configured on the server. Topic is saved in queue for the nightly run.",
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

    if (adminUser) {
      const { logAdminAction } = await import("@/lib/firebase/audit.server");
      await logAdminAction(adminUser, {
        action: "crawl.dispatch_foundry",
        targetType: "crawl_job",
        targetId: "fact-foundry-workflow",
        details: "Dispatched manual Fact Foundry GitHub Action workflow",
      });
    }

    return { ok: true, message: "Fact Foundry workflow triggered successfully on GitHub Actions." };
  } catch (err: unknown) {
    return { ok: false, message: err instanceof Error ? err.message : "Failed to trigger GitHub Action" };
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
  const { docs } = await listDocs("users", { pageSize: 200 });
  const term = input.search?.trim().toLowerCase();
  const players = docs
    .map((doc) => ({
      id: doc.id,
      displayName: str(doc.data["displayName"]),
      email: str(doc.data["email"]),
      isPremium: doc.data["isPremium"] === true,
      createdAt: typeof doc.data["createdAt"] === "string" ? doc.data["createdAt"] : null,
      stats: null as PlayerRecord["stats"],
    }))
    .filter((player) =>
      term ? `${player.displayName} ${player.email} ${player.id}`.toLowerCase().includes(term) : true,
    )
    .slice(0, 50);
  return players;
}

export async function getPlayer(id: string): Promise<PlayerRecord | null> {
  const doc = await getDoc(`users/${id}`);
  if (!doc) return null;
  const summary = await getDoc(`users/${id}/stats/summary`);
  return {
    id: doc.id,
    displayName: str(doc.data["displayName"]),
    email: str(doc.data["email"]),
    isPremium: doc.data["isPremium"] === true,
    createdAt: typeof doc.data["createdAt"] === "string" ? doc.data["createdAt"] : null,
    stats: summary
      ? {
          totalGamesPlayed: num(summary.data["totalGamesPlayed"]) ?? 0,
          totalCorrect: num(summary.data["totalCorrect"]) ?? 0,
          totalWrong: num(summary.data["totalWrong"]) ?? 0,
          bestScore: num(summary.data["bestScore"]) ?? 0,
          lifetimePercentCorrect: num(summary.data["lifetimePercentCorrect"]) ?? 0,
        }
      : null,
  };
}

export async function setPremium(input: { id: string; isPremium: boolean }, adminUser?: AdminUser) {
  await patchDoc(`users/${input.id}`, { isPremium: input.isPremium, updatedAt: new Date().toISOString() });
  if (adminUser) {
    const { logAdminAction } = await import("@/lib/firebase/audit.server");
    await logAdminAction(adminUser, {
      action: input.isPremium ? "player.grant_premium" : "player.revoke_premium",
      targetType: "user",
      targetId: input.id,
      details: `${input.isPremium ? "Granted" : "Revoked"} premium entitlement for user ${input.id}`,
      after: { isPremium: input.isPremium },
    });
  }
  return { ok: true as const };
}

/* ------------------------------ daily challenge ---------------------------- */

export interface DailyPackSummary {
  date: string;
  category: string;
  seed: string;
  total_rounds: number;
  createdAt: string | null;
}

export async function listDailyPacks(limit = 100): Promise<DailyPackSummary[]> {
  const { docs } = await listDocs("daily_packs", { pageSize: limit });
  const packs: DailyPackSummary[] = docs.map((doc) => ({
    date: doc.id,
    category: str(doc.data["category"]) || "mixed",
    seed: str(doc.data["seed"]),
    total_rounds: Array.isArray(doc.data["rounds"])
      ? doc.data["rounds"].length
      : (num(doc.data["total_rounds"]) ?? 0),
    createdAt: typeof doc.data["createdAt"] === "string" ? doc.data["createdAt"] : null,
  }));
  packs.sort((a, b) => b.date.localeCompare(a.date));
  return packs;
}

export async function getDailyPack(date: string): Promise<DailyPack | null> {
  const doc = await getDoc(`daily_packs/${date}`);
  if (!doc) return null;
  return {
    date,
    seed: str(doc.data["seed"]),
    category: str(doc.data["category"]),
    rounds: Array.isArray(doc.data["rounds"]) ? (doc.data["rounds"] as Json[]) : [],
    createdAt: typeof doc.data["createdAt"] === "string" ? doc.data["createdAt"] : null,
  };
}

export async function deleteDailyPack(date: string, adminUser?: AdminUser): Promise<{ ok: boolean }> {
  const { deleteDoc } = await import("../firebase/firestore.server");
  await deleteDoc(`daily_packs/${date}`);
  if (adminUser) {
    const { logAdminAction } = await import("@/lib/firebase/audit.server");
    await logAdminAction(adminUser, {
      action: "daily.delete_pack",
      targetType: "daily_pack",
      targetId: date,
      details: `Deleted daily pack for date ${date}`,
    });
  }
  return { ok: true };
}

export async function generateDailyPackFromFactBank(input: {
  category?: string;
  subject?: string;
}): Promise<{ category: string; rounds: any[] }> {
  const { exportFacts } = await import("./content.server");
  const allFacts = await exportFacts({
    status: "active",
    contentRating: "standard",
  });

  let candidates = allFacts;
  if (input.subject?.trim()) {
    const sub = input.subject.trim().toLowerCase();
    candidates = candidates.filter((f) => f.subject.toLowerCase().includes(sub));
  }

  // Shuffle candidates
  const shuffled = candidates.sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, 5);

  const rounds = selected.map((f, index) => {
    const trueNum = f.true_number;
    const targetDirection = index % 2 === 0 ? "MORE" : "LESS";
    const multiplier = 1.8 + Math.random() * 0.8;
    let presentedNum: number;

    if (targetDirection === "MORE") {
      presentedNum = trueNum > 10 ? Math.round(trueNum / multiplier) : Number((trueNum / multiplier).toFixed(1));
    } else {
      presentedNum = trueNum > 10 ? Math.round(trueNum * multiplier) : Number((trueNum * multiplier).toFixed(1));
    }

    if (presentedNum === trueNum) {
      presentedNum = targetDirection === "MORE" ? trueNum - 1 : trueNum + 1;
    }

    const actualDirection = trueNum > presentedNum ? "MORE" : "LESS";

    return {
      round_number: index + 1,
      topic: f.subject,
      claim_statement: f.question || `${f.subject} - ${f.angle}`,
      presented_number: presentedNum,
      true_number: trueNum,
      unit: f.unit,
      correct_direction: actualDirection,
      explanation: f.context || `${f.subject}'s true value is ${trueNum} ${f.unit}.`,
      difficulty: "casual",
      surprise_factor: f.surprise_factor ?? 2,
    };
  });

  return {
    category: input.category || (selected[0]?.subject ?? "Curated Trivia"),
    rounds,
  };
}

export async function scheduleDailyPack(
  input: {
    date: string;
    category: string;
    rounds: unknown[];
  },
  adminUser?: AdminUser,
): Promise<DailyPack> {
  const payload = {
    date: input.date,
    seed: `admin_scheduled_${input.date}`,
    category: input.category,
    rounds: input.rounds,
    is_valid: true,
    total_rounds: input.rounds.length,
    status_message: "Admin pre-scheduled daily pack",
    createdAt: new Date().toISOString(),
  };

  const existing = await getDoc(`daily_packs/${input.date}`);
  if (existing) {
    await patchDoc(`daily_packs/${input.date}`, payload);
  } else {
    await createDoc("daily_packs", input.date, payload);
  }

  if (adminUser) {
    const { logAdminAction } = await import("@/lib/firebase/audit.server");
    await logAdminAction(adminUser, {
      action: "daily.schedule_pack",
      targetType: "daily_pack",
      targetId: input.date,
      details: `Pre-scheduled daily pack for date ${input.date} with category "${input.category}" (${input.rounds.length} rounds)`,
    });
  }

  return {
    date: input.date,
    seed: payload.seed,
    category: payload.category,
    rounds: payload.rounds as Json[],
    createdAt: payload.createdAt,
  };
}

export async function getDailyLeaderboard(date: string) {
  const doc = await getDoc(`daily_leaderboards/${date}`);
  if (!doc) return { date, entries: [] as Json[], raw: null as Json };
  const entries = Array.isArray(doc.data["entries"]) ? (doc.data["entries"] as Json[]) : [];
  return { date, entries, raw: doc.data as unknown as Json };
}

export async function removeDailyLeaderboardEntry(
  input: {
    date: string;
    uid: string;
    reason?: string;
  },
  adminUser?: AdminUser,
): Promise<{ ok: boolean }> {
  const doc = await getDoc(`daily_leaderboards/${input.date}`);
  if (!doc) return { ok: true };
  const rawEntries = Array.isArray(doc.data["entries"]) ? (doc.data["entries"] as Record<string, unknown>[]) : [];
  const filtered = rawEntries.filter((e) => e["uid"] !== input.uid);

  await patchDoc(`daily_leaderboards/${input.date}`, {
    entries: filtered,
    updatedAt: new Date().toISOString(),
  });

  if (adminUser) {
    const { logAdminAction } = await import("@/lib/firebase/audit.server");
    await logAdminAction(adminUser, {
      action: "daily.moderate_leaderboard_entry",
      targetType: "leaderboard",
      targetId: `${input.date}:${input.uid}`,
      details: `Removed user ${input.uid} from daily leaderboard for ${input.date}. Reason: ${input.reason || "Administrative removal"}`,
    });
  }

  return { ok: true };
}

/* --------------------------------- analytics ------------------------------- */

export async function getGameAnalytics(input: { since?: string }) {
  const filters = input.since
    ? [{ field: "startedAt" as const, op: "GREATER_THAN_OR_EQUAL" as const, value: input.since }]
    : [];
  const docs = await runQuery({ collection: "games", filters, limit: 500 });

  const tally = (key: string) => {
    const counts = new Map<string, number>();
    for (const doc of docs) {
      const value = str(doc.data[key]) || "unknown";
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
