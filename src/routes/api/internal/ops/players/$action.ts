import { createFileRoute } from "@tanstack/react-router";

import { runOpsRoute } from "@/lib/admin/ops-route.server";
import { opsPlayersPlayer, opsPlayersPremium, opsPlayersSearch } from "@/lib/admin/ops-portal.server";

/**
 * Players for the Notion Ops Assistant.
 *
 * GET  /api/internal/ops/players/search?q=
 * GET  /api/internal/ops/players/player?id=
 * POST /api/internal/ops/players/premium  { id, isPremium }
 */
export const Route = createFileRoute("/api/internal/ops/players/$action")({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        runOpsRoute(request, params.action, {
          GET: {
            "search": (url) => opsPlayersSearch(url.searchParams.get("q") ?? undefined),
            "player": (url) => opsPlayersPlayer(url.searchParams.get("id") ?? ""),
          },
        }),
      POST: ({ request, params }) =>
        runOpsRoute(request, params.action, {
          POST: {
            "premium": (body) => opsPlayersPremium(body),
          },
        }),
    },
  },
});
