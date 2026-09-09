/**
 * Autonomous Daily Blitz drafts. Writes daily_pack_drafts only.
 * Live daily_packs still require Save & Schedule. Unfilled live dates
 * keep the Sports bank cycle until then.
 */
import { createDoc, deleteDoc, getDoc, patchDoc } from "../firebase/firestore.server";
import {
  BLITZ_CATEGORIES,
  DAILY_BLITZ_FALLBACK_CATEGORY,
  DAILY_BLITZ_ROUNDS,
  addUtcDays,
  utcToday,
} from "./daily-blitz";
import { generatePackViaGoAgent, goAgentConfigured } from "./goagent.server";
import { getDailyDraft, getDailyPack, writeDailyDraft } from "./ops.server";

export const DEFAULT_DRAFT_LOOKAHEAD = 5;
const DRAFT_CLAIM_COLLECTION = "daily_pack_draft_claims";
/** Go pack generation can take minutes; expired claims may be reclaimed. */
const DRAFT_CLAIM_LEASE_MS = 10 * 60 * 1000;

/**
 * Generates UTC date strings for a bounded lookahead period.
 *
 * @param lookahead - The number of dates to generate, clamped to 1 through 14
 * @param from - The UTC date from which to start
 * @returns An array of consecutive UTC date strings
 */
export function draftTargets(lookahead: number, from = utcToday()): string[] {
  const n = Math.min(14, Math.max(1, Math.round(lookahead) || 1));
  const dates: string[] = [];
  for (let i = 0; i < n; i++) dates.push(addUtcDays(from, i));
  return dates;
}

/** @deprecated Use draftTargets. Kept for callers from the merged main branch. */
export const lookaheadDates = draftTargets;

/**
 * Normalizes a draft lookahead value to an integer between 1 and 14 days.
 *
 * @param raw - The value to normalize
 * @returns The integer lookahead when valid; otherwise, the default draft lookahead
 */
export function clampLookahead(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 14) return DEFAULT_DRAFT_LOOKAHEAD;
  return n;
}

/**
 * Selects a Blitz category using a cyclic offset.
 *
 * @param offset - The category index offset, which may be negative
 * @returns The category at the normalized offset, or the fallback category when no categories are configured
 */
export function rotateCategory(offset: number): string {
  const list = BLITZ_CATEGORIES.length ? BLITZ_CATEGORIES : [DAILY_BLITZ_FALLBACK_CATEGORY];
  return list[((offset % list.length) + list.length) % list.length];
}

function firestoreMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAlreadyExistsError(error: unknown): boolean {
  return /\(409\)|ALREADY_EXISTS/i.test(firestoreMessage(error));
}

function isLostClaimRaceError(error: unknown): boolean {
  return /FAILED_PRECONDITION|\(400\)|\(404\)|ALREADY_EXISTS|\(409\)/i.test(firestoreMessage(error));
}

/**
 * Whether a draft-date claim may be deleted and recreated.
 *
 * @param status - Stored claim status
 * @param leaseExpiresAt - ISO lease expiry, if any
 * @param now - Comparison instant in milliseconds
 * @returns True when the claim is failed or the lease has elapsed
 */
export function shouldReclaimDraftClaim(
  status: string,
  leaseExpiresAt: string | null | undefined,
  now = Date.now(),
): boolean {
  if (status === "failed") return true;
  if (status !== "generating") return true;
  if (!leaseExpiresAt) return true;
  const expires = Date.parse(leaseExpiresAt);
  return !Number.isFinite(expires) || expires <= now;
}

async function claimDraftDate(
  date: string,
): Promise<{ ok: true; claimId: string } | { ok: false; reason: string }> {
  const claimId = crypto.randomUUID();
  const now = Date.now();
  const payload = {
    date,
    claimId,
    status: "generating",
    claimedAt: new Date(now).toISOString(),
    leaseExpiresAt: new Date(now + DRAFT_CLAIM_LEASE_MS).toISOString(),
    source: "cron",
  };

  const createClaim = async () => {
    await createDoc(DRAFT_CLAIM_COLLECTION, date, payload);
  };

  try {
    await createClaim();
    return { ok: true, claimId };
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }

  const existing = await getDoc(`${DRAFT_CLAIM_COLLECTION}/${date}`);
  if (!existing) {
    try {
      await createClaim();
      return { ok: true, claimId };
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        return { ok: false, reason: "date already claimed" };
      }
      throw error;
    }
  }

  const status = String(existing.data["status"] ?? "");
  const leaseExpiresAt =
    typeof existing.data["leaseExpiresAt"] === "string" ? existing.data["leaseExpiresAt"] : null;
  if (!shouldReclaimDraftClaim(status, leaseExpiresAt, now)) {
    return { ok: false, reason: "date already claimed" };
  }

  try {
    await deleteDoc(
      `${DRAFT_CLAIM_COLLECTION}/${date}`,
      existing.updateTime ? { updateTime: existing.updateTime } : { exists: true },
    );
    await createClaim();
    return { ok: true, claimId };
  } catch (error) {
    if (isLostClaimRaceError(error)) {
      return { ok: false, reason: "date already claimed" };
    }
    throw error;
  }
}

