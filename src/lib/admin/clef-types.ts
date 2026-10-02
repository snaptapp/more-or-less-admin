/**
 * Shared Clef response types and strict validators for More or Less Admin.
 */

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
}

export interface ClefResponse<T = Record<string, unknown>> {
  model: string;
  answers: T;
  usage?: Record<string, unknown>;
}

export function validateNoulAnswer(data: unknown): number | null {
  if (!data || typeof data !== "object") return null;
  const rec = data as Record<string, unknown>;
  if (rec.type !== "noul") return null;
  const val = rec.noul;
  if (typeof val !== "number" || Number.isNaN(val) || !Number.isFinite(val)) return null;
  if (val < 0 || val > 1) return null;
  return val;
}

export function validateScoreAnswer(data: unknown, min = 0, max = 3): number | null {
  if (!data || typeof data !== "object") return null;
  const rec = data as Record<string, unknown>;
  if (rec.type !== "score") return null;
  const val = rec.score;
  if (typeof val !== "number" || Number.isNaN(val) || !Number.isFinite(val)) return null;
  if (val < min || val > max) return null;
  return val;
}
