import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";
import type { JSONValue } from "@notionhq/workers/types";

import { registerPortalTools } from "./portal-tools.js";

function asJson(value: unknown): JSONValue {
  return JSON.parse(JSON.stringify(value)) as JSONValue;
}

/**
 * Notion Worker tools for More-or-Less Ops Assistant.
 *
 * Thin auth + normalization over the Admin Ops API.
 * Fact Bank tools stay read-only. Moderation, players, Daily Blitz,
 * analytics, and Remote Config tools call the same admin-page actions.
 * Role grant and revoke are not exposed.
 *
 * Secrets:
 *   OPS_API_BASE_URL  e.g. https://ops.snaptapp.us
 *   OPS_ASSISTANT_SECRET  Bearer token for /api/internal/ops/*
 */
const worker = new Worker();
export default worker;

const DIMENSIONS = [
  "topic",
  "match_scope",
  "genre",
  "difficulty",
  "status",
  "source",
] as const;

function opsConfig(): { base: string; secret: string } {
  const base = (process.env.OPS_API_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const secret = (process.env.OPS_ASSISTANT_SECRET ?? "").trim();
  if (!base) throw new Error("OPS_API_BASE_URL is not configured");
  if (!secret) throw new Error("OPS_ASSISTANT_SECRET is not configured");
  return { base, secret };
}

async function opsCall(path: string, init?: { method?: "GET" | "POST"; body?: unknown }): Promise<JSONValue> {
  const { base, secret } = opsConfig();
  const response = await fetch(`${base}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${secret}`,
      ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof body === "object" &&
      body &&
      "error" in body &&
      typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : `Ops API HTTP ${response.status}`;
    throw new Error(message);
  }
  return asJson(body);
}

async function opsGet(path: string): Promise<JSONValue> {
  return opsCall(path);
}

worker.tool("factbank_health", {
  title: "Fact Bank Health",
  description:
    "Use for production Fact Bank health. Returns Firestore canonical counts, deployed serving snapshot, drift, and status. Call before answering whether production facts are healthy or in sync.",
  schema: j.object({}),
  hints: { readOnlyHint: true },
  execute: async () => opsGet("/api/internal/ops/factbank/health"),
});

worker.tool("factbank_breakdown", {
  title: "Fact Bank Breakdown",
  description:
    "Use when asked which topics, match scopes, genres, difficulties, statuses, or sources are underrepresented. Returns thinnest and densest buckets.",
  schema: j.object({
    dimension: j
      .enum(...DIMENSIONS)
      .describe("Aggregation dimension: topic, match_scope, genre, difficulty, status, or source."),
  }),
  hints: { readOnlyHint: true },
  execute: async ({ dimension }) =>
    opsGet(`/api/internal/ops/factbank/distribution?dimension=${encodeURIComponent(dimension)}`),
});

worker.tool("factbank_validate", {
  title: "Fact Bank Validate",
  description:
    "Use when asked about invalid facts, missing sources, or validation errors. Returns aggregated rule counts and a few examples, not every row.",
  schema: j.object({}),
  hints: { readOnlyHint: true },
  execute: async () => opsGet("/api/internal/ops/factbank/validation"),
});

worker.tool("factbank_duplicates", {
  title: "Fact Bank Duplicates",
  description:
    "Use when asked about duplicate or colliding facts. Distinguishes exact question text, same subject+value, and normalized comparison clusters.",
  schema: j.object({}),
  hints: { readOnlyHint: true },
  execute: async () => opsGet("/api/internal/ops/factbank/duplicates"),
});

worker.tool("factbank_drift", {
  title: "Fact Bank Drift",
  description:
    "Use when asked whether Firestore, export/serving, and KV are out of sync. Identifies the first divergent layer and recommends the publication boundary to inspect.",
  schema: j.object({}),
  hints: { readOnlyHint: true },
  execute: async () => opsGet("/api/internal/ops/factbank/drift"),
});

worker.tool("factbank_inspect", {
  title: "Fact Bank Inspect",
  description:
    "Use when asked to inspect a topic or match scope (for example 'Inspect Disco'). Returns matched subjects, active/pending counts, and validation examples.",
  schema: j.object({
    topic_or_scope: j
      .string()
      .describe("Topic name, match scope, genre fragment, or alias to inspect."),
  }),
  hints: { readOnlyHint: true },
  execute: async ({ topic_or_scope }) =>
    opsGet(`/api/internal/ops/factbank/inspect?q=${encodeURIComponent(topic_or_scope)}`),
});

const MODERATION_ACTIONS = [
  "retire_fact",
  "fix_number",
  "reject",
  "resolve_only",
  "add_to_bank",
  "resolve_duplicate",
  "edit_fact",
  "resolve_as_is",
] as const;

worker.tool("moderation_queue", {
  title: "Moderation Queue",
  description:
    "Use for the moderation inbox. count is the full number of pending_review reports. Each call returns at most 100 reports with the matched fact, duplicate facts, and buttons. If truncated is true, call again with offset set to next_offset until truncated is false. Cite count, not the page length.",
  schema: j.object({
    offset: j.number().nullable().describe("Page start. Null or 0 is the first page. Use next_offset when truncated is true."),
  }),
  hints: { readOnlyHint: true },
  execute: async ({ offset }) =>
    opsGet(`/api/internal/ops/moderation/queue?offset=${encodeURIComponent(String(offset ?? 0))}`),
});

worker.tool("moderation_copilot", {
  title: "Run Moderation Copilot",
  description:
    "Run the moderation copilot for one pending report. Read-only with respect to the fact: it returns a verdict, sources, and a recommended inbox button. recommendation.apply is false when the verdict is unclear or needs closer review. Do not press a button in that case.",
  schema: j.object({
    report_id: j.string().describe("trivia_reports id from moderation_queue."),
  }),
  execute: async ({ report_id }) =>
    opsCall("/api/internal/ops/moderation/copilot", {
      method: "POST",
      body: { reportId: report_id },
    }),
});

worker.tool("moderation_act", {
  title: "Press Moderation Button",
  description:
    "Press one moderation inbox button for one pending report. Use only an action listed in that report's buttons from moderation_queue. For fix_number and add_to_bank, pass corrected_number. For resolve_duplicate, pass keep_fact_id from the chosen Keep button. For edit_fact, pass fact_updates. After moderation_copilot, press the button only when recommendation.apply is true, using the recommendation's action and fields.",
  schema: j.object({
    report_id: j.string().describe("trivia_reports id from moderation_queue."),
    action: j.enum(...MODERATION_ACTIONS).describe("Inbox button action."),
    corrected_number: j.number().nullable().describe("Required for fix_number and add_to_bank."),
    keep_fact_id: j.string().nullable().describe("Required for resolve_duplicate. The fact id to keep."),
    note: j.string().nullable().describe("Optional resolution note."),
    fact_updates: j
      .object({
        question: j.string().nullable(),
        claim_template: j.string().nullable(),
        true_number: j.number().nullable(),
        unit: j.string().nullable(),
        context: j.string().nullable(),
        explanation: j.string().nullable(),
      })
      .nullable()
      .describe("Required for edit_fact. Only fields to change."),
  }),
  execute: async ({ report_id, action, corrected_number, keep_fact_id, note, fact_updates }) => {
    const updates =
      fact_updates === null
        ? undefined
        : {
            question: fact_updates.question ?? undefined,
            claim_template: fact_updates.claim_template ?? undefined,
            true_number: fact_updates.true_number ?? undefined,
            unit: fact_updates.unit ?? undefined,
            context: fact_updates.context ?? undefined,
            explanation: fact_updates.explanation ?? undefined,
          };
    return opsCall("/api/internal/ops/moderation/act", {
      method: "POST",
      body: {
        reportId: report_id,
        action,
        correctedNumber: corrected_number ?? undefined,
        keepFactId: keep_fact_id ?? undefined,
        note: note ?? undefined,
        factUpdates: updates,
      },
    });
  },
});

worker.tool("crawl_queue", {
  title: "Crawl Queue",
  description:
    "Use for the Fact Foundry crawl queue. Returns how many jobs are queued and the exact subjects, priorities, and statuses. This is not the moderation inbox and not the Fact Bank pending-admission count. Read-only: it does not enqueue.",
  schema: j.object({
    status: j
      .enum("queued", "processing", "done", "completed")
      .nullable()
      .describe("Optional status filter. Omit for the whole queue."),
  }),
  hints: { readOnlyHint: true },
  execute: async ({ status }) => {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    return opsGet(`/api/internal/ops/crawl/queue${query}`);
  },
});

worker.tool("mol_system_snapshot", {
  title: "More or Less System Snapshot",
  description:
    "Use for 'Anything wrong with More or Less?' or 'What changed?'. Composes Fact Bank health, validation summary, anomalies, and deltas versus the previous snapshot. Explicitly opts into persist=1 so Ops can record tiny bookkeeping in ops_assistant_snapshots/factbank_latest for later change lines.",
  schema: j.object({
    include_validation: j
      .boolean()
      .describe("When true (default), include aggregated validation in the snapshot.")
      .nullable(),
  }),
  execute: async ({ include_validation }) => {
    const validation = include_validation === false ? "0" : "1";
    return opsGet(
      `/api/internal/ops/factbank/snapshot?validation=${validation}&persist=1`,
    );
  },
});

registerPortalTools(worker, { get: opsGet, call: opsCall });
