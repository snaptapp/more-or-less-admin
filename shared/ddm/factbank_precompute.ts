/**
 * Production-owned fact-bank precompute adapter.
 *
 * The exported functions are pure boundaries around the vendored DDM: they
 * validate the exact persisted block, convert it to the DDM input shape, and
 * retry live derivation without retaining a rejected precompute hint.
 */

import { adaptRoundJSON } from "./derivation_adapter";
import {
  derive,
  DDMVersion,
  fnv1a32,
  type CandidateSide,
  type PrecomputedDerivation,
  type PrecomputedDistractor,
  type QuantityKind,
  type TrapDirection,
} from "./derivation";
import type { Direction } from "./protocol";

/** A distractor exactly as stored in the exported fact-bank JSON. */
export interface BankDistractor {
  surprise_factor: number;
  side: CandidateSide;
  presented_number: string;
}

/** The snake_case, exact-token block stored in the exported fact bank. */
export interface BankDerivationBlock {
  model_version: string;
  quantity_kind: string;
  trap_direction: string;
  plausible_min: string;
  plausible_max: string;
  canonical_surprise_factor?: number;
  distractors: BankDistractor[];
}

/** The fact fields needed by the precompute adapter and its stable key. */
export interface BankPrecomputeFact {
  category: string;
  sub_category: string;
  specialty: string;
  fact: string;
  angle?: string;
  number_token: string;
  unit: string;
  surprise_factor?: number;
  quantity_kind?: string;
  plausible_min?: string;
  plausible_max?: string;
  derivation?: BankDerivationBlock;
}

/** Closed sets mirrored from the export boundary and the DDM unions. */
export const DERIVATION_QUANTITY_KINDS: readonly QuantityKind[] = Object.freeze([
  "year",
  "count",
  "percentage",
  "percent_change",
  "ratio",
  "physical_measure",
  "money",
  "duration",
  "rating",
]);
export const DERIVATION_TRAP_DIRECTIONS: readonly TrapDirection[] = Object.freeze([
  "OVERESTIMATE",
  "UNDERESTIMATE",
]);

const QUANTITY_KIND_SET: ReadonlySet<string> = new Set(DERIVATION_QUANTITY_KINDS);
const TRAP_DIRECTION_SET: ReadonlySet<string> = new Set(DERIVATION_TRAP_DIRECTIONS);

/** True for an exact decimal token; no exponent or float reparse is allowed. */
export function isCanonicalToken(value: unknown): value is string {
  return typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value);
}

export function isDerivationQuantityKind(value: unknown): value is QuantityKind {
  return typeof value === "string" && QUANTITY_KIND_SET.has(value);
}

export function isDerivationTrapDirection(value: unknown): value is TrapDirection {
  return typeof value === "string" && TRAP_DIRECTION_SET.has(value);
}

/** Stable identity used to seed alternate selection for one bank fact. */
export function stableFactKey(
  fact: Pick<BankPrecomputeFact, "category" | "sub_category" | "specialty" | "angle" | "fact">
): string {
  return `${fact.category}|${fact.sub_category}|${fact.specialty}|${fact.angle ?? ""}|${fact.fact}`;
}

/**
 * Rotate only entries sharing (surpriseFactor, side), preserving the input
 * order when either seed is absent. The returned array is a new array.
 */
export function rotateDistractorGroups(
  distractors: readonly PrecomputedDistractor[],
  variantSeed?: string,
  factKey?: string
): PrecomputedDistractor[] {
  const rotated = [...distractors];
  if (variantSeed === undefined || factKey === undefined || rotated.length < 2) return rotated;
  const groupIndices = new Map<string, number[]>();
  for (let i = 0; i < rotated.length; i++) {
    const key = `${rotated[i].surpriseFactor}|${rotated[i].side}`;
    const indices = groupIndices.get(key) ?? [];
    indices.push(i);
    groupIndices.set(key, indices);
  }
  for (const [key, indices] of groupIndices) {
    if (indices.length < 2) continue;
    const rotation = fnv1a32(`${factKey}|${variantSeed}|${key}`) % indices.length;
    if (rotation === 0) continue;
    const entries = indices.map((i) => rotated[i]);
    for (let i = 0; i < indices.length; i++) {
      rotated[indices[i]] = entries[(i + rotation) % indices.length];
    }
  }
  return rotated;
}

