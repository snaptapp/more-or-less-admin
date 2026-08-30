# Admin Dashboard for More-or-Less (Question Packs)

## Goal
A signed-in web dashboard to manage the game's question packs, connected
directly to the existing Firebase project, built inside this Lovable project
so it can reuse the Arena design system.

## Phase 1 — Firebase connection
1. Add a Firebase **service account key** as a build secret (user downloads
   the JSON key from Firebase console → Project settings → Service accounts
   and pastes it; values never touch the chat).
2. Server functions (TanStack Start, `src/lib/*.functions.ts`) call Firestore
   through the service account — never from the browser.
3. Discovery step: list the project's collections and a sample of documents
   so the dashboard models the real data (pack names, question shape,
   categories), not a guess.

## Phase 2 — Question pack admin UI
1. **Pack list** — browse packs with search/filter; show question count and
   last-updated.
2. **Pack editor** — view and edit a pack's fields and its questions
   (add, edit, delete, reorder); plain-text friendly, with validation
   (non-empty question, valid answer value).
3. **Create pack** — new pack form with sensible defaults from the existing
   schema.
4. Guardrail: every write shows a confirmation; edits never auto-delete
   content.

## Phase 3 — Access control
- Sign-in page; only a single admin identity can reach the dashboard
  (Firebase account check or admin passphrase stored server-side).
- All server functions verify the session before touching Firestore;
  unauthenticated requests get 401.
- The dashboard routes live under a protected layout; the published site's
  other paths are unaffected.

## Non-goals (this round)
- No editing of players, stats, or other collections.
- No changes to the Flutter app or the game's own Firestore rules.
- The dashboard reads/writes via server functions only — no Firestore client
  SDK in the browser, so no extra public rules are needed.

## Technical notes
- Firestore access via the `firebase-admin` SDK in server functions, with a
  REST fallback if the Worker runtime objects to the SDK.
- Secrets (service account JSON) are server-only, read inside handlers.
- UI: Arena design system components + a simple table/list layout tuned for
  desktop.
