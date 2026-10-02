import { createFileRoute } from "@tanstack/react-router";
import {
  MODERATION_ACTIONS,
  ModerationRequestError,
  type ModerationAction,
  type ModerationActInput,
  type ModerationFactUpdates,
} from "@/lib/admin/ops-moderation.server";

/**
 * Moderation inbox for the Notion Ops Assistant.
 *
 * GET  /api/internal/ops/moderation/queue
 * POST /api/internal/ops/moderation/copilot  { reportId }
 * POST /api/internal/ops/moderation/act      { reportId, action, ... }
 *
 * Auth: Bearer OPS_ASSISTANT_SECRET.
 */
export const Route = createFileRoute("/api/internal/ops/moderation/$action")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const denied = await authorize(request);
        if (denied) return denied;
        const action = params.action?.trim().toLowerCase() ?? "";
        if (action !== "queue") {
          return Response.json(
            { error: "Unknown moderation read. Use queue." },
            { status: 404 },
          );
        }
        try {
          const ops = await import("@/lib/admin/ops-moderation.server");
          return Response.json(await ops.moderationQueue(readOffset(request)));
        } catch (error) {
          return moderationError(error);
        }
      },
      POST: async ({ request, params }) => {
        const denied = await authorize(request);
        if (denied) return denied;
        const action = params.action?.trim().toLowerCase() ?? "";
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "JSON body is required." }, { status: 400 });
        }
        try {
          const ops = await import("@/lib/admin/ops-moderation.server");
          switch (action) {
            case "copilot": {
              const reportId = readReportId(body);
              return Response.json(await ops.moderationCopilot(reportId));
            }
            case "act":
              return Response.json(await ops.moderationAct(readAct(body)));
            default:
              return Response.json(
                { error: "Unknown moderation action. Use copilot or act." },
                { status: 404 },
              );
          }
        } catch (error) {
          return moderationError(error);
        }
      },
    },
  },
});

async function authorize(request: Request): Promise<Response | null> {
  const { requireOpsAssistantAuth } = await import("@/lib/admin/ops-assistant-auth.server");
  const auth = requireOpsAssistantAuth(request.headers.get("authorization"));
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  return null;
}

function moderationError(error: unknown): Response {
  if (error instanceof ModerationRequestError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  console.error("[ops/moderation]", error);
  const message = error instanceof Error ? error.message : "Moderation error.";
  return Response.json({ error: message }, { status: 500 });
}

function readOffset(request: Request): number {
  const raw = new URL(request.url).searchParams.get("offset");
  if (raw == null || raw === "") return 0;
  const offset = Number(raw);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ModerationRequestError("offset must be a non-negative integer.", 400);
  }
  return offset;
}

function readReportId(body: unknown): string {
  if (!body || typeof body !== "object") {
    throw new ModerationRequestError("reportId is required.", 400);
  }
  const reportId = (body as { reportId?: unknown }).reportId;
  if (typeof reportId !== "string" || !reportId.trim()) {
    throw new ModerationRequestError("reportId is required.", 400);
  }
  return reportId;
}

function readAct(body: unknown): ModerationActInput {
  if (!body || typeof body !== "object") {
    throw new ModerationRequestError("reportId and action are required.", 400);
  }
  const raw = body as Record<string, unknown>;
  const reportId = raw["reportId"];
  const action = raw["action"];
  if (typeof reportId !== "string" || !reportId.trim()) {
    throw new ModerationRequestError("reportId is required.", 400);
  }
  if (typeof action !== "string" || !MODERATION_ACTIONS.includes(action as ModerationAction)) {
    throw new ModerationRequestError(
      `action must be one of: ${MODERATION_ACTIONS.join(", ")}.`,
      400,
    );
  }
  const correctedNumber = raw["correctedNumber"];
  if (correctedNumber !== undefined && typeof correctedNumber !== "number") {
    throw new ModerationRequestError("correctedNumber must be a number.", 400);
  }
  const note = raw["note"];
  if (note !== undefined && typeof note !== "string") {
    throw new ModerationRequestError("note must be a string.", 400);
  }
  const keepFactId = raw["keepFactId"];
  if (keepFactId !== undefined && typeof keepFactId !== "string") {
    throw new ModerationRequestError("keepFactId must be a string.", 400);
  }
  return {
    reportId,
    action: action as ModerationAction,
    correctedNumber: typeof correctedNumber === "number" ? correctedNumber : undefined,
    factUpdates: readUpdates(raw["factUpdates"]),
    note: typeof note === "string" ? note : undefined,
    keepFactId: typeof keepFactId === "string" ? keepFactId : undefined,
    copilot: readCopilot(raw["copilot"]),
  };
}

function readUpdates(value: unknown): ModerationFactUpdates | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ModerationRequestError("factUpdates must be an object.", 400);
  }
  const raw = value as Record<string, unknown>;
  const updates: ModerationFactUpdates = {};
  const textKeys = [
    "question",
    "claim_template",
    "unit",
    "plausible_min",
    "plausible_max",
    "quantity_kind",
    "explanation",
    "context",
  ] as const;
  for (const key of textKeys) {
    const field = raw[key];
    if (field === undefined) continue;
    if (typeof field !== "string") {
      throw new ModerationRequestError(`factUpdates.${key} must be a string.`, 400);
    }
    updates[key] = field;
  }
  if (raw["true_number"] !== undefined) {
    if (typeof raw["true_number"] !== "number" || !Number.isFinite(raw["true_number"])) {
      throw new ModerationRequestError("factUpdates.true_number must be a finite number.", 400);
    }
    updates.true_number = raw["true_number"];
  }
  if (raw["surprise_factor"] !== undefined) {
    if (typeof raw["surprise_factor"] !== "number" || !Number.isFinite(raw["surprise_factor"])) {
      throw new ModerationRequestError("factUpdates.surprise_factor must be a number.", 400);
    }
    updates.surprise_factor = raw["surprise_factor"];
  }
  return updates;
}

function readCopilot(value: unknown): ModerationActInput["copilot"] {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object") {
    throw new ModerationRequestError("copilot must be an object.", 400);
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw["verdict"] !== "string" || typeof raw["confidence"] !== "string") return undefined;
  if (typeof raw["score"] !== "number" || typeof raw["needsReview"] !== "boolean") return undefined;
  return {
    verdict: raw["verdict"],
    confidence: raw["confidence"],
    score: raw["score"],
    needsReview: raw["needsReview"],
  };
}
