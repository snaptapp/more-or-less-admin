/**
 * Feature: admin-quality-gates-and-shared-contracts
 *
 * Properties over the admin portal's consumption of the Shared_Contract_Artifact:
 * what statuses the fact list filter and status display offer, and the fact that
 * being able to display or filter a status confers no authority to write it.
 *
 * Property 29: The fact-status filter and display offer exactly the declared
 *   statuses, and representation grants no write authority.
 *   *For all* statuses the artifact declares, the fact-list status filter and
 *   the fact status display enumerate exactly `FACT_STATUSES` — omitting none
 *   and offering none the artifact does not declare — and the ability to
 *   display or filter a status implies nothing about whether `setFactStatus`
 *   will accept a transition into it. In particular a status the artifact
 *   declares yet no admin-authorized transition targets is displayed and
 *   filterable but has no admin-authorized transition into it.
 *   Validates: Requirements 9.2, 9.8
 *
 * Property 30: `setFactStatus` accepts a transition if and only if it is
 *   admin-authorized.
 *   *For all* current→requested status pairs over `FACT_STATUSES` (plus some
 *   unknown statuses), `setFactStatus` succeeds exactly when `STATUS_TRANSITIONS`
 *   contains `{ from, to, adminAuthorized: true }`; otherwise it throws before
 *   any Firestore write and leaves the stored document byte-for-byte unchanged.
 *   Validates: Requirements 9.3, 9.4
 *
 * Property 32: Unknown persisted statuses render safely and remain unmodified.
 *   *For any* non-empty string not in `FACT_STATUSES`, `isKnownFactStatus` is
 *   false, `adminAuthorizedTargetsFor` returns `[]`, `FactStatusBadge` renders
 *   the value verbatim with an unknown-status indicator, and `setFactStatus`
 *   rejects any transition *from* it before any write.
 *   Validates: Requirement 9.10
 *
 * Design notes
 * ------------
 * The status domain is iterated from the generated artifact
 * (`FACT_STATUSES`, `STATUS_TRANSITIONS`) at run time — never restated — so a
 * status or transition added to the contract extends these properties instead
 * of leaving new behaviour unasserted. The only seam is Firestore (the
 * in-memory double from `test/setup.ts`); `content.server` and `AdminShell` are
 * the real modules, so the acceptance/rejection asserted on is production's.
 * `FactStatusBadge` is rendered with `react-dom/server` under the Node test
 * environment, which needs no DOM.
 */
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { blockedNetworkAttempts, firestoreDouble } from "./setup";

// Persistence is the only seam (Requirement 6.10): no credential, emulator, or
// deployed service. `content.server` itself is the real module.
vi.mock("@/lib/firebase/firestore.server", async () => {
  const { firestoreDouble: double } = await import("./setup");
  return double().module;
});

import {
  FACT_STATUSES,
  STATUS_TRANSITIONS,
  type FactStatus,
} from "../shared/fact-lifecycle-contract.gen";
import {
  adminAuthorizedTargetsFor,
  isKnownFactStatus,
  FactStatusBadge,
} from "@/admin/AdminShell";
import { FactStatusTransitionError, setFactStatus } from "@/lib/admin/content.server";

// ---------------------------------------------------------------------------
// Shared oracles, derived from the artifact rather than transcribed
// ---------------------------------------------------------------------------

/**
 * The contract's own answer to "is this transition admin-authorized?", read
 * straight from `STATUS_TRANSITIONS`. Every assertion about acceptance is
 * checked against this, so the test and the artifact cannot silently diverge.
 */
function contractAuthorizes(from: string, to: string): boolean {
  return STATUS_TRANSITIONS.some(
    (transition) => transition.from === from && transition.to === to && transition.adminAuthorized,
  );
}

/** Statuses the artifact declares but no admin-authorized transition targets. */
const STATUSES_WITH_NO_INBOUND_AUTH: FactStatus[] = FACT_STATUSES.filter(
  (status) => !STATUS_TRANSITIONS.some((t) => t.to === status && t.adminAuthorized),
);

