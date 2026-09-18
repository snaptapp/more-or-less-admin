/**
 * Contract-derived named constants (Requirement 9.9).
 *
 * The four fact statuses and the DDM `quantity_kind` values are owned by the
 * Shared_Contract_Artifact (`shared/fact-lifecycle-contract.gen.ts`). Admin
 * source must never restate them as hand-written string literals; instead it
 * references the named constants exported here, which are derived at module
 * load from the artifact's `FACT_STATUSES` / `QUANTITY_KINDS` arrays.
 *
 * `STATUS.active` and `QK.year` resolve to the exact contract strings, but the
 * literal `"active"` / `"year"` appears only inside the artifact — so the
 * Contract_Literal_Check scan (which flags string literals equal to a contract
 * value) stays green while the values remain single-sourced and type-checked
 * against `FactStatus` / `QuantityKind`.
 */

import {
  FACT_STATUSES,
  QUANTITY_KINDS,
  type FactStatus,
  type QuantityKind,
} from "../../../shared/fact-lifecycle-contract.gen";

export {
  CONTRACT_VERSION,
  FACT_STATUSES,
  QUANTITY_KINDS,
  STATUS_TRANSITIONS,
  LIFECYCLE_FIELDS,
} from "../../../shared/fact-lifecycle-contract.gen";
export type {
  FactStatus,
  QuantityKind,
  StatusTransition,
  FieldDescriptor,
} from "../../../shared/fact-lifecycle-contract.gen";

/**
 * Builds a self-keyed lookup (`{ value: value }`) from a readonly tuple of
 * string members, typed so each member is reachable as a dot-accessed property.
 * No member literal is written here; the values come from the passed-in array.
 */
function selfKeyed<const T extends readonly string[]>(values: T): { [K in T[number]]: K } {
  const out = {} as { [K in T[number]]: K };
  for (const value of values) {
    out[value as T[number]] = value as never;
  }
  return out;
}

/**
 * Named fact-status constants derived from the artifact.
 * `STATUS.active === "active"`, and so on for every declared status.
 */
export const STATUS: { [K in FactStatus]: K } = selfKeyed(FACT_STATUSES);

/**
 * Named quantity-kind constants derived from the artifact.
 * `QK.year === "year"`, and so on for every declared kind.
 */
export const QK: { [K in QuantityKind]: K } = selfKeyed(QUANTITY_KINDS);
