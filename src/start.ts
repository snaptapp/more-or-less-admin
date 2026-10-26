import { createStart, createMiddleware } from "@tanstack/react-start";
import { getIdToken } from "./lib/firebase/client";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-attacher";

/** Attaches the signed-in admin's Firebase ID token to every server call. */
const attachFirebaseAuth = createMiddleware({ type: "function" }).client(async ({ next }) => {
  const token = await getIdToken();
  return next(token ? { headers: { Authorization: `Bearer ${token}` } } : {});
});

export const startInstance = createStart(() => ({
  functionMiddleware: [attachSupabaseAuth, attachFirebaseAuth],
}));
