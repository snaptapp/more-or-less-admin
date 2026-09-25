/**
 * Offline DDM-4 parity replay for the Admin vendored production port.
 *
 * Objective: prove the synchronized Go fixtures remain byte-identical in Admin
 * across the complete quantity/side/bounds/zero/token domain, preserve exact
 * numeric spellings, exercise the Firestore precompute adapter, and fail closed
 * to a block-free live DDM-4 result for a ddm-999 block.
 *
 * The fixture files are read-only synchronized handoff artifacts. This suite
 * never regenerates or writes them and imports only pure local modules.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
  TrapOverestimate,
  TrapUnderestimate,
  derive,
  deriveResultJSON,
  numericIngest,
  schemaIngestRaw,
  stmtGateApply,
  stmtGateValidPolicy,
  type CandidateSide,
  type DerivationInput,
  type DerivationSource,
  type FixedPointValue,
  type PrecomputedDerivation,
  type QuantityKind,
  type StmtGatePolicy,
  type TrapDirection,
} from "../shared/ddm/derivation";
import {
  deriveBankRound,
  toPrecomputedDerivation,
  type BankPrecomputeFact,
  type FirestoreDerivationBlock,
} from "../src/lib/admin/ddm-precompute";
import { blockedNetworkAttempts } from "./setup";

interface FixtureBoundsHint {
  readonly min_token: string;
  readonly max_token: string;
}

interface FixturePrecomputedDistractor {
  readonly surprise_factor: number;
  readonly side: CandidateSide;
  readonly presented_number: string;
}

interface FixturePrecomputed {
  readonly model_version: string;
  readonly quantity_kind: string;
  readonly trap_direction: string;
  readonly plausible_min: string;
  readonly plausible_max: string;
  readonly distractors: readonly FixturePrecomputedDistractor[] | null;
}

interface FixtureInput {
  readonly incoming_numeric_token: string;
  readonly unit: string;
  readonly quantity_kind?: string;
  readonly trap_direction?: string;
  readonly fact_bank_bounds?: FixtureBoundsHint;
  readonly model_bounds?: FixtureBoundsHint;
  readonly surprise_factor: number;
  readonly forced_side?: CandidateSide;
  readonly precomputed?: FixturePrecomputed;
}

interface FixtureExpected {
  readonly outcome: "success" | "abstain";
  readonly reason?: string;
  readonly incoming_numeric_token?: string;
  readonly quantity_kind?: QuantityKind;
  readonly correct_direction?: CandidateSide;
  readonly source?: DerivationSource;
}

interface FixtureDerivationCase {
  readonly name: string;
  readonly notes?: string;
  readonly metadata?: unknown;
  readonly input: FixtureInput;
  readonly expected: FixtureExpected;
}

interface FixtureStatementCase {
  readonly name: string;
  readonly notes?: string;
  readonly statement: string;
  readonly truth: FixedPointValue;
  readonly presented: FixedPointValue;
  readonly policy: string;
  readonly expected: unknown;
}

interface ParityFixture {
  readonly schema: string;
  readonly model_version: string;
  readonly description: string;
  readonly derivation_cases: readonly FixtureDerivationCase[];
  readonly statement_cases: readonly FixtureStatementCase[];
}

interface CrossRuntimeRow {
  readonly index: number;
  readonly name: string;
  readonly domain: string;
  readonly metadata?: unknown;
  readonly input: FixtureInput;
  readonly expected: FixtureExpected;
}

interface CrossRuntimeFixture {
  readonly schema: string;
  readonly model_version: string;
  readonly description: string;
  readonly rows: readonly CrossRuntimeRow[];
}

const ALL_QUANTITY_KINDS: readonly QuantityKind[] = [
  KindYear,
  KindCount,
  KindPercentage,
  KindPercentChange,
  KindRatio,
  KindPhysicalMeasure,
  KindMoney,
  KindDuration,
  KindRating,
];
const ALL_SIDES: readonly CandidateSide[] = [SideMore, SideLess];
const REQUIRED_EXACT_TOKEN_SPELLINGS = [
  "0.070",
  "7e-2",
  "2.9e-1",
  "1.0050",
  "1.5e3",
  "1.5e+3",
  "42.00",
  "-0.0",
  "+42",
] as const;

const PARITY_FIXTURE = JSON.parse(
  readFileSync(
    new URL("../shared/ddm/fixtures/derivation_parity.json", import.meta.url),
    "utf8",
  ),
) as ParityFixture;
const CROSS_RUNTIME_FIXTURE = JSON.parse(
  readFileSync(
    new URL("../shared/ddm/fixtures/derivation_cross_runtime.json", import.meta.url),
    "utf8",
  ),
) as CrossRuntimeFixture;

function mapBounds(bounds: FixtureBoundsHint) {
  return {
    minToken: bounds.min_token,
    maxToken: bounds.max_token,
  };
}

/** Copies only the allowlisted DDM fields and keeps every token byte verbatim. */
function mapInput(fixtureInput: FixtureInput): DerivationInput {
  const input: DerivationInput = {
    incomingNumericToken: fixtureInput.incoming_numeric_token,
    unit: fixtureInput.unit,
    surpriseFactor: fixtureInput.surprise_factor,
  };

  if (fixtureInput.quantity_kind !== undefined) {
    input.quantityKind = fixtureInput.quantity_kind;
  }
  if (fixtureInput.trap_direction !== undefined) {
    input.trapDirection = fixtureInput.trap_direction;
  }
  if (fixtureInput.fact_bank_bounds !== undefined) {
    input.factBankBounds = mapBounds(fixtureInput.fact_bank_bounds);
  }
  if (fixtureInput.model_bounds !== undefined) {
    input.modelBounds = mapBounds(fixtureInput.model_bounds);
  }
  if (fixtureInput.forced_side !== undefined) {
    input.forcedSide = fixtureInput.forced_side;
  }
  if (fixtureInput.precomputed !== undefined) {
    // These are already low-level kernel fixtures. In particular, the
    // ddm-999 vector intentionally carries empty kind/trap/bound fields so the
    // kernel must reject it on model version before reading them. A production
    // Firestore block goes through toPrecomputedDerivation in the separate
    // adapter tests below.
    input.precomputed = {
      modelVersion: fixtureInput.precomputed.model_version,
      quantityKind: fixtureInput.precomputed.quantity_kind,
      trapDirection: fixtureInput.precomputed.trap_direction,
      plausibleMin: fixtureInput.precomputed.plausible_min,
      plausibleMax: fixtureInput.precomputed.plausible_max,
      distractors: (fixtureInput.precomputed.distractors ?? []).map((distractor) => ({
        surpriseFactor: distractor.surprise_factor,
        side: distractor.side,
        presentedNumber: distractor.presented_number,
      })),
    } as PrecomputedDerivation;
  }

  return input;
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function statementResultJSON(result: {
  readonly ok: boolean;
  readonly statement: string;
  readonly reason: string;
  readonly policy: string;
}): string {
  return JSON.stringify({
    ok: result.ok,
    policy: result.policy,
    reason: result.reason,
    statement: result.statement,
  });
}

function percentChangeInput(): DerivationInput {
  const ingest = schemaIngestRaw({
    trueNumberToken: "340",
    unit: "percent change",
    quantityKind: KindPercentChange,
    plausibleMinToken: "-100.00",
    plausibleMaxToken: "3400.000",
    surpriseFactor: 1,
  });
  if (ingest.input === undefined) {
    throw new Error(`percent-change fixture setup abstained: ${ingest.abstain?.reason}`);
  }
  return ingest.input;
}

function productionAdapterRound(input: DerivationInput, block: unknown) {
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
  return deriveBankRound(fact);
}

function currentAdapterBlock(): FirestoreDerivationBlock {
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

function staleAdapterBlock(): FirestoreDerivationBlock {
  return {
    model_version: "ddm-999",
    quantity_kind: KindRating,
    trap_direction: TrapOverestimate,
    plausible_min: "0.000",
    plausible_max: "10.000",
    canonical_surprise_factor: 3,
    distractors: [
      { surprise_factor: 3, side: SideMore, presented_number: "999.000" },
    ],
  };
}

describe("synchronized DDM-4 fixture authority", () => {
  it("locks fixture integrity and the required kind/side/bounds/zero/token coverage", () => {
    // Arrange
    const allCases = [
      ...PARITY_FIXTURE.derivation_cases,
      ...CROSS_RUNTIME_FIXTURE.rows,
    ];
    const successful = allCases.filter(({ expected }) => expected.outcome === "success");
    const abstained = allCases.filter(({ expected }) => expected.outcome === "abstain");
    const forcedRows = CROSS_RUNTIME_FIXTURE.rows.filter(
      ({ input }) => input.forced_side !== undefined,
    );
    const zeroRows = CROSS_RUNTIME_FIXTURE.rows.filter(({ domain }) => domain === "kind_zero");
    const tokens = new Set(
      CROSS_RUNTIME_FIXTURE.rows.map(({ input }) => input.incoming_numeric_token),
    );

    // Act
    const coveredKinds = new Set(
      successful.flatMap(({ expected }) =>
        expected.quantity_kind === undefined ? [] : [expected.quantity_kind],
      ),
    );
    const coveredSides = new Set(
      successful.flatMap(({ expected }) =>
        expected.correct_direction === undefined ? [] : [expected.correct_direction],
      ),
    );

    // Assert
    expect(PARITY_FIXTURE.schema).toBe("derivation_parity/1");
    expect(PARITY_FIXTURE.model_version).toBe(DDMVersion);
    expect(PARITY_FIXTURE.derivation_cases.length).toBeGreaterThan(0);
    expect(PARITY_FIXTURE.statement_cases.length).toBeGreaterThan(0);
    expect(CROSS_RUNTIME_FIXTURE.schema).toBe("derivation_cross_runtime/1");
    expect(CROSS_RUNTIME_FIXTURE.model_version).toBe(DDMVersion);
    expect(CROSS_RUNTIME_FIXTURE.rows.length).toBeGreaterThanOrEqual(100);
    expect(CROSS_RUNTIME_FIXTURE.rows.map(({ index }) => index)).toEqual(
      CROSS_RUNTIME_FIXTURE.rows.map((_row, index) => index),
    );
    expect(successful.length).toBeGreaterThan(0);
    expect(abstained.length).toBeGreaterThan(0);
    expect(coveredKinds).toEqual(new Set(ALL_QUANTITY_KINDS));
    expect(coveredKinds.has(KindPercentChange)).toBe(true);
    expect(coveredSides).toEqual(new Set(ALL_SIDES));
    expect(new Set(forcedRows.map(({ input }) => input.forced_side))).toEqual(
      new Set(ALL_SIDES),
    );
    expect(
      forcedRows.every(
        ({ input, expected }) =>
          input.forced_side !== undefined &&
          expected.outcome === "success" &&
          expected.correct_direction === input.forced_side,
      ),
    ).toBe(true);
    expect(
      PARITY_FIXTURE.derivation_cases.some(
        ({ input }) => input.fact_bank_bounds !== undefined,
      ),
    ).toBe(true);
    expect(
      PARITY_FIXTURE.derivation_cases.some(({ input }) => input.model_bounds !== undefined),
    ).toBe(true);
    expect(zeroRows).toHaveLength(ALL_QUANTITY_KINDS.length);
    expect(
      zeroRows.find(({ input }) => input.quantity_kind === KindYear)?.expected,
    ).toMatchObject({ outcome: "abstain", reason: "ZERO_OUTSIDE_YEAR_DOMAIN" });
    expect(
      zeroRows
        .filter(({ input }) => input.quantity_kind !== KindYear)
        .every(({ expected }) => expected.outcome === "success" && expected.source === "zero_value"),
    ).toBe(true);
    for (const token of REQUIRED_EXACT_TOKEN_SPELLINGS) {
      expect(tokens.has(token), `missing exact token spelling ${token}`).toBe(true);
    }
    expect(blockedNetworkAttempts()).toEqual([]);
  });
});

describe("derivation_parity.json replay", () => {
  it("replays every derivation success and abstain byte-for-byte", () => {
    // Arrange
    const mismatches: string[] = [];

    // Act
    for (const fixtureCase of PARITY_FIXTURE.derivation_cases) {
      const [produced, serialized] = deriveResultJSON(derive(mapInput(fixtureCase.input)));
      if (!serialized) {
        mismatches.push(`${fixtureCase.name}: result could not be serialized`);
        continue;
      }
      const expected = canonical(fixtureCase.expected);
      if (produced !== expected) {
        mismatches.push(
          `${fixtureCase.name}:\n  want: ${expected}\n   got: ${produced}`,
        );
      }
    }

    // Assert
    expect(
      PARITY_FIXTURE.derivation_cases.some(({ expected }) => expected.outcome === "success"),
    ).toBe(true);
    expect(
      PARITY_FIXTURE.derivation_cases.some(({ expected }) => expected.outcome === "abstain"),
    ).toBe(true);
    expect(mismatches, mismatches.join("\n")).toEqual([]);
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("replays every statement success and failure byte-for-byte", () => {
    // Arrange
    const mismatches: string[] = [];
    const outcomes = PARITY_FIXTURE.statement_cases.map(({ expected }) => expected);

    // Act
    for (const fixtureCase of PARITY_FIXTURE.statement_cases) {
      if (!stmtGateValidPolicy(fixtureCase.policy)) {
        mismatches.push(`${fixtureCase.name}: unknown policy ${fixtureCase.policy}`);
        continue;
      }
      const result = stmtGateApply(
        fixtureCase.statement,
        fixtureCase.truth,
        fixtureCase.presented,
        fixtureCase.policy as StmtGatePolicy,
      );
      const produced = statementResultJSON(result);
      const expected = canonical(fixtureCase.expected);
      if (produced !== expected) {
        mismatches.push(
          `${fixtureCase.name}:\n  want: ${expected}\n   got: ${produced}`,
        );
      }
    }

    // Assert
    expect(
      outcomes.some((expected) => isRecord(expected) && expected.ok === true),
    ).toBe(true);
    expect(
      outcomes.some((expected) => isRecord(expected) && expected.ok === false),
    ).toBe(true);
    expect(mismatches, mismatches.join("\n")).toEqual([]);
    expect(blockedNetworkAttempts()).toEqual([]);
  });
});

describe("derivation_cross_runtime.json replay", () => {
  it("preserves every incoming token through mapping and numeric diagnostics", () => {
    // Arrange
    const diagnostics = CROSS_RUNTIME_FIXTURE.rows.map((row) => ({
      name: row.name,
      stored: row.input.incoming_numeric_token,
      mapped: mapInput(row.input).incomingNumericToken,
      diagnosed: numericIngest(row.input.incoming_numeric_token).incomingNumericToken,
    }));

    // Act
    const mismatches = diagnostics.filter(
      ({ stored, mapped, diagnosed }) =>
        mapped !== stored || diagnosed !== stored,
    );

    // Assert
    expect(diagnostics.length).toBe(CROSS_RUNTIME_FIXTURE.rows.length);
    expect(mismatches).toEqual([]);
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("replays all 231 synchronized cross-runtime rows byte-for-byte", () => {
    // Arrange
    const mismatches: string[] = [];

    // Act
    for (const row of CROSS_RUNTIME_FIXTURE.rows) {
      const [produced, serialized] = deriveResultJSON(derive(mapInput(row.input)));
      if (!serialized) {
        mismatches.push(`${row.index}:${row.name}: result could not be serialized`);
        continue;
      }
      const expected = canonical(row.expected);
      if (produced !== expected) {
        mismatches.push(
          `${row.index}:${row.name} (token=${JSON.stringify(row.input.incoming_numeric_token)}):\n  want: ${expected}\n   got: ${produced}`,
        );
      }
    }

    // Assert
    expect(CROSS_RUNTIME_FIXTURE.rows).toHaveLength(231);
    expect(
      CROSS_RUNTIME_FIXTURE.rows.filter(({ expected }) => expected.outcome === "success"),
    ).toHaveLength(188);
    expect(
      CROSS_RUNTIME_FIXTURE.rows.filter(({ expected }) => expected.outcome === "abstain"),
    ).toHaveLength(43);
    expect(mismatches, mismatches.join("\n")).toEqual([]);
    expect(blockedNetworkAttempts()).toEqual([]);
  });
});

describe("DDM precompute adapter replay", () => {
  it("round-trips a current block losslessly and re-gates its exact presented token", () => {
    // Arrange
    const block = currentAdapterBlock();
    const before = JSON.stringify(block);
    const input = percentChangeInput();

    // Act
    const converted = toPrecomputedDerivation(block);
    const result = productionAdapterRound(input, block);

    // Assert
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
    expect(result).toMatchObject({
      source: "precomputed",
      quantityKind: KindPercentChange,
      direction: SideMore,
      presented: 252,
      plausibleMin: -100,
      plausibleMax: 3400,
    });
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("rejects malformed adapter fields without returning partial stale data", () => {
    // Arrange
    const malformedBlocks: readonly unknown[] = [
      null,
      { ...currentAdapterBlock(), model_version: "" },
      { ...currentAdapterBlock(), quantity_kind: "not-a-kind" },
      { ...currentAdapterBlock(), trap_direction: "SIDEWAYS" },
      { ...currentAdapterBlock(), plausible_min: "-1e2" },
      { ...currentAdapterBlock(), distractors: {} },
    ];

    // Act
    const converted = malformedBlocks.map((block) => toPrecomputedDerivation(block));

    // Assert
    expect(converted).toEqual(malformedBlocks.map(() => undefined));
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("derives a ddm-999 block live without leaking any stale field", () => {
    // Arrange
    const staleBlock = staleAdapterBlock();
    const input = percentChangeInput();
    // Act
    const fallback = productionAdapterRound(input, staleBlock);

    // Assert
    expect(fallback).toMatchObject({
      source: "live",
      quantityKind: KindPercentChange,
      trapDirection: TrapUnderestimate,
      direction: SideMore,
      plausibleMin: -100,
      plausibleMax: 3400,
    });
    expect(fallback?.quantityKind).not.toBe(staleBlock.quantity_kind);
    expect(fallback?.trapDirection).not.toBe(staleBlock.trap_direction);
    expect(fallback?.presented).not.toBe(999);
    expect(fallback?.plausibleMin).not.toBe(0);
    expect(fallback?.plausibleMax).not.toBe(10);
    expect(blockedNetworkAttempts()).toEqual([]);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
