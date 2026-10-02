import { createFileRoute } from "@tanstack/react-router";

import { runOpsRoute } from "@/lib/admin/ops-route.server";
import {
  opsDailyDay,
  opsDailyDelete,
  opsDailyFill,
  opsDailyGenerate,
  opsDailyPublish,
  opsDailyRemoveScore,
  opsDailySchedule,
} from "@/lib/admin/ops-portal.server";

/**
 * Daily Blitz for the Notion Ops Assistant.
 *
 * GET  /api/internal/ops/daily/schedule
 * GET  /api/internal/ops/daily/day?date=
 * POST /api/internal/ops/daily/delete    { date }
 * POST /api/internal/ops/daily/remove    { date, uid, reason? }
 * POST /api/internal/ops/daily/fill      { lookahead? }
 * POST /api/internal/ops/daily/generate  { topic, brief?, numRounds?, excludeAngles? }
 * POST /api/internal/ops/daily/publish   { date, category, rounds }
 */
export const Route = createFileRoute("/api/internal/ops/daily/$action")({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        runOpsRoute(request, params.action, {
          GET: {
            "schedule": () => opsDailySchedule(),
            "day": (url) => opsDailyDay(url.searchParams.get("date") ?? ""),
          },
        }),
      POST: ({ request, params }) =>
        runOpsRoute(request, params.action, {
          POST: {
            "delete": (body) => opsDailyDelete(body),
            "remove": (body) => opsDailyRemoveScore(body),
            "fill": (body) => opsDailyFill(body),
            "generate": (body) => opsDailyGenerate(body),
            "publish": (body) => opsDailyPublish(body),
          },
        }),
    },
  },
});
