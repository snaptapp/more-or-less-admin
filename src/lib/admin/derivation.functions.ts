import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "./middleware";
import { auditDerivation, type DerivationAuditTrace } from "./derivation-audit";
import { numericIngest } from "../../../shared/ddm/derivation";

export const auditDerivationFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: unknown) =>
    z
      .object({
        trueNumber: z.union([z.number(), z.string()]),
        unit: z.string(),
        surpriseFactor: z.union([z.number(), z.string()]).optional(),
        quantityKind: z.string().optional(),
        trapDirection: z.enum(["OVERESTIMATE", "UNDERESTIMATE"]).optional(),
        forcedSide: z.enum(["MORE", "LESS"]).optional(),
        plausibleMin: z.union([z.number(), z.string()]).optional(),
        plausibleMax: z.union([z.number(), z.string()]).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    return auditDerivation({
      trueNumber: data.trueNumber,
      unit: data.unit,
      surpriseFactor: data.surpriseFactor,
      quantityKind: data.quantityKind,
      trapDirection: data.trapDirection,
      forcedSide: data.forcedSide,
      plausibleMin: data.plausibleMin,
      plausibleMax: data.plausibleMax,
    });
  });

export interface ProbedRoundAudit {
  round_number: number;
  topic: string;
  claim_statement: string;
  true_number: number | string;
  presented_number: number | string;
  unit: string;
  correct_direction: string;
  surprise_factor: number;
  explanation: string;
  quantity_kind?: string;
  trap_direction?: string;
  plausible_min?: number;
  plausible_max?: number;
  trace: DerivationAuditTrace | null;
}

export interface ProbeGoAgentResult {
  category: string;
  status_message: string;
  rounds: ProbedRoundAudit[];
}

export const probeGoAgentPackFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: unknown) =>
    z
      .object({
        topic: z.string().min(1),
        numRounds: z.number().int().min(1).max(5).optional(),
        guidance: z.string().optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const { generatePackViaGoAgent } = await import("./goagent.server");
    const pack = await generatePackViaGoAgent({
      topic: data.topic,
      numRounds: data.numRounds ?? 3,
      guidance: data.guidance,
    });

    const rounds: ProbedRoundAudit[] = pack.rounds.map((r) => {
      let trace: DerivationAuditTrace | null = null;
      try {
        const trueToken = String(r.true_number).trim();
        if (trueToken !== "" && numericIngest(trueToken).fixedPointValue !== undefined) {
          trace = auditDerivation({
            // Preserve the source numeric spelling until the DDM's exact
            // Numeric_Ingest stage. Converting to Number here would erase
            // trailing zeroes, exponent spelling, and scale-3 edge cases.
            trueNumber: trueToken,
            unit: r.unit,
            surpriseFactor: r.surprise_factor,
            quantityKind: r.quantity_kind,
            trapDirection: r.trap_direction === "UNDERESTIMATE" ? "UNDERESTIMATE" : "OVERESTIMATE",
            forcedSide: r.correct_direction === "MORE" ? "MORE" : "LESS",
            plausibleMin: r.plausible_min,
            plausibleMax: r.plausible_max,
          });
        }
      } catch {
        trace = null;
      }

      return {
        round_number: r.round_number,
        topic: r.topic,
        claim_statement: r.claim_statement,
        true_number: r.true_number,
        presented_number: r.presented_number,
        unit: r.unit,
        correct_direction: r.correct_direction,
        surprise_factor: r.surprise_factor,
        explanation: r.explanation,
        quantity_kind: r.quantity_kind,
        trap_direction: r.trap_direction,
        plausible_min: r.plausible_min,
        plausible_max: r.plausible_max,
        trace,
      };
    });

    return {
      category: pack.category,
      status_message: pack.status_message,
      rounds,
    };
  });
