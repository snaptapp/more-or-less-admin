/**
 * Forwards committed admin audit entries to Amplitude as server-side events.
 *
 * Firestore `admin_audit_logs` stays the source of truth; Amplitude is a
 * best-effort mirror for charting. Forwarding never throws and never blocks the
 * caller's write: on Workers the request is handed to `waitUntil`.
 *
 * Only identifiers and the action name are sent. `adminEmail`, `details`,
 * `before`, and `after` stay in Firestore.
 */

const AMPLITUDE_HTTP_API = "https://api2.amplitude.com/2/httpapi";
const AUDIT_COLLECTION_PREFIX = "admin_audit_logs/";

export const AUDIT_EVENT_TYPE = "Admin Action Performed";

/** Amplitude rejects a whole batch when any user_id is shorter than this. */
const MIN_USER_ID_LENGTH = 5;

export interface AmplitudeEvent {
  event_type: string;
  user_id?: string;
  device_id?: string;
  time?: number;
  insert_id: string;
  event_properties: Record<string, string>;
}

function apiKey(): string | undefined {
  if (import.meta.env.MODE === "test") return undefined;
  const key = import.meta.env.VITE_AMPLITUDE_API_KEY as string | undefined;
  return key ? key : undefined;
}

/** True when `path` names a document in the admin audit collection. */
export function isAuditPath(path: string): boolean {
  return path.replace(/^\//, "").startsWith(AUDIT_COLLECTION_PREFIX);
}

/** Map one audit document to an Amplitude event, or null when it is not an audit row. */
export function toAmplitudeEvent(
  auditId: string,
  data: Record<string, unknown>,
): AmplitudeEvent | null {
  const action = typeof data["action"] === "string" ? data["action"] : "";
  const adminUid = typeof data["adminUid"] === "string" ? data["adminUid"] : "";
  if (!auditId || !action || !adminUid) return null;

  const createdAt = typeof data["createdAt"] === "string" ? Date.parse(data["createdAt"]) : NaN;
  const event: AmplitudeEvent = {
    event_type: AUDIT_EVENT_TYPE,
    insert_id: auditId,
    event_properties: {
      action,
      target_type: typeof data["targetType"] === "string" ? data["targetType"] : "system",
      target_id: typeof data["targetId"] === "string" ? data["targetId"] : "",
      audit_id: auditId,
      admin_uid: adminUid,
    },
  };
  if (adminUid.length >= MIN_USER_ID_LENGTH) event.user_id = adminUid;
  else event.device_id = `admin:${adminUid}`;
  if (Number.isFinite(createdAt)) event.time = createdAt;
  return event;
}

async function send(key: string, events: AmplitudeEvent[]): Promise<void> {
  try {
    const response = await fetch(AMPLITUDE_HTTP_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, events }),
    });
    if (!response.ok) {
      console.warn(`Amplitude audit forward failed: HTTP ${response.status}`);
    }
  } catch (error) {
    console.warn("Amplitude audit forward failed", error);
  }
}

/**
 * Forward audit entries that have already been committed to Firestore.
 * Call only after the write succeeds, never for staged transaction writes.
 */
export async function forwardAuditEntries(
  entries: ReadonlyArray<{ id: string; data: Record<string, unknown> }>,
): Promise<void> {
  const key = apiKey();
  if (!key || entries.length === 0) return;
  const events = entries
    .map((entry) => toAmplitudeEvent(entry.id, entry.data))
    .filter((event): event is AmplitudeEvent => event !== null);
  if (events.length === 0) return;

  const pending = send(key, events);
  try {
    const { waitUntil } = await import("cloudflare:workers");
    waitUntil(pending);
  } catch {
    // Outside the Workers runtime: finish the request inline.
    await pending;
  }
}
