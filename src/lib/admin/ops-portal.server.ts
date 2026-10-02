/**
 * Ops Assistant surface for players, Daily Blitz, analytics, remote config,
 * the admin directory, and the audit log.
 *
 * Reads and writes call the same server functions as the admin pages.
 * Granting or revoking the admin claim is not on this surface.
 */

import type { AdminUser } from "@/lib/firebase/verify.server";
import { logAdminAction, listAuditLogs } from "@/lib/firebase/audit.server";
import {
  deleteDailyPack,
  findPlayers,
  flagQuestionTelemetry,
  generateDailyPackFromGoAgent,
  getDailyDraft,
  getDailyLeaderboard,
  getDailyPack,
  getGameAnalytics,
  getPlayer,
  listDailyDrafts,
  listDailyPacks,
  listQuestionTelemetry,
  removeDailyLeaderboardEntry,
  scheduleDailyPack,
  setPremium,
  type DailyPack,
  type DailyPackDraft,
} from "./ops.server";
import { fillUnfilledDailyDrafts } from "./daily-drafts.server";
import { listAuthUsers } from "./roles.server";
import {
  getTopicSuggestionsConfig,
  publishTopicSuggestionsConfig,
  type CustomParamEntry,
  type RemoteConfigPublishInput,
} from "@/lib/firebase/remote_config.server";

const OPS_ACTOR: AdminUser = {
  uid: "ops-assistant",
  email: "ops-assistant@snaptapp.us",
  name: "More-or-Less Ops Assistant",
  isClaimAdmin: false,
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WINDOWS = [7, 30, 90] as const;
type WindowDays = (typeof WINDOWS)[number];

export class PortalRequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "PortalRequestError";
    this.status = status;
  }
}

function checkedAt(): string {
  return new Date().toISOString();
}

function asRecord(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new PortalRequestError("JSON object body is required.");
  }
  return body as Record<string, unknown>;
}

function readDate(raw: unknown, field = "date"): string {
  if (typeof raw !== "string" || !DATE_RE.test(raw)) {
    throw new PortalRequestError(`${field} must be YYYY-MM-DD.`);
  }
  return raw;
}

function readRequiredString(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new PortalRequestError(`${field} is required.`);
  }
  return raw.trim();
}

function readOptionalString(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") throw new PortalRequestError("Expected a string.");
  return raw;
}

function readWindow(raw: unknown, fallback: WindowDays = 7): WindowDays {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (value === 7 || value === 30 || value === 90) return value;
  throw new PortalRequestError("days must be 7, 30, or 90.");
}

function sinceFor(days: WindowDays): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function summarizeRound(raw: unknown, index: number) {
  const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const claim =
    typeof rec["claim_statement"] === "string"
      ? rec["claim_statement"]
      : typeof rec["question"] === "string"
        ? rec["question"]
        : "";
  return {
    round_number: typeof rec["round_number"] === "number" ? rec["round_number"] : index + 1,
    topic: typeof rec["topic"] === "string" ? rec["topic"] : "",
    claim,
    true_number: typeof rec["true_number"] === "number" ? rec["true_number"] : null,
    presented_number: typeof rec["presented_number"] === "number" ? rec["presented_number"] : null,
    unit: typeof rec["unit"] === "string" ? rec["unit"] : "",
  };
}

function summarizeDraft(draft: DailyPackDraft) {
  return {
    date: draft.date,
    category: draft.category,
    status: draft.status,
    source: draft.source,
    brief: draft.brief,
    total_rounds: draft.total_rounds,
    draftedAt: draft.draftedAt,
    rounds: draft.rounds.map(summarizeRound),
  };
}

function summarizePack(pack: DailyPack) {
  return {
    date: pack.date,
    category: pack.category,
    seed: pack.seed,
    total_rounds: pack.total_rounds,
    blitz_ready: pack.total_rounds >= 15,
    createdAt: pack.createdAt,
    rounds: pack.rounds.map(summarizeRound),
  };
}

function summarizeEntry(raw: unknown) {
  const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    uid: typeof rec["uid"] === "string" ? rec["uid"] : "",
    displayName:
      typeof rec["displayName"] === "string"
        ? rec["displayName"]
        : typeof rec["name"] === "string"
          ? rec["name"]
          : "",
    score: typeof rec["score"] === "number" ? rec["score"] : null,
  };
}

