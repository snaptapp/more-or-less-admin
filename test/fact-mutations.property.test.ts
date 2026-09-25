/**
 * Feature: admin-quality-gates-and-shared-contracts
 *
 * Properties over the two `src/lib/admin/content.server.ts` functions that
 * decide what a fact document *becomes*: the status patch a moderator writes,
 * and the field mapping every read goes through.
 *
 * Property 20: `setFactStatus` builds the correct patch for every status
 *   *For any* status value in `FACT_STATUSES` at run time, the patch
 *   `setFactStatus` persists sets `status` to that value and carries an
 *   ISO-8601 `updated_at`; the `retired` case carries a non-empty
 *   `retired_reason`; the `disputed` case sets no `retired_reason`; and the
 *   `active` case clears `retired_reason`. No transition writes
 *   `verified_at` or `verifier_model`; those fields belong to the banked-fact
 *   auditor, not an admin moderation operation.
 *   Validates: Requirements 6.5, 6.6
 *
 * Property 21: `toFact` canonicalizes `surprise_factor` across the legacy range
 *   *For any* integer input from 0 through 10, `toFact` preserves inputs 0
 *   through 3 and maps each input 4 through 10 into the range 0 through 3
 *   matching the Main_Repository canonicalization, and maps an absent or
 *   non-numeric value to `null`.
 *   Validates: Requirement 6.9
 *
 * Design notes
 * ------------
 * `FACT_STATUSES` is iterated at run time, never restated: the status domain is
 * generated with `fc.constantFrom(...FACT_STATUSES)` and every status is also
 * exercised once by an explicit sweep over the same array, so adding a status
 * to the declaration (Requirement 9.1 does exactly that in Phase 2) extends
 * this property instead of silently leaving the new status unasserted.
 *
 * Verification metadata is intentionally absent from every transition patch;
 * the dedicated CAS/audit suite proves that a transition cannot smuggle those
 * fields into the transaction payload.
 *
 * Only Firestore is replaced (the in-memory double from `test/setup.ts`);
 * `content.server` itself is the real module, so the patch asserted on is the
 * patch production would send. `toFact` is pure over a `FirestoreDoc`, so
 * Property 21 constructs documents directly and needs no store at all.
 */
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import {
  blockedNetworkAttempts,
  firestoreDouble,
  type FirestoreDoc,
  type Json,
} from "./setup";

// Persistence is the only seam: no credential, emulator, or deployed service
// (Requirement 6.10).
vi.mock("@/lib/firebase/firestore.server", async () => {
  const { firestoreDouble: double } = await import("./setup");
  return double().module;
});

import { FACT_STATUSES, setFactStatus, toFact } from "@/lib/admin/content.server";
import { STATUS_TRANSITIONS } from "../shared/fact-lifecycle-contract.gen";

/**
 * A current status the shared contract admin-authorizes to transition into
 * `target`, or `null` when no admin-authorized transition reaches `target`.
 * The contract — not this test — decides which starting status makes a target
 * reachable, so the sweep below seeds the reachable ones from a valid source
 * and pins the unreachable ones (e.g. `pending`) as rejected.
 */
function adminAuthorizedSourceFor(target: string): string | null {
  const transition = STATUS_TRANSITIONS.find((t) => t.to === target && t.adminAuthorized);
  return transition ? transition.from : null;
}



// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** `new Date().toISOString()` output, and only that: an ISO-8601 UTC instant. */
function isIsoTimestamp(value: Json | undefined): boolean {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

/** The document a status change starts from: a plain, active, verified fact. */
const SEED_DOC = {
  subject: "Seeded subject",
  subject_key: "seeded_subject",
  angle: "Seeded angle",
  angle_key: "seeded_angle",
  question: "Seeded question?",
  claim_template: "Seeded claim {n}",
  context: "Seeded context",
  true_number: 42,
  unit: "units",
  status: "active",
  content_rating: "standard",
  surprise_factor: 2,
  retired_reason: "an earlier retirement reason",
  verifier_model: "seeded_model",
  verified_at: "2023-01-01T00:00:00.000Z",
  source_urls: [],
  served_count: 0,
} as const;

/** Ids built from a fixed alphabet, so every id is one legal path segment. */
const idArb = fc
  .array(fc.constantFrom("a", "b", "c", "d", "e", "f", "0", "1", "2", "3", "_"), {
    minLength: 3,
    maxLength: 10,
  })
  .map((chars) => `fact_${chars.join("")}`);

/**
 * Invoke `setFactStatus` against a freshly seeded document and return the patch
 * it sent, having first proved it sent exactly one.
 */
async function persistedPatch(input: {
  id: string;
  status: (typeof FACT_STATUSES)[number];
  reason?: string;
  verifierModel?: string;
}): Promise<{ patch: Record<string, Json>; status: string }> {
  // The contract guard (Requirements 9.3, 9.4) evaluates current→requested, so
  // the document is seeded in a status the contract admin-authorizes to reach
  // the requested one. Callers only reach here for reachable targets.
  const from = adminAuthorizedSourceFor(input.status);
  if (from === null) {
    throw new Error(
      `persistedPatch called for unreachable target "${input.status}"; use the rejection path instead`,
    );
  }
  firestoreDouble().reset();
  firestoreDouble().seed(`fact_bank/${input.id}`, { ...SEED_DOC, status: from });

  const record = await setFactStatus(input);

  const writes = firestoreDouble().writes();
  expect(writes, `writes for status ${input.status}`).toHaveLength(1);
  expect(writes[0].kind).toBe("patch");
  expect(writes[0].path).toBe(`fact_bank/${input.id}`);
  const patch = writes[0].data;
  if (patch === undefined) throw new Error("the recorded patch carried no data");

  return { patch, status: record.status };
}

/**
 * Every clause of Requirements 6.5 and 6.6 for one invocation, expressed
 * against the patch that reached Firestore.
 */
function expectPatchSatisfiesContract(
  patch: Record<string, Json>,
  input: { status: (typeof FACT_STATUSES)[number]; reason?: string; verifierModel?: string },
): void {
  const where = `status ${input.status}`;

  // Every transition carries the requested status and an ISO timestamp.
  expect(patch["status"], where).toBe(input.status);
  expect(isIsoTimestamp(patch["updated_at"]), `${where}: updated_at ${String(patch["updated_at"])}`).toBe(
    true,
  );

  // Admin transitions are moderation operations, never verification events.
  // Existing verification fields are preserved by the merge, but no transition
  // may add or rewrite either one.
  expect("verified_at" in patch, `${where}: verified_at must not be written`).toBe(false);
  expect("verifier_model" in patch, `${where}: verifier_model must not be written`).toBe(false);

  if (input.status === "retired") {
    const reason = patch["retired_reason"];
    expect(typeof reason, where).toBe("string");
    expect(String(reason).length, where).toBeGreaterThan(0);
    if (input.reason !== undefined) expect(reason).toBe(input.reason);
  }

  if (input.status === "disputed") {
    expect("retired_reason" in patch, `${where}: retired_reason must not be set`).toBe(false);
  }

  if (input.status === "active") {
    expect(patch["retired_reason"], where).toBeNull();
  }

  // Nothing outside the declared transition patch surface is written.
  const allowed = new Set(["status", "updated_at", "retired_reason"]);
  expect(Object.keys(patch).filter((key) => !allowed.has(key)), where).toEqual([]);
}

// ---------------------------------------------------------------------------
// Property 20
// ---------------------------------------------------------------------------

describe("Feature: admin-quality-gates-and-shared-contracts, Property 20: `setFactStatus` builds the correct patch for every status", () => {
  it("declares a non-empty status set, so the sweep below is not vacuous", () => {
    expect(FACT_STATUSES.length).toBeGreaterThan(0);
    expect(new Set(FACT_STATUSES).size).toBe(FACT_STATUSES.length);
    // The contract must retain the lifecycle states exercised below; a future
    // contract change should fail loudly rather than silently skip a status.
    expect(FACT_STATUSES).toContain("active");
    expect(FACT_STATUSES).toContain("disputed");
    expect(FACT_STATUSES).toContain("retired");
  });

  it("covers every FACT_STATUSES value declared at run time, once each", async () => {
    // Requirement 6.5 is explicit that the coverage set is whatever the array
    // declares *at the time of the run*, so it is iterated, not restated. Each
    // status is seeded from a contract-authorized source (Requirements 9.3,
    // 9.4); a target the contract makes unreachable (e.g. `pending`) is pinned
    // as a rejection instead, so the patch contract is still asserted for every
    // reachable status without granting write authority the contract withholds.
    const covered: string[] = [];
    for (const status of FACT_STATUSES) {
      if (adminAuthorizedSourceFor(status) === null) {
        firestoreDouble().reset();
        firestoreDouble().seed(`fact_bank/sweep_${status}`, { ...SEED_DOC });
        await expect(setFactStatus({ id: `sweep_${status}`, status })).rejects.toThrow(
          /not admin-authorized/,
        );
        expect(firestoreDouble().writes()).toHaveLength(0);
        covered.push(status);
        continue;
      }
      const input = { id: `sweep_${status}`, status };
      const { patch, status: returnedStatus } = await persistedPatch(input);
      expectPatchSatisfiesContract(patch, input);
      // The record handed back reflects the new status, so the caller and the
      // store agree.
      expect(returnedStatus).toBe(status);
      covered.push(status);
    }
    expect(covered).toEqual([...FACT_STATUSES]);
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("builds a metadata-free patch for any status, reason and legacy verifier input", async () => {
    // `reason` is either absent or a non-empty string: the two forms the portal
    // produces. (An explicitly supplied empty reason is pinned as an
    // observation below — it is outside this property's quantifier.)
    // Only statuses the contract makes reachable are drawn: the patch shape is
    // what this property asserts, and an unreachable target has no patch (it is
    // rejected before any write). Reachability is covered separately above.
    const reachableStatuses = FACT_STATUSES.filter(
      (status) => adminAuthorizedSourceFor(status) !== null,
    );
    const inputArb = fc.record({
      id: idArb,
      status: fc.constantFrom(...reachableStatuses),
      reason: fc.option(fc.string({ minLength: 1, maxLength: 60 }), { nil: undefined }),
      verifierModel: fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
    });

    await fc.assert(
      fc.asyncProperty(inputArb, async (input) => {
        const { patch, status } = await persistedPatch(input);
        expectPatchSatisfiesContract(patch, input);
        expect(status).toBe(input.status);
        expect(blockedNetworkAttempts()).toEqual([]);
        return true;
      }),
      { numRuns: 150 },
    );
  });

  it("leaves every other field of the document exactly as it was", async () => {
    const reachableStatuses = FACT_STATUSES.filter(
      (status) => adminAuthorizedSourceFor(status) !== null,
    );
    await fc.assert(
      fc.asyncProperty(idArb, fc.constantFrom(...reachableStatuses), async (id, status) => {
        const { patch } = await persistedPatch({ id, status });
        const stored = firestoreDouble().document(`fact_bank/${id}`);
        if (stored === null) throw new Error(`fact ${id} vanished`);

        // A patch merges: untouched keys keep their seeded values.
        for (const [key, seeded] of Object.entries(SEED_DOC)) {
          if (key in patch) continue;
          expect(stored.data[key], `${key} after status ${status}`).toEqual(seeded);
        }
        return true;
      }),
      { numRuns: 100 },
    );
  });

  it("passes an explicitly supplied empty reason through, so the fallback is nullish-only", async () => {
    // Observation, not a Requirement 6.5 clause: the non-empty guarantee comes
    // from the `??` fallback, which only fires on `undefined`/`null`. A caller
    // that supplies `reason: ""` (the `changeFactStatus` validator accepts it,
    // since `reason` is `z.string().optional()`) stores an empty
    // `retired_reason`. Pinned here so the boundary is documented rather than
    // discovered later.
    const { patch } = await persistedPatch({ id: "empty_reason", status: "retired", reason: "" });
    expect(patch["status"]).toBe("retired");
    expect(patch["retired_reason"]).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Property 21
// ---------------------------------------------------------------------------

/**
 * The Main_Repository canonicalization, transcribed from the reference tests
 * (`tests/node/derivation_property04_surprise.test.ts` and
 * `agent-go/derivation_surprise_test.go`): canonical 0-3 are identity, and the
 * legacy 4-10 band folds into 0-3 as 4→1, 5-7→2, 8-10→3.
 */
const CANONICAL_SURPRISE: Readonly<Record<number, number>> = {
  0: 0,
  1: 1,
  2: 2,
  3: 3,
  4: 1,
  5: 2,
  6: 2,
  7: 2,
  8: 3,
  9: 3,
  10: 3,
};

/** A `fact_bank` document carrying exactly the supplied `surprise_factor`. */
function docWithSurprise(raw: Json | undefined): FirestoreDoc {
  const data: Record<string, Json> = { subject: "Subject", angle: "Angle" };
  if (raw !== undefined) data["surprise_factor"] = raw;
  return { id: "fact_surprise", path: "fact_bank/fact_surprise", data };
}

/** Values that are present but not numbers, so canonicalization has nothing to read. */
const nonNumericArb: fc.Arbitrary<Json> = fc.oneof(
  fc.string({ maxLength: 4 }),
  // A numeric *string* is still non-numeric to the mapper.
  fc.integer({ min: 0, max: 10 }).map((value) => String(value)),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 2 }),
  fc.constant({ value: 2 } as Json),
);

describe("Feature: admin-quality-gates-and-shared-contracts, Property 21: `toFact` canonicalizes `surprise_factor` across the legacy range", () => {
  it("preserves 0-3 and folds 4-10 into 0-3, matching the Main_Repository mapping", () => {
    for (let raw = 0; raw <= 10; raw++) {
      const canonical = toFact(docWithSurprise(raw)).surprise_factor;
      expect(canonical, `surprise_factor ${raw}`).toBe(CANONICAL_SURPRISE[raw]);
      if (raw <= 3) expect(canonical, `surprise_factor ${raw} preserved`).toBe(raw);
      expect(canonical, `surprise_factor ${raw} in range`).toBeGreaterThanOrEqual(0);
      expect(canonical, `surprise_factor ${raw} in range`).toBeLessThanOrEqual(3);
    }
  });

  it("maps every integer 0-10 into 0-3 deterministically, whatever else the document carries", () => {
    // The surrounding document is generated too: canonicalization must depend on
    // the one field and nothing else.
    const noiseArb = fc.record({
      status: fc.constantFrom(...FACT_STATUSES),
      content_rating: fc.constantFrom("standard", "after_dark"),
      true_number: fc.option(fc.double({ min: -1e6, max: 1e6, noNaN: true }), { nil: null }),
      unit: fc.string({ maxLength: 8 }),
      served_count: fc.nat({ max: 1000 }),
    });

    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10 }), noiseArb, (raw, noise) => {
        const doc = docWithSurprise(raw);
        Object.assign(doc.data, noise);

        const canonical = toFact(doc).surprise_factor;
        expect(canonical).toBe(CANONICAL_SURPRISE[raw]);
        expect(canonical).toBeGreaterThanOrEqual(0);
        expect(canonical).toBeLessThanOrEqual(3);
        // Determinism: the same document maps the same way every time.
        expect(toFact(doc).surprise_factor).toBe(canonical);
        return true;
      }),
      { numRuns: 150 },
    );
  });

  it("maps an absent or non-numeric surprise_factor to null", () => {
    // Absent: the field is not in the document at all.
    expect(toFact(docWithSurprise(undefined)).surprise_factor).toBeNull();
    expect(toFact({ id: "empty", path: "fact_bank/empty", data: {} }).surprise_factor).toBeNull();

    fc.assert(
      fc.property(nonNumericArb, (raw) => {
        expect(toFact(docWithSurprise(raw)).surprise_factor, JSON.stringify(raw)).toBeNull();
        return true;
      }),
      { numRuns: 120 },
    );
  });

  it("keeps the whole range inside 0-3, including values above and below the legacy band", () => {
    // Totality beyond the property's stated 0-10 domain: a document written by
    // some older or broken producer must still read back inside the canonical
    // band rather than leaking a value the client cannot render.
    fc.assert(
      fc.property(fc.integer({ min: -50, max: 50 }), (raw) => {
        const canonical = toFact(docWithSurprise(raw)).surprise_factor;
        expect(canonical, `surprise_factor ${raw}`).not.toBeNull();
        const value = canonical ?? Number.NaN;
        expect(value, `surprise_factor ${raw}`).toBeGreaterThanOrEqual(0);
        expect(value, `surprise_factor ${raw}`).toBeLessThanOrEqual(3);
        return true;
      }),
      { numRuns: 120 },
    );

    // No store was touched and nothing reached the network.
    expect(firestoreDouble().writeCount()).toBe(0);
    expect(blockedNetworkAttempts()).toEqual([]);
  });
});
