# AGENTS.md — More or Less Admin

> More or Less ops portal. Game services and fact writes belong to `snaptapp/more-or-less`. See [README.md](./README.md) and [quality gate](./docs/QUALITY_GATE.md).

## Critical Invariants

1. **Deploy:** `main` auto-deploys via Workers Builds (`npm run build` → `wrangler deploy`); the build runs the quality gate. Never bypass a failed gate.
2. **Packages:** npm only, pinned `npm@10.9.8`; `npm ci`, `package-lock.json` only. `.npmrc` needs `ignore-scripts=false`.
3. **Typecheck:** TypeScript 7 (`typescript7`) for checking; TypeScript 5 for ESLint/AST until tooling converges.
4. **Secrets:** Service account JSON belongs in Worker secrets, never `wrangler.jsonc`; `FIREBASE_WEB_API_KEY` is publishable. `OPS_ASSISTANT_SECRET` belongs on the live ops Worker `more-or-less-ops` and on the Notion factbank worker, as the same value. Set Notion worker env once with `ntn workers env set`; later `ntn workers deploy` keeps it. Do not print the secret, commit it, reuse `OPS_CRON_SECRET`, or set `OPS_ASSISTANT_ALLOW_CRON_FALLBACK` in production.
5. **Fact writes:** Indexes live in `more-or-less`. Admin creates/imports/report-adds as `pending` only; Foundry alone promotes to `active`. Follow contract-authorized moderation transitions; subject/angle are immutable. Reconciler alone writes `fact_count`. Admin never writes deployed `fact_bank.json`; players receive changes through export → hydration PR → Worker deployment.
6. **DDM-4:** Consume exact vendored kernel/tables/adapters/fixtures, never reimplement or hand-edit them; fail closed on local digest or read-only upstream freshness failure.
7. **Reconciliation:** Report only, never mutate Firestore or write `fact_count` from reconciliation.
8. **Mobile UI:** Put shared overflow and touch rules in Arena tokens; use the admin drawer and labelled mobile record cards, retaining desktop tables and actions, because the public root redirects to Admin.

## Essential Commands

```sh
npm ci && npm run dev             # Local dev (cp .env.example .env first)
npm run gate                      # Run Quality_Gate alone (pre-push check)
npm run build                     # Quality_Gate + vite build (Workers Builds command)
npm run deploy                    # Manual production deploy (build -> wrangler deploy)
```

## Notion workers (`ntn`)

Ops Assistant tools live in `notion-workers/`. Workspace Trackdub `01454199-cd94-8168-873e-00038ccb0750`. Factbank worker id `01a0fb75-8c71-77fc-b769-0d2f008a8bd9`. `ntn` is the Notion CLI; if it is missing from `PATH`, it is installed next to the mise Node 22 binary. `workers.json` is gitignored and appears after the first deploy. The CLI cannot attach worker tools. That stays in the agent Settings UI. The agent's instructions are the page parented by the agent (`fb6dfb7d-5260-4ca8-abc1-5d2a3a998f8a`). Replace that page from `notion-workers/AGENT_INSTRUCTIONS.md` with `ntn api -X PATCH /v1/pages/<id>/markdown`.

```sh
ntn login
ntn whoami
ntn workers list

# First create, from the worker directory. Deploy before env set.
cd notion-workers/more-or-less-factbank
ntn workers deploy --name more-or-less-factbank --yes
ntn workers env set OPS_API_BASE_URL=https://ops.snaptapp.us OPS_ASSISTANT_SECRET=...
ntn workers env list

# Code updates keep the remote env.
ntn workers deploy

# Remote smoke uses the worker env. --local reads .env instead.
ntn workers exec factbank_health -d '{}'
ntn workers exec factbank_health --local -d '{}'

# Inspector, once, from notion-workers/cloudflare-state-inspector.
ntn workers deploy --name cloudflare-state-inspector --yes
ntn workers env set CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
ntn workers exec production_health -d '{"project":"more-or-less"}'
```

From the repo root, pass `--worker-id 01a0fb75-8c71-77fc-b769-0d2f008a8bd9` to `env` and `exec` for the factbank worker. The matching Admin secret is `npx wrangler secret put OPS_ASSISTANT_SECRET --name more-or-less-ops`. The hostname `ops.snaptapp.us` is that worker. `wrangler.jsonc` name `tanstack-start-app` does not serve it.
