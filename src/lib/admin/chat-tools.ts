/**
 * Shared ops chat tool runner. Provider-agnostic.
 *
 * `draft_pack` is the only path that calls Go POST /pack.
 * Guided Daily/Content chat never writes daily_packs or fact_bank.
 * Autonomous cron may write daily_pack_drafts only.
 */
import { exportFacts, getFact } from "./content.server";
import {
  DAILY_BLITZ_ROUNDS,
  DAILY_BLITZ_FALLBACK_CATEGORY,
  calendarStripDates,
  factToBlitzRound,
  type ChatCard,
  type EditableRound,
} from "./daily-blitz";
import type { ChatToolDeclaration } from "./chat-backend";
import { generatePackViaGoAgent, goAgentConfigured } from "./goagent.server";
import {
  enqueueCrawl,
  getDailyPack,
  listCrawlQueue,
  listSubjects,
  triggerFoundryWorkflow,
  writeDailyDraft,
} from "./ops.server";

export type ChatSurface = "daily" | "facts" | "autonomous";

export interface ToolContext {
  date: string;
  topic: string;
  brief: string;
  rounds: EditableRound[];
  surface: ChatSurface;
}

const DAILY_TOOLS: ChatToolDeclaration[] = [
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
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "propose_swap",
    description: "Build a DDM-gated round from a fact-bank id for the editor. Does not write the live pack.",
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
      properties: { n: { type: "integer" } },
      required: ["n"],
    },
  },
];

const FACTS_TOOLS: ChatToolDeclaration[] = [
  {
    name: "coverage_gaps",
    description:
      "List thin genres and subjects with few active DDM facts. Chat cannot write fact_bank rows; enqueue for Foundry instead.",
    parameters: {
      type: "object",
      properties: {
        minFacts: { type: "integer", description: "Subjects at or below this fact_count are thin. Default 3." },
        limit: { type: "integer", description: "Max subjects to return. Default 12." },
      },
    },
  },
  {
    name: "enqueue_subject",
    description:
      "Write one subject to crawl_queue for Fact Foundry. Does not write fact_bank. Foundry is the only verifier.",
    parameters: {
      type: "object",
      properties: {
        subject: { type: "string" },
        priority: { type: "integer", description: "0-100, higher first. Default 5." },
        refresh: { type: "boolean", description: "Re-verify banked angles. Default false." },
      },
      required: ["subject"],
    },
  },
  {
    name: "enqueue_playlist",
    description: "Expand a playlist name into crawl_queue topics (same as ops enqueue).",
    parameters: {
      type: "object",
      properties: {
        playlist: { type: "string", description: "Playlist name or alias" },
        priority: { type: "integer" },
        refresh: { type: "boolean" },
      },
      required: ["playlist"],
    },
  },
  {
    name: "list_queue",
    description: "List crawl_queue jobs, optionally filtered by status.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", description: "queued | processing | done" },
      },
    },
  },
  {
    name: "trigger_foundry",
    description:
      "Dispatch the Fact Foundry GitHub Action. Does not write facts from chat. Foundry search-verifies queued subjects.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "search_fact_bank",
    description: "Search verified fact bank rows. Read-only.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "draft_pack",
    description:
      "Ask the Go agent for a 15-round pack as an Apply card (for filling Daily from a topic or playlist). Does not publish.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string" },
        topic: { type: "string" },
        brief: { type: "string" },
      },
      required: ["topic"],
    },
  },
];

const AUTONOMOUS_TOOLS: ChatToolDeclaration[] = [
  ...DAILY_TOOLS.filter((t) => t.name === "list_unfilled_dates" || t.name === "draft_pack"),
  {
    name: "save_daily_draft",
    description:
      "Write daily_pack_drafts/{date} with status awaiting_review. Never writes daily_packs. Live publish is Save & Schedule only.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string" },
        category: { type: "string" },
        brief: { type: "string" },
        rounds: { type: "array", items: { type: "object" } },
      },
      required: ["date", "category", "rounds"],
    },
  },
];

export function toolsForSurface(surface: ChatSurface): ChatToolDeclaration[] {
  if (surface === "facts") return FACTS_TOOLS;
  if (surface === "autonomous") return AUTONOMOUS_TOOLS;
  return DAILY_TOOLS;
}

