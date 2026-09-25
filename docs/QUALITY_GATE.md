# Quality Gate & Operational Boundaries

This reference documents the Admin quality gate and the cross-repo boundaries it
protects. The gate is local, mandatory, and read-only: it validates the checked-out
source and generated handoff artifacts without changing Firestore, deploying a
Worker, or dispatching a workflow.

## Quality Gate Pipeline

`scripts/quality-gate.mjs` is the mandatory pre-deploy gate. It runs members in
fixed order, stops at the first failure, and has no bypass. Recognized skip flags
or environment variables are reported and ignored.

| # | Member | Command | Standalone script | Purpose |
|---|---|---|---|---|
| 1 | `Lockfile_Check` | `node scripts/check-lockfiles.mjs` | `npm run check:lockfiles` | Ensures `package-lock.json` is the sole lockfile |
| 2 | `Typecheck_Step` | `node node_modules/typescript7/bin/tsc --noEmit` | `npm run typecheck` | TypeScript 7 check; zero errors required |
| 3 | `Lint_Step` | `eslint .` | `npm run lint` | ESLint errors fail; warnings pass |
| 4 | `Suppression_Check` | `node scripts/check-suppressions.mjs` | `npm run check:suppressions` | Enforces `suppression-baseline.json` ceilings |
| 5 | `Contract_Literal_Check` | `node scripts/check-contract-literals.mjs` | `npm run check:contract-literals` | Ensures Admin literals come from the consumed contract |
| 6 | `Shared_Artifact_Integrity_Check` | `node scripts/check-shared-artifacts.mjs` | `npm run check:artifacts` | Verifies the local consumed/published contract, DDM-4 bundle, fixtures, and manifest digests |
| 7 | `Test_Suite` | `vitest run` | `npm test` | Vitest suite |
| 8 | `Contract_Drift_Check` | `node scripts/check-contract-drift.mjs` | `npm run check:contract` | Checks the adopted consumed contract against the vendored published snapshot |

`Contract_Drift_Check` is included only when `contract-adoption.json` records
`adopted: true`. An absent or false adoption record excludes that member and
reports the reason; an unreadable adoption record fails closed. The gate itself
does not perform network I/O.

## Shared artifact integrity and freshness

- The Main repository is the source for generated contract, DDM-4 source/tables,
  and parity fixtures. Admin's `shared/ddm/` bundle is vendored, not a second
  implementation. Do not hand-edit vendored DDM files.
- `Shared_Artifact_Integrity_Check` compares every consumed and published
  handoff file byte-for-byte with the manifest's SHA-256 digests and verifies
  adoption metadata. A missing, stale, or partially synchronized bundle is not
  deployable.
- Upstream freshness is a separate read-only check (`npm run
  check:artifact-freshness`). It compares the adopted source commit and manifest
  authority with the Main repository and detects changes that have not yet been
  published/adopted. It is intentionally not part of the network-free build gate.
- The DDM-4 kernel remains the production authority. A stored Firestore block is
  untrusted input: the adapter and caller re-gate it under the current vendored
  kernel and fall back or abstain rather than trusting stale fields.

## Fact-bank lifecycle and propagation

Admin fact create/import/report-add paths are admission-only and write
`status: pending`. Foundry's banked-fact audit is the only `pending → active`
promotion. Admin may perform only contract-authorized moderation transitions;
it cannot approve a pending fact. `subject` and `angle` are immutable after
admission, and `fact_subjects.fact_count` is reconciler-owned coverage metadata,
not an Admin fact-write field.

Firestore is the canonical source truth. The deployed JSON bank in the game
Worker is the serving truth. A Firestore change becomes player-visible only
after export, hydration PR merge, and Worker deployment. The Admin deployed-
state view compares those stores; it does not mutate either one.

The edge dispute blocklist is an independent one-year KV hot-path cache. A
player dispute can remove a matching claim from the hot path immediately, but
it does not reconcile Firestore lifecycle state, update a fact status, or
synchronize at deployment time.

## Reconciliation and deployment safety

Key reconciliation is report-only: it reads a local snapshot, emits a
deterministic review report and hash, and has no production apply path. Never
turn that report into a Firestore mutation or an authoritative `fact_count`
write. This documentation does not authorize production Firestore access,
workflow dispatch, hydration-branch operations, or Worker deployment.
