import {
  validateNoulAnswer,
  validateScoreAnswer,
  type ClefResponse,
} from "./clef-types";
import { createDoc, patchDoc, getDoc, type Json } from "../firebase/firestore.server";

export interface FactTriageRecord {
  fact_id: string;
  status: "success" | "triage_failed";
  is_objectively_verifiable?: number;
  is_subjective?: number;
  raw_surprise_score?: number;
  canonical_surprise_factor?: 0 | 1 | 2 | 3;
  triaged_at: string;
  error?: string;
}

export function canonicalSurpriseFactor(score: number): 0 | 1 | 2 | 3 {
  const rounded = Math.round(score);
  return Math.min(3, Math.max(0, rounded)) as 0 | 1 | 2 | 3;
}

export async function triageFactCandidate(
  ai: { run: (model: string, input: Record<string, unknown>) => Promise<unknown> } | undefined,
  fact: {
    factId: string;
    question: string;
    true_number: number;
    unit: string;
    claim_template: string;
  }
): Promise<FactTriageRecord | null> {
  if (!ai?.run) return null; // Safe stub in dev when workerd binding is not present

  try {
    const res = (await ai.run("@cf/cloudflare/clef", {
      model: "clef",
      state: {
        claim: fact.claim_template,
        question: fact.question,
        number: fact.true_number,
        unit: fact.unit,
      },
      questions: {
        is_objectively_verifiable: {
          type: "noul",
          instructions: "Is this claim structured as an objectively verifiable measurement, count, or historical record?",
        },
        is_subjective: {
          type: "noul",
          instructions: "Is this claim based on subjective taste, opinion, or unmeasurable sentiment?",
        },
        surprise_factor: {
          type: "score",
          instructions: "How counter-intuitive or surprising is this number?",
          criteria: ["0: Obvious / Common knowledge", "1: Mildly surprising", "2: Counter-intuitive", "3: Mind-blowing"],
        },
      },
    })) as ClefResponse<Record<string, unknown>>;

    const isVerifiable = validateNoulAnswer(res.answers?.is_objectively_verifiable);
    const isSubjective = validateNoulAnswer(res.answers?.is_subjective);
    const rawScore = validateScoreAnswer(res.answers?.surprise_factor, 0, 3);

    // FAIL CLOSED: If any required field is missing or invalid, do NOT invent synthetic defaults!
    if (isVerifiable === null || isSubjective === null || rawScore === null) {
      return {
        fact_id: fact.factId,
        status: "triage_failed",
        triaged_at: new Date().toISOString(),
        error: "MALFORMED_CLEF_RESPONSE",
      };
    }

    return {
      fact_id: fact.factId,
      status: "success",
      is_objectively_verifiable: isVerifiable,
      is_subjective: isSubjective,
      raw_surprise_score: rawScore,
      canonical_surprise_factor: canonicalSurpriseFactor(rawScore),
      triaged_at: new Date().toISOString(),
    };
  } catch (err) {
    return {
      fact_id: fact.factId,
      status: "triage_failed",
      triaged_at: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Persists triage record in the isolated `fact_triage/{factId}` collection.
 * This guarantees the canonical facts collection remains strictly isolated and
 * satisfies the Foundry-only active promotion contract.
 */
export async function saveFactTriageRecord(record: FactTriageRecord): Promise<void> {
  const data: Record<string, Json> = {
    fact_id: record.fact_id,
    status: record.status,
    triaged_at: record.triaged_at,
  };
  if (record.is_objectively_verifiable !== undefined) {
    data.is_objectively_verifiable = record.is_objectively_verifiable;
  }
  if (record.is_subjective !== undefined) {
    data.is_subjective = record.is_subjective;
  }
  if (record.raw_surprise_score !== undefined) {
    data.raw_surprise_score = record.raw_surprise_score;
  }
  if (record.canonical_surprise_factor !== undefined) {
    data.canonical_surprise_factor = record.canonical_surprise_factor;
  }
  if (record.error !== undefined) {
    data.error = record.error;
  }

  const existing = await getDoc(`fact_triage/${record.fact_id}`);
  if (existing) {
    const deletePaths: string[] = [];
    if (record.is_objectively_verifiable === undefined) {
      deletePaths.push("is_objectively_verifiable");
    }
    if (record.is_subjective === undefined) {
      deletePaths.push("is_subjective");
    }
    if (record.raw_surprise_score === undefined) {
      deletePaths.push("raw_surprise_score");
    }
    if (record.canonical_surprise_factor === undefined) {
      deletePaths.push("canonical_surprise_factor");
    }
    if (record.error === undefined) {
      deletePaths.push("error");
    }
    await patchDoc(`fact_triage/${record.fact_id}`, data, deletePaths);
  } else {
    await createDoc("fact_triage", record.fact_id, data);
  }
}
