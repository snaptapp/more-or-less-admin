/**
 * DDM-4 auditor contract tests.
 *
 * The auditor is a presentation adapter. These tests deliberately compare its
 * emitted values and abstain reasons with direct calls to the vendored kernel;
 * no expected distractor table is duplicated here.
 */
import { describe, expect, it } from "vitest";

import {
  DDM_VERSION,
  auditDerivation,
  type DerivationAuditInput,
  type QuantityKind,
} from "../src/lib/admin/derivation-audit";
import {
  DDMVersion,
  KindCount,
  KindDuration,
  KindMoney,
  KindPercentChange,
  KindPercentage,
  KindPhysicalMeasure,
  KindRating,
  KindRatio,
  KindYear,
  SideLess,
  SideMore,
  derive,
  formatFixedCanonical,
  schemaIngestRaw,
  type DerivationInput,
  type FixedPointValue,
} from "../shared/ddm/derivation";

const KIND_CASES: ReadonlyArray<{
  kind: QuantityKind;
  input: DerivationAuditInput;
}> = [
  { kind: KindYear, input: { trueNumber: "1897", unit: "year", surpriseFactor: 1, quantityKind: KindYear } },
  { kind: KindCount, input: { trueNumber: "1000", unit: "people", surpriseFactor: 1, quantityKind: KindCount } },
  { kind: KindPercentage, input: { trueNumber: "40", unit: "%", surpriseFactor: 1, quantityKind: KindPercentage } },
  { kind: KindPercentChange, input: { trueNumber: "340", unit: "percent change", surpriseFactor: 1, quantityKind: KindPercentChange } },
  { kind: KindRatio, input: { trueNumber: "8", unit: "ratio", surpriseFactor: 1, quantityKind: KindRatio } },
  { kind: KindPhysicalMeasure, input: { trueNumber: "42", unit: "km", surpriseFactor: 2, quantityKind: KindPhysicalMeasure } },
  { kind: KindMoney, input: { trueNumber: "500", unit: "dollars", surpriseFactor: 1, quantityKind: KindMoney } },
  { kind: KindDuration, input: { trueNumber: "90", unit: "seconds", surpriseFactor: 1, quantityKind: KindDuration } },
  { kind: KindRating, input: { trueNumber: "7", unit: "rating", surpriseFactor: 1, quantityKind: KindRating } },
];

function toKernelInput(input: DerivationAuditInput): DerivationInput {
  const token = String(input.trueNumber).trim();
  const bounds = input.plausibleMin !== undefined && input.plausibleMax !== undefined
    ? {
        plausibleMinToken: String(input.plausibleMin),
        plausibleMaxToken: String(input.plausibleMax),
      }
    : {};
  const ingest = schemaIngestRaw(
    {
      trueNumberToken: token,
      unit: input.unit,
      quantityKind: input.quantityKind,
      trapDirection: input.trapDirection,
      surpriseFactor: Number(input.surpriseFactor ?? 2),
      ...bounds,
    },
    input.forcedSide,
  );
  if (ingest.input === undefined) throw new Error(`unexpected schema abstain: ${ingest.abstain?.reason}`);
  return ingest.input;
}

function fixedNumber(value: FixedPointValue): number {
  const factor = 10 ** value.scale;
  const magnitude = value.scale === 0 ? value.mantissa : value.mantissa / factor;
  return value.negative ? -magnitude : magnitude;
}

function kernelSuccess(input: DerivationInput) {
  const result = derive(input);
  if (result.success === undefined) throw new Error(`expected success, got ${result.abstain?.reason}`);
  return result.success;
}

