# AGENTS.md — More or Less Admin

> Ops/admin portal for More or Less: TanStack Start + React 19 on Cloudflare Worker (`tanstack-start-app`, serves `ops.snaptapp.us`). Game services, `fact_bank` writes, and indexes belong to `snaptapp/more-or-less`.
> Details: [README.md](./README.md) · Quality gate details: [docs/QUALITY_GATE.md](./docs/QUALITY_GATE.md).

## Critical Invariants

1. **Deploy & Quality Gate:** Commits to `main` auto-deploy via Cloudflare Workers Builds (`npm run build` → `wrangler deploy`). `npm run build` runs `scripts/quality-gate.mjs` before Vite. Gate failures block deployment. Zero-bypass policy.
2. **Package Manager: npm only.** Pinned `npm@10.9.8`. Use `npm ci`. Track only `package-lock.json` (do not add bun/pnpm/yarn). `.npmrc` requires `ignore-scripts=false`.
3. **Compiler Split:** Typechecking uses TypeScript 7 (`npm:typescript7`, `node node_modules/typescript7/bin/tsc --noEmit`). AST/ESLint uses TS 5 (`typescript` devDependency). Keep both until tooling converges.
4. **Secrets & Config:** Never put `FIREBASE_SERVICE_ACCOUNT_JSON` or `GO_AGENT_SERVICE_ACCOUNT_JSON` in `wrangler.jsonc` (use Worker secrets). `FIREBASE_WEB_API_KEY` is publishable.
5. **Data Boundaries:** Firestore indexes are deployed from `more-or-less`. Admin fact creation, CSV import, and report-add admission write `status: pending` only. Foundry is the only `pending → active` promoter; Admin may apply only contract-authorized moderation transitions. `subject` and `angle` are immutable after admission. `fact_subjects.fact_count` is reconciler-owned and is not an Admin fact-write field. Admin does not write the deployed `src/data/fact_bank.json`; Firestore changes reach players only through export → hydration PR merge → Worker deployment.
6. **DDM and artifact boundaries:** Production is DDM-4. Admin consumes the exact vendored production DDM kernel, tables, adapters, and fixtures; it must not reimplement the model or hand-edit vendored artifacts. Local digest integrity and separate read-only upstream freshness checks are fail-closed boundaries.
7. **Reconciliation safety:** Key reconciliation is report-only and has no production apply path. Never turn a review report into a Firestore mutation or a `fact_count` write.

## Essential Commands

```sh
npm ci && npm run dev             # Local dev (cp .env.example .env first)
npm run gate                      # Run Quality_Gate alone (pre-push check)
npm run build                     # Quality_Gate + vite build (Workers Builds command)
npm run deploy                    # Manual production deploy (build -> wrangler deploy)

# Gate members:
npm run check:lockfiles           # Lockfile_Check
npm run typecheck                 # Typecheck_Step (tsc --noEmit via typescript7)
npm run lint                      # Lint_Step (eslint)
npm run check:suppressions        # Suppression_Check (suppression-baseline.json)
npm run check:contract-literals   # Contract_Literal_Check
npm run check:artifacts          # Shared_Artifact_Integrity_Check
npm test                          # Test_Suite (vitest run)
npm run check:contract            # Contract_Drift_Check (sync via npm run sync:contract)
```
