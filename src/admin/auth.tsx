import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { User } from "firebase/auth";
import { getFirebaseClient } from "@/lib/firebase/client";

interface AdminAuthState {
  user: User | null;
  ready: boolean;
  error: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOutAdmin: () => Promise<void>;
}

const AdminAuthContext = createContext<AdminAuthState | null>(null);

export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const { auth } = await getFirebaseClient();
        const { onAuthStateChanged } = await import("firebase/auth");
        if (cancelled) return;
        unsubscribe = onAuthStateChanged(auth, (next) => {
          setUser(next);
          setReady(true);
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Firebase is not configured");
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    setError(null);
    const { auth } = await getFirebaseClient();
    const { signInWithEmailAndPassword } = await import("firebase/auth");
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Sign-in failed";
      setError(message.replace("Firebase: ", ""));
      throw cause;
    }
  }, []);

  const signOutAdmin = useCallback(async () => {
    const { auth } = await getFirebaseClient();
    const { signOut } = await import("firebase/auth");
    await signOut(auth);
  }, []);

  const value = useMemo<AdminAuthState>(
    () => ({ user, ready, error, signIn, signOutAdmin }),
    [user, ready, error, signIn, signOutAdmin],
  );

  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}

export function useAdminAuth(): AdminAuthState {
  const context = useContext(AdminAuthContext);
  if (!context) throw new Error("useAdminAuth must be used inside AdminAuthProvider");
  return context;
}
