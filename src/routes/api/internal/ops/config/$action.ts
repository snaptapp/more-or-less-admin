import { createFileRoute } from "@tanstack/react-router";

import { runOpsRoute } from "@/lib/admin/ops-route.server";
import { opsConfigPublish, opsConfigRead } from "@/lib/admin/ops-portal.server";

/**
 * Remote Config for the Notion Ops Assistant.
 *
 * GET  /api/internal/ops/config/read
 * POST /api/internal/ops/config/publish
 */
export const Route = createFileRoute("/api/internal/ops/config/$action")({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        runOpsRoute(request, params.action, {
          GET: {
            "read": () => opsConfigRead(),
          },
        }),
      POST: ({ request, params }) =>
        runOpsRoute(request, params.action, {
          POST: {
            "publish": (body) => opsConfigPublish(body),
          },
        }),
    },
  },
});
