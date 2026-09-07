/** Shared Daily Blitz authoring types and pure helpers (safe for client + server). */

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
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function canonicalToken(value: unknown): string | null {
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value)) return String(value);
    return String(value);
  }
  return null;
}

const DERIVATION_KINDS = new Set([
  "year",
  "count",
  "percentage",
  "ratio",
  "physical_measure",
  "money",
  "duration",
  "rating",
]);
const DERIVATION_TRAPS = new Set(["OVERESTIMATE", "UNDERESTIMATE"]);

export function parseDerivationBlock(raw: unknown): FactDerivationBlock | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const modelVersion = rec.model_version;
  if (typeof modelVersion !== "string" || modelVersion === "") return null;
  if (typeof rec.quantity_kind !== "string" || !DERIVATION_KINDS.has(rec.quantity_kind)) return null;
  if (typeof rec.trap_direction !== "string" || !DERIVATION_TRAPS.has(rec.trap_direction)) return null;
  const plausibleMin = canonicalToken(rec.plausible_min);
  const plausibleMax = canonicalToken(rec.plausible_max);
  if (!plausibleMin || !plausibleMax) return null;

  const rawDistractors = Array.isArray(rec.distractors) ? rec.distractors : [];
  const distractors: FactDerivationDistractor[] = [];
  for (const item of rawDistractors) {
    const d = asRecord(item);
    if (!d) continue;
    const surprise = typeof d.surprise_factor === "number" ? d.surprise_factor : Number(d.surprise_factor);
    if (!Number.isInteger(surprise) || surprise < 0 || surprise > 3) continue;
    if (d.side !== "MORE" && d.side !== "LESS") continue;
    const presented = canonicalToken(d.presented_number);
    if (!presented) continue;
    distractors.push({
      surprise_factor: surprise,
      side: d.side,
      presented_number: presented,
    });
  }

  const block: FactDerivationBlock = {
    model_version: modelVersion,
    quantity_kind: rec.quantity_kind,
    trap_direction: rec.trap_direction,
    plausible_min: plausibleMin,
    plausible_max: plausibleMax,
    distractors,
  };
  if (Number.isInteger(rec.canonical_surprise_factor)) {
    block.canonical_surprise_factor = rec.canonical_surprise_factor as number;
  }
  return block;
}

export function pickGatedDistractor(
  block: FactDerivationBlock | null | undefined,
  trueNumber: number,
  preferredSide?: "MORE" | "LESS",
  surprise = 2,
): { presented: number; side: "MORE" | "LESS" } | null {
  if (!block?.distractors.length) return null;
  const usable = block.distractors
    .map((d) => {
      const presented = Number(d.presented_number);
      if (!Number.isFinite(presented) || presented === trueNumber) return null;
      const side = directionFromNumbers(trueNumber, presented);
      return { presented, side, surprise: d.surprise_factor, labeled: d.side };
    })
    .filter((d): d is NonNullable<typeof d> => d !== null);

  if (!usable.length) return null;

  const ranked = usable.slice().sort((a, b) => {
    const sideScore = (item: typeof a) => (preferredSide && item.side === preferredSide ? 0 : 1);
    const surpriseScore = (item: typeof a) => (item.surprise === surprise ? 0 : 1);
    return sideScore(a) - sideScore(b) || surpriseScore(a) - surpriseScore(b);
  });
  const best = ranked[0];
  return { presented: best.presented, side: best.side };
}

export function numberlessClaim(question: string, fallback: string): string {
  const q = question.trim();
  if (q && !/\d/.test(q)) return q;
  const stripped = q.replace(/\d+(?:\.\d+)?/g, "").replace(/\s{2,}/g, " ").trim();
  if (stripped.length >= 8) return stripped;
  return fallback;
}

export function factToBlitzRound(input: {
  factId?: string;
  subject: string;
  question?: string;
  angle?: string;
  context?: string;
  fact?: string;
  unit: string;
  true_number: number;
  surprise_factor?: number | null;
  derivation?: FactDerivationBlock | null;
  preferredSide?: "MORE" | "LESS";
  round_number: number;
  topic?: string;
}): { round: EditableRound } | { error: string } {
  const trueNum = Number(input.true_number);
  if (!Number.isFinite(trueNum)) {
    return { error: "Fact is missing a finite true_number." };
  }
  const surprise =
    typeof input.surprise_factor === "number" && Number.isFinite(input.surprise_factor)
      ? Math.min(3, Math.max(0, Math.round(input.surprise_factor)))
      : 2;
  const picked = pickGatedDistractor(input.derivation, trueNum, input.preferredSide, surprise);
  if (!picked) {
    return {
      error:
        "This fact has no DDM-gated distractor. Draft with the Go agent or pick another fact from the bank.",
    };
  }

  const fallback = [input.subject, input.angle].filter(Boolean).join(" - ") || input.subject;
  const explanation =
    (input.context || input.fact || "").trim() || `${input.subject}'s true value is ${trueNum} ${input.unit}.`;

  return {
    round: {
      round_number: input.round_number,
      topic: (input.topic || input.subject || "").trim(),
      claim_statement: numberlessClaim(input.question || "", fallback),
      presented_number: picked.presented,
      true_number: trueNum,
      unit: input.unit || "",
      correct_direction: picked.side,
      explanation,
      surprise_factor: surprise,
      difficulty: "casual",
      quantity_kind: input.derivation?.quantity_kind,
      trap_direction: input.derivation?.trap_direction,
      plausible_min: input.derivation ? Number(input.derivation.plausible_min) : undefined,
      plausible_max: input.derivation ? Number(input.derivation.plausible_max) : undefined,
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
    `Unfilled dates in the strip (Sports bank cycle until saved): ${
      input.unfilledDates.length ? input.unfilledDates.join(", ") : "none"
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
      surprise_factor: Number(rec.surprise_factor ?? 2),
      difficulty: rec.difficulty === "medium" || rec.difficulty === "hard" ? rec.difficulty : "casual",
      quantity_kind: typeof rec.quantity_kind === "string" ? rec.quantity_kind : undefined,
      trap_direction: typeof rec.trap_direction === "string" ? rec.trap_direction : undefined,
      plausible_min: typeof rec.plausible_min === "number" ? rec.plausible_min : undefined,
      plausible_max: typeof rec.plausible_max === "number" ? rec.plausible_max : undefined,
      source: "go",
    };
  });
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
      surprise_factor: Number(r.surprise_factor),
      difficulty: r.difficulty || "casual",
      ...(r.quantity_kind ? { quantity_kind: r.quantity_kind } : {}),
      ...(r.trap_direction ? { trap_direction: r.trap_direction } : {}),
      ...(r.plausible_min !== undefined ? { plausible_min: r.plausible_min } : {}),
      ...(r.plausible_max !== undefined ? { plausible_max: r.plausible_max } : {}),
    };
  });
}
