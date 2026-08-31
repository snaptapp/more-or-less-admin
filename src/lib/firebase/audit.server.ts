import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./admin.server";
import type { AdminUser } from "./verify.server";

export type JsonValue = string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[];

export interface AuditLogEntry {
  id?: string;
  adminUid: string;
  adminEmail: string | null;
  action: string;
  targetType: "fact" | "report" | "user" | "subject" | "crawl_job" | "daily_pack" | "leaderboard" | "system";
  targetId: string;
  details?: string;
  before?: Record<string, any> | null;
  after?: Record<string, any> | null;
  createdAt?: string | null;
}

export async function logAdminAction(
  adminUser: AdminUser,
  entry: Omit<AuditLogEntry, "adminUid" | "adminEmail" | "createdAt">,
  transaction?: FirebaseFirestore.Transaction
): Promise<void> {
  const collectionRef = adminDb.collection("admin_audit_logs");
  const docRef = collectionRef.doc();
  const payload = {
    adminUid: adminUser.uid,
    adminEmail: adminUser.email,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    details: entry.details ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    createdAt: FieldValue.serverTimestamp(),
  };

  if (transaction) {
    transaction.set(docRef, payload);
  } else {
    await docRef.set(payload);
  }
}

export async function listAuditLogs(limitCount = 100): Promise<AuditLogEntry[]> {
  const snapshot = await adminDb
    .collection("admin_audit_logs")
    .orderBy("createdAt", "desc")
    .limit(limitCount)
    .get();

  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      adminUid: data["adminUid"] as string,
      adminEmail: (data["adminEmail"] as string) || null,
      action: data["action"] as string,
      targetType: data["targetType"] as AuditLogEntry["targetType"],
      targetId: data["targetId"] as string,
      details: (data["details"] as string) || undefined,
      before: (data["before"] as Record<string, any>) || null,
      after: (data["after"] as Record<string, any>) || null,
      createdAt: data["createdAt"]?.toDate
        ? data["createdAt"].toDate().toISOString()
        : null,
    };
  });
}
