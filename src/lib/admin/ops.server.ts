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

export async function setPremium(input: { id: string; isPremium: boolean }) {
  await patchDoc(`users/${input.id}`, { isPremium: input.isPremium });
  return { ok: true as const };
}

/* ------------------------------ daily challenge ---------------------------- */

export interface DailyPack {
  date: string;
  seed: string;
  category: string;
  rounds: Json[];
  createdAt: string | null;
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

export async function getDailyLeaderboard(date: string) {
  const doc = await getDoc(`daily_leaderboards/${date}`);
  if (!doc) return { date, entries: [] as Json[], raw: null as Json };
  const entries = Array.isArray(doc.data["entries"]) ? (doc.data["entries"] as Json[]) : [];
  return { date, entries, raw: doc.data as unknown as Json };
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
