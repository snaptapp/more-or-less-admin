/**
 * Feature: admin-quality-gates-and-shared-contracts
 *
 * Property 5: `isEmailAllowlisted` accepts every supported entry form
 *   *For any* allowlist entry in a supported form (bare domain, bare domain
 *   matched by a subdomain address, leading-`@` suffix, or full email address)
 *   and any email address that matches that form, `isEmailAllowlisted` returns
 *   `true`.
 *   Validates: Requirements 5.2
 *
 * Property 6: `isEmailAllowlisted` rejects non-matches and nullish/whitespace input
 *   *For any* email address whose domain is absent from the allowlist, whose
 *   domain merely ends with a bare-domain entry's characters without a `@` or
 *   `.` boundary, or whose local part differs from a full-email entry sharing
 *   its domain, and *for any* `null`, `undefined`, or whitespace-only email or
 *   allowlist, `isEmailAllowlisted` returns `false`.
 *   Validates: Requirements 5.3, 5.4
 *
 * Property 7: `isEmailAllowlisted` is case-insensitive and whitespace-invariant
 *   *For any* matching (address, entry) pair, `isEmailAllowlisted` returns an
 *   identical result across the all-lowercase, all-uppercase, and mixed-case
 *   variants of both the address and the entry, and adding leading or trailing
 *   whitespace to an otherwise-matching address or entry does not change the
 *   result.
 *   Validates: Requirements 5.4, 5.5
 *
 * What is under test
 * ------------------
 * `isEmailAllowlisted(email, list)` from `src/lib/firebase/verify.server.ts` —
 * the email half of the Authorization_Boundary. It is a pure function that
 * takes the allowlist as a parameter, so these tests need no environment
 * variable, no request context, and no `vi.mock`: the module is imported for
 * real. (`verify.server.ts` imports `@tanstack/react-start/server` and
 * `./credentials.server`, and neither performs work at import time, so the
 * import is clean under the `node` test environment. The `fetch` guard in
 * `test/setup.ts` stays armed throughout — nothing here goes near the network.)
 *
 * The four matching rules the implementation actually applies, in order:
 *   1. `!email || list.length === 0`            → false
 *   2. entry starting with `@`                   → `address.endsWith(entry)`
 *   3. entry containing `@` elsewhere            → `address === entry`
 *   4. bare entry (no `@`)                       → `address.endsWith("@" + entry)`
 *                                                  `|| address.endsWith("." + entry)`
 * Both the address and each entry are `trim().toLowerCase()`d first, and a
 * blank entry is skipped rather than treated as a wildcard.
 *
 * Generator strategy
 * ------------------
 * Every case is *constructed* to match or not match rather than generated and
 * then classified against a reimplementation of the rules — a second copy of
 * the matching logic in the test would pass even if both copies were wrong.
 * The non-matching constructions are the interesting ones:
 *
 *   - "domain absent": bare entries filtered so the address domain neither
 *     equals an entry nor is a dot-separated subdomain of one.
 *   - "no boundary": the address domain is `<alphanumeric prefix><entry>`, so
 *     the entry's characters appear at the end of the address with a letter or
 *     digit — not `@` or `.` — in front of them. This is the substring-vs-domain
 *     confusion that would let `evil-snaptapp.us` in.
 *   - "local part differs": a full-address entry, same domain, different local
 *     part, which rule 3 must reject by equality.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { isEmailAllowlisted } from "@/lib/firebase/verify.server";

/** Every property runs well above the 100-iteration floor. */
const NUM_RUNS = 200;

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

const LABEL_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789".split("");

/** A single DNS-style label: non-empty, alphanumeric, no dots. */
const labelArb = (maxLength: number): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...LABEL_CHARS), { minLength: 1, maxLength })
    .map((chars) => chars.join(""));

/** A registrable domain such as `acme.com` or `ops.acme.dev`. */
const domainArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.array(labelArb(6), { minLength: 1, maxLength: 2 }),
    fc.constantFrom("com", "us", "io", "dev", "app"),
  )
  .map(([labels, tld]) => [...labels, tld].join("."));

/** A local part such as `dana` or `dana.ops` — never leading/trailing dot. */
const localArb: fc.Arbitrary<string> = fc
  .tuple(labelArb(8), fc.option(labelArb(6), { nil: null }))
  .map(([head, tail]) => (tail === null ? head : `${head}.${tail}`));

