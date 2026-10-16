import { describe, expect, it } from "vitest";
import {
  GAME_MODE_IDS,
  MODE_VISIBILITY_KEYS,
  applyModeVisibility,
  modesWithConditionalValues,
  parseModeVisibility,
} from "@/lib/admin/mode-visibility";
import {
  isCompetitiveWin,
  ownerOf,
  summarizeLaunchRuns,
  toLaunchRun,
  toLaunchStats,
  type LaunchRun,
} from "@/lib/admin/launch-analytics";

describe("mode visibility", () => {
  it("mirrors the client default when keys are unset: Solitaire only", () => {
    const visibility = parseModeVisibility(undefined);
    for (const id of GAME_MODE_IDS) expect(visibility[id]).toBe(id === "solitaire");
  });

  it("reads stored BOOLEAN defaults and covers every client key", () => {
    const visibility = parseModeVisibility({
      mode_arena_visible: { defaultValue: { value: "true" } },
      mode_solitaire_visible: { defaultValue: { value: "false" } },
    });
    expect(visibility.arena).toBe(true);
    expect(visibility.solitaire).toBe(false);
    expect(visibility.octagon).toBe(false);
    expect([...MODE_VISIBILITY_KEYS]).toContain("mode_party_visible");
    expect(MODE_VISIBILITY_KEYS.size).toBe(9);
  });

  it("writes only changed modes and keeps conditional overrides", () => {
    const parameters: Record<string, { defaultValue?: { value?: string }; valueType?: string; conditionalValues?: Record<string, { value: string }> }> = {
      mode_arena_visible: { defaultValue: { value: "false" }, conditionalValues: { testers: { value: "true" } } },
    };
    const changed = applyModeVisibility(parameters, { arena: true, octagon: false, solitaire: true });
    expect(changed).toEqual(["arena"]);
    expect(parameters.mode_arena_visible).toMatchObject({
      defaultValue: { value: "true" },
      valueType: "BOOLEAN",
      conditionalValues: { testers: { value: "true" } },
    });
    // Unchanged modes never gain an explicit key, so they keep tracking the client default.
    expect(parameters.mode_octagon_visible).toBeUndefined();
    expect(parameters.mode_solitaire_visible).toBeUndefined();
    expect(modesWithConditionalValues(parameters)).toEqual(["arena"]);
  });
});

function doc(uid: string, id: string, data: Record<string, string | number | boolean>) {
  return { id, path: `users/${uid}/launch_history/${id}`, data };
}

describe("launch analytics", () => {
  it("takes the owner from the document path and rejects other paths", () => {
    expect(ownerOf("users/u1/launch_history/arena:300000")).toBe("u1");
    expect(ownerOf("users/u1/game_history/x")).toBeNull();
    expect(ownerOf("launch_history/x")).toBeNull();
  });

  it("matches the Functions competitive-win rule", () => {
    expect(isCompetitiveWin({ mode: "arena", ranked: true, rank: 1, outcome: "completed" })).toBe(true);
    expect(isCompetitiveWin({ mode: "arena", ranked: false, rank: 1, outcome: "completed" })).toBe(false);
    expect(isCompetitiveWin({ mode: "octagon", ranked: true, rank: 3, outcome: "tied_win" })).toBe(true);
    expect(isCompetitiveWin({ mode: "octagon", ranked: true, rank: 1, outcome: "loss" })).toBe(false);
    expect(isCompetitiveWin({ mode: "solitaire", ranked: true, rank: 1, outcome: "completed" })).toBe(false);
  });

  it("skips malformed rows and summarizes per mode", () => {
    const runs = [
      doc("u1", "arena:300000", { mode: "arena", eventId: "arena:300000", startedAt: 300000, score: 4000, rank: 1, humanCount: 2, ranked: true, verified: true, outcome: "completed" }),
      doc("u2", "arena:300000", { mode: "arena", eventId: "arena:300000", startedAt: 300000, score: 2000, rank: 2, humanCount: 2, ranked: true, verified: true, outcome: "completed" }),
      doc("u1", "arena:600000", { mode: "arena", eventId: "arena:600000", startedAt: 600000, score: 3000, rank: 1, humanCount: 1, ranked: false, verified: true, outcome: "completed" }),
      doc("u3", "solitaire-a", { mode: "solitaire", startedAt: 1000, score: 5000, ranked: false, verified: false, outcome: "completed" }),
      doc("u3", "bad", { mode: "party", startedAt: 1, score: 1 }),
      { id: "stray", path: "users/u4/game_history/stray", data: { mode: "arena", startedAt: 1, score: 1 } },
    ].map(toLaunchRun).filter((run): run is LaunchRun => run !== null);

    expect(runs).toHaveLength(4);
    const byMode = Object.fromEntries(summarizeLaunchRuns(runs).map((row) => [row.mode, row]));
    expect(byMode.arena).toEqual({ mode: "arena", runs: 3, players: 2, rankedRuns: 2, wins: 1, averageScore: 3000, events: 2 });
    expect(byMode.solitaire).toMatchObject({ runs: 1, players: 1, wins: 0, averageScore: 5000, events: 0 });
    expect(byMode.octagon).toMatchObject({ runs: 0, averageScore: null });
  });

  it("reads only ranked-mode launch_stats and ignores Solitaire and unknown modes", () => {
    const stats = toLaunchStats([
      { id: "arena", path: "users/u1/launch_stats/arena", data: { rankedMatches: 3, wins: 1, scoreTotal: 9000 } },
      { id: "party", path: "users/u1/launch_stats/party", data: { rankedMatches: 9 } },
      { id: "solitaire", path: "users/u1/launch_stats/solitaire", data: { rankedMatches: 4 } },
    ]);
    expect(stats).toEqual([{ mode: "arena", rankedMatches: 3, wins: 1, scoreTotal: 9000 }]);
  });
});
