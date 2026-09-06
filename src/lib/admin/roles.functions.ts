import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "./middleware";

export const listAdminUsers = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async () => {
    const { listAuthUsers } = await import("./roles.server");
    return listAuthUsers();
  });

export const setAdminRole = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator((data) => z.object({ uid: z.string().min(1), admin: z.boolean() }).parse(data))
  .handler(async ({ data, context }) => {
    const caller = context.user;
    if (caller.uid === data.uid && !data.admin) {
      throw new Error("You cannot revoke your own admin access");
    }
    const { setAdminClaim } = await import("./roles.server");
    const { logAdminAction } = await import("@/lib/firebase/audit.server");
    const { patchDoc } = await import("@/lib/firebase/firestore.server");

    // Write isAdmin to entitlements/{email} so the onUserCreated trigger
    // propagates the claim to any future UIDs for the same email address.
    const entitlementsWriter = async (email: string, isAdmin: boolean) => {
      await patchDoc(`entitlements/${email}`, {
        isAdmin,
        grantedAt: new Date().toISOString(),
        grantedBy: caller.email ?? caller.uid,
      });
    };

    const updated = await setAdminClaim(data.uid, data.admin, entitlementsWriter);
    await logAdminAction(caller, {
      action: data.admin ? "grant_admin" : "revoke_admin",
      targetType: "user",
      targetId: data.uid,
      details: `${caller.email ?? caller.uid} ${data.admin ? "granted" : "revoked"} admin for ${updated.email ?? data.uid}`,
    });
    return updated;
  });

export const fetchAuditLogEntries = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async () => {
    const { listAuditLogs } = await import("@/lib/firebase/audit.server");
    return listAuditLogs(100);
  });