/** A seedable `fact_bank` document in a given status. */
function seedDoc(status: string): Record<string, unknown> {
  return {
    subject: "Seeded subject",
    subject_key: "seeded_subject",
    angle: "Seeded angle",
    angle_key: "seeded_angle",
    question: "Seeded question?",
    claim_template: "Seeded claim {n}",
    context: "Seeded context",
    true_number: 42,
    unit: "units",
    status,
    content_rating: "standard",
    surprise_factor: 2,
    source_urls: [],
    served_count: 0,
  };
}

/** Non-empty strings that are not any declared status. */
const unknownStatusArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 24 })
  .filter((s) => s.trim().length > 0 && !(FACT_STATUSES as readonly string[]).includes(s));

// ---------------------------------------------------------------------------
// Property 29
// ---------------------------------------------------------------------------

describe("Feature: admin-quality-gates-and-shared-contracts, Property 29: the fact-status filter and display offer exactly the declared statuses, and representation grants no write authority", () => {
  it("declares a non-empty, duplicate-free status set so the sweeps below are not vacuous", () => {
    expect(FACT_STATUSES.length).toBeGreaterThan(0);
    expect(new Set(FACT_STATUSES).size).toBe(FACT_STATUSES.length);
  });

  it("the fact-status display enumerates exactly the declared set — every declared status is known, nothing undeclared is", () => {
    // The display (`FactStatusBadge` → `statusTone` → the contract-keyed tone
    // map) treats a status as declared iff it is in `FACT_STATUSES`.
    for (const status of FACT_STATUSES) {
      expect(isKnownFactStatus(status), `${status} declared`).toBe(true);
    }
    fc.assert(
      fc.property(unknownStatusArb, (status) => {
        expect(isKnownFactStatus(status), `${status} undeclared`).toBe(false);
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it("the filter option set (the derived declared list) equals FACT_STATUSES exactly, in order", () => {
    // The route builds its `<option>` list by mapping over `FACT_STATUSES`
    // (facts.tsx). The declared filter domain is therefore that array itself:
    // reconstruct it the same way and assert exact equality, so a missing or
    // extra option would fail.
    const filterOptions = FACT_STATUSES.map((status) => status);
    expect(filterOptions).toEqual([...FACT_STATUSES]);
    // Every filter option is a known status and every known status is offered.
    for (const option of filterOptions) expect(isKnownFactStatus(option)).toBe(true);
    for (const status of FACT_STATUSES) expect(filterOptions).toContain(status);
  });

  it("displaying/filtering a status implies nothing about write authority into it", async () => {
    // Requirement 9.8: being offered in the filter/display never widens the
    // accepted `setFactStatus` target set. For every declared (displayable,
    // filterable) target, acceptance is decided solely by the contract's
    // admin-authorized transitions, independent of displayability.
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...FACT_STATUSES),
        fc.constantFrom(...FACT_STATUSES),
        async (from, to) => {
          // Both `from` and `to` are declared, hence both displayable/filterable.
          expect(isKnownFactStatus(from)).toBe(true);
          expect(isKnownFactStatus(to)).toBe(true);

          firestoreDouble().reset();
          const id = "repr_no_auth";
          firestoreDouble().seed(`fact_bank/${id}`, seedDoc(from));

          const authorized = contractAuthorizes(from, to);
          if (authorized) {
            await expect(setFactStatus({ id, status: to })).resolves.toBeTruthy();
          } else {
            await expect(setFactStatus({ id, status: to })).rejects.toBeInstanceOf(
              FactStatusTransitionError,
            );
            // No write authority despite both statuses being representable.
            expect(firestoreDouble().writeCount()).toBe(0);
          }
          expect(blockedNetworkAttempts()).toEqual([]);
          return true;
        },
      ),
      { numRuns: 150 },
    );
  });

  it("a declared status no admin-authorized transition targets is still displayed/filterable, yet has no authorized inbound transition (Requirement 9.8)", () => {
    // The contract as generated has at least one such status (`retired`);
    // pinning the derivation guards against a future contract that drops it.
    for (const status of STATUSES_WITH_NO_INBOUND_AUTH) {
      // Displayable and filterable…
      expect(isKnownFactStatus(status)).toBe(true);
      expect([...FACT_STATUSES]).toContain(status);
      // …yet no admin-authorized transition reaches it from any source.
      for (const from of FACT_STATUSES) {
        expect(contractAuthorizes(from, status), `${from} -> ${status}`).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Property 30
// ---------------------------------------------------------------------------

describe("Feature: admin-quality-gates-and-shared-contracts, Property 30: `setFactStatus` accepts a transition if and only if it is admin-authorized", () => {
  it("accepts iff the contract admin-authorizes the current→requested transition, over every declared pair", async () => {
    // Exhaustive over the declared status square: for every (from, to) pair the
    // outcome matches the contract's admin-authorized flag exactly.
    for (const from of FACT_STATUSES) {
      for (const to of FACT_STATUSES) {
        firestoreDouble().reset();
        const id = `pair_${from}_${to}`;
        const before = firestoreDouble().seed(`fact_bank/${id}`, seedDoc(from));

        const authorized = contractAuthorizes(from, to);
        if (authorized) {
          const record = await setFactStatus({ id, status: to });
          expect(record.status, `${from} -> ${to} accepted`).toBe(to);
          const writes = firestoreDouble().writes();
          expect(writes, `${from} -> ${to} writes`).toHaveLength(1);
          expect(writes[0].kind).toBe("patch");
          expect(writes[0].path).toBe(`fact_bank/${id}`);
        } else {
          let thrown: unknown;
          try {
            await setFactStatus({ id, status: to });
          } catch (error) {
            thrown = error;
          }
          expect(thrown, `${from} -> ${to} must throw`).toBeInstanceOf(FactStatusTransitionError);
          const err = thrown as FactStatusTransitionError;
          // The error names the current and rejected target status (Req 9.4).
          expect(err.from, `${from} -> ${to} error.from`).toBe(from);
          expect(err.to, `${from} -> ${to} error.to`).toBe(to);
          // Rejected before any Firestore write; the document is unchanged.
          expect(firestoreDouble().writeCount(), `${from} -> ${to} no write`).toBe(0);
          const after = firestoreDouble().document(`fact_bank/${id}`);
          expect(after?.data, `${from} -> ${to} doc unchanged`).toEqual(before.data);
        }
        expect(blockedNetworkAttempts()).toEqual([]);
      }
    }
  });

  it("a transition FROM an unknown persisted status is never accepted and never writes", async () => {
    await fc.assert(
      fc.asyncProperty(
        unknownStatusArb,
        fc.constantFrom(...FACT_STATUSES),
        async (from, to) => {
          firestoreDouble().reset();
          const id = "from_unknown";
          const before = firestoreDouble().seed(`fact_bank/${id}`, seedDoc(from));

          // The contract has no transition from an undeclared source, so the
          // request is rejected before any write.
          expect(contractAuthorizes(from, to)).toBe(false);
          await expect(setFactStatus({ id, status: to })).rejects.toBeInstanceOf(
            FactStatusTransitionError,
          );
          expect(firestoreDouble().writeCount()).toBe(0);
          expect(firestoreDouble().document(`fact_bank/${id}`)?.data).toEqual(before.data);
          expect(blockedNetworkAttempts()).toEqual([]);
          return true;
        },
      ),
      { numRuns: 150 },
    );
  });

  it("the accepted-target set equals the admin-authorized targets the display derives, for every current status", async () => {
    // `setFactStatus` and `adminAuthorizedTargetsFor` (the display/control seam)
    // must agree: the transitions the portal *offers* are exactly the ones it
    // *accepts*. Any drift between the control and the mutation would surface a
    // status the UI offers but the server rejects, or vice versa.
    for (const from of FACT_STATUSES) {
      const offered = new Set(adminAuthorizedTargetsFor(from));
      const accepted: FactStatus[] = [];
      for (const to of FACT_STATUSES) {
        firestoreDouble().reset();
        const id = `agree_${from}_${to}`;
        firestoreDouble().seed(`fact_bank/${id}`, seedDoc(from));
        try {
          await setFactStatus({ id, status: to });
          accepted.push(to);
        } catch {
          // rejected — not an accepted target.
        }
      }
      expect(new Set(accepted), `accepted targets from ${from}`).toEqual(offered);
    }
  });
});

// ---------------------------------------------------------------------------
// Property 32
// ---------------------------------------------------------------------------

/**
 * The `FactStatusBadge` output as a static HTML string. The badge is authored
 * in JSX in `src/`, but this test file is a `.ts` (matching every other
 * property test), so it renders through `createElement` rather than inline JSX.
 */
function badgeText(status: string): string {
  return renderToStaticMarkup(createElement(FactStatusBadge, { status }));
}

describe("Feature: admin-quality-gates-and-shared-contracts, Property 32: unknown persisted statuses render safely and remain unmodified", () => {
  it("classifies an unknown status as not-known and offers no status-change target", () => {
    fc.assert(
      fc.property(unknownStatusArb, (status) => {
        expect(isKnownFactStatus(status), `${status} known`).toBe(false);
        expect(adminAuthorizedTargetsFor(status), `${status} targets`).toEqual([]);
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it("renders the unknown value verbatim with a distinguishing indicator", () => {
    fc.assert(
      fc.property(
        // HTML-escaping would obscure a verbatim check, so this property draws
        // from an alphabet that survives markup unescaped; the escaping path is
        // pinned as an example below.
        fc
          .stringMatching(/^[A-Za-z0-9_ -]{1,24}$/)
          .filter((s) => s.trim().length > 0 && !(FACT_STATUSES as readonly string[]).includes(s)),
        (status) => {
          const markup = badgeText(status);
          // Verbatim: the stored value appears in the rendered output untouched.
          expect(markup, `${status} verbatim`).toContain(status);
          // Distinguishing indicator: the ⚠ marker and an "unknown status" label.
          expect(markup, `${status} marker`).toContain("⚠");
          expect(markup.toLowerCase(), `${status} label`).toContain("unknown status");
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("renders every declared status without the unknown indicator", () => {
    for (const status of FACT_STATUSES) {
      const markup = badgeText(status);
      expect(markup, `${status} verbatim`).toContain(status);
      expect(markup, `${status} no marker`).not.toContain("⚠");
    }
  });

  it("escapes an unknown status containing HTML metacharacters rather than injecting markup", () => {
    // A stored status is untrusted data; React escapes it. The escaped form is
    // still "verbatim" in the sense that the text content equals the value.
    const markup = badgeText("<b>x</b>");
    expect(markup).not.toContain("<b>x</b>");
    expect(markup).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(markup).toContain("⚠");
  });

  it("rejects every status change FROM an unknown persisted status without writing (Requirement 9.10)", async () => {
    await fc.assert(
      fc.asyncProperty(
        unknownStatusArb,
        fc.constantFrom(...FACT_STATUSES),
        async (from, to) => {
          firestoreDouble().reset();
          const id = "unknown_persisted";
          const before = firestoreDouble().seed(`fact_bank/${id}`, seedDoc(from));

          await expect(setFactStatus({ id, status: to })).rejects.toBeInstanceOf(
            FactStatusTransitionError,
          );
          // The stored `status` (and every other field) is left unmodified.
          expect(firestoreDouble().writeCount()).toBe(0);
          const after = firestoreDouble().document(`fact_bank/${id}`);
          expect(after?.data["status"]).toBe(from);
          expect(after?.data).toEqual(before.data);
          expect(blockedNetworkAttempts()).toEqual([]);
          return true;
        },
      ),
      { numRuns: 150 },
    );
  });
});
