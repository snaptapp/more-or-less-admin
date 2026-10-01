# AGENTS.md — More or Less Admin

> More or Less ops portal. Game services and fact writes belong to `snaptapp/more-or-less`. See [README.md](./README.md) and [quality gate](./docs/QUALITY_GATE.md).

## Critical Invariants

1. **Deploy:** `main` auto-deploys via Workers Builds (`npm run build` → `wrangler deploy`); the build runs the quality gate. Never bypass a failed gate.
2. **Packages:** npm only, pinned `npm@10.9.8`; `npm ci`, `package-lock.json` only. `.npmrc` needs `ignore-scripts=false`.
3. **Typecheck:** TypeScript 7 (`typescript7`) for checking; TypeScript 5 for ESLint/AST until tooling converges.
4. **Secrets:** Service account JSON belongs in Worker secrets, never `wrangler.jsonc`; `FIREBASE_WEB_API_KEY` is publishable.
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
