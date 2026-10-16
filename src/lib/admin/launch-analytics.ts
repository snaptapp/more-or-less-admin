/**
 * Launch-mode results (Solitaire, Arena, Octagon) for Admin analytics and player views.
 *
 * Results live at `users/{uid}/launch_history/{id}` and per-mode aggregates at
 * `users/{uid}/launch_stats/{mode}`; both are written only by Functions in
 * snaptapp/more-or-less (`recordLaunchEvent`, `recordSolitaireRun`). Arena and
 * Octagon rows are server-verified; Solitaire rows are self-reported. Admin reads
 * these collections and never writes them.
 */

export const LAUNCH_MODE_IDS = ["solitaire", "arena", "octagon"] as const;
export type LaunchModeId = (typeof LAUNCH_MODE_IDS)[number];

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface LaunchHistoryDoc {
  id: string;
  path: string;
  data: Record<string, Json>;
}

export interface LaunchRun {
  id: string;
  uid: string;
  mode: LaunchModeId;
  eventId: string | null;
  startedAt: number;
  score: number;
  rank: number | null;
  humanCount: number | null;
  ranked: boolean;
  verified: boolean;
  outcome: string;
  win: boolean;
}

export interface LaunchModeSummary {
  mode: LaunchModeId;
  runs: number;
  players: number;
  rankedRuns: number;
  wins: number;
  averageScore: number | null;
  events: number;
}

function num(value: Json | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isLaunchMode(value: Json | undefined): value is LaunchModeId {
  return typeof value === "string" && (LAUNCH_MODE_IDS as readonly string[]).includes(value);
}

/** The owner uid is the path segment after `users/`; documents elsewhere are rejected. */
export function ownerOf(path: string): string | null {
  const parts = path.split("/");
  const at = parts.indexOf("users");
  return at >= 0 && parts[at + 2] === "launch_history" && parts[at + 1] ? parts[at + 1] : null;
}

/**
 * Mirrors `competitiveWin` in functions/src/launch_results.ts: only ranked
 * events count, Arena by rank 1 and Octagon by a (tied) win outcome.
 */
export function isCompetitiveWin(run: Pick<LaunchRun, "mode" | "ranked" | "rank" | "outcome">): boolean {
  if (!run.ranked) return false;
  if (run.mode === "arena") return run.rank === 1;
  if (run.mode === "octagon") return run.outcome === "win" || run.outcome === "tied_win";
  return false;
}

/** Parses one stored result, or null when it is not a well-formed launch row. */
export function toLaunchRun(doc: LaunchHistoryDoc): LaunchRun | null {
  const uid = ownerOf(doc.path);
  const mode = doc.data["mode"];
  const startedAt = num(doc.data["startedAt"]);
  const score = num(doc.data["score"]);
  if (!uid || !isLaunchMode(mode) || startedAt === null || score === null) return null;
  const eventId = typeof doc.data["eventId"] === "string" ? doc.data["eventId"] : null;
  const run = {
    id: doc.id,
    uid,
    mode,
    eventId,
    startedAt,
    score,
    rank: num(doc.data["rank"]),
    humanCount: num(doc.data["humanCount"]),
    ranked: doc.data["ranked"] === true,
    verified: doc.data["verified"] === true,
    outcome: typeof doc.data["outcome"] === "string" ? doc.data["outcome"] : "unknown",
  };
  return { ...run, win: isCompetitiveWin(run) };
}

export function summarizeLaunchRuns(runs: readonly LaunchRun[]): LaunchModeSummary[] {
  return LAUNCH_MODE_IDS.map((mode) => {
    const rows = runs.filter((run) => run.mode === mode);
    const scoreTotal = rows.reduce((sum, run) => sum + run.score, 0);
    return {
      mode,
      runs: rows.length,
      players: new Set(rows.map((run) => run.uid)).size,
      rankedRuns: rows.filter((run) => run.ranked).length,
      wins: rows.filter((run) => run.win).length,
      averageScore: rows.length ? Math.round(scoreTotal / rows.length) : null,
      events: new Set(rows.map((run) => run.eventId).filter((id): id is string => id !== null)).size,
    };
  });
}

export interface LaunchStatsRow {
  mode: LaunchModeId;
  rankedMatches: number;
  wins: number;
  scoreTotal: number;
}

/** Reads `users/{uid}/launch_stats/{mode}` documents; unknown modes are skipped. */
export function toLaunchStats(docs: readonly LaunchHistoryDoc[]): LaunchStatsRow[] {
  return docs.flatMap((doc) => {
    if (!isLaunchMode(doc.id)) return [];
    return [{
      mode: doc.id,
      rankedMatches: num(doc.data["rankedMatches"]) ?? 0,
      wins: num(doc.data["wins"]) ?? 0,
      scoreTotal: num(doc.data["scoreTotal"]) ?? 0,
    }];
  });
}