export async function opsPlayersSearch(search?: string) {
  const items = await findPlayers({ search });
  return { count: items.length, truncated: items.length >= 50, checked_at: checkedAt(), items };
}

export async function opsPlayersPlayer(id: string) {
  const playerId = readRequiredString(id, "id");
  const player = await getPlayer(playerId);
  if (!player) throw new PortalRequestError("Player not found.", 404);
  return { checked_at: checkedAt(), player };
}

export async function opsPlayersPremium(body: unknown) {
  const raw = asRecord(body);
  const id = readRequiredString(raw["id"], "id");
  if (typeof raw["isPremium"] !== "boolean") {
    throw new PortalRequestError("isPremium must be true or false.");
  }
  const result = await setPremium({ id, isPremium: raw["isPremium"] }, OPS_ACTOR);
  return { ...result, id, isPremium: raw["isPremium"] };
}

export async function opsDailySchedule() {
  const [packs, drafts] = await Promise.all([listDailyPacks(100), listDailyDrafts(60)]);
  return {
    pack_count: packs.length,
    draft_count: drafts.length,
    checked_at: checkedAt(),
    packs,
    drafts: drafts.map((draft) => ({
      date: draft.date,
      category: draft.category,
      status: draft.status,
      source: draft.source,
      total_rounds: draft.total_rounds,
      draftedAt: draft.draftedAt,
    })),
  };
}

export async function opsDailyDay(date: string) {
  const day = readDate(date);
  const [pack, leaderboard, draft] = await Promise.all([
    getDailyPack(day),
    getDailyLeaderboard(day),
    getDailyDraft(day).catch(() => null),
  ]);
  const entries = Array.isArray(leaderboard.entries) ? leaderboard.entries.map(summarizeEntry) : [];
  return {
    date: day,
    checked_at: checkedAt(),
    pack: pack ? summarizePack(pack) : null,
    draft: draft ? summarizeDraft(draft) : null,
    leaderboard: { count: entries.length, entries },
  };
}

export async function opsDailyDelete(body: unknown) {
  const raw = asRecord(body);
  const date = readDate(raw["date"]);
  return deleteDailyPack(date, OPS_ACTOR);
}

export async function opsDailyRemoveScore(body: unknown) {
  const raw = asRecord(body);
  const date = readDate(raw["date"]);
  const uid = readRequiredString(raw["uid"], "uid");
  const reason = readOptionalString(raw["reason"]) ?? "Administrative removal | via Ops Assistant";
  return removeDailyLeaderboardEntry({ date, uid, reason }, OPS_ACTOR);
}

export async function opsDailyFill(body: unknown) {
  const raw = asRecord(body);
  const lookahead = raw["lookahead"];
  let days = 5;
  if (lookahead !== undefined && lookahead !== null && lookahead !== "") {
    const value = typeof lookahead === "number" ? lookahead : Number(lookahead);
    if (!Number.isInteger(value) || value < 1 || value > 14) {
      throw new PortalRequestError("lookahead must be an integer from 1 to 14.");
    }
    days = value;
  }
  return fillUnfilledDailyDrafts(days);
}

export async function opsDailyGenerate(body: unknown) {
  const raw = asRecord(body);
  const topic = readRequiredString(raw["topic"], "topic");
  const brief = readOptionalString(raw["brief"]);
  let numRounds: number | undefined;
  if (raw["numRounds"] !== undefined && raw["numRounds"] !== null && raw["numRounds"] !== "") {
    const value = typeof raw["numRounds"] === "number" ? raw["numRounds"] : Number(raw["numRounds"]);
    if (!Number.isInteger(value) || value < 1 || value > 15) {
      throw new PortalRequestError("numRounds must be an integer from 1 to 15.");
    }
    numRounds = value;
  }
  const excludeRaw = raw["excludeAngles"];
  let excludeAngles: string[] | undefined;
  if (excludeRaw !== undefined && excludeRaw !== null) {
    if (!Array.isArray(excludeRaw) || excludeRaw.some((item) => typeof item !== "string")) {
      throw new PortalRequestError("excludeAngles must be an array of strings.");
    }
    excludeAngles = excludeRaw;
  }
  return generateDailyPackFromGoAgent({ topic, brief, numRounds, excludeAngles });
}

