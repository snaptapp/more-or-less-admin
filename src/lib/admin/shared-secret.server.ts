/**
 * Shared Bearer shared-secret matching for internal Ops HTTP gates.
 *
 * Used by cron (mutating) and Ops Assistant (read-only) auth paths so parsing
 * and constant-time comparison stay identical.
 */

function constantTimeEqual(expected: string, provided: string): boolean {
  const max = Math.max(expected.length, provided.length);
  let mismatch = expected.length ^ provided.length;
  for (let i = 0; i < max; i++) {
    mismatch |= (expected.charCodeAt(i) || 0) ^ (provided.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

/**
 * Returns true when Authorization carries a Bearer token that matches expected.
 * Empty expected or missing/empty token fails closed.
 */
export function bearerSecretMatches(
  authorization: string | null,
  expected: string,
): boolean {
  if (!expected) return false;
  const provided = (authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!provided) return false;
  return constantTimeEqual(expected, provided);
}
