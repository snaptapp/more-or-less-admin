/**
 * Edge-case example tests for the two `requireAdmin` fail-closed paths (task 5.5).
 *
 * Feature: admin-quality-gates-and-shared-contracts
 *
 * Requirement 5.11, both clauses:
 *
 *   1. When the signing-key source is unavailable, `requireAdmin` raises an
 *      error indicating that signing keys could not be retrieved and returns no
 *      `AdminUser`. Covered here in three source-unavailability flavours, which
 *      the implementation reaches by different routes:
 *        - a response that is not ok            → `Unable to fetch Firebase signing keys`
 *        - a fetcher that rejects outright      → the transport error propagates
 *        - an ok response with an unreadable body → the body error propagates
 *      All three must fail closed, and none may leave key material behind that
 *      a later attempt could mistake for a successful retrieval.
 *
 *   2. When a token's header or payload segment does not decode to valid JSON,
 *      `requireAdmin` raises and returns no `AdminUser`. Both segments are
 *      covered, because they fail at different points in the boundary: the
 *      header is parsed *before* any key is fetched, whereas the payload is
 *      parsed *after* the signature has already verified — so the payload case
 *      only exercises the decode path if the token is genuinely well signed.
 *
 * Scope boundary
 * --------------
 * Task 5.4 owns `test/requireadmin.property.test.ts` (Properties 8-10: the token
 * rejection matrix, the authorization biconditional, and order independence).
 * This file deliberately stays on the two Requirement 5.11 cases. The two
 * positive controls below exist only to establish non-vacuity — to show each
 * rejection is attributable to the unavailable key source or the undecodable
 * segment, and not to a harness that could never authorize anything.
 *
 * How the seams are used (task 5.2)
 * ---------------------------------
 * Both dependencies are plain parameters, so no module is mocked here:
 * `fetchJwks` supplies the signing keys and `getHeader` supplies the bearer
 * token. Every case asserts `blockedNetworkAttempts()` is empty, which proves
 * the guard in `test/setup.ts` saw no outbound request at all — the JWKS
 * endpoint included.
 *
 * `resetJwksCache()` runs before *and* after every test. Without it a document
 * cached by a preceding case would satisfy `getJwks` from memory and the
 * unavailable-source path would never be reached; the last test in the first
 * block demonstrates exactly that masking, so the reset is a proven necessity
 * rather than a precaution.
 *
 * Credentials
 * -----------
 * `requireAdmin` reads `getServiceAccount().project_id` to check the audience
 * and issuer claims. This file synthesizes a `FIREBASE_SERVICE_ACCOUNT_JSON`
 * with a fake project id and an obviously non-key `private_key` (never used on
 * this path), and restores the previous environment after each test. No real
 * credential is involved. Signing keys are a locally generated RSA key pair
 * published through the injected JWKS double.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AuthError,
  JWKS_URL,
  getJwks,
  headerSourceFromRecord,
  requireAdmin,
  resetJwksCache,
  type AdminUser,
  type Jwk,
  type JwksFetcher,
  type JwksResponse,
} from "@/lib/firebase/verify.server";

import { blockedNetworkAttempts } from "./setup";

// ---------------------------------------------------------------------------
// Environment: a synthesized service account, never a real credential
// ---------------------------------------------------------------------------

const TEST_PROJECT_ID = "more-or-less-admin-unit-test";
const TEST_ALLOWLIST = "unit-test.example";
const TEST_EMAIL = `ops@${TEST_ALLOWLIST}`;

const TEST_SERVICE_ACCOUNT_JSON = JSON.stringify({
  project_id: TEST_PROJECT_ID,
  client_email: `ops-portal@${TEST_PROJECT_ID}.iam.gserviceaccount.com`,
  // Deliberately not a key: `requireAdmin` only reads `project_id`, and a
  // parseable placeholder keeps any accidental signing attempt loud.
  private_key: "NOT-A-PRIVATE-KEY (synthesized for tests)",
});

const ENV_KEYS = ["FIREBASE_SERVICE_ACCOUNT_JSON", "ADMIN_EMAIL_ALLOWLIST"] as const;

const originalEnv = new Map<string, string | undefined>();

function setTestEnv(): void {
  for (const key of ENV_KEYS) originalEnv.set(key, process.env[key]);
  process.env["FIREBASE_SERVICE_ACCOUNT_JSON"] = TEST_SERVICE_ACCOUNT_JSON;
  process.env["ADMIN_EMAIL_ALLOWLIST"] = TEST_ALLOWLIST;
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const previous = originalEnv.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  originalEnv.clear();
}

// ---------------------------------------------------------------------------
// base64url + local RSA token minting
// ---------------------------------------------------------------------------

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlFromText(text: string): string {
  return base64UrlFromBytes(new TextEncoder().encode(text));
}

interface MintedKey {
  kid: string;
  /** The public half, in the shape the JWKS document publishes it. */
  jwk: Jwk;
  privateKey: CryptoKey;
}

