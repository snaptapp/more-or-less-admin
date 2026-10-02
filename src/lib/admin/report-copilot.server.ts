/**
 * Report review copilot. Read-only: asks Gemini (Vertex, Google Search grounding)
 * for a verdict on a disputed fact. Never writes Firestore — a human applies
 * any suggestion through the existing Apply & Resolve editor.
 */
import { getAccessToken } from "../firebase/credentials.server";
import { asJsonObject, isAbortError, responseSnippet } from "./http";
import {
  scoreFactCandidateQuality,
  compareDuplicateCandidates,
  isDuplicateDecisionSafe,
  type DuplicateFactCandidate,
  type CandidateQualityScore,
  type MinimalReviewForSafety,
} from "./duplicate-resolution";

export {
  scoreFactCandidateQuality,
  compareDuplicateCandidates,
  isDuplicateDecisionSafe,
  type DuplicateFactCandidate,
  type CandidateQualityScore,
  type MinimalReviewForSafety,
};
export type CopilotFactCandidate = DuplicateFactCandidate;

const MODEL_ID = "gemini-3.8-flash";

export type CopilotVerdict =
  | "uphold_fact"
  | "fix_number"
  | "edit_fact"
  | "retire_fact"
  | "resolve_duplicate"
  | "add_to_bank"
  | "resolve_as_is"
  | "reject"
  | "unclear";

export interface CopilotSource {
  url: string;
  title: string;
  excerpts: string[];
  /** Number the source states, when the model extracted one. */
  value?: number;
  stance: "supports" | "contradicts" | "unclear";
  /** True when this source's value disagrees with the recommended number or other sources. */
  conflicting: boolean;
}

export interface CopilotDuplicateResolution {
  keepFactId: string | null;
  retireFactIds: string[];
  action: "keep_one" | "retire_all" | "reject_report";
  reason: string;
}

/**
 * Source-quality policy applied before any recommendation is shown:
 * - No sources: verdict forced to "unclear", confidence "low". Prefill is advisory only.
 * - Only 1 source: confidence capped at "medium".
 * - Sources disagree (>5% spread between stated values, or a source contradicts the
 *   recommended number): confidence capped at "low", each disagreeing source flagged.
 * - Model says "low": kept low; recommendation still shown but marked for closer review.
 * Any cap or flag sets needsReview so admins can prioritize.
 */
export interface CopilotPolicy {
  needsReview: boolean;
  reasons: string[];
  modelConfidence: "low" | "medium" | "high";
  score: number; // 0-100 for the meter
  /** Every input to the score, in order. Sum of points = score (clamped 0-100). */
  factors: CopilotFactor[];
}

export interface CopilotFactor {
  label: string;
  points: number;
  kind: "base" | "boost" | "penalty" | "cap";
  detail: string;
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
    subject?: string;
    angle?: string;
    quantity_kind?: string;
    surprise_factor?: number;
    plausible_min?: string;
    plausible_max?: string;
    difficulty_hint?: "casual" | "medium" | "hard";
  };
  duplicateResolution?: CopilotDuplicateResolution;
  sources: CopilotSource[];
  policy: CopilotPolicy;
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
  qualityFlags?: string[];
  fact?: {
    id?: string;
    subject: string;
    angle: string;
    question: string;
    claim_template: string;
    true_number: number | null;
    unit: string;
    context: string;
    source_urls: string[];
    quality_flags?: string[];
    status?: string;
    quantity_kind?: string;
    surprise_factor?: number;
  } | null;
  duplicateFacts?: CopilotFactCandidate[];
}

const VERDICTS: CopilotVerdict[] = [
  "uphold_fact",
  "fix_number",
  "edit_fact",
  "retire_fact",
  "resolve_duplicate",
  "add_to_bank",
  "resolve_as_is",
  "reject",
  "unclear",
];

function vertexUrl(): string {
  const id = process.env["GOOGLE_CLOUD_PROJECT"]?.trim() || process.env["FIREBASE_PROJECT_ID"]?.trim();
  if (!id) throw new Error("GOOGLE_CLOUD_PROJECT or FIREBASE_PROJECT_ID must be configured");
  const loc = (process.env["VERTEX_LOCATION"] ?? "global").trim() || "global";
  return `https://aiplatform.googleapis.com/v1/projects/${id}/locations/${loc}/publishers/google/models/${MODEL_ID}:generateContent`;
}

