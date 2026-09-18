/**
 * Firebase ID token verification + admin authorization.
 *
 * This is the security boundary for the portal: route guards only affect UI,
 * every server function that touches Firestore calls `requireAdmin()`.
 *
 * Two dependencies are injectable so the boundary can be tested with no
 * network and no request context (Requirement 5.9): the JWKS source and the
 * request-header source. Both default to the production implementation, so
 * every existing call site — `authMiddleware` in `src/lib/admin/middleware.ts`
 * calls `requireAdmin()` with no arguments — behaves exactly as before.
 *
 * Intended test usage (see task 5.4):
 *
 *     import {
 *       requireAdmin,
 *       resetJwksCache,
 *       headerSourceFromRecord,
 *       type Jwk,
 *     } from "@/lib/firebase/verify.server";
 *
 *     beforeEach(() => {
 *       // Key material cached by a preceding case cannot leak into this one.
 *       resetJwksCache();
 *     });
 *
 *     const keys: Jwk[] = [publishedJwkForLocallyMintedKeyPair];
 *     const user = await requireAdmin({
 *       getHeader: headerSourceFromRecord({ authorization: `Bearer ${token}` }),
 *       fetchJwks: async () => ({ ok: true, json: async () => ({ keys }) }),
 *     });
 *
 * No `vi.mock` of this module (or of `@tanstack/react-start/server`) is needed:
 * both seams are plain parameters.
 */
import { getRequestHeader } from "@tanstack/react-start/server";
import { getServiceAccount } from "./credentials.server";

/** Google's published signing keys for Firebase ID tokens. */
export const JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

/** One published RSA signing key, as it appears in the JWKS document. */
export interface Jwk {
  kid: string;
  n: string;
  e: string;
  alg?: string;
  kty: string;
}

/**
 * The part of an HTTP response `getJwks` actually consumes. Narrow on purpose:
 * the real `fetch` satisfies it, and a test double can satisfy it with a plain
 * object instead of constructing a `Response`.
 */
export interface JwksResponse {
  readonly ok: boolean;
  json(): Promise<unknown>;
}

/** Injectable JWKS source. The real `fetch` is assignable to this. */
export type JwksFetcher = (url: string) => Promise<JwksResponse>;

/**
 * Injectable request-header source. Typed from `getRequestHeader`, so the
 * production default is the function itself and a test double may accept a
 * plain `string` name.
 */
export type RequestHeaderSource = typeof getRequestHeader;

/** Production JWKS source: the ambient `fetch`, resolved at call time. */
const defaultJwksFetcher: JwksFetcher = (url) => fetch(url);

/** Production request-header source: the current request's headers. */
const defaultHeaderSource: RequestHeaderSource = getRequestHeader;

/**
 * Builds a `RequestHeaderSource` over a fixed header map, for callers that have
 * headers in hand rather than an ambient request (tests, primarily). Lookup is
 * case-insensitive, matching HTTP header semantics.
 */
export function headerSourceFromRecord(
  headers: Readonly<Record<string, string | undefined>>,
): RequestHeaderSource {
  const normalized = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") normalized.set(name.toLowerCase(), value);
  }
  return (name) => normalized.get(name.toLowerCase());
}

let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;

/**
 * Drops the cached JWKS document. Production never needs this — the cache
 * expires on its own — but a test suite calls it between cases so retained key
 * material cannot make one case's result depend on another's (Requirement 5.9).
 */
export function resetJwksCache(): void {
  jwksCache = null;
}

/**
 * The published signing keys, cached for an hour.
 *
 * @param fetcher JWKS source; defaults to the ambient `fetch`.
 */
export async function getJwks(fetcher: JwksFetcher = defaultJwksFetcher): Promise<Jwk[]> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < 60 * 60 * 1000) return jwksCache.keys;
  const response = await fetcher(JWKS_URL);
  if (!response.ok) throw new Error("Unable to fetch Firebase signing keys");
  const payload = (await response.json()) as { keys: Jwk[] };
  jwksCache = { keys: payload.keys, fetchedAt: Date.now() };
  return payload.keys;
}

