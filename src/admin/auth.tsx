import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { MultiFactorResolver, TotpSecret, User } from "firebase/auth";
import { getFirebaseClient } from "@/lib/firebase/client";

export type SignInResult = "signed-in" | "mfa-required";

export interface TotpEnrollment {
  /** otpauth:// URL, rendered as a QR code by the caller. */
  qrUrl: string;
  /** Manual entry key for authenticator apps. */
  manualKey: string;
}

interface AdminAuthState {
  user: User | null;
  ready: boolean;
  error: string | null;
  /** True while a TOTP challenge must be completed to finish sign-in. */
  mfaPending: boolean;
  /** True when the signed-in user has a TOTP factor enrolled. */
  mfaEnrolled: boolean;
  signIn: (email: string, password: string) => Promise<SignInResult>;
  verifyMfa: (code: string) => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  beginTotpEnrollment: () => Promise<TotpEnrollment>;
  finalizeTotpEnrollment: (code: string) => Promise<void>;
  signOutAdmin: () => Promise<void>;
}

const AdminAuthContext = createContext<AdminAuthState | null>(null);

function messageOf(cause: unknown, fallback: string): string {
  const message = cause instanceof Error ? cause.message : fallback;
  return message.replace("Firebase: ", "");
}

export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mfaPending, setMfaPending] = useState(false);
  const [mfaEnrolled, setMfaEnrolled] = useState(false);
  const resolverRef = useRef<MultiFactorResolver | null>(null);
  const secretRef = useRef<TotpSecret | null>(null);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const { auth } = await getFirebaseClient();
        const { onAuthStateChanged, multiFactor } = await import("firebase/auth");
        if (cancelled) return;
        unsubscribe = onAuthStateChanged(auth, (next) => {
          setUser(next);
          setMfaEnrolled(next ? multiFactor(next).enrolledFactors.length > 0 : false);
          if (!next) {
            setMfaPending(false);
            resolverRef.current = null;
          }
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

  const signIn = useCallback(async (email: string, password: string): Promise<SignInResult> => {
    setError(null);
    const { auth } = await getFirebaseClient();
    const { signInWithEmailAndPassword, getMultiFactorResolver, AuthErrorCodes } =
      await import("firebase/auth");
    try {
      await signInWithEmailAndPassword(auth, email, password);
      return "signed-in";
    } catch (cause) {
      const code = (cause as { code?: string } | null)?.code;
      if (code === AuthErrorCodes.MFA_REQUIRED || code === "auth/multi-factor-auth-required") {
        resolverRef.current = getMultiFactorResolver(auth, cause as never);
        setMfaPending(true);
        return "mfa-required";
      }
      setError(messageOf(cause, "Sign-in failed"));
      throw cause;
    }
  }, []);

  const verifyMfa = useCallback(async (code: string) => {
    setError(null);
    const resolver = resolverRef.current;
    if (!resolver) throw new Error("No multi-factor challenge is active");
    const { TotpMultiFactorGenerator } = await import("firebase/auth");
    const hint = resolver.hints.find(
      (entry) => entry.factorId === TotpMultiFactorGenerator.FACTOR_ID,
    );
    if (!hint) {
      throw new Error("This account uses an unsupported second factor (expected authenticator app)");
    }
    try {
      const assertion = TotpMultiFactorGenerator.assertionForSignIn(hint.uid, code.trim());
      await resolver.resolveSignIn(assertion);
      resolverRef.current = null;
      setMfaPending(false);
    } catch (cause) {
      setError(messageOf(cause, "Verification failed"));
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

  const beginTotpEnrollment = useCallback(async (): Promise<TotpEnrollment> => {
    setError(null);
    const { auth } = await getFirebaseClient();
    const { multiFactor, TotpMultiFactorGenerator } = await import("firebase/auth");
    const current = auth.currentUser;
    if (!current) throw new Error("Sign in before enrolling a second factor");
    const session = await multiFactor(current).getSession();
    const secret = await TotpMultiFactorGenerator.generateSecret(session);
    secretRef.current = secret;
    return {
      qrUrl: secret.generateQrCodeUrl(current.email ?? "admin", "More or Less Admin"),
      manualKey: secret.secretKey,
    };
  }, []);

  const finalizeTotpEnrollment = useCallback(async (code: string) => {
    setError(null);
    const secret = secretRef.current;
    if (!secret) throw new Error("Start enrollment before verifying a code");
    const { auth } = await getFirebaseClient();
    const { multiFactor, TotpMultiFactorGenerator } = await import("firebase/auth");
    const current = auth.currentUser;
    if (!current) throw new Error("Sign in before enrolling a second factor");
    try {
      const assertion = TotpMultiFactorGenerator.assertionForEnrollment(secret, code.trim());
      await multiFactor(current).enroll(assertion, "Authenticator app");
      secretRef.current = null;
      setMfaEnrolled(true);
    } catch (cause) {
      setError(messageOf(cause, "Enrollment failed"));
      throw cause;
    }
  }, []);

  const signOutAdmin = useCallback(async () => {
    const { auth } = await getFirebaseClient();
    const { signOut } = await import("firebase/auth");
    resolverRef.current = null;
    secretRef.current = null;
    setMfaPending(false);
    await signOut(auth);
  }, []);

  const value = useMemo<AdminAuthState>(
    () => ({
      user,
      ready,
      error,
      mfaPending,
      mfaEnrolled,
      signIn,
      verifyMfa,
      resetPassword,
      beginTotpEnrollment,
      finalizeTotpEnrollment,
      signOutAdmin,
    }),
    [
      user,
      ready,
      error,
      mfaPending,
      mfaEnrolled,
      signIn,
      verifyMfa,
      resetPassword,
      beginTotpEnrollment,
      finalizeTotpEnrollment,
      signOutAdmin,
    ],
  );

  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}

export function useAdminAuth(): AdminAuthState {
  const context = useContext(AdminAuthContext);
  if (!context) throw new Error("useAdminAuth must be used inside AdminAuthProvider");
  return context;
}
