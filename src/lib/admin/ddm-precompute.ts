/**
 * Firestore precompute adapter for the vendored DDM-4 kernel.
 *
 * Firestore stores the Foundry block with snake_case keys and exact decimal
 * tokens. The vendored kernel consumes camelCase fields and does the final
 * re-gate. Keeping this conversion outside the vendored module is important:
 * the kernel remains byte-identical to the production handoff, while this
 * boundary validates the untrusted Firestore shape without reparsing numeric
 * tokens through a JavaScript number.
 */

import { QUANTITY_KINDS } from "./contract";
import {
  DDMVersion,
  SideLess,
  SideMore,
  TrapOverestimate,
  TrapUnderestimate,
  derive,
  fnv1a32,
  type CandidateSide,
  type DerivationInput,
  type DerivationResult,
  type PrecomputedDerivation,
  type PrecomputedDistractor,
} from "../../../shared/ddm/derivation";

/** One untrusted distractor as it is stored on a Firestore fact document. */
export interface FirestoreDerivationDistractor {
  readonly surprise_factor: number;
  readonly side: string;
  readonly presented_number: string;
}

/** The snake_case, exact-token precompute block stored by the Fact Foundry. */
export interface FirestoreDerivationBlock {
  readonly model_version: string;
  readonly quantity_kind: string;
  readonly trap_direction: string;
  readonly plausible_min: string;
  readonly plausible_max: string;
  readonly canonical_surprise_factor?: number;
  readonly distractors: readonly FirestoreDerivationDistractor[];
}

/** The identity fields used by the production stable-fact key. */
export interface StableFactIdentity {
  readonly category: string;
  readonly sub_category: string;
  readonly specialty: string;
  readonly angle?: string | null;
  readonly fact: string;
}

/** Optional deterministic alternate-selection and forced-side inputs. */
export interface PrecomputeDeriveOptions {
  readonly variantSeed?: string;
  readonly factKey?: string;
  readonly forcedSide?: CandidateSide;
}

const DERIVATION_KINDS = new Set<string>(QUANTITY_KINDS);
const DERIVATION_TRAPS = new Set<string>([TrapOverestimate, TrapUnderestimate]);
const CANDIDATE_SIDES = new Set<string>([SideMore, SideLess]);

/**
 * Production stable identity for a bank fact.
 *
 * The separator and field order intentionally match `stableFactKey` in the
 * Main repository. It is separate from the claim/number deduplication key: the
 * latter identifies a question, while this key scopes deterministic alternates
 * to the fact's taxonomy and claim.
 */
export function stableFactKey(fact: StableFactIdentity): string {
  return `${fact.category}|${fact.sub_category}|${fact.specialty}|${fact.angle ?? ""}|${fact.fact}`;
}

/**
 * Converts a Firestore precompute block to the vendored DDM shape.
 *
 * Structural failures return `undefined`; malformed individual distractors are
 * dropped so the DDM can decide whether the remaining entries are usable. All
 * numeric tokens are copied verbatim. The model version is intentionally not
 * compared here: the vendored DDM is the authority that turns a mismatch into
 * `TABLE_VERSION_MISMATCH`, allowing callers to retry live without losing the
 * diagnostic. Use `toCurrentPrecomputedDerivation` at a boundary that wants to
 * reject a stale block before handing it to the DDM.
 */
