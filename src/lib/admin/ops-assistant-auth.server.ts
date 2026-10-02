/**
 * Shared-secret gate for read-only Ops Assistant HTTP endpoints.
 *
 * Accepts Bearer tokens matching OPS_ASSISTANT_SECRET. When
 * OPS_ASSISTANT_ALLOW_CRON_FALLBACK=1, also accepts OPS_CRON_SECRET if the
 * assistant secret is unset (local/bootstrap only). No Firebase session is required.
 */

function cronFallbackAllowed(): boolean {
  const flag = (process.env["OPS_ASSISTANT_ALLOW_CRON_FALLBACK"] ?? "").trim();
  return flag === "1" || flag.toLowerCase() === "true";
}

function constantTimeEqual(expected: string, provided: string): boolean {
  const max = Math.max(expected.length, provided.length);
  let mismatch = expected.length ^ provided.length;
  for (let i = 0; i < max; i++) {
    mismatch |= (expected.charCodeAt(i) || 0) ^ (provided.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

/** Resolves the configured Ops Assistant bearer secret, if any. */
export function opsAssistantSecret(): string {
  const assistant = (process.env["OPS_ASSISTANT_SECRET"] ?? "").trim();
  if (assistant) return assistant;
  if (!cronFallbackAllowed()) return "";
  return (process.env["OPS_CRON_SECRET"] ?? "").trim();
}

/**
 * Validates an Authorization header against the Ops Assistant secret.
 *
 * @param authorization - Raw Authorization header value
 * @returns true when the Bearer token matches the configured secret
 */
export function opsAssistantSecretMatches(authorization: string | null): boolean {
  const expected = opsAssistantSecret();
  if (!expected) return false;
  const provided = (authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!provided) return false;
  return constantTimeEqual(expected, provided);
}

export type OpsAuthResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 401 | 503; readonly error: string };

/** Gate used by `/api/internal/ops/*` handlers. */
export function requireOpsAssistantAuth(authorization: string | null): OpsAuthResult {
  if (!opsAssistantSecret()) {
    return {
      ok: false,
      status: 503,
      error: "OPS_ASSISTANT_SECRET is not configured.",
    };
  }
  if (!opsAssistantSecretMatches(authorization)) {
    return { ok: false, status: 401, error: "Unauthorized." };
  }
  return { ok: true };
}
