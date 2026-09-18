import { createDoc, runQuery, type FirestoreDoc } from "./firestore.server";
import type { AdminUser } from "./verify.server";

export type JsonValue = string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[];

/**
 * Payload accepted on the write side of the audit log.
 *
 * Callers hand us plain JS records whose values the Firestore encoder
 * serializes (`encodeFields`), so the input is deliberately wider than the
 * `JsonValue` that comes back out of Firestore on the read side.
 */
export type AuditPayload = JsonValue | Record<string, unknown>;

/**
 * An audit log entry as read from Firestore and transported to the client.
 *
 * `before` / `after` are `JsonValue` because that is what Firestore returns
 * (`FirestoreDoc.data` is `Record<string, Json>`) and because the TanStack
 * Start serializer must be able to validate every field of this type.
 */
export interface AuditLogEntry {
  id?: string;
  adminUid: string;
  adminEmail: string | null;
  action: string;
  targetType: "fact" | "report" | "user" | "subject" | "playlist" | "crawl_job" | "daily_pack" | "leaderboard" | "system";
  targetId: string;
  details?: string;
  before?: JsonValue | null;
  after?: JsonValue | null;
  createdAt?: string | null;
}

/** The shape a caller supplies to {@link logAdminAction}. */
export type AuditLogInput = Omit<
  AuditLogEntry,
  "adminUid" | "adminEmail" | "createdAt" | "before" | "after"
> & {
  before?: AuditPayload | null;
  after?: AuditPayload | null;
};

export async function logAdminAction(adminUser: AdminUser, entry: AuditLogInput): Promise<void> {
  const payload = {
    adminUid: adminUser.uid,
    adminEmail: adminUser.email,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    details: entry.details ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    createdAt: new Date().toISOString(),
  };

  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await createDoc("admin_audit_logs", id, payload);
}

export async function listAuditLogs(limitCount = 100): Promise<AuditLogEntry[]> {
  const docs = await runQuery({
    collection: "admin_audit_logs",
    orderBy: { field: "createdAt", direction: "DESCENDING" },
    limit: limitCount,
  });

  return docs.map((doc: FirestoreDoc) => {
    const data = doc.data;
    return {
      id: doc.id,
      adminUid: String(data["adminUid"] ?? ""),
      adminEmail: data["adminEmail"] ? String(data["adminEmail"]) : null,
      action: String(data["action"] ?? ""),
      targetType: (data["targetType"] as AuditLogEntry["targetType"]) ?? "system",
      targetId: String(data["targetId"] ?? ""),
      details: data["details"] ? String(data["details"]) : undefined,
      before: data["before"] ?? null,
      after: data["after"] ?? null,
      createdAt: typeof data["createdAt"] === "string" ? data["createdAt"] : null,
    };
  });
}
