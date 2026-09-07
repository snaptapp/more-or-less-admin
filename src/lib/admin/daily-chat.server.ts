/**
 * Daily Blitz chat strategist. Gemini 3.8 Flash with function calling.
 *
 * Lives on the ops Worker. Does not write daily_packs. Tool results are
 * returned as Apply cards so chat cannot silently overwrite the editor.
 * Pack writing is delegated to the Go agent via OIDC POST /pack.
 */
import { getAccessToken } from "../firebase/credentials.server";
import { exportFacts, getFact } from "./content.server";
import {
  DAILY_BLITZ_ROUNDS,
  DAILY_BLITZ_SECONDS,
  DAILY_BLITZ_FALLBACK_CATEGORY,
  calendarStripDates,
  draftContextSummary,
  factToBlitzRound,
  type ChatCard,
  type ChatMessage,
  type EditableRound,
} from "./daily-blitz";
import { generatePackViaGoAgent, goAgentConfigured } from "./goagent.server";
import { isAbortError, responseSnippet } from "./http";
import { listDailyPacks } from "./ops.server";

const MODEL_ID = "gemini-3.8-flash";
const MAX_TOOL_TURNS = 6;

type GeminiPart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
};

type GeminiContent = { role: string; parts: GeminiPart[] };

function projectId(): string {
  return (
    process.env["GOOGLE_CLOUD_PROJECT"]?.trim() ||
    process.env["FIREBASE_PROJECT_ID"]?.trim() ||
    "more-or-less-505908"
  );
}

function vertexUrl(): string {
  const loc = (process.env["VERTEX_LOCATION"] ?? "global").trim() || "global";
  return `https://aiplatform.googleapis.com/v1/projects/${projectId()}/locations/${loc}/publishers/google/models/${MODEL_ID}:generateContent`;
}

const SYSTEM_PROMPT = `You are the Daily Blitz strategist for More or Less ops at ops.snaptapp.us.
Daily Blitz is 15 questions in 60 seconds. One verified attempt per UTC day.
You plan themes, briefs, swaps, and mix. You do NOT publish packs and you do NOT write Firestore.
The Go agent is the pack factory: grounded rounds, DDM distractors, safety unchanged.
When you want a pack or a regenerated round, call a tool. Tool results land as Apply cards in the editor. Never claim you already saved a live pack. The admin must click Apply, then Save & Schedule.
Unscheduled dates play a Sports fact-bank cycle until a pack is saved. Unreviewed drafts must not go live.
Do not stuff the brief into the topic. Pass a clean topic into draft_pack and put mix notes in brief.
Do not mention GameMode.blitz. Do not offer a second Daily Blitz admin tab.
Keep replies concise. No em dashes.`;

const TOOLS = [
  {
    functionDeclarations: [
      {
        name: "list_unfilled_dates",
        description:
          "List dates on the 14-day strip that have no authored daily_packs document. Those dates still play the Sports bank cycle.",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "draft_pack",
        description:
          "Ask the Go agent to write a 15-round grounded pack. Returns an Apply card. Does not save to Firestore. Topic must be a clean subject, not the full brief.",
        parameters: {
          type: "object",
          properties: {
            date: { type: "string", description: "UTC date YYYY-MM-DD" },
            topic: { type: "string", description: "Clean pack topic, e.g. NBA scoring" },
            brief: {
              type: "string",
              description: "Strategist notes for mix, eras, or angles to avoid",
            },
          },
          required: ["date", "topic"],
        },
      },
      {
        name: "regenerate_round",
        description:
          "Ask the Go agent for a single replacement round. Returns an Apply card for that slot. Does not save to Firestore.",
        parameters: {
          type: "object",
          properties: {
            date: { type: "string" },
            n: { type: "integer", description: "1-based round number" },
            note: { type: "string", description: "What to change about this round" },
          },
          required: ["date", "n"],
        },
      },
      {
        name: "search_fact_bank",
        description: "Search the same verified fact bank the round dropdown uses.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      },
      {
        name: "propose_swap",
        description:
          "Build a DDM-gated round from a fact-bank id for the editor. Does not write the live pack.",
        parameters: {
          type: "object",
          properties: {
            round: { type: "integer", description: "1-based round number to replace" },
            factId: { type: "string" },
          },
          required: ["round", "factId"],
        },
      },
      {
        name: "explain_round",
        description: "Explain distractor, direction, surprise, and source for round n of the current draft.",
        parameters: {
          type: "object",
          properties: {
            n: { type: "integer" },
          },
          required: ["n"],
        },
      },
    ],
  },
];

function jsonSafe(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value: value as unknown };
}

function newCardId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function listUnfilledDates(): Promise<string[]> {
  const packs = await listDailyPacks(200);
  const have = new Set(packs.map((p) => p.date));
  return calendarStripDates().filter((d) => !have.has(d));
}

