/**
 * Service-account credential handling for the Firebase Admin surface.
 *
 * Runs on the Cloudflare Worker runtime, so everything here uses Web Crypto
 * and fetch — the firebase-admin Node SDK is not usable in this environment.
 */

export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

let cachedAccount: ServiceAccount | null = null;

export function getServiceAccount(): ServiceAccount {
  if (cachedAccount) return cachedAccount;
  const raw = process.env["FIREBASE_SERVICE_ACCOUNT_JSON"];
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not configured");
  let parsed: ServiceAccount;
  try {
    parsed = JSON.parse(raw) as ServiceAccount;
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing required fields");
  }
  parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  cachedAccount = parsed;
  return parsed;
}

function base64UrlEncode(bytes: Uint8Array | string): string {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

const tokenCache = new Map<string, { value: string; expiresAt: number }>();

const DEFAULT_SCOPES = ["https://www.googleapis.com/auth/datastore"];

/** OAuth2 access token for the given Google API scopes, cached until near expiry. */
export async function getAccessToken(scopes: string[] = DEFAULT_SCOPES): Promise<string> {
  const scopeKey = scopes.slice().sort().join(" ");
  const now = Math.floor(Date.now() / 1000);
  const cachedToken = tokenCache.get(scopeKey);
  if (cachedToken && cachedToken.expiresAt - 60 > now) return cachedToken.value;

  const account = getServiceAccount();
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64UrlEncode(
    JSON.stringify({
      iss: account.client_email,
      scope: scopeKey,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(account.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  const assertion = `${header}.${claims}.${base64UrlEncode(new Uint8Array(signature))}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to mint Google access token (${response.status})`);
  }
  const payload = (await response.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: payload.access_token, expiresAt: now + payload.expires_in };
  return payload.access_token;
}
