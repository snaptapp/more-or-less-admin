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
  formatFixedCanonical,
  type CandidateSide,
  type FixedPointValue,
  type NumericConstraints,
  type PrecomputedDerivation,
  type PrecomputedDistractor,
  type QuantityKind,
  type TrapDirection,
} from "./derivation";
import {
  derivationInputFingerprint,
  enumeratePlayableCandidateGroups,
} from "./derivation_resolve";
import { DDM_IMPLEMENTATION_REVISION } from "./ddm_implementation_gen";
import { makeNumericFormat, type NumericFormatV2 } from "./factquality_round";
import type { Direction, NumericConstraintsPayload } from "./protocol";

/** A distractor exactly as stored in the exported fact-bank JSON. */
export interface BankDistractor {
  surprise_factor: number;
  side: CandidateSide;
  presented_number: string;
  remedy_stage?: string;
  calibration_tier?: number;
}

/** Snake-case wire projection of the resolved internal constraints, or
 *  undefined when absent or invalid. Only the five policy members are
 *  emitted; used to stamp a round's `numeric_constraints` metadata. */
export function numericConstraintsPayload(
  c: NumericConstraints | undefined
): NumericConstraintsPayload | undefined {
  if (c === undefined || c.invalid === true) return undefined;
  const out: NumericConstraintsPayload = {};
  if (c.displayDecimalPlaces !== undefined) out.display_decimal_places = c.displayDecimalPlaces;
  if (c.quantumToken !== undefined) out.quantum_token = c.quantumToken;
  if (c.minSeparationToken !== undefined) out.min_separation_token = c.minSeparationToken;
  if (c.credibleMinToken !== undefined) out.credible_min_token = c.credibleMinToken;
  if (c.credibleMaxToken !== undefined) out.credible_max_token = c.credibleMaxToken;
  return out;
}

/** The snake_case, exact-token block stored in the exported fact bank. */
export interface BankDerivationBlock {
  model_version: string;
  quantity_kind: string;
  trap_direction: string;
  plausible_min: string;
  plausible_max: string;
  canonical_surprise_factor?: number;
  implementation_revision?: string;
  candidate_policy?: string;
  true_number_token?: string;
  normalized_unit?: string;
  numeric_constraints?: unknown;
  input_fingerprint?: string;
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
  /** Canonical true-number token. When present it is the exact truth authority;
   *  number_token's grouping-stripped form must equal it. */
  true_number_token?: string;
  /** Optional wire true_number used only for checking emitted rounds. */
  true_number?: number;
  unit: string;
  surprise_factor?: number;
  quantity_kind?: string;
  plausible_min?: string;
  plausible_max?: string;
  /** Presence, including an explicit null, selects qualified numerics. */
  numeric_constraints?: unknown;
  derivation?: BankDerivationBlock;
}

/** Qualified candidate-inventory policy minted by PrecomputeQualifiedBlock. */
export const QUALIFIED_CANDIDATE_POLICY = "best_usable_tier_v2";

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

const BANK_CONSTRAINT_KEYS: ReadonlySet<string> = new Set([
  "display_decimal_places",
  "quantum_token",
  "min_separation_token",
  "credible_min_token",
  "credible_max_token",
]);

/**
 * Map the stored snake_case constraint object onto the DDM input shape. The
 * persisted block is untrusted: unknown members, null member values, and
 * non-integer precision mark the policy invalid so the DDM re-gate fails
 * closed instead of silently dropping fields. A stored null means absent.
 */