async function searchFacts(query: string) {
  const facts = await exportFacts({
    status: "active",
    contentRating: "standard",
    search: query,
    pageSize: 24,
  });
  return facts.slice(0, 12).map((f) => ({
    id: f.id,
    subject: f.subject,
    question: f.question || f.angle,
    true_number: f.true_number,
    unit: f.unit,
    has_ddm: Boolean(f.derivation?.distractors?.length),
  }));
}

async function proposeSwap(roundNumber: number, factId: string, preferredSide?: "MORE" | "LESS") {
  const fact = await getFact(factId);
  if (!fact) return { error: `Fact ${factId} not found.` };
  if (fact.true_number === null) return { error: `Fact ${factId} has no true_number.` };
  const result = factToBlitzRound({
    factId: fact.id,
    subject: fact.subject,
    question: fact.question,
    angle: fact.angle,
    context: fact.context,
    unit: fact.unit,
    true_number: fact.true_number,
    surprise_factor: fact.surprise_factor,
    derivation: fact.derivation,
    preferredSide,
    round_number: roundNumber,
  });
  if ("error" in result) return { error: result.error };
  return { round: result.round, factId: fact.id };
}

function explainRound(n: number, rounds: EditableRound[]) {
  const round = rounds.find((r) => r.round_number === n) ?? rounds[n - 1];
  if (!round) return { error: `No round ${n} in the current draft.` };
  const trueNum = Number(round.true_number);
  const presented = Number(round.presented_number);
  return {
    round_number: round.round_number,
    claim_statement: round.claim_statement,
    presented_number: round.presented_number,
    true_number: round.true_number,
    unit: round.unit,
    correct_direction:
      Number.isFinite(trueNum) && Number.isFinite(presented) && trueNum !== presented
        ? trueNum > presented
          ? "MORE"
          : "LESS"
        : round.correct_direction,
    surprise_factor: round.surprise_factor,
    quantity_kind: round.quantity_kind ?? "unknown",
    trap_direction: round.trap_direction ?? "unknown",
    source: round.source ?? "editor",
    fact_id: round.fact_id ?? null,
    note:
      "Distractors must come from the DDM (Go /pack or a DDM-gated bank fact). Random multiplicative offsets are illegal.",
  };
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { date: string; topic: string; brief: string; rounds: EditableRound[] },
): Promise<{ result: Record<string, unknown>; card?: ChatCard }> {
  switch (name) {
    case "list_unfilled_dates": {
      const dates = await listUnfilledDates();
      return {
        result: {
          unfilled: dates,
          fallback: `${DAILY_BLITZ_FALLBACK_CATEGORY} bank cycle until a pack is saved`,
        },
        card: {
          id: newCardId("dates"),
          tool: name,
          title: "Unfilled dates",
          summary: dates.length
            ? dates.join(", ")
            : "Every date in the strip has an authored pack.",
          applyKind: "none",
        },
      };
    }
    case "draft_pack": {
      if (!goAgentConfigured()) {
        return {
          result: { error: "GO_AGENT_URL is not configured on ops." },
        };
      }
      const date = String(args.date ?? ctx.date);
      const topic = String(args.topic ?? ctx.topic).trim();
      const brief = String(args.brief ?? ctx.brief ?? "").trim();
      const pack = await generatePackViaGoAgent({
        topic,
        guidance: brief,
        numRounds: DAILY_BLITZ_ROUNDS,
      });
      return {
        result: {
          date,
          topic: pack.category,
          total_rounds: pack.rounds.length,
          status_message: pack.status_message,
          applied: false,
          note: "Click Apply to load this draft into the editor. Save & Schedule publishes.",
        },
        card: {
          id: newCardId("pack"),
          tool: name,
          title: `15-round Go draft for ${date}`,
          summary: `${pack.rounds.length} DDM-gated rounds on ${pack.category}. Apply loads the editor. Save publishes.`,
          applyKind: "pack",
          date,
          topic: pack.category,
          rounds: pack.rounds,
        },
      };
    }
    case "regenerate_round": {
      if (!goAgentConfigured()) {
        return { result: { error: "GO_AGENT_URL is not configured on ops." } };
      }
      const n = Number(args.n);
      if (!Number.isInteger(n) || n < 1 || n > DAILY_BLITZ_ROUNDS) {
        return { result: { error: `Round n must be 1-${DAILY_BLITZ_ROUNDS}.` } };
      }
      const note = String(args.note ?? "").trim();
      const current = ctx.rounds.find((r) => r.round_number === n);
      const topic = (current?.topic || ctx.topic).trim();
      const exclude = ctx.rounds
        .filter((r) => r.round_number !== n)
        .map((r) => r.claim_statement.trim())
        .filter(Boolean);
      const pack = await generatePackViaGoAgent({
        topic,
        numRounds: 1,
        guidance: note || `Replacement Daily Blitz round ${n}. Keep it distinct from the rest of the pack.`,
        excludeAngles: exclude,
      });
      const round = pack.rounds[0];
      if (!round) return { result: { error: "Go agent returned no round." } };
      round.round_number = n;
      return {
        result: {
          n,
          claim_statement: round.claim_statement,
          applied: false,
        },
        card: {
          id: newCardId("round"),
          tool: name,
          title: `Replace round ${n}`,
          summary: round.claim_statement || `New grounded round ${n}`,
          applyKind: "round",
          roundIndex: n - 1,
          round,
        },
      };
    }
    case "search_fact_bank": {
      const query = String(args.query ?? "").trim();
      if (!query) return { result: { error: "query is required" } };
      const facts = await searchFacts(query);
      return {
        result: { facts, count: facts.length },
        card: {
          id: newCardId("search"),
          tool: name,
          title: `Fact bank: ${query}`,
          summary: facts.length
            ? facts
                .slice(0, 6)
                .map((f) => `${f.subject}: ${f.question}${f.has_ddm ? "" : " (no DDM block)"}`)
                .join(" | ")
            : "No matching active facts.",
          applyKind: "none",
        },
      };
    }
    case "propose_swap": {
      const roundNumber = Number(args.round);
      const factId = String(args.factId ?? "");
      const preferred: "MORE" | "LESS" | undefined = roundNumber % 2 === 0 ? "LESS" : "MORE";
      const swapped = await proposeSwap(roundNumber, factId, preferred);
      if ("error" in swapped && swapped.error) {
        return { result: { error: swapped.error } };
      }
      const round = (swapped as { round: EditableRound }).round;
      return {
        result: { round, applied: false },
        card: {
          id: newCardId("swap"),
          tool: name,
          title: `Swap round ${roundNumber}`,
          summary: round.claim_statement,
          applyKind: "round",
          roundIndex: roundNumber - 1,
          round,
        },
      };
    }
    case "explain_round": {
      const n = Number(args.n);
      const explained = explainRound(n, ctx.rounds);
      return {
        result: explained,
        card: {
          id: newCardId("explain"),
          tool: name,
          title: `Round ${n}`,
          summary:
            "error" in explained && explained.error
              ? String(explained.error)
              : `${explained.correct_direction}: presented ${explained.presented_number} vs true ${explained.true_number} ${explained.unit} (surprise ${explained.surprise_factor}, ${explained.source})`,
          applyKind: "none",
        },
      };
    }
    default:
      return { result: { error: `Unknown tool ${name}` } };
  }
}