export async function opsDailyPublish(body: unknown) {
  const raw = asRecord(body);
  const date = readDate(raw["date"]);
  const category = readRequiredString(raw["category"], "category");
  if (!Array.isArray(raw["rounds"]) || raw["rounds"].length === 0) {
    throw new PortalRequestError("rounds must be a non-empty array.");
  }
  try {
    const pack = await scheduleDailyPack({ date, category, rounds: raw["rounds"] }, OPS_ACTOR);
    return {
      ok: true as const,
      date: pack.date,
      category: pack.category,
      total_rounds: pack.total_rounds,
      seed: pack.seed,
    };
  } catch (error) {
    if (error instanceof PortalRequestError) throw error;
    if (
      error instanceof Error &&
      /needs a claim|at least one complete round|cannot overwrite/i.test(error.message)
    ) {
      throw new PortalRequestError(error.message);
    }
    throw error;
  }
}

export async function opsAnalyticsGames(daysRaw?: string) {
  const days = readWindow(daysRaw);
  const summary = await getGameAnalytics({ since: sinceFor(days) });
  return { days, since: sinceFor(days), checked_at: checkedAt(), ...summary };
}

export async function opsAnalyticsQuestions(input: { days?: string; kind?: string; search?: string }) {
  const days = readWindow(input.days);
  const kind = input.kind?.trim() ?? "";
  if (kind && kind !== "fact" && kind !== "generated") {
    throw new PortalRequestError("kind must be fact or generated.");
  }
  const items = await listQuestionTelemetry({
    days,
    kind: kind === "fact" || kind === "generated" ? kind : undefined,
    search: input.search,
  });
  return { days, count: items.length, checked_at: checkedAt(), items };
}

export async function opsAnalyticsFlag(body: unknown) {
  const raw = asRecord(body);
  const days = readWindow(raw["days"], 7);
  const questionId = readRequiredString(raw["questionId"], "questionId");
  const result = await flagQuestionTelemetry({ days, questionId }, OPS_ACTOR);
  await logAdminAction(OPS_ACTOR, {
    action: "telemetry.flag_for_review",
    targetType: "report",
    targetId: result.reportId,
    details: `Flagged ${questionId} from ${days}-day signed telemetry | via Ops Assistant`,
  });
  return result;
}

function readStringArray(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((item) => typeof item !== "string" || !item.trim())) {
    throw new PortalRequestError(`${field} must be a non-empty array of strings.`);
  }
  return raw.map((item) => item.trim());
}

