import { describe, expect, it, vi } from "vitest";
import {
  validateNoulAnswer,
  validateScoreAnswer,
} from "@/lib/admin/clef-types";
import {
  canonicalSurpriseFactor,
  triageFactCandidate,
} from "@/lib/admin/clef-triage.server";

describe("Clef Fact Triage (Admin)", () => {
  describe("validateNoulAnswer", () => {
    it("validates valid noul values", () => {
      expect(validateNoulAnswer({ type: "noul", noul: 0.95 })).toBe(0.95);
      expect(validateNoulAnswer({ type: "noul", noul: 0 })).toBe(0);
      expect(validateNoulAnswer({ type: "noul", noul: 1 })).toBe(1);
    });

    it("rejects invalid noul values and missing types", () => {
      expect(validateNoulAnswer({ type: "score", noul: 0.5 })).toBeNull();
      expect(validateNoulAnswer({ noul: 0.5 })).toBeNull();
      expect(validateNoulAnswer({ type: "noul", noul: -0.1 })).toBeNull();
      expect(validateNoulAnswer({ type: "noul", noul: 1.1 })).toBeNull();
      expect(validateNoulAnswer({ type: "noul", noul: NaN })).toBeNull();
      expect(validateNoulAnswer(null)).toBeNull();
    });
  });

  describe("validateScoreAnswer", () => {
    it("validates valid score values within range", () => {
      expect(validateScoreAnswer({ type: "score", score: 0 }, 0, 3)).toBe(0);
      expect(validateScoreAnswer({ type: "score", score: 2.4 }, 0, 3)).toBe(2.4);
      expect(validateScoreAnswer({ type: "score", score: 3 }, 0, 3)).toBe(3);
    });

    it("rejects scores out of bounds or missing type", () => {
      expect(validateScoreAnswer({ type: "score", score: -0.1 }, 0, 3)).toBeNull();
      expect(validateScoreAnswer({ type: "score", score: 3.1 }, 0, 3)).toBeNull();
      expect(validateScoreAnswer({ type: "noul", score: 2 }, 0, 3)).toBeNull();
      expect(validateScoreAnswer({ score: 2 }, 0, 3)).toBeNull();
      expect(validateScoreAnswer(null, 0, 3)).toBeNull();
    });
  });

  describe("canonicalSurpriseFactor", () => {
    it("rounds and clamps raw scores to 0 | 1 | 2 | 3", () => {
      expect(canonicalSurpriseFactor(0)).toBe(0);
      expect(canonicalSurpriseFactor(0.4)).toBe(0);
      expect(canonicalSurpriseFactor(0.6)).toBe(1);
      expect(canonicalSurpriseFactor(1.8)).toBe(2);
      expect(canonicalSurpriseFactor(2.5)).toBe(3);
      expect(canonicalSurpriseFactor(3.0)).toBe(3);
      expect(canonicalSurpriseFactor(-1)).toBe(0);
      expect(canonicalSurpriseFactor(5)).toBe(3);
    });
  });

  describe("triageFactCandidate", () => {
    const sampleFact = {
      factId: "fact-123",
      question: "How many moons does Mars have?",
      true_number: 2,
      unit: "moons",
      claim_template: "Mars has {n} moons.",
    };

    it("returns null when AI binding is undefined (safe dev stub)", async () => {
      const res = await triageFactCandidate(undefined, sampleFact);
      expect(res).toBeNull();
    });

    it("successfully evaluates fact and produces FactTriageRecord", async () => {
      const mockRun = vi.fn().mockResolvedValue({
        model: "clef",
        answers: {
          is_objectively_verifiable: { type: "noul", noul: 0.99 },
          is_subjective: { type: "noul", noul: 0.01 },
          surprise_factor: { type: "score", score: 1.2 },
        },
      });

      const res = await triageFactCandidate({ run: mockRun }, sampleFact);
      expect(mockRun).toHaveBeenCalledWith("@cf/cloudflare/clef", expect.objectContaining({
        model: "clef",
        state: {
          claim: sampleFact.claim_template,
          question: sampleFact.question,
          number: sampleFact.true_number,
          unit: sampleFact.unit,
        },
      }));

      expect(res).not.toBeNull();
      expect(res?.status).toBe("success");
      expect(res?.fact_id).toBe("fact-123");
      expect(res?.is_objectively_verifiable).toBe(0.99);
      expect(res?.is_subjective).toBe(0.01);
      expect(res?.raw_surprise_score).toBe(1.2);
      expect(res?.canonical_surprise_factor).toBe(1);
      expect(res?.triaged_at).toBeDefined();
    });

    it("fails closed on malformed response without synthesizing false success fields", async () => {
      const mockRun = vi.fn().mockResolvedValue({
        model: "clef",
        answers: {
          is_objectively_verifiable: { type: "noul", noul: 0.95 },
          // Missing surprise_factor and is_subjective
        },
      });

      const res = await triageFactCandidate({ run: mockRun }, sampleFact);
      expect(res).not.toBeNull();
      expect(res?.status).toBe("triage_failed");
      expect(res?.error).toBe("MALFORMED_CLEF_RESPONSE");
      expect(res?.is_objectively_verifiable).toBeUndefined();
      expect(res?.raw_surprise_score).toBeUndefined();
    });

    it("fails closed when AI execution throws", async () => {
      const mockRun = vi.fn().mockRejectedValue(new Error("Rate limited on Workers AI"));

      const res = await triageFactCandidate({ run: mockRun }, sampleFact);
      expect(res).not.toBeNull();
      expect(res?.status).toBe("triage_failed");
      expect(res?.error).toBe("Rate limited on Workers AI");
    });
  });
});
