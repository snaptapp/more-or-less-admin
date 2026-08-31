/**
 * Firebase ID token verification + admin authorization using official Firebase Admin SDK.
 *
 * This is the security boundary for the portal: route guards only affect UI,
 * every server function that touches Firestore calls `requireAdmin()`.
 */
import { getRequestHeader } from "@tanstack/react-start/server";
import { adminAuth } from "./admin.server";

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

/** Verifies the bearer token on the current request and asserts admin access. */
export async function requireAdmin(): Promise<AdminUser> {
  const header = getRequestHeader("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw new AuthError("Not signed in", 401);

  try {
    // Check revocation (checkRevoked = true) for immediate session invalidation on role changes
    const decoded = await adminAuth.verifyIdToken(token, true);

    const email = decoded.email?.toLowerCase() ?? null;
    const isClaimAdmin = decoded["admin"] === true;
    const list = allowlist();
    const isAllowlisted = !!email && list.includes(email);

    if (!isClaimAdmin && !isAllowlisted) {
      throw new AuthError(
        `This account is not an admin (${email ?? "no email on token"}). ` +
          (list.length === 0
            ? "The admin email allowlist is empty."
            : "Add this exact email to the ADMIN_EMAIL_ALLOWLIST secret or grant admin role."),
        403
      );
    }

    return {
      uid: decoded.uid,
      email: decoded.email ?? null,
      name: decoded.name ?? null,
      isClaimAdmin,
    };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    const msg = error instanceof Error ? error.message : "Invalid or expired token";
    if (msg.includes("revoked")) {
      throw new AuthError("Your admin session has been revoked. Please sign in again.", 401);
    }
    throw new AuthError(`Authentication failed: ${msg}`, 401);
  }
}
