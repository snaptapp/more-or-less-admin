/**
 * Ops-owned tool loop. Max 6 tool turns. Backends only complete() one model turn.
 */
import {
  historyToContents,
  jsonSafe,
  selectChatBackend,
  type ChatContent,
  type ChatPart,
} from "./chat-backend";
import { executeTool, toolsForSurface, type ChatSurface, type ToolContext } from "./chat-tools";
import type { ChatCard, ChatMessage } from "./daily-blitz";

const MAX_TOOL_TURNS = 6;

/**
 * Runs a chat completion loop with surface-specific tools and collects generated cards.
 *
 * @param input - Chat configuration, message history, execution context, and fallback user identity
 * @returns The final model text and any cards produced by executed tools
 */
export async function runChatLoop(input: {
  surface: ChatSurface;
  system: string;
  messages: ChatMessage[];
  ctx: Omit<ToolContext, "surface">;
  fallbackUser: string;
}): Promise<{ text: string; cards: ChatCard[] }> {
  const backend = await selectChatBackend();
  const tools = toolsForSurface(input.surface);
  const contents = historyToContents(input.messages, input.fallbackUser);
  const cards: ChatCard[] = [];
  const ctx: ToolContext = { ...input.ctx, surface: input.surface };

  let turn = await backend.complete({ system: input.system, tools, contents });
  for (let i = 0; i < MAX_TOOL_TURNS; i++) {
    if (!turn.toolCalls.length) {
      return { text: turn.text || "Done.", cards };
    }
    contents.push(turn.assistantMessage);
    const responseParts: ChatPart[] = [];
    for (const call of turn.toolCalls) {
      try {
        const executed = await executeTool(call.name, call.args, ctx);
        if (executed.card) cards.push(executed.card);
        responseParts.push({
          functionResponse: { name: call.name, response: jsonSafe(executed.result) },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        responseParts.push({
          functionResponse: { name: call.name, response: { error: message } },
        });
      }
    }
    contents.push({ role: "user", parts: responseParts });
    turn = await backend.complete({ system: input.system, tools, contents });
  }

  return {
    text:
      turn.text ||
      "Tool loop stopped. Apply any cards, then Save when the pack is ready.",
    cards,
  };
}

export type { ChatContent };
