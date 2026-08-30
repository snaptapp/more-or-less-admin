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
  resetPassword: (email: string) => Promise<void>;
  signOutAdmin: () => Promise<void>;
}

const AdminAuthContext = createContext<AdminAuthState | null>(null);

function messageOf(cause: unknown, fallback: string): string {
  const raw = cause instanceof Error ? cause.message : fallback;
  if (raw.includes("app-check-token-is-invalid")) {
    return "Firebase App Check is enforced on this project. Disable enforcement for Authentication in the Firebase Console (App Check → APIs → Authentication), or register this app's site key.";
  }
  return raw.replace("Firebase: ", "");
}

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
        setError(messageOf(cause, "Firebase is not configured"));
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
      setError(messageOf(cause, "Sign-in failed"));
      throw cause;
    }
  }, []);

  const resetPassword = useCallback(async (email: string) => {
    setError(null);
    const { auth } = await getFirebaseClient();
    const { sendPasswordResetEmail } = await import("firebase/auth");
    try {
      await sendPasswordResetEmail(auth, email);
    } catch (cause) {
      setError(messageOf(cause, "Password reset failed"));
      throw cause;
    }
  }, []);

  const signOutAdmin = useCallback(async () => {
    const { auth } = await getFirebaseClient();
    const { signOut } = await import("firebase/auth");
    await signOut(auth);
  }, []);

  const value = useMemo<AdminAuthState>(
    () => ({ user, ready, error, signIn, resetPassword, signOutAdmin }),
    [user, ready, error, signIn, resetPassword, signOutAdmin],
  );

  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}

export function useAdminAuth(): AdminAuthState {
  const context = useContext(AdminAuthContext);
  if (!context) throw new Error("useAdminAuth must be used inside AdminAuthProvider");
  return context;
}
