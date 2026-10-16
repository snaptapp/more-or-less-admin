/**
 * DDM-4 decision auditor for the Admin inspector.
 *
 * This module is intentionally a tracer, not a second derivation model. Every
 * candidate outcome is produced by the vendored production kernel in
 * `shared/ddm/derivation.ts`; the adapter below only translates kernel results
 * into the long-standing inspector shape.
 */

import { type QuantityKind as ContractQuantityKind } from "./contract";
import {
  DDMVersion,
  SideLess,
  SideMore,
  canonicalizeSurprise as kernelCanonicalizeSurprise,
  classifyQuantityKind as kernelClassifyQuantityKind,
  computeMagnitudeScale,
  composeDistanceBand,
  derive,
  formatFixedCanonical,
  numericIngest,
  normalizeUnit as kernelNormalizeUnit,
  normalizeFixed,
  pow10,
  resolveBounds,
  resolveCandidateSides,
  resolveKindStrategy,
  resolveTrapDirection,
  snapCandidate,
  strategyMultiplicative,
  subtractFixed,
  type AbstainReason,
  type CandidateSide as KernelCandidateSide,
  type DerivationInput,
  type DerivationResult,
  type DerivationSource,
  type DerivationStrategy as KernelDerivationStrategy,
  type FixedPointValue,
  type QuantityKind as KernelQuantityKind,
  type TrapDirection as KernelTrapDirection,
} from "../../../shared/ddm/derivation";

export const DDM_VERSION = DDMVersion;
export const DERIVATION_AUDIT_TRACE_VERSION = DDMVersion;

export type DerivationStrategy = KernelDerivationStrategy;
export type TrapDirection = KernelTrapDirection;
export type CandidateSide = KernelCandidateSide;
export type QuantityKind = ContractQuantityKind;

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
  /** Kernel outcome metadata is additive; the original eight fields stay intact. */
  moreOutcome?: "success" | "abstain";
  lessOutcome?: "success" | "abstain";
  moreAbstainReason?: AbstainReason;
  lessAbstainReason?: AbstainReason;
  moreSource?: DerivationSource;
  lessSource?: DerivationSource;
  moreRemedyStage?: string;
  lessRemedyStage?: string;
  moreCandidateToken?: string;
  lessCandidateToken?: string;
}

export interface DerivationAuditDiagnostics {
  modelVersion: string;
  incomingNumericToken: string;
  trueNumberToken: string;
  presentedNumberToken?: string;
  source?: DerivationSource;
  remedyStage?: string;
  magnitudeScale?: number;
  plausibleMin?: number;
  plausibleMax?: number;
  abstainReason?: AbstainReason;
}

export interface DerivationAuditTrace {
  /** Explicitly versioned extension of the original inspector trace shape. */
  traceVersion: string;
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
    /** Additive metadata from the same kernel result that supplies the candidates. */
    magnitudeScale?: number;
    variant?: string;
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
    /** Legacy numeric field retained for the existing UI contract. */
    remedyStage: number;
    remedyStageId?: string;
    source?: DerivationSource;
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
    abstainReason?: AbstainReason;
    source?: DerivationSource;
    remedyStage?: string;
    magnitudeScale?: number;
  };
  /** Additive, serializable kernel diagnostics for parity/debug consumers. */
  diagnostics: DerivationAuditDiagnostics;
  /** Present only when the selected derivation is an abstention. */
  abstainReason?: AbstainReason;
  source?: DerivationSource;
  remedyStage?: string;
  magnitudeScale?: number;
  matrix: DerivationMatrixRow[];
}

export const SURPRISE_DESCRIPTIONS: Record<number, string> = {
  0: "Obvious / Familiar (close to common intuition)",
  1: "Mild / Plausible (modest misconception offset)",
  2: "Very Surprising (strong counter-intuitive spread)",
  3: "Mind-Blowing Intuition Trap (extreme magnitude shift)",
};

/** DDM-4 unit normalization, exposed under the Admin's historical name. */
export function normalizeUnit(raw: string): string {
  return kernelNormalizeUnit(raw);
}

/** DDM-4 surprise canonicalization, exposed under the Admin's historical name. */
export function canonicalizeSurprise(raw: unknown): number {
  const numeric = typeof raw === "number" ? raw : Number(raw ?? 2);
  return kernelCanonicalizeSurprise(Number.isFinite(numeric) ? numeric : 2);
}

/**
 * Classifies a unit using the vendored DDM classifier. The optional hint is
 * intentionally accepted as a string here because the Admin form is untrusted;
 * the kernel validates it against its closed set and true-number constraints.
 */
