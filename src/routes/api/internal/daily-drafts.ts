import { createFileRoute } from "@tanstack/react-router";

/**
 * Secret-gated cron for autonomous Daily Blitz drafts.
 *
 * Writes daily_pack_drafts only. Never publishes daily_packs.
 * Authorization: Authorization: Bearer $OPS_CRON_SECRET
 */
export const Route = createFileRoute("/api/internal/daily-drafts")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = (process.env["OPS_CRON_SECRET"] ?? "").trim();
        if (!expected) {
          return Response.json({ error: "OPS_CRON_SECRET is not configured." }, { status: 503 });
        }
        const header = request.headers.get("authorization") ?? "";
        const got = header.replace(/^Bearer\s+/i, "").trim();
        const crypto = await import("node:crypto");
        const expectedBuffer = Buffer.from(expected);
        const gotBuffer = Buffer.from(got);
        if (gotBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(gotBuffer, expectedBuffer)) {
          return Response.json({ error: "Unauthorized." }, { status: 401 });
        }
          return Response.json({ error: "Unauthorized." }, { status: 401 });
        }
        let lookahead = 5;
        try {
          const body = (await request.json()) as { lookahead?: unknown };
          const n = Number(body?.lookahead);
          if (Number.isInteger(n) && n >= 1 && n <= 14) lookahead = n;
        } catch {
          /* empty body is fine */
        }
        const { fillUnfilledDailyDrafts } = await import("@/lib/admin/daily-drafts.server");
        const result = await fillUnfilledDailyDrafts(lookahead);
        return Response.json({ ok: true, lookahead, ...result });
      },
    },
  },
});
