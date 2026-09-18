# AGENTS.md — More or Less Admin

> Ops/admin portal for More or Less. TanStack Start + React 19 on a Cloudflare Worker (`tanstack-start-app`, serves `ops.snaptapp.us`). Companion to `snaptapp/more-or-less` — the game repo owns `fact_bank` writes, Firestore indexes, and all deployable game services.

## Deployment (read this first)

- **No GitHub Actions deploy workflow exists here.** Production deploys run through **Cloudflare Workers Builds** (project `more-or-less-ops`): every push/merge to `main` builds and deploys automatically; preview branches upload a version only.
- Manual fallback: `npm run deploy` (vite build + `wrangler deploy`) — needs local Wrangler auth.
- Verify a deploy: `gh api repos/snaptapp/more-or-less-admin/commits/<sha>/check-runs` → `Workers Builds: more-or-less-ops`.
- Setup details + build settings: `README.md` § "Continuous deployment".

## Commands

```sh
npm install && npm run dev        # local dev (cp .env.example .env first)
npm run deploy                    # manual production deploy
npx tsc --noEmit                  # typecheck (pre-existing errors exist in unrelated files)
npm run lint                      # eslint
```

## Conventions & gotchas

- **Secrets:** never put `FIREBASE_SERVICE_ACCOUNT_JSON` / `GO_AGENT_SERVICE_ACCOUNT_JSON` in `wrangler.jsonc` — use Worker secrets. `FIREBASE_WEB_API_KEY` in `vars` is publishable by design.
- **Firestore indexes:** Worker deploys do not ship indexes. New composite/collection-group queries need `firebase deploy --only firestore:indexes` from the `more-or-less` repo (README § "Firestore indexes").
- **Fact lifecycle:** `/admin/facts` reads `fact_bank` in project `more-or-less-505908`. Statuses: `pending` (generated, awaiting the banked-fact auditor — never serves), `active`, `disputed`, `retired`. "Mark active" on a pending fact is a human-verified promote. Fact Foundry is the only `fact_bank` writer.
- **No `fact_bank` writes from admin code** beyond the `changeFactStatus`/`updateFact` moderation paths and `crawl_queue` enqueues.
- Admin repo commits go straight to `main` (matches history); Workers Builds ships them.
