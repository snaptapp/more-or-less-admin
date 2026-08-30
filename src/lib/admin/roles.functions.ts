import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "@/lib/firebase/verify.server";
import { listAuthUsers, setAdminClaim } from "./roles.server";

export const listAdminUsers = createServerFn({ method: "GET" }).handler(async () => {
  await requireAdmin();
  return listAuthUsers();
});

export const setAdminRole = createServerFn({ method: "POST" })
  .inputValidator((data) => z.object({ uid: z.string().min(1), admin: z.boolean() }).parse(data))
  .handler(async ({ data }) => {
    const caller = await requireAdmin();
    if (caller.uid === data.uid && !data.admin) {
      throw new Error("You cannot revoke your own admin access");
    }
    return setAdminClaim(data.uid, data.admin);
  });
