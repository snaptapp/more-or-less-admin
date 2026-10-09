/** Type-only compatibility declarations for the production DDM adapter artifact. */
export type Direction = "MORE" | "LESS";

export interface NumericConstraintsPayload {
  display_decimal_places?: number;
  quantum_token?: string;
  min_separation_token?: string;
  credible_min_token?: string;
  credible_max_token?: string;
}
