import { getApps, initializeApp, cert, applicationDefault, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getStorage, type Storage } from "firebase-admin/storage";

let adminAppInstance: App | null = null;

function getCredential() {
  const rawJson = process.env["FIREBASE_SERVICE_ACCOUNT_JSON"];
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson);
      if (parsed.private_key) {
        parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
      }
      return cert(parsed);
    } catch {
      console.warn("[Firebase Admin] Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON, falling back to applicationDefault");
    }
  }
  return applicationDefault();
}

export function getAdminApp(): App {
  if (adminAppInstance) return adminAppInstance;
  const existing = getApps();
  if (existing.length > 0) {
    adminAppInstance = existing[0];
    return adminAppInstance;
  }

  const projectId =
    process.env["FIREBASE_PROJECT_ID"] ||
    process.env["GOOGLE_CLOUD_PROJECT"] ||
    "more-or-less-505908";

  adminAppInstance = initializeApp({
    credential: getCredential(),
    projectId,
  });

  return adminAppInstance;
}

export const adminAuth: Auth = getAuth(getAdminApp());
export const adminDb: Firestore = getFirestore(getAdminApp());
export const adminStorage: Storage = getStorage(getAdminApp());
