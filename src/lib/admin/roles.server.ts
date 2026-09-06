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

async function callApi(
  path: string,
  options: { method?: "GET" | "POST"; body?: Record<string, unknown>; params?: Record<string, string> } = {},
): Promise<Response> {
  const token = await getAccessToken(IDENTITY_SCOPES);
  const projectId = getServiceAccount().project_id;
  const url = new URL(`${baseUrl()}${path}`);
  if (options.params) {
    for (const [key, val] of Object.entries(options.params)) {
      if (val) url.searchParams.set(key, val);
    }
  }

  const method = options.method ?? "POST";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "x-goog-user-project": projectId,
  };
  if (method === "POST") {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url.toString(), {
    method,
    headers,
    body: method === "POST" && options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Identity Toolkit request failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return response;
}

/** Lists all Firebase Auth users, deduplicated by email (one record per real person). */
export async function listAuthUsers(): Promise<AdminUserRecord[]> {
  const users: AdminUserRecord[] = [];
  let nextPageToken: string | undefined;
  do {
    const response = await callApi("/accounts:batchGet", {
      method: "GET",
      params: {
        maxResults: "500",
        ...(nextPageToken ? { nextPageToken } : {}),
      },
    });
    const payload = (await response.json()) as {
      users?: RawUser[];
      nextPageToken?: string;
    };
    for (const raw of payload.users ?? []) users.push(toRecord(raw));
    nextPageToken = payload.nextPageToken;
  } while (nextPageToken);

  // Group by lowercase email — one row per real person.
  // Users with no email (anonymous) are kept as individual rows.
  const byEmail = new Map<string, AdminUserRecord[]>();
  const noEmail: AdminUserRecord[] = [];
  for (const user of users) {
    const key = user.email?.toLowerCase() ?? "";
    if (!key) { noEmail.push(user); continue; }
    const group = byEmail.get(key) ?? [];
    group.push(user);
    byEmail.set(key, group);
  }

  const deduped: AdminUserRecord[] = [];
  for (const group of byEmail.values()) {
    // Canonical record: prefer admin, then most-recently-signed-in.
    const canonical =
      group.find((u) => u.isAdmin) ??
      group.sort((a, b) => (b.lastSignInAt ?? "").localeCompare(a.lastSignInAt ?? ""))[0];
    deduped.push(canonical);
  }
  for (const u of noEmail) deduped.push(u);

  deduped.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return deduped;
}

function readClaims(raw: RawUser | undefined): Record<string, unknown> {
  if (!raw?.customAttributes) return {};
  try {
    return JSON.parse(raw.customAttributes) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Grants or revokes the admin custom claim on the UID, and mirrors the state
 *  to entitlements/{email} so the onUserCreated trigger propagates it to any
 *  future UIDs created for the same email address. */
export async function setAdminClaim(
  uid: string,
  admin: boolean,
  entitlementsWriter?: (email: string, isAdmin: boolean) => Promise<void>,
): Promise<AdminUserRecord> {
  // Read current claims first — accounts:update replaces customAttributes wholesale.
  const lookup = await callApi("/accounts:lookup", { method: "POST", body: { localId: [uid] } });
  const lookupPayload = (await lookup.json()) as { users?: RawUser[] };
  const current = lookupPayload.users?.[0];
  if (!current) throw new Error("User not found");

  const claims = readClaims(current);
  if (admin) claims["admin"] = true;
  else delete claims["admin"];

  const response = await callApi("/accounts:update", {
    method: "POST",
    body: {
      localId: uid,
      customAttributes: JSON.stringify(claims),
    },
  });
  const payload = (await response.json()) as { localId: string };
  const updated = toRecord({ ...current, localId: payload.localId, customAttributes: JSON.stringify(claims) });

  // Mirror to entitlements/{email} for future-UID propagation.
  if (current.email && entitlementsWriter) {
    await entitlementsWriter(current.email.toLowerCase(), admin);
  }

  return updated;
}
