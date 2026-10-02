import { createFileRoute } from "@tanstack/react-router";

import { runOpsRoute } from "@/lib/admin/ops-route.server";
import {
  opsAnalyticsFlag,
  opsAnalyticsGames,
  opsAnalyticsQuestions,
} from "@/lib/admin/ops-portal.server";

/**
 * Game analytics for the Notion Ops Assistant.
 *
 * GET  /api/internal/ops/analytics/games?days=7|30|90
 * GET  /api/internal/ops/analytics/questions?days=&kind=&search=
 * POST /api/internal/ops/analytics/flag  { days, questionId }
 */
export const Route = createFileRoute("/api/internal/ops/analytics/$action")({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        runOpsRoute(request, params.action, {
          GET: {
            "games": (url) => opsAnalyticsGames(url.searchParams.get("days") ?? undefined),
            "questions": (url) =>
              opsAnalyticsQuestions({
                days: url.searchParams.get("days") ?? undefined,
                kind: url.searchParams.get("kind") ?? undefined,
                search: url.searchParams.get("search") ?? undefined,
              }),
          },
        }),
      POST: ({ request, params }) =>
        runOpsRoute(request, params.action, {
          POST: {
            "flag": (body) => opsAnalyticsFlag(body),
          },
        }),
    },
  },
});
