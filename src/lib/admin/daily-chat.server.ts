/**
 * Daily Blitz chat strategist. Gemini (default) or ADK via ChatBackend.
 *
 * Lives on the ops Worker. Does not write daily_packs. Tool results are
 * returned as Apply cards so chat cannot silently overwrite the editor.
 * Pack writing is delegated to the Go agent via OIDC POST /pack.
 */
import {
  DAILY_BLITZ_ROUNDS,
  DAILY_BLITZ_SECONDS,
  draftContextSummary,
  type ChatCard,
  type ChatMessage,
  type EditableRound,
} from "./daily-blitz";
import { runChatLoop } from "./chat-loop";

const SYSTEM_PROMPT = `You are the Daily Blitz strategist for More or Less ops at ops.snaptapp.us.
Daily Blitz is 15 questions in 60 seconds. One verified attempt per UTC day.
You plan themes, briefs, swaps, and mix. You do NOT publish packs and you do NOT write Firestore.
The Go agent is the pack factory: grounded rounds, DDM distractors, safety unchanged.
When you want a pack or a regenerated round, call a tool. Tool results land as Apply cards in the editor. Never claim you already saved a live pack. The admin must click Apply, then Save & Schedule.
Unscheduled dates play a Sports fact-bank cycle until a pack is saved. Unreviewed drafts must not go live.
Do not stuff the brief into the topic. Pass a clean topic into draft_pack and put mix notes in brief.
Do not mention GameMode.blitz. Do not offer a second Daily Blitz admin tab.
Keep replies concise. No em dashes.`;

export interface DailyChatInput {
  date: string;
  topic: string;
  brief: string;
  rounds: EditableRound[];
  unfilledDates: string[];
  messages: ChatMessage[];
}

export async function runDailyBlitzChat(input: DailyChatInput): Promise<{
  text: string;
  cards: ChatCard[];
}> {
  const contextBlock = draftContextSummary({
    date: input.date,
    topic: input.topic,
    brief: input.brief,
    rounds: input.rounds,
    unfilledDates: input.unfilledDates,
  });
  const system = `${SYSTEM_PROMPT}

Always use this live editor snapshot:
${contextBlock}

Daily Blitz is ${DAILY_BLITZ_ROUNDS} questions, ${DAILY_BLITZ_SECONDS} seconds.`;

  return runChatLoop({
    surface: "daily",
    system,
    messages: input.messages,
    fallbackUser: "Help me fill this Daily Blitz date.",
    ctx: {
      date: input.date,
      topic: input.topic,
      brief: input.brief,
      rounds: input.rounds,
    },
  });
}
