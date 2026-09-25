// Distractor Derivation Model (DDM) — Worker raw-token / allowlisted input
// adapter (task 16.2).
//
// This module is the Worker-side seam between the UNTRUSTED incoming round wire
// shape (the raw round JSON the guardrail path receives) and the pure DDM
// `derive` entry point exported by the shared, byte-identical DDM module
// (src/derivation.ts). It is deliberately kept OUTSIDE that shared file so the
// shared module stays byte-identical to functions/src/ai/derivation.ts (the
// port-identity check compares only the derivation*.ts kernel, not this
// adapter). It mirrors the Functions adapter functions/src/ai/derivation_adapter.ts.
//
// WHY A SEPARATE ADAPTER (Requirements 3.13, 8.7, 8.8, 8.12, 9.1, 9.15, 12.3,
// 12.12):
//
//   1. TOKEN PRESERVATION BEFORE MATERIALIZATION (Requirements 8.12, 12.3): a
//      round arrives as JSON text. `JSON.parse` (or accepting an already
//      materialized round object) would coerce a numeric literal such as
//      `0.070`, `7e-2`, or `1.005` into a binary float, losing the exact
//      spelling. The shared `schemaIngest` therefore captures the EXACT
//      `true_number` (and optional bounds) token strings with the raw JSON
//      numeric-token lexer BEFORE any structural parse could touch them. This
//      adapter simply forwards the raw round text to it; there is no
//      `Number(token)`, `parseFloat`, or `JSON.parse`-into-number on the
//      required numeric field here.
//
//   2. ALLOWLISTED INPUT — NO METADATA (Requirements 3.13, 8.7, 8.8, 9.15,
//      12.12): `schemaIngest` builds the allowlisted DerivationInput exclusively
//      out of DDM fields; pack/round difficulty metadata, topic, round_number,
//      presented_number, and correct_direction are structurally unable to reach
//      the DDM.
//
// Keeping this adapter as the only place the guardrail glue names the DDM
// schema-ingest symbol also keeps the guardrail module (guardrails.ts) off the
// DDM raw-token adapter surface, so its legacy R5 rebalance helpers (which
// operate on ALREADY-DERIVED rounds, not raw tokens) are correctly out of scope
// for the token-preservation static check (task 11.3) — exactly as the Functions
// generator stays off that surface by importing `adaptRoundJSON` rather than
// `schemaIngest` directly.

import {
  schemaIngest,
  type CandidateSide,
  type PrecomputedDerivation,
  type SchemaIngestResult,
} from "./derivation";

// AdapterOptions carries caller overrides that are legitimate DDM inputs but do
// not appear on the wire round itself: an optional forced side and an optional
// Fact-Bank precompute block. Neither is metadata; both are explicit
// allowlisted DerivationInput members.
export interface AdapterOptions {
  forcedSide?: CandidateSide;
  precomputed?: PrecomputedDerivation;
}

// adaptRoundJSON is the PRIMARY Worker adapter entry point. It takes the EXACT
// raw JSON text of a single incoming round and returns a SchemaIngestResult
// carrying either the allowlisted DerivationInput or a required-numeric abstain.
//
// Token preservation (Requirements 8.12, 12.3): the required `true_number` and
// optional `plausible_min`/`plausible_max` tokens are captured verbatim by the
// shared raw JSON numeric-token lexer inside `schemaIngest` BEFORE any
// structural parse runs, so a spelling like "0.070", "7e-2", "-3", or "1.005"
// reaches Numeric_Ingest unchanged.
export function adaptRoundJSON(
  roundJSON: string,
  opts: AdapterOptions = {},
): SchemaIngestResult {
  return schemaIngest(roundJSON, opts.forcedSide, opts.precomputed);
}