describe("DDM-4 derivation auditor", () => {
  it("pins the trace to the vendored DDM-4 kernel and preserves the legacy fields", () => {
    const input = KIND_CASES[1].input;
    const trace = auditDerivation(input);
    const success = kernelSuccess(toKernelInput(input));

    expect(DDM_VERSION).toBe(DDMVersion);
    expect(trace.traceVersion).toBe(DDMVersion);
    expect(trace.input).toMatchObject({
      token: "1000",
      trueNumber: 1000,
      rawSurprise: 1,
      canonicalSurprise: 1,
    });
    expect(trace.classification.quantityKind).toBe(KindCount);
    expect(trace.outcome.presentedNumber).toBe(fixedNumber(success.presentedNumber));
    expect(trace.outcome.correctDirection).toBe(success.correctDirection);
    expect(trace.outcome.source).toBe(success.source);
    expect(trace.outcome.remedyStage).toBe(success.remedyStage);
    expect(trace.diagnostics.presentedNumberToken).toBe(formatFixedCanonical(success.presentedNumber));
    expect(trace.boundsAndSnapping.boundsClamped).toBe(false);
    expect(trace.matrix).toHaveLength(4);
  });

  it("calls the kernel for both candidate sides across all nine quantity kinds", () => {
    for (const { kind, input } of KIND_CASES) {
      const trace = auditDerivation(input);
      const success = kernelSuccess(toKernelInput(input));

      expect(trace.classification.quantityKind, kind).toBe(kind);
      expect(trace.outcome.presentedNumber, kind).toBe(fixedNumber(success.presentedNumber));
      expect(trace.outcome.correctDirection, kind).toBe(success.correctDirection);
      expect(trace.boundsAndSnapping.snappingInterval, kind).toBeGreaterThan(0);
      expect(trace.matrix, kind).toHaveLength(4);

      for (const row of trace.matrix) {
        expect(row.moreOutcome, `${kind} surprise ${row.surprise} MORE`).toBeDefined();
        expect(row.lessOutcome, `${kind} surprise ${row.surprise} LESS`).toBeDefined();
      }
    }
  });

  it("keeps resolved bounds and reports them from the kernel rather than clamping them", () => {
    const input: DerivationAuditInput = {
      trueNumber: "1000",
      unit: "people",
      quantityKind: KindCount,
      surpriseFactor: 1,
      plausibleMin: "100",
      plausibleMax: "5000",
    };
    const trace = auditDerivation(input);
    const success = kernelSuccess(toKernelInput(input));

    expect(trace.diagnostics.plausibleMin).toBe(fixedNumber(success.plausibleMin));
    expect(trace.diagnostics.plausibleMax).toBe(fixedNumber(success.plausibleMax));
    expect(trace.boundsAndSnapping.boundsClamped).toBe(false);
    expect(trace.outcome.presentedNumber).toBe(fixedNumber(success.presentedNumber));
  });

  it("preserves forced-side precedence and exposes the forced-side trace", () => {
    const base: DerivationAuditInput = {
      trueNumber: "42",
      unit: "km",
      quantityKind: KindPhysicalMeasure,
      surpriseFactor: 2,
      trapDirection: "OVERESTIMATE",
    };

    const more = auditDerivation({ ...base, forcedSide: SideMore });
    const less = auditDerivation({ ...base, forcedSide: SideLess });

    expect(more.sideSelection.forcedSide).toBe(SideMore);
    expect(more.sideSelection.selectedSide).toBe(SideMore);
    expect(more.outcome.correctDirection).toBe(SideMore);
    expect(more.outcome.remedyStage).toBe("preferred_side");
    expect(more.matrix[2].moreOutcome).toBe("success");
    expect(more.matrix[2].winningSide).toBe(SideMore);

    expect(less.sideSelection.forcedSide).toBe(SideLess);
    expect(less.sideSelection.selectedSide).toBe(SideLess);
    expect(less.outcome.correctDirection).toBe(SideLess);
    expect(less.outcome.remedyStage).toBe("preferred_side");
    expect(less.matrix[2].lessOutcome).toBe("success");
    expect(less.matrix[2].winningSide).toBe(SideLess);
  });

  it("uses the kernel Zero Value Strategy for zero and records its source", () => {
    const input: DerivationAuditInput = {
      trueNumber: "-0",
      unit: "people",
      quantityKind: KindCount,
      surpriseFactor: 1,
      plausibleMin: "0",
      plausibleMax: "1000",
    };
    const trace = auditDerivation(input);
    const success = kernelSuccess(toKernelInput(input));

    expect(trace.input.token).toBe("-0");
    expect(trace.input.trueNumber).toBe(0);
    expect(trace.outcome.presentedNumber).toBe(fixedNumber(success.presentedNumber));
    expect(trace.outcome.source).toBe("zero_value");
    expect(trace.diagnostics.presentedNumberToken).toBe(formatFixedCanonical(success.presentedNumber));
    expect(trace.matrix.some((row) => row.moreOutcome === "success" || row.lessOutcome === "success")).toBe(true);
  });

  it("maps kernel abstain reasons deterministically for bounded and forced-side failures", () => {
    const bounded: DerivationAuditInput = {
      trueNumber: "200",
      unit: "passer rating",
      surpriseFactor: 1,
      plausibleMin: "0",
      plausibleMax: "10",
    };
    const first = auditDerivation(bounded);
    const second = auditDerivation(bounded);
    expect(first.abstainReason).toBe("BOUNDS_INCOHERENT");
    expect(first.diagnostics.abstainReason).toBe("BOUNDS_INCOHERENT");
    expect(second).toEqual(first);

    const forced: DerivationAuditInput = {
      trueNumber: "0",
      unit: "people",
      quantityKind: KindCount,
      surpriseFactor: 1,
      plausibleMin: "0",
      plausibleMax: "1000",
      forcedSide: SideMore,
    };
    const forcedTrace = auditDerivation(forced);
    expect(forcedTrace.abstainReason).toBe("NO_CANDIDATE_PASSES_GATE");
    expect(forcedTrace.matrix.every((row) => row.moreOutcome === "abstain")).toBe(true);
    expect(forcedTrace.matrix.every((row) => row.moreAbstainReason === "NO_CANDIDATE_PASSES_GATE")).toBe(true);
  });

  it("retains exact numeric token spelling through the audit boundary", () => {
    const trace = auditDerivation({
      trueNumber: "1.5e3",
      unit: "people",
      quantityKind: KindCount,
      surpriseFactor: 1,
      plausibleMin: "-1000",
      plausibleMax: "5000",
    });
    expect(trace.input.token).toBe("1.5e3");
    expect(trace.diagnostics.incomingNumericToken).toBe("1.5e3");
    expect(trace.diagnostics.trueNumberToken).toBe("1500");
    expect(trace.outcome.presentedNumber).toBe(fixedNumber(kernelSuccess(toKernelInput({
      trueNumber: "1.5e3",
      unit: "people",
      quantityKind: KindCount,
      surpriseFactor: 1,
      plausibleMin: "-1000",
      plausibleMax: "5000",
    })).presentedNumber));
  });

  it("reports adaptive rating strategy consistently as bounded <=10 and multiplicative >10", () => {
    const boundedTrace = auditDerivation({
      trueNumber: "7",
      unit: "rating",
      quantityKind: KindRating,
      surpriseFactor: 1,
    });
    expect(boundedTrace.classification.strategy).toBe("bounded");
    expect(boundedTrace.classification.unitDescription).toBe("rating (bounded)");

    const multiplicativeTrace = auditDerivation({
      trueNumber: "120",
      unit: "rating",
      quantityKind: KindRating,
      surpriseFactor: 1,
    });
    expect(multiplicativeTrace.classification.strategy).toBe("multiplicative");
    expect(multiplicativeTrace.classification.unitDescription).toBe("rating (multiplicative)");
  });
});
