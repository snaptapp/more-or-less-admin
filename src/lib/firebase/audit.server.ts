import { createDoc, runQuery, type FirestoreDoc } from "./firestore.server";
import type { AdminUser } from "./verify.server";

export type JsonValue = string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[];

export interface AuditLogEntry {
  id?: string;
  adminUid: string;
  adminEmail: string | null;
  action: string;
  targetType: "fact" | "report" | "user" | "subject" | "playlist" | "crawl_job" | "daily_pack" | "leaderboard" | "system";
  targetId: string;
  details?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  createdAt?: string | null;
}

export async function logAdminAction(
  adminUser: AdminUser,
  entry: Omit<AuditLogEntry, "adminUid" | "adminEmail" | "createdAt">,
): Promise<void> {
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
      before: (data["before"] as Record<string, unknown>) || null,
      after: (data["after"] as Record<string, unknown>) || null,
      createdAt: typeof data["createdAt"] === "string" ? data["createdAt"] : null,
    };
  });
}
