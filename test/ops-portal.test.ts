import { beforeEach, describe, expect, it, vi } from "vitest";
import { firestoreDouble, remoteConfigDouble } from "./setup";

const listAuthUsers = vi.hoisted(() => vi.fn());

vi.mock("@/lib/firebase/firestore.server", async () => {
  const { firestoreDouble } = await import("./setup");
  return firestoreDouble().module;
});

vi.mock("@/lib/firebase/remote_config.server", async () => {
  const { remoteConfigDouble } = await import("./setup");
  return remoteConfigDouble().module;
});

vi.mock("@/lib/admin/roles.server", () => ({
  listAuthUsers,
}));

import {
  opsAnalyticsFlag,
  opsAnalyticsGames,
  opsAnalyticsQuestions,
  opsAuditLog,
  opsConfigPublish,
  opsConfigRead,
  opsDailyDay,
  opsDailyDelete,
  opsDailyFill,
  opsDailyPublish,
  opsDailyRemoveScore,
  opsDailySchedule,
  opsPlayersPlayer,
  opsPlayersPremium,
  opsPlayersSearch,
  opsRolesList,
  PortalRequestError,
} from "@/lib/admin/ops-portal.server";

const ROUND = {
  topic: "Disco",
  claim_statement: "Disco peaked in this many years after 1900",
  true_number: 78,
  presented_number: 70,
  unit: "year",
  explanation: "Billboard's disco peak.",
};