const SYSTEM = `You are the moderation copilot for "More or Less", a numeric trivia game.
A player disputed a fact or a linter flagged duplicate/conflicting facts. Use Google Search to verify the true number. Respond with ONLY a JSON object:
{"verdict":"uphold_fact|fix_number|edit_fact|retire_fact|resolve_duplicate|add_to_bank|resolve_as_is|reject|unclear","confidence":"low|medium|high","rationale":"2-4 sentences","suggested":{"true_number":number?,"unit":string?,"question":string?,"claim_template":string? (must contain {n}),"context":string?,"subject":string?,"angle":string?,"quantity_kind":string?,"surprise_factor":number?,"plausible_min":string?,"plausible_max":string?,"difficulty_hint":"casual|medium|hard"?,"note":string (short resolution note)},"duplicate_resolution":{"keep_fact_id":string|null,"retire_fact_ids":[string],"action":"keep_one|retire_all|reject_report","reason":string},"sources":[{"url":string,"title":string,"excerpt":"verbatim quote","value":number|null (the number this source states, in the fact's unit),"stance":"supports|contradicts|unclear" (relative to your recommended true number)}]}
Never invent excerpts; if sources disagree, say so in the rationale.
Rules:
- When duplicate candidate facts are present:
  - verdict should be resolve_duplicate (or retire_fact if all duplicates are invalid, or unclear if cannot be verified).
  - Compare all candidate facts (Fact A, Fact B, etc.).
  - TIE-BREAKING WHEN BOTH DUPLICATES HAVE THE CORRECT TRUE NUMBER:
    When multiple candidate facts have the correct verified true_number, choose which to keep using this strict hierarchy:
    1. Valid Claim Template: Mandatory requirement that claim_template contains '{n}' exactly once for reveal/export.
    2. Zero Quality Flags: Prefer facts with 0 linter quality flags over facts carrying flags (e.g. bounds_chart_position, ambiguous_unit).
    3. Grounding Citations: Prefer facts with non-empty, authoritative source_urls over facts without sources.
    4. Presented Card Prompt (NO question marks): The presented question is a card setup prompt displayed above the number orb. It MUST NOT contain a question mark ('?'), but MUST NOT be a sterile clinical label either. Prefer warm, engaging natural phrasing that sets up the orb (e.g. 'How many career Grammy Awards Stevie Wonder won' or 'A cheetah's top sprint speed in mph', NEVER 'How many ... did he win?' and NEVER sterile labels like 'Stevie Wonder Grammys').
    5. Explanation Depth: Prefer facts with educational, detailed context/explanation over stub/empty explanations.
    6. Lifecycle Stability: Prefer keeping an 'active' fact over 'disputed' or 'pending' if other criteria are equal.
  - In duplicate_resolution: set keep_fact_id to the ID of the chosen winner (or null if retiring all), retire_fact_ids to the IDs of losing duplicates to retire, action to "keep_one" (or "retire_all" if all are flawed, or "reject_report" if not actually duplicates), and reason explaining specifically why the winner was chosen (especially which tie-break factors decided the winner if both true numbers are correct).
  - If the kept fact's true_number needs correction to match verified ground truth, also provide suggested.true_number.
- When no fact exists in the fact bank (primaryFactA is null, AI trivia round report):
  - add_to_bank when the trivia claim is verifiable, factually correct, and an engaging numeric fact. Provide suggested: subject, angle, true_number, unit, claim_template (with {n}), context, and optional quantity_kind/surprise_factor/difficulty_hint.
  - reject when the claim is factually false, nonsensical, or cannot be verified.
- For single fact disputes (no duplicates):
  - uphold_fact or reject when the stored fact and number are correct (player was wrong).
  - fix_number when only the number is wrong.
  - edit_fact when question phrasing, unit, context, or plausible bounds need updating.
  - resolve_as_is when a fact was flagged with linter warnings but is verified correct and acceptable as-is (clearing false positive flags).
  - retire_fact when the fact is unverifiable, outdated, or fundamentally broken.
- Only include suggested fields you would change. true_number must be a single finite number, never a range.`;

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
  const promptPayload: Record<string, unknown> = {
    dispute: {
      topic: input.topic,
      claimStatement: input.claimStatement,
      presentedNumber: input.presentedNumber,
      storedTrueNumber: input.trueNumber,
      unit: input.unit,
      disputeReason: input.reason,
      qualityFlags: input.qualityFlags ?? [],
      playerFeedback: input.feedbackText,
    },
    primaryFactA: input.fact
      ? {
          id: input.fact.id,
          subject: input.fact.subject,
          angle: input.fact.angle,
          question: input.fact.question,
          claim_template: input.fact.claim_template,
          true_number: input.fact.true_number,
          unit: input.fact.unit,
          context: input.fact.context,
          source_urls: input.fact.source_urls,
          quality_flags: input.fact.quality_flags ?? [],
          status: input.fact.status,
        }
      : null,
  };
  if (input.duplicateFacts && input.duplicateFacts.length > 0) {
    promptPayload.candidateDuplicateFacts = input.duplicateFacts.map((d, idx) => ({
      label: `Duplicate Fact (${String.fromCharCode(66 + idx)})`,
      id: d.id,
      subject: d.subject,
      angle: d.angle,
      question: d.question,
      claim_template: d.claim_template,
      true_number: d.true_number,
      unit: d.unit,
      context: d.context,
      source_urls: d.source_urls ?? [],
      quality_flags: d.quality_flags ?? [],
      status: d.status,
    }));
  }
  const prompt = JSON.stringify(promptPayload, null, 2);
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
    subject: clean(s.subject, 120),
    angle: clean(s.angle, 120),
    quantity_kind: clean(s.quantity_kind, 60),
    surprise_factor: typeof s.surprise_factor === "number" && s.surprise_factor >= 0 && s.surprise_factor <= 3 ? s.surprise_factor : undefined,
    plausible_min: clean(s.plausible_min, 60),
    plausible_max: clean(s.plausible_max, 60),
    difficulty_hint: ["casual", "medium", "hard"].includes(String(s.difficulty_hint)) ? (s.difficulty_hint as "casual" | "medium" | "hard") : undefined,
  };

  const allCandidates: CopilotFactCandidate[] = [
    ...(input.fact ? [input.fact as CopilotFactCandidate] : []),
    ...(input.duplicateFacts ?? []),
  ];

  const tieBreakEval = allCandidates.length >= 2
    ? compareDuplicateCandidates(allCandidates, suggested.true_number ?? input.trueNumber)
    : null;

  // Duplicate resolution parsing
  const rawDup = asJsonObject(parsed.duplicate_resolution ?? parsed.duplicateResolution);
  let duplicateResolution: CopilotDuplicateResolution | undefined = undefined;
  if (rawDup) {
    const keepId = clean(rawDup.keep_fact_id ?? rawDup.keepFactId, 100) || tieBreakEval?.recommendedWinnerId || null;
    const rawRetire = Array.isArray(rawDup.retire_fact_ids)
      ? rawDup.retire_fact_ids
      : Array.isArray(rawDup.retireFactIds)
        ? rawDup.retireFactIds
        : tieBreakEval?.retireIds ?? [];
    const retireFactIds = rawRetire
      .map((id) => clean(id, 100))
      .filter((id): id is string => Boolean(id) && id !== keepId);
    const rawAction = String(rawDup.action ?? "");
    const action = (["keep_one", "retire_all", "reject_report"].includes(rawAction)
      ? rawAction
      : keepId
        ? "keep_one"
        : "retire_all") as CopilotDuplicateResolution["action"];
    let reason = clean(rawDup.reason, 600) || "";
    if (tieBreakEval && (!reason || reason.length < 30 || !reason.includes("Winner"))) {
      reason = reason ? `${reason} (${tieBreakEval.tieBreakReason})` : tieBreakEval.tieBreakReason;
    }

    duplicateResolution = {
      keepFactId: keepId,
      retireFactIds,
      action,
      reason: reason || "Duplicate evaluation completed.",
    };
  } else if (allCandidates.length >= 2) {
    const keepId = clean(parsed.keep_fact_id ?? parsed.keepFactId ?? s.keep_fact_id ?? s.keepFactId, 100) || tieBreakEval?.recommendedWinnerId || null;
    if (keepId || verdict === "resolve_duplicate") {
      const retireFactIds = allCandidates.map((c) => c.id).filter((id) => id !== keepId);
      duplicateResolution = {
        keepFactId: keepId,
        retireFactIds,
        action: keepId ? "keep_one" : "retire_all",
        reason: tieBreakEval?.tieBreakReason || clean(parsed.rationale, 600) || "Duplicate resolved via copilot evaluation.",
      };
    }
  }

  // Sources: grounding metadata (authoritative links) + model-quoted excerpts.
  const byUrl = new Map<string, CopilotSource>();
  const chunks = cand?.groundingMetadata?.groundingChunks ?? [];
  chunks.forEach((c) => {
    const url = c.web?.uri;
    if (url && !byUrl.has(url)) byUrl.set(url, { url, title: c.web?.title || url, excerpts: [], stance: "unclear", conflicting: false });
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
        byUrl.set(url, { url, title, excerpts: excerpt ? [excerpt] : [], stance: "unclear", conflicting: false });
      }
      const target = byUrl.get(url) ?? existing;
      if (target) {
        const v = typeof row?.value === "number" ? row.value : Number(row?.value);
        if (row?.value !== null && row?.value !== undefined && Number.isFinite(v)) target.value = v;
        const st = String(row?.stance);
        if (st === "supports" || st === "contradicts") target.stance = st;
      }
    }
  }

  const sources = [...byUrl.values()].slice(0, 8);
  const targetFact = duplicateResolution?.keepFactId
    ? (duplicateResolution.keepFactId === input.fact?.id
        ? input.fact
        : input.duplicateFacts?.find((d) => d.id === duplicateResolution!.keepFactId))
    : input.fact;
  const targetNumber = suggested.true_number ?? targetFact?.true_number ?? input.trueNumber;
  const policy = applySourcePolicy(sources, targetNumber, confidence);

  let finalVerdict = verdict;
  if (sources.length === 0) {
    finalVerdict = "unclear";
  } else if (duplicateResolution && (verdict === "uphold_fact" || verdict === "fix_number")) {
    finalVerdict = "resolve_duplicate";
  } else if (!input.fact?.id && (verdict === "uphold_fact" || verdict === "add_to_bank")) {
    finalVerdict = "add_to_bank";
  }

  return {
    verdict: finalVerdict,
    confidence: policy.confidence,
    rationale: clean(parsed.rationale, 1200) || "No rationale provided.",
    suggested,
    duplicateResolution,
    sources,
    policy: policy.policy,
    model: MODEL_ID,
  };
}

