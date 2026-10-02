import { createFileRoute } from "@tanstack/react-router";

import { runOpsRoute } from "@/lib/admin/ops-route.server";
import { opsAuditLog } from "@/lib/admin/ops-portal.server";

/**
 * Admin audit log for the Notion Ops Assistant.
 *
 * GET /api/internal/ops/audit/log?limit=&action=&targetId=
 */
export const Route = createFileRoute("/api/internal/ops/audit/$action")({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        runOpsRoute(request, params.action, {
          GET: {
            "log": (url) =>
              opsAuditLog({
                limit: url.searchParams.get("limit") ?? undefined,
                action: url.searchParams.get("action") ?? undefined,
                targetId: url.searchParams.get("targetId") ?? undefined,
              }),
          },
        }),
    },
  },
});
