import { STATUS } from "./contract";

export interface DuplicateFactCandidate {
  id: string;
  subject: string;
  angle: string;
  question: string;
  claim_template: string;
  true_number: number | null;
  unit: string;
  context?: string;
  source_urls?: string[];
  quality_flags?: string[];
  status?: string;
  quantity_kind?: string | null;
  surprise_factor?: number | null;
}

export interface CandidateQualityScore {
  score: number;
  breakdown: string[];
}

/**
 * Deterministic quality scoring for duplicate candidate facts.
 * Used for tie-breaking when multiple duplicates have identical / correct true_numbers.
 */
export function scoreFactCandidateQuality(
  cand: DuplicateFactCandidate,
  targetNumber?: number | null,
): CandidateQualityScore {
  let score = 0;
  const breakdown: string[] = [];

  // 1. Correct true_number alignment
  if (targetNumber !== undefined && targetNumber !== null && cand.true_number !== null) {
    if (Math.abs(cand.true_number - targetNumber) < 1e-6) {
      score += 40;
      breakdown.push("true_number matches target (+40)");
    } else {
      score -= 20;
      breakdown.push(`true_number ${cand.true_number} differs from target ${targetNumber} (-20)`);
    }
  }

  // 2. Clean quality flags (crucial tie-breaker: 0 flags vs linter warnings)
  const flags = cand.quality_flags ?? [];
  if (flags.length === 0) {
    score += 30;
    breakdown.push("clean: 0 quality flags (+30)");
  } else {
    const penalty = flags.length * 15;
    score -= penalty;
    breakdown.push(`carries ${flags.length} flag(s): ${flags.join(", ")} (-${penalty})`);
  }

  // 3. Source grounding citations
  const sources = cand.source_urls ?? [];
  if (sources.length > 0) {
    const boost = Math.min(sources.length * 10, 25);
    score += boost;
    breakdown.push(`${sources.length} source citation(s) (+${boost})`);
  } else {
    breakdown.push("no source citations (0)");
  }

  // 4. Prompt phrasing & clarity
  // Fast-paced party trivia needs engaging, natural phrasing that is quickly readable during
  // a timed round (7-30s shot clock), avoiding clinical/sterile database stubs on one end
  // and overly bloated academic run-ons on the other.
  const q = cand.question?.trim() || "";
  if (q.length >= 12 && q.length <= 100) {
    score += 15;
    breakdown.push("engaging, well-sized card prompt (+15)");
  } else if (q.length > 100) {
    score += 8;
    breakdown.push("verbose prompt (+8)");
  } else if (q.length > 0) {
    score += 5;
    breakdown.push("under-specified / stub prompt (+5)");
  } else {
    score -= 20;
    breakdown.push("missing question prompt (-20)");
  }

  // 5. Claim template structural integrity (Mandatory game invariant)
  // claim_template is the full declarative sentence with {n} (e.g. "A cheetah runs at {n} mph").
  // Fact admission and export require {n} exactly once for reveal/export.
  const tmpl = cand.claim_template?.trim() || "";
  const placeholderCount = (tmpl.match(/\{n\}/g) || []).length;
  if (placeholderCount === 1) {
    score += 25;
    breakdown.push("valid claim template with {n} exactly once (+25)");
  } else if (placeholderCount === 0) {
    score -= 30;
    breakdown.push("malformed: claim template missing {n} (-30)");
  } else {
    score -= 30;
    breakdown.push(`malformed: claim template has multiple ({n}) placeholders (-30)`);
  }

  // 6. Educational explanation depth
  const ctx = cand.context?.trim() || "";
  if (ctx.length >= 35) {
    score += 15;
    breakdown.push("detailed background explanation (+15)");
  } else if (ctx.length > 0) {
    score += 5;
    breakdown.push("brief explanation (+5)");
  }

  // 7. Status stability
  if (cand.status === STATUS.active) {
    score += 10;
    breakdown.push("currently active in bank (+10)");
  } else if (cand.status === STATUS.pending) {
    score += 5;
    breakdown.push("pending admission (+5)");
  }

  return { score, breakdown };
}

/**
 * Compare all duplicate candidates and determine the recommended winner and tie-break reason.
 */