/** Generates an RS256 key pair and the JWK the JWKS double will publish for it. */
async function mintKeyPair(kid: string): Promise<MintedKey> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (!exported.kty || !exported.n || !exported.e) {
    throw new Error("exported JWK is missing kty/n/e");
  }
  return {
    kid,
    jwk: { kid, kty: exported.kty, n: exported.n, e: exported.e, alg: "RS256" },
    privateKey: pair.privateKey,
  };
}

interface MintOptions {
  /** Raw header segment. Overrides `header`; use for segments that must not be JSON. */
  headerSegment?: string;
  /** Raw payload segment. Overrides `claims`; use for segments that must not be JSON. */
  payloadSegment?: string;
  header?: Record<string, unknown>;
  claims?: Record<string, unknown>;
}

/**
 * Signs `header.payload` with the minted private key, so the signature really
 * verifies against the published JWK. Either segment can be supplied verbatim,
 * which is how the undecodable-segment cases keep the signature valid while the
 * segment content is not JSON.
 */
async function mintToken(key: MintedKey, options: MintOptions = {}): Promise<string> {
  const headerSegment =
    options.headerSegment ??
    base64UrlFromText(
      JSON.stringify(options.header ?? { alg: "RS256", typ: "JWT", kid: key.kid }),
    );
  const payloadSegment =
    options.payloadSegment ?? base64UrlFromText(JSON.stringify(options.claims ?? authorizedClaims()));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key.privateKey,
    new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
  );
  return `${headerSegment}.${payloadSegment}.${base64UrlFromBytes(new Uint8Array(signature))}`;
}

/** Claims that satisfy every check after the payload decode, so nothing else can be blamed. */
function authorizedClaims(): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    aud: TEST_PROJECT_ID,
    iss: `https://securetoken.google.com/${TEST_PROJECT_ID}`,
    sub: "unit-test-subject-uid",
    exp: now + 300,
    email: TEST_EMAIL,
    email_verified: true,
    name: "Unit Test Operator",
  };
}

// ---------------------------------------------------------------------------
// JWKS doubles
// ---------------------------------------------------------------------------

interface CountingFetcher {
  fetcher: JwksFetcher;
  /** Every URL the boundary asked for, in call order. */
  calls: string[];
}

function countingFetcher(behaviour: (url: string) => Promise<JwksResponse>): CountingFetcher {
  const calls: string[] = [];
  return {
    calls,
    fetcher: async (url) => {
      calls.push(url);
      return behaviour(url);
    },
  };
}

/** An available source publishing exactly the minted key. */
function availableJwks(keys: readonly Jwk[]): CountingFetcher {
  return countingFetcher(async () => ({
    ok: true,
    json: async () => ({ keys: keys.slice() }),
  }));
}

/** Source unavailable: the endpoint answered, but not with a usable status. */
function notOkJwks(): CountingFetcher {
  return countingFetcher(async () => ({
    ok: false,
    // `getJwks` must not read the body of a non-ok response; if it does, this
    // rejection surfaces instead of the expected diagnostic.
    json: async () => {
      throw new Error("body of a non-ok JWKS response must not be read");
    },
  }));
}

/** The transport error a failed connection produces (undici throws this shape). */
const TRANSPORT_FAILURE = new TypeError("fetch failed");

/** Source unavailable: the request never completed. */
function rejectingJwks(): CountingFetcher {
  return countingFetcher(async () => {
    throw TRANSPORT_FAILURE;
  });
}

const UNREADABLE_BODY = new Error("JWKS response body is truncated");

/** Source unavailable: an ok response whose body cannot be read. */
function unreadableBodyJwks(): CountingFetcher {
  return countingFetcher(async () => ({
    ok: true,
    json: async () => {
      throw UNREADABLE_BODY;
    },
  }));
}

// ---------------------------------------------------------------------------
// Attempt helper — makes "returns no AdminUser" directly assertable
// ---------------------------------------------------------------------------

type Attempt = { returned: true; user: AdminUser } | { returned: false; error: unknown };

async function attemptRequireAdmin(token: string, fetchJwks: JwksFetcher): Promise<Attempt> {
  try {
    const user = await requireAdmin({
      getHeader: headerSourceFromRecord({ authorization: `Bearer ${token}` }),
      fetchJwks,
    });
    return { returned: true, user };
  } catch (error) {
    return { returned: false, error };
  }
}

