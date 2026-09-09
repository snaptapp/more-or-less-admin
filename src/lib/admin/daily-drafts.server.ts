/**
 * Cron / admin fill of daily_pack_drafts. Never writes live daily_packs.
 * Unfilled live dates keep the Sports bank cycle until Save & Schedule.
 */
import { BLITZ_CATEGORIES, DAILY_BLITZ_ROUNDS, addUtcDays, utcToday } from "./daily-blitz";
import { generatePackViaGoAgent, goAgentConfigured } from "./goagent.server";
import { createDoc, getDoc } from "../firebase/firestore.server";

export const DEFAULT_DRAFT_LOOKAHEAD = 5;

/**
 * Generates consecutive UTC dates for a bounded lookahead period.
 *
 * @param lookahead - The number of dates to generate, limited to 1 through 14.
 * @param from - The UTC date from which to start.
 * @returns An array of consecutive UTC date strings.
 */
export function lookaheadDates(lookahead: number, from = utcToday()): string[] {
  const n = Math.min(14, Math.max(1, Math.round(lookahead) || 1));
  return Array.from({ length: n }, (_, i) => addUtcDays(from, i));
}

/**
 * Normalizes a draft lookahead value to an integer between 1 and 14 days.
 *
 * @param raw - The value to normalize
 * @returns The integer lookahead when valid; otherwise, the default draft lookahead
 */
export function clampLookahead(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 14) return DEFAULT_DRAFT_LOOKAHEAD;
  return n;
}

/**
 * Fills missing daily pack drafts for the requested date range.
 *
 * @param lookahead - The number of consecutive days to process.
 * @returns The dates with newly created drafts and the dates skipped with reasons.
 */
export async function fillUnfilledDailyDrafts(
  lookahead: number = DEFAULT_DRAFT_LOOKAHEAD,
): Promise<{ drafted: string[]; skipped: { date: string; reason: string }[] }> {
  const drafted: string[] = [];
  const skipped: { date: string; reason: string }[] = [];
  if (!goAgentConfigured()) {
    return {
      drafted,
      skipped: [{ date: "*", reason: "GO_AGENT_URL is not configured on the ops Worker." }],
    };
  }

  const dates = lookaheadDates(lookahead);
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const live = await getDoc(`daily_packs/${date}`);
    if (live) {
      skipped.push({ date, reason: `Live daily_packs/${date} already exists.` });
      continue;
    }
    const draft = await getDoc(`daily_pack_drafts/${date}`);
    if (draft) {
      skipped.push({ date, reason: `Draft daily_pack_drafts/${date} already exists.` });
      continue;
    }

    const category = BLITZ_CATEGORIES[i % BLITZ_CATEGORIES.length];
    const brief = `Autonomous Daily Blitz draft for ${date}. Genre rotation: ${category}. Mix 15 grounded rounds.`;
    try {
      const pack = await generatePackViaGoAgent({
        topic: category,
        guidance: brief,
        numRounds: DAILY_BLITZ_ROUNDS,
      });
      if (!pack.is_valid || pack.rounds.length === 0) {
        skipped.push({
          date,
          reason: pack.status_message || "Go agent returned no rounds.",
        });
        continue;
      }
      await createDoc("daily_pack_drafts", date, {
        date,
        category: pack.category || category,
        brief,
        rounds: pack.rounds,
        status: "awaiting_review",
        source: "cron",
        draftedAt: new Date().toISOString(),
        total_rounds: pack.rounds.length,
        published: false,
      });
      drafted.push(date);
    } catch (err) {
      skipped.push({
        date,
        reason: err instanceof Error ? err.message : "draft fill failed",
      });
    }
  }
  return { drafted, skipped };
}

/**
 * Validates an authorization header against the configured operations cron secret.
 *
 * @param authorization - The authorization header containing the bearer token
 * @returns `true` if the token matches the configured secret, `false` otherwise.
 */
export function cronSecretMatches(authorization: string | null): boolean {
  const expected = (process.env["OPS_CRON_SECRET"] ?? "").trim();
  if (!expected) return false;
  const provided = (authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!provided) return false;
  if (expected.length !== provided.length) return false;

  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return mismatch === 0;
}
