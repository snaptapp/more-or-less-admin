import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  formatNumericToken,
  legacyRoundFingerprint,
  parsePlayableRoundJSON,
  parseRoundValidationContextJSON,
  playableRoundFromWireJSON,
  requiredNumericFormatVersion,
  validatePlayableRound,
} from "../shared/ddm/factquality_round";

interface RoundCase {
  name: string;
  round_json: string;
  wire_round_json?: string;
  context: unknown;
  findings: unknown;
  legacy_fingerprint?: string;
  required_format_version: number;
  format_representable: boolean;
}

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL(
  "../shared/ddm/fixtures/fact_quality_round_parity.json", import.meta.url,
)), "utf8")) as { schema: string; cases: RoundCase[] };
const formats = JSON.parse(readFileSync(fileURLToPath(new URL(
  "../shared/ddm/fixtures/numeric_format_v2.json", import.meta.url,
)), "utf8")) as {
  schema: string;
  cases: { name: string; token: string; places: number; kind: string; display: string; ok: boolean }[];
};

describe("vendored Go actual-round and numeric-format parity", () => {
  it("uses the captured Go schemas without generating expectations", () => {
    expect(fixture.schema).toBe("fact-quality-round-parity/1");
    expect(formats.schema).toBe("numeric-format/2");
    expect(fixture.cases.length).toBeGreaterThan(0);
    expect(formats.cases.length).toBeGreaterThan(0);
  });

  it("validates selected candidates and bindings without changing the inputs", () => {
    for (const one of fixture.cases) {
      const round = parsePlayableRoundJSON(one.round_json);
      const context = parseRoundValidationContextJSON(JSON.stringify(one.context));
      if (round === undefined || context === undefined) {
        throw new Error(`${one.name}: captured inputs did not decode`);
      }
      const before = JSON.stringify([round, context]);
      expect(JSON.stringify(validatePlayableRound(round, context)), one.name)
        .toBe(JSON.stringify(one.findings));
      expect(JSON.stringify([round, context]), `${one.name}: mutation`).toBe(before);
      const [requiredVersion, representable] = requiredNumericFormatVersion(round);
      expect(requiredVersion, `${one.name}: minimum format`).toBe(one.required_format_version);
      expect(representable, `${one.name}: representability`).toBe(one.format_representable);
      if (one.legacy_fingerprint !== undefined) {
        if (context.canonical_fact === undefined) {
          throw new Error(`${one.name}: fingerprint has no canonical input`);
        }
        expect(legacyRoundFingerprint(context.canonical_fact), one.name)
          .toBe(one.legacy_fingerprint);
      }
      if (one.wire_round_json !== undefined) {
        const wire = playableRoundFromWireJSON(one.wire_round_json);
        if (wire === undefined) {
          throw new Error(`${one.name}: wire tokens could not be captured`);
        }
        expect(JSON.stringify(validatePlayableRound(wire, context)), `${one.name}: wire`)
          .toBe(JSON.stringify(one.findings));
      }
    }
  });

  it("rejects trailing content after an internal round object", () => {
    expect(parsePlayableRoundJSON(`${fixture.cases[0].round_json} 9`)).toBeUndefined();
  });

  it("renders canonical decimal tokens identically to Go", () => {
    for (const one of formats.cases) {
      const [display, ok] = formatNumericToken(one.token, one.places, one.kind);
      expect(ok, `${one.name}: representability`).toBe(one.ok);
      expect(display, `${one.name}: rendered bytes`).toBe(one.display);
    }
  });
});
