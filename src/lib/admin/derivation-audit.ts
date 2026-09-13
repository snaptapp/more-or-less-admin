/**
 * Distractor Derivation Model (DDM) — Decision Audit Engine for More or Less Admin.
 *
 * Implements deterministic decision tracing for why agent-go and the DDM
 * presented a specific number, matching the normative tables in tests/fixtures/derivation_tables.json
 * and unit_tables.json.
 */

export const DDM_VERSION = "ddm-2";

export type QuantityKind =
  | "year"
  | "count"
  | "percentage"
  | "ratio"
  | "physical_measure"
  | "money"
  | "duration"
  | "rating";

export type DerivationStrategy = "additive" | "multiplicative" | "bounded";
export type TrapDirection = "OVERESTIMATE" | "UNDERESTIMATE";
export type CandidateSide = "MORE" | "LESS";

export interface DerivationMatrixRow {
  surprise: number;
  surpriseLabel: string;
  moreCandidate: number;
  lessCandidate: number;
  moreDelta: number;
  lessDelta: number;
  moreRatio: number;
  lessRatio: number;
  isWinningCandidate: boolean;
  winningSide?: CandidateSide;
}

export interface DerivationAuditTrace {
  input: {
    token: string;
    trueNumber: number;
    unit: string;
    rawSurprise: number;
    canonicalSurprise: number;
    trapDirection: TrapDirection;
    forcedSide?: CandidateSide;
    plausibleMin?: number;
    plausibleMax?: number;
  };
  classification: {
    quantityKind: QuantityKind;
    strategy: DerivationStrategy;
    matchedUnitRule: string;
    unitDescription: string;
  };
  band: {
    surprise: number;
    surpriseLabel: string;
    factorMin: number;
    factorMax: number;
    deltaMin?: number;
    deltaMax?: number;
    bandDescription: string;
  };
  sideSelection: {
    trapDirection: TrapDirection;
    trapSide: CandidateSide;
    forcedSide?: CandidateSide;
    selectedSide: CandidateSide;
    rationale: string;
  };
  boundsAndSnapping: {
    rawCandidate: number;
    boundsClamped: boolean;
    clampedTo?: number;
    snappedCandidate: number;
    snappingInterval: number;
    remedyStage: number;
  };
  outcome: {
    presentedNumber: number;
    trueNumber: number;
    unit: string;
    correctDirection: CandidateSide;
    delta: number;
    ratio: number;
    percentDiff: number;
    explanation: string;
  };
  matrix: DerivationMatrixRow[];
}

export const SURPRISE_DESCRIPTIONS: Record<number, string> = {
  0: "Obvious / Familiar (close to common intuition)",
  1: "Mild / Plausible (modest misconception offset)",
  2: "Very Surprising (strong counter-intuitive spread)",
  3: "Mind-Blowing Intuition Trap (extreme magnitude shift)",
};

/**
 * Normalizes unit string per DDM normalization steps:
 * trim surrounding whitespace, invariant lowercase, collapse whitespace.
 */
export function normalizeUnit(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s\t\n\r\f\v]+/g, " ");
}

/**
 * Maps incoming surprise (0-10 or null) to canonical 0-3 band.
 */
export function canonicalizeSurprise(raw: unknown): number {
  const num = Number(raw ?? 2);
  if (!Number.isFinite(num)) return 2;
  const rounded = Math.round(num);
  if (rounded <= 0) return 0;
  if (rounded === 1) return 1;
  if (rounded === 2) return 2;
  if (rounded === 3) return 3;
  if (rounded === 4) return 1;
  if (rounded >= 5 && rounded <= 7) return 2;
  return 3;
}

