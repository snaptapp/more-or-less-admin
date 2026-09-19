/**
 * Feature: admin-quality-gates-and-shared-contracts
 *
 * Property 8: `requireAdmin` rejects every malformed or invalid token
 *   *For any* token exhibiting exactly one of the rejection conditions — absent
 *   authorization header, missing `Bearer` prefix, fewer than 3 segments, `alg`
 *   other than `RS256`, missing `kid`, unknown `kid`, failed signature,
 *   audience ≠ project id, issuer ≠ the Google securetoken issuer for that
 *   project, absent `exp`, `exp` earlier than now, or absent `sub` —
 *   `requireAdmin` raises an `AuthError` with status 401 and returns no
 *   `AdminUser`.
 *   Validates: Requirements 5.6, 5.11
 *
 * Property 9: `requireAdmin` authorization biconditional
 *   *For any* token bearing a valid signature, matching audience, matching
 *   issuer, and an `exp` at or after the current second, `requireAdmin` returns
 *   an `AdminUser` **if and only if** the token's `admin` claim equals boolean
 *   `true` **or** its email claim is matched by `isEmailAllowlisted` against the
 *   configured allowlist; when it returns an `AdminUser`, `uid` equals `sub`,
 *   `email` preserves the token's letter case, `name` equals the token `name`
 *   claim or `null`, and `isClaimAdmin` equals whether the `admin` claim was
 *   boolean `true`; otherwise it raises and returns no `AdminUser` (including
 *   for a truthy-but-not-`true` admin claim, a missing email claim, and an empty
 *   allowlist).
 *   Validates: Requirements 5.7, 5.8, 5.10
 *
 * Property 10: `requireAdmin` results are independent of execution order and
 *   issue no network request
 *   *For any* ordering of a set of `requireAdmin` test cases sharing an injected
 *   key source, each case produces the same result it would produce in
 *   isolation (key material retained by a preceding case cannot change a later
 *   one), and a full run issues zero requests to the signing-key endpoint or any
 *   other network endpoint.
 *   Validates: Requirements 5.9, 6.10, 6.14
 *
 * How the boundary is exercised
 * -----------------------------
 * `requireAdmin` is called through the two seams task 5.2 added, so the real
 * implementation runs end to end with no request context and no network:
 *
 *   - `getHeader: headerSourceFromRecord({ authorization })` supplies the
 *     bearer header (or omits it) instead of an ambient request.
 *   - `fetchJwks: <double>` publishes the JWKS document. Every key it publishes
 *     is a *locally minted* RSA key pair (WebCrypto `generateKey`), and every
 *     token is signed with the matching private key, so signature verification
 *     is genuine RS256 rather than stubbed.
 *
 * `getServiceAccount()` is fed a synthesized service-account JSON with a fake
 * project id (its `private_key` is never used — token signing uses the locally
 * minted pair), so `aud` / `iss` checks are deterministic without a credential.
 *
 * Cost note: RSA key generation is slow, so exactly two key pairs are minted at
 * module scope — the primary signer, plus a second one Property 10 uses to prove
 * that retained key material cannot leak between cases. No iteration generates a
 * key pair.
 *
 * Clock: `Date` is faked (`toFake: ["Date"]`, so `setTimeout` and the async
 * plumbing WebCrypto relies on stay real). That makes `exp` exactly equal to the
 * current second reachable without a race — Requirement 5.7 requires that token
 * to be ACCEPTED.
 *
 * Scope: task 5.5 owns the Requirement 5.11 example tests for an unavailable
 * signing-key source and for a segment that does not decode to valid JSON
 * (`test/requireadmin-failclosed.test.ts`); this file keeps to the token matrix.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import {
  AuthError,
  headerSourceFromRecord,
  isEmailAllowlisted,
  requireAdmin,
  resetJwksCache,
  type AdminUser,
  type Jwk,
  type JwksFetcher,
} from "@/lib/firebase/verify.server";

import { blockedNetworkAttempts } from "./setup";

// ---------------------------------------------------------------------------
// Deterministic service account (never a real credential)
// ---------------------------------------------------------------------------

const PROJECT_ID = "more-or-less-property-test";
const ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;

/**
 * `getServiceAccount()` caches on first call, so the value is installed at
 * module scope — before any test can trigger the read. `private_key` is
 * structurally valid but inert: nothing in `requireAdmin` signs with it.
 */
process.env["FIREBASE_SERVICE_ACCOUNT_JSON"] = JSON.stringify({
  project_id: PROJECT_ID,
  client_email: `ops-tests@${PROJECT_ID}.iam.gserviceaccount.com`,
  private_key: "-----BEGIN PRIVATE KEY-----\\nnot-a-real-key\\n-----END PRIVATE KEY-----\\n",
});