export function compareDuplicateCandidates(
  candidates: DuplicateFactCandidate[],
  targetNumber?: number | null,
): {
  recommendedWinnerId: string | null;
  retireIds: string[];
  tieBreakReason: string;
} {
  if (candidates.length === 0) {
    return { recommendedWinnerId: null, retireIds: [], tieBreakReason: "No candidates to evaluate." };
  }
  if (candidates.length === 1) {
    return { recommendedWinnerId: candidates[0].id, retireIds: [], tieBreakReason: "Single candidate provided." };
  }

  const scored = candidates.map((c) => ({
    candidate: c,
    ...scoreFactCandidateQuality(c, targetNumber),
  }));

  scored.sort((a, b) => b.score - a.score);

  const winner = scored[0];
  const losers = scored.slice(1);
  const retireIds = losers.map((l) => l.candidate.id);

  // Articulate tie-breaking factors between winner and closest runner-up
  const runnerUp = losers[0];
  const reasons: string[] = [];
  const winnerFlags = winner.candidate.quality_flags?.length ?? 0;
  const runnerUpFlags = runnerUp.candidate.quality_flags?.length ?? 0;
  if (winnerFlags === 0 && runnerUpFlags > 0) {
    reasons.push(`clean quality state (0 flags vs ${runnerUpFlags} on ${runnerUp.candidate.id})`);
  } else if (winnerFlags < runnerUpFlags) {
    reasons.push(`fewer quality flags (${winnerFlags} vs ${runnerUpFlags})`);
  }

  const winnerSources = winner.candidate.source_urls?.length ?? 0;
  const runnerUpSources = runnerUp.candidate.source_urls?.length ?? 0;
  if (winnerSources > runnerUpSources) {
    reasons.push(`${winnerSources} source citations vs ${runnerUpSources} on ${runnerUp.candidate.id}`);
  }

  const winnerTmplCount = (winner.candidate.claim_template?.match(/\{n\}/g) || []).length;
  const runnerUpTmplCount = (runnerUp.candidate.claim_template?.match(/\{n\}/g) || []).length;
  if (winnerTmplCount === 1 && runnerUpTmplCount !== 1) {
    reasons.push(`valid {n} claim template (malformed on ${runnerUp.candidate.id})`);
  }

  const winnerQ = winner.candidate.question?.trim() || "";
  const runnerUpQ = runnerUp.candidate.question?.trim() || "";
  if (winnerQ.length >= 12 && runnerUpQ.length < 12) {
    reasons.push(`richer prompt description (${winnerQ.length} chars vs stub '${runnerUpQ}')`);
  }

  const winnerCtx = winner.candidate.context?.trim().length ?? 0;
  const runnerUpCtx = runnerUp.candidate.context?.trim().length ?? 0;
  if (winnerCtx > runnerUpCtx + 20) {
    reasons.push("richer educational explanation");
  }

  if (winner.candidate.status === STATUS.active && runnerUp.candidate.status !== STATUS.active) {
    reasons.push(`currently active (${runnerUp.candidate.status ?? "inactive"} on ${runnerUp.candidate.id})`);
  }

  const tieBreakReason = reasons.length > 0
    ? `Winner ${winner.candidate.id} chosen over ${runnerUp.candidate.id} (${winner.score} pts vs ${runnerUp.score} pts) based on: ${reasons.join(", ")}.`
    : `Winner ${winner.candidate.id} scored highest (${winner.score} pts vs ${runnerUp.score} pts) across quality, sources, and phrasing.`;

  return {
    recommendedWinnerId: winner.candidate.id,
    retireIds,
    tieBreakReason,
  };
}

export interface MinimalReviewForSafety {
  verdict: string;
  confidence: string;
  policy: {
    needsReview: boolean;
    score: number;
    reasons: string[];
  };
  duplicateResolution?: {
    action: string;
    keepFactId: string | null;
    retireFactIds: string[];
  } | null;
  sources: Array<{
    conflicting: boolean;
  }>;
}

/**
 * Checks whether a Copilot duplicate resolution is safe to bulk-apply without per-item manual editor review.
 */
export function isDuplicateDecisionSafe(
  review: MinimalReviewForSafety,
  candidates?: DuplicateFactCandidate[],
): {
  safe: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (review.verdict !== "resolve_duplicate") {
    reasons.push(`Verdict is ${review.verdict}, not resolve_duplicate.`);
  }
  if (
    !review.duplicateResolution ||
    review.duplicateResolution.action !== "keep_one" ||
    !review.duplicateResolution.keepFactId
  ) {
    reasons.push("No single winning fact identified to keep.");
  }
  if (review.confidence !== "high") {
    reasons.push(`Confidence is ${review.confidence} (expected high).`);
  }
  if (review.policy.needsReview) {
    reasons.push(`Policy flagged for review: ${review.policy.reasons.join(", ") || "needs review"}`);
  }
  if (review.policy.score < 75) {
    reasons.push(`Quality score ${review.policy.score} is below the safe threshold of 75.`);
  }
  const conflicting = review.sources.filter((s) => s.conflicting);
  if (conflicting.length > 0) {
    reasons.push(`${conflicting.length} source(s) conflict with recommendation.`);
  }
  if (candidates && candidates.length > 0 && review.duplicateResolution?.keepFactId) {
    const keepFact = candidates.find((c) => c.id === review.duplicateResolution?.keepFactId);
    if (!keepFact) {
      reasons.push(`Recommended winner ${review.duplicateResolution.keepFactId} is not in candidate list.`);
    } else {
      const tmpl = keepFact.claim_template?.trim() || "";
      const count = (tmpl.match(/\{n\}/g) || []).length;
      if (count !== 1) {
        reasons.push(`Winning fact ${keepFact.id} has invalid claim template (must contain {n} exactly once, found ${count}).`);
      }
    }
  }

  return {
    safe: reasons.length === 0,
    reasons,
  };
}