const EXACT_UNIT_MAP: Record<string, QuantityKind> = {
  year: "year",
  years: "year",
  yr: "year",
  yrs: "year",
  ce: "year",
  ad: "year",
  bc: "year",
  bce: "year",
  "year (ce)": "year",
  "year ce": "year",
  "year ad": "year",
  "calendar year": "year",

  percent: "percentage",
  percentage: "percentage",
  "%": "percentage",
  pct: "percentage",
  "per cent": "percentage",
  "percentage points": "percentage",

  mph: "physical_measure",
  "km/h": "physical_measure",
  kmh: "physical_measure",
  knots: "physical_measure",
  meters: "physical_measure",
  metres: "physical_measure",
  meter: "physical_measure",
  metre: "physical_measure",
  feet: "physical_measure",
  foot: "physical_measure",
  ft: "physical_measure",
  inches: "physical_measure",
  inch: "physical_measure",
  in: "physical_measure",
  cm: "physical_measure",
  mm: "physical_measure",
  km: "physical_measure",
  miles: "physical_measure",
  mile: "physical_measure",
  yards: "physical_measure",
  yard: "physical_measure",
  yd: "physical_measure",
  kg: "physical_measure",
  kilograms: "physical_measure",
  kilogram: "physical_measure",
  lbs: "physical_measure",
  lb: "physical_measure",
  pounds: "physical_measure",
  pound: "physical_measure",
  tons: "physical_measure",
  tonnes: "physical_measure",
  grams: "physical_measure",
  g: "physical_measure",
  mg: "physical_measure",
  ounces: "physical_measure",
  oz: "physical_measure",
  calories: "physical_measure",
  kcal: "physical_measure",
  bpm: "physical_measure",
  celsius: "physical_measure",
  fahrenheit: "physical_measure",
  "°c": "physical_measure",
  "°f": "physical_measure",

  $: "money",
  usd: "money",
  dollar: "money",
  dollars: "money",
  "us dollars": "money",
  cents: "money",
  "million dollars": "money",
  "billion dollars": "money",
  "trillion dollars": "money",
  euro: "money",
  euros: "money",
  "€": "money",
  gbp: "money",
  pounds_sterling: "money",
  "£": "money",
  yen: "money",
  "¥": "money",

  seconds: "duration",
  second: "duration",
  sec: "duration",
  secs: "duration",
  s: "duration",
  minutes: "duration",
  minute: "duration",
  min: "duration",
  mins: "duration",
  hours: "duration",
  hour: "duration",
  hr: "duration",
  hrs: "duration",
  h: "duration",
  days: "duration",
  day: "duration",
  d: "duration",
  weeks: "duration",
  week: "duration",
  months: "duration",
  month: "duration",

  stars: "rating",
  star: "rating",
  "/5": "rating",
  "/10": "rating",
  "/100": "rating",
  rating: "rating",

  ratio: "ratio",
  ":1": "ratio",
  "to 1": "ratio",
};

/**
 * Classifies a normalized unit string into its QuantityKind.
 */
export function classifyQuantityKind(unit: string, hint?: string): { kind: QuantityKind; matchedRule: string } {
  const norm = normalizeUnit(unit);
  if (EXACT_UNIT_MAP[norm]) {
    return { kind: EXACT_UNIT_MAP[norm], matchedRule: `Exact match for unit "${norm}"` };
  }

  // Check prefix or substring indicators
  if (norm.includes("$") || norm.includes("dollar") || norm.includes("euro") || norm.includes("usd")) {
    return { kind: "money", matchedRule: `Currency token in "${norm}"` };
  }
  if (norm.includes("%") || norm.includes("percent")) {
    return { kind: "percentage", matchedRule: `Percentage symbol in "${norm}"` };
  }
  if (/\b(year|ce|ad|bce)\b/.test(norm)) {
    return { kind: "year", matchedRule: `Year term in "${norm}"` };
  }
  if (
    norm.includes("meter") ||
    norm.includes("metre") ||
    norm.includes("mile") ||
    norm.includes("foot") ||
    norm.includes("feet") ||
    norm.includes("gram") ||
    norm.includes("pound") ||
    norm.includes("kg") ||
    norm.includes("mph") ||
    norm.includes("km")
  ) {
    return { kind: "physical_measure", matchedRule: `Measurement dimension in "${norm}"` };
  }
  if (norm.includes("second") || norm.includes("minute") || norm.includes("hour") || norm.includes("day")) {
    return { kind: "duration", matchedRule: `Temporal unit in "${norm}"` };
  }

  // Use hint if valid
  if (hint && isValidQuantityKind(hint)) {
    return { kind: hint, matchedRule: `Model hint: "${hint}"` };
  }

  // Fallback to count for discrete nouns (people, trees, planets, etc.)
  return { kind: "count", matchedRule: `Count noun fallback for "${norm}"` };
}

