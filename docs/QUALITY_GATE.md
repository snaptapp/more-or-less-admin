# Quality Gate & Deployment Reference

This reference documents the quality gate pipeline, ratchets, and deploy mechanics for More or Less Admin.
Detailed background is in [README.md](./README.md).

## Quality Gate Pipeline

`scripts/quality-gate.mjs` is the mandatory pre-deploy gate. It runs members in fixed order, stopping at the first failure. There is no bypass (`SKIP_TESTS`, `FORCE_DEPLOY`, etc. are ignored and logged to stderr).

| # | Member | Command | Standalone script | Purpose |
|---|---|---|---|---|
| 1 | `Lockfile_Check` | `node scripts/check-lockfiles.mjs` | `npm run check:lockfiles` | Ensures `package-lock.json` is the sole lockfile |
| 2 | `Typecheck_Step` | `node node_modules/typescript7/bin/tsc --noEmit` | `npm run typecheck` | TS7 compiler check (0 errors required) |
| 3 | `Lint_Step` | `eslint .` | `npm run lint` | ESLint (errors fail, warnings pass) |
| 4 | `Suppression_Check` | `node scripts/check-suppressions.mjs` | `npm run check:suppressions` | Ratchet: ensures type suppressions don't exceed `suppression-baseline.json` |
| 5 | `Contract_Literal_Check` | `node scripts/check-contract-literals.mjs` | `npm run check:contract-literals` | Ensures admin literals derive from consumed contract |
| 6 | `Test_Suite` | `vitest run` | `npm test` | Vitest test suite |
| 7 | `Contract_Drift_Check` | `node scripts/check-contract-drift.mjs` | `npm run check:contract` | Compares `shared/fact-lifecycle-contract.gen.ts` to vendored published snapshot |

### Contract Synchronization
Snapshot is vendored at `contract/published/fact-lifecycle-contract.gen.ts` (declared in `contract-source.json`).
When Main_Repository updates the contract:
```sh
npm run sync:contract   # Refresh vendored snapshot (needs sibling ../more-or-less)
```
Then adopt the changes in `shared/` to pass `Contract_Drift_Check`.

### Ratchet Artifacts
- `suppression-baseline.json`: Per-file ceilings for `Type_Suppression`. Fails if exceeded or if an entry names a removed file. Plan: `suppression-reduction-plan.md`.
- `server-fn-auth-allowlist.json`: Lists endpoints intentionally omitting `authMiddleware`. Unauthorized server functions fail `Test_Suite` unless present; stale entries also fail.

## Deployment Details

- Production deploys run automatically via **Cloudflare Workers Builds** (`more-or-less-ops` project) on push to `main`.
- Workers Builds runs `npm run build` (`scripts/quality-gate.mjs && vite build`), then `npx wrangler deploy`.
- Gate failure aborts the build, preventing `npx wrangler deploy` from running and keeping the previous worker version live.
- Manual deploy fallback: `npm run deploy` (requires wrangler auth).
- Verification: `gh api repos/snaptapp/more-or-less-admin/commits/<sha>/check-runs` or `npx wrangler deployments list`.
- Direct `wrangler deploy` bypasses must be logged in `EMERGENCY_DEPLOYS.md` and resolved within 24h.