/** A whitespace-only string (what `trim()` reduces to nothing). */
const blankArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(" ", "\t", "\n", "\r"), { minLength: 1, maxLength: 4 })
  .map((chars) => chars.join(""));

/**
 * Entries the implementation must skip rather than honour: empty strings and
 * whitespace-only strings. Safe to sprinkle into any list — they can neither
 * create nor suppress a match.
 */
const skippedEntriesArb: fc.Arbitrary<string[]> = fc.array(
  fc.oneof(fc.constant(""), blankArb),
  { maxLength: 3 },
);

// ---------------------------------------------------------------------------
// Matching pairs — one per supported entry form (Requirement 5.2)
// ---------------------------------------------------------------------------

type EntryForm =
  | "bare-domain-equal"
  | "bare-domain-subdomain"
  | "at-prefixed-suffix"
  | "full-address";

interface MatchPair {
  readonly form: EntryForm;
  readonly email: string;
  readonly entry: string;
}

/** Bare domain entry, address whose domain equals it. */
const bareDomainEqualArb: fc.Arbitrary<MatchPair> = fc
  .tuple(localArb, domainArb)
  .map(([local, domain]) => ({
    form: "bare-domain-equal" as const,
    email: `${local}@${domain}`,
    entry: domain,
  }));

/** Bare domain entry, address whose domain is a dot-separated subdomain of it. */
const bareDomainSubdomainArb: fc.Arbitrary<MatchPair> = fc
  .tuple(localArb, fc.array(labelArb(5), { minLength: 1, maxLength: 2 }), domainArb)
  .map(([local, subLabels, domain]) => ({
    form: "bare-domain-subdomain" as const,
    email: `${local}@${subLabels.join(".")}.${domain}`,
    entry: domain,
  }));

/** Entry with a leading `@`, address ending in it. */
const atPrefixedArb: fc.Arbitrary<MatchPair> = fc
  .tuple(localArb, domainArb)
  .map(([local, domain]) => ({
    form: "at-prefixed-suffix" as const,
    email: `${local}@${domain}`,
    entry: `@${domain}`,
  }));

/** Full email address entry, matched by an equal address. */
const fullAddressArb: fc.Arbitrary<MatchPair> = fc
  .tuple(localArb, domainArb)
  .map(([local, domain]) => ({
    form: "full-address" as const,
    email: `${local}@${domain}`,
    entry: `${local}@${domain}`,
  }));

const matchPairArb: fc.Arbitrary<MatchPair> = fc.oneof(
  bareDomainEqualArb,
  bareDomainSubdomainArb,
  atPrefixedArb,
  fullAddressArb,
);

// ---------------------------------------------------------------------------
// Non-matching pairs (Requirement 5.3)
// ---------------------------------------------------------------------------

type NonMatchKind = "domain-absent" | "no-boundary" | "local-part-differs";

interface NonMatchCase {
  readonly kind: NonMatchKind;
  readonly email: string;
  /** Entries that must all fail to match `email`. */
  readonly entries: string[];
}

/** The address domain is absent from a list of bare-domain entries. */
const domainAbsentArb: fc.Arbitrary<NonMatchCase> = fc
  .tuple(localArb, domainArb, fc.array(domainArb, { minLength: 1, maxLength: 3 }))
  .filter(([, domain, entries]) =>
    entries.every((entry) => domain !== entry && !domain.endsWith(`.${entry}`)),
  )
  .map(([local, domain, entries]) => ({
    kind: "domain-absent" as const,
    email: `${local}@${domain}`,
    entries,
  }));

/**
 * The address domain ends with a bare entry's characters, but with an
 * alphanumeric character in front of them instead of a `@` or `.` boundary.
 */
const noBoundaryArb: fc.Arbitrary<NonMatchCase> = fc
  .tuple(localArb, labelArb(6), domainArb)
  .map(([local, prefix, domain]) => ({
    kind: "no-boundary" as const,
    email: `${local}@${prefix}${domain}`,
    entries: [domain],
  }));

