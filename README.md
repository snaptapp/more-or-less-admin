# More or Less Admin

Admin portal for More or Less (ops). TanStack Start + React on Cloudflare Workers.

Production: [ops.snaptapp.us](https://ops.snaptapp.us) → Worker `tanstack-start-app`.

## Stack

- TanStack Start + TanStack Router (file-based routing under `src/routes/`)
- React 19 + TypeScript
- TanStack Query, Zod, Recharts, date-fns
- Cloudflare Workers (`@cloudflare/vite-plugin` + Wrangler)

## Develop

```sh
cp .env.example .env   # fill FIREBASE_WEB_API_KEY and ADMIN_EMAIL_ALLOWLIST locally
npm install
npm run dev
```

`.env` is gitignored. Do not commit it.

## Deploy (local)

```sh
npm run deploy
```

Requires Wrangler auth and Worker secret `FIREBASE_SERVICE_ACCOUNT_JSON` (already set in production).

## Continuous deployment (Cloudflare Workers Builds)

Connect Git so every commit/PR merge to `main` builds and deploys with no CI runners.

1. Cloudflare Dashboard → **Workers & Pages** → Worker **`tanstack-start-app`** (must match `name` in `wrangler.jsonc`).
2. **Settings** → **Builds** → **Connect**.
3. Select GitHub account / org **snaptapp**, repository **more-or-less-admin**.
4. Build settings:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Non-production deploy | `npx wrangler versions upload` (default) |
| Root directory | `/` (repo root) |

5. Keep runtime secrets on the Worker (**Settings → Variables and Secrets**). Do not put `FIREBASE_SERVICE_ACCOUNT_JSON` or `GO_AGENT_SERVICE_ACCOUNT_JSON` in `wrangler.jsonc`. `FIREBASE_WEB_API_KEY` in `vars` is the publishable Firebase web key used by browser sign-in, not a service-account credential. `ADMIN_EMAIL_ALLOWLIST` may be set as a Worker secret of the same name (secret wins over the bootstrap var).
6. Daily Blitz authoring (`/admin/daily`) calls the Go pack factory on Cloud Run (`GO_AGENT_URL` var) and Vertex Gemini for the strategist chat. The ops service account needs `roles/run.invoker` on `agent-go` and `roles/aiplatform.user` on project `more-or-less-505908`.
7. Push or merge to `main` to trigger a production deploy. Preview branches upload a version only.

Alternatively: **Workers & Pages** → **Create** → **Import a repository** → same settings. Worker name must stay `tanstack-start-app` so it continues serving `ops.snaptapp.us`.

## Firestore indexes (occasional)

Worker deploys do **not** update Firestore indexes. When admin (or game) code adds composite / collection-group queries that need new indexes, deploy them from the main **more-or-less** repo (project `more-or-less-505908`):

```sh
cd ../more-or-less   # or your checkout of snaptapp/more-or-less
firebase deploy --only firestore:indexes
```

Do this when:

- Firestore returns a failed-precondition / “requires an index” link
- You add multi-field filters, inequality + orderBy, or collection-group queries
- You change `firestore.indexes.json` in the game repo (`snaptapp/more-or-less`)

**Game analytics** (`users/*/game_history`) needs collection-group indexes on `playedAt` (ASC and DESC). Those live in the game repo’s `firestore.indexes.json` fieldOverrides. Without them, Overview “Games (7d)” count may work while Game analytics / mode pies fail or fall back.

Single-field equality/`count()` aggregations usually need no new composite index. Index builds can take minutes after deploy; keep the console link until status is Enabled.
