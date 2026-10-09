/**
 * Exact unit- and period-aware source comparison for the report copilot
 * (Task 7). Replaces the retired universal 5% relative tolerance: two stated
 * values either agree exactly after unit normalization, conflict exactly, or
 * are incomparable when their units or periods cannot be reconciled.
 *
 * Advisory only: the result feeds copilot confidence/needsReview, never a
 * write decision. All arithmetic is bigint-exact decimal, never float and
 * never percentage tolerance.
 */
import { normalizeUnit } from "../../../shared/ddm/derivation_resolve";
import { FACT_QUALITY_REGISTRY } from "../../../shared/fact-quality/fact-quality-units.gen";

/** A stated value with its stated scope. Missing unit/period are unknowns. */
export interface SourceValueRef {
  /** Exact decimal token as stated ("4650000000", "1.20e9", "-0.05"). */
  token: string;
  /** Unit the token is expressed in (raw spelling; normalized here). */
  unit?: string;
  /** Coverage period (as-of year/edition, e.g. "1989"). */
  period?: string;
}

export type SourceComparison = "agree" | "conflict" | "incomparable";

interface Rational {
  /** numerator (signed). */
  num: bigint;
  /** denominator (always positive). */
  den: bigint;
}

const DECIMAL_TOKEN = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/**
 * Parse an exact decimal token to a rational without any floating-point
 * step. Returns null for non-decimal spellings (fractions, words, junk);
 * they are incomparable rather than silently approximated.
 */
function parseDecimalRational(token: string): Rational | null {
  const m = DECIMAL_TOKEN.exec(token.trim());
  if (!m) return null;
  const [, sign, intPart, fracPart, expPart] = m;
  let num = BigInt(intPart + (fracPart ?? ""));
  let den = 10n ** BigInt((fracPart ?? "").length);
  if (expPart !== undefined) {
    const exp = BigInt(expPart);
    if (exp >= 0n) num *= 10n ** exp;
    else den *= 10n ** -exp;
  }
  if (sign === "-") num = -num;
  return { num, den };
}

function mul(a: Rational, b: Rational): Rational {
  return { num: a.num * b.num, den: a.den * b.den };
}

function sub(a: Rational, b: Rational): Rational {
  return { num: a.num * b.den - b.num * a.den, den: a.den * b.den };
}

function equal(a: Rational, b: Rational): boolean {
  return a.num * b.den === b.num * a.den;
}

/**
 * One registry decimal pair (e.g. `factor_num`/`factor_den`) interpreted as
 * the rational `parse(num) / parse(den)`. `den` defaults to "1"; a zero
 * denominator or unparseable token returns null.
 */
function registryRatio(numToken: string, denToken: string | undefined): Rational | null {
  const num = parseDecimalRational(numToken);
  const den = denToken === undefined ? { num: 1n, den: 1n } : parseDecimalRational(denToken);
  if (!num || !den || den.num === 0n || den.den === 0n) return null;
  // parse(numToken)/parse(denToken) with each parsed token itself a rational.
  const denominator = num.den * den.num;
  if (denominator === 0n) return null;
  return { num: num.num * den.den, den: denominator };
}

/**
 * Convert a stated value into its base-unit rational using the shared unit
 * registry: `base = (value - offset) * factor` with exact decimal factors.
 * Returns null when the unit is unknown to the registry.
 */
function toBaseRational(value: Rational, unitNorm: string): Rational | null {
  const unit = FACT_QUALITY_REGISTRY.units[unitNorm];
  if (!unit) return null;
  const factor = registryRatio(unit.factor_num, unit.factor_den);
  if (!factor || factor.den === 0n) return null;
  let v = value;
  if (unit.offset_num !== undefined) {
    const offset = registryRatio(unit.offset_num, unit.offset_den);
    if (!offset) return null;
    if (offset.num !== 0n) v = sub(v, offset);
  }
  return mul(v, factor);
}

function normalizePeriod(period: string | undefined): string {
  return (period ?? "").trim().toLowerCase();
}

/**
 * Registry units are keyed by canonical name; stated values arrive in any
 * alias spelling. `normalizeUnit` only canonicalizes whitespace and case, so
 * the alias index is resolved separately and lazily.
 */
const CANONICAL_UNITS = (() => {
  const index = new Map<string, string>();
  for (const [canonical, unit] of Object.entries(FACT_QUALITY_REGISTRY.units)) {
    index.set(normalizeUnit(canonical), canonical);
    for (const alias of unit.aliases) index.set(normalizeUnit(alias), canonical);
  }
  return index;
})();

/** Canonical registry key for a stated unit, or null when unknown. */
function canonicalUnit(unit: string | undefined): string | null {
  if (unit === undefined) return null;
  const norm = normalizeUnit(unit);
  if (!norm) return null;
  return CANONICAL_UNITS.get(norm) ?? null;
}

/**
 * Compare two stated source values exactly.
 *  - "incomparable": different periods, units unknown to the registry, units
 *    of different base measures, or an unparseable token. Incomparable is not
 *    a conflict and not a support: the values simply cannot be reconciled.
 *  - "conflict": same period, reconcilable units, and the exact converted
 *    values differ by any amount.
 *  - "agree": same period and the exact converted values are equal.
 */
export function compareSourceValues(a: SourceValueRef, b: SourceValueRef): SourceComparison {
  if (normalizePeriod(a.period) !== normalizePeriod(b.period)) return "incomparable";

  const aRat = parseDecimalRational(a.token);
  const bRat = parseDecimalRational(b.token);
  if (!aRat || !bRat) return "incomparable";

  const aUnit = canonicalUnit(a.unit);
  const bUnit = canonicalUnit(b.unit);
  // Neither side stated a unit: a bare-number comparison is exact-equality only.
  if (a.unit === undefined && b.unit === undefined) {
    return equal(aRat, bRat) ? "agree" : "conflict";
  }
  // A stated unit that resolves to nothing, or a missing counterpart, cannot
  // be reconciled; never treated as agreement or conflict.
  if (aUnit === null || bUnit === null) return "incomparable";
  if (aUnit === bUnit) return equal(aRat, bRat) ? "agree" : "conflict";

  const aBase = FACT_QUALITY_REGISTRY.units[aUnit]?.base;
  const bBase = FACT_QUALITY_REGISTRY.units[bUnit]?.base;
  if (!aBase || !bBase || aBase !== bBase) return "incomparable";

  const aConv = toBaseRational(aRat, aUnit);
  const bConv = toBaseRational(bRat, bUnit);
  if (!aConv || !bConv) return "incomparable";
  return equal(aConv, bConv) ? "agree" : "conflict";
}
