/**
 * Content-page chat strategist. Same ChatBackend + tool runner as Daily.
 * Enqueue tools write crawl_queue. Chat never writes fact_bank rows.
 */
import { runChatLoop } from "./chat-loop";
import type { ChatCard, ChatMessage } from "./daily-blitz";

const SYSTEM_PROMPT = `You are the fact-bank hydration strategist for More or Less ops.
You choose what to crawl. Fact Foundry is the only verifier that writes fact_bank.
You may enqueue subjects or playlists and list coverage gaps. Never invent true_number values.
Never claim you saved a bank row. Foundry search-verifies after the queue drains.
Do not draft Daily packs from this page. Daily Blitz authoring lives on /admin/daily.
Keep replies concise. No em dashes.`;

export interface FactsChatInput {
  messages: ChatMessage[];
}

/**
 * Runs a facts chat session to identify coverage gaps and suggest items for the crawl queue.
 *
 * @param input - The chat messages to provide to the facts strategist
 * @returns The response text and generated chat cards
 */
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
