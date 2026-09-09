/**
 * Autonomous Daily Blitz drafts. Writes daily_pack_drafts only.
 * Live daily_packs still require Save & Schedule.
 */
import {
  BLITZ_CATEGORIES,
  DAILY_BLITZ_FALLBACK_CATEGORY,
  DAILY_BLITZ_ROUNDS,
  addUtcDays,
  utcToday,
} from "./daily-blitz";
import { generatePackViaGoAgent, goAgentConfigured } from "./goagent.server";
import { getDailyDraft, getDailyPack, writeDailyDraft } from "./ops.server";

/**
 * Generates UTC date strings for a bounded lookahead period.
 *
 * @param lookahead - The number of dates to generate, clamped to 1 through 14
 * @param from - The UTC date from which to start
 * @returns An array of consecutive UTC date strings
 */
export function draftTargets(lookahead: number, from = utcToday()): string[] {
  const n = Math.min(14, Math.max(1, lookahead));
  const dates: string[] = [];
  for (let i = 0; i < n; i++) dates.push(addUtcDays(from, i));
  return dates;
}

/**
 * Selects a Blitz category using a cyclic offset.
 *
 * @param offset - The category index offset, which may be negative
 * @returns The category at the normalized offset, or the fallback category when no categories are configured
 */
export function rotateCategory(offset: number): string {
  const list = BLITZ_CATEGORIES.length ? BLITZ_CATEGORIES : [DAILY_BLITZ_FALLBACK_CATEGORY];
  return list[((offset % list.length) + list.length) % list.length];
}

/**
 * Creates daily Blitz drafts for upcoming dates that have no live pack or pending draft.
 *
 * @param lookahead - The number of upcoming days to consider, clamped to the supported range.
 * @returns Drafted dates and dates skipped with the reason for each skip.
 */
export async function fillUnfilledDailyDrafts(lookahead = 5): Promise<{
  drafted: string[];
  skipped: Array<{ date: string; reason: string }>;
}> {
  const drafted: string[] = [];
  const skipped: Array<{ date: string; reason: string }> = [];
  if (!goAgentConfigured()) {
    return {
      drafted,
      skipped: [{ date: "*", reason: "GO_AGENT_URL is not configured on ops." }],
    };
  }

  const dates = draftTargets(lookahead);
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const live = await getDailyPack(date);
    if (live) {
      skipped.push({ date, reason: "live pack exists" });
      continue;
    }
    const existing = await getDailyDraft(date);
    if (existing) {
      skipped.push({ date, reason: "draft already awaiting review" });
      continue;
    }
    const category = rotateCategory(i);
    const brief = `Autonomous Daily Blitz draft for ${date}. Genre rotation: ${category}. Mix 15 grounded rounds.`;
    try {
      const pack = await generatePackViaGoAgent({
        topic: category,
        guidance: brief,
        numRounds: DAILY_BLITZ_ROUNDS,
      });
      await writeDailyDraft({
        date,
        category: pack.category || category,
        brief,
        rounds: pack.rounds,
        source: "cron",
      });
      drafted.push(date);
    } catch (err) {
      skipped.push({
        date,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { drafted, skipped };
}
