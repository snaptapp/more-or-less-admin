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
import { sanitizeDraftRounds } from "./daily-blitz";
import { STATUS } from "./contract";
import { GENRES, validateTaxonomy } from "./taxonomy";

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
  const taxonomyErr = validateTaxonomy(input.category, input.sub_category, input.subject);
  if (taxonomyErr) throw new Error(taxonomyErr);
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
  const existing = await getDoc(`fact_subjects/${input.id}`);
  if (!existing) throw new Error(`Topic ${input.id} not found`);
  const effectiveCat = input.category ?? str(existing.data["category"]);
  const effectiveSubCat = input.sub_category !== undefined ? input.sub_category : str(existing.data["sub_category"]);
  const effectiveSubject = str(existing.data["subject"]);
  const taxonomyErr = validateTaxonomy(effectiveCat, effectiveSubCat, effectiveSubject);
  if (taxonomyErr) throw new Error(taxonomyErr);

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

const DEFAULT_CRAWL_PRIORITY = 5;
const MAX_CRAWL_SUBJECT_LENGTH = 64;
const CRAWL_REQUESTED_BY = new Set(["cron", "report", "demand", "manual", "strategist"]);

export type EnqueueDecision = "insert" | "requeue" | "skip";

export interface EnqueueResult {
  subject: string;
  subjectKey: string;
  action: "inserted" | "requeued" | "skipped";
  reason?: string;
}

export interface EnqueueSubjectInput {
  subject: string;
  priority?: number;
  refresh?: boolean;
  category?: string;
  requestedBy?: string;
}

interface EnqueueExecution {
  result: EnqueueResult;
  record: CrawlRecord;
}

function isActiveLease(existing: Record<string, unknown>, now: Date): boolean {
  const raw = existing["claim_expires_at"];
  let expiresAt: number;
  if (raw instanceof Date) {
    expiresAt = raw.getTime();
  } else if (typeof raw === "string") {
    expiresAt = Date.parse(raw);
  } else {
    return false;
  }
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

/** Mirrors the Go queue decision table, including an invalid/expired lease. */
export function decideEnqueueAction(
  existing: Record<string, unknown> | null | undefined,
  now = new Date(),
): EnqueueDecision {
  if (!existing) return "insert";
  const status = typeof existing["status"] === "string" ? existing["status"] : "";
  switch (status) {
    case "processing":
      return isActiveLease(existing, now) ? "skip" : "requeue";
    case "completed":
    case "done":
      return "requeue";
    case "queued":
      return "skip";
    default:
      return "requeue";
  }
}

function categoryMatchKey(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/ & /g, " and ");
}

function canonicalCategory(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  const key = categoryMatchKey(trimmed);
  const match = GENRES.find((candidate) => categoryMatchKey(candidate) === key);
  if (!match) {
    throw new Error(`invalid category ${JSON.stringify(value)} (must be one of CanonicalCategories)`);
  }
  return match;
}

function canonicalRequestedBy(value: string | undefined): string {
  const requestedBy = value?.trim().toLowerCase() || "manual";
  if (!CRAWL_REQUESTED_BY.has(requestedBy)) {
    throw new Error(`invalid requested_by ${JSON.stringify(value)}`);
  }
  return requestedBy;
}

