// Task 5 (first slice) playable-candidate parity replay for Admin.
//
// Replays every case in the vendored Go-captured fixture
// shared/fact-quality/fixtures/derivation_playable_candidates.json through the
// vendored DDM kernel's enumeratePlayableCandidateGroups and compares the
// translated result field-for-field, including all provenance fields
// (remedy_stage, calibration_tier) and serialized abstain diagnostics. The
// fixture and the vendored kernel are read-only handoff artifacts; this gate
// never invents per-language expected values.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  enumeratePlayableCandidateGroups,
  type CandidateGroup,
  type CandidateSide,
  type DerivationAbstain,
  type DerivationInput,
  type QuantityKind,
  type TrapDirection,
} from "../shared/ddm/derivation";

interface FixtureBoundsHint {
  min_token: string;
  max_token: string;
}

interface FixturePrecomputedDistractor {
  surprise_factor: number;
  side: CandidateSide;
  presented_number: string;
}

interface FixturePrecomputed {
  model_version: string;
  quantity_kind: string;
  trap_direction: string;
  plausible_min: string;
  plausible_max: string;
  distractors: FixturePrecomputedDistractor[] | null;
}

interface FixtureInput {
  incoming_numeric_token: string;
  unit: string;
  quantity_kind?: string;
  trap_direction?: string;
  fact_bank_bounds?: FixtureBoundsHint;
  model_bounds?: FixtureBoundsHint;
  surprise_factor: number;
  forced_side?: CandidateSide;
  precomputed?: FixturePrecomputed;
}

interface PlayableFixtureCase {
  name: string;
  input: FixtureInput;
  groups: unknown[] | null;
  abstain: unknown;
}

interface PlayableFixture {
  schema: string;
  cases: PlayableFixtureCase[];
}

function mapFixtureInput(fi: FixtureInput): DerivationInput {
  const input: DerivationInput = {
    incomingNumericToken: fi.incoming_numeric_token,
    unit: fi.unit,
    surpriseFactor: fi.surprise_factor,
  };
  if (fi.quantity_kind !== undefined) input.quantityKind = fi.quantity_kind;
  if (fi.trap_direction !== undefined) input.trapDirection = fi.trap_direction;
  if (fi.fact_bank_bounds !== undefined) {
    input.factBankBounds = {
      minToken: fi.fact_bank_bounds.min_token,
      maxToken: fi.fact_bank_bounds.max_token,
    };
  }
  if (fi.model_bounds !== undefined) {
    input.modelBounds = {
      minToken: fi.model_bounds.min_token,
      maxToken: fi.model_bounds.max_token,
    };
  }
  if (fi.forced_side !== undefined) input.forcedSide = fi.forced_side;
  if (fi.precomputed !== undefined) {
    input.precomputed = {
      modelVersion: fi.precomputed.model_version,
      quantityKind: fi.precomputed.quantity_kind as QuantityKind,
      trapDirection: fi.precomputed.trap_direction as TrapDirection,
      plausibleMin: fi.precomputed.plausible_min,
      plausibleMax: fi.precomputed.plausible_max,
      distractors: (fi.precomputed.distractors ?? []).map((d) => ({
        surpriseFactor: d.surprise_factor,
        side: d.side,
        presentedNumber: d.presented_number,
      })),
    };
  }
  return input;
}

// Go marshals a nil group slice as null; translate the empty inventory the
// same way.
function groupsToSnake(groups: CandidateGroup[]): unknown {
  if (groups.length === 0) return null;
  return groups.map((g) => ({
    surprise_factor: g.surpriseFactor,
    side: g.side,
    remedy_stage: g.remedyStage,
    calibration_tier: g.calibrationTier,
    candidates: g.candidates.map((c) => ({
      value: c.value,
      side: c.side,
      remedy_stage: c.remedyStage,
      calibration_tier: c.calibrationTier,
    })),
  }));
}

function abstainToSnake(a: DerivationAbstain | undefined): unknown {
  if (a === undefined) return null;
  const out: Record<string, unknown> = {
    outcome: a.outcome,
    reason: a.reason,
    incoming_numeric_token: a.incomingNumericToken ?? "",
  };
  if (a.fixedPointValue !== undefined) out.fixed_point_value = a.fixedPointValue;
  if (a.normalizedUnit) out.normalized_unit = a.normalizedUnit;
  if (a.quantityKind) out.quantity_kind = a.quantityKind;
  if (a.surpriseFactor !== undefined) out.surprise_factor = a.surpriseFactor;
  if (a.magnitudeScale !== undefined) out.magnitude_scale = a.magnitudeScale;
  if (a.trapDirection) out.trap_direction = a.trapDirection;
  if (a.plausibleMin !== undefined) out.plausible_min = a.plausibleMin;
  if (a.plausibleMax !== undefined) out.plausible_max = a.plausibleMax;
  return out;
}

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../shared/fact-quality/fixtures/derivation_playable_candidates.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
) as PlayableFixture;

describe("vendored playable-candidate parity replay (Task 5 slice 1)", () => {
  it("loads the vendored Go-captured fixture", () => {
    expect(fixture.schema).toBe("playable-candidate-parity/1");
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  it("replays every case through the vendored kernel", () => {
    for (const tc of fixture.cases) {
      const res = enumeratePlayableCandidateGroups(mapFixtureInput(tc.input));
      expect(groupsToSnake(res.groups), `${tc.name} groups`).toEqual(tc.groups);
      expect(abstainToSnake(res.abstain), `${tc.name} abstain`).toEqual(
        tc.abstain,
      );
    }
  });
});
