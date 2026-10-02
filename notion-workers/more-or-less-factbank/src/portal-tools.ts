import { j } from "@notionhq/workers/schema-builder";
import type { JSONValue } from "@notionhq/workers/types";
import type { Worker } from "@notionhq/workers";

type OpsClient = {
  get: (path: string) => Promise<JSONValue>;
  call: (path: string, init: { method: "POST"; body: unknown }) => Promise<JSONValue>;
};

function query(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

/** Admin-page tools: players, Daily Blitz, analytics, remote config, roles, audit. */
export function registerPortalTools(worker: Worker, ops: OpsClient): void {
  worker.tool("players_search", {
    title: "Search Players",
    description:
      "Search players by display name, email, or uid. Returns up to 50 people. Use for who a player is and whether they are premium.",
    schema: j.object({
      q: j.string().nullable().describe("Optional name, email, or uid fragment. Omit to list the first page."),
    }),
    hints: { readOnlyHint: true },
    execute: async ({ q }) => ops.get(`/api/internal/ops/players/search${query({ q })}`),
  });

  worker.tool("players_player", {
    title: "Get Player",
    description: "Load one player by uid, including premium status and lifetime stats.",
    schema: j.object({
      id: j.string().describe("Firebase uid from players_search."),
    }),
    hints: { readOnlyHint: true },
    execute: async ({ id }) => ops.get(`/api/internal/ops/players/player${query({ id })}`),
  });

  worker.tool("players_premium", {
    title: "Set Player Premium",
    description:
      "Grant or remove premium for one player. This is the Players page button. Use only when the operator asked to change that player's premium.",
    schema: j.object({
      id: j.string().describe("Firebase uid."),
      is_premium: j.boolean().describe("true grants premium. false removes it."),
    }),
    execute: async ({ id, is_premium }) =>
      ops.call("/api/internal/ops/players/premium", {
        method: "POST",
        body: { id, isPremium: is_premium },
      }),
  });

  worker.tool("daily_schedule", {
    title: "Daily Blitz Schedule",
    description:
      "List published Daily Blitz packs and drafts awaiting review. Draft rows omit round text. Use daily_day for one date.",
    schema: j.object({}),
    hints: { readOnlyHint: true },
    execute: async () => ops.get("/api/internal/ops/daily/schedule"),
  });

  worker.tool("daily_day", {
    title: "Daily Blitz Day",
    description:
      "Load one UTC date: published pack rounds, the draft if one is awaiting review, and the leaderboard.",
    schema: j.object({
      date: j.string().describe("UTC date YYYY-MM-DD."),
    }),
    hints: { readOnlyHint: true },
    execute: async ({ date }) => ops.get(`/api/internal/ops/daily/day${query({ date })}`),
  });

  worker.tool("daily_delete", {
    title: "Delete Daily Pack",
    description:
      "Delete the published Daily Blitz pack for one date. Live players lose that pack. Use only when the operator asked to delete that date.",
    schema: j.object({
      date: j.string().describe("UTC date YYYY-MM-DD."),
    }),
    execute: async ({ date }) =>
      ops.call("/api/internal/ops/daily/delete", { method: "POST", body: { date } }),
  });

  worker.tool("daily_remove_score", {
    title: "Remove Leaderboard Score",
    description:
      "Remove one uid from a Daily Blitz leaderboard. This is the Remove score button. Use only when the operator asked to remove that score.",
    schema: j.object({
      date: j.string().describe("UTC date YYYY-MM-DD."),
      uid: j.string().describe("Player uid from daily_day leaderboard.entries."),
      reason: j.string().nullable().describe("Optional reason stored on the audit log."),
    }),
    execute: async ({ date, uid, reason }) =>
      ops.call("/api/internal/ops/daily/remove", {
        method: "POST",
        body: { date, uid, reason: reason ?? undefined },
      }),
  });

  worker.tool("daily_fill", {
    title: "Fill Daily Drafts",
    description:
      "Ask the Go agent to draft Daily Blitz packs for upcoming dates that have no live pack and no draft. Writes drafts only. It does not publish. Needs GO_AGENT_URL on ops.",
    schema: j.object({
      lookahead: j.number().nullable().describe("Days ahead, 1 to 14. Default 5."),
    }),
    execute: async ({ lookahead }) =>
      ops.call("/api/internal/ops/daily/fill", {
        method: "POST",
        body: { lookahead: lookahead ?? undefined },
      }),
  });

  worker.tool("daily_generate", {
    title: "Generate Daily Pack",
    description:
      "Generate Daily Blitz rounds for a topic. Returns the draft. It does not publish. Publish only with daily_publish after the operator approves the rounds.",
    schema: j.object({
      topic: j.string().describe("Pack topic or category."),
      brief: j.string().nullable().describe("Optional guidance for the generator."),
      num_rounds: j.number().nullable().describe("1 to 15. Default is a full blitz."),
      exclude_angles: j.array(j.string()).nullable().describe("Angles to avoid."),
    }),
    execute: async ({ topic, brief, num_rounds, exclude_angles }) =>
      ops.call("/api/internal/ops/daily/generate", {
        method: "POST",
        body: {
          topic,
          brief: brief ?? undefined,
          numRounds: num_rounds ?? undefined,
          excludeAngles: exclude_angles ?? undefined,
        },
      }),
  });

  worker.tool("daily_publish", {
    title: "Publish Daily Pack",
    description:
      "Publish a Daily Blitz pack for one date and remove that date's draft. This is Save and Schedule. Use only when the operator approved these rounds. Each round needs a claim, unit, explanation, and unequal true and presented numbers.",
    schema: j.object({
      date: j.string().describe("UTC date YYYY-MM-DD."),
      category: j.string().describe("Pack category."),
      rounds: j
        .array(
          j.object({
            claim_statement: j.string(),
            unit: j.string(),
            explanation: j.string(),
            true_number: j.number(),
            presented_number: j.number(),
            topic: j.string().nullable(),
          }),
        )
        .describe("Complete rounds to publish."),
    }),
    execute: async ({ date, category, rounds }) =>
      ops.call("/api/internal/ops/daily/publish", {
        method: "POST",
        body: { date, category, rounds },
      }),
  });

  worker.tool("analytics_games", {
    title: "Game Analytics",
    description:
      "Summarize recent matches by mode, lobby, and category. days is 7, 30, or 90. The sample is capped at 500 games.",
    schema: j.object({
      days: j.enum("7", "30", "90").nullable().describe("Window. Default 7."),
    }),
    hints: { readOnlyHint: true },
    execute: async ({ days }) => ops.get(`/api/internal/ops/analytics/games${query({ days })}`),
  });

  worker.tool("analytics_questions", {
    title: "Question Telemetry",
    description:
      "List questions with at least 20 answers in the window, worst accuracy first. kind is fact or generated.",
    schema: j.object({
      days: j.enum("7", "30", "90").nullable().describe("Window. Default 7."),
      kind: j.enum("fact", "generated").nullable().describe("Optional question kind."),
      search: j.string().nullable().describe("Optional question id, claim, or topic fragment."),
    }),
    hints: { readOnlyHint: true },
    execute: async ({ days, kind, search }) =>
      ops.get(`/api/internal/ops/analytics/questions${query({ days, kind, search })}`),
  });

  worker.tool("analytics_flag", {
    title: "Flag Question For Review",
    description:
      "Send one telemetry question to the moderation inbox. If the question is an active fact, this also marks that fact disputed. Use only when the operator asked to flag that question id.",
    schema: j.object({
      days: j.enum("7", "30", "90").describe("Telemetry window the row came from."),
      question_id: j.string().describe("questionId from analytics_questions."),
    }),
    execute: async ({ days, question_id }) =>
      ops.call("/api/internal/ops/analytics/flag", {
        method: "POST",
        body: { days: Number(days), questionId: question_id },
      }),
  });

  worker.tool("config_read", {
    title: "Read Remote Config",
    description:
      "Read the live topic suggestions, ad switches, allowed emails, custom parameters, and the etag required to publish.",
    schema: j.object({}),
    hints: { readOnlyHint: true },
    execute: async () => ops.get("/api/internal/ops/config/read"),
  });

  worker.tool("config_publish", {
    title: "Publish Remote Config",
    description:
      "Publish Remote Config. Live players pick this up. Call config_read first and resend default_topics and variants unchanged except for the field the operator named. Send the etag from that read. Omit an ad switch to leave it as it is.",
    schema: j.object({
      etag: j.string().describe("etag from config_read."),
      default_topics: j.array(j.string()).describe("Default topic list."),
      variants: j
        .array(
          j.object({
            condition_name: j.string(),
            expression: j.string(),
            tag_color: j.string().nullable(),
            topics: j.array(j.string()),
          }),
        )
        .describe("Condition rules. Resend the current list."),
      enable_interstitial_ads: j.boolean().nullable(),
      interstitial_ad_frequency: j.number().nullable(),
      enable_rewarded_ads: j.boolean().nullable(),
      enable_banner_ads: j.boolean().nullable(),
      allowed_emails: j.array(j.string()).nullable(),
    }),
    execute: async ({
      etag,
      default_topics,
      variants,
      enable_interstitial_ads,
      interstitial_ad_frequency,
      enable_rewarded_ads,
      enable_banner_ads,
      allowed_emails,
    }) =>
      ops.call("/api/internal/ops/config/publish", {
        method: "POST",
        body: {
          etag,
          defaultTopics: default_topics,
          variants: variants.map((variant) => ({
            conditionName: variant.condition_name,
            expression: variant.expression,
            tagColor: variant.tag_color ?? undefined,
            topics: variant.topics,
          })),
          enableInterstitialAds: enable_interstitial_ads ?? undefined,
          interstitialAdFrequency: interstitial_ad_frequency ?? undefined,
          enableRewardedAds: enable_rewarded_ads ?? undefined,
          enableBannerAds: enable_banner_ads ?? undefined,
          allowedEmails: allowed_emails ?? undefined,
        },
      }),
  });

  worker.tool("roles_list", {
    title: "List Admins",
    description:
      "List Firebase accounts that have the admin claim, plus the total account count. Optional q searches email, name, or uid and returns up to 50 matches. This tool cannot grant or revoke admin.",
    schema: j.object({
      q: j.string().nullable().describe("Optional email, name, or uid fragment."),
    }),
    hints: { readOnlyHint: true },
    execute: async ({ q }) => ops.get(`/api/internal/ops/roles/list${query({ q })}`),
  });

  worker.tool("audit_log", {
    title: "Audit Log",
    description:
      "Read the latest admin audit entries, including Ops Assistant writes. Filter with action or target_id. limit is 1 to 100, default 40.",
    schema: j.object({
      limit: j.number().nullable(),
      action: j.string().nullable().describe("Action name fragment, such as grant_admin or daily."),
      target_id: j.string().nullable().describe("Exact target id."),
    }),
    hints: { readOnlyHint: true },
    execute: async ({ limit, action, target_id }) =>
      ops.get(`/api/internal/ops/audit/log${query({ limit, action, targetId: target_id })}`),
  });
}