describe("ops portal", () => {
  beforeEach(() => {
    listAuthUsers.mockReset();
    listAuthUsers.mockResolvedValue([
      {
        uid: "admin",
        email: "admin@snaptapp.us",
        displayName: "Admin",
        emailVerified: true,
        disabled: false,
        isAdmin: true,
        mfaEnrolled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastSignInAt: "2026-10-01T00:00:00.000Z",
      },
      {
        uid: "player",
        email: "ada@example.com",
        displayName: "Ada",
        emailVerified: true,
        disabled: false,
        isAdmin: false,
        mfaEnrolled: false,
        createdAt: "2026-02-01T00:00:00.000Z",
        lastSignInAt: null,
      },
    ]);
    remoteConfigDouble().seedTopicSuggestions({
      defaultTopics: ["Disco", "NBA"],
      variants: [{ conditionName: "US", expression: "device.country == 'US'", topics: ["NBA"] }],
    });
    firestoreDouble().seedMany({
      "users/ada": {
        displayName: "Ada",
        email: "ada@example.com",
        isPremium: false,
        createdAt: "2026-02-01T00:00:00.000Z",
      },
      "users/ada/stats/summary": {
        totalGamesPlayed: 4,
        totalCorrect: 3,
        totalWrong: 1,
        bestScore: 3,
        lifetimePercentCorrect: 0.75,
      },
      "daily_packs/2026-10-02": {
        category: "Music",
        seed: "seed",
        rounds: [ROUND],
        createdAt: "2026-10-01T00:00:00.000Z",
      },
      "daily_leaderboards/2026-10-02": {
        entries: [{ uid: "ada", displayName: "Ada", score: 12 }],
      },
      "users/ada/game_history/g1": {
        gameMode: "daily",
        playedAt: new Date().toISOString(),
        category: "Music",
        verified: true,
      },
      "round_analytics_7d/q1": {
        questionId: "fact:f1",
        kind: "fact",
        claimStatement: "Disco peaked in 1978",
        topic: "Disco",
        category: "Music",
        unit: "year",
        attempts: 40,
        correct: 10,
        skipped: 0,
      },
      "fact_bank/f1": { status: "active", subject: "Disco" },
    });
  });

  it("searches players and grants premium on the entitlements doc", async () => {
    const found = await opsPlayersSearch("ada");
    expect(found.count).toBe(1);
    expect(found.items[0]?.id).toBe("ada");

    await opsPlayersPremium({ id: "ada", isPremium: true });
    const player = await opsPlayersPlayer("ada");
    expect(player.player.isPremium).toBe(true);
    expect(player.player.stats?.totalGamesPlayed).toBe(4);
    expect(firestoreDouble().document("entitlements/ada@example.com")?.data["isPremium"]).toBe(true);
  });

  it("lists a daily pack, removes a score, and deletes the pack", async () => {
    const schedule = await opsDailySchedule();
    expect(schedule.pack_count).toBe(1);
    expect(schedule.packs[0]?.blitz_ready).toBe(false);

    const day = await opsDailyDay("2026-10-02");
    expect(day.pack?.rounds[0]?.claim).toContain("Disco");
    expect(day.leaderboard.entries[0]?.uid).toBe("ada");

    await opsDailyRemoveScore({ date: "2026-10-02", uid: "ada" });
    const after = await opsDailyDay("2026-10-02");
    expect(after.leaderboard.count).toBe(0);

    await opsDailyDelete({ date: "2026-10-02" });
    expect(firestoreDouble().document("daily_packs/2026-10-02")).toBeNull();
  });

  it("publishes a complete daily pack", async () => {
    const published = await opsDailyPublish({
      date: "2026-10-03",
      category: "Music",
      rounds: [ROUND],
    });
    expect(published.total_rounds).toBe(1);
    expect(firestoreDouble().document("daily_packs/2026-10-03")?.data["category"]).toBe("Music");
  });

  it("summarizes games, lists weak questions, and flags a fact into the inbox", async () => {
    const games = await opsAnalyticsGames("7");
    expect(games.total).toBe(1);
    expect(games.byMode[0]?.name).toBe("Daily Blitz");

    const questions = await opsAnalyticsQuestions({ days: "7", kind: "fact" });
    expect(questions.count).toBe(1);
    expect(questions.items[0]?.questionId).toBe("fact:f1");

    const flagged = await opsAnalyticsFlag({ days: 7, questionId: "fact:f1" });
    expect(flagged.alreadyReviewed).toBe(false);
    expect(firestoreDouble().document(`trivia_reports/${flagged.reportId}`)?.data["status"]).toBe(
      "pending_review",
    );
    expect(firestoreDouble().document("fact_bank/f1")?.data["status"]).toBe("disputed");
  });

  it("reads and publishes remote config with the current etag", async () => {
    const current = await opsConfigRead();
    expect(current.config.defaultTopics).toEqual(["Disco", "NBA"]);
    const published = await opsConfigPublish({
      etag: current.config.etag,
      defaultTopics: ["Disco", "NBA", "Space"],
      variants: current.config.variants,
      enableBannerAds: true,
    });
    expect(published.config.defaultTopics).toContain("Space");
    expect(remoteConfigDouble().publishes()).toHaveLength(1);
  });

  it("lists admins and can find a non-admin account without changing roles", async () => {
    const directory = await opsRolesList();
    expect(directory.admin_count).toBe(1);
    expect(directory.admins[0]?.email).toBe("admin@snaptapp.us");
    expect(directory.total_accounts).toBe(2);

    const matches = await opsRolesList("ada");
    expect(matches.matches[0]?.isAdmin).toBe(false);
  });

  it("reads audit entries written by portal actions", async () => {
    await opsPlayersPremium({ id: "ada", isPremium: true });
    const log = await opsAuditLog({ action: "premium" });
    expect(log.count).toBe(1);
    expect(log.items[0]?.action).toBe("player.grant_premium");
    expect(log.items[0]?.adminEmail).toBe("ops-assistant@snaptapp.us");
  });

  it("rejects incomplete writes", async () => {
    await expect(opsPlayersPremium({ id: "ada" })).rejects.toBeInstanceOf(PortalRequestError);
    await expect(opsPlayersPlayer("missing")).rejects.toMatchObject({ status: 404 });
    await expect(opsDailyFill({ lookahead: 0 })).rejects.toBeInstanceOf(PortalRequestError);
    await expect(
      opsDailyPublish({ date: "2026-10-04", category: "Music", rounds: [{ topic: "Disco" }] }),
    ).rejects.toBeInstanceOf(PortalRequestError);
  });
});
