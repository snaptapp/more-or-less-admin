import { createMiddleware, createServerFn } from "@tanstack/react-start";
import { getIdToken } from "@/lib/firebase/client";
import type { AdminUser } from "@/lib/firebase/verify.server";

export const authMiddleware = createMiddleware({ type: "function" })
  .client(async ({ next }) => {
    const token = await getIdToken();
    return next({
      headers: {
        authorization: token ? `Bearer ${token}` : "",
      },
    });
  })
  .server(async ({ next }) => {
    const { requireAdmin } = await import("@/lib/firebase/verify.server");
    const user = await requireAdmin();
    return next({
      context: { user },
    });
  });

export function authedServerFn(options?: Parameters<typeof createServerFn>[0]) {
  return createServerFn(options).middleware([authMiddleware]);
}

