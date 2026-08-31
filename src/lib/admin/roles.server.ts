/**
 * Firebase Authentication user & role management via Firebase Admin SDK.
 *
 * Roles are stored as custom claims (e.g. { admin: true }); the admin gate
 * in verify.server.ts reads them from the user's ID token.
 */
import { adminAuth } from "../firebase/admin.server";
import { logAdminAction } from "../firebase/audit.server";
import type { AdminUser } from "../firebase/verify.server";
import type { UserRecord } from "firebase-admin/auth";

export interface AdminUserRecord {
  uid: string;
  email: string | null;
  displayName: string | null;
  emailVerified: boolean;
  disabled: boolean;
  isAdmin: boolean;
  mfaEnrolled: boolean;
  createdAt: string | null;
  lastSignInAt: string | null;
}

function toRecord(user: UserRecord): AdminUserRecord {
  const claims = (user.customClaims || {}) as Record<string, unknown>;
  const mfaFactors = user.multiFactor?.enrolledFactors || [];
  return {
    uid: user.uid,
    email: user.email ?? null,
    displayName: user.displayName ?? null,
    emailVerified: user.emailVerified === true,
    disabled: user.disabled === true,
    isAdmin: claims["admin"] === true,
    mfaEnrolled: mfaFactors.length > 0,
    createdAt: user.metadata.creationTime ? new Date(user.metadata.creationTime).toISOString() : null,
    lastSignInAt: user.metadata.lastSignInTime ? new Date(user.metadata.lastSignInTime).toISOString() : null,
  };
}

/** Lists all Firebase Auth users. */
export async function listAuthUsers(): Promise<AdminUserRecord[]> {
  const users: AdminUserRecord[] = [];
  let nextPageToken: string | undefined;
  do {
    const listResult = await adminAuth.listUsers(500, nextPageToken);
    for (const user of listResult.users) {
      users.push(toRecord(user));
    }
    nextPageToken = listResult.pageToken;
  } while (nextPageToken);

  users.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return users;
}

/** Grants or revokes the admin custom claim, merging with existing claims and revoking tokens. */
export async function setAdminClaim(
  adminUser: AdminUser,
  uid: string,
  admin: boolean
): Promise<AdminUserRecord> {
  const user = await adminAuth.getUser(uid);
  const currentClaims = (user.customClaims || {}) as Record<string, unknown>;
  const beforeAdmin = currentClaims["admin"] === true;

  const newClaims = { ...currentClaims };
  if (admin) {
    newClaims["admin"] = true;
  } else {
    delete newClaims["admin"];
  }

  await adminAuth.setCustomUserClaims(uid, newClaims);
  // Invalidate existing refresh tokens so permission changes take effect quickly
  await adminAuth.revokeRefreshTokens(uid);

  // Log to immutable audit log
  await logAdminAction(adminUser, {
    action: admin ? "role.grant_admin" : "role.revoke_admin",
    targetType: "user",
    targetId: uid,
    details: `${admin ? "Granted" : "Revoked"} admin role for ${user.email || uid}`,
    before: { isAdmin: beforeAdmin },
    after: { isAdmin: admin },
  });

  const updatedUser = await adminAuth.getUser(uid);
  return toRecord(updatedUser);
}
