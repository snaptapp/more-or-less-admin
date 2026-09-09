/**
 * Taxonomy, crawl queue, players, daily challenge and game analytics.
 * Server-only; callers authorize with `requireAdmin()` first.
 */
import {
  createDoc,
  getDoc,
  isFirestoreIndexError,
  listDocs,
  normalizeKey,
  patchDoc,
  runQuery,
  runTransaction,
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
  playlist_ids: string[];
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
    playlist_ids: strArray(d["playlist_ids"]),
    fact_count: num(d["fact_count"]) ?? 0,
    last_crawled_at: typeof d["last_crawled_at"] === "string" ? d["last_crawled_at"] : null,
    crawl_notes: str(d["crawl_notes"]),
  };
}

async function listAllDocs(collection: string) {
  const docs: FirestoreDoc[] = [];
  let pageToken: string | undefined;
  do {
    const page = await listDocs(collection, { pageSize: 300, pageToken });
    docs.push(...page.docs);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return docs;
}

export async function listSubjects(input: {
  search?: string;
  category?: string;
  family?: string;
  playlistId?: string;
}) {
  const docs = await listAllDocs("fact_subjects");
  let subjects = docs.map(toSubject);
  if (input.category) subjects = subjects.filter((s) => s.category === input.category);
  if (input.family) subjects = subjects.filter((s) => s.sub_category === input.family);
  if (input.playlistId) {
    subjects = subjects.filter((s) => s.playlist_ids.includes(input.playlistId!));
  }
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

async function assertNameNotTaken(key: string, kind: "topic" | "playlist") {
  const other = kind === "topic" ? await getDoc(`fact_playlists/${key}`) : await getDoc(`fact_subjects/${key}`);
  if (other) {
    throw new Error(
      kind === "topic"
        ? "A playlist already uses this name. Pick a different topic name."
        : "A topic already uses this name. Pick a different playlist name.",
    );
  }
}

export async function createSubject(input: {
  subject: string;
  category: string;
  sub_category?: string;
  aliases?: string[];
  playlist_ids?: string[];
}): Promise<SubjectRecord> {
  const subjectKey = normalizeKey(input.subject);
  if (!subjectKey) throw new Error("Topic name is required");
  if (await getDoc(`fact_subjects/${subjectKey}`)) throw new Error("A topic with this name already exists");
  await assertNameNotTaken(subjectKey, "topic");
  const playlist_ids = [...new Set(input.playlist_ids ?? [])];
  const created = toSubject(
    await createDoc("fact_subjects", subjectKey, {
      subject: input.subject.trim(),
      subject_key: subjectKey,
      category: input.category,
      ...(input.sub_category ? { sub_category: input.sub_category } : {}),
      aliases: input.aliases ?? [],
      playlist_ids: [],
      fact_count: 0,
      crawl_notes: "",
      createdAt: new Date().toISOString(),
    }),
  );
  if (!playlist_ids.length) return created;
  await syncTopicPlaylists(subjectKey, playlist_ids);
  const updated = await getDoc(`fact_subjects/${subjectKey}`);
  return updated ? toSubject(updated) : created;
}

export async function updateSubject(input: {
  id: string;
  category?: string;
  sub_category?: string;
  aliases?: string[];
  crawl_notes?: string;
  playlist_ids?: string[];
}): Promise<SubjectRecord> {
  const patch: Record<string, unknown> = {};
  if (input.category !== undefined) patch["category"] = input.category;
  if (input.sub_category !== undefined) patch["sub_category"] = input.sub_category;
  if (input.aliases !== undefined) patch["aliases"] = input.aliases;
  if (input.crawl_notes !== undefined) patch["crawl_notes"] = input.crawl_notes;
  if (Object.keys(patch).length > 0) await patchDoc(`fact_subjects/${input.id}`, patch);
  if (input.playlist_ids) await syncTopicPlaylists(input.id, input.playlist_ids);
  const updated = await getDoc(`fact_subjects/${input.id}`);
  if (!updated) throw new Error(`Topic ${input.id} not found`);
  return toSubject(updated);
}

export interface PlaylistRecord {
  id: string;
  name: string;
  aliases: string[];
  topic_keys: string[];
  createdAt: string | null;
  updatedAt: string | null;
}

function toPlaylist(doc: FirestoreDoc): PlaylistRecord {
  const d = doc.data;
  return {
    id: doc.id,
    name: str(d["name"]),
    aliases: strArray(d["aliases"]),
    topic_keys: strArray(d["topic_keys"]),
    createdAt: typeof d["createdAt"] === "string" ? d["createdAt"] : null,
    updatedAt: typeof d["updatedAt"] === "string" ? d["updatedAt"] : null,
  };
}

export async function listPlaylists() {
  const docs = await listAllDocs("fact_playlists");
  const playlists = docs.map(toPlaylist);
  playlists.sort((a, b) => a.name.localeCompare(b.name));
  return playlists;
}

async function syncTopicPlaylists(subjectKey: string, playlistIds: string[]) {
  const subject = await getDoc(`fact_subjects/${subjectKey}`);
  const prev = subject ? strArray(subject.data["playlist_ids"]) : [];
  const next = [...new Set(playlistIds)];
  if (subject) {
    await patchDoc(`fact_subjects/${subjectKey}`, { playlist_ids: next });
  }
  const add = next.filter((id) => !prev.includes(id));
  const remove = prev.filter((id) => !next.includes(id));
  const now = new Date().toISOString();
  for (const id of add) {
    const playlist = await getDoc(`fact_playlists/${id}`);
    if (!playlist) continue;
    const keys = strArray(playlist.data["topic_keys"]);
    if (!keys.includes(subjectKey)) {
      await patchDoc(`fact_playlists/${id}`, { topic_keys: [...keys, subjectKey], updatedAt: now });
    }
  }
  for (const id of remove) {
    const playlist = await getDoc(`fact_playlists/${id}`);
    if (!playlist) continue;
    await patchDoc(`fact_playlists/${id}`, {
      topic_keys: strArray(playlist.data["topic_keys"]).filter((key) => key !== subjectKey),
      updatedAt: now,
    });
  }
}

async function syncPlaylistTopics(playlistId: string, topicKeys: string[]) {
  const playlist = await getDoc(`fact_playlists/${playlistId}`);
  const prev = playlist ? strArray(playlist.data["topic_keys"]) : [];
  const next = [...new Set(topicKeys)];
  const now = new Date().toISOString();
  if (playlist) {
    await patchDoc(`fact_playlists/${playlistId}`, { topic_keys: next, updatedAt: now });
  }
  const add = next.filter((key) => !prev.includes(key));
  const remove = prev.filter((key) => !next.includes(key));
  for (const key of add) {
    const subject = await getDoc(`fact_subjects/${key}`);
    if (!subject) continue;
    const ids = strArray(subject.data["playlist_ids"]);
    if (!ids.includes(playlistId)) {
      await patchDoc(`fact_subjects/${key}`, { playlist_ids: [...ids, playlistId] });
    }
  }
  for (const key of remove) {
    const subject = await getDoc(`fact_subjects/${key}`);
    if (!subject) continue;
    await patchDoc(`fact_subjects/${key}`, {
      playlist_ids: strArray(subject.data["playlist_ids"]).filter((id) => id !== playlistId),
    });
  }
}

export async function createPlaylist(input: {
  name: string;
  aliases?: string[];
  topic_keys?: string[];
}): Promise<PlaylistRecord> {
  const playlistKey = normalizeKey(input.name);
  if (!playlistKey) throw new Error("Playlist name is required");
  if (await getDoc(`fact_playlists/${playlistKey}`)) throw new Error("A playlist with this name already exists");
  await assertNameNotTaken(playlistKey, "playlist");
  const topic_keys = [...new Set(input.topic_keys ?? [])];
  const now = new Date().toISOString();
  const created = toPlaylist(
    await createDoc("fact_playlists", playlistKey, {
      name: input.name.trim(),
      playlist_key: playlistKey,
      aliases: input.aliases ?? [],
      topic_keys: [],
      createdAt: now,
      updatedAt: now,
    }),
  );
  if (topic_keys.length) {
    await syncPlaylistTopics(playlistKey, topic_keys);
    const updated = await getDoc(`fact_playlists/${playlistKey}`);
    return updated ? toPlaylist(updated) : created;
  }
  return created;
}

export async function updatePlaylist(input: {
  id: string;
  name?: string;
  aliases?: string[];
  topic_keys?: string[];
}): Promise<PlaylistRecord> {
  const existing = await getDoc(`fact_playlists/${input.id}`);
  if (!existing) throw new Error(`Playlist ${input.id} not found`);
  const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (input.name !== undefined) patch["name"] = input.name;
  if (input.aliases !== undefined) patch["aliases"] = input.aliases;
  if (Object.keys(patch).length > 1) await patchDoc(`fact_playlists/${input.id}`, patch);
  if (input.topic_keys) await syncPlaylistTopics(input.id, input.topic_keys);
  const updated = await getDoc(`fact_playlists/${input.id}`);
  if (!updated) throw new Error(`Playlist ${input.id} not found`);
  return toPlaylist(updated);
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
}): Promise<{ items: CrawlRecord[]; expandedFrom: string | null }> {
  const playlists = await listPlaylists();
  const needle = input.subject.trim().toLowerCase();
  const playlist = playlists.find(
    (item) =>
      item.name.toLowerCase() === needle || item.aliases.some((alias) => alias.toLowerCase() === needle),
  );
  if (playlist?.topic_keys.length) {
    const items: CrawlRecord[] = [];
    for (const key of playlist.topic_keys) {
      const topic = await getDoc(`fact_subjects/${key}`);
      const name = topic ? str(topic.data["subject"]) || key : key;
      items.push(await enqueueOneTopic(name, input.priority, input.refresh));
    }
    return { items, expandedFrom: playlist.name };
  }
  return { items: [await enqueueOneTopic(input.subject, input.priority, input.refresh)], expandedFrom: null };
}

async function enqueueOneTopic(subject: string, priority: number, refresh: boolean): Promise<CrawlRecord> {
  const subjectKey = normalizeKey(subject);
  const payload = {
    subject,
    priority,
    status: "queued",
    requested_by: "manual",
    refresh,
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
    );

  // Group by lowercase email — one row per real person.
  // Players with no email are kept as individual rows.
  const byEmail = new Map<string, typeof players[number][]>();
  const noEmail: typeof players = [];
  for (const player of players) {
    const key = player.email.toLowerCase();
    if (!key) { noEmail.push(player); continue; }
    const group = byEmail.get(key) ?? [];
    group.push(player);
    byEmail.set(key, group);
  }

  const deduped: PlayerRecord[] = [];
  for (const group of byEmail.values()) {
    // Canonical UID: prefer any that already has isPremium, otherwise most-recent createdAt.
    const canonical =
      group.find((p) => p.isPremium) ??
      group.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0];
    deduped.push({ ...canonical, stats: null });
  }
  for (const p of noEmail) deduped.push(p);

  return deduped.slice(0, 50);
}

