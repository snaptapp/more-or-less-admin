import { createFileRoute } from "@tanstack/react-router";

/**
 * GitHub Actions cron hits this path with OPS_CRON_SECRET.
 * Fills daily_pack_drafts only. Live daily_packs stay on the Sports cycle
 * until an admin Save & Schedule.
 */
export const Route = createFileRoute("/api/internal/daily-drafts")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { clampLookahead, cronSecretMatches, fillUnfilledDailyDrafts } =
          await import("@/lib/admin/daily-drafts.server");

        if (!(process.env["OPS_CRON_SECRET"] ?? "").trim()) {
          return Response.json(
            { error: "OPS_CRON_SECRET is not configured" },
            { status: 503 },
          );
        }
        if (!cronSecretMatches(request.headers.get("authorization"))) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        let lookahead = 5;
        try {
          const body = (await request.json()) as { lookahead?: unknown };
          lookahead = clampLookahead(body?.lookahead);
        } catch {
          lookahead = 5;
        }

        const result = await fillUnfilledDailyDrafts(lookahead);
        return Response.json(result);
      },
    },
  },
});
