/**
 * Shared bearer gate and JSON envelope for `/api/internal/ops/*` routes.
 */

import { PortalRequestError } from "./ops-portal.server";
import { requireOpsAssistantAuth } from "./ops-assistant-auth.server";

type GetHandler = (url: URL) => Promise<unknown>;
type PostHandler = (body: unknown) => Promise<unknown>;

export async function runOpsRoute(
  request: Request,
  action: string | undefined,
  handlers: { GET?: Record<string, GetHandler>; POST?: Record<string, PostHandler> },
): Promise<Response> {
  const auth = requireOpsAssistantAuth(request.headers.get("authorization"));
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const name = action?.trim().toLowerCase() ?? "";
  const method = request.method;
  if (method !== "GET" && method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  const table = handlers[method];
  const handler = table?.[name];
  if (!handler) {
    const known = table ? Object.keys(table).join(", ") : "";
    return Response.json(
      { error: known ? `Unknown action. Use ${known}.` : "Method not allowed." },
      { status: 404 },
    );
  }

  try {
    if (method === "GET") {
      return Response.json(await (handler as GetHandler)(new URL(request.url)));
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "JSON body is required." }, { status: 400 });
    }
    return Response.json(await (handler as PostHandler)(body));
  } catch (error) {
    if (error instanceof PortalRequestError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("[ops]", error);
    const message = error instanceof Error ? error.message : "Ops error.";
    return Response.json({ error: message }, { status: 500 });
  }
}
