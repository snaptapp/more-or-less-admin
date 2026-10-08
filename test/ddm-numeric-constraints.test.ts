// Task 5 numeric-constraints parity replay for Admin.
//
// Replays every case in the vendored Go-captured fixture
// shared/ddm/fixtures/derivation_numeric_constraints.json through the vendored
// DDM kernel's derive() + enumeratePlayableCandidateGroups and compares the
// serialized result bytes and group provenance field-for-field. Fixture inputs
// are RAW JSON text so strict-decoder cases (explicit nulls, duplicate keys,
// unknown fields) reach parseDerivationInputJSON exactly as Go's UnmarshalJSON
// sees them. The fixture and the vendored kernel are read-only handoff
// artifacts; this gate never invents per-language expected values.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  derive,
  deriveResultJSON,
  enumeratePlayableCandidateGroups,
  parseDerivationInputJSON,
  type CandidateGroup,
  type DerivationAbstain,
} from "../shared/ddm/derivation";

interface NumericFixtureCase {
  name: string;
  result: unknown;
  groups: unknown;
  group_abstain: unknown;
}

interface NumericFixture {
  schema: string;
  cases: NumericFixtureCase[];
}

// skipWS returns the first index at/after i that is not JSON whitespace.
function skipWS(s: string, i: number): number {
  while (i < s.length && (s[i] === " " || s[i] === "\t" || s[i] === "\n" || s[i] === "\r")) {
    i++;
  }
  return i;
}

// rawValueEnd returns the index one past the JSON value starting at i (a
// string, number, literal, or balanced object/array). It never inspects the
// content, only the container shape.
function rawValueEnd(s: string, i: number): number {
  i = skipWS(s, i);
  const c = s[i];
  if (c === '"') {
    i++;
    while (i < s.length) {
      if (s[i] === "\\") {
        i += 2;
        continue;
      }
      if (s[i] === '"') {
        return i + 1;
      }
      i++;
    }
    return -1;
  }
  if (c === "{" || c === "[") {
    let depth = 0;
    while (i < s.length) {
      if (s[i] === '"') {
        const end = rawValueEnd(s, i);
        if (end < 0) {
          return -1;
        }
        i = end;
        continue;
      }
      if (s[i] === "{" || s[i] === "[") {
        depth++;
      } else if (s[i] === "}" || s[i] === "]") {
        depth--;
        if (depth === 0) {
          return i + 1;
        }
      }
      i++;
    }
    return -1;
  }
  // Primitive: number or literal — ends at the next structural character.
  while (i < s.length && s[i] !== "," && s[i] !== "}" && s[i] !== "]" && s[i] !== " " && s[i] !== "\t" && s[i] !== "\n" && s[i] !== "\r") {
    i++;
  }
  return i;
}

// loadRawInputs walks the fixture TEXT and extracts each case's "input"
// member verbatim, in document order. The structural parse collapses
// duplicate object keys, so the raw bytes are the only faithful input for the
// strict decoder.
function loadRawInputs(text: string, count: number): string[] {
  const raws: string[] = [];
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const key = text.indexOf('"input":', cursor);
    if (key < 0) {
      throw new Error(`fixture input ${i} not found`);
    }
    const start = skipWS(text, key + '"input":'.length);
    const end = rawValueEnd(text, start);
    if (end < 0) {
      throw new Error(`fixture input ${i} unterminated`);
    }
    raws.push(text.slice(start, end));
    cursor = end;
  }
  return raws;
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

const fixtureText = readFileSync(
  fileURLToPath(
    new URL(
      "../shared/ddm/fixtures/derivation_numeric_constraints.json",
      import.meta.url,
    ),
  ),
  "utf8",
);
const fixture = JSON.parse(fixtureText) as NumericFixture;
const inputRaws = loadRawInputs(fixtureText, fixture.cases.length);

describe("vendored numeric-constraints parity replay (Task 5)", () => {
  it("loads the vendored Go-captured fixture", () => {
    expect(fixture.schema).toBe("numeric-constraints-parity/1");
    expect(fixture.cases.length).toBeGreaterThan(0);
    expect(inputRaws.length).toBe(fixture.cases.length);
  });

  it("replays every case through the vendored kernel", () => {
    fixture.cases.forEach((tc, i) => {
      const input = parseDerivationInputJSON(inputRaws[i]);
      expect(input, `${tc.name} strict decode`).not.toBeUndefined();
      if (input === undefined) {
        return;
      }

      const result = derive(input);
      const [serialized, ok] = deriveResultJSON(result);
      expect(ok, `${tc.name} result serialization`).toBe(true);
      // The fixture result is the Go-serialized bytes; re-compact through
      // parse/stringify to normalize the pretty-printed embedding while
      // preserving Go's member order.
      expect(serialized, `${tc.name} derive result`).toBe(
        JSON.stringify(tc.result),
      );

      const res = enumeratePlayableCandidateGroups(input);
      expect(groupsToSnake(res.groups), `${tc.name} groups`).toEqual(tc.groups);
      expect(abstainToSnake(res.abstain), `${tc.name} group abstain`).toEqual(
        tc.group_abstain,
      );
    });
  });
});
