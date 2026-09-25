/**
 * The Admin Firestore precompute boundary is deliberately tested against the
 * vendored DDM-4 kernel. These tests are local and pure: no Firestore, network,
 * generated-table, or deployment work is involved.
 */
import { describe, expect, it } from "vitest";

import {
  deriveBankRound,
  stableFactKey,
  toCurrentPrecomputedDerivation,
  toPrecomputedDerivation,
  type BankPrecomputeFact,
  type FirestoreDerivationBlock,
} from "../src/lib/admin/ddm-precompute";
import {
  DDMVersion,
  KindPercentChange,
  SideLess,
  SideMore,
  TrapUnderestimate,
  derive,
  formatFixedCanonical,
  schemaIngestRaw,
  type CandidateSide,
  type PrecomputedDerivation,
} from "../shared/ddm/derivation";

function validBlock(): FirestoreDerivationBlock {
  return {
    model_version: DDMVersion,
    quantity_kind: KindPercentChange,
    trap_direction: TrapUnderestimate,
    plausible_min: "-100.00",
    plausible_max: "3400.000",
    canonical_surprise_factor: 1,
    distractors: [
      { surprise_factor: 1, side: SideMore, presented_number: "252.00" },
      { surprise_factor: 1, side: SideLess, presented_number: "425.0" },
    ],
  };
}

function percentChangeInput(side?: CandidateSide, precomputed?: PrecomputedDerivation) {
  return schemaIngestRaw(
    {
      trueNumberToken: "340",
      unit: "percent change",
      quantityKind: KindPercentChange,
      plausibleMinToken: "-100.00",
      plausibleMaxToken: "3400.000",
      surpriseFactor: 1,
    },
    side,
    precomputed,
  );
}

function deriveViaProductionAdapter(
  input: NonNullable<ReturnType<typeof percentChangeInput>["input"]>,
  block: unknown,
  side?: CandidateSide,
) {
  const bounds = input.factBankBounds ?? input.modelBounds;
  const fact: BankPrecomputeFact = {
    category: "Test",
    sub_category: "",
    specialty: "Adapter",
    fact: "test",
    number_token: input.incomingNumericToken,
    unit: input.unit,
    surprise_factor: input.surpriseFactor,
    quantity_kind: input.quantityKind,
    plausible_min: bounds?.minToken,
    plausible_max: bounds?.maxToken,
    derivation: block as BankPrecomputeFact["derivation"],
  };
  return deriveBankRound(fact, side);
}

function liveToken(side: CandidateSide): string {
  const ingest = percentChangeInput(side);
  if (ingest.input === undefined) throw new Error("percent-change input did not ingest");
  const result = derive(ingest.input);
  if (result.success === undefined) throw new Error("percent-change input did not derive");
  const token = formatFixedCanonical(result.success.presentedNumber);
  return token.includes(".") ? `${token}0` : `${token}.0`;
}