function existingPriority(existing: Record<string, Json> | null): number {
  const value = existing?.["priority"];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function claimReset(existing: Record<string, Json> | null): Record<string, Json> {
  const reset: Record<string, Json> = {
    claim_token: null,
    claiming_agent: null,
    claim_expires_at: null,
  };
  if (existing && "claimed_by" in existing) reset["claimed_by"] = null;
  if (existing && "claimed_at" in existing) reset["claimed_at"] = null;
  return reset;
}

function toCrawlData(id: string, data: Record<string, Json>): CrawlRecord {
  return toCrawl({ id, path: `crawl_queue/${id}`, data });
}

function shouldUpgradeQueued(
  existing: Record<string, Json>,
  isBanked: boolean,
  priority: number,
  requestedRefresh: boolean,
): boolean {
  const refresh = existing["refresh"] === true;
  return (
    (isBanked && !refresh) ||
    priority > existingPriority(existing) ||
    (requestedRefresh && !refresh)
  );
}

function queueResult(
  subject: string,
  subjectKey: string,
  action: EnqueueResult["action"],
  reason?: string,
): EnqueueResult {
  return {
    subject,
    subjectKey,
    action,
    ...(reason ? { reason } : {}),
  };
}

async function enqueueSubjectInternal(input: EnqueueSubjectInput): Promise<EnqueueExecution> {
  const subject = input.subject.trim();
  if (!subject) throw new Error("subject is required");
  if (subject.length > MAX_CRAWL_SUBJECT_LENGTH) {
    throw new Error(`subject exceeds ${MAX_CRAWL_SUBJECT_LENGTH} characters`);
  }
  const subjectKey = normalizeKey(subject);
  if (!subjectKey) throw new Error("normalized subject key is empty");

  const category = canonicalCategory(input.category);
  const taxonomyError = validateTaxonomy(category, "", subject);
  if (taxonomyError) throw new Error(taxonomyError);
  const requestedBy = canonicalRequestedBy(input.requestedBy);
  const priority =
    typeof input.priority === "number" && input.priority > 0 ? input.priority : DEFAULT_CRAWL_PRIORITY;
  const requestedRefresh = input.refresh === true;
  const now = new Date();
  const nowIso = now.toISOString();
  const subjectPath = `fact_subjects/${subjectKey}`;
  const queuePath = `crawl_queue/${subjectKey}`;

  return runTransaction(async (tx) => {
    // Every read is deliberately completed before the first write. runTransaction
    // reruns this whole callback after contention, so the decision is never based
    // on a stale pre-read snapshot.
    const subjectDoc = await tx.get(subjectPath);
    const queueDoc = await tx.get(queuePath);
    const isBanked = subjectDoc !== null;
    const existing = queueDoc?.data ?? null;
    const decision = decideEnqueueAction(existing, now);

    if (decision === "skip") {
      if (existing?.["status"] === "queued" && shouldUpgradeQueued(existing, isBanked, priority, requestedRefresh)) {
        const upgrades: Record<string, Json> = {
          requested_by: requestedBy,
          updated_at: nowIso,
        };
        if (isBanked || requestedRefresh) upgrades["refresh"] = true;
        if (priority > existingPriority(existing)) upgrades["priority"] = priority;
        if (category) upgrades["category"] = category;
        tx.update(queuePath, upgrades);
        const data = { ...existing, ...upgrades };
        return {
          result: queueResult(subject, subjectKey, "requeued"),
          record: toCrawlData(subjectKey, data),
        };
      }
      return {
        result: queueResult(subject, subjectKey, "skipped", "already queued or actively processing"),
        record: toCrawlData(subjectKey, existing ?? {}),
      };
    }

    const effectivePriority = Math.max(priority, existingPriority(existing));
    const effectiveRefresh = isBanked || requestedRefresh || existing?.["refresh"] === true;
    const payload: Record<string, Json> = {
      subject,
      subject_key: subjectKey,
      priority: effectivePriority,
      status: "queued",
      refresh: effectiveRefresh,
      requested_by: requestedBy,
      enqueued_at: nowIso,
      updated_at: nowIso,
      completed_at: null,
      ...claimReset(existing),
    };
    if (category) payload["category"] = category;

    if (decision === "insert") {
      tx.set(queuePath, payload);
      return {
        result: queueResult(subject, subjectKey, "inserted"),
        record: toCrawlData(subjectKey, payload),
      };
    }

    tx.update(queuePath, payload);
    return {
      result: queueResult(subject, subjectKey, "requeued"),
      record: toCrawlData(subjectKey, { ...(existing ?? {}), ...payload }),
    };
  });
}

/** Enqueue one subject using the Go queue decision table inside one transaction. */
export async function enqueueSubject(input: EnqueueSubjectInput): Promise<EnqueueResult> {
  return (await enqueueSubjectInternal(input)).result;
}

export async function enqueueCrawl(input: {
  subject: string;
  priority: number;
  refresh: boolean;
  category?: string;
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
      const category = input.category ?? (topic ? str(topic.data["category"]) : "");
      items.push((await enqueueSubjectInternal({
        subject: name,
        priority: input.priority,
        refresh: input.refresh,
        category,
      })).record);
    }
    return { items, expandedFrom: playlist.name };
  }
  return {
    items: [(await enqueueSubjectInternal({
      subject: input.subject,
      priority: input.priority,
      refresh: input.refresh,
      category: input.category,
    })).record],
    expandedFrom: null,
  };
}

