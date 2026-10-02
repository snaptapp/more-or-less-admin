import { createFileRoute } from "@tanstack/react-router";

import { runOpsRoute } from "@/lib/admin/ops-route.server";
import { opsRolesList } from "@/lib/admin/ops-portal.server";

/**
 * Admin directory for the Notion Ops Assistant. Read only.
 * Grant and revoke stay on the Roles page.
 *
 * GET /api/internal/ops/roles/list?q=
 */
export const Route = createFileRoute("/api/internal/ops/roles/$action")({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        runOpsRoute(request, params.action, {
          GET: {
            "list": (url) => opsRolesList(url.searchParams.get("q") ?? undefined),
          },
        }),
    },
  },
});