/** A full-address entry sharing the domain, but with a different local part. */
const localPartDiffersArb: fc.Arbitrary<NonMatchCase> = fc
  .tuple(localArb, localArb, domainArb)
  .filter(([listed, supplied]) => listed.toLowerCase() !== supplied.toLowerCase())
  .map(([listed, supplied, domain]) => ({
    kind: "local-part-differs" as const,
    email: `${supplied}@${domain}`,
    entries: [`${listed}@${domain}`],
  }));

const nonMatchCaseArb: fc.Arbitrary<NonMatchCase> = fc.oneof(
  domainAbsentArb,
  noBoundaryArb,
  localPartDiffersArb,
);

/** A single-entry view of a non-match, for the invariance property. */
const nonMatchPairArb: fc.Arbitrary<{ email: string; entry: string }> = nonMatchCaseArb.map(
  (nonMatch) => ({ email: nonMatch.email, entry: nonMatch.entries[0]! }),
);

// ---------------------------------------------------------------------------
// Case and whitespace variants (Requirements 5.4, 5.5)
// ---------------------------------------------------------------------------

/** Uppercases the positions the mask marks, lowercases the rest. */
function mixedCase(value: string, mask: readonly boolean[]): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]!;
    out += mask[i % mask.length] ? char.toUpperCase() : char.toLowerCase();
  }
  return out;
}

/**
 * Exactly the three letter-case variants Requirement 5.5 enumerates:
 * all-lowercase, all-uppercase, mixed-case.
 */
function caseVariants(value: string, mask: readonly boolean[]): string[] {
  return [value.toLowerCase(), value.toUpperCase(), mixedCase(value, mask)];
}

/** Every case variant, each also with leading, trailing, and both-side padding. */
function caseAndWhitespaceVariants(
  value: string,
  mask: readonly boolean[],
  left: string,
  right: string,
): string[] {
  return caseVariants(value, mask).flatMap((variant) => [
    variant,
    `${left}${variant}`,
    `${variant}${right}`,
    `${left}${variant}${right}`,
  ]);
}

const caseMaskArb: fc.Arbitrary<boolean[]> = fc.array(fc.boolean(), {
  minLength: 1,
  maxLength: 6,
});

// ---------------------------------------------------------------------------
// Property 5
// ---------------------------------------------------------------------------

