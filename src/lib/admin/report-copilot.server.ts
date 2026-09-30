/**
 * Report review copilot. Read-only: asks Gemini (Vertex, Google Search grounding)
 * for a verdict on a disputed fact. Never writes Firestore — a human applies
 * any suggestion through the existing Apply & Resolve editor.
 */
import { getAccessToken } from "../firebase/credentials.server";
import { asJsonObject, isAbortError, responseSnippet } from "./http";

const MODEL_ID = "gemini-3.8-flash";

export type CopilotVerdict = "uphold_fact" | "fix_number" | "edit_fact" | "retire_fact" | "unclear";

export interface CopilotSource {
  url: string;
  title: string;
  excerpts: string[];
}

export interface CopilotReview {
  verdict: CopilotVerdict;
  confidence: "low" | "medium" | "high";
  rationale: string;
  suggested: {
    true_number?: number;
    unit?: string;
    question?: string;
    claim_template?: string;
    context?: string;
    note?: string;
  };
  sources: CopilotSource[];
  model: string;
}

export interface CopilotInput {
  topic: string;
  claimStatement: string;
  presentedNumber: number | null;
  trueNumber: number | null;
  unit: string;
  reason: string;
  feedbackText: string;
  fact?: {
    subject: string;
    angle: string;
    question: string;
    claim_template: string;
    true_number: number | null;
    unit: string;
    context: string;
    source_urls: string[];
  } | null;
}

const VERDICTS: CopilotVerdict[] = ["uphold_fact", "fix_number", "edit_fact", "retire_fact", "unclear"];

function vertexUrl(): string {
  const id = process.env["GOOGLE_CLOUD_PROJECT"]?.trim() || process.env["FIREBASE_PROJECT_ID"]?.trim();
  if (!id) throw new Error("GOOGLE_CLOUD_PROJECT or FIREBASE_PROJECT_ID must be configured");
  const loc = (process.env["VERTEX_LOCATION"] ?? "global").trim() || "global";
  return `https://aiplatform.googleapis.com/v1/projects/${id}/locations/${loc}/publishers/google/models/${MODEL_ID}:generateContent`;
}

const SYSTEM = `You are the moderation copilot for "More or Less", a numeric trivia game.
A player disputed a fact. Use Google Search to verify the true number. Respond with ONLY a JSON object:
{"verdict":"uphold_fact|fix_number|edit_fact|retire_fact|unclear","confidence":"low|medium|high","rationale":"2-4 sentences","suggested":{"true_number":number?,"unit":string?,"question":string?,"claim_template":string? (must contain {n}),"context":string?,"note":string (short resolution note)},"sources":[{"url":string,"title":string,"excerpt":"verbatim quote supporting the number"}]}
Rules: uphold_fact when the stored number is right. fix_number when only the number is wrong. edit_fact when unit/wording is ambiguous or wrong. retire_fact when the fact is unverifiable or inherently ambiguous. Only include suggested fields you would change. true_number must be a single finite number, never a range.`;

function clean(value: unknown, max = 800): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t ? t.slice(0, max) : undefined;
}

function parseJsonBlock(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return asJsonObject(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return null;
  }
}

export async function reviewReportWithCopilot(input: CopilotInput): Promise<CopilotReview> {
  const token = await getAccessToken(["https://www.googleapis.com/auth/cloud-platform"]);
  const prompt = JSON.stringify({ report: input }, null, 2);
  let response: Response;
  try {
    response = await fetch(vertexUrl(), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { role: "system", parts: [{ text: SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        tools: [{ googleSearch: {} }],
        generationConfig: { temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    if (isAbortError(err)) throw new Error("Copilot review timed out.");
    throw err;
  }
  if (!response.ok) {
    throw new Error(`Copilot review failed (${response.status}): ${await responseSnippet(response, 300)}`);
  }
  const payload = (await response.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; thought?: boolean }> };
      groundingMetadata?: {
        groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
        groundingSupports?: Array<{ segment?: { text?: string }; groundingChunkIndices?: number[] }>;
      };
    }>;
  };
  const cand = payload.candidates?.[0];
  const text = (cand?.content?.parts ?? [])
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
  const parsed = parseJsonBlock(text);
  if (!parsed) throw new Error("Copilot returned no structured verdict.");

  const verdict = VERDICTS.includes(parsed.verdict as CopilotVerdict) ? (parsed.verdict as CopilotVerdict) : "unclear";
  const confidence = ["low", "medium", "high"].includes(String(parsed.confidence))
    ? (parsed.confidence as CopilotReview["confidence"])
    : "low";
  const s = asJsonObject(parsed.suggested) ?? {};
  const num = typeof s.true_number === "number" ? s.true_number : Number(s.true_number);
  const template = clean(s.claim_template);
  const suggested: CopilotReview["suggested"] = {
    true_number: s.true_number !== undefined && Number.isFinite(num) ? num : undefined,
    unit: clean(s.unit, 60),
    question: clean(s.question, 300),
    claim_template: template && template.includes("{n}") ? template : undefined,
    context: clean(s.context, 600),
    note: clean(s.note, 300),
  };

  // Sources: grounding metadata (authoritative links) + model-quoted excerpts.
  const byUrl = new Map<string, CopilotSource>();
  const chunks = cand?.groundingMetadata?.groundingChunks ?? [];
  chunks.forEach((c) => {
    const url = c.web?.uri;
    if (url && !byUrl.has(url)) byUrl.set(url, { url, title: c.web?.title || url, excerpts: [] });
  });
  for (const support of cand?.groundingMetadata?.groundingSupports ?? []) {
    const seg = clean(support.segment?.text, 400);
    if (!seg || seg.startsWith("{")) continue;
    for (const idx of support.groundingChunkIndices ?? []) {
      const url = chunks[idx]?.web?.uri;
      const src = url ? byUrl.get(url) : undefined;
      if (src && src.excerpts.length < 3 && !src.excerpts.includes(seg)) src.excerpts.push(seg);
    }
  }
  if (Array.isArray(parsed.sources)) {
    for (const raw of parsed.sources.slice(0, 6)) {
      const row = asJsonObject(raw);
      const url = clean(row?.url, 500);
      if (!url || !/^https?:\/\//i.test(url)) continue;
      const excerpt = clean(row?.excerpt, 400);
      const title = clean(row?.title, 200) || url;
      const existing = [...byUrl.values()].find((v) => v.url === url || v.title === title);
      if (existing) {
        if (excerpt && !existing.excerpts.includes(excerpt)) existing.excerpts.unshift(excerpt);
      } else {
        byUrl.set(url, { url, title, excerpts: excerpt ? [excerpt] : [] });
      }
    }
  }

  return {
    verdict,
    confidence,
    rationale: clean(parsed.rationale, 1200) || "No rationale provided.",
    suggested,
    sources: [...byUrl.values()].slice(0, 8),
    model: MODEL_ID,
  };
}
