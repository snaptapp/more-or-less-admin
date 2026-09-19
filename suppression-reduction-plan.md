# Type_Suppression reduction plan

Companion to `suppression-baseline.json`. Required by Requirement 4.6 of the
`admin-quality-gates-and-shared-contracts` spec: for every file that declares a
`Server_Function`, a `Privileged_Mutation_Path`, or a member of the
`Authorization_Boundary` **and** whose recorded baseline is greater than 0, this
file records the target count of 0 and the reason each remaining occurrence has
not yet been removed.

Measured with `scripts/check-suppressions.mjs` (`npm run check:suppressions`)
over every `.ts` / `.tsx` file under `src/`. Whole-tree total at baseline time:
**17 occurrences across 60 scanned files**.

## Scope: which files must be baselined explicitly

`suppression-baseline.json` carries an explicit measured entry for every
privileged or boundary file even when the measured count is 0, so a suppression
introduced into one of them later trips `Suppression_Check` rather than silently
becoming the new normal. The set was derived by reading the code against the
Glossary definitions, not assumed:

| Category | Files | How the set was determined |
| --- | --- | --- |
| `Authorization_Boundary` | `src/lib/admin/middleware.ts`, `src/lib/firebase/verify.server.ts` | Named directly by the Glossary (`requireAdmin` + `authMiddleware`). |
| `Server_Function` declarations | `src/lib/admin/config.functions.ts`, `src/lib/admin/content.functions.ts`, `src/lib/admin/derivation.functions.ts`, `src/lib/admin/ops.functions.ts`, `src/lib/admin/roles.functions.ts`, `src/routes/api/internal/daily-drafts.ts`, `src/routes/api/public/firebase-config.ts` | `node scripts/enumerate-server-functions.mjs --pretty` — 45 declarations across these 7 files. |
| `Privileged_Mutation_Path` | `src/lib/admin/content.server.ts`, `src/lib/admin/daily-drafts.server.ts`, `src/lib/admin/ops.server.ts`, `src/lib/admin/roles.server.ts`, `src/lib/firebase/audit.server.ts`, `src/lib/firebase/firestore.server.ts`, `src/lib/firebase/remote_config.server.ts` | Every server module reaching a Firestore write (`createDoc` / `patchDoc` / `deleteDoc` / `runTransaction`), a Firebase Auth custom-claim write (`setAdminClaim`), or a Remote Config publish (`publishTopicSuggestionsConfig`). `firestore.server.ts` is included because it *is* the write primitive layer. |

`src/lib/firebase/credentials.server.ts` mints privileged access tokens but
performs no write, so it falls outside all three Glossary categories and carries
no explicit entry. It measures 0 today and would be caught by the
unbaselined-with-occurrences rule (Requirement 4.8) if a suppression appeared in
it.

## Privileged / boundary files with a baseline above 0

Both are the same shape of problem: a domain value being widened into the
Firestore transport type `Json` from `src/lib/firebase/firestore.server.ts`
(`string | number | boolean | null | Json[] | { [key: string]: Json }`) through
`as unknown as`. None of the three is a silenced compiler complaint about
*behaviour*; each is an unwritten encoder between a domain type and the
transport type. The target for every one of them is **0**.

### `src/lib/admin/content.server.ts` — baseline 1, target 0

| Line | Form | Occurrence |
| --- | --- | --- |
| 500 | cast through `unknown` | `existing as unknown as Record<string, Json>` |

`updateFact` falls back to synthesizing the returned document when Firestore
returns no patched body, spreading the previously-read `Fact` into a
`Record<string, Json>` doc payload. `Fact` is a domain interface with no index
signature and with fields (`derivation`, nested objects) that are not declared in
terms of `Json`, so it is not assignable to the transport type.

**Why it persists:** removing it needs a real `Fact` → `Record<string, Json>`
encoder, which is a change to the shape of the fact record itself rather than to
the five typecheck errors this phase resolves. Writing that encoder without test
coverage over `updateFact` would be the riskiest possible edit to make in a
privileged mutation path; it is deferred until the mutation coverage of
Requirement 6 is in place.