describe("Property 5: isEmailAllowlisted accepts every supported entry form", () => {
  it("returns true for a matching address in every entry form, at any list position", () => {
    fc.assert(
      fc.property(
        matchPairArb,
        skippedEntriesArb,
        fc.nat(),
        (pair, skipped, rawIndex) => {
          // The entry alone matches...
          expect(isEmailAllowlisted(pair.email, [pair.entry])).toBe(true);

          // ...and still matches wherever it sits among skipped entries.
          const list = [...skipped];
          list.splice(rawIndex % (list.length + 1), 0, pair.entry);
          expect(isEmailAllowlisted(pair.email, list)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("covers each enumerated entry form with a concrete example", () => {
    // bare domain, domain equal
    expect(isEmailAllowlisted("dana@snaptapp.us", ["snaptapp.us"])).toBe(true);
    // bare domain, address on a dot-separated subdomain
    expect(isEmailAllowlisted("dana@ops.snaptapp.us", ["snaptapp.us"])).toBe(true);
    // entry with a leading '@'
    expect(isEmailAllowlisted("dana@snaptapp.us", ["@snaptapp.us"])).toBe(true);
    // full email address entry
    expect(isEmailAllowlisted("dana@snaptapp.us", ["dana@snaptapp.us"])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Property 6
// ---------------------------------------------------------------------------

describe("Property 6: isEmailAllowlisted rejects non-matches and nullish/whitespace input", () => {
  it("returns false for every constructed non-match", () => {
    fc.assert(
      fc.property(nonMatchCaseArb, skippedEntriesArb, (nonMatch, skipped) => {
        expect(isEmailAllowlisted(nonMatch.email, [...nonMatch.entries, ...skipped])).toBe(
          false,
        );
        expect(isEmailAllowlisted(nonMatch.email, [...skipped, ...nonMatch.entries])).toBe(
          false,
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("returns false for null, undefined, empty, and whitespace-only addresses", () => {
    const nullishEmailArb = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.constant(""),
      blankArb,
    );
    const anyListArb = fc.array(
      fc.oneof(fc.string({ maxLength: 16 }), domainArb, matchPairArb.map((p) => p.entry)),
      { maxLength: 4 },
    );

    fc.assert(
      fc.property(nullishEmailArb, anyListArb, (email, list) => {
        expect(isEmailAllowlisted(email, list)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("returns false for every address when the allowlist is empty or entirely blank", () => {
    const anyEmailArb = fc.oneof(
      matchPairArb.map((pair) => pair.email),
      fc.string({ maxLength: 24 }),
      fc.constant(null),
      fc.constant(undefined),
    );
    const uselessListArb = fc.oneof(
      fc.constant<string[]>([]),
      fc.array(fc.oneof(fc.constant(""), blankArb), { minLength: 1, maxLength: 4 }),
    );

    fc.assert(
      fc.property(anyEmailArb, uselessListArb, (email, list) => {
        expect(isEmailAllowlisted(email, list)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("covers each enumerated rejection with a concrete example", () => {
    // domain absent from the allowlist
    expect(isEmailAllowlisted("dana@example.com", ["snaptapp.us"])).toBe(false);
    // domain ends with the entry's characters without a '@' or '.' boundary
    expect(isEmailAllowlisted("dana@evilsnaptapp.us", ["snaptapp.us"])).toBe(false);
    // full-address entry, differing local part
    expect(isEmailAllowlisted("mallory@snaptapp.us", ["dana@snaptapp.us"])).toBe(false);
    // nullish and whitespace-only addresses
    expect(isEmailAllowlisted(null, ["snaptapp.us"])).toBe(false);
    expect(isEmailAllowlisted(undefined, ["snaptapp.us"])).toBe(false);
    expect(isEmailAllowlisted("   \t ", ["snaptapp.us"])).toBe(false);
    // empty and entirely blank allowlists
    expect(isEmailAllowlisted("dana@snaptapp.us", [])).toBe(false);
    expect(isEmailAllowlisted("dana@snaptapp.us", ["", "  ", "\t"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Property 7
// ---------------------------------------------------------------------------

describe("Property 7: isEmailAllowlisted is case-insensitive and whitespace-invariant", () => {
  const invariantPairArb = fc.oneof(
    matchPairArb.map((pair) => ({ email: pair.email, entry: pair.entry, expected: true })),
    nonMatchPairArb.map((pair) => ({ email: pair.email, entry: pair.entry, expected: false })),
  );

  it("returns an identical result across every case and whitespace variant of both sides", () => {
    fc.assert(
      fc.property(
        invariantPairArb,
        caseMaskArb,
        caseMaskArb,
        blankArb,
        blankArb,
        (pair, emailMask, entryMask, left, right) => {
          const baseline = isEmailAllowlisted(pair.email, [pair.entry]);
          expect(baseline).toBe(pair.expected);

          const emails = caseAndWhitespaceVariants(pair.email, emailMask, left, right);
          const entries = caseAndWhitespaceVariants(pair.entry, entryMask, left, right);

          // All three letter-case variants are present on each side, so the
          // >= 3 variants Requirement 5.5 asks for are exercised every run.
          expect(emails.length).toBeGreaterThanOrEqual(3);
          expect(entries.length).toBeGreaterThanOrEqual(3);

          for (const email of emails) {
            for (const entry of entries) {
              expect(isEmailAllowlisted(email, [entry])).toBe(baseline);
            }
          }
        },
      ),
      { numRuns: 120 },
    );
  });

  it("covers case and whitespace invariance with concrete examples", () => {
    for (const email of ["dana@snaptapp.us", "DANA@SNAPTAPP.US", "Dana@SnapTapp.Us"]) {
      for (const entry of ["snaptapp.us", "SNAPTAPP.US", "SnapTapp.Us"]) {
        expect(isEmailAllowlisted(email, [entry])).toBe(true);
      }
    }
    expect(isEmailAllowlisted("  dana@snaptapp.us  ", ["snaptapp.us"])).toBe(true);
    expect(isEmailAllowlisted("dana@snaptapp.us", ["\tsnaptapp.us\n"])).toBe(true);
    expect(isEmailAllowlisted("  MALLORY@EXAMPLE.COM ", ["  SnapTapp.Us  "])).toBe(false);
  });
});