function newCardId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function listUnfilledDates(): Promise<string[]> {
  const dates = calendarStripDates();
  const found = await Promise.all(dates.map((d) => getDailyPack(d)));
  return dates.filter((_, i) => !found[i]);
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

async function coverageGaps(minFacts: number, limit: number) {
  const { subjects, coverage } = await listSubjects({});
  const thinSubjects = subjects
    .filter((s) => s.fact_count <= minFacts)
    .sort((a, b) => a.fact_count - b.fact_count || a.subject.localeCompare(b.subject))
    .slice(0, limit)
    .map((s) => ({
      subject: s.subject,
      category: s.category,
      fact_count: s.fact_count,
      last_crawled_at: s.last_crawled_at,
    }));
  const thinGenres = coverage
    .slice()
    .sort((a, b) => a.facts - b.facts || a.subjects - b.subjects)
    .slice(0, 8);
  return { thinSubjects, thinGenres, minFacts };
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
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
        return { result: { error: "GO_AGENT_URL is not configured on ops." } };
      }
      const date = String(args.date ?? ctx.date);
      const topic = String(args.topic ?? ctx.topic).trim();
      const brief = String(args.brief ?? ctx.brief ?? "").trim();
      if (!topic) return { result: { error: "topic is required" } };
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
      if (ctx.surface === "facts") {
        return { result: { error: "regenerate_round is a Daily editor tool." } };
      }
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
        result: { n, claim_statement: round.claim_statement, applied: false },
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
      if (!Number.isInteger(roundNumber) || roundNumber < 1 || roundNumber > DAILY_BLITZ_ROUNDS) {
        return { result: { error: `round must be 1-${DAILY_BLITZ_ROUNDS}.` } };
      }
      const factId = String(args.factId ?? "");
      if (!factId) return { result: { error: "factId is required." } };
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
    case "coverage_gaps": {
      const minFacts = Number.isInteger(Number(args.minFacts)) ? Number(args.minFacts) : 3;
      const limit = Number.isInteger(Number(args.limit)) ? Math.min(50, Math.max(1, Number(args.limit))) : 12;
      const gaps = await coverageGaps(minFacts, limit);
      const subjectNames = gaps.thinSubjects.map((s) => `${s.subject} (${s.fact_count})`);
      return {
        result: gaps,
        card: {
          id: newCardId("gaps"),
          tool: name,
          title: "Coverage gaps",
          summary: subjectNames.length
            ? `Thin subjects: ${subjectNames.slice(0, 8).join(", ")}`
            : "No thin subjects at this threshold.",
          applyKind: "none",
        },
      };
    }
    case "enqueue_subject":
    case "enqueue_playlist": {
      const subject = String(args.subject ?? args.playlist ?? "").trim();
      if (!subject) return { result: { error: "subject or playlist is required" } };
      const priorityRaw = Number(args.priority);
      const priority = Number.isInteger(priorityRaw) ? Math.min(100, Math.max(0, priorityRaw)) : 5;
      const refresh = args.refresh === true;
      const enqueued = await enqueueCrawl({ subject, priority, refresh });
      const names = enqueued.items.map((item) => item.subject);
      return {
        result: {
          expandedFrom: enqueued.expandedFrom,
          count: enqueued.items.length,
          subjects: names,
          wrote_fact_bank: false,
        },
        card: {
          id: newCardId("enqueue"),
          tool: name,
          title: enqueued.expandedFrom ? `Queued playlist ${enqueued.expandedFrom}` : `Queued ${subject}`,
          summary: `${enqueued.items.length} crawl_queue job(s). Foundry verifies; chat does not write fact_bank.`,
          applyKind: "none",
        },
      };
    }
    case "list_queue": {
      const status = String(args.status ?? "").trim();
      const items = await listCrawlQueue({ status: status || undefined });
      return {
        result: {
          count: items.length,
          items: items.slice(0, 30).map((item) => ({
            id: item.id,
            subject: item.subject,
            status: item.status,
            priority: item.priority,
            requested_by: item.requested_by,
          })),
        },
        card: {
          id: newCardId("queue"),
          tool: name,
          title: status ? `Queue (${status})` : "Crawl queue",
          summary: items.length
            ? items
                .slice(0, 8)
                .map((item) => `${item.subject}: ${item.status}`)
                .join(" | ")
            : "Queue is empty.",
          applyKind: "none",
        },
      };
    }
    case "trigger_foundry": {
      const dispatched = await triggerFoundryWorkflow();
      return {
        result: dispatched,
        card: {
          id: newCardId("foundry"),
          tool: name,
          title: dispatched.ok ? "Foundry dispatched" : "Foundry not dispatched",
          summary: dispatched.message,
          applyKind: "none",
        },
      };
    }
    case "save_daily_draft": {
      if (ctx.surface !== "autonomous") {
        return {
          result: {
            error: "save_daily_draft is autonomous-only. Guided chat uses Apply cards, then Save & Schedule.",
          },
        };
      }
      const date = String(args.date ?? ctx.date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return { result: { error: "date must be YYYY-MM-DD" } };
      }
      const live = await getDailyPack(date);
      if (live) {
        return { result: { error: `Live daily_packs/${date} already exists. Chat cannot overwrite it.` } };
      }
      const category = String(args.category ?? ctx.topic ?? DAILY_BLITZ_FALLBACK_CATEGORY);
      const brief = String(args.brief ?? ctx.brief ?? "");
      const rounds = Array.isArray(args.rounds) ? args.rounds : ctx.rounds;
      const draft = await writeDailyDraft({
        date,
        category,
        brief,
        rounds,
        source: "strategist",
      });
      return {
        result: {
          date: draft.date,
          status: draft.status,
          total_rounds: draft.total_rounds,
          published: false,
          collection: "daily_pack_drafts",
        },
        card: {
          id: newCardId("draft"),
          tool: name,
          title: `Draft saved for ${date}`,
          summary: `awaiting_review in daily_pack_drafts. Live publish still requires Save & Schedule.`,
          applyKind: "none",
        },
      };
    }
    default:
      return { result: { error: `Unknown tool ${name}` } };
  }
}