**Removal condition:** add a `toFactDoc(fact: Fact): Record<string, Json>`
encoder next to the existing `toFact` decoder, assert round-tripping under the
`Test_Suite`, then drop the cast and lower this entry to 0.

### `src/lib/admin/ops.server.ts` — baseline 2, target 0

| Line | Form | Occurrence |
| --- | --- | --- |
| 709 | cast through `unknown` | `rounds as unknown as Json[]` |
| 825 | cast through `unknown` | `doc.data as unknown as Json` |

Line 709 (`writeDailyDraft`): `rounds` is the return of
`sanitizeDraftRounds` in `src/lib/admin/daily-blitz.ts`, which is typed in terms
of the round domain shape rather than `Json`, so the array is not assignable to
the declared `rounds: Json[]` field of the returned draft.

Line 825 (`getDailyLeaderboard`): widens a `FirestoreDoc["data"]`
(`Record<string, Json>`) to the `Json` union for the `raw` passthrough field.

**Why they persist:** both are contained inside daily-draft and leaderboard read
paths that this phase does not touch, and removing them means changing the
declared return type of `sanitizeDraftRounds` (line 709) and reconciling
`Record<string, Json>` with the `{ [key: string]: Json }` arm of the `Json` union
(line 825). Neither is required to reach a 0-error `Typecheck_Step`, and both sit
in a module with 45 privileged exports and no test coverage yet.

**Removal condition:** once the Requirement 6 mutation coverage exercises
`writeDailyDraft` and `getDailyLeaderboard`, declare `sanitizeDraftRounds` as
returning a `Json`-compatible round type and let line 825 widen directly, then
lower this entry to 0.

## Non-privileged file with a baseline above 0

### `src/routeTree.gen.ts` — baseline 14, no target

Not a `Server_Function` declaration site, not a `Privileged_Mutation_Path`, and
not a member of the `Authorization_Boundary`. It is a **generated** file: the
TanStack Router plugin (`@tanstack/router-plugin`) emits it, and all 14
occurrences are the same `as any` the generator writes on each route-tree
`.update(...)` call (lines 31-96, one per route).

No reduction target is set, because the file is not hand-edited and any change
would be overwritten on the next generation. Its baseline entry exists so that a
route added or removed upstream shows up as a count change rather than passing
unnoticed. When the route count grows, the correct response is to raise this one
entry to the newly generated count — it is the only entry in the baseline for
which raising is legitimate rather than a regression.

## Requirement 4.2 — the five typecheck fixes added no suppression

Counts before and after the fixes, measured with the same counter. Pre-fix
sources were read straight out of git (`git show HEAD:<path>`) so the comparison
is against the committed state, not a reconstruction.

| File | Pre-fix (`HEAD`) | Post-fix (working tree) | Verdict |
| --- | --- | --- | --- |
| `src/admin/DerivationInspector.tsx` | 0 | 0 | ≤ pre-fix |
| `src/lib/admin/content.functions.ts` | 0 | 0 | ≤ pre-fix |
| `src/lib/admin/roles.functions.ts` | 0 | 0 | ≤ pre-fix |
| `src/lib/firebase/audit.server.ts` | 0 | 0 | ≤ pre-fix |
| `src/lib/admin/content.server.ts` | 1 | 1 | ≤ pre-fix |

`audit.server.ts` and `content.server.ts` are listed alongside the three files
that carried the errors because the fixes landed in them: the `AuditLogEntry`
`before` / `after` type change (Requirement 3.7) is in `audit.server.ts`, and the
real `bulkUpdateFacts` implementation (Requirements 3.2, 3.4, 3.5) is in
`content.server.ts`. Every affected file holds at or below its pre-fix count, so
Requirement 4.2 is satisfied: the zero-error state was reached by genuine type
fixes, not by silencing diagnostics.

## Maintaining this ratchet

- `Suppression_Check` never rewrites `suppression-baseline.json`. Raising an
  entry is a deliberate, reviewable edit, and outside `routeTree.gen.ts` it means
  a regression.
- When a count drops, the check reports the improvement on standard output and
  still exits 0. Lower the entry in the same change to lock the gain in.
- A file removed from `src/` must have its baseline entry removed too, or the
  check fails on the stale entry (Requirement 4.9).
