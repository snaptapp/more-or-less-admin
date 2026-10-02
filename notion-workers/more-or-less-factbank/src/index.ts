import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";
import type { JSONValue } from "@notionhq/workers/types";

function asJson(value: unknown): JSONValue {
  return JSON.parse(JSON.stringify(value)) as JSONValue;
}

/**
 * Notion Worker tools for More-or-Less Ops Assistant.
 *
 * Thin auth + normalization over Admin's read-only Ops API.
 * Does not reimplement Fact Bank validation or lifecycle logic.
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

async function opsGet(path: string): Promise<JSONValue> {
  const base = (process.env.OPS_API_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const secret = (process.env.OPS_ASSISTANT_SECRET ?? "").trim();
  if (!base) throw new Error("OPS_API_BASE_URL is not configured");
  if (!secret) throw new Error("OPS_ASSISTANT_SECRET is not configured");

  const response = await fetch(`${base}${path}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${secret}`,
    },
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

worker.tool("mol_system_snapshot", {
  title: "More or Less System Snapshot",
  description:
    "Use for 'Anything wrong with More or Less?' or 'What changed?'. Composes Fact Bank health, validation summary, anomalies, and deltas versus the previous snapshot. The Ops API persists tiny bookkeeping metadata in ops_assistant_snapshots/factbank_latest so later calls can compute change lines.",
  schema: j.object({
    include_validation: j
      .boolean()
      .describe("When true (default), include aggregated validation in the snapshot.")
      .nullable(),
  }),
  execute: async ({ include_validation }) => {
    const validation = include_validation === false ? "0" : "1";
    return opsGet(`/api/internal/ops/factbank/snapshot?validation=${validation}`);
  },
});
