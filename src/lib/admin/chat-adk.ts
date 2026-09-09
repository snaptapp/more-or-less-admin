/**
 * ADK chat backend for ops.
 *
 * Interactive Daily/Content chat stays on Gemini in the Worker. The Python
 * ADK strategist (`app/ops_strategist.py` in more-or-less) is for batch
 * CLI / cron. If OPS_STRATEGIST_URL is set, this backend POSTs one complete()
 * turn there so the same tool loop can run against ADK.
 */
import {
  functionCalls,
  visibleText,
  type ChatBackend,
  type ChatCompleteResult,
  type ChatContent,
} from "./chat-backend";
import { isAbortError, responseSnippet, asJsonObject } from "./http";

function strategistUrl(): string {
  const url = (process.env["OPS_STRATEGIST_URL"] ?? "").trim().replace(/\/+$/, "");
  if (url && !url.startsWith("https://")) {
    throw new Error("OPS_STRATEGIST_URL must use HTTPS");
  }
  return url;
}

export const adkChatBackend: ChatBackend = {
  id: "adk",
  async complete(input): Promise<ChatCompleteResult> {
    const base = strategistUrl();
    if (!base) {
      throw new Error(
        "OPS_CHAT_BACKEND=adk is for the Python strategist CLI (`uv run python -m app.ops_strategist`) or a configured OPS_STRATEGIST_URL. Use OPS_CHAT_BACKEND=gemini for the ops UI.",
      );
    }
    let response: Response;
    try {
      response = await fetch(`${base}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system: input.system,
          tools: input.tools,
          contents: input.contents,
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw new Error("ADK strategist timed out.");
      }
      throw err;
    }
    if (!response.ok) {
      const detail = await responseSnippet(response, 400);
      throw new Error(`ADK strategist failed (${response.status}): ${detail}`);
    }
    const parsed = asJsonObject(await response.json());
    if (!parsed) throw new Error("ADK strategist returned invalid JSON.");
    const text = typeof parsed.text === "string" ? parsed.text : "";
    const rawCalls = Array.isArray(parsed.toolCalls) ? parsed.toolCalls : [];
    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    for (const item of rawCalls) {
      const rec = asJsonObject(item);
      const name = typeof rec?.name === "string" ? rec.name.trim() : "";
      if (!name) continue;
      toolCalls.push({
        name,
        args: rec && rec.args && typeof rec.args === "object" && !Array.isArray(rec.args)
          ? (rec.args as Record<string, unknown>)
          : {},
      });
    }
    const assistantParts = Array.isArray(parsed.parts)
      ? (parsed.parts as ChatContent["parts"])
      : [
          ...(text ? [{ text }] : []),
          ...toolCalls.map((call) => ({ functionCall: { name: call.name, args: call.args } })),
        ];
    const assistantMessage: ChatContent = { role: "model", parts: assistantParts };
    return {
      text: text || visibleText(assistantMessage.parts),
      toolCalls: toolCalls.length ? toolCalls : functionCalls(assistantMessage.parts),
      assistantMessage,
    };
  },
};
