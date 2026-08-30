# More-or-Less Admin Portal

A web admin dashboard for the trivia game's content pipeline, built here in
Lovable (React + TanStack Start) and connected directly to your existing
Firebase project. The Flutter game is untouched — this is a separate surface
over the same Firestore data.

## Architecture

The browser never talks to Firestore. All reads and writes go through server
functions running on this app's server, using the Firebase Admin SDK with a
service-account credential. That keeps your Firestore security rules unchanged
and means no admin-facing rules need to be opened up.

```text
Browser (admin UI)
   -> server functions (Firebase Admin SDK, service account)
      -> Cloud Firestore  (fact_bank, trivia_reports, ...)
      -> Cloudflare API   (KV purge, room stats)   [later phase]
```

## Phase 1 — Connection and access control

1. Store the Firebase service-account JSON as a server-only secret (you paste
   it into a secure form; it never appears in chat or client code).
2. Firebase Authentication sign-in for the portal itself. Access requires an
   `admin: true` custom claim, with an email allowlist as the fallback check.
3. Every server function verifies the caller's Firebase ID token and admin
   claim before touching Firestore — the route guard is UX only, the token
   check is the security boundary.
4. Shared app shell: sidebar navigation, Arena design-system styling, desktop
   -first layout.

## Phase 2 — Fact Bank (`fact_bank`)

The core surface.

- **Browse**: paginated table with search over `subject` / `angle` /
  `question`, and filters for category, `status`, `content_rating`,
  `difficulty_hint`, and `surprise_factor` range.
- **Fact detail / edit**: all editable fields (`subject`, `angle`,
  `true_number`, `unit`, `claim_template`, `context`, `question`,
  `surprise_factor`, `difficulty_hint`, `content_rating`, `source_urls`).
  Live preview renders `claim_template` with `{n}` substituted so you see the
  player-facing sentence while editing.
- **Status actions**: Verify & Approve, Mark Disputed, Retire Fact. Retiring
  requires a `retired_reason`; changing `true_number` writes the old value to
  `previous_true_number` automatically.
- **History panel**: previous-number diff, `verifier_model`, `verified_at`,
  `served_count`, `last_served_at`.
- Document IDs are the existing 16-char `subject_key|angle_key` SHA1 — the
  portal recomputes it the same way when creating a fact, so IDs stay
  consistent with the pipeline.

## Phase 3 — Moderation inbox (`trivia_reports`)

- Queue of `pending_review` reports, newest first, with the reported claim
  shown next to the current fact-bank record for side-by-side comparison.
- Quick actions, each one atomic across both collections:
  - **Accept & Retire Fact** — retires the fact, resolves the report.
  - **Accept & Fix Number** — sets a corrected `true_number` (old value moved
    to `previous_true_number`), resolves the report.
  - **Reject Report** — marks the report rejected with a note.
- Resolved/rejected tabs for audit.

## Phase 4 — Taxonomy and crawl queue

- `fact_subjects`: taxonomy manager — assign one of the 11 canonical
  categories, edit `sub_category` and `aliases`, view `fact_count` and
  `last_crawled_at` coverage stats (which categories are thin).
- `crawl_queue`: queue monitor by status, manual "Enqueue topic for crawl"
  with priority and `refresh` flag, priority adjustment on queued items.

## Phase 5 — Players, daily challenge, analytics

- `users`: lookup by email or display name, view lifetime stats from
  `stats/summary`, toggle `isPremium`.
- `daily_packs` / `daily_leaderboards`: date-picker preview of upcoming and
  past packs (all 5 rounds), plus that date's leaderboard.
- `games`: aggregate read-only analytics — volume by `gameMode`, `category`,
  `difficulty`, and `pace` over a date range.

## Phase 6 — Cloudflare edge operations

- KV cache purge for a topic after a fact edit (so corrected questions stop
  serving from the 30-day cache).
- Dispute blocklist inspection: view and clear `disputed:claim:<sha1>` keys.
- Live room count / connection health, read from the Cloudflare API.

This phase needs a Cloudflare API token with KV and Workers read/write scope,
stored as a second server-only secret. Everything before it works without it.

## Notes and open items

- Phases 2 and 3 are the working v1; the rest builds on the same shell.
- Before writing the fact editor I'll read a sample of real `fact_bank` and
  `trivia_reports` documents through the connection from phase 1, so the forms
  match your actual field shapes rather than the spec alone.
- Writes are confirmed and never cascade-delete; retire/dispute are status
  changes, not deletions.
- The portal is a separate deployment from the game — the Flutter app, its
  Firestore rules, and the Cloud Run agents are not modified.
