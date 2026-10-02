import { createFileRoute } from "@tanstack/react-router";
import { CrawlRequestError } from "@/lib/admin/ops-crawl.server";

/**
 * Read-only crawl queue for the Notion Ops Assistant.
 *
 * GET /api/internal/ops/crawl/queue?status=queued|processing|done|completed
 * Auth: Bearer OPS_ASSISTANT_SECRET.
 */
export const Route = createFileRoute("/api/internal/ops/crawl/$action")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { requireOpsAssistantAuth } = await import(
          "@/lib/admin/ops-assistant-auth.server"
        );
        const auth = requireOpsAssistantAuth(request.headers.get("authorization"));
        if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

        const action = params.action?.trim().toLowerCase() ?? "";
        if (action !== "queue") {
          return Response.json({ error: "Unknown crawl read. Use queue." }, { status: 404 });
        }
        const status = new URL(request.url).searchParams.get("status") ?? undefined;
        try {
          const ops = await import("@/lib/admin/ops-crawl.server");
          return Response.json(await ops.opsCrawlQueue(status));
        } catch (error) {
          if (error instanceof CrawlRequestError) {
            return Response.json({ error: error.message }, { status: error.status });
          }
          console.error("[ops/crawl]", error);
          const message = error instanceof Error ? error.message : "Crawl queue error.";
          return Response.json({ error: message }, { status: 500 });
        }
      },
    },
  },
});