export async function setCrawlPriority(input: {
  id: string;
  priority: number;
}): Promise<CrawlRecord> {
  return toCrawl(await patchDoc(`crawl_queue/${input.id}`, { priority: input.priority }));
}

const FOUNDRY_REPOSITORY = "snaptapp/more-or-less";
const FOUNDRY_WORKFLOW = "fact-foundry.yml";
const FOUNDRY_REF = "main";
const FOUNDRY_INPUTS = {
  subjects: "",
  refresh_stale_days: "0",
  facts_per_subject: "8",
} as const;

export interface FoundryDispatchResult {
  configured: boolean;
  ok: boolean;
  message: string;
}

function foundryToken(): string | null {
  return (process.env["GITHUB_TOKEN"] || process.env["GH_TOKEN"] || "").trim() || null;
}

export async function getFoundryDispatchStatus(): Promise<{ configured: boolean }> {
  return { configured: foundryToken() !== null };
}

export async function triggerFoundryWorkflow(adminUser?: AdminUser): Promise<FoundryDispatchResult> {
  const token = foundryToken();

  if (!token) {
    return {
      configured: false,
      ok: false,
      message: "On-demand dispatch is not configured. Topics remain queued for nightly hydration.",
    };
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${FOUNDRY_REPOSITORY}/actions/workflows/${FOUNDRY_WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "more-or-less-admin",
        },
        body: JSON.stringify({ ref: FOUNDRY_REF, inputs: FOUNDRY_INPUTS }),
      },
    );

    if (!res.ok) {
      const errText = await res.text();
      return {
        configured: true,
        ok: false,
        message: `GitHub Action dispatch failed (${res.status}): ${errText.slice(0, 200)}`,
      };
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

    return {
      configured: true,
      ok: true,
      message: "Fact Foundry workflow triggered successfully on GitHub Actions.",
    };
  } catch (err: unknown) {
    return {
      configured: true,
      ok: false,
      message: err instanceof Error ? err.message : "Failed to trigger GitHub Action",
    };
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
 * @throws If no round survives schema validation
 */
export async function writeDailyDraft(input: {
  date: string;
  category: string;
  brief?: string;
  rounds: unknown[];
  source?: string;
}): Promise<DailyPackDraft> {
  const rounds = sanitizeDraftRounds(
    Array.isArray(input.rounds) ? input.rounds : [],
    input.category,
  );
  if (!rounds.length) {
    throw new Error("A daily draft needs at least one complete round.");
  }
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
    rounds: rounds as unknown as Json[],
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

export interface QuestionTelemetryRecord {
  id: string;
  questionId: string;
  kind: "fact" | "generated";
  claim: string;
  topic: string;
  category: string;
  unit: string;
  attempts: number;
  correct: number;
  skipped: number;
  answered: number;
  accuracy: number;
  skipRate: number;
  lastSeenAt: string | null;
}

export async function listQuestionTelemetry(input: { days: 7 | 30 | 90; kind?: "fact" | "generated"; search?: string }) {
  // Page through the full collection before ranking: listDocs returns a
  // nextPageToken past the first page and the default order is by document
  // name, so ranking only the first page would hide worse questions on later
  // pages (and could report "no actionable telemetry" incorrectly).
  const docs = await listAllDocs(`round_analytics_${input.days}d`);
  const term = input.search?.trim().toLowerCase() ?? "";
  return docs.map((doc): QuestionTelemetryRecord => toTelemetryRecord(doc)).filter((row) => row.answered >= 20 && (!input.kind || row.kind === input.kind) && (!term || `${row.questionId} ${row.claim} ${row.topic}`.toLowerCase().includes(term)))
    .sort((a, b) => a.accuracy - b.accuracy || b.answered - a.answered).slice(0, 100);
}

function telemetryReportId(questionId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < questionId.length; i++) { hash ^= questionId.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  return `telemetry_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function parseTelemetryFactId(questionId: string): string | null {
  if (!questionId.startsWith("fact:")) return null;
  const docId = questionId.slice("fact:".length).trim();
  return docId || null;
}

function toTelemetryRecord(doc: FirestoreDoc): QuestionTelemetryRecord {
  const attempts = num(doc.data["attempts"]) ?? 0;
  const correct = num(doc.data["correct"]) ?? 0;
  const skipped = num(doc.data["skipped"]) ?? 0;
  const answered = Math.max(0, attempts - skipped);
  return {
    id: doc.id, questionId: str(doc.data["questionId"]), kind: str(doc.data["kind"]) === "fact" ? "fact" : "generated",
    claim: str(doc.data["claimStatement"]), topic: str(doc.data["topic"]), category: str(doc.data["category"]), unit: str(doc.data["unit"]),
    attempts, correct, skipped, answered, accuracy: answered ? correct / answered : 0, skipRate: attempts ? skipped / attempts : 0,
    lastSeenAt: typeof doc.data["lastSeenAt"] === "string" ? doc.data["lastSeenAt"] : null,
  };
}

export async function flagQuestionTelemetry(input: { days: 7 | 30 | 90; questionId: string }, admin: AdminUser) {
  const reportId = telemetryReportId(input.questionId);
  const existing = await getDoc(`trivia_reports/${reportId}`);
  if (existing) return { reportId, alreadyReviewed: existing.data["status"] !== "pending_review" };

  // Load the telemetry row so the moderation inbox gets an actionable
  // report (topic/claim/unit/fact id). Without this, findFactForReport sees
  // an empty topic, returns null, and the inbox only offers AI-claim actions.
  let telemetry: QuestionTelemetryRecord | null = null;
  try {
    const matches = await runQuery({
      collection: `round_analytics_${input.days}d`,
      filters: [{ field: "questionId", op: "EQUAL", value: input.questionId }],
      limit: 1,
    });
    if (matches[0]) telemetry = toTelemetryRecord(matches[0]);
  } catch {
    telemetry = null;
  }

  const factId = parseTelemetryFactId(input.questionId);
  let factPreviousStatus: string | null = null;
  if (factId) {
    const factDoc = await getDoc(`fact_bank/${factId}`);
    if (factDoc) {
      const currentStatus = typeof factDoc.data["status"] === "string" ? factDoc.data["status"] : "";
      factPreviousStatus = currentStatus || null;
      // Only transition active facts to disputed. Never overwrite an
      // already-disputed or retired fact with stale telemetry.
      if (currentStatus === STATUS.active) {
        await patchDoc(`fact_bank/${factId}`, { status: STATUS.disputed, disputedAt: new Date().toISOString() });
      }
    }
  }
  await createDoc("trivia_reports", reportId, {
    status: "pending_review", reportSource: "round_telemetry", questionId: input.questionId,
    ...(factId ? { factId } : {}),
    ...(factPreviousStatus ? { factPreviousStatus } : {}),
    topic: telemetry?.topic ?? "", claimStatement: telemetry?.claim ?? "", unit: telemetry?.unit ?? "",
    category: telemetry?.category ?? "", kind: telemetry?.kind ?? "",
    telemetryDays: input.days, telemetryAnswered: telemetry?.answered ?? 0,
    telemetryAccuracy: telemetry?.accuracy ?? 0,
    reason: `Low player accuracy in ${input.days}-day signed self-reported telemetry`, createdAt: new Date().toISOString(),
  });
  return { reportId, alreadyReviewed: false };
}