export function toPrecomputedDerivation(
  block: unknown,
  variantSeed?: string,
  factKey?: string,
): PrecomputedDerivation | undefined {
  const record = asRecord(block);
  if (!record) return undefined;

  const modelVersion = record.model_version;
  if (typeof modelVersion !== "string" || modelVersion === "") return undefined;

  const quantityKind = record.quantity_kind;
  if (typeof quantityKind !== "string" || !DERIVATION_KINDS.has(quantityKind)) {
    return undefined;
  }

  const trapDirection = record.trap_direction;
  if (typeof trapDirection !== "string" || !DERIVATION_TRAPS.has(trapDirection)) {
    return undefined;
  }

  const plausibleMin = record.plausible_min;
  const plausibleMax = record.plausible_max;
  if (!isCanonicalToken(plausibleMin) || !isCanonicalToken(plausibleMax)) {
    return undefined;
  }

  const rawDistractors = record.distractors;
  if (!Array.isArray(rawDistractors)) return undefined;

  const distractors: PrecomputedDistractor[] = [];
  for (const rawDistractor of rawDistractors as unknown[]) {
    const distractor = asRecord(rawDistractor);
    if (!distractor) continue;

    const surpriseFactor = distractor.surprise_factor;
    if (
      typeof surpriseFactor !== "number" ||
      !Number.isInteger(surpriseFactor) ||
      surpriseFactor < 0 ||
      surpriseFactor > 3
    ) {
      continue;
    }

    const side = distractor.side;
    if (typeof side !== "string" || !CANDIDATE_SIDES.has(side)) continue;

    const presentedNumber = distractor.presented_number;
    if (!isCanonicalToken(presentedNumber)) continue;

    distractors.push({
      surpriseFactor,
      side: side as CandidateSide,
      presentedNumber,
    });
  }

  rotateDistractorGroups(distractors, variantSeed, factKey);

  return {
    modelVersion,
    quantityKind: quantityKind as PrecomputedDerivation["quantityKind"],
    trapDirection: trapDirection as PrecomputedDerivation["trapDirection"],
    plausibleMin,
    plausibleMax,
    distractors,
  };
}

/**
 * Strict boundary variant for callers that do not want to invoke the DDM's
 * version-mismatch diagnostic. A structurally valid block from another model
 * version is rejected before it can reach a live derivation attempt.
 */
export function toCurrentPrecomputedDerivation(
  block: unknown,
  variantSeed?: string,
  factKey?: string,
): PrecomputedDerivation | undefined {
  const converted = toPrecomputedDerivation(block, variantSeed, factKey);
  return converted?.modelVersion === DDMVersion ? converted : undefined;
}

/**
 * Runs the DDM once with a converted block and, when that attempt does not
 * succeed, once more with the block removed. The retry is the production
 * stale/malformed-block rule: a rejected block's kind, bounds, trap, and
 * distractor fields never become authoritative live-derivation inputs.
 */
export function deriveWithPrecompute(
  input: DerivationInput,
  block: unknown,
  options: PrecomputeDeriveOptions = {},
): DerivationResult {
  const precomputed = toPrecomputedDerivation(block, options.variantSeed, options.factKey);
  const firstInput = withoutPrecomputed(input);
  if (options.forcedSide !== undefined) firstInput.forcedSide = options.forcedSide;
  if (precomputed !== undefined) firstInput.precomputed = precomputed;

  const first = derive(firstInput);
  if (precomputed === undefined || first.success !== undefined) return first;

  const liveInput = { ...firstInput };
  delete liveInput.precomputed;
  return derive(liveInput);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/** Accepts only the canonical decimal-token grammar emitted by the Foundry. */
function isCanonicalToken(value: unknown): value is string {
  return typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value);
}

function withoutPrecomputed(input: DerivationInput): DerivationInput {
  const copy: DerivationInput = { ...input };
  delete copy.precomputed;
  return copy;
}

/**
 * Rotates only entries sharing the same (surprise, side) key. The hash and
 * group-key spelling are deliberately identical to the production adapter;
 * callers can therefore reproduce a daily or seeded pack selection exactly.
 */
function rotateDistractorGroups(
  distractors: PrecomputedDistractor[],
  variantSeed: string | undefined,
  factKey: string | undefined,
): void {
  if (variantSeed === undefined || factKey === undefined || distractors.length < 2) return;

  const groupIndices = new Map<string, number[]>();
  for (let index = 0; index < distractors.length; index++) {
    const key = `${distractors[index].surpriseFactor}|${distractors[index].side}`;
    const indices = groupIndices.get(key) ?? [];
    indices.push(index);
    groupIndices.set(key, indices);
  }

  for (const [key, indices] of groupIndices) {
    if (indices.length < 2) continue;
    const rotation = fnv1a32(`${factKey}|${variantSeed}|${key}`) % indices.length;
    if (rotation === 0) continue;
    const entries = indices.map((index) => distractors[index]);
    for (let index = 0; index < indices.length; index++) {
      distractors[indices[index]] = entries[(index + rotation) % entries.length];
    }
  }
}
