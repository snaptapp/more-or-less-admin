/**
 * Content-page chat strategist. Same ChatBackend + tool runner as Daily.
 * Enqueue tools write crawl_queue. Chat never writes fact_bank rows.
 * draft_pack is an Apply card only.
 */
import { runChatLoop } from "./chat-loop";
import type { ChatCard, ChatMessage } from "./daily-blitz";

const SYSTEM_PROMPT = `You are the fact-bank hydration strategist for More or Less ops.
You choose what to crawl. Fact Foundry is the only verifier that writes fact_bank.
You may enqueue subjects or playlists and list coverage gaps. Never invent true_number values.
Never claim you saved a bank row. Foundry search-verifies after the queue drains.
draft_pack calls the Go agent and returns an Apply card for Daily. It does not publish.
Keep replies concise. No em dashes.`;

export interface FactsChatInput {
  messages: ChatMessage[];
}

export async function runFactsBankChat(input: FactsChatInput): Promise<{
  text: string;
  cards: ChatCard[];
}> {
  return runChatLoop({
    surface: "facts",
    system: SYSTEM_PROMPT,
    messages: input.messages,
    fallbackUser: "Show coverage gaps and suggest what to enqueue.",
    ctx: {
      date: "",
      topic: "",
      brief: "",
      rounds: [],
    },
  });
}
