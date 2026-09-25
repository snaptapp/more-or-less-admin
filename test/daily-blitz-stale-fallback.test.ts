import { describe, expect, it } from "vitest";

import { DDMVersion } from "../shared/ddm/derivation";
import {
  factToBlitzRound,
  parseDerivationBlock,
  type FactDerivationBlock,
} from "../src/lib/admin/daily-blitz";

const CURRENT_PLAUSIBLE_MIN = "-100.00";
const CURRENT_PLAUSIBLE_MAX = "3400.000";

function currentBlock(): FactDerivationBlock {
  return {
    model_version: DDMVersion,
    quantity_kind: "percent_change",
    trap_direction: "UNDERESTIMATE",
    plausible_min: CURRENT_PLAUSIBLE_MIN,
    plausible_max: CURRENT_PLAUSIBLE_MAX,
    distractors: [
      { surprise_factor: 1, side: "MORE", presented_number: "252.00" },
      { surprise_factor: 1, side: "LESS", presented_number: "425.0" },
    ],
  };
}

function baseInput(derivation?: FactDerivationBlock | null) {
  return {
    subject: "Example metric",
    question: "What is the measured value?",
    unit: "percent change",
    true_number: 340,
    surprise_factor: 1,
    quantity_kind: "percent_change",
    plausible_min: CURRENT_PLAUSIBLE_MIN,
    plausible_max: CURRENT_PLAUSIBLE_MAX,
    derivation,
    round_number: 1,
  };
}

function requireRound(result: ReturnType<typeof factToBlitzRound>) {
  if ("error" in result) throw new Error(result.error);
  return result.round;
}

describe("Daily Blitz DDM boundary", () => {
  it("accepts only the current DDM version and structurally valid blocks", () => {
    const current = currentBlock();

    expect(parseDerivationBlock(current)).toMatchObject({
      model_version: DDMVersion,
      quantity_kind: "percent_change",
      trap_direction: "UNDERESTIMATE",
      plausible_min: CURRENT_PLAUSIBLE_MIN,
      plausible_max: CURRENT_PLAUSIBLE_MAX,
    });
    expect(parseDerivationBlock({ ...current, model_version: "ddm-999" })).toBeNull();
    expect(parseDerivationBlock({ ...current, plausible_min: "not-a-token" })).toBeNull();
    expect(parseDerivationBlock({ ...current, distractors: {} })).toBeNull();
  });

  it("re-gates a current block through the vendored DDM", () => {
    const block = currentBlock();
    const round = requireRound(factToBlitzRound(baseInput(parseDerivationBlock(block))));

    expect(round.presented_number).toBe(252);
    expect(round.correct_direction).toBe("MORE");
    expect(round.quantity_kind).toBe("percent_change");
    expect(round.trap_direction).toBe("UNDERESTIMATE");
    expect(round.plausible_min).toBe(-100);
    expect(round.plausible_max).toBe(3400);
  });

  it("rejects a current block whose candidate fails the gate and derives live", () => {
    const rejected: FactDerivationBlock = {
      ...currentBlock(),
      quantity_kind: "rating",
      trap_direction: "OVERESTIMATE",
      plausible_min: "0.00",
      plausible_max: "10.00",
      distractors: [{ surprise_factor: 1, side: "MORE", presented_number: "340" }],
    };
    const round = requireRound(factToBlitzRound(baseInput(parseDerivationBlock(rejected))));

    expect(round.presented_number).not.toBe(340);
    expect(round.quantity_kind).toBe("percent_change");
    expect(round.trap_direction).toBe("UNDERESTIMATE");
    expect(round.plausible_min).not.toBe(0);
    expect(round.plausible_max).not.toBe(10);
  });

  it("rejects stale blocks and retries live without exposing stale metadata", () => {
    const stale: FactDerivationBlock = {
      ...currentBlock(),
      model_version: "ddm-999",
      quantity_kind: "rating",
      trap_direction: "OVERESTIMATE",
      plausible_min: "0.00",
      plausible_max: "10.00",
      distractors: [{ surprise_factor: 1, side: "MORE", presented_number: "999.00" }],
    };

    expect(parseDerivationBlock(stale)).toBeNull();
    const directRound = requireRound(factToBlitzRound(baseInput(stale)));
    const parsedRound = requireRound(factToBlitzRound(baseInput(parseDerivationBlock(stale))));
    const malformed = { ...stale, model_version: DDMVersion, plausible_min: "not-a-token" };
    expect(parseDerivationBlock(malformed)).toBeNull();
    const malformedRound = requireRound(factToBlitzRound(baseInput(malformed)));

    expect(parsedRound).toEqual(directRound);
    expect(malformedRound).toEqual(directRound);
    expect(directRound.presented_number).not.toBe(999);
    expect(directRound.quantity_kind).toBe("percent_change");
    expect(directRound.trap_direction).toBe("UNDERESTIMATE");
    expect(directRound.plausible_min).not.toBe(0);
    expect(directRound.plausible_max).not.toBe(10);
  });

  it("returns the existing safe error when live derivation abstains", () => {
    const result = factToBlitzRound({
      subject: "Year zero",
      unit: "year",
      true_number: 0,
      round_number: 1,
    });

    expect(result).toEqual({
      error:
        "This fact has no DDM-gated distractor. Draft with the Go agent or pick another fact from the bank.",
    });
  });
});