export async function getPlayer(id: string): Promise<PlayerRecord | null> {
  const doc = await getDoc(`users/${id}`);
  if (!doc) return null;
  const summary = await getDoc(`users/${id}/stats/summary`);
  const email = str(doc.data["email"]);

  // isPremium is authoritative from entitlements/{email}; fall back to the
  // legacy users/{uid}.isPremium field during the transition period.
  let isPremium = doc.data["isPremium"] === true;
  if (email) {
    const entitlement = await getDoc(`entitlements/${email.toLowerCase()}`);
    if (entitlement) isPremium = entitlement.data["isPremium"] === true;
  }

  return {
    id: doc.id,
    displayName: str(doc.data["displayName"]),
    email,
    isPremium,
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
  // Resolve the player's email to write to the canonical entitlements/{email} doc.
  const doc = await getDoc(`users/${input.id}`);
  const email = doc ? str(doc.data["email"]) : "";

  if (email) {
    await patchDoc(`entitlements/${email.toLowerCase()}`, {
      isPremium: input.isPremium,
      grantedAt: new Date().toISOString(),
      grantedBy: adminUser?.email ?? adminUser?.uid ?? "system",
    });
  } else {
    // No email on file — fall back to the legacy per-UID field.
    await patchDoc(`users/${input.id}`, { isPremium: input.isPremium, updatedAt: new Date().toISOString() });
  }

  if (adminUser) {
    const { logAdminAction } = await import("@/lib/firebase/audit.server");
    await logAdminAction(adminUser, {
      action: input.isPremium ? "player.grant_premium" : "player.revoke_premium",
      targetType: "user",
      targetId: email || input.id,
      details: `${input.isPremium ? "Granted" : "Revoked"} premium entitlement for ${email || input.id} (uid: ${input.id})`,
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
  blitz_ready: boolean;
}

export interface DailyPack {
  date: string;
  seed: string;
  category: string;
  rounds: Json[];
  createdAt: string | null;
  total_rounds: number;
}

export async function listDailyPacks(limit = 100): Promise<DailyPackSummary[]> {
  const { docs } = await listDocs("daily_packs", { pageSize: limit });
  const packs: DailyPackSummary[] = docs.map((doc) => {
    const total_rounds = Array.isArray(doc.data["rounds"])
      ? doc.data["rounds"].length
      : (num(doc.data["total_rounds"]) ?? 0);
    return {
      date: doc.id,
      category: str(doc.data["category"]) || "mixed",
      seed: str(doc.data["seed"]),
      total_rounds,
      createdAt: typeof doc.data["createdAt"] === "string" ? doc.data["createdAt"] : null,
      blitz_ready: total_rounds >= 15,
    };
  });
  packs.sort((a, b) => b.date.localeCompare(a.date));
  return packs;
}

/**
 * Retrieves a published daily pack for the specified date.
 *
 * @param date - The daily pack date
 * @returns The daily pack, or `null` if no pack exists for the date
 */
export async function getDailyPack(date: string): Promise<DailyPack | null> {
  const doc = await getDoc(`daily_packs/${date}`);
  if (!doc) return null;
  return {
    date,
    seed: str(doc.data["seed"]),
    category: str(doc.data["category"]),
    rounds: Array.isArray(doc.data["rounds"]) ? (doc.data["rounds"] as Json[]) : [],
    createdAt: typeof doc.data["createdAt"] === "string" ? doc.data["createdAt"] : null,
    total_rounds: Array.isArray(doc.data["rounds"])
      ? doc.data["rounds"].length
      : (num(doc.data["total_rounds"]) ?? 0),
  };
}

export interface DailyPackDraft {
  date: string;
  category: string;
  brief: string;
  rounds: Json[];
  status: "awaiting_review";
  source: string;
  draftedAt: string | null;
  total_rounds: number;
}

/**
 * Converts stored daily-pack draft data into a normalized draft record.
 *
 * @param date - The draft's calendar date
 * @param data - Stored draft fields
 * @returns A normalized daily-pack draft with default status, source, and round count
 */
function toDailyDraft(date: string, data: Record<string, Json>): DailyPackDraft {
  const rounds = Array.isArray(data["rounds"]) ? (data["rounds"] as Json[]) : [];
  return {
    date,
    category: str(data["category"]),
    brief: str(data["brief"]),
    rounds,
    status: "awaiting_review",
    source: str(data["source"]) || "strategist",
    draftedAt: typeof data["draftedAt"] === "string" ? data["draftedAt"] : null,
    total_rounds: rounds.length || (num(data["total_rounds"]) ?? 0),
  };
}

/**
 * Retrieves a daily-pack draft by date.
 *
 * @param date - The draft date
 * @returns The daily-pack draft, or `null` if no draft exists for the date
 */
export async function getDailyDraft(date: string): Promise<DailyPackDraft | null> {
  const doc = await getDoc(`daily_pack_drafts/${date}`);
  if (!doc) return null;
  return toDailyDraft(date, doc.data);
}

/**
 * Lists daily-pack drafts, ordered from newest to oldest date.
 *
 * @param limit - Maximum number of drafts to return
 * @returns The matching daily-pack drafts
 */
export async function listDailyDrafts(limit = 60): Promise<DailyPackDraft[]> {
  const { docs } = await listDocs("daily_pack_drafts", { pageSize: limit });
  const drafts = docs.map((doc) => toDailyDraft(doc.id, doc.data));
  drafts.sort((a, b) => b.date.localeCompare(a.date));
  return drafts;
}

/**
 * Creates or updates a daily-pack draft for review.
 *
 * @param input - The draft date, category, rounds, and optional brief and source metadata
 * @returns The stored daily-pack draft with review status and round count
 * @throws If a published daily pack already exists for the specified date
 */
export async function writeDailyDraft(input: {
  date: string;
  category: string;
  brief?: string;
  rounds: unknown[];
  source?: string;
}): Promise<DailyPackDraft> {
  // Validate and filter rounds for required fields
  const rawRounds = Array.isArray(input.rounds) ? input.rounds : [];
  const rounds = rawRounds.filter((r) => {
    if (!r || typeof r !== "object") return false;
    const round = r as Record<string, unknown>;
    // Require essential round fields: claim_statement, true_number, presented_number, unit
    if (typeof round["claim_statement"] !== "string" || !round["claim_statement"]) return false;
    if (typeof round["unit"] !== "string" || !round["unit"]) return false;
    // Ensure numeric fields are present (can be numbers or numeric strings)
    const trueNum = round["true_number"];
    const presentedNum = round["presented_number"];
    if (trueNum === null || trueNum === undefined || trueNum === "") return false;
    if (presentedNum === null || presentedNum === undefined || presentedNum === "") return false;
    // Validate round_number if present
    const roundNum = round["round_number"];
    if (roundNum !== undefined && roundNum !== null) {
      const n = Number(roundNum);
      if (!Number.isFinite(n) || n < 1) return false;
    }
    return true;
  });
  
  const payload = {
    date: input.date,
    category: input.category,
    brief: input.brief ?? "",
    rounds,
    status: "awaiting_review",
    source: input.source ?? "strategist",
    draftedAt: new Date().toISOString(),
    total_rounds: rounds.length,
  };
  await runTransaction(async (tx) => {
    const live = await tx.get(`daily_packs/${input.date}`);
    if (live) {
      throw new Error(
        `Live daily_packs/${input.date} already exists. Drafts cannot overwrite published packs.`,
      );
    }
    await tx.get(`daily_pack_drafts/${input.date}`);
    tx.set(`daily_pack_drafts/${input.date}`, payload);
  });
  return {
    date: input.date,
    category: input.category,
    brief: input.brief ?? "",
    rounds: rounds as Json[],
    status: "awaiting_review",
    source: input.source ?? "strategist",
    draftedAt: payload.draftedAt,
    total_rounds: rounds.length,
  };
}

/**
 * Deletes the published daily pack for a date.
 *
 * @param date - The daily pack date
 * @param adminUser - The administrator performing the deletion, if applicable
 * @returns An object indicating whether the deletion succeeded
 */
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

export async function generateDailyPackFromGoAgent(input: {
  topic: string;
  brief?: string;
  numRounds?: number;
  excludeAngles?: string[];
}) {
  const { generatePackViaGoAgent } = await import("./goagent.server");
  return generatePackViaGoAgent({
    topic: input.topic,
    guidance: input.brief,
    numRounds: input.numRounds,
    excludeAngles: input.excludeAngles,
  });
}

/**
 * Publishes a validated daily pack and removes any matching draft.
 *
 * @param input - The pack date, category, and rounds to publish.
 * @returns The scheduled daily pack.
 * @throws Error if the pack has no rounds or contains an incomplete round.
 */
export async function scheduleDailyPack(
  input: {
    date: string;
    category: string;
    rounds: unknown[];
  },
  adminUser?: AdminUser,
): Promise<DailyPack> {
  const { roundReadyToSchedule } = await import("./daily-blitz");
  if (!Array.isArray(input.rounds) || input.rounds.length === 0) {
    throw new Error("A Daily Blitz pack needs at least one complete round.");
  }
  const incomplete = input.rounds.findIndex((raw) => {
    const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    return !roundReadyToSchedule(rec);
  });
  if (incomplete >= 0) {
    throw new Error(
      `Round ${incomplete + 1} needs a claim, unit, explanation, and unequal true/presented numbers.`,
    );
  }

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

  await runTransaction(async (tx) => {
    await tx.get(`daily_packs/${input.date}`);
    const draftDoc = await tx.get(`daily_pack_drafts/${input.date}`);
    tx.set(`daily_packs/${input.date}`, payload);
    if (draftDoc) tx.delete(`daily_pack_drafts/${input.date}`);
  });

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
    total_rounds: input.rounds.length,
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

type ProductMode = "Classic" | "Cutthroat" | "Daily Blitz" | "Unknown";
type LobbyKind = "single" | "multiplayer";

interface ClassifiedGame {
  product: ProductMode;
  lobby: LobbyKind | null;
  label: string;
}

const DAILY_WIRES = new Set(["daily", "dailychallenge", "blitz", "blitz60s"]);
const CUTTHROAT_WIRES = new Set(["cutthroat"]);
const CLASSIC_WIRES = new Set([
  "standard",
  "standard3round",
  "versus",
  "versus1v1",
  "party",
  "partyroom",
]);
const MULTIPLAYER_WIRES = new Set(["versus", "versus1v1", "party", "partyroom"]);

function classifyGame(data: Record<string, Json>): ClassifiedGame {
  const wire = str(data["gameMode"]).toLowerCase();
  const ruleset = str(data["ruleset"]).toLowerCase();
  const source = str(data["matchSource"]).toLowerCase();

  let product: ProductMode = "Unknown";
  if (DAILY_WIRES.has(wire)) product = "Daily Blitz";
  else if (CUTTHROAT_WIRES.has(wire) || ruleset === "cutthroat") product = "Cutthroat";
  else if (
    CLASSIC_WIRES.has(wire) ||
    ruleset === "standard" ||
    ruleset === "party" ||
    ruleset === "blitz"
  ) {
    product = "Classic";
  }

  if (product === "Daily Blitz") {
    return { product, lobby: null, label: "Daily Blitz" };
  }
  if (product === "Unknown") {
    return { product, lobby: null, label: "Unknown" };
  }

  const lobby: LobbyKind =
    source === "party" || MULTIPLAYER_WIRES.has(wire) ? "multiplayer" : "single";
  return { product, lobby, label: `${product} (${lobby})` };
}

export async function getGameAnalytics(input: { since?: string }) {
  // game_history lives under users/{uid}/game_history/{id}. Collection-group
  // inequality / orderBy on playedAt need COLLECTION_GROUP field overrides.
  // Prefer a real windowed query; if the index is missing, sample without
  // filters so Overview / Analytics still render.
  const filters = input.since
    ? [{ field: "playedAt" as const, op: "GREATER_THAN_OR_EQUAL" as const, value: input.since }]
    : [];
  const newestFirst = { field: "playedAt" as const, direction: "DESCENDING" as const };

  async function load(
    orderBy?: { field: "playedAt"; direction: "ASCENDING" | "DESCENDING" },
    useFilters = true,
  ) {
    return runQuery({
      collection: "game_history",
      allDescendants: true,
      filters: useFilters ? filters : [],
      ...(orderBy ? { orderBy } : {}),
      limit: 500,
    });
  }

  const attempts: Array<{
    orderBy?: { field: "playedAt"; direction: "ASCENDING" | "DESCENDING" };
    useFilters: boolean;
    newestFirst: boolean;
  }> = [
    { orderBy: newestFirst, useFilters: true, newestFirst: true },
    { useFilters: true, newestFirst: false },
    { orderBy: newestFirst, useFilters: false, newestFirst: true },
    { useFilters: false, newestFirst: false },
  ];

  let docs: Awaited<ReturnType<typeof load>> = [];
  let orderedNewestFirst = false;
  let indexUnavailable = false;

  let loaded = false;
  for (const attempt of attempts) {
    try {
      docs = await load(attempt.orderBy, attempt.useFilters);
      orderedNewestFirst = attempt.newestFirst;
      indexUnavailable = !attempt.useFilters;
      if (!attempt.useFilters && input.since) {
        docs = docs.filter((doc) => str(doc.data["playedAt"]) >= input.since!);
      }
      loaded = true;
      break;
    } catch (error) {
      if (!isFirestoreIndexError(error)) throw error;
    }
  }

  if (!loaded) {
    docs = [];
    indexUnavailable = true;
  }

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

  const classified = docs.map((doc) => classifyGame(doc.data));

  const tallyClassified = (key: "product" | "label", include: (row: ClassifiedGame) => boolean) => {
    const counts = new Map<string, number>();
    for (const row of classified) {
      if (!include(row)) continue;
      const value = row[key];
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  };

  const tallyBool = (key: string, trueLabel: string, falseLabel: string) => {
    let yes = 0;
    let no = 0;
    for (const doc of docs) {
      if (doc.data[key] === true) yes += 1;
      else no += 1;
    }
    return [
      { name: trueLabel, count: yes },
      { name: falseLabel, count: no },
    ].filter((row) => row.count > 0);
  };

  return {
    total: docs.length,
    windowed: docs.length >= 500,
    orderedNewestFirst,
    indexUnavailable,
    byMode: tallyClassified("product", () => true),
    byLobby: tallyClassified("label", (row) => row.lobby !== null),
    byCategory: tally("category"),
    byVerified: tallyBool("verified", "verified", "unverified"),
  };
}