function toBankNumericConstraints(value: unknown): NumericConstraints | undefined {
  if (value === undefined || value === null) return undefined;
  const invalid: NumericConstraints = { invalid: true };
  if (typeof value !== "object" || Array.isArray(value)) return invalid;
  const out: NumericConstraints = {};
  for (const key of Object.keys(value)) {
    if (!BANK_CONSTRAINT_KEYS.has(key)) return invalid;
  }
  const record = value as Record<string, unknown>;
  const tokenField = (name: "quantum_token" | "min_separation_token" | "credible_min_token" | "credible_max_token"): string | undefined => {
    const v = record[name];
    if (v === undefined) return undefined;
    if (typeof v !== "string") return undefined;
    return v;
  };
  const places = record.display_decimal_places;
  if (places !== undefined) {
    if (typeof places !== "number" || !Number.isInteger(places)) return invalid;
    out.displayDecimalPlaces = places;
  }
  const quantum = tokenField("quantum_token");
  if (record.quantum_token !== undefined && quantum === undefined) return invalid;
  if (quantum !== undefined) out.quantumToken = quantum;
  const separation = tokenField("min_separation_token");
  if (record.min_separation_token !== undefined && separation === undefined) return invalid;
  if (separation !== undefined) out.minSeparationToken = separation;
  const credibleMin = tokenField("credible_min_token");
  if (record.credible_min_token !== undefined && credibleMin === undefined) return invalid;
  if (credibleMin !== undefined) out.credibleMinToken = credibleMin;
  const credibleMax = tokenField("credible_max_token");
  if (record.credible_max_token !== undefined && credibleMax === undefined) return invalid;
  if (credibleMax !== undefined) out.credibleMaxToken = credibleMax;
  return out;
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
    const entry: PrecomputedDistractor = {
      surpriseFactor: d.surprise_factor,
      side: d.side,
      presentedNumber: d.presented_number,
    };
    if (d.remedy_stage !== undefined) {
      if (typeof d.remedy_stage !== "string") continue;
      entry.remedyStage = d.remedy_stage;
    }
    if (d.calibration_tier !== undefined) {
      if (typeof d.calibration_tier !== "number") continue;
      entry.calibrationTier = d.calibration_tier;
    }
    distractors.push(entry);
  }

  const out: PrecomputedDerivation = {
    modelVersion: block.model_version,
    quantityKind: block.quantity_kind,
    trapDirection: block.trap_direction,
    plausibleMin: block.plausible_min,
    plausibleMax: block.plausible_max,
    distractors: rotateDistractorGroups(distractors, variantSeed, factKey),
  };
  // Qualified (best_usable_tier_v2) bindings are forwarded verbatim; the DDM
  // re-gate revalidates every one against the live policy. Malformed types
  // degrade to absence so the block loses qualification rather than gaining
  // authority it did not earn.
  if (typeof block.implementation_revision === "string") {
    out.implementationRevision = block.implementation_revision;
  }
  if (typeof block.candidate_policy === "string") {
    out.candidatePolicy = block.candidate_policy;
  }
  if (typeof block.true_number_token === "string") {
    out.trueNumberToken = block.true_number_token;
  }
  if (typeof block.normalized_unit === "string") {
    out.normalizedUnit = block.normalized_unit;
  }
  if (typeof block.input_fingerprint === "string") {
    out.inputFingerprint = block.input_fingerprint;
  }
  const constraints = toBankNumericConstraints(block.numeric_constraints);
  if (constraints !== undefined) {
    out.numericConstraints = constraints;
  }
  return out;
}

export interface DerivedBankRound {
  presented: number;
  direction: Direction;
  source: DerivationSource;
  quantityKind: QuantityKind;
  trapDirection: TrapDirection;
  plausibleMin: number;
  plausibleMax: number;
  // Qualified (Task 5) metadata, additive only: absent on legacy rounds.
  displayDecimalPlaces?: number;
  presentedToken?: string;
  implementationRevision?: string;
  remedyStage?: string;
  calibrationTier?: number;
  // Task 6 exact-numeric metadata, additive only: the canonical true token,
  // the resolved effective constraints (internal camelCase shape), the
  // qualified candidate policy, the DDM canonical surprise, and the v2
  // numeric format built from the actual fixed values.
  trueToken?: string;
  numericFormat?: NumericFormatV2;
  numericConstraints?: NumericConstraints;
  candidatePolicy?: string;
  canonicalSurprise?: number;
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

/** Exact raw true-number token for a bank row: the explicit canonical token
 *  wins; otherwise the claim's number_token with grouping removed. Returns
 *  null when neither yields an ingestable token. */
function bankTrueNumberToken(fact: BankPrecomputeFact): string | null {
  if (fact.true_number_token !== undefined) {
    return isCanonicalToken(fact.true_number_token) ? fact.true_number_token : null;
  }
  const numericToken = fact.number_token.replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(numericToken)) return null;
  return numericToken;
}

/** The exact raw round JSON seeded from the immutable bank row: the canonical
 *  true-number token plus unit/kind/bounds/constraint hints, ready for the
 *  schema-ingest raw adapter seam. Exported for the bank's canonical-fact
 *  context builder; callers must not inject metadata into it. */