function readPublishInput(body: unknown): { etag: string; input: RemoteConfigPublishInput } {
  const raw = asRecord(body);
  const etag = readRequiredString(raw["etag"], "etag");
  const defaultTopics = readStringArray(raw["defaultTopics"], "defaultTopics");
  if (!Array.isArray(raw["variants"])) {
    throw new PortalRequestError("variants must be an array. Resend the variants from config_read.");
  }
  const seen = new Set<string>();
  const variants = raw["variants"].map((item, index) => {
    const variant = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const conditionName = readRequiredString(variant["conditionName"], `variants[${index}].conditionName`);
    if (seen.has(conditionName)) {
      throw new PortalRequestError("Condition names must be unique.");
    }
    seen.add(conditionName);
    return {
      conditionName,
      expression: readRequiredString(variant["expression"], `variants[${index}].expression`),
      tagColor: readOptionalString(variant["tagColor"]),
      topics: readStringArray(variant["topics"], `variants[${index}].topics`),
    };
  });
  const input: RemoteConfigPublishInput = { defaultTopics, variants };
  if (raw["enableInterstitialAds"] !== undefined) {
    if (typeof raw["enableInterstitialAds"] !== "boolean") {
      throw new PortalRequestError("enableInterstitialAds must be a boolean.");
    }
    input.enableInterstitialAds = raw["enableInterstitialAds"];
  }
  if (raw["interstitialAdFrequency"] !== undefined) {
    const value = raw["interstitialAdFrequency"];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 50) {
      throw new PortalRequestError("interstitialAdFrequency must be an integer from 1 to 50.");
    }
    input.interstitialAdFrequency = value;
  }
  if (raw["enableRewardedAds"] !== undefined) {
    if (typeof raw["enableRewardedAds"] !== "boolean") {
      throw new PortalRequestError("enableRewardedAds must be a boolean.");
    }
    input.enableRewardedAds = raw["enableRewardedAds"];
  }
  if (raw["enableBannerAds"] !== undefined) {
    if (typeof raw["enableBannerAds"] !== "boolean") {
      throw new PortalRequestError("enableBannerAds must be a boolean.");
    }
    input.enableBannerAds = raw["enableBannerAds"];
  }
  if (raw["allowedEmails"] !== undefined) {
    if (!Array.isArray(raw["allowedEmails"]) || raw["allowedEmails"].some((item) => typeof item !== "string")) {
      throw new PortalRequestError("allowedEmails must be an array of strings.");
    }
    input.allowedEmails = raw["allowedEmails"];
  }
  if (raw["customParameters"] !== undefined) {
    if (!raw["customParameters"] || typeof raw["customParameters"] !== "object" || Array.isArray(raw["customParameters"])) {
      throw new PortalRequestError("customParameters must be an object.");
    }
    const customParameters: Record<string, CustomParamEntry> = {};
    for (const [key, value] of Object.entries(raw["customParameters"] as Record<string, unknown>)) {
      const entry = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
      if (!entry || typeof entry["value"] !== "string") {
        throw new PortalRequestError(`customParameters.${key}.value must be a string.`);
      }
      const valueType = entry["valueType"];
      if (
        valueType !== undefined &&
        valueType !== "STRING" &&
        valueType !== "BOOLEAN" &&
        valueType !== "NUMBER" &&
        valueType !== "JSON"
      ) {
        throw new PortalRequestError(`customParameters.${key}.valueType is invalid.`);
      }
      customParameters[key] = {
        value: entry["value"],
        ...(valueType ? { valueType } : {}),
        ...(typeof entry["description"] === "string" ? { description: entry["description"] } : {}),
      };
    }
    input.customParameters = customParameters;
  }
  return { etag, input };
}

export async function opsConfigRead() {
  const config = await getTopicSuggestionsConfig();
  return { checked_at: checkedAt(), config };
}

export async function opsConfigPublish(body: unknown) {
  const { etag, input } = readPublishInput(body);
  const updated = await publishTopicSuggestionsConfig(input, etag, OPS_ACTOR.email ?? OPS_ACTOR.uid);
  await logAdminAction(OPS_ACTOR, {
    action: "update_remote_config_topics",
    targetType: "system",
    targetId: "custom_topic_suggestions",
    details: `${OPS_ACTOR.email} published Remote Config (${input.defaultTopics.length} default topics, ${input.variants.length} variant rules) | via Ops Assistant`,
    after: {
      defaultTopics: input.defaultTopics,
      variants: input.variants,
      versionNumber: updated.versionNumber,
    },
  });
  return { ok: true as const, config: updated };
}

export async function opsRolesList(search?: string) {
  const users = await listAuthUsers();
  const admins = users.filter((user) => user.isAdmin);
  const term = search?.trim().toLowerCase() ?? "";
  const matches = term
    ? users
        .filter((user) => `${user.email ?? ""} ${user.displayName ?? ""} ${user.uid}`.toLowerCase().includes(term))
        .slice(0, 50)
    : [];
  return {
    admin_count: admins.length,
    total_accounts: users.length,
    checked_at: checkedAt(),
    admins,
    matches,
  };
}

export async function opsAuditLog(input: { limit?: string; action?: string; targetId?: string }) {
  let limit = 40;
  if (input.limit !== undefined && input.limit !== "") {
    const value = Number(input.limit);
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      throw new PortalRequestError("limit must be an integer from 1 to 100.");
    }
    limit = value;
  }
  const action = input.action?.trim().toLowerCase() ?? "";
  const targetId = input.targetId?.trim() ?? "";
  const rows = await listAuditLogs(100);
  const filtered = rows.filter((row) => {
    if (action && !row.action.toLowerCase().includes(action)) return false;
    if (targetId && row.targetId !== targetId) return false;
    return true;
  });
  const items = filtered.slice(0, limit);
  return { count: items.length, scanned: rows.length, checked_at: checkedAt(), items };
}