/** Asserts the attempt raised, produced no `AdminUser`, and touched no network. */
function expectFailedClosed(attempt: Attempt): Error {
  expect(attempt.returned, "requireAdmin must raise rather than return").toBe(false);
  // Not merely "the user is falsy": the successful branch is absent entirely.
  expect("user" in attempt).toBe(false);
  expect(blockedNetworkAttempts()).toEqual([]);

  if (attempt.returned) throw new Error("unreachable: attempt returned an AdminUser");
  expect(attempt.error).toBeInstanceOf(Error);
  return attempt.error as Error;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let signingKey: MintedKey;

beforeAll(async () => {
  // One key pair for the file: generation is the only slow step here.
  signingKey = await mintKeyPair("unit-test-kid-1");
});

beforeEach(() => {
  // A document cached by any preceding case cannot satisfy `getJwks` here, so
  // the unavailable-source path is genuinely reached (Requirement 5.9).
  resetJwksCache();
  setTestEnv();
});

afterEach(() => {
  resetJwksCache();
  restoreEnv();
});

// ---------------------------------------------------------------------------
// Requirement 5.11, clause 1 — the signing-key source is unavailable
// ---------------------------------------------------------------------------

describe("Requirement 5.11: requireAdmin fails closed when the signing-key source is unavailable", () => {
  it("raises that signing keys could not be retrieved, and returns no AdminUser, on a non-ok response", async () => {
    const token = await mintToken(signingKey);
    const jwks = notOkJwks();

    const error = expectFailedClosed(await attemptRequireAdmin(token, jwks.fetcher));

    // The diagnostic names the failure as key retrieval, not token content.
    expect(error.message).toBe("Unable to fetch Firebase signing keys");
    expect(error.message).toMatch(/signing keys/i);

    // The boundary really did try the published endpoint, once.
    expect(jwks.calls).toEqual([JWKS_URL]);
  });

  it("raises and returns no AdminUser when the JWKS fetcher rejects outright", async () => {
    const token = await mintToken(signingKey);
    const jwks = rejectingJwks();

    const error = expectFailedClosed(await attemptRequireAdmin(token, jwks.fetcher));

    // The transport error propagates unchanged — it is not swallowed, and it is
    // not converted into an authorization decision.
    expect(error).toBe(TRANSPORT_FAILURE);
    expect(error).not.toBeInstanceOf(AuthError);
    expect(jwks.calls).toEqual([JWKS_URL]);
  });

  it("raises and returns no AdminUser when an ok JWKS response has an unreadable body", async () => {
    const token = await mintToken(signingKey);
    const jwks = unreadableBodyJwks();

    const error = expectFailedClosed(await attemptRequireAdmin(token, jwks.fetcher));

    expect(error).toBe(UNREADABLE_BODY);
    expect(jwks.calls).toEqual([JWKS_URL]);
  });

  it("caches nothing from an unavailable source, so the next retrieval retries it", async () => {
    const token = await mintToken(signingKey);

    // Two failing attempts in a row: the second must consult the source again
    // rather than reuse anything the first left behind.
    const firstAttempt = notOkJwks();
    expectFailedClosed(await attemptRequireAdmin(token, firstAttempt.fetcher));
    const secondAttempt = rejectingJwks();
    expectFailedClosed(await attemptRequireAdmin(token, secondAttempt.fetcher));
    expect(secondAttempt.calls).toEqual([JWKS_URL]);

    // And no poisoned cache entry survives: a now-available source is read.
    const recovered = availableJwks([signingKey.jwk]);
    await expect(getJwks(recovered.fetcher)).resolves.toEqual([signingKey.jwk]);
    expect(recovered.calls).toEqual([JWKS_URL]);
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("authorizes the very same token once the signing-key source is available", async () => {
    // Non-vacuity control: the three rejections above are attributable to the
    // key source, because this token authorizes when the source answers.
    const token = await mintToken(signingKey);
    const jwks = availableJwks([signingKey.jwk]);

    const attempt = await attemptRequireAdmin(token, jwks.fetcher);
    expect(attempt.returned).toBe(true);
    if (!attempt.returned) throw new Error("unreachable: available source must authorize");
    expect(attempt.user.uid).toBe("unit-test-subject-uid");
    expect(attempt.user.email).toBe(TEST_EMAIL);
    expect(attempt.user.isClaimAdmin).toBe(false);
    expect(jwks.calls).toEqual([JWKS_URL]);
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("would be masked by a cached document, which is why the cache is reset per test", async () => {
    // This is the justification for the `beforeEach` reset, asserted rather
    // than asserted-about: with a warm cache an unavailable source is never
    // consulted, so a case relying on that path would pass for the wrong
    // reason. The reset is what makes the three rejections above meaningful.
    const warm = availableJwks([signingKey.jwk]);
    await expect(getJwks(warm.fetcher)).resolves.toEqual([signingKey.jwk]);
    expect(warm.calls).toEqual([JWKS_URL]);

    const masked = notOkJwks();
    await expect(getJwks(masked.fetcher)).resolves.toEqual([signingKey.jwk]);
    expect(masked.calls, "a warm cache masks the unavailable source").toEqual([]);

    resetJwksCache();
    const exposed = notOkJwks();
    await expect(getJwks(exposed.fetcher)).rejects.toThrow(
      "Unable to fetch Firebase signing keys",
    );
    expect(exposed.calls).toEqual([JWKS_URL]);
    expect(blockedNetworkAttempts()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Requirement 5.11, clause 2 — a segment does not decode to valid JSON
// ---------------------------------------------------------------------------

/** Segment bodies that decode to text but are not valid JSON. */
const NOT_JSON_SEGMENTS: Array<{ label: string; text: string }> = [
  { label: "plain text", text: "not-json" },
  { label: "a truncated object", text: '{"alg":"RS256","kid":' },
  { label: "a key=value pair", text: "alg=RS256" },
  { label: "an unterminated array", text: "[unclosed" },
  { label: "a bare identifier", text: "undefined" },
];

describe("Requirement 5.11: requireAdmin fails closed when the token header segment does not decode to valid JSON", () => {
  it.each(NOT_JSON_SEGMENTS)(
    "raises and returns no AdminUser when the header segment is $label",
    async ({ text }) => {
      // Signed with the real key over the real segments, so the only defect is
      // that the header does not parse.
      const token = await mintToken(signingKey, { headerSegment: base64UrlFromText(text) });
      const jwks = availableJwks([signingKey.jwk]);

      const error = expectFailedClosed(await attemptRequireAdmin(token, jwks.fetcher));
      expect(error).toBeInstanceOf(SyntaxError);

      // The header is parsed before any key retrieval, so the boundary stopped
      // before it asked the signing-key source for anything.
      expect(jwks.calls).toEqual([]);
    },
  );

  it("raises and returns no AdminUser when the header segment is not decodable base64url", async () => {
    // Not even a decode to text: `atob` rejects the alphabet.
    const token = await mintToken(signingKey, { headerSegment: "!!!not-base64!!!" });
    const jwks = availableJwks([signingKey.jwk]);

    expectFailedClosed(await attemptRequireAdmin(token, jwks.fetcher));
    expect(jwks.calls).toEqual([]);
  });
});

describe("Requirement 5.11: requireAdmin fails closed when the token payload segment does not decode to valid JSON", () => {
  it.each(NOT_JSON_SEGMENTS)(
    "raises and returns no AdminUser when the payload segment is $label",
    async ({ text }) => {
      const token = await mintToken(signingKey, { payloadSegment: base64UrlFromText(text) });
      const jwks = availableJwks([signingKey.jwk]);

      const error = expectFailedClosed(await attemptRequireAdmin(token, jwks.fetcher));
      expect(error).toBeInstanceOf(SyntaxError);

      // The payload is parsed only after the signature has verified, so this
      // case genuinely exercises the decode path: the key was fetched and the
      // signature over `header.payload` was accepted first.
      expect(jwks.calls).toEqual([JWKS_URL]);
    },
  );

  it("raises and returns no AdminUser when the payload segment is not decodable base64url", async () => {
    const token = await mintToken(signingKey, { payloadSegment: "!!!not-base64!!!" });
    const jwks = availableJwks([signingKey.jwk]);

    expectFailedClosed(await attemptRequireAdmin(token, jwks.fetcher));
  });

  it("authorizes when the payload segment decodes to valid JSON claims", async () => {
    // Non-vacuity control for this block: the minting path, the published key
    // and the signature are all sound, so every rejection above is attributable
    // to the segment content alone.
    const token = await mintToken(signingKey, {
      payloadSegment: base64UrlFromText(JSON.stringify(authorizedClaims())),
    });
    const jwks = availableJwks([signingKey.jwk]);

    const attempt = await attemptRequireAdmin(token, jwks.fetcher);
    expect(attempt.returned).toBe(true);
    if (!attempt.returned) throw new Error("unreachable: valid claims must authorize");
    expect(attempt.user.uid).toBe("unit-test-subject-uid");
    expect(attempt.user.name).toBe("Unit Test Operator");
    expect(blockedNetworkAttempts()).toEqual([]);
  });
});