function isValidQuantityKind(k: string): k is QuantityKind {
  return [
    "year",
    "count",
    "percentage",
    "ratio",
    "physical_measure",
    "money",
    "duration",
    "rating",
  ].includes(k);
}

export function strategyForKind(kind: QuantityKind): DerivationStrategy {
  if (kind === "year") return "additive";
  if (kind === "percentage" || kind === "rating") return "bounded";
  return "multiplicative";
}

// Multiplicative Base Distance Bands (from derivation_tables.json)
const MULTIPLICATIVE_BANDS = [
  { surprise: 0, min: 1.15, max: 1.35 },
  { surprise: 1, min: 1.35, max: 1.7 },
  { surprise: 2, min: 1.8, max: 2.8 },
  { surprise: 3, min: 2.5, max: 5.0 },
];

// Additive Year Deltas (from derivation_tables.json)
const YEAR_DELTAS = [
  { surprise: 0, min: 3, max: 5 },
  { surprise: 1, min: 8, max: 12 },
  { surprise: 2, min: 25, max: 40 },
  { surprise: 3, min: 60, max: 100 },
];

// Percentage Deltas (from derivation_tables.json)
const PERCENTAGE_DELTAS = [
  { surprise: 0, min: 1.5, max: 3.0 },
  { surprise: 1, min: 3.0, max: 6.0 },
  { surprise: 2, min: 8.0, max: 20.0 },
  { surprise: 3, min: 20.0, max: 40.0 },
];

// Rating Deltas
const RATING_DELTAS = [
  { surprise: 0, min: 0.2, max: 0.5 },
  { surprise: 1, min: 0.5, max: 1.0 },
  { surprise: 2, min: 1.0, max: 2.0 },
  { surprise: 3, min: 2.0, max: 3.5 },
];

function snappingIntervalFor(val: number, kind: QuantityKind): number {
  if (kind === "year") return 1;
  if (kind === "percentage") return val > 20 ? 1 : 0.5;
  if (kind === "rating") return 0.1;

  const abs = Math.abs(val);
  if (abs >= 1_000_000_000) return 50_000_000;
  if (abs >= 100_000_000) return 5_000_000;
  if (abs >= 10_000_000) return 500_000;
  if (abs >= 1_000_000) return 50_000;
  if (abs >= 100_000) return 5_000;
  if (abs >= 10_000) return 500;
  if (abs >= 1_000) return 50;
  if (abs >= 100) return 5;
  if (abs >= 20) return 1;
  if (abs >= 2) return 0.5;
  return 0.1;
}

function snapValue(val: number, interval: number): number {
  if (interval <= 0) return val;
  const snapped = Math.round(val / interval) * interval;
  return Number(snapped.toPrecision(12)) / 1;
}

/**
 * Calculates raw candidates for a given true number, surprise level, and quantity kind.
 */
function calculateRawCandidates(
  trueNum: number,
  surprise: number,
  kind: QuantityKind,
  strategy: DerivationStrategy,
): { moreRaw: number; lessRaw: number; factorMin: number; factorMax: number; deltaMin?: number; deltaMax?: number } {
  if (strategy === "additive" && kind === "year") {
    const band = YEAR_DELTAS[surprise] ?? YEAR_DELTAS[2];
    const midDelta = (band.min + band.max) / 2;
    return {
      moreRaw: trueNum - midDelta,
      lessRaw: trueNum + midDelta,
      factorMin: 1,
      factorMax: 1,
      deltaMin: band.min,
      deltaMax: band.max,
    };
  }

  if (strategy === "bounded" && kind === "percentage") {
    const band = PERCENTAGE_DELTAS[surprise] ?? PERCENTAGE_DELTAS[2];
    const midDelta = (band.min + band.max) / 2;
    return {
      moreRaw: Math.max(0, trueNum - midDelta),
      lessRaw: Math.min(100, trueNum + midDelta),
      factorMin: 1,
      factorMax: 1,
      deltaMin: band.min,
      deltaMax: band.max,
    };
  }

  if (strategy === "bounded" && kind === "rating") {
    const band = RATING_DELTAS[surprise] ?? RATING_DELTAS[2];
    const midDelta = (band.min + band.max) / 2;
    return {
      moreRaw: Math.max(0, trueNum - midDelta),
      lessRaw: trueNum + midDelta,
      factorMin: 1,
      factorMax: 1,
      deltaMin: band.min,
      deltaMax: band.max,
    };
  }

  // Multiplicative strategy
  const band = MULTIPLICATIVE_BANDS[surprise] ?? MULTIPLICATIVE_BANDS[2];
  const midFactor = (band.min + band.max) / 2;
  const moreRaw = trueNum / midFactor;
  const lessRaw = trueNum * midFactor;

  return {
    moreRaw,
    lessRaw,
    factorMin: band.min,
    factorMax: band.max,
  };
}