function base64UrlDecode(input: string): Uint8Array<ArrayBuffer> {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface AdminUser {
  uid: string;
  email: string | null;
  name: string | null;
  isClaimAdmin: boolean;
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

function allowlist(): string[] {
  return (process.env["ADMIN_EMAIL_ALLOWLIST"] ?? "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function isEmailAllowlisted(email: string | null | undefined, list: string[]): boolean {
  if (!email || list.length === 0) return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  for (const entry of list) {
    const pattern = entry.trim().toLowerCase();
    if (!pattern) continue;
    if (pattern.startsWith("@")) {
      if (normalized.endsWith(pattern)) return true;
    } else if (pattern.includes("@")) {
      if (normalized === pattern) return true;
    } else {
      // Domain without leading '@' (e.g. "trackdub.com", "snaptapp.us")
      if (normalized.endsWith(`@${pattern}`) || normalized.endsWith(`.${pattern}`)) return true;
    }
  }
  return false;
}

/** Overridable dependencies of {@link requireAdmin}; both default to production. */
export interface RequireAdminOptions {
  /** JWKS source. Default: the ambient `fetch` against {@link JWKS_URL}. */
  fetchJwks?: JwksFetcher;
  /** Request-header source. Default: the current request's headers. */
  getHeader?: RequestHeaderSource;
}

/**
 * Verifies the bearer token on the current request and asserts admin access.
 *
 * Called with no arguments in production (`authMiddleware`), which resolves
 * both dependencies to the real request headers and the real JWKS endpoint.
 */
export async function requireAdmin(options: RequireAdminOptions = {}): Promise<AdminUser> {
  const readHeader = options.getHeader ?? defaultHeaderSource;
  const fetchJwks = options.fetchJwks ?? defaultJwksFetcher;

  const header = readHeader("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw new AuthError("Not signed in");

  const [rawHeader, rawPayload, rawSignature] = token.split(".");
  if (!rawHeader || !rawPayload || !rawSignature) throw new AuthError("Malformed token");

  const header64 = JSON.parse(new TextDecoder().decode(base64UrlDecode(rawHeader))) as {
    kid?: string;
    alg?: string;
  };
  if (header64.alg !== "RS256" || !header64.kid) throw new AuthError("Unsupported token");

  const jwk = (await getJwks(fetchJwks)).find((entry) => entry.kid === header64.kid);
  if (!jwk) throw new AuthError("Unknown signing key");

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlDecode(rawSignature),
    new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
  );
  if (!valid) throw new AuthError("Invalid token signature");

  const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(rawPayload))) as {
    aud?: string;
    iss?: string;
    sub?: string;
    exp?: number;
    email?: string;
    email_verified?: boolean;
    name?: string;
    admin?: boolean;
  };

  const projectId = getServiceAccount().project_id;
  const now = Math.floor(Date.now() / 1000);
  if (claims.aud !== projectId) throw new AuthError("Token audience mismatch");
  if (claims.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new AuthError("Token issuer mismatch");
  }
  if (!claims.exp || claims.exp < now) throw new AuthError("Token expired");
  if (!claims.sub) throw new AuthError("Token has no subject");

  const email = claims.email?.toLowerCase() ?? null;
  const isClaimAdmin = claims.admin === true;
  const list = allowlist();
  const isAllowlisted = isEmailAllowlisted(email, list);

  if (!isClaimAdmin && !isAllowlisted) {
    throw new AuthError(
      `This account is not an admin (${email ?? "no email on token"}). ` +
      (list.length === 0
        ? "The admin email allowlist is empty."
        : "Add this email address or domain to the ADMIN_EMAIL_ALLOWLIST secret, then sign out and back in."),
      403,
    );
  }


  return {
    uid: claims.sub,
    email: claims.email ?? null,
    name: claims.name ?? null,
    isClaimAdmin,
  };
}
