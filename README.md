# More or Less Admin

Admin portal for More or Less (ops). TanStack Start + React on Cloudflare Workers.

Production: [ops.snaptapp.us](https://ops.snaptapp.us) → Worker `tanstack-start-app`.

## Stack

- TanStack Start + TanStack Router (file-based routing under `src/routes/`)
- React 19 + TypeScript
- TanStack Query, Zod, Recharts, date-fns
- Cloudflare Workers (`@cloudflare/vite-plugin` + Wrangler)

## Package manager

**npm is the only supported package manager here.** The exact version is pinned in `package.json` (`"packageManager": "npm@10.9.8"`, the npm shipped with the Node 22 LTS line CI and Workers Builds use), and `package-lock.json` is the only tracked lockfile — `pnpm-lock.yaml`, `bun.lock`, `bunfig.toml`, and `pnpm-workspace.yaml` are removed and gitignored. The tracked `.npmrc` records the install-time native-build approval (`ignore-scripts=false`) that `@firebase/util`, `esbuild`, `protobufjs`, and `workerd` need; do not set `ignore-scripts=true`, it leaves esbuild and workerd without their platform binaries.

**Install command for a clean checkout: `npm ci`.** It installs exactly what the lockfile pins and leaves `package-lock.json` untouched. Use `npm install` only when you are intentionally adding or updating a dependency (it may rewrite the lockfile).

## Develop

```sh
cp .env.example .env   # fill FIREBASE_WEB_API_KEY and ADMIN_EMAIL_ALLOWLIST locally
npm ci
npm run dev
```

`.env` is gitignored. Do not commit it.

## Quality gate

`scripts/quality-gate.mjs` is a hard, mandatory gate on every build and therefore on every deploy. It
runs its members in this fixed order and stops at the first non-zero exit, printing the failing member
name, a pointer to that member's own diagnostics, and the members it never reached:

| # | Member | What it checks | Run it alone |
| --- | --- | --- | --- |
| 1 | `Lockfile_Check` | `package-lock.json` is the only tracked lockfile | `npm run check:lockfiles` |
| 2 | `Typecheck_Step` | `tsc --noEmit` reports 0 errors | `npm run typecheck` |
| 3 | `Lint_Step` | `eslint .` reports 0 errors | `npm run lint` |
| 4 | `Suppression_Check` | no file exceeds its `suppression-baseline.json` entry | `npm run check:suppressions` |
| 5 | `Contract_Literal_Check` | admin literals derive from the consumed contract artifact | `npm run check:contract-literals` |
| 6 | `Shared_Artifact_Integrity_Check` | vendored contract and DDM digests match the manifest | `npm run check:artifacts` |
| 7 | `Ops_Assistant_Check` | Notion tools, instructions, and Ops API routes agree | `npm run check:ops-assistant` |
| 8 | `Test_Suite` | `vitest run` passes | `npm test` |
| 9 | `Contract_Drift_Check` | consumed copy matches the vendored published artifact | `npm run check:contract` |

`Contract_Drift_Check` is a member because `contract-adoption.json` records `adopted: true`. It
compares `shared/fact-lifecycle-contract.gen.ts` (the consumed copy) against the vendored published
snapshot `contract/published/fact-lifecycle-contract.gen.ts`, the path declared in
`contract-source.json`. The snapshot lives inside this repository because the gate must also pass
where no sibling checkout exists (CI, Workers Builds). After Main_Repository republishes the
contract, run `npm run sync:contract` with the `more-or-less` checkout side by side to refresh the
snapshot, then adopt the new state into `shared/` — the drift check fails closed until the copies
match again.

Two npm scripts invoke the gate:

```sh
npm run gate     # the gate alone — exits with the gate's status, writes no build output
npm run build    # node scripts/quality-gate.mjs && vite build
```

`npm run deploy` reaches it through `build`. Run `npm run gate` before pushing to reproduce the CI and
Workers Builds result locally.

**There is no bypass.** No flag, no environment variable, no branch condition, no local-versus-CI
behavior skips or downgrades a member. If the gate sees a recognized skip request (`SKIP_TESTS`,
`FORCE_DEPLOY`, `--skip-…`, and similar) it ignores the request, runs every member anyway, and writes
an "ignored" diagnostic to stderr. `Lint_Step` is deliberately run without `--max-warnings`: 1 or more
ESLint errors fail the gate, warnings alone (3 today) do not.

**A gate failure blocks the deploy.** Workers Builds project `more-or-less-ops` runs `npm run build`
and then `npx wrangler deploy`. A non-zero gate exit fails the build, so the deploy command never
runs, no new Worker version is uploaded, and the previously deployed version keeps serving
`ops.snaptapp.us`; the `Workers Builds: more-or-less-ops` check run reports the failure. Locally,
`npm run deploy` skips `wrangler` the same way.

**CI.** `.github/workflows/ci.yml` runs on every push: checkout → Node (from `.node-version`) →
`npm ci` → `npm run gate`, on the GitHub-hosted **`ubuntu-latest`** runner. The `CI / Quality gate`
check-run conclusion mirrors the gate exit code. This workflow makes the result visible early — the
gate inside `npm run build` is what actually blocks the deploy.

**Emergency deploys.** If the portal must be deployed by invoking `npx wrangler deploy` directly,
bypassing the build and deploy scripts, record it in [`EMERGENCY_DEPLOYS.md`](EMERGENCY_DEPLOYS.md):
the deployed commit id, the operator, the reason for the bypass, and every gate member that was
failing or not run. `main` must return to a passing gate within 24 hours of that entry. The log is
currently empty.

### Deploy-blocking: confirmed vs. not yet observed

The blocking chain above is established by configuration, and the check-run reporting shape by past
runs. **A Workers Builds run in which the gate actually failed has not happened yet**, so the last
links are inferred rather than observed. Recorded so a later reader does not mistake one for the other.

Confirmed by configuration and local scripts:

- `package.json` → `"build": "node scripts/quality-gate.mjs && vite build"`. The `&&` short-circuits, so
  a non-zero gate exit means `vite build` never runs.
- `scripts/quality-gate.mjs` exits with the failing member's status (`process.exit(outcome.exitCode)`)
  and never writes to `dist/` — it produces no build output at all, failing or passing.
- Workers Builds project `more-or-less-ops` is configured with build command `npm run build` and deploy
  command `npx wrangler deploy` (see [Continuous deployment](#continuous-deployment-cloudflare-workers-builds)).
  Workers Builds runs the deploy command only after the build command exits 0.

Confirmed by real check runs (`gh api`, GitHub App `cloudflare-workers-and-pages`):

- The check-run name is exactly `Workers Builds: more-or-less-ops`, and its `details_url` points at the
  Cloudflare build page for that run.
- 13 of the last 15 commits on `main` carry that check run and every one concluded `success` (most
  recent: `5f739a4`). Two commits carry no Workers Builds check run at all.

Not yet observed — awaiting a real failing run:

- Every recorded run predates this gate (the gate work is uncommitted as of this note), so no run has
  exercised a non-zero `npm run build`. That the pipeline then **fails the build, skips
  `npx wrangler deploy`, uploads no new Worker version, leaves the prior version serving
  `ops.snaptapp.us`, and reports that check run with conclusion `failure`** follows from the build/deploy
  command split above and from Workers Builds' documented behavior. It is not an observation made here.

To verify once the gate has landed on `main` and a build has failed:

```sh
gh api repos/snaptapp/more-or-less-admin/commits/<sha>/check-runs \
  --jq '.check_runs[] | select(.name == "Workers Builds: more-or-less-ops") | {conclusion, details_url}'
npx wrangler deployments list   # the active version should still be the pre-failure one
```

Expect `"conclusion": "failure"`, a Cloudflare build log ending at the gate's failing-member report with
no `vite build` or `wrangler deploy` output after it, and `ops.snaptapp.us` still served by the version
deployed before the failing push.

### Tracked ratchet artifacts

Three tracked files hold the gate's ratchet state. The gate reads them; it never rewrites them.

- **`suppression-baseline.json`** — per-file ceiling on `Type_Suppression` occurrences (`@ts-ignore`,
  `@ts-expect-error`, explicit `any`, casts through `unknown`, eslint-disable) for every `.ts`/`.tsx`
  under `src/`. `Suppression_Check` fails when a file measures above its entry, when a file with
  occurrences has no entry, or when an entry names a path that no longer exists. Counts below baseline
  are reported on stdout and pass — lower the number in the file when you remove one.
- **`suppression-reduction-plan.md`** — for every privileged or authorization-boundary file whose
  baseline is above 0: the target of 0 and the reason each remaining occurrence persists.
- **`server-fn-auth-allowlist.json`** — the endpoints intentionally not composing `authMiddleware`
  (the `OPS_CRON_SECRET`-gated `/api/internal/daily-drafts` and the public
  `/api/public/firebase-config`), each with the mechanism applied instead. A new server function that
  is neither authorized nor listed fails the `Test_Suite`; so does a stale entry.

## Notion Ops Assistant (`ntn`)

Custom Agent tools are the workers in `notion-workers/`. They call `https://ops.snaptapp.us` with bearer `OPS_ASSISTANT_SECRET`. `ntn workers env set` stores variables on the Notion worker. A later `ntn workers deploy` leaves them in place, so the token is set once.

Workspace: Trackdub `01454199-cd94-8168-873e-00038ccb0750`. Factbank worker: `more-or-less-factbank` (`01a0fb75-8c71-77fc-b769-0d2f008a8bd9`). `workers.json` is gitignored and is created by the first deploy in that directory. If `ntn` is not on `PATH`, use the copy installed next to mise’s Node 22.

```sh
ntn login
ntn whoami
ntn workers list

cd notion-workers/more-or-less-factbank
ntn workers deploy --name more-or-less-factbank --yes
ntn workers env set OPS_API_BASE_URL=https://ops.snaptapp.us OPS_ASSISTANT_SECRET=...
ntn workers env list
ntn workers deploy
ntn workers exec factbank_health -d '{}'
ntn workers exec factbank_health --local -d '{}'
```

Remote `exec` uses the worker’s stored env. `--local` reads a gitignored `.env` in that directory.

Cloudflare inspector, from `notion-workers/cloudflare-state-inspector`:

```sh
ntn workers deploy --name cloudflare-state-inspector --yes
ntn workers env set CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
ntn workers exec production_health -d '{"project":"more-or-less"}'
```

From the repo root, add `--worker-id 01a0fb75-8c71-77fc-b769-0d2f008a8bd9` on factbank `env` and `exec` commands. Put the same `OPS_ASSISTANT_SECRET` on the live ops Worker:

```sh
npx wrangler secret put OPS_ASSISTANT_SECRET --name more-or-less-ops
```

`ops.snaptapp.us` is served by `more-or-less-ops`. The `name` in `wrangler.jsonc` is `tanstack-start-app`, and secrets on that Worker do not reach the hostname. Do not reuse `OPS_CRON_SECRET` or set `OPS_ASSISTANT_ALLOW_CRON_FALLBACK` in production. Do not commit or print either secret.

The CLI cannot connect workers to the agent or enable their tools. In Notion, open **More-or-Less Ops Assistant** → Settings → Tools and access and enable the worker tools. The instructions themselves are the agent's Instructions page (`fb6dfb7d-5260-4ca8-abc1-5d2a3a998f8a`). Replace that page from `notion-workers/AGENT_INSTRUCTIONS.md`:

```sh
ntn api -X PATCH /v1/pages/fb6dfb7d-5260-4ca8-abc1-5d2a3a998f8a/markdown -d @body.json
```

`body.json` is `{ "type": "replace_content", "replace_content": { "new_str": "<markdown>" } }`. Do not commit that file.

## Deploy (local)

```sh
npm run deploy
```

Runs the quality gate, then the Vite build, then `wrangler deploy` — a gate failure stops before
`wrangler`. Requires Wrangler auth and Worker secret `FIREBASE_SERVICE_ACCOUNT_JSON` (already set in
production).

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

The npm-only migration leaves these unchanged: the build command stays `npm run build` and the deploy command stays `npx wrangler deploy`, so Workers Builds needs no reconfiguration. `npm run build` now runs the [quality gate](#quality-gate) first, so a failing check fails the build here and the deploy command never runs.

1. Keep runtime secrets on the Worker (**Settings → Variables and Secrets**). Do not put `FIREBASE_SERVICE_ACCOUNT_JSON` or `GO_AGENT_SERVICE_ACCOUNT_JSON` in `wrangler.jsonc`. `FIREBASE_WEB_API_KEY` in `vars` is the publishable Firebase web key used by browser sign-in, not a service-account credential. `ADMIN_EMAIL_ALLOWLIST` may be set as a Worker secret of the same name (secret wins over the bootstrap var).
2. Daily Blitz authoring (`/admin/daily`) calls the Go pack factory on Cloud Run (`GO_AGENT_URL` var) and a swappable chat backend (`OPS_CHAT_BACKEND`, default `gemini`) for the strategist. The ops service account needs `roles/run.invoker` on `agent-go` and `roles/aiplatform.user` on project `more-or-less-505908`. Chat never publishes: Apply cards load the editor, Save & Schedule writes `daily_packs`. Autonomous cron (`POST /api/internal/daily-drafts` with `OPS_CRON_SECRET`) writes `daily_pack_drafts` only. Content (`/admin/facts`) uses the same chat rail to enqueue crawls; Fact Foundry is the only `fact_bank` writer. Foundry-generated facts land as `status: pending` (never served/exported) until the banked-fact auditor promotes them — filter the facts list by `pending` to review the unverified queue; a manual "Mark active" is a human-verified promote.
3. Push or merge to `main` to trigger a production deploy. Preview branches upload a version only.

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

## Clef Fact Auto-Triage (`fact_triage/` Sidecar)

The Admin Worker incorporates Cloudflare's native `@cf/cloudflare/clef` (27B parameter decision model) via the `env.AI` binding in `wrangler.jsonc` (`src/lib/admin/clef-triage.server.ts`):
- **Structured Assessment:** Exposes `triageFactCandidate` (not yet wired into submit/import flows) to assess fact candidates for objective verifiability (`is_objectively_verifiable`, noul), subjectivity (`is_subjective`, noul), and counter-intuitiveness (`surprise_factor`, score 0–3).
- **Data Boundary & Contract Isolation:** Triage results are written strictly to the sidecar collection `fact_triage/{factId}`. Canonical `facts` documents remain untouched to preserve `ALLOWED_FIELDS` in `fact-admission.ts` and ensure that only the Fact Foundry promoter elevates facts to active status.
- **Fail-Closed Reporting:** Partial or malformed Clef evaluations mark the record as `status: "triage_failed"` with error details, rather than synthesizing false confidence or default values.
