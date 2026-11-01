/**
 * Pure duplicate-detection helpers for admin reports and facts. No I/O: the
 * functions only normalize question text and compare token sets.
 */
import { normalizeKey } from "../firebase/firestore.server";
import { QUANTITY_KINDS } from "../../../shared/fact-lifecycle-contract.gen";

const INTERROGATIVE_PREFIXES = [
  ["how", "many"],
  ["how", "much"],
  ["how", "long"],
  ["how", "tall"],
  ["how", "far"],
  ["how", "old"],
  ["how", "fast"],
  ["how", "often"],
  ["how", "does"],
  ["how", "did"],
  ["how", "do"],
  ["what", "is"],
  ["what", "s"],
  ["what", "was"],
  ["what", "were"],
  ["what", "did"],
  ["what", "does"],
  ["what", "are"],
  ["what", QUANTITY_KINDS[0]],
  ["what"],
  ["which"],
  ["who"],
  ["when"],
  ["where"],
  ["why"],
  ["how"],
];

type DuplicateCandidate = {
  id?: string;
  question?: string;
  claim_template?: string;
  subject?: string;
  subject_key?: string;
};

/** True when the tokens begin with the prefix and carry at least one word after it. */
function startsWithPrefix(tokens: string[], prefix: readonly string[]): boolean {
  return tokens.length > prefix.length && prefix.every((word, i) => tokens[i] === word);
}

/** Two strings match only when both are non-empty and equal. */
function matchesNonEmpty(a: string, b: string): boolean {
  return a !== "" && a === b;
}

export function normalizeQuestion(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!s) return "";
  const toks = s.split(" ").filter(Boolean);
  const prefix = INTERROGATIVE_PREFIXES.find((pre) => startsWithPrefix(toks, pre));
  return (prefix ? toks.slice(prefix.length) : toks).join(" ");
}

/** Shared-element count and Jaccard index. Either set empty yields 0 for both. */
function sharedTokenStats(a: Set<string>, b: Set<string>): { intersection: number; jaccard: number } {
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return { intersection, jaccard: union > 0 ? intersection / union : 0 };
}

export const ENGLISH_STOP_WORDS = new Set([
  "a", "about", "above", "after", "again", "all", "also", "am", "an", "and", "any", "are", "as", "at",
  "be", "because", "been", "before", "being", "below", "between", "both", "but", "by", "can", "did",
  "do", "does", "doing", "down", "during", "each", "few", "for", "from", "further", "had", "has",
  "have", "having", "he", "her", "here", "hers", "herself", "him", "himself", "his", "how", "i",
  "if", "in", "into", "is", "it", "its", "itself", "just", "me", "more", "most", "my", "myself",
  "no", "nor", "not", "now", "of", "off", "on", "once", "only", "or", "other", "our", "ours",
  "ourselves", "out", "over", "own", "same", "she", "should", "so", "some", "such", "than", "that",
  "the", "their", "theirs", "them", "themselves", "then", "there", "these", "they", "this", "those",
  "through", "throughout", "to", "too", "under", "until", "up", "very", "was", "we", "were", "what",
  "when", "where", "which", "while", "who", "whom", "why", "with", "won", "would", "you", "your",
  "yours", "yourself", "yourselves",
]);

export function extractEntityTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !ENGLISH_STOP_WORDS.has(w));
}

function questionText(fact: DuplicateCandidate): string {
  return normalizeQuestion(fact.question || fact.claim_template || "");
}

function subjectKey(fact: DuplicateCandidate): string {
  return (fact.subject_key || normalizeKey(fact.subject || "")).trim().toLowerCase();
}

function isDuplicateByOverlap(sameSubject: boolean, intersection: number, jaccard: number): boolean {
  // When subjects match: require moderate entity Jaccard (>= 0.40) or at least 2 shared entity tokens with jaccard >= 0.30
  if (sameSubject) {
    return jaccard >= 0.40 || (intersection >= 2 && jaccard >= 0.30);
  }
  // Cross-subject: require strong entity overlap (>= 0.60 Jaccard AND >= 2 shared entity tokens)
  return jaccard >= 0.60 && intersection >= 2;
}

export function areFactsDuplicateCandidates(primary: DuplicateCandidate, candidate: DuplicateCandidate): boolean {
  if (matchesNonEmpty(primary.id ?? "", candidate.id ?? "")) {
    return false;
  }

  const normA = questionText(primary);
  const normB = questionText(candidate);
  if (matchesNonEmpty(normA, normB)) {
    return true;
  }

  // Empty token sets give zero overlap, so they fall through to false without a separate guard.
  const { intersection, jaccard } = sharedTokenStats(
    new Set(extractEntityTokens(normA)),
    new Set(extractEntityTokens(normB)),
  );
  return isDuplicateByOverlap(matchesNonEmpty(subjectKey(primary), subjectKey(candidate)), intersection, jaccard);
}
