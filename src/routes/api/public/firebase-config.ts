import { createFileRoute } from "@tanstack/react-router";
import { getAdminApp } from "@/lib/firebase/admin.server";

/**
 * Publishable Firebase web config for the admin sign-in form.
 *
 * A plain HTTP route rather than a server function: server functions run the
 * global auth middleware, which itself needs this config to mint a token.
 * Only publishable values are returned — the service account stays server-side.
 */
export const Route = createFileRoute("/api/public/firebase-config")({
  server: {
    handlers: {
      GET: async () => {
        const apiKey =
          process.env["FIREBASE_WEB_API_KEY"] ||
          "AIzaSyBLNZLQZkus4CutqPTS7LmfVDD0rao2qwo";
        const app = getAdminApp();
        const projectId =
          app.options.projectId ||
          process.env["FIREBASE_PROJECT_ID"] ||
          process.env["GOOGLE_CLOUD_PROJECT"] ||
          "more-or-less-505908";

        return Response.json(
          {
            apiKey,
            authDomain: `${projectId}.firebaseapp.com`,
            projectId,
          },
          { headers: { "Cache-Control": "private, max-age=300" } },
        );
      },
    },
  },
});