/** Frozen wall clock. `exp === NOW_SECONDS` is the "expires this second" case. */
const FIXED_NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);
const NOW_SECONDS = Math.floor(FIXED_NOW_MS / 1000);

// ---------------------------------------------------------------------------
// base64url + local RSA signing
// ---------------------------------------------------------------------------

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function utf8ToBase64Url(text: string): string {
  return bytesToBase64Url(new TextEncoder().encode(text));
}

interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  /** The published form, exactly as it would appear in the JWKS document. */
  jwk: Jwk;
}

async function mintSigningKey(kid: string): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (!exported.kty || !exported.n || !exported.e) {
    throw new Error("exported public JWK is missing kty/n/e");
  }
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: { kid, kty: exported.kty, n: exported.n, e: exported.e, alg: "RS256" },
  };
}

// Two key pairs for the whole file (see the cost note in the header).
const PRIMARY_KEY = await mintSigningKey("primary-signing-key");
const SECONDARY_KEY = await mintSigningKey("secondary-signing-key");

type JwtHeader = Record<string, unknown>;
type JwtClaims = Record<string, unknown>;

interface MintedToken {
  headerSegment: string;
  payloadSegment: string;
  signatureSegment: string;
  signatureBytes: Uint8Array;
  token: string;
}

/** Sign `header.payload` with the locally minted private key (real RS256). */
async function mintToken(
  key: SigningKey,
  header: JwtHeader,
  claims: JwtClaims,
): Promise<MintedToken> {
  const headerSegment = utf8ToBase64Url(JSON.stringify(header));
  const payloadSegment = utf8ToBase64Url(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key.privateKey,
    new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
  );
  const signatureBytes = new Uint8Array(signature);
  const signatureSegment = bytesToBase64Url(signatureBytes);
  return {
    headerSegment,
    payloadSegment,
    signatureSegment,
    signatureBytes,
    token: `${headerSegment}.${payloadSegment}.${signatureSegment}`,
  };
}

/** A JWT header the implementation accepts: RS256 plus the published `kid`. */
function validHeader(key: SigningKey): JwtHeader {
  return { alg: "RS256", typ: "JWT", kid: key.kid };
}

/** Drop absent claims rather than emitting `undefined` (JSON would omit them). */
function claimsFrom(entries: Record<string, unknown>): JwtClaims {
  const claims: JwtClaims = {};
  for (const [name, value] of Object.entries(entries)) {
    if (value !== undefined) claims[name] = value;
  }
  return claims;
}

// ---------------------------------------------------------------------------
// Invocation harness
// ---------------------------------------------------------------------------

/** How many times an injected JWKS double was asked for keys (never `fetch`). */
let jwksFetchCalls = 0;

function jwksDouble(keys: readonly Jwk[]): JwksFetcher {
  return async () => {
    jwksFetchCalls += 1;
    return { ok: true, json: async () => ({ keys: keys.map((key) => ({ ...key })) }) };
  };
}

interface Invocation {
  /** Omitted entirely when `undefined` — the "absent header" condition. */
  authorization?: string | undefined;
  keys: readonly Jwk[];
}

function invokeRequireAdmin(invocation: Invocation): Promise<AdminUser> {
  const headers: Record<string, string | undefined> = {};
  if (invocation.authorization !== undefined) {
    headers["authorization"] = invocation.authorization;
  }
  return requireAdmin({
    getHeader: headerSourceFromRecord(headers),
    fetchJwks: jwksDouble(invocation.keys),
  });
}

type Outcome =
  | { kind: "user"; user: AdminUser }
  | { kind: "error"; isAuthError: boolean; status: number | null; message: string };

