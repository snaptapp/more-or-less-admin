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

export function draftTargets(lookahead: number, from = utcToday()): string[] {
  const n = Math.min(14, Math.max(1, lookahead));
  const dates: string[] = [];
  for (let i = 0; i < n; i++) dates.push(addUtcDays(from, i));
  return dates;
}

export function rotateCategory(offset: number): string {
  const list = BLITZ_CATEGORIES.length ? BLITZ_CATEGORIES : [DAILY_BLITZ_FALLBACK_CATEGORY];
  return list[((offset % list.length) + list.length) % list.length];
}

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
