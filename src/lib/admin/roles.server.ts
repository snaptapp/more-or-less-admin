/**
 * Firebase Authentication user & role management via the Identity Toolkit
 * REST API. Runs on the Worker runtime — no firebase-admin SDK.
 *
 * Roles are stored as custom claims (e.g. { admin: true }); the admin gate
 * in verify.server.ts reads them from the user's ID token.
 */

import { getAccessToken, getServiceAccount } from "@/lib/firebase/credentials.server";

const IDENTITY_SCOPES = [
  "https://www.googleapis.com/auth/identitytoolkit",
  "https://www.googleapis.com/auth/userinfo.email",
];

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

interface RawUser {
  localId: string;
  email?: string;
  displayName?: string;
  emailVerified?: boolean;
  disabled?: boolean;
  customAttributes?: string;
  createdAt?: string;
  lastLoginAt?: string;
  mfaInfo?: unknown[];
}

function baseUrl(): string {
  return `https://identitytoolkit.googleapis.com/v1/projects/${getServiceAccount().project_id}`;
}

function toRecord(raw: RawUser): AdminUserRecord {
  let claims: Record<string, unknown> = {};
  if (raw.customAttributes) {
    try {
      claims = JSON.parse(raw.customAttributes) as Record<string, unknown>;
    } catch {
      claims = {};
    }
  }
  return {
    uid: raw.localId,
    email: raw.email ?? null,
    displayName: raw.displayName ?? null,
    emailVerified: raw.emailVerified === true,
    disabled: raw.disabled === true,
    isAdmin: claims["admin"] === true,
    mfaEnrolled: Array.isArray(raw.mfaInfo) && raw.mfaInfo.length > 0,
    createdAt: raw.createdAt ? new Date(Number(raw.createdAt)).toISOString() : null,
    lastSignInAt: raw.lastLoginAt ? new Date(Number(raw.lastLoginAt)).toISOString() : null,
  };
}

async function callApi(path: string, body: Record<string, unknown>): Promise<Response> {
  const token = await getAccessToken(IDENTITY_SCOPES);
  const response = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Identity Toolkit request failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return response;
}

/** Lists all Firebase Auth users (paginated). */
export async function listAuthUsers(): Promise<AdminUserRecord[]> {
  const users: AdminUserRecord[] = [];
  let nextPageToken: string | undefined;
  do {
    const response = await callApi("/accounts:batchGet", {
      maxResults: 500,
      ...(nextPageToken ? { nextPageToken } : {}),
    });
    const payload = (await response.json()) as {
      users?: RawUser[];
      nextPageToken?: string;
    };
    for (const raw of payload.users ?? []) users.push(toRecord(raw));
    nextPageToken = payload.nextPageToken;
  } while (nextPageToken);
  users.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return users;
}

function readClaims(raw: RawUser | undefined): Record<string, unknown> {
  if (!raw?.customAttributes) return {};
  try {
    return JSON.parse(raw.customAttributes) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Grants or revokes the admin custom claim, merging with existing claims. */
export async function setAdminClaim(uid: string, admin: boolean): Promise<AdminUserRecord> {
  // Read current claims first — accounts:update replaces customAttributes wholesale.
  const lookup = await callApi("/accounts:lookup", { localId: [uid] });
  const lookupPayload = (await lookup.json()) as { users?: RawUser[] };
  const current = lookupPayload.users?.[0];
  if (!current) throw new Error("User not found");

  const claims = readClaims(current);
  if (admin) claims["admin"] = true;
  else delete claims["admin"];

  const response = await callApi("/accounts:update", {
    localId: uid,
    customAttributes: JSON.stringify(claims),
  });
  const payload = (await response.json()) as { localId: string };
  return toRecord({ ...current, localId: payload.localId, customAttributes: JSON.stringify(claims) });
}