async function captureOutcome(run: () => Promise<AdminUser>): Promise<Outcome> {
  try {
    return { kind: "user", user: await run() };
  } catch (error) {
    return {
      kind: "error",
      isAuthError: error instanceof AuthError,
      status: error instanceof AuthError ? error.status : null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Lowercase hex strings. fast-check 4 removed `fc.hexaString`, and hex is the
 * right shape here anyway: `sub` and `kid` values must survive the
 * JSON → UTF-8 → base64url → decode round trip byte for byte (a lone surrogate
 * would not, and that is not what these properties are about).
 */
const HEX_UNIT = fc.constantFrom(..."0123456789abcdef".split(""));

function hexString(minLength: number, maxLength: number): fc.Arbitrary<string> {
  return fc.string({ unit: HEX_UNIT, minLength, maxLength });
}

/**
 * Mirror of the module-private `allowlist()` reader in `verify.server.ts`:
 * `ADMIN_EMAIL_ALLOWLIST` split on commas/whitespace, trimmed, lowercased, with
 * empties dropped. Property 9 needs it to compute the expected verdict.
 */
function parseAllowlist(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const ORIGINAL_ALLOWLIST = process.env["ADMIN_EMAIL_ALLOWLIST"];

beforeAll(() => {
  process.env["ADMIN_EMAIL_ALLOWLIST"] = "";
});

afterAll(() => {
  if (ORIGINAL_ALLOWLIST === undefined) delete process.env["ADMIN_EMAIL_ALLOWLIST"];
  else process.env["ADMIN_EMAIL_ALLOWLIST"] = ORIGINAL_ALLOWLIST;
});

beforeEach(() => {
  // Only `Date` is faked: WebCrypto and Vitest's own timeout handling need real
  // timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW_MS);
  // Requirement 5.9: key material cached by a preceding case cannot reach this
  // one.
  resetJwksCache();
  jwksFetchCalls = 0;
  process.env["ADMIN_EMAIL_ALLOWLIST"] = "";
});

afterEach(() => {
  resetJwksCache();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Property 8 — the rejection matrix
// ---------------------------------------------------------------------------

/** The Requirement 5.6 conditions, plus one extra form of signature failure. */
const REJECTION_KINDS = [
  "absent-authorization-header",
  "authorization-without-bearer-prefix",
  "fewer-than-three-segments",
  "algorithm-other-than-rs256",
  "header-without-kid",
  "kid-matching-no-published-key",
  "invalid-signature",
  "payload-tampered-after-signing",
  "audience-mismatch",
  "issuer-mismatch",
  "absent-exp",
  "exp-earlier-than-now",
  "absent-sub",
] as const;

type RejectionKind = (typeof REJECTION_KINDS)[number];

/**
 * The domain the Property 8 allowlist accepts. Every base token carries an
 * address in this domain *and* `admin: true`, so the token would be accepted if
 * the injected defect were not the reason for rejection — see the control test.
 */
const REJECTION_ALLOWLIST = "property8.test";

interface RejectionSample {
  kind: RejectionKind;
  subject: string;
  emailLocal: string;
  nonBearerVariant:
  | "empty"
  | "whitespace"
  | "bare-token"
  | "lowercase-scheme"
  | "uppercase-scheme"
  | "no-space"
  | "basic-scheme"
  | "scheme-only"
  | "scheme-and-space";
  segmentVariant: "header-only" | "header-and-payload" | "empty-payload" | "empty-signature";
  wrongAlgorithm: string;
  unpublishedKid: string;
  wrongAudience: string;
  wrongIssuer: string;
  expiredBySeconds: number;
}

const rejectionSampleArb: fc.Arbitrary<RejectionSample> = fc.record({
  kind: fc.constantFrom(...REJECTION_KINDS),
  // Hexadecimal so the JSON → UTF-8 → base64url → decode round trip is exact
  // (a lone surrogate would not survive it, and that is not what is under test).
  subject: hexString(1, 28),
  emailLocal: fc.constantFrom("ops", "admin", "ops.tester", "Ops.Tester", "a"),
  nonBearerVariant: fc.constantFrom(
    "empty",
    "whitespace",
    "bare-token",
    "lowercase-scheme",
    "uppercase-scheme",
    "no-space",
    "basic-scheme",
    "scheme-only",
    "scheme-and-space",
  ),
  segmentVariant: fc.constantFrom(
    "header-only",
    "header-and-payload",
    "empty-payload",
    "empty-signature",
  ),
  wrongAlgorithm: fc.constantFrom("HS256", "RS512", "PS256", "ES256", "none", "rs256", "RS256 "),
  unpublishedKid: fc
    .oneof(
      fc.constantFrom("", "unknown-kid", "PRIMARY-SIGNING-KEY", "primary-signing-key "),
      hexString(1, 16),
    )
    .filter((kid) => kid !== PRIMARY_KEY.kid && kid !== SECONDARY_KEY.kid),
  wrongAudience: fc
    .oneof(
      fc.constantFrom("", "more-or-less-505908", "other-project", `${PROJECT_ID}-staging`),
      hexString(1, 20),
    )
    .filter((audience) => audience !== PROJECT_ID),
  wrongIssuer: fc
    .oneof(
      fc.constantFrom(
        "",
        "https://securetoken.google.com/other-project",
        "https://accounts.google.com",
        `${ISSUER}/`,
        `http://securetoken.google.com/${PROJECT_ID}`,
      ),
      hexString(1, 20),
    )
    .filter((issuer) => issuer !== ISSUER),
  expiredBySeconds: fc.integer({ min: 1, max: 30 * 24 * 3600 }),
});

/** Base claims that satisfy every check, before one is broken. */
function rejectionBaseClaims(sample: RejectionSample): JwtClaims {
  return claimsFrom({
    sub: sample.subject,
    aud: PROJECT_ID,
    iss: ISSUER,
    exp: NOW_SECONDS + 3600,
    email: `${sample.emailLocal}@${REJECTION_ALLOWLIST}`,
    name: "Ops Tester",
    admin: true,
  });
}

function nonBearerAuthorization(sample: RejectionSample, token: string): string {
  switch (sample.nonBearerVariant) {
    case "empty":
      return "";
    case "whitespace":
      return "   ";
    case "bare-token":
      return token;
    case "lowercase-scheme":
      return `bearer ${token}`;
    case "uppercase-scheme":
      return `BEARER ${token}`;
    case "no-space":
      return `Bearer${token}`;
    case "basic-scheme":
      return `Basic ${token}`;
    case "scheme-only":
      return "Bearer";
    case "scheme-and-space":
      // Well-formed prefix, empty token.
      return "Bearer ";
  }
}

function truncatedToken(sample: RejectionSample, minted: MintedToken): string {
  switch (sample.segmentVariant) {
    case "header-only":
      return minted.headerSegment;
    case "header-and-payload":
      return `${minted.headerSegment}.${minted.payloadSegment}`;
    case "empty-payload":
      return `${minted.headerSegment}..${minted.signatureSegment}`;
    case "empty-signature":
      return `${minted.headerSegment}.${minted.payloadSegment}.`;
  }
}

/** Flip one bit of the signature: genuine RS256 verification then fails. */
function tamperSignature(bytes: Uint8Array): Uint8Array {
  const copy = bytes.slice();
  copy[copy.length - 1] = copy[copy.length - 1] ^ 0x01;
  return copy;
}

/**
 * Build the invocation carrying exactly the one defect `sample.kind` names.
 * Everything else about the token stays valid and authorized.
 */
async function buildRejection(sample: RejectionSample): Promise<Invocation> {
  const keys: readonly Jwk[] = [PRIMARY_KEY.jwk];
  const baseClaims = rejectionBaseClaims(sample);

  switch (sample.kind) {
    case "absent-authorization-header":
      return { keys };

    case "authorization-without-bearer-prefix": {
      const minted = await mintToken(PRIMARY_KEY, validHeader(PRIMARY_KEY), baseClaims);
      return { authorization: nonBearerAuthorization(sample, minted.token), keys };
    }

    case "fewer-than-three-segments": {
      const minted = await mintToken(PRIMARY_KEY, validHeader(PRIMARY_KEY), baseClaims);
      return { authorization: `Bearer ${truncatedToken(sample, minted)}`, keys };
    }

    case "algorithm-other-than-rs256": {
      const minted = await mintToken(
        PRIMARY_KEY,
        { alg: sample.wrongAlgorithm, typ: "JWT", kid: PRIMARY_KEY.kid },
        baseClaims,
      );
      return { authorization: `Bearer ${minted.token}`, keys };
    }

    case "header-without-kid": {
      const minted = await mintToken(PRIMARY_KEY, { alg: "RS256", typ: "JWT" }, baseClaims);
      return { authorization: `Bearer ${minted.token}`, keys };
    }

    case "kid-matching-no-published-key": {
      const minted = await mintToken(
        PRIMARY_KEY,
        { alg: "RS256", typ: "JWT", kid: sample.unpublishedKid },
        baseClaims,
      );
      return { authorization: `Bearer ${minted.token}`, keys };
    }

    case "invalid-signature": {
      const minted = await mintToken(PRIMARY_KEY, validHeader(PRIMARY_KEY), baseClaims);
      const tampered = bytesToBase64Url(tamperSignature(minted.signatureBytes));
      return {
        authorization: `Bearer ${minted.headerSegment}.${minted.payloadSegment}.${tampered}`,
        keys,
      };
    }

    case "payload-tampered-after-signing": {
      const minted = await mintToken(PRIMARY_KEY, validHeader(PRIMARY_KEY), baseClaims);
      // Same signature, different payload: the claims an attacker would swap in.
      const swapped = utf8ToBase64Url(
        JSON.stringify({ ...baseClaims, sub: `${sample.subject}-escalated` }),
      );
      return {
        authorization: `Bearer ${minted.headerSegment}.${swapped}.${minted.signatureSegment}`,
        keys,
      };
    }

    case "audience-mismatch": {
      const minted = await mintToken(PRIMARY_KEY, validHeader(PRIMARY_KEY), {
        ...baseClaims,
        aud: sample.wrongAudience,
      });
      return { authorization: `Bearer ${minted.token}`, keys };
    }

    case "issuer-mismatch": {
      const minted = await mintToken(PRIMARY_KEY, validHeader(PRIMARY_KEY), {
        ...baseClaims,
        iss: sample.wrongIssuer,
      });
      return { authorization: `Bearer ${minted.token}`, keys };
    }

    case "absent-exp": {
      const { exp: _exp, ...withoutExp } = baseClaims;
      const minted = await mintToken(PRIMARY_KEY, validHeader(PRIMARY_KEY), withoutExp);
      return { authorization: `Bearer ${minted.token}`, keys };
    }

    case "exp-earlier-than-now": {
      const minted = await mintToken(PRIMARY_KEY, validHeader(PRIMARY_KEY), {
        ...baseClaims,
        exp: NOW_SECONDS - sample.expiredBySeconds,
      });
      return { authorization: `Bearer ${minted.token}`, keys };
    }

    case "absent-sub": {
      const { sub: _sub, ...withoutSub } = baseClaims;
      const minted = await mintToken(PRIMARY_KEY, validHeader(PRIMARY_KEY), withoutSub);
      return { authorization: `Bearer ${minted.token}`, keys };
    }
  }
}

async function assertRejected(sample: RejectionSample): Promise<void> {
  process.env["ADMIN_EMAIL_ALLOWLIST"] = REJECTION_ALLOWLIST;
  resetJwksCache();

  const invocation = await buildRejection(sample);
  const outcome = await captureOutcome(() => invokeRequireAdmin(invocation));

  expect(outcome.kind, `${sample.kind}: requireAdmin returned an AdminUser`).toBe("error");
  if (outcome.kind !== "error") return;
  expect(outcome.isAuthError, `${sample.kind}: not an AuthError (${outcome.message})`).toBe(true);
  expect(outcome.status, `${sample.kind}: ${outcome.message}`).toBe(401);
  // No credential, emulator, or endpoint was reached (Requirements 5.9, 6.14).
  expect(blockedNetworkAttempts()).toEqual([]);
}

describe("Feature: admin-quality-gates-and-shared-contracts, Property 8: `requireAdmin` rejects every malformed or invalid token", () => {
  it("accepts the unmutated control token, so the rejection matrix is not vacuous", async () => {
    process.env["ADMIN_EMAIL_ALLOWLIST"] = REJECTION_ALLOWLIST;
    const sample: RejectionSample = {
      kind: "absent-sub",
      subject: "deadbeef",
      emailLocal: "ops",
      nonBearerVariant: "empty",
      segmentVariant: "header-only",
      wrongAlgorithm: "HS256",
      unpublishedKid: "unknown-kid",
      wrongAudience: "other-project",
      wrongIssuer: "https://accounts.google.com",
      expiredBySeconds: 1,
    };
    const minted = await mintToken(
      PRIMARY_KEY,
      validHeader(PRIMARY_KEY),
      rejectionBaseClaims(sample),
    );

    const user = await invokeRequireAdmin({
      authorization: `Bearer ${minted.token}`,
      keys: [PRIMARY_KEY.jwk],
    });

    expect(user.uid).toBe("deadbeef");
    expect(user.email).toBe(`ops@${REJECTION_ALLOWLIST}`);
    expect(user.isClaimAdmin).toBe(true);
    expect(jwksFetchCalls).toBe(1);
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("raises AuthError(401) for every generated malformed or invalid token", async () => {
    await fc.assert(
      fc.asyncProperty(rejectionSampleArb, async (sample) => {
        await assertRejected(sample);
      }),
      // 13 conditions × 10 → every condition is drawn many times over.
      { numRuns: 130 },
    );
  });

  it("covers each of the enumerated rejection conditions at least once", async () => {
    // Deterministic floor under the generated distribution: every Requirement
    // 5.6 condition is exercised in a single run, whatever fast-check sampled.
    const fixed: Omit<RejectionSample, "kind"> = {
      subject: "0f1e2d3c",
      emailLocal: "ops",
      nonBearerVariant: "lowercase-scheme",
      segmentVariant: "header-and-payload",
      wrongAlgorithm: "HS256",
      unpublishedKid: "unknown-kid",
      wrongAudience: "other-project",
      wrongIssuer: "https://accounts.google.com",
      expiredBySeconds: 60,
    };
    for (const kind of REJECTION_KINDS) {
      await assertRejected({ ...fixed, kind });
    }
  });
});

// ---------------------------------------------------------------------------
// Property 9 — the authorization biconditional
// ---------------------------------------------------------------------------

/** `admin` claim shapes, including truthy values that are not boolean `true`. */
const ADMIN_CLAIM_VARIANTS = [
  { label: "absent", present: false, value: undefined },
  { label: "true", present: true, value: true },
  { label: "false", present: true, value: false },
  { label: "one", present: true, value: 1 },
  { label: "zero", present: true, value: 0 },
  { label: "string-true", present: true, value: "true" },
  { label: "string-TRUE", present: true, value: "TRUE" },
  { label: "empty-object", present: true, value: {} },
  { label: "empty-array", present: true, value: [] },
  { label: "null", present: true, value: null },
] as const;

type AdminClaimVariant = (typeof ADMIN_CLAIM_VARIANTS)[number];

/** Addresses spanning the allowlist entry forms and several letter cases. */
const EMAIL_ADDRESSES = [
  "ops@snaptapp.us",
  "OPS@SNAPTAPP.US",
  "Ops.Tester@SnapTapp.us",
  "ops@team.snaptapp.us",
  "ops@trackdub.com",
  "ops@notsnaptapp.us",
  "someone@example.test",
  "",
] as const;

/** Allowlist entry forms: bare domain, `@`-prefixed domain, full address, junk. */
const ALLOWLIST_ENTRIES = [
  "",
  "   ",
  "snaptapp.us",
  "SNAPTAPP.US",
  " snaptapp.us ",
  "@snaptapp.us",
  "ops@snaptapp.us",
  "trackdub.com",
  "notsnaptapp.us",
] as const;

interface AuthorizationSample {
  subject: string;
  adminClaim: AdminClaimVariant;
  emailPresent: boolean;
  emailAddress: string;
  namePresent: boolean;
  nameValue: string;
  allowlistEntries: string[];
  allowlistSeparator: string;
  expOffsetSeconds: number;
}

const authorizationSampleArb: fc.Arbitrary<AuthorizationSample> = fc.record({
  subject: hexString(1, 28),
  adminClaim: fc.constantFrom(...ADMIN_CLAIM_VARIANTS),
  emailPresent: fc.boolean(),
  emailAddress: fc.constantFrom(...EMAIL_ADDRESSES),
  namePresent: fc.boolean(),
  nameValue: fc.constantFrom("Ops Tester", "zoë ops", "", "  "),
  allowlistEntries: fc.array(fc.constantFrom(...ALLOWLIST_ENTRIES), {
    minLength: 0,
    maxLength: 3,
  }),
  allowlistSeparator: fc.constantFrom(",", ", ", " ", "\n", ",,"),
  // Weighted towards 0 so "expires exactly this second" (Requirement 5.7,
  // which requires acceptance) is drawn often.
  expOffsetSeconds: fc.oneof(
    { arbitrary: fc.constant(0), weight: 2 },
    { arbitrary: fc.integer({ min: 1, max: 7 * 24 * 3600 }), weight: 3 },
  ),
});

describe("Feature: admin-quality-gates-and-shared-contracts, Property 9: `requireAdmin` authorization biconditional", () => {
  it("returns an AdminUser iff the admin claim is boolean true or the email is allowlisted", async () => {
    await fc.assert(
      fc.asyncProperty(authorizationSampleArb, async (sample) => {
        const rawAllowlist = sample.allowlistEntries.join(sample.allowlistSeparator);
        process.env["ADMIN_EMAIL_ALLOWLIST"] = rawAllowlist;
        resetJwksCache();

        const emailClaim = sample.emailPresent ? sample.emailAddress : undefined;
        const nameClaim = sample.namePresent ? sample.nameValue : undefined;
        const minted = await mintToken(
          PRIMARY_KEY,
          validHeader(PRIMARY_KEY),
          claimsFrom({
            sub: sample.subject,
            aud: PROJECT_ID,
            iss: ISSUER,
            exp: NOW_SECONDS + sample.expOffsetSeconds,
            email: emailClaim,
            name: nameClaim,
            ...(sample.adminClaim.present ? { admin: sample.adminClaim.value } : {}),
          }),
        );

        // The expected verdict, computed from the two authorities the
        // implementation consults: the boolean `admin` claim and the real
        // `isEmailAllowlisted` against the parsed allowlist.
        const parsedList = parseAllowlist(rawAllowlist);
        const claimGrantsAdmin = sample.adminClaim.present && sample.adminClaim.value === true;
        const allowlistGrantsAdmin = isEmailAllowlisted(emailClaim ?? null, parsedList);
        const shouldAuthorize = claimGrantsAdmin || allowlistGrantsAdmin;

        const label = `admin=${sample.adminClaim.label} email=${emailClaim ?? "<absent>"
          } allowlist=[${parsedList.join("|")}] expOffset=${sample.expOffsetSeconds}`;

        const outcome = await captureOutcome(() =>
          invokeRequireAdmin({
            authorization: `Bearer ${minted.token}`,
            keys: [PRIMARY_KEY.jwk],
          }),
        );

        if (shouldAuthorize) {
          expect(
            outcome.kind,
            `${label}: expected an AdminUser, got ${outcome.kind === "error" ? outcome.message : "?"
            }`,
          ).toBe("user");
          if (outcome.kind !== "user") return;
          expect(outcome.user.uid, `${label}: uid`).toBe(sample.subject);
          // Letter case is preserved exactly as the token presented it.
          expect(outcome.user.email, `${label}: email`).toBe(emailClaim ?? null);
          expect(outcome.user.name, `${label}: name`).toBe(nameClaim ?? null);
          expect(outcome.user.isClaimAdmin, `${label}: isClaimAdmin`).toBe(claimGrantsAdmin);
        } else {
          expect(outcome.kind, `${label}: expected a rejection`).toBe("error");
          if (outcome.kind !== "error") return;
          expect(outcome.isAuthError, `${label}: not an AuthError`).toBe(true);
          // The token itself verified, so this is an authorization refusal
          // rather than an authentication failure.
          expect(outcome.status, `${label}: ${outcome.message}`).toBe(403);
        }

        expect(blockedNetworkAttempts()).toEqual([]);
      }),
      { numRuns: 130 },
    );
  });

  it("pins the two named witnesses: allowlisted-only (5.7) and claim-only (5.8)", async () => {
    // Requirement 5.7 — valid signature, `exp` equal to the current second, an
    // allowlisted address and no admin claim.
    process.env["ADMIN_EMAIL_ALLOWLIST"] = "snaptapp.us";
    const allowlisted = await mintToken(
      PRIMARY_KEY,
      validHeader(PRIMARY_KEY),
      claimsFrom({
        sub: "uid-allowlisted",
        aud: PROJECT_ID,
        iss: ISSUER,
        exp: NOW_SECONDS,
        email: "Ops.Tester@SnapTapp.us",
      }),
    );
    const byAllowlist = await invokeRequireAdmin({
      authorization: `Bearer ${allowlisted.token}`,
      keys: [PRIMARY_KEY.jwk],
    });
    expect(byAllowlist).toEqual({
      uid: "uid-allowlisted",
      email: "Ops.Tester@SnapTapp.us",
      name: null,
      isClaimAdmin: false,
    });

    // Requirement 5.8 — admin custom claim `true`, address absent from an empty
    // allowlist.
    resetJwksCache();
    process.env["ADMIN_EMAIL_ALLOWLIST"] = "";
    const claimed = await mintToken(
      PRIMARY_KEY,
      validHeader(PRIMARY_KEY),
      claimsFrom({
        sub: "uid-claimed",
        aud: PROJECT_ID,
        iss: ISSUER,
        exp: NOW_SECONDS + 60,
        email: "stranger@example.test",
        name: "Claimed Admin",
        admin: true,
      }),
    );
    const byClaim = await invokeRequireAdmin({
      authorization: `Bearer ${claimed.token}`,
      keys: [PRIMARY_KEY.jwk],
    });
    expect(byClaim).toEqual({
      uid: "uid-claimed",
      email: "stranger@example.test",
      name: "Claimed Admin",
      isClaimAdmin: true,
    });

    expect(blockedNetworkAttempts()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Property 10 — order independence and zero network traffic
// ---------------------------------------------------------------------------

interface OrderedCase {
  label: string;
  authorization?: string | undefined;
  keys: readonly Jwk[];
  allowlist: string;
}

/**
 * Cases that deliberately disagree about key material: two are signed by the
 * primary pair and published under it, one is signed by the *secondary* pair and
 * published under that, and one presents a primary-signed token while only the
 * secondary key is published. Without the per-case `resetJwksCache()`, the hour
 * of JWKS caching would make a later case's verdict depend on which case ran
 * first — exactly the hazard Requirement 5.9 names.
 */
async function buildOrderedCases(): Promise<OrderedCase[]> {
  const validClaims = (sub: string, extra: Record<string, unknown>): JwtClaims =>
    claimsFrom({
      sub,
      aud: PROJECT_ID,
      iss: ISSUER,
      exp: NOW_SECONDS + 3600,
      ...extra,
    });

  const allowlistedOnPrimary = await mintToken(
    PRIMARY_KEY,
    validHeader(PRIMARY_KEY),
    validClaims("uid-primary-allowlisted", { email: "ops@snaptapp.us" }),
  );
  const claimAdminOnSecondary = await mintToken(
    SECONDARY_KEY,
    validHeader(SECONDARY_KEY),
    validClaims("uid-secondary-claimed", { email: "stranger@example.test", admin: true }),
  );
  const expiredOnPrimary = await mintToken(
    PRIMARY_KEY,
    validHeader(PRIMARY_KEY),
    claimsFrom({
      sub: "uid-expired",
      aud: PROJECT_ID,
      iss: ISSUER,
      exp: NOW_SECONDS - 1,
      email: "ops@snaptapp.us",
    }),
  );
  const unauthorizedOnPrimary = await mintToken(
    PRIMARY_KEY,
    validHeader(PRIMARY_KEY),
    validClaims("uid-unauthorized", { email: "stranger@example.test", admin: "true" }),
  );

  return [
    {
      label: "primary key, allowlisted email → AdminUser",
      authorization: `Bearer ${allowlistedOnPrimary.token}`,
      keys: [PRIMARY_KEY.jwk],
      allowlist: "snaptapp.us",
    },
    {
      label: "secondary key, admin claim → AdminUser",
      authorization: `Bearer ${claimAdminOnSecondary.token}`,
      keys: [SECONDARY_KEY.jwk],
      allowlist: "",
    },
    {
      label: "primary-signed token, only the secondary key published → 401",
      authorization: `Bearer ${allowlistedOnPrimary.token}`,
      keys: [SECONDARY_KEY.jwk],
      allowlist: "snaptapp.us",
    },
    {
      label: "expired token → 401",
      authorization: `Bearer ${expiredOnPrimary.token}`,
      keys: [PRIMARY_KEY.jwk],
      allowlist: "snaptapp.us",
    },
    {
      label: "verified token, neither allowlisted nor boolean-true admin → 403",
      authorization: `Bearer ${unauthorizedOnPrimary.token}`,
      keys: [PRIMARY_KEY.jwk],
      allowlist: "snaptapp.us",
    },
  ];
}

/** Run one case exactly the way the suite runs it: cache reset, then invoke. */
async function runOrderedCase(orderedCase: OrderedCase, resetCache: boolean): Promise<Outcome> {
  if (resetCache) resetJwksCache();
  process.env["ADMIN_EMAIL_ALLOWLIST"] = orderedCase.allowlist;
  return captureOutcome(() =>
    invokeRequireAdmin({ authorization: orderedCase.authorization, keys: orderedCase.keys }),
  );
}

describe("Feature: admin-quality-gates-and-shared-contracts, Property 10: `requireAdmin` results are independent of execution order and issue no network request", () => {
  it("produces each case's isolated result under every generated ordering, with no request attempted", async () => {
    const cases = await buildOrderedCases();
    const indices = cases.map((_, index) => index);

    // Baseline: each case in isolation.
    const isolated: Outcome[] = [];
    for (const orderedCase of cases) {
      isolated.push(await runOrderedCase(orderedCase, true));
    }
    // Sanity: the baseline spans acceptance and both rejection statuses, so the
    // comparison below is not comparing five identical outcomes.
    expect(isolated.filter((outcome) => outcome.kind === "user")).toHaveLength(2);
    expect(
      isolated.filter((outcome) => outcome.kind === "error" && outcome.status === 401),
    ).toHaveLength(2);
    expect(
      isolated.filter((outcome) => outcome.kind === "error" && outcome.status === 403),
    ).toHaveLength(1);

    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray(indices, { minLength: indices.length, maxLength: indices.length }),
        async (order) => {
          const callsBefore = jwksFetchCalls;
          for (const index of order) {
            const orderedCase = cases[index];
            const outcome = await runOrderedCase(orderedCase, true);
            expect(outcome, `${orderedCase.label} (order ${order.join(",")})`).toEqual(
              isolated[index],
            );
          }
          // Every key lookup went to the injected double...
          expect(jwksFetchCalls).toBeGreaterThan(callsBefore);
          // ...and the network guard recorded nothing: no signing-key endpoint,
          // no Firestore, no Identity Toolkit, nothing (Requirements 6.10, 6.14).
          expect(blockedNetworkAttempts()).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("shows the cache reset is load-bearing: retained keys change a later case", async () => {
    // Negative control for the property above. Case 0 publishes the primary key;
    // case 1 publishes only the secondary key. Run back to back *without* the
    // reset, the hour-long JWKS cache still holds the primary key, so case 1's
    // token is rejected as "Unknown signing key" instead of being accepted.
    const cases = await buildOrderedCases();
    const primaryCase = cases[0];
    const secondaryCase = cases[1];

    const secondaryInIsolation = await runOrderedCase(secondaryCase, true);
    expect(secondaryInIsolation.kind).toBe("user");

    resetJwksCache();
    const first = await runOrderedCase(primaryCase, false);
    expect(first.kind).toBe("user");
    const callsAfterFirst = jwksFetchCalls;

    const second = await runOrderedCase(secondaryCase, false);
    expect(second.kind).toBe("error");
    if (second.kind === "error") {
      expect(second.status).toBe(401);
      expect(second.message).toBe("Unknown signing key");
    }
    // The second invocation never consulted its own key source — it read the
    // retained cache, which is precisely why `resetJwksCache()` runs per case.
    expect(jwksFetchCalls).toBe(callsAfterFirst);
    expect(blockedNetworkAttempts()).toEqual([]);
  });
});
