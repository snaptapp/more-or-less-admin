/** Shared Daily Blitz authoring types and pure helpers (safe for client + server). */
import { deriveWithPrecompute, toPrecomputedDerivation } from "./ddm-precompute";
import {
  DDMVersion,
  schemaIngestRaw,
  type DerivationResult,
  type FixedPointValue,
  type RawSchemaRound,
} from "../../../shared/ddm/derivation";

export const DAILY_BLITZ_ROUNDS = 15;
export const DAILY_BLITZ_SECONDS = 60;
export const DAILY_BLITZ_FALLBACK_CATEGORY = "Sports";

export const BLITZ_CATEGORIES = [
  "Sports",
  "Animals & Nature",
  "Science & Space",
  "Music",
  "Movies & TV",
  "Pop Culture & Records",
  "History & World",
  "Food & Drink",
  "Technology",
  "Money & Business",
  "General",
] as const;

export interface FactDerivationDistractor {
  surprise_factor: number;
  side: "MORE" | "LESS";
  presented_number: string;
}

export interface FactDerivationBlock {
  model_version: string;
  quantity_kind: string;
  trap_direction: string;
  plausible_min: string;
  plausible_max: string;
  canonical_surprise_factor?: number;
  distractors: FactDerivationDistractor[];
}

export interface EditableRound {
  round_number: number;
  topic: string;
  claim_statement: string;
  presented_number: number | string;
  true_number: number | string;
  unit: string;
  correct_direction: "MORE" | "LESS";
  explanation: string;
  surprise_factor: number;
  difficulty: "casual" | "medium" | "hard";
  quantity_kind?: string;
  trap_direction?: string;
  plausible_min?: number;
  plausible_max?: number;
  source?: "go" | "fact_bank";
  fact_id?: string;
}

export interface ChatCard {
  id: string;
  tool: string;
  title: string;
  summary: string;
  applyKind?: "pack" | "round" | "none";
  date?: string;
  topic?: string;
  roundIndex?: number;
  rounds?: EditableRound[];
  round?: EditableRound;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  cards?: ChatCard[];
}

export interface PromptSuggestion {
  id: string;
  label: string;
  prompt: string;
}

