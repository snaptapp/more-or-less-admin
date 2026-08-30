import { createServerFn } from "@tanstack/react-start";

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
}

/**
 * Firebase web config for the browser SDK. These are publishable values —
 * the service-account credential never leaves the server.
 */
export const getFirebaseWebConfig = createServerFn({ method: "GET" }).handler(
  async (): Promise<FirebaseWebConfig> => {
    const { getServiceAccount } = await import("./credentials.server");
    const projectId = getServiceAccount().project_id;
    return {
      apiKey: process.env["FIREBASE_WEB_API_KEY"] ?? "",
      authDomain: `${projectId}.firebaseapp.com`,
      projectId,
    };
  },
);