export function classifyQuantityKind(
  unit: string,
  hint?: string,
): { kind: QuantityKind; matchedRule: string } {
  const zero = numericIngest("0").fixedPointValue;
  if (zero === undefined) {
    throw new Error("DDM-4 classifier is unavailable: zero ingest failed.");
  }
  const [kind] = kernelClassifyQuantityKind(hint ?? "", unit, zero);
  return {
    kind: kind as ContractQuantityKind,
    matchedRule: describeUnitRule(unit, hint, kind as ContractQuantityKind),
  };
}

/** Resolves the strategy through the vendored generated-table view. */
export function strategyForKind(kind: QuantityKind): DerivationStrategy {
  return (resolveKindStrategy(kind as KernelQuantityKind) ?? strategyMultiplicative) as DerivationStrategy;
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

interface SideAuditResult {
  side: CandidateSide;
  success?: NonNullable<DerivationResult["success"]>;
  abstain?: NonNullable<DerivationResult["abstain"]>;
}

interface MatrixCandidateValues {
  candidate: number;
  delta: number;
  ratio: number;
  outcome: "success" | "abstain";
  abstainReason?: AbstainReason;
  source?: DerivationSource;
  remedyStage?: string;
  candidateToken?: string;
}

interface ResolvedAuditContext {
  trueFixed: FixedPointValue;
  canonicalSurprise: number;
  kind: QuantityKind;
  normalizedUnit: string;
  magnitudeScale: number;
  trapDirection: TrapDirection;
  strategy: DerivationStrategy;
  bounds?: { min: FixedPointValue; max: FixedPointValue };
}

/**
 * Executes the full DDM-4 audit. The four surprise rows and both candidate sides
 * are obtained by calling `derive()` eight times with an explicit forced side;
 * the selected row is then the kernel's ordinary result under the caller's
 * optional forced-side override.
 */
export function auditDerivation(input: DerivationAuditInput): DerivationAuditTrace {
  const token = asNumericToken(input.trueNumber);
  const ingest = numericIngest(token);
  if (ingest.fixedPointValue === undefined) {
    const reason = ingest.ingestReason ?? "INVALID_NUMERIC_TOKEN";
    throw new Error(`Invalid true_number: "${token}". Must be a finite number. DDM-4 abstain: ${reason}`);
  }

  const rawSurprise = finiteNumber(input.surpriseFactor ?? 2, 2);
  const baseInput = toKernelInput(input, token, rawSurprise);
  const selected = derive(baseInput);
  const context = resolveContext(input, baseInput, ingest.fixedPointValue, rawSurprise, selected);
  const sides = resolveCandidateSides(context.trapDirection, input.forcedSide);
  const matrix = buildMatrix(baseInput, context, selected);

  const success = selected.success;
  const selectedSide = success?.correctDirection ?? input.forcedSide ?? sides.preferred;
  const reason = selected.abstain?.reason;
  const presented = success ? fixedToNumber(success.presentedNumber) : Number.NaN;
  const trueNumber = fixedToNumber(context.trueFixed);
  const delta = success ? distance(success.presentedNumber, context.trueFixed) : Number.NaN;
  const ratio = success ? presentedRatio(success.presentedNumber, context.trueFixed) : Number.NaN;
  const percentDiff = success ? percentageDifference(success.presentedNumber, context.trueFixed) : Number.NaN;
  const snappingInterval = success
    ? snappingIntervalFor(success, context)
    : 0;
  const band = describeBand(context);
  const normalizedHint = input.quantityKind?.trim().toLowerCase() ?? "";

  return {
    traceVersion: DERIVATION_AUDIT_TRACE_VERSION,
    input: {
      token,
      trueNumber,
      unit: input.unit,
      rawSurprise,
      canonicalSurprise: context.canonicalSurprise,
      trapDirection: context.trapDirection,
      forcedSide: input.forcedSide,
      plausibleMin: optionalFiniteNumber(input.plausibleMin),
      plausibleMax: optionalFiniteNumber(input.plausibleMax),
    },
    classification: {
      quantityKind: context.kind,
      strategy: context.strategy,
      matchedUnitRule: describeUnitRule(input.unit, input.quantityKind, context.kind, normalizedHint),
      unitDescription: `${context.kind} (${context.strategy})`,
    },
    band: {
      ...band,
      surprise: context.canonicalSurprise,
      surpriseLabel: surpriseLabel(context.canonicalSurprise),
      magnitudeScale: context.magnitudeScale,
    },
    sideSelection: {
      trapDirection: context.trapDirection,
      trapSide: sides.preferred,
      forcedSide: input.forcedSide,
      selectedSide,
      rationale: describeSideSelection(context.trapDirection, input.forcedSide, selectedSide, success !== undefined),
    },
    boundsAndSnapping: {
      // DDM-4 returns a fully snapped value. It rejects out-of-bounds raw
      // candidates rather than clamping, so the final value is the only
      // kernel-authoritative candidate exposed by the legacy field.
      rawCandidate: presented,
      boundsClamped: false,
      snappedCandidate: presented,
      snappingInterval,
      remedyStage: 0,
      remedyStageId: success?.remedyStage,
      source: success?.source,
    },
    outcome: {
      presentedNumber: presented,
      trueNumber,
      unit: input.unit,
      correctDirection: selectedSide,
      delta,
      ratio,
      percentDiff,
      explanation: explainOutcome(success, context, selectedSide, reason),
      abstainReason: reason,
      source: success?.source,
      remedyStage: success?.remedyStage,
      magnitudeScale: context.magnitudeScale,
    },
    diagnostics: {
      modelVersion: DDM_VERSION,
      incomingNumericToken: token,
      trueNumberToken: formatFixedCanonical(context.trueFixed),
      presentedNumberToken: success ? formatFixedCanonical(success.presentedNumber) : undefined,
      source: success?.source,
      remedyStage: success?.remedyStage,
      magnitudeScale: context.magnitudeScale,
      plausibleMin: context.bounds ? fixedToNumber(context.bounds.min) : undefined,
      plausibleMax: context.bounds ? fixedToNumber(context.bounds.max) : undefined,
      abstainReason: reason,
    },
    abstainReason: reason,
    source: success?.source,
    remedyStage: success?.remedyStage,
    magnitudeScale: context.magnitudeScale,
    matrix,
  };
}

function asNumericToken(value: number | string): string {
  if (typeof value === "number") return String(value);
  return value.trim();
}

function finiteNumber(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value ?? fallback);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function optionalFiniteNumber(value: number | string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function toKernelInput(input: DerivationAuditInput, token: string, rawSurprise: number): DerivationInput {
  const kernelInput: DerivationInput = {
    incomingNumericToken: token,
    unit: input.unit,
    surpriseFactor: rawSurprise,
  };
  if (input.quantityKind !== undefined) kernelInput.quantityKind = input.quantityKind;
  if (input.trapDirection !== undefined) kernelInput.trapDirection = input.trapDirection;
  if (input.forcedSide !== undefined) kernelInput.forcedSide = input.forcedSide;

  const min = input.plausibleMin === undefined || input.plausibleMin === "" ? undefined : String(input.plausibleMin).trim();
  const max = input.plausibleMax === undefined || input.plausibleMax === "" ? undefined : String(input.plausibleMax).trim();
  if (min !== undefined && max !== undefined) {
    kernelInput.modelBounds = { minToken: min, maxToken: max };
  }
  return kernelInput;
}

function resolveContext(
  input: DerivationAuditInput,
  kernelInput: DerivationInput,
  trueFixed: FixedPointValue,
  rawSurprise: number,
  result: DerivationResult,
): ResolvedAuditContext {
  const diagnostic = result.success ?? result.abstain;
  const normalizedUnit = diagnostic?.normalizedUnit ?? normalizeUnit(input.unit);
  const kind = (diagnostic?.quantityKind ?? kernelClassifyQuantityKind(input.quantityKind ?? "", input.unit, trueFixed)[0]) as ContractQuantityKind;
  const canonicalSurprise = diagnostic?.surpriseFactor ?? kernelCanonicalizeSurprise(rawSurprise);
  const [magnitudeScale, magnitudeOK] = computeMagnitudeScale(trueFixed);
  const resolvedMagnitude = diagnostic?.magnitudeScale ?? (magnitudeOK ? magnitudeScale : 0);
  const trapDirection = diagnostic?.trapDirection ?? resolveTrapDirection(input.trapDirection ?? "", kind as KernelQuantityKind, normalizedUnit, trueFixed).trap;
  const strategy = strategyForKind(kind);

  let bounds: ResolvedAuditContext["bounds"];
  if (diagnostic?.plausibleMin !== undefined && diagnostic.plausibleMax !== undefined) {
    bounds = { min: diagnostic.plausibleMin, max: diagnostic.plausibleMax };
  } else {
    const resolvedBounds = resolveBounds(
      kind as KernelQuantityKind,
      normalizedUnit,
      trueFixed,
      kernelInput.factBankBounds,
      kernelInput.modelBounds,
    );
    if (resolvedBounds.ok && resolvedBounds.bounds !== undefined) bounds = resolvedBounds.bounds;
  }

  return {
    trueFixed,
    canonicalSurprise,
    kind,
    normalizedUnit,
    magnitudeScale: resolvedMagnitude,
    trapDirection,
    strategy,
    bounds,
  };
}

function buildMatrix(
  kernelInput: DerivationInput,
  context: ResolvedAuditContext,
  selected: DerivationResult,
): DerivationMatrixRow[] {
  const rows: DerivationMatrixRow[] = [];
  for (let surprise = 0; surprise <= 3; surprise += 1) {
    const more = matrixCandidate(deriveForcedSide(kernelInput, surprise, SideMore), context.trueFixed);
    const less = matrixCandidate(deriveForcedSide(kernelInput, surprise, SideLess), context.trueFixed);
    const winning = selected.success !== undefined && surprise === context.canonicalSurprise;
    const winningSide = winning ? selected.success?.correctDirection : undefined;
    rows.push({
      surprise,
      surpriseLabel: surpriseLabel(surprise),
      moreCandidate: more.candidate,
      moreDelta: more.delta,
      moreRatio: more.ratio,
      moreOutcome: more.outcome,
      moreAbstainReason: more.abstainReason,
      moreSource: more.source,
      moreRemedyStage: more.remedyStage,
      moreCandidateToken: more.candidateToken,
      lessCandidate: less.candidate,
      lessDelta: less.delta,
      lessRatio: less.ratio,
      lessOutcome: less.outcome,
      lessAbstainReason: less.abstainReason,
      lessSource: less.source,
      lessRemedyStage: less.remedyStage,
      lessCandidateToken: less.candidateToken,
      isWinningCandidate: winning,
      winningSide,
    });
  }
  return rows;
}

function deriveForcedSide(
  input: DerivationInput,
  surprise: number,
  side: CandidateSide,
): SideAuditResult {
  const result = derive({ ...input, surpriseFactor: surprise, forcedSide: side });
  return {
    side,
    success: result.success,
    abstain: result.abstain,
  };
}

function matrixCandidate(
  sideResult: SideAuditResult,
  trueFixed: FixedPointValue,
): MatrixCandidateValues {
  const success = sideResult.success;
  if (success === undefined) {
    return {
      candidate: Number.NaN,
      delta: Number.NaN,
      ratio: Number.NaN,
      outcome: "abstain",
      abstainReason: sideResult.abstain?.reason,
    };
  }

  const candidate = success.presentedNumber;
  return {
    candidate: fixedToNumber(candidate),
    delta: distance(candidate, trueFixed),
    ratio: displayRatio(candidate, trueFixed, sideResult.side),
    outcome: "success",
    source: success.source,
    remedyStage: success.remedyStage,
    candidateToken: formatFixedCanonical(candidate),
  };
}

function describeUnitRule(
  unit: string,
  hint: string | undefined,
  kind: QuantityKind,
  normalizedHint = hint?.trim().toLowerCase() ?? "",
): string {
  if (normalizedHint !== "" && normalizedHint === kind) {
    return "Model quantity-kind hint accepted by the DDM-4 classifier.";
  }
  if (hint !== undefined && hint.trim() !== "") {
    return "DDM-4 classifier ignored the invalid or incoherent quantity-kind hint and inferred the kind.";
  }
  return `DDM-4 classifier inferred ${kind} from normalized unit "${normalizeUnit(unit)}" and the true value.`;
}

function describeSideSelection(
  trapDirection: TrapDirection,
  forcedSide: CandidateSide | undefined,
  selectedSide: CandidateSide,
  succeeded: boolean,
): string {
  if (forcedSide !== undefined) {
    return `Forced side ${forcedSide} takes precedence over trap direction ${trapDirection}; the DDM-4 kernel restricted remedies to that side${succeeded ? "." : " and abstained."}`;
  }
  if (!succeeded) {
    return `Trap direction ${trapDirection} selected ${selectedSide}; the DDM-4 kernel exhausted the permitted remedy ladder.`;
  }
  return `Trap direction ${trapDirection} selected ${selectedSide}; the DDM-4 kernel may use the permitted opposite-side remedy when the preferred side is exhausted.`;
}

function surpriseLabel(surprise: number): string {
  return SURPRISE_DESCRIPTIONS[surprise] ?? `Canonical surprise ${surprise}`;
}

function describeBand(context: ResolvedAuditContext): Omit<DerivationAuditTrace["band"], "surprise" | "surpriseLabel"> {
  const composed = composeDistanceBand(
    context.kind as KernelQuantityKind,
    context.canonicalSurprise,
    context.magnitudeScale,
    context.trueFixed,
  );
  const band = composed.band;
  const multiplicative = band.strategy === "multiplicative";
  const factors = band.factorUnit > 0
    ? [band.minFactorPermille / band.factorUnit, band.maxFactorPermille / band.factorUnit]
    : [1, 1];
  const deltaMin = multiplicative ? undefined : fixedToNumber(band.minDelta);
  const deltaMax = multiplicative ? undefined : fixedToNumber(band.maxDelta);
  const factorDescription = `${factors[0]}x–${factors[1]}x`;
  const deltaDescription = `${formatFixedCanonical(band.minDelta)}–${formatFixedCanonical(band.maxDelta)}`;
  const description = composed.ok
    ? multiplicative
      ? `DDM-4 multiplicative band ${factorDescription} (${band.variant} magnitude variant).`
      : `DDM-4 ${band.strategy} delta band ${deltaDescription} (${band.variant} magnitude variant).`
    : "DDM-4 band unavailable because the generated table could not be composed.";

  return {
    factorMin: factors[0],
    factorMax: factors[1],
    deltaMin,
    deltaMax,
    bandDescription: description,
    variant: band.variant,
  };
}

function snappingIntervalFor(
  success: NonNullable<DerivationResult["success"]>,
  context: ResolvedAuditContext,
): number {
  if (context.bounds === undefined) return 0;
  const snapped = snapCandidate(
    context.kind as KernelQuantityKind,
    success.presentedNumber,
    success.correctDirection,
    context.trueFixed,
    context.bounds,
  );
  if (!snapped.accepted) return 0;
  const exponent = snapped.stepExp;
  const [power, ok] = pow10(Math.abs(exponent));
  if (!ok || !Number.isFinite(power) || power === 0) return 0;
  return exponent >= 0 ? power : 1 / power;
}

function explainOutcome(
  success: NonNullable<DerivationResult["success"]> | undefined,
  context: ResolvedAuditContext,
  selectedSide: CandidateSide,
  reason: AbstainReason | undefined,
): string {
  if (success === undefined) {
    return `DDM-4 abstained (${reason ?? "NO_CANDIDATE_PASSES_GATE"}); no presented number was emitted.`;
  }
  const presented = fixedToNumber(success.presentedNumber);
  const truth = fixedToNumber(context.trueFixed);
  const delta = distance(success.presentedNumber, context.trueFixed);
  const relation = selectedSide === SideMore ? "greater" : "smaller";
  return `DDM-4 ${success.source} derivation: true ${truth} ${context.normalizedUnit} vs presented ${presented} ${context.normalizedUnit}; true is ${relation} by ${delta}. Correct answer: ${success.correctDirection}. Remedy stage: ${success.remedyStage}.`;
}

function fixedToNumber(value: FixedPointValue): number {
  const [factor, ok] = pow10(value.scale);
  if (!ok) return Number.NaN;
  const magnitude = value.scale === 0 ? value.mantissa : value.mantissa / factor;
  return value.negative ? -magnitude : magnitude;
}

function distance(left: FixedPointValue, right: FixedPointValue): number {
  const [difference, ok] = subtractFixed(left, right);
  if (!ok) return Number.NaN;
  const [normalized, normalizedOK] = normalizeFixed({ ...difference, negative: false });
  return normalizedOK ? fixedToNumber(normalized) : Number.NaN;
}

function presentedRatio(presented: FixedPointValue, truth: FixedPointValue): number {
  const presentedNumber = fixedToNumber(presented);
  const trueNumber = fixedToNumber(truth);
  if (trueNumber === 0) return presentedNumber;
  return presentedNumber / trueNumber;
}

function displayRatio(candidate: FixedPointValue, truth: FixedPointValue, side: CandidateSide): number {
  const candidateNumber = fixedToNumber(candidate);
  const trueNumber = fixedToNumber(truth);
  if (trueNumber === 0 || candidateNumber === 0) return 1;
  return side === SideMore ? trueNumber / candidateNumber : candidateNumber / trueNumber;
}

function percentageDifference(presented: FixedPointValue, truth: FixedPointValue): number {
  const presentedNumber = fixedToNumber(presented);
  const trueNumber = fixedToNumber(truth);
  if (trueNumber === 0) return presentedNumber === 0 ? 0 : 100;
  return Math.round(((presentedNumber - trueNumber) / trueNumber) * 100);
}