export function rawBankRoundJSON(fact: BankPrecomputeFact): string | null {
  const numericToken = bankTrueNumberToken(fact);
  if (numericToken === null) return null;
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
  // A present numeric_constraints member, including an explicit null, selects
  // the qualified numerical semantics. It is re-emitted verbatim into the raw
  // round JSON so the DDM strict parser (not this adapter) stays the sole
  // authority on policy validity; malformed policies abstain closed.
  if (Object.prototype.hasOwnProperty.call(fact, "numeric_constraints")) {
    const encoded = JSON.stringify(fact.numeric_constraints);
    if (encoded !== undefined) {
      parts.push(`"numeric_constraints":${encoded}`);
    }
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
  const factHasConstraints = Object.prototype.hasOwnProperty.call(fact, "numeric_constraints");
  // A qualified (v2) block cannot authorize a legacy round: when the fact
  // itself carries no numeric_constraints the stored policy is untrusted
  // provenance, not permission, so this abstains rather than falling back to
  // unconstrained derivation.
  if (precomputed?.candidatePolicy === QUALIFIED_CANDIDATE_POLICY && !factHasConstraints) {
    return { round: null, abstainReason: "INVALID_NUMERIC_CONSTRAINTS" };
  }
  const rawRoundJSON = rawBankRoundJSON(fact);
  if (rawRoundJSON === null) return { round: null, abstainReason: "INVALID_NUMERIC_TOKEN" };

  let abstainReason: string | undefined;
  let result = runDerive(rawRoundJSON, forced, precomputed);
  // Stale or non-deciding blocks retry live under the SAME input, so the
  // fact's own constraints and bounds still bind. An
  // INVALID_NUMERIC_CONSTRAINTS abstain never retries: a malformed policy or
  // a v2 block on unconstrained input must not be rescued into a legacy round.
  if (
    result.success === undefined &&
    precomputed !== undefined &&
    result.abstain !== "INVALID_NUMERIC_CONSTRAINTS"
  ) {
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
      ...(winner.displayDecimalPlaces !== undefined
        ? { displayDecimalPlaces: winner.displayDecimalPlaces }
        : {}),
      presentedToken: formatFixedCanonical(winner.presentedNumber),
      ...(winner.implementationRevision !== undefined
        ? { implementationRevision: winner.implementationRevision }
        : {}),
      remedyStage: winner.remedyStage,
      ...(winner.calibrationTier !== undefined
        ? { calibrationTier: winner.calibrationTier }
        : {}),
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

/**
 * Returns every member of the current best-usable remedy tier for `fact` on
 * the requested side (the side derive() would win when `forced` is absent).
 * Each result carries the actual canonical true/presented tokens, the DDM
 * canonical surprise, the resolved kind/trap/bounds, the v2 numeric format
 * built from the actual fixed values, and the revision/stage/tier/policy
 * binding. Stored rotated ordering is preserved for members matching the
 * tier; lower remedy tiers are never appended for variety. An empty result
 * means the fact cannot serve a validated round on that side.
 */
export function deriveBankRoundCandidates(
  fact: BankPrecomputeFact,
  forced?: Direction,
  variantSeed?: string
): DerivedBankRound[] {
  const precomputed = toPrecomputedDerivation(fact.derivation, variantSeed, stableFactKey(fact));
  const factHasConstraints = Object.prototype.hasOwnProperty.call(fact, "numeric_constraints");
  // Same qualified guard as deriveBankRoundDetailed: a v2 block cannot
  // authorize a round for a fact that carries no numeric_constraints.
  if (precomputed?.candidatePolicy === QUALIFIED_CANDIDATE_POLICY && !factHasConstraints) {
    return [];
  }
  const rawRoundJSON = rawBankRoundJSON(fact);
  if (rawRoundJSON === null) return [];
  const ingest = adaptRoundJSON(rawRoundJSON, {
    forcedSide: forced as CandidateSide | undefined,
  });
  if (ingest.abstain !== undefined || ingest.input === undefined) return [];

  const { groups } = enumeratePlayableCandidateGroups(ingest.input);
  if (groups.length === 0) return [];

  let wanted = forced;
  if (wanted === undefined) {
    const res = derive(ingest.input);
    if (res.success === undefined) return [];
    wanted = res.success.correctDirection as Direction;
  }
  const group = groups.find((g) => g.side === wanted);
  if (group === undefined) return [];

  // Resolved round-wide fields come from the derive() winner on this side;
  // per-candidate stage/tier stay per-member.
  const sideResult = derive({
    ...ingest.input,
    forcedSide: group.side,
    precomputed: undefined,
  });
  if (sideResult.success === undefined) return [];
  const success = sideResult.success;

  // Stored rotated members of this (surprise, side) tier lead in rotated
  // order ONLY when the stored block's binding re-gates for the current
  // input: the same live derive() that would consume it as a hint must
  // succeed with it. A stale revision/fingerprint/truth/policy block cannot
  // promote ordering or claim source=precomputed; such members fall back to
  // live enumeration order.
  const storedIndex = new Map<
    string,
    { index: number; remedyStage?: string; calibrationTier?: number }
  >();
  if (precomputed !== undefined) {
    const gated = derive({ ...ingest.input, forcedSide: group.side, precomputed });
    // A stale fingerprint/revision/binding block may fall through to a LIVE
    // success inside derive(); only a success that actually consumed the
    // stored block may promote stored ordering or claim source=precomputed.
    // The unconstrained re-gate binds only model_version inside derive(), so
    // the adapter independently binds the stored revision and derivation
    // input fingerprint for the current resolved input before trusting them.
    const boundForCurrentInput =
      precomputed.implementationRevision === DDM_IMPLEMENTATION_REVISION &&
      precomputed.inputFingerprint !== undefined &&
      precomputed.inputFingerprint ===
        derivationInputFingerprint(
          formatFixedCanonical(success.trueNumber),
          success.normalizedUnit,
          success.quantityKind,
          formatFixedCanonical(success.plausibleMin),
          formatFixedCanonical(success.plausibleMax),
          success.surpriseFactor,
          success.numericConstraints,
        );
    if (
      gated.success !== undefined &&
      gated.success.source === "precomputed" &&
      boundForCurrentInput
    ) {
      let idx = 0;
      for (const d of precomputed.distractors) {
        if (
          d.side === group.side &&
          d.surpriseFactor === group.surpriseFactor &&
          !storedIndex.has(d.presentedNumber)
        ) {
          storedIndex.set(d.presentedNumber, {
            index: idx++,
            remedyStage: d.remedyStage,
            calibrationTier: d.calibrationTier,
          });
        }
      }
    }
  }
  // A stored member only leads when its stage/tier also match the enumerated
  // candidate: stale lower-tier inventory never tags a current member as
  // primary precomputed.
  const storedLead = (token: string, stage: string | undefined, tier: number | undefined) => {
    const stored = storedIndex.get(token);
    if (stored === undefined) return undefined;
    if (stored.remedyStage !== stage || stored.calibrationTier !== tier) return undefined;
    return stored.index;
  };
  const ordered = group.candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const ai = storedLead(formatFixedCanonical(a.c.value), a.c.remedyStage, a.c.calibrationTier);
      const bi = storedLead(formatFixedCanonical(b.c.value), b.c.remedyStage, b.c.calibrationTier);
      if (ai !== undefined && bi !== undefined) return ai - bi;
      if (ai !== undefined) return -1;
      if (bi !== undefined) return 1;
      return a.i - b.i;
    });

  return ordered.map(({ c }) => {
    const presentedToken = formatFixedCanonical(c.value);
    const [format] = makeNumericFormat(
      success.trueNumber,
      c.value,
      success.quantityKind,
      success.numericConstraints
    );
    const out: DerivedBankRound = {
      presented: fixedToNumber(c.value),
      direction: group.side as Direction,
      source:
        storedLead(presentedToken, c.remedyStage, c.calibrationTier) !== undefined
          ? "precomputed"
          : "live",
      quantityKind: success.quantityKind,
      trapDirection: success.trapDirection,
      plausibleMin: fixedToNumber(success.plausibleMin),
      plausibleMax: fixedToNumber(success.plausibleMax),
      presentedToken,
      trueToken: formatFixedCanonical(success.trueNumber),
      remedyStage: c.remedyStage,
      calibrationTier: c.calibrationTier,
      canonicalSurprise: success.surpriseFactor,
    };
    if (success.displayDecimalPlaces !== undefined) {
      out.displayDecimalPlaces = success.displayDecimalPlaces;
    }
    if (format !== undefined) out.numericFormat = format;
    if (success.numericConstraints !== undefined) {
      out.numericConstraints = success.numericConstraints;
      out.candidatePolicy = QUALIFIED_CANDIDATE_POLICY;
    }
    // Every emitted candidate binds the CURRENT implementation revision: the
    // shared gate treats a numeric_format without a revision as unbound.
    out.implementationRevision =
      success.implementationRevision ?? DDM_IMPLEMENTATION_REVISION;
    return out;
  });
}