describe("Firestore DDM precompute adapter", () => {
  it("converts ddm-4 snake_case fields losslessly and preserves exact numeric spellings", () => {
    const block = validBlock();
    const before = JSON.stringify(block);

    const converted = toPrecomputedDerivation(block);

    expect(converted).toStrictEqual({
      modelVersion: DDMVersion,
      quantityKind: KindPercentChange,
      trapDirection: TrapUnderestimate,
      plausibleMin: "-100.00",
      plausibleMax: "3400.000",
      distractors: [
        { surpriseFactor: 1, side: SideMore, presentedNumber: "252.00" },
        { surpriseFactor: 1, side: SideLess, presentedNumber: "425.0" },
      ],
    });
    expect(JSON.stringify(block)).toBe(before);
  });

  it("rejects malformed block shapes without returning partial fields", () => {
    const malformed: unknown[] = [
      null,
      [],
      { ...validBlock(), model_version: "" },
      { ...validBlock(), model_version: 4 },
      { ...validBlock(), quantity_kind: "not-a-quantity-kind" },
      { ...validBlock(), trap_direction: "SIDEWAYS" },
      { ...validBlock(), plausible_min: "1e3" },
      { ...validBlock(), plausible_max: 3400 },
      { ...validBlock(), distractors: {} },
    ];

    for (const block of malformed) {
      expect(toPrecomputedDerivation(block)).toBeUndefined();
    }
  });

  it("drops malformed individual distractors instead of reparsing their values", () => {
    const converted = toPrecomputedDerivation({
      ...validBlock(),
      distractors: [
        { surprise_factor: 1, side: SideMore, presented_number: "252.00" },
        { surprise_factor: 1.5, side: SideMore, presented_number: "200" },
        { surprise_factor: 1, side: "SIDEWAYS", presented_number: "200" },
        { surprise_factor: 1, side: SideMore, presented_number: "1e3" },
        { surprise_factor: 1, side: SideMore, presented_number: 252 },
        null,
        { surprise_factor: 1, side: SideLess, presented_number: "425.0" },
      ],
    });

    expect(converted?.distractors).toStrictEqual([
      { surpriseFactor: 1, side: SideMore, presentedNumber: "252.00" },
      { surpriseFactor: 1, side: SideLess, presentedNumber: "425.0" },
    ]);
  });

  it("retains the production stable fact key shape", () => {
    const fact = {
      category: "Sports",
      sub_category: "Soccer",
      specialty: "Players",
      angle: "Top speed",
      fact: "A player scored 1",
    };

    expect(stableFactKey(fact)).toBe("Sports|Soccer|Players|Top speed|A player scored 1");
    expect(stableFactKey({ ...fact, angle: undefined })).toBe(
      "Sports|Soccer|Players||A player scored 1",
    );
    expect(stableFactKey({ ...fact, angle: null })).toBe(
      "Sports|Soccer|Players||A player scored 1",
    );
  });

  it("selects same-key alternates deterministically and leaves other groups alone", () => {
    const block: FirestoreDerivationBlock = {
      ...validBlock(),
      distractors: [
        { surprise_factor: 1, side: SideMore, presented_number: "1" },
        { surprise_factor: 1, side: SideLess, presented_number: "2" },
        { surprise_factor: 1, side: SideMore, presented_number: "3" },
        { surprise_factor: 1, side: SideMore, presented_number: "4" },
      ],
    };
    const factKey = "Sports|Soccer|Players|Top speed|A player scored 1";

    const unrotated = toPrecomputedDerivation(block);
    const first = toPrecomputedDerivation(block, "daily", factKey);
    const second = toPrecomputedDerivation(block, "daily", factKey);

    expect(unrotated?.distractors.map((entry) => entry.presentedNumber)).toEqual(["1", "2", "3", "4"]);
    expect(first).toStrictEqual(second);
    expect(first?.distractors.map((entry) => entry.presentedNumber)).toEqual(["4", "2", "1", "3"]);
  });

  it("accepts percent_change bounds and forced-side inputs through the DDM re-gate", () => {
    const block: FirestoreDerivationBlock = {
      ...validBlock(),
      distractors: [
        { surprise_factor: 1, side: SideMore, presented_number: liveToken(SideMore) },
        { surprise_factor: 1, side: SideLess, presented_number: liveToken(SideLess) },
      ],
    };
    const precomputed = toPrecomputedDerivation(block);
    expect(precomputed?.quantityKind).toBe(KindPercentChange);

    for (const side of [SideMore, SideLess]) {
      const ingest = percentChangeInput(side, precomputed);
      expect(ingest.input).toBeDefined();
      const result = derive(ingest.input!);

      expect(result.success?.source).toBe("precomputed");
      expect(result.success?.correctDirection).toBe(side);
      expect(result.success?.quantityKind).toBe(KindPercentChange);
      expect(result.success?.plausibleMin).toEqual({ negative: true, mantissa: 100, scale: 0 });
      expect(result.success?.plausibleMax).toEqual({ negative: false, mantissa: 3400, scale: 0 });
    }
  });

  it("rejects stale blocks for strict consumers and retries them live without stale fields", () => {
    const stale = {
      ...validBlock(),
      model_version: "ddm-999",
      quantity_kind: "rating",
      plausible_min: "0.00",
      plausible_max: "10.00",
      distractors: [{ surprise_factor: 1, side: SideMore, presented_number: "999.00" }],
    };

    expect(toPrecomputedDerivation(stale)).toBeDefined();
    expect(toCurrentPrecomputedDerivation(stale)).toBeUndefined();

    const ingest = schemaIngestRaw({
      trueNumberToken: "340",
      unit: "percent change",
      quantityKind: KindPercentChange,
      surpriseFactor: 1,
    });
    const result = deriveViaProductionAdapter(ingest.input!, stale);

    expect(result?.source).toBe("live");
    expect(result?.quantityKind).toBe(KindPercentChange);
    expect(result?.presented).not.toBe(999);
    expect(result?.plausibleMin).not.toBe(0);
  });

  it("falls live when a valid block's candidate fails the re-gate", () => {
    const rejected = {
      ...validBlock(),
      quantity_kind: "rating",
      plausible_min: "0.00",
      plausible_max: "10.00",
      distractors: [{ surprise_factor: 1, side: SideMore, presented_number: "340.00" }],
    };
    const ingest = schemaIngestRaw({
      trueNumberToken: "340",
      unit: "percent change",
      quantityKind: KindPercentChange,
      surpriseFactor: 1,
    });
    const result = deriveViaProductionAdapter(ingest.input!, rejected);

    expect(result?.source).toBe("live");
    expect(result?.quantityKind).toBe(KindPercentChange);
    expect(result?.presented).not.toBe(340);
    expect(result?.plausibleMin).not.toBe(0);
  });

  it("drops a malformed block and an existing precompute before live derivation", () => {
    const malformed = {
      ...validBlock(),
      plausible_min: "not-a-token",
      quantity_kind: "rating",
      distractors: [{ surprise_factor: 1, side: SideMore, presented_number: "999.00" }],
    };
    const stalePrecomputed: PrecomputedDerivation = {
      modelVersion: DDMVersion,
      quantityKind: "rating",
      trapDirection: TrapUnderestimate,
      plausibleMin: "0.00",
      plausibleMax: "10.00",
      distractors: [{ surpriseFactor: 1, side: SideMore, presentedNumber: "888.00" }],
    };
    const ingest = schemaIngestRaw({
      trueNumberToken: "340",
      unit: "percent change",
      quantityKind: KindPercentChange,
      surpriseFactor: 1,
    });
    const result = deriveViaProductionAdapter(
      { ...ingest.input!, precomputed: stalePrecomputed },
      malformed,
    );

    expect(result?.source).toBe("live");
    expect(result?.quantityKind).toBe(KindPercentChange);
    expect(result?.presented).not.toBe(999);
    expect(result?.plausibleMin).not.toBe(0);
  });
});