const RANK = { low: 0, medium: 1, high: 2 } as const;
const cap = (c: keyof typeof RANK, max: keyof typeof RANK) => (RANK[c] > RANK[max] ? max : c);

function differs(a: number, b: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / scale > 0.05;
}

export function applySourcePolicy(
  sources: CopilotSource[],
  target: number | null | undefined,
  modelConfidence: "low" | "medium" | "high",
): { confidence: "low" | "medium" | "high"; policy: CopilotPolicy } {
  const reasons: string[] = [];
  let confidence = modelConfidence;
  if (sources.length === 0) {
    confidence = "low";
    reasons.push("No sources returned; verdict set to unclear.");
  } else if (sources.length === 1) {
    confidence = cap(confidence, "medium");
    reasons.push("Only one source found.");
  }
  const valued = sources.filter((s) => s.value !== undefined);
  let conflict = false;
  for (const s of sources) {
    const vsTarget = s.value !== undefined && target != null && Number.isFinite(target) && differs(s.value, target);
    const vsOthers = s.value !== undefined && valued.some((o) => o !== s && differs(o.value!, s.value!));
    s.conflicting = s.stance === "contradicts" || vsTarget || vsOthers;
    if (s.conflicting) conflict = true;
  }
  if (conflict) {
    confidence = "low";
    reasons.push(`${sources.filter((s) => s.conflicting).length} source(s) conflict with the recommendation or each other.`);
  }
  if (modelConfidence === "low" && !reasons.length) reasons.push("Copilot reported low confidence.");
  const supporting = sources.filter((s) => !s.conflicting && s.stance === "supports");
  const conflicting = sources.filter((s) => s.conflicting);
  const withExcerpts = sources.filter((s) => s.excerpts.length > 0).length;
  const factors: CopilotFactor[] = [];
  const modelBase = { low: 25, medium: 60, high: 90 }[modelConfidence];
  factors.push({ label: "Copilot self-rating", points: modelBase, kind: "base", detail: `Model reported ${modelConfidence} confidence.` });
  const finalBase = { low: 25, medium: 60, high: 90 }[confidence];
  if (finalBase !== modelBase) {
    factors.push({
      label: "Source-quality cap",
      points: finalBase - modelBase,
      kind: "cap",
      detail: sources.length === 0 ? "No sources: capped at low." : conflict ? "Conflicting sources: capped at low." : "Single source: capped at medium.",
    });
  }
  if (supporting.length) {
    factors.push({
      label: "Supporting sources",
      points: Math.min(supporting.length, 3) * 3,
      kind: "boost",
      detail: `${supporting.length} source(s) agree with the recommended number (+3 each, max 3).`,
    });
  }
  if (conflict) {
    factors.push({ label: "Conflict penalty", points: -10, kind: "penalty", detail: `${conflicting.length} conflicting: ${conflicting.map((c) => c.title).slice(0, 3).join("; ")}` });
  }
  if (sources.length && withExcerpts === 0) {
    factors.push({ label: "No quoted evidence", points: -5, kind: "penalty", detail: "Sources returned links but no excerpts to check." });
    reasons.push("No source provided a quoted excerpt.");
  }
  const score = Math.max(0, Math.min(100, factors.reduce((sum, f) => sum + f.points, 0)));
  return {
    confidence,
    policy: { needsReview: confidence === "low" || reasons.length > 0, reasons, modelConfidence, score, factors },
  };
}