export interface DerivationAuditInput {
  trueNumber: number | string;
  unit: string;
  surpriseFactor?: number | string;
  quantityKind?: string;
  trapDirection?: TrapDirection;
  forcedSide?: CandidateSide;
  plausibleMin?: number | string;
  plausibleMax?: number | string;
}

/**
 * Executes a full DDM derivation audit and returns the complete decision trace.
 */
export function auditDerivation(input: DerivationAuditInput): DerivationAuditTrace {
  const token = String(input.trueNumber ?? "").trim();
  const trueNum = Number(token);
  if (!Number.isFinite(trueNum)) {
    throw new Error(`Invalid true_number: "${token}". Must be a finite number.`);
  }

  const rawSurprise = Number(input.surpriseFactor ?? 2);
  const canonicalSurprise = canonicalizeSurprise(rawSurprise);

  const { kind: resolvedKind, matchedRule } = classifyQuantityKind(input.unit, input.quantityKind);
  const strategy = strategyForKind(resolvedKind);

  const pMin = input.plausibleMin !== undefined && input.plausibleMin !== "" ? Number(input.plausibleMin) : undefined;
  const pMax = input.plausibleMax !== undefined && input.plausibleMax !== "" ? Number(input.plausibleMax) : undefined;

  const trapDirection: TrapDirection = input.trapDirection === "UNDERESTIMATE" ? "UNDERESTIMATE" : "OVERESTIMATE";
  const trapSide: CandidateSide = trapDirection === "OVERESTIMATE" ? "LESS" : "MORE";
  const selectedSide: CandidateSide = input.forcedSide ?? trapSide;

  const matrix: DerivationMatrixRow[] = [];
  for (let s = 0; s <= 3; s++) {
    const raw = calculateRawCandidates(trueNum, s, resolvedKind, strategy);
    const intervalMore = snappingIntervalFor(raw.moreRaw, resolvedKind);
    const intervalLess = snappingIntervalFor(raw.lessRaw, resolvedKind);

    let snappedMore = snapValue(raw.moreRaw, intervalMore);
    let snappedLess = snapValue(raw.lessRaw, intervalLess);

    if (pMin !== undefined) {
      if (snappedMore < pMin) snappedMore = pMin;
      if (snappedLess < pMin) snappedLess = pMin;
    }
    if (pMax !== undefined) {
      if (snappedMore > pMax) snappedMore = pMax;
      if (snappedLess > pMax) snappedLess = pMax;
    }

    if (snappedMore >= trueNum) snappedMore = trueNum > 1 ? trueNum - 1 : trueNum * 0.8;
    if (snappedLess <= trueNum) snappedLess = trueNum + 1;

    const moreDelta = Math.abs(trueNum - snappedMore);
    const lessDelta = Math.abs(snappedLess - trueNum);

    const isWinning = s === canonicalSurprise;

    matrix.push({
      surprise: s,
      surpriseLabel: SURPRISE_DESCRIPTIONS[s],
      moreCandidate: snappedMore,
      lessCandidate: snappedLess,
      moreDelta,
      lessDelta,
      moreRatio: Number((trueNum / (snappedMore || 1)).toFixed(2)),
      lessRatio: Number(((snappedLess || 1) / trueNum).toFixed(2)),
      isWinningCandidate: isWinning,
      winningSide: isWinning ? selectedSide : undefined,
    });
  }

  const winningRow = matrix[canonicalSurprise];
  const chosenPresented = selectedSide === "MORE" ? winningRow.moreCandidate : winningRow.lessCandidate;

  const currentRaw = calculateRawCandidates(trueNum, canonicalSurprise, resolvedKind, strategy);
  const rawTarget = selectedSide === "MORE" ? currentRaw.moreRaw : currentRaw.lessRaw;
  const snappingInterval = snappingIntervalFor(rawTarget, resolvedKind);

  let boundsClamped = false;
  let clampedTo: number | undefined;
  if (pMin !== undefined && rawTarget < pMin) {
    boundsClamped = true;
    clampedTo = pMin;
  } else if (pMax !== undefined && rawTarget > pMax) {
    boundsClamped = true;
    clampedTo = pMax;
  }

  const delta = Math.abs(trueNum - chosenPresented);
  const ratio = trueNum !== 0 ? chosenPresented / trueNum : chosenPresented;
  const percentDiff = trueNum !== 0 ? Math.round(((chosenPresented - trueNum) / trueNum) * 100) : 100;

  const correctDirection: CandidateSide = trueNum > chosenPresented ? "MORE" : "LESS";

  const bandDesc =
    strategy === "additive"
      ? `Additive delta of ${currentRaw.deltaMin ?? 0} to ${currentRaw.deltaMax ?? 0} ${input.unit}`
      : `Multiplicative band of ${currentRaw.factorMin}x to ${currentRaw.factorMax}x (${Math.round(
          (currentRaw.factorMin - 1) * 100,
        )}% to ${Math.round((currentRaw.factorMax - 1) * 100)}% shift)`;

  const sideRationale = input.forcedSide
    ? `Forced side override: ${input.forcedSide} selected by caller or pack balance constraints.`
    : `Trap direction is ${trapDirection}: intuitively players ${
        trapDirection === "OVERESTIMATE" ? "expect a larger number" : "expect a smaller number"
      }, so presenting ${
        selectedSide === "LESS" ? "a higher number (making correct answer LESS)" : "a lower number (making correct answer MORE)"
      } creates the maximum intuition trap.`;

  const explanation =
    correctDirection === "MORE"
      ? `True is ${trueNum} ${input.unit} vs presented ${chosenPresented} ${input.unit}. True is GREATER (+${delta} ${input.unit}, ${Math.abs(percentDiff)}% difference), so the correct answer is MORE.`
      : `True is ${trueNum} ${input.unit} vs presented ${chosenPresented} ${input.unit}. True is SMALLER (-${delta} ${input.unit}, ${Math.abs(percentDiff)}% difference), so the correct answer is LESS.`;

  return {
    input: {
      token,
      trueNumber: trueNum,
      unit: input.unit,
      rawSurprise,
      canonicalSurprise,
      trapDirection,
      forcedSide: input.forcedSide,
      plausibleMin: pMin,
      plausibleMax: pMax,
    },
    classification: {
      quantityKind: resolvedKind,
      strategy,
      matchedUnitRule: matchedRule,
      unitDescription: `${resolvedKind} (${strategy})`,
    },
    band: {
      surprise: canonicalSurprise,
      surpriseLabel: SURPRISE_DESCRIPTIONS[canonicalSurprise],
      factorMin: currentRaw.factorMin,
      factorMax: currentRaw.factorMax,
      deltaMin: currentRaw.deltaMin,
      deltaMax: currentRaw.deltaMax,
      bandDescription: bandDesc,
    },
    sideSelection: {
      trapDirection,
      trapSide,
      forcedSide: input.forcedSide,
      selectedSide,
      rationale: sideRationale,
    },
    boundsAndSnapping: {
      rawCandidate: Number(rawTarget.toFixed(2)),
      boundsClamped,
      clampedTo,
      snappedCandidate: chosenPresented,
      snappingInterval,
      remedyStage: 0,
    },
    outcome: {
      presentedNumber: chosenPresented,
      trueNumber: trueNum,
      unit: input.unit,
      correctDirection,
      delta,
      ratio: Number(ratio.toFixed(2)),
      percentDiff,
      explanation,
    },
    matrix,
  };
}
