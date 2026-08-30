import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
}

let appPromise: Promise<{ app: FirebaseApp; auth: Auth; config: FirebaseWebConfig }> | null = null;

/** Lazily initialises the browser Firebase app using server-provided config. */
export function getFirebaseClient() {
  if (!appPromise) {
    appPromise = (async () => {
      const response = await fetch("/api/public/firebase-config");
      if (!response.ok) throw new Error("Firebase config is unavailable");
      const config = (await response.json()) as FirebaseWebConfig;
      const app = getApps()[0] ?? initializeApp(config);
      return { app, auth: getAuth(app), config };
    })();
    appPromise.catch(() => {
      appPromise = null;
    });
  }
  return appPromise;
}

/** Current user's ID token, or null when signed out. */
export async function getIdToken(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  try {
    const { auth } = await getFirebaseClient();
    await auth.authStateReady();
    return auth.currentUser ? await auth.currentUser.getIdToken() : null;
  } catch {
    return null;
  }
}
