  Goal

  Ship two buffs: (A) per-round accuracy analytics in the admin site so real player answers continuously grade
  facts, distractors, and surprise calibration; (B) close the reporting-loop holes — server-side bounty
  settlement, reporter-history escalation, and ombudsman-vs-human agreement tracking.

  Success Criteria

  • Admin shows per-question correct rates (right/wrong/skip counts + report counts) aggregated from real
    play, with outliers (near-0% or near-100%) surfaced.
  • Ombudsman bounties (+500 / −250 / +250) actually move player points exactly once, enforced server-side — a
    modified client can neither grant itself bounties nor dodge penalties.
  • Repeat-overturned reporters escalate to human review automatically; ombudsman-vs-human agreement is logged
    and viewable, producing the number that decides whether cross-model arbitration is needed.

  Context And Current Facts

  • game_history docs carry only aggregates (roundsCorrect/Wrong/Skipped,
    functions/src/game/recordMatch.ts:83-85). Per-round guesses are never persisted — analytics over
    users/{uid}/game_history (getGameAnalytics, admin ops.server.ts:911) cannot see question-level accuracy
    today.
  • Dispute path works end-to-end: client dialog → edge POST /api/dispute (auth, dispute quota,
    src/index.ts:383) → Go POST /arbitrate (same model, same grounding) → dispute_outcome log; reports land in
    trivia_reports with reporterUid → admin mod queue → actOnReport (retire_fact / fix_number / reject /
    resolve_only / add_to_bank, admin content.functions.ts:203).
  • Verdict economics already exist in the ombudsman prompt (agent-go/arbitrate.go:19-29): DEBUNKED (+500),
    VERIFIED_CANONICAL (−250), AMBIGUOUS (+250). But bountyAwarded is only displayed in the client dialog (
    dispute_fact_dialog.dart:479-525) — no server code anywhere applies it to points. The −250 penalty is
    currently unenforceable theater.
  • Reports are written twice (client direct-to-Firestore in firestore_persistence_service.dart:749 and
    Functions reportWrongAnswer callable in functions/src/index.ts:1716), risking duplicate queue entries.
  • A canonical question key already exists: disputedFactKey (edge src/disputed.ts:38), normalized claim hash.
  • Admin repo has lint + build but no test runner.

  Constraints And Non-goals

  • No changes to verdict thresholds, DDM, guardrails, or the three-verdict taxonomy.
  • No prompt changes to generation or arbitration models in this plan (cross-model ombudsman is a gated
    follow-up, not this phase).
  • Bounty settlement must be idempotent (report filed once, settled once — retries and double report writes
    must not double-pay).
  • Non-goals: client UI redesign, changing dispute quotas, Foundry re-verify automation (human mod queue
    stays the decider).

  Key Decisions

  1. Question identity: disputedFactKey. Reuse the existing normalized-claim hash rather than inventing a
     fact-ID scheme (generated rounds have no bank ID). Computed wherever the outcome is recorded so all
     writers agree.
  2. Store per-round outcomes on game_history docs, not a new collection. Append a bounded rounds array (
     [{q, ok, skip}], max 15 entries) at recordMatch time. No new indexes, no new security rules, existing
     analytics sampling keeps working.
  3. Settle bounties in Functions, keyed by reportId. The edge Worker is stateless (no Firestore); the
     Functions reportWrongAnswer callable already writes the report doc and calls edge arbitration — it
     settles the bounty in the same transaction path, guarded by a bountySettled flag on the report. Client
     display becomes a receipt, not the transaction.
  4. Keep the +500/−250/+250 economics; add refund-via-ambiguity explicitly. AMBIGUOUS already pays +250
     (half-bounty, no penalty) — that is the good-faith refund. No taxonomy change needed, just settle it
     server-side like the rest.
  5. Escalation by reporter track record, computed from existing data. reporterUid is already on every report
     — no schema change. Reporters with ≥N overturns in trailing M reports bypass ombudsman-overrule straight
     to the human queue.
  6. Agreement tracking before cross-model. Log ombudsman verdict vs human resolution (both fields already
     exist on reports: ombudsmanVerdict, resolution action) into an admin view first. Only spend on a second
     model family if agreement drops below the bar this view reveals.

  Recommended Approach

  Two slices, analytics first (independent, no economy risk), then the reporting economy (needs care around
  double-settle and double-write).

  Work Plan

  Slice 1 — Per-round accuracy analytics
  1. Client + Functions: extend recordMatch input with bounded rounds: [{q, ok, skip}] (
     functions/src/game/recordMatch.ts, firestore_persistence_service.dart, game_controller_play.dart);
     validate length ≤ 15 and q as non-empty string server-side, mirroring existing requireInt bounds.
  2. Shared key: compute q with the disputedFactKey normalization on both writers (port the ~15-line
     normalizer to Dart, or compute server-side from claim text sent alongside — prefer server-side to avoid
     client key divergence).
  3. Admin: extend getGameAnalytics to aggregate per-q correct/wrong/skip/report counts over the sampled
     window; new /admin/analytics section (or reports.tsx adjunct) listing outlier questions sorted by
     distance from 50%, each linking to its fact/report.
  4. Backfill: none (aggregates from new writes only; label the view "since <deploy date>").

  Slice 2 — Reporting economy
  5. Dedupe report writes: make the client call either direct Firestore or the callable, not both (recommend
     callable-only: it already triggers edge arbitration; keep the local SharedPreferences copy as offline
     fallback).
  6. Server-side settlement: in the callable path, after arbitration returns, write bountyAwarded to the
     player's points in a transaction guarded by bountySettled: true on the report doc; retries and duplicate
     report docs for the same (reporterUid, claimKey) settle once.
  7. Reporter history + escalation: nightly-or-lazy computation of reporter overturn rate from trivia_reports;
     reporters above threshold get escalateHuman: true on new reports, which the mod queue surfaces first and
     the ombudsman cannot auto-close.
  8. Agreement view: admin table joining ombudsmanVerdict → human action per report, with agreement %; alert
     (or roadmap trigger) if below 90%.

  Validation Plan

  • Slice 1: flutter test (client round-capture), Functions npm test (new bounds-rejection cases: 16 rounds,
    empty q), admin npm run lint + npm run build; manual: play 2 solo games, confirm per-q rows appear in the
    new analytics view.
  • Slice 2: Functions tests for double-settle (same reportId twice → one credit), duplicate-claim
    suppression, and penalty application; edge npm test unchanged (no Worker changes); manual: file a report
    on a known-good fact, confirm −250 lands in Firestore (not just the dialog), then resolve and confirm no
    double-credit on retry.
  • Highest-risk check: the bounty transaction under concurrent duplicate writes — prove with a test that
    races two settlements for the same report.

  Risks / Rollback

  • Per-round arrays grow game_history docs (~15 small objects; negligible) — but if write volume/cost
    surprises, gate behind a sampling flag.
  • Changing the client to callable-only reporting needs the callable deployed first (order matters; old
    clients still direct-write — the dedupe key must tolerate both during transition).
  • Settlement bugs move real points: ship behind an admin-config flag (config.tsx already exists) starting in
    log-only mode (compute-but-don't-apply for one week), then enforce.
  • Rollback: analytics is additive (ignore the new field); settlement flag flips back to log-only; no
    migrations to reverse.

  Open Questions

  None that block planning — reporter-threshold numbers (N overturns in M reports) and the agreement-% bar are
  tuning constants I'll default (3-in-10, 90%) and expose in admin config.