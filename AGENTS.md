# AGENTS.md — More or Less Admin

> Ops/admin portal for More or Less. TanStack Start + React 19 on a Cloudflare Worker (`tanstack-start-app`, serves `ops.snaptapp.us`). Companion to `snaptapp/more-or-less` — the game repo owns `fact_bank` writes, Firestore indexes, and all deployable game services.

## Deployment (read this first)

- **No GitHub Actions deploy workflow exists here.** Production deploys run through **Cloudflare Workers Builds** (project `more-or-less-ops`): every push/merge to `main` builds and deploys automatically; preview branches upload a version only.
- Workers Builds commands are **`npm run build`** (build) and **`npx wrangler deploy`** (deploy) — unchanged by the npm-only migration, so the pipeline needs no reconfiguration.
- **`npm run build` runs `Quality_Gate` before Vite.** A failing gate member fails the Workers Builds build, so `npx wrangler deploy` never runs, no new Worker version is uploaded, and the previously deployed Worker keeps serving `ops.snaptapp.us`. See § "Quality gate".
- Manual fallback: `npm run deploy` (`npm run build` — gate + vite build — then `wrangler deploy`) — needs local Wrangler auth. A gate failure skips `wrangler` here too.
- Verify a deploy: `gh api repos/snaptapp/more-or-less-admin/commits/<sha>/check-runs` → `Workers Builds: more-or-less-ops`. On a gate-blocked build that check run concludes `failure` and the pre-failure Worker version stays active (`npx wrangler deployments list`) — this failing-run path is inferred from config, not yet observed live; see `README.md` § "Deploy-blocking: confirmed vs. not yet observed".
- Setup details + build settings: `README.md` § "Continuous deployment".

## Commands

```sh
npm ci && npm run dev             # local dev (cp .env.example .env first)
npm run gate                      # Quality_Gate alone — no build output. Run before pushing.
npm run build                     # Quality_Gate, then vite build (what Workers Builds runs)
npm run deploy                    # manual production deploy (build → wrangler deploy)

# Individual gate members, for iterating on one failure:
npm run check:lockfiles           # Lockfile_Check
npm run typecheck                 # Typecheck_Step — tsc --noEmit reports 0 errors; keep it that way
npm run lint                      # Lint_Step — eslint (errors fail, warnings do not)
npm run check:suppressions        # Suppression_Check
npm test                          # Test_Suite — vitest run
```

## Quality gate

`scripts/quality-gate.mjs` is the mandatory pre-deploy gate. It runs its members in this fixed order
and stops at the first non-zero exit, reporting the failing member and the members it never reached:

| # | Member | Command | Standalone script |
| --- | --- | --- | --- |
| 1 | `Lockfile_Check` | `node scripts/check-lockfiles.mjs` | `npm run check:lockfiles` |
| 2 | `Typecheck_Step` | `node node_modules/typescript7/bin/tsc --noEmit` | `npm run typecheck` |
| 3 | `Lint_Step` | `eslint .` | `npm run lint` |
| 4 | `Suppression_Check` | `node scripts/check-suppressions.mjs` | `npm run check:suppressions` |
| 5 | `Test_Suite` | `vitest run` | `npm test` |
| — | `Contract_Drift_Check` | *excluded* | — |

`Contract_Drift_Check` is configured but not yet a member: it joins only once `contract-adoption.json`
records `adopted: true`. That file is absent today, so the gate prints the exclusion and its reason on
stdout and decides the exit code on members 1-5.

- **Two npm scripts invoke it:** `npm run gate` (gate only, produces no build output) and
  `npm run build` (`node scripts/quality-gate.mjs && vite build`). `npm run deploy` reaches it through
  `build`.
- **There is no bypass.** No flag, no environment variable, no branch condition, no local-vs-CI
  behavior. If the gate sees a recognized skip request (`SKIP_TESTS`, `FORCE_DEPLOY`, `--skip-*`, …) it
  ignores it, runs every member anyway, and writes an "ignored" diagnostic to stderr.
- **A gate failure blocks the deploy.** Workers Builds project `more-or-less-ops` runs `npm run build`
  then `npx wrangler deploy`; a non-zero gate exit fails the build, so the deploy step never runs and
  the live Worker version is untouched.
