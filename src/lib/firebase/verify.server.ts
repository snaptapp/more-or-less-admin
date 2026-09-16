/**
 * Firebase ID token verification + admin authorization.
 *
 * This is the security boundary for the portal: route guards only affect UI,
 * every server function that touches Firestore calls `requireAdmin()`.
 */
import { getRequestHeader } from "@tanstack/react-start/server";
import { getServiceAccount } from "./credentials.server";

const JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

interface Jwk {
  kid: string;
  n: string;
  e: string;
  alg?: string;
  kty: string;
}

let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;

async function getJwks(): Promise<Jwk[]> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < 60 * 60 * 1000) return jwksCache.keys;
  const response = await fetch(JWKS_URL);
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

/** Verifies the bearer token on the current request and asserts admin access. */
export async function requireAdmin(): Promise<AdminUser> {
  const header = getRequestHeader("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw new AuthError("Not signed in");

  const [rawHeader, rawPayload, rawSignature] = token.split(".");
  if (!rawHeader || !rawPayload || !rawSignature) throw new AuthError("Malformed token");

  const header64 = JSON.parse(new TextDecoder().decode(base64UrlDecode(rawHeader))) as {
    kid?: string;
    alg?: string;
  };
  if (header64.alg !== "RS256" || !header64.kid) throw new AuthError("Unsupported token");

  const jwk = (await getJwks()).find((entry) => entry.kid === header64.kid);
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
