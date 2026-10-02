import { createFileRoute } from "@tanstack/react-router";
import {
  FACTBANK_DIMENSIONS,
  type FactbankDimension,
} from "@/lib/admin/ops-factbank.server";

/**
 * Read-only Fact Bank ops API for the Notion Ops Assistant.
 *
 * GET /api/internal/ops/factbank/:action
 * Auth: Bearer OPS_ASSISTANT_SECRET (optional OPS_CRON_SECRET when OPS_ASSISTANT_ALLOW_CRON_FALLBACK=1).
 */
export const Route = createFileRoute("/api/internal/ops/factbank/$action")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { requireOpsAssistantAuth } = await import(
          "@/lib/admin/ops-assistant-auth.server"
        );
        const auth = requireOpsAssistantAuth(request.headers.get("authorization"));
        if (!auth.ok) {
          return Response.json({ error: auth.error }, { status: auth.status });
        }

        const action = params.action?.trim().toLowerCase() ?? "";
        const url = new URL(request.url);

        try {
          const ops = await import("@/lib/admin/ops-factbank.server");
          switch (action) {
            case "health":
              return Response.json(await ops.factbankHealth());
            case "distribution":
            case "breakdown": {
              const dimension = (url.searchParams.get("dimension") ??
                "genre") as FactbankDimension;
              if (!FACTBANK_DIMENSIONS.includes(dimension)) {
                return Response.json(
                  {
                    error: `dimension must be one of: ${FACTBANK_DIMENSIONS.join(", ")}`,
                  },
                  { status: 400 },
                );
              }
              return Response.json(await ops.factbankBreakdown(dimension));
            }
            case "validation":
            case "validate":
              return Response.json(await ops.factbankValidate());
            case "duplicates":
              return Response.json(await ops.factbankDuplicates());
            case "drift":
              return Response.json(await ops.factbankDrift());
            case "inspect":
            case "topic": {
              const topic =
                url.searchParams.get("q") ??
                url.searchParams.get("topic") ??
                url.searchParams.get("id") ??
                "";
              if (!topic.trim()) {
                return Response.json(
                  { error: "Query parameter q (topic_or_scope) is required." },
                  { status: 400 },
                );
              }
              return Response.json(await ops.factbankInspect(topic));
            }
            case "snapshot":
              return Response.json(
                await ops.molSystemSnapshot({
                  persist: url.searchParams.get("persist") !== "0",
                  includeValidation: url.searchParams.get("validation") !== "0",
                }),
              );
            default:
              return Response.json(
                {
                  error: `Unknown action '${action}'.`,
                  actions: [
                    "health",
                    "distribution",
                    "validation",
                    "duplicates",
                    "drift",
                    "inspect",
                    "snapshot",
                  ],
                },
                { status: 404 },
              );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Ops factbank error.";
          return Response.json({ error: message }, { status: 500 });
        }
      },
    },
  },
});