- **`Lint_Step` fails on errors only.** ESLint warnings (3 today) exit 0; 1 or more errors exit
  non-zero.
- **CI:** `.github/workflows/ci.yml` runs `npm ci` → `npm run gate` on every push, on the
  **`docker-desktop`** self-hosted runner label (the laptop ARC scale set — do not mix it with
  `self-hosted`/`lite`/`full`). The `CI / Quality gate` check-run conclusion mirrors the gate exit code.
  This workflow reports; the gate inside `npm run build` is what actually blocks the deploy.
- **Bypassing it is a logged event.** If you ever deploy by running `npx wrangler deploy` directly,
  add an entry to `EMERGENCY_DEPLOYS.md` naming the deployed commit, the operator, the reason, and
  every gate member that was failing or not run — and return `main` to a passing gate within 24 hours.
  The log is currently empty.
- **Tracked ratchet artifacts you will meet:** `suppression-baseline.json` (per-file `Type_Suppression`
  ceilings — `Suppression_Check` fails when a file exceeds its entry, and also when an entry names a
  file that no longer exists; it never rewrites the baseline) with `suppression-reduction-plan.md`
  (target 0 for privileged/boundary files, with the reason each remaining occurrence persists), and
  `server-fn-auth-allowlist.json` (the endpoints intentionally not composing `authMiddleware` and the
  mechanism used instead — a new unauthorized server function fails the `Test_Suite` unless it is
  listed, and a stale entry fails it too).

## Conventions & gotchas

- **Package manager: npm only.** Version pinned in `package.json` (`"packageManager": "npm@10.9.8"`, the npm on the Node 22 LTS line CI and Workers Builds use). `package-lock.json` is the only tracked lockfile; `pnpm-lock.yaml`, `bun.lock`, `bunfig.toml`, and `pnpm-workspace.yaml` are removed and gitignored. Never introduce pnpm/bun/yarn commands or lockfiles. The documented install command for a clean checkout is **`npm ci`** — use `npm install` only to intentionally add or update a dependency. The tracked `.npmrc` records the install-time native-build approval (`ignore-scripts=false`) required by `@firebase/util`, `esbuild`, `protobufjs`, and `workerd`.
- **TypeScript 7 compiler, TypeScript 5 API.** The typecheck compiler is the native TypeScript 7 `tsc`, installed as the npm alias `typescript7` (`npm:typescript@^7.0.2`) and invoked by `npm run typecheck` and `Typecheck_Step` as `node node_modules/typescript7/bin/tsc --noEmit`. `typescript@7` ships no JavaScript compiler API, so the `typescript` devDependency stays on `^5.9.3` for tooling that consumes it: `typescript-eslint` (whose peer range is `<6.1.0` on every release channel), the AST-audit tests that `import ts from "typescript"`, and `scripts/enumerate-server-functions.mjs`. A bare `tsc` on PATH resolves to the v5 bin; only `npm run typecheck` and the gate run v7. When a typescript-eslint release supports TypeScript 7, collapse the split: set `typescript` to `^7`, drop `typescript7`, and point the typecheck script and `Typecheck_Step.package` back at `typescript`.
- **Secrets:** never put `FIREBASE_SERVICE_ACCOUNT_JSON` / `GO_AGENT_SERVICE_ACCOUNT_JSON` in `wrangler.jsonc` — use Worker secrets. `FIREBASE_WEB_API_KEY` in `vars` is publishable by design.
- **Firestore indexes:** Worker deploys do not ship indexes. New composite/collection-group queries need `firebase deploy --only firestore:indexes` from the `more-or-less` repo (README § "Firestore indexes").
- **Fact lifecycle:** `/admin/facts` reads `fact_bank` in project `more-or-less-505908`. Statuses: `pending` (generated, awaiting the banked-fact auditor — never serves), `active`, `disputed`, `retired`. "Mark active" on a pending fact is a human-verified promote. Fact Foundry is the only `fact_bank` writer.
- **No `fact_bank` writes from admin code** beyond the `changeFactStatus`/`updateFact` moderation paths and `crawl_queue` enqueues.
- Admin repo commits go straight to `main` (matches history); Workers Builds ships them.
