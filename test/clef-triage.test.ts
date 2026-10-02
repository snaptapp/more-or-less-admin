import { describe, expect, it, vi } from "vitest";
import {
  validateNoulAnswer,
  validateScoreAnswer,
} from "@/lib/admin/clef-types";
import {
  canonicalSurpriseFactor,
  triageFactCandidate,
  saveFactTriageRecord,
} from "@/lib/admin/clef-triage.server";
import { getDoc, createDoc, patchDoc, type FirestoreDoc } from "@/lib/firebase/firestore.server";

vi.mock("@/lib/firebase/firestore.server", () => ({
  getDoc: vi.fn(),
  createDoc: vi.fn(),
  patchDoc: vi.fn(),
}));

const mockDoc: FirestoreDoc = {
  id: "fact-abc",
  path: "fact_triage/fact-abc",
  data: {},
  createTime: "2026-10-02T12:00:00Z",
  updateTime: "2026-10-02T12:00:00Z",
};

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

  describe("saveFactTriageRecord", () => {
    it("creates a new record in fact_triage/{factId} when doc does not exist", async () => {
      vi.mocked(getDoc).mockResolvedValue(null);
      vi.mocked(createDoc).mockResolvedValue(mockDoc);

      await saveFactTriageRecord({
        fact_id: "fact-abc",
        status: "success",
        is_objectively_verifiable: 0.98,
        is_subjective: 0.02,
        raw_surprise_score: 2.1,
        canonical_surprise_factor: 2,
        triaged_at: "2026-10-02T12:00:00Z",
      });

      expect(getDoc).toHaveBeenCalledWith("fact_triage/fact-abc");
      expect(createDoc).toHaveBeenCalledWith("fact_triage", "fact-abc", {
        fact_id: "fact-abc",
        status: "success",
        triaged_at: "2026-10-02T12:00:00Z",
        is_objectively_verifiable: 0.98,
        is_subjective: 0.02,
        raw_surprise_score: 2.1,
        canonical_surprise_factor: 2,
      });
      // Verifies canonical facts collection is NEVER touched!
      expect(createDoc).not.toHaveBeenCalledWith("facts", expect.anything(), expect.anything());
    });

    it("patches an existing record with deletePaths for omitted fields", async () => {
      vi.mocked(getDoc).mockResolvedValue(mockDoc);
      vi.mocked(patchDoc).mockResolvedValue(mockDoc);

      // Transitioning from success to triage_failed: success fields omitted
      await saveFactTriageRecord({
        fact_id: "fact-abc",
        status: "triage_failed",
        error: "NETWORK_ERROR",
        triaged_at: "2026-10-02T12:01:00Z",
      });

      expect(patchDoc).toHaveBeenCalledWith(
        "fact_triage/fact-abc",
        {
          fact_id: "fact-abc",
          status: "triage_failed",
          triaged_at: "2026-10-02T12:01:00Z",
          error: "NETWORK_ERROR",
        },
        [
          "is_objectively_verifiable",
          "is_subjective",
          "raw_surprise_score",
          "canonical_surprise_factor",
        ]
      );
    });

    it("propagates getDoc errors instead of swallowing them", async () => {
      vi.mocked(getDoc).mockRejectedValue(new Error("Permission denied (403)"));

      await expect(
        saveFactTriageRecord({
          fact_id: "fact-abc",
          status: "triage_failed",
          error: "AUTH_FAILURE",
          triaged_at: "2026-10-02T12:00:00Z",
        })
      ).rejects.toThrow("Permission denied (403)");
    });
  });
});