export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addUtcDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function formatDateLabel(dateStr: string): string {
  const t = utcToday();
  if (dateStr === t) return "Today";
  if (dateStr === addUtcDays(t, 1)) return "Tomorrow";
  if (dateStr === addUtcDays(t, -1)) return "Yesterday";
  const d = new Date(dateStr + "T00:00:00Z");
  return d.toLocaleDateString(undefined, {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** Calendar strip: yesterday through 14 days ahead. */
export function calendarStripDates(from = utcToday()): string[] {
  const dates: string[] = [];
  for (let offset = -1; offset <= 14; offset++) dates.push(addUtcDays(from, offset));
  return dates;
}

export function emptyRound(roundNumber: number, topic = ""): EditableRound {
  return {
    round_number: roundNumber,
    topic,
    claim_statement: "",
    presented_number: "",
    true_number: "",
    unit: "",
    correct_direction: "MORE",
    explanation: "",
    surprise_factor: 2,
    difficulty: "casual",
  };
}

export function directionFromNumbers(trueNumber: number, presentedNumber: number): "MORE" | "LESS" {
  return trueNumber > presentedNumber ? "MORE" : "LESS";
}

export function clampSurprise(raw: unknown): number {
  const s = Number(raw ?? 2);
  if (!Number.isFinite(s)) return 2;
  return Math.min(3, Math.max(0, Math.round(s)));
}

export function roundReadyToSchedule(round: {
  claim_statement?: unknown;
  unit?: unknown;
  explanation?: unknown;
  true_number?: unknown;
  presented_number?: unknown;
}): boolean {
  const trueNum = Number(round.true_number);
  const presented = Number(round.presented_number);
  return Boolean(
    String(round.claim_statement ?? "").trim() &&
    String(round.unit ?? "").trim() &&
    String(round.explanation ?? "").trim() &&
    Number.isFinite(trueNum) &&
    Number.isFinite(presented) &&
    trueNum !== presented,
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

const DDM_DISTRACTOR_ERROR =
  "This fact has no DDM-gated distractor. Draft with the Go agent or pick another fact from the bank.";

/**
 * Parses a Firestore derivation block at the current production DDM boundary.
 *
 * A block is never accepted merely because its version is non-empty: the
 * version must equal the vendored kernel's `DDMVersion`. Structural conversion
 * is delegated to the same adapter used by the runtime, so malformed blocks
 * cannot enter the editor as apparently usable derivation metadata.
 */
export function parseDerivationBlock(raw: unknown): FactDerivationBlock | null {
  const rec = asRecord(raw);
  if (!rec || rec.model_version !== DDMVersion) return null;

  let converted: ReturnType<typeof toPrecomputedDerivation>;
  try {
    converted = toPrecomputedDerivation(raw);
  } catch {
    return null;
  }
  if (!converted || converted.modelVersion !== DDMVersion) return null;

  const block: FactDerivationBlock = {
    model_version: converted.modelVersion,
    quantity_kind: converted.quantityKind,
    trap_direction: converted.trapDirection,
    plausible_min: converted.plausibleMin,
    plausible_max: converted.plausibleMax,
    distractors: converted.distractors.map((entry) => ({
      surprise_factor: entry.surpriseFactor,
      side: entry.side,
      presented_number: entry.presentedNumber,
    })),
  };
  if (rec.canonical_surprise_factor !== undefined) {
    if (
      typeof rec.canonical_surprise_factor !== "number" ||
      !Number.isInteger(rec.canonical_surprise_factor) ||
      rec.canonical_surprise_factor < 0 ||
      rec.canonical_surprise_factor > 3
    ) {
      return null;
    }
    block.canonical_surprise_factor = rec.canonical_surprise_factor;
  }
  return block;
}

/**
 * Legacy-compatible distractor helper.
 *
 * It now delegates to the same vendored DDM path as fact-to-round assembly;
 * stored candidate fields are never used as an independent selection oracle.
 * Callers that have a unit or fact-level semantic hints should use
 * {@link factToBlitzRound}, which preserves that input context.
 */
export function pickGatedDistractor(
  block: FactDerivationBlock | null | undefined,
  trueNumber: number,
  preferredSide?: "MORE" | "LESS",
  surprise = 2,
): { presented: number; side: "MORE" | "LESS" } | null {
  if (block?.model_version !== DDMVersion) return null;
  try {
    const trueNumberToken = ddmToken(trueNumber);
    if (trueNumberToken === null) return null;
    const ingest = schemaIngestRaw(
      { trueNumberToken, unit: "", surpriseFactor: surprise },
      preferredSide,
    ).input;
    if (!ingest) return null;

    const result = deriveWithPrecompute(ingest, block, { forcedSide: preferredSide });
    const success = result.success;
    if (!success) return null;
    const presented = fixedToNumber(success.presentedNumber);
    if (!Number.isFinite(presented) || presented === trueNumber) return null;
    return { presented, side: success.correctDirection };
  } catch {
    return null;
  }
}

export function numberlessClaim(question: string, fallback: string): string {
  const q = question.trim();
  if (q && !/\d/.test(q)) return q;
  const stripped = q.replace(/\d+(?:\.\d+)?/g, "").replace(/\s{2,}/g, " ").trim();
  if (stripped.length >= 8) return stripped;
  return fallback;
}

interface FactToBlitzInput {
  factId?: string;
  subject: string;
  question?: string;
  angle?: string;
  context?: string;
  fact?: string;
  unit: string;
  true_number: number;
  surprise_factor?: number | null;
  /** Authoritative fact-level semantic hints; these are independent of a stored precompute block. */
  quantity_kind?: string | null;
  plausible_min?: string | number | null;
  plausible_max?: string | number | null;
  derivation?: FactDerivationBlock | null;
  preferredSide?: "MORE" | "LESS";
  round_number: number;
  topic?: string;
}

function ddmToken(value: unknown): string | null {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function fixedToNumber(value: FixedPointValue): number {
  // The DDM has already validated the exact fixed-point value. This is the
  // single post-derivation conversion to the editor/wire number type.
  const magnitude = value.scale === 0 ? value.mantissa : value.mantissa / 10 ** value.scale;
  return value.negative ? -magnitude : magnitude;
}

/** Builds the allowlisted input without ever copying fields from a precompute block. */
function buildDerivationInput(input: FactToBlitzInput, trueNumber: number, surprise: number) {
  const trueNumberToken = ddmToken(trueNumber);
  if (trueNumberToken === null) return null;

  const raw: RawSchemaRound = {
    trueNumberToken,
    unit: input.unit || "",
    surpriseFactor: surprise,
  };
  if (typeof input.quantity_kind === "string" && input.quantity_kind.trim() !== "") {
    raw.quantityKind = input.quantity_kind;
  }

  const min = ddmToken(input.plausible_min);
  const max = ddmToken(input.plausible_max);
  if (min !== null && max !== null) {
    raw.plausibleMinToken = min;
    raw.plausibleMaxToken = max;
  }

  return schemaIngestRaw(raw, input.preferredSide).input;
}

/** Runs the current DDM with precompute re-gating and a block-free live retry. */
function deriveBlitz(input: FactToBlitzInput, trueNumber: number, surprise: number): DerivationResult | null {
  try {
    const derivationInput = buildDerivationInput(input, trueNumber, surprise);
    if (derivationInput === undefined || derivationInput === null) return null;
    return deriveWithPrecompute(derivationInput, input.derivation, {
      forcedSide: input.preferredSide,
    });
  } catch {
    return null;
  }
}

export function factToBlitzRound(input: FactToBlitzInput): { round: EditableRound } | { error: string } {
  const trueNum = Number(input.true_number);
  if (!Number.isFinite(trueNum)) {
    return { error: "Fact is missing a finite true_number." };
  }
  // Preserve the authored/legacy value until the DDM canonicalizes it. Clamping
  // here would collapse legacy 7→3 before the production table can map it to 2.
  const surprise =
    typeof input.surprise_factor === "number" && Number.isFinite(input.surprise_factor)
      ? input.surprise_factor
      : 2;
  const derived = deriveBlitz(input, trueNum, surprise);
  const success = derived?.success;
  if (!success) return { error: DDM_DISTRACTOR_ERROR };

  const presented = fixedToNumber(success.presentedNumber);
  const plausibleMin = fixedToNumber(success.plausibleMin);
  const plausibleMax = fixedToNumber(success.plausibleMax);
  if (
    !Number.isFinite(presented) ||
    !Number.isFinite(plausibleMin) ||
    !Number.isFinite(plausibleMax) ||
    presented === trueNum ||
    plausibleMin > plausibleMax ||
    directionFromNumbers(trueNum, presented) !== success.correctDirection
  ) {
    return { error: DDM_DISTRACTOR_ERROR };
  }

  const fallback = [input.subject, input.angle].filter(Boolean).join(" - ") || input.subject;
  const explanation =
    (input.context || input.fact || "").trim() || `${input.subject}'s true value is ${trueNum} ${input.unit}.`;

  return {
    round: {
      round_number: input.round_number,
      topic: (input.topic || input.subject || "").trim(),
      claim_statement: numberlessClaim(input.question || "", fallback),
      presented_number: presented,
      true_number: trueNum,
      unit: input.unit || "",
      correct_direction: success.correctDirection,
      explanation,
      surprise_factor: success.surpriseFactor,
      difficulty: "casual",
      quantity_kind: success.quantityKind,
      trap_direction: success.trapDirection,
      plausible_min: plausibleMin,
      plausible_max: plausibleMax,
      source: "fact_bank",
      fact_id: input.factId,
    },
  };
}

export function moreLessMix(rounds: EditableRound[]): { more: number; less: number } {
  let more = 0;
  let less = 0;
  for (const r of rounds) {
    const t = Number(r.true_number);
    const p = Number(r.presented_number);
    if (!Number.isFinite(t) || !Number.isFinite(p) || t === p) continue;
    if (directionFromNumbers(t, p) === "MORE") more += 1;
    else less += 1;
  }
  return { more, less };
}

export function draftContextSummary(input: {
  date: string;
  topic: string;
  brief: string;
  rounds: EditableRound[];
  unfilledDates: string[];
}): string {
  const filled = input.rounds.filter((r) => String(r.claim_statement || "").trim());
  const mix = moreLessMix(filled);
  const lines = filled.slice(0, DAILY_BLITZ_ROUNDS).map((r) => {
    const t = r.true_number === "" ? "?" : r.true_number;
    const p = r.presented_number === "" ? "?" : r.presented_number;
    return `${r.round_number}. ${r.correct_direction} | ${r.claim_statement} | presented ${p} vs true ${t} ${r.unit}`.trim();
  });
  return [
    `Selected date: ${input.date}`,
    `Topic / category: ${input.topic || "(none)"}`,
    `Last brief: ${input.brief.trim() || "(none)"}`,
    `Draft rounds: ${filled.length}/${DAILY_BLITZ_ROUNDS} (MORE ${mix.more} / LESS ${mix.less})`,
    `Unfilled dates in the strip (Sports bank cycle until saved): ${input.unfilledDates.length ? input.unfilledDates.join(", ") : "none"
    }`,
    filled.length ? `Current draft:\n${lines.join("\n")}` : "Current draft: empty",
  ].join("\n");
}

export function mapPackRounds(rawRounds: unknown[], fallbackTopic: string): EditableRound[] {
  return rawRounds.map((item, i) => {
    const rec = asRecord(item) ?? {};
    const trueNum = Number(rec.true_number);
    const presented = Number(rec.presented_number);
    const direction =
      Number.isFinite(trueNum) && Number.isFinite(presented) && trueNum !== presented
        ? directionFromNumbers(trueNum, presented)
        : rec.correct_direction === "LESS"
          ? "LESS"
          : "MORE";
    return {
      round_number: i + 1,
      topic: String(rec.topic ?? fallbackTopic ?? ""),
      claim_statement: String(rec.claim_statement ?? rec.claim ?? ""),
      presented_number: Number.isFinite(presented) ? presented : "",
      true_number: Number.isFinite(trueNum) ? trueNum : "",
      unit: String(rec.unit ?? ""),
      correct_direction: direction,
      explanation: String(rec.explanation ?? ""),
      surprise_factor: clampSurprise(rec.surprise_factor),
      difficulty: rec.difficulty === "medium" || rec.difficulty === "hard" ? rec.difficulty : "casual",
      quantity_kind: typeof rec.quantity_kind === "string" ? rec.quantity_kind : undefined,
      trap_direction: typeof rec.trap_direction === "string" ? rec.trap_direction : undefined,
      plausible_min: typeof rec.plausible_min === "number" ? rec.plausible_min : undefined,
      plausible_max: typeof rec.plausible_max === "number" ? rec.plausible_max : undefined,
      source: "go",
    };
  });
}

/**
 * Coerces raw pack rows into complete EditableRound entries.
 * Drops objects that lack a claim, unit, explanation, or unequal true/presented numbers.
 *
 * @param rawRounds - Untrusted round payloads
 * @param fallbackTopic - Topic used when a row omits one
 * @returns Validated rounds, re-numbered from 1
 */
export function sanitizeDraftRounds(rawRounds: unknown[], fallbackTopic: string): EditableRound[] {
  const source = Array.isArray(rawRounds) ? rawRounds : [];
  return mapPackRounds(source, fallbackTopic)
    .filter((round) => roundReadyToSchedule(round))
    .map((round, i) => ({ ...round, round_number: i + 1 }));
}

export function schedulePayload(rounds: EditableRound[], category: string) {
  return rounds.map((r, i) => {
    const trueNum = Number(r.true_number);
    const presented = Number(r.presented_number);
    return {
      round_number: i + 1,
      topic: r.topic.trim() || category,
      claim_statement: r.claim_statement.trim(),
      presented_number: presented,
      true_number: trueNum,
      unit: r.unit.trim(),
      correct_direction: Number.isFinite(trueNum) && Number.isFinite(presented)
        ? directionFromNumbers(trueNum, presented)
        : r.correct_direction,
      explanation: r.explanation.trim(),
      surprise_factor: clampSurprise(r.surprise_factor),
      difficulty: r.difficulty || "casual",
      ...(r.quantity_kind ? { quantity_kind: r.quantity_kind } : {}),
      ...(r.trap_direction ? { trap_direction: r.trap_direction } : {}),
      ...(r.plausible_min !== undefined ? { plausible_min: r.plausible_min } : {}),
      ...(r.plausible_max !== undefined ? { plausible_max: r.plausible_max } : {}),
    };
  });
}