async function releaseDraftClaim(date: string, claimId: string): Promise<void> {
  const existing = await getDoc(`${DRAFT_CLAIM_COLLECTION}/${date}`);
  if (!existing) return;
  if (String(existing.data["claimId"] ?? "") !== claimId) return;
  await deleteDoc(`${DRAFT_CLAIM_COLLECTION}/${date}`);
}

async function markDraftClaimFailed(date: string, claimId: string, reason: string): Promise<void> {
  const existing = await getDoc(`${DRAFT_CLAIM_COLLECTION}/${date}`);
  if (!existing) return;
  if (String(existing.data["claimId"] ?? "") !== claimId) return;
  await patchDoc(`${DRAFT_CLAIM_COLLECTION}/${date}`, {
    status: "failed",
    error: reason.slice(0, 500),
    failedAt: new Date().toISOString(),
  });
}

/**
 * Creates daily Blitz drafts for upcoming dates that have no live pack or pending draft.
 *
 * @param lookahead - The number of upcoming days to consider, clamped to the supported range.
 * @returns Drafted dates and dates skipped with the reason for each skip.
 */
export async function fillUnfilledDailyDrafts(
  lookahead: number = DEFAULT_DRAFT_LOOKAHEAD,
): Promise<{ drafted: string[]; skipped: { date: string; reason: string }[] }> {
  const drafted: string[] = [];
  const skipped: { date: string; reason: string }[] = [];
  if (!goAgentConfigured()) {
    return {
      drafted,
      skipped: [{ date: "*", reason: "GO_AGENT_URL is not configured on ops." }],
    };
  }

  const dates = draftTargets(lookahead);
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const live = await getDailyPack(date);
    if (live) {
      skipped.push({ date, reason: "live pack exists" });
      continue;
    }
    const existing = await getDailyDraft(date);
    if (existing) {
      skipped.push({ date, reason: "draft already awaiting review" });
      continue;
    }

    let claimed: { ok: true; claimId: string } | { ok: false; reason: string };
    try {
      claimed = await claimDraftDate(date);
    } catch (err) {
      skipped.push({
        date,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!claimed.ok) {
      skipped.push({ date, reason: claimed.reason });
      continue;
    }

    const category = rotateCategory(i);
    const brief = `Autonomous Daily Blitz draft for ${date}. Genre rotation: ${category}. Mix 15 grounded rounds.`;
    let releaseClaim = true;
    try {
      const liveAfterClaim = await getDailyPack(date);
      if (liveAfterClaim) {
        skipped.push({ date, reason: "live pack exists" });
        continue;
      }
      const draftAfterClaim = await getDailyDraft(date);
      if (draftAfterClaim) {
        skipped.push({ date, reason: "draft already awaiting review" });
        continue;
      }

      const pack = await generatePackViaGoAgent({
        topic: category,
        guidance: brief,
        numRounds: DAILY_BLITZ_ROUNDS,
      });
      if (!pack.is_valid || pack.rounds.length === 0) {
        const reason = pack.status_message || "Go agent returned no rounds.";
        await markDraftClaimFailed(date, claimed.claimId, reason);
        releaseClaim = false;
        skipped.push({ date, reason });
        continue;
      }
      await writeDailyDraft({
        date,
        category: pack.category || category,
        brief,
        rounds: pack.rounds,
        source: "cron",
      });
      drafted.push(date);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await markDraftClaimFailed(date, claimed.claimId, reason);
      releaseClaim = false;
      skipped.push({ date, reason });
    } finally {
      if (releaseClaim) {
        try {
          await releaseDraftClaim(date, claimed.claimId);
        } catch {
          /* Lease expires and can be reclaimed. */
        }
      }
    }
  }
  return { drafted, skipped };
}

/**
 * Validates an authorization header against the configured operations cron secret.
 *
 * @param authorization - The authorization header containing the bearer token
 * @returns `true` if the token matches the configured secret, `false` otherwise.
 */
export function cronSecretMatches(authorization: string | null): boolean {
  const expected = (process.env["OPS_CRON_SECRET"] ?? "").trim();
  if (!expected) return false;
  const provided = (authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!provided) return false;
  const max = Math.max(expected.length, provided.length);
  let mismatch = expected.length ^ provided.length;
  for (let i = 0; i < max; i++) {
    mismatch |= (expected.charCodeAt(i) || 0) ^ (provided.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}
