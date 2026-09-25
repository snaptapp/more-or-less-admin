/**
 * Admin compatibility surface for the vendored production fact-bank adapter.
 *
 * The implementation and its digest come from the production-owned
 * `shared/ddm/factbank_precompute.ts` artifact. Admin must not duplicate the
 * conversion, alternate rotation, or precompute-then-live fallback logic.
 */

import { DDMVersion, type PrecomputedDerivation } from "../../../shared/ddm/derivation";
import {
  deriveBankRound,
  deriveBankRoundDetailed,
  stableFactKey as productionStableFactKey,
  toPrecomputedDerivation as toProductionPrecomputedDerivation,
  type BankPrecomputeFact,
  type DerivedBankRound,
  type DerivationSource,
  type DetailedBankRound,
} from "../../../shared/ddm/factbank_precompute";

export interface FirestoreDerivationDistractor {
  readonly surprise_factor: unknown;
  readonly side: unknown;
  readonly presented_number: unknown;
}

export interface FirestoreDerivationBlock {
  readonly model_version: unknown;
  readonly quantity_kind: unknown;
  readonly trap_direction: unknown;
  readonly plausible_min: unknown;
  readonly plausible_max: unknown;
  readonly canonical_surprise_factor?: unknown;
  readonly distractors: unknown;
}

export type StableFactIdentity = Pick<
  BankPrecomputeFact,
  "category" | "sub_category" | "specialty" | "fact"
> & { readonly angle?: string | null };
export type { BankPrecomputeFact, DerivedBankRound, DerivationSource, DetailedBankRound };

export { deriveBankRound, deriveBankRoundDetailed };

/** Stable fact identity compatibility wrapper; null and omitted angles are equivalent. */
export function stableFactKey(fact: StableFactIdentity): string {
  return productionStableFactKey({
    ...fact,
    angle: fact.angle ?? undefined,
  });
}

/** Accepts the untrusted Firestore shape and delegates conversion unchanged. */
export function toPrecomputedDerivation(
  block: unknown,
  variantSeed?: string,
  factKey?: string,
): PrecomputedDerivation | undefined {
  return toProductionPrecomputedDerivation(
    block as Parameters<typeof toProductionPrecomputedDerivation>[0],
    variantSeed,
    factKey,
  );
}

/** Strict boundary variant for callers that reject stale model versions early. */
export function toCurrentPrecomputedDerivation(
  block: unknown,
  variantSeed?: string,
  factKey?: string,
): PrecomputedDerivation | undefined {
  const converted = toPrecomputedDerivation(block, variantSeed, factKey);
  return converted?.modelVersion === DDMVersion ? converted : undefined;
}