/** Convert a validated snake_case block to the camelCase DDM input shape. */
export function toPrecomputedDerivation(
  block: BankDerivationBlock | undefined,
  variantSeed?: string,
  factKey?: string
): PrecomputedDerivation | undefined {
  if (!block || typeof block !== "object") return undefined;
  if (typeof block.model_version !== "string" || block.model_version === "") return undefined;
  if (!isDerivationQuantityKind(block.quantity_kind)) return undefined;
  if (!isDerivationTrapDirection(block.trap_direction)) return undefined;
  if (!isCanonicalToken(block.plausible_min) || !isCanonicalToken(block.plausible_max)) {
    return undefined;
  }
  if (!Array.isArray(block.distractors)) return undefined;

  const distractors: PrecomputedDistractor[] = [];
  for (const d of block.distractors) {
    if (!d || typeof d !== "object") continue;
    if (!Number.isInteger(d.surprise_factor) || d.surprise_factor < 0 || d.surprise_factor > 3) continue;
    if (d.side !== "MORE" && d.side !== "LESS") continue;
    if (!isCanonicalToken(d.presented_number)) continue;
    distractors.push({
      surpriseFactor: d.surprise_factor,
      side: d.side,
      presentedNumber: d.presented_number,
    });
  }

  return {
    modelVersion: block.model_version,
    quantityKind: block.quantity_kind,
    trapDirection: block.trap_direction,
    plausibleMin: block.plausible_min,
    plausibleMax: block.plausible_max,
    distractors: rotateDistractorGroups(distractors, variantSeed, factKey),
  };
}

export interface DerivedBankRound {
  presented: number;
  direction: Direction;
  source: DerivationSource;
  quantityKind: QuantityKind;
  trapDirection: TrapDirection;
  plausibleMin: number;
  plausibleMax: number;
}

export type DerivationSource = "precomputed" | "live";

export interface DetailedBankRound {
  round: DerivedBankRound | null;
  abstainReason?: string;
}

/** Convert a DDM fixed-point success to the wire number after all gates run. */
function fixedToNumber(v: { negative: boolean; mantissa: number; scale: number }): number {
  const magnitude = v.scale === 0 ? v.mantissa : v.mantissa / Math.pow(10, v.scale);
  return v.negative ? -magnitude : magnitude;
}

function rawBankRoundJSON(fact: BankPrecomputeFact): string | null {
  const numericToken = fact.number_token.replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(numericToken)) return null;
  const parts = [`"true_number":${numericToken}`, `"unit":${JSON.stringify(fact.unit)}`];
  if (typeof fact.surprise_factor === "number" && Number.isInteger(fact.surprise_factor)) {
    parts.push(`"surprise_factor":${fact.surprise_factor}`);
  }
  if (typeof fact.quantity_kind === "string" && fact.quantity_kind.trim()) {
    parts.push(`"quantity_kind":${JSON.stringify(fact.quantity_kind.trim())}`);
  }
  const minTok = typeof fact.plausible_min === "string" ? fact.plausible_min.trim() : "";
  const maxTok = typeof fact.plausible_max === "string" ? fact.plausible_max.trim() : "";
  if (minTok && maxTok &&
      /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(minTok) &&
      /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(maxTok)) {
    parts.push(`"plausible_min":${minTok}`, `"plausible_max":${maxTok}`);
  }
  return `{${parts.join(",")}}`;
}

function runDerive(rawRoundJSON: string, forced: Direction | undefined, block: PrecomputedDerivation | undefined) {
  const ingest = adaptRoundJSON(rawRoundJSON, {
    forcedSide: forced as CandidateSide | undefined,
    precomputed: block,
  });
  if (ingest.abstain !== undefined || ingest.input === undefined) {
    return { abstain: ingest.abstain?.reason };
  }
  const result = derive(ingest.input);
  return { success: result.success, abstain: result.abstain?.reason };
}

/** Prefer a re-gated block, then retry live with no block on any rejection. */
export function deriveBankRoundDetailed(
  fact: BankPrecomputeFact,
  forced?: Direction,
  variantSeed?: string
): DetailedBankRound {
  const precomputed = toPrecomputedDerivation(fact.derivation, variantSeed, stableFactKey(fact));
  const rawRoundJSON = rawBankRoundJSON(fact);
  if (rawRoundJSON === null) return { round: null, abstainReason: "INVALID_NUMERIC_TOKEN" };

  let abstainReason: string | undefined;
  let result = runDerive(rawRoundJSON, forced, precomputed);
  if (result.success === undefined && precomputed !== undefined) {
    abstainReason = result.abstain;
    result = runDerive(rawRoundJSON, forced, undefined);
  }
  if (result.success === undefined) {
    return { round: null, abstainReason: result.abstain ?? abstainReason };
  }

  const winner = result.success;
  return {
    round: {
      presented: fixedToNumber(winner.presentedNumber),
      direction: winner.correctDirection as Direction,
      source: winner.source === "precomputed" ? "precomputed" : "live",
      quantityKind: winner.quantityKind,
      trapDirection: winner.trapDirection,
      plausibleMin: fixedToNumber(winner.plausibleMin),
      plausibleMax: fixedToNumber(winner.plausibleMax),
    },
  };
}

export function deriveBankRound(
  fact: BankPrecomputeFact,
  forced?: Direction,
  variantSeed?: string
): DerivedBankRound | null {
  return deriveBankRoundDetailed(fact, forced, variantSeed).round;
}

export function precomputeVersionMatches(fact: BankPrecomputeFact): boolean {
  return fact.derivation?.model_version === DDMVersion;
}