async function generateContent(contents: GeminiContent[], system: string): Promise<GeminiContent> {
  const token = await getAccessToken(["https://www.googleapis.com/auth/cloud-platform"]);
  let response: Response;
  try {
    response = await fetch(vertexUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        systemInstruction: { role: "system", parts: [{ text: system }] },
        contents,
        tools: TOOLS,
        generationConfig: {
          temperature: 0.4,
          thinkingConfig: { thinkingLevel: "LOW" },
        },
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    if (isAbortError(err)) {
      throw new Error("Gemini chat timed out.");
    }
    throw err;
  }
  if (!response.ok) {
    const detail = await responseSnippet(response, 400);
    throw new Error(
      `Gemini chat failed (${response.status}): ${detail}. Grant the ops service account roles/aiplatform.user on ${projectId()} if this is 403.`,
    );
  }
  let payload: {
    candidates?: Array<{ content?: GeminiContent }>;
    error?: { message?: string };
  };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    throw new Error("Gemini chat returned invalid JSON.");
  }
  const content = payload.candidates?.[0]?.content;
  if (!content?.parts?.length) {
    throw new Error(payload.error?.message || "Gemini returned no content.");
  }
  return { role: content.role || "model", parts: content.parts };
}

function visibleText(parts: GeminiPart[]): string {
  return parts
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text!.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function functionCalls(parts: GeminiPart[]): Array<{ name: string; args: Record<string, unknown> }> {
  const out: Array<{ name: string; args: Record<string, unknown> }> = [];
  for (const part of parts) {
    const name = part.functionCall?.name?.trim();
    if (!name) continue;
    out.push({ name, args: part.functionCall?.args ?? {} });
  }
  return out;
}

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

  const contents: GeminiContent[] = [];
  for (const msg of input.messages.slice(-12)) {
    contents.push({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.text }],
    });
  }
  if (!contents.length) {
    contents.push({ role: "user", parts: [{ text: "Help me fill this Daily Blitz date." }] });
  }

  const cards: ChatCard[] = [];
  let model = await generateContent(contents, system);

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const calls = functionCalls(model.parts);
    if (!calls.length) {
      const text = visibleText(model.parts);
      return { text: text || "Done.", cards };
    }

    contents.push(model);
    const responseParts: GeminiPart[] = [];
    for (const call of calls) {
      try {
        const executed = await executeTool(call.name, call.args, {
          date: input.date,
          topic: input.topic,
          brief: input.brief,
          rounds: input.rounds,
        });
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
    model = await generateContent(contents, system);
  }

  return {
    text: visibleText(model.parts) || "Tool loop stopped. Apply any cards, then Save when the pack is ready.",
    cards,
  };
}
