import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import { getFirebaseWebConfig, type FirebaseWebConfig } from "./config.functions";

let appPromise: Promise<{ app: FirebaseApp; auth: Auth; config: FirebaseWebConfig }> | null = null;

/** Lazily initialises the browser Firebase app using server-provided config. */
export function getFirebaseClient() {
  if (!appPromise) {
    appPromise = (async () => {
      const config = await getFirebaseWebConfig();
      const app = getApps()[0] ?? initializeApp(config);
      return { app, auth: getAuth(app), config };
    })();
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
