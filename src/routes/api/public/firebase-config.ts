import { createFileRoute } from "@tanstack/react-router";

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
        const apiKey = process.env["FIREBASE_WEB_API_KEY"];
        if (!apiKey) {
          return new Response(JSON.stringify({ error: "Firebase web API key is not configured" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
        const { getServiceAccount } = await import("@/lib/firebase/credentials.server");
        const projectId = getServiceAccount().project_id;
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
