import { createFileRoute } from "@tanstack/react-router";

const PUBLIC_SKIP_REASONS = new Set([
  "live pack exists",
  "draft already awaiting review",
  "date already claimed",
]);

/**
 * Maps fill skip reasons to a cron-safe string with no internal error text.
 *
 * @param reason - The internal skip reason from draft fill
 * @returns A stable, non-sensitive reason for the API response
 */
function publicSkipReason(reason: string): string {
  if (PUBLIC_SKIP_REASONS.has(reason)) return reason;
  if (reason.includes("GO_AGENT_URL is not configured")) return "Go agent is not configured.";
  if (/returned no rounds/i.test(reason)) return "Go agent returned no rounds.";
  return "generation failed";
}

/**
 * Secret-gated cron for autonomous Daily Blitz drafts.
 *
 * GitHub Actions posts here with OPS_CRON_SECRET. Writes daily_pack_drafts
 * only. Live daily_packs stay on the Sports bank cycle until Save & Schedule.
 */
export const Route = createFileRoute("/api/internal/daily-drafts")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { clampLookahead, cronSecretMatches, fillUnfilledDailyDrafts } =
          await import("@/lib/admin/daily-drafts.server");

        if (!(process.env["OPS_CRON_SECRET"] ?? "").trim()) {
          return Response.json(
            { error: "OPS_CRON_SECRET is not configured." },
            { status: 503 },
          );
        }
        if (!cronSecretMatches(request.headers.get("authorization"))) {
          return Response.json({ error: "Unauthorized." }, { status: 401 });
        }

        let lookahead = 5;
        try {
          const body = (await request.json()) as { lookahead?: unknown };
          lookahead = clampLookahead(body?.lookahead);
        } catch {
          lookahead = 5;
        }

        const result = await fillUnfilledDailyDrafts(lookahead);
        const skipped = result.skipped.map((item) => ({
          date: item.date,
          reason: publicSkipReason(item.reason),
        }));
        const goAgentDown = result.skipped.some(
          (item) => item.date === "*" && item.reason.includes("GO_AGENT_URL"),
        );
        if (goAgentDown && result.drafted.length === 0) {
          return Response.json(
            { ok: false, lookahead, drafted: result.drafted, skipped },
            { status: 503 },
          );
        }
        return Response.json({
          ok: true,
          lookahead,
          drafted: result.drafted,
          skipped,
        });
      },
    },
  },
});
