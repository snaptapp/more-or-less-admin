# Fact-batch mutation semantics

**Status:** tracked contract for subtask `fact-bank-correctness-21`
**Scope:** Admin fact import and fact bulk-update paths

This document is the contract implemented by the per-fact import and bulk-update
paths. The accompanying `src/lib/admin/batch-mutation-semantics.ts` module is
a pure, dependency-free reference for the result shape and per-item execution
contract; the Firestore adapter lives in `content.server.ts` and is exercised
through the server-function handlers. No batch-level atomicity is implied.

## Invariants

1. **One fact plus one audit is one unit.** For a single input fact, the fact
   mutation and its audit entry are staged in the same transaction. The
   transaction commits both or exposes neither. A failed audit must roll back a
   staged fact mutation.
2. **The unit is per item.** Each CSV row or bulk edit gets its own transaction.
   The transaction boundary is one fact, not a collection of facts.
3. **A batch is non-atomic (not batch-atomic).** Once an item commits, a later
   item may fail without rolling the earlier item back. There is no
   all-or-nothing promise for
   an import or bulk update, and callers must use the returned item results.
4. **A persisted fact has exactly one audit entry.** An item reported as
   `persisted` is valid only when `auditCommitted` is true. `skipped`,
   `failed`, and `not-attempted` items do not receive a success audit entry.
5. **Input order is stable.** Results retain the order of the input array. The
   contract does not sort by fact id, so a caller can reconcile persisted items
   (or the persisted prefix under a stop policy) without guessing which item ran
   first.
6. **Partial data is deterministic.** Given the same ids, outcomes, and failure
   messages, the result object and its JSON representation are identical. The
   summarizer does not read a clock, generate a random id, or include a stack
   trace. A thrown item error is normalized to a stable error code and message.

## Item outcomes

The result has one entry for every input position, including positions that
were not attempted after a fail-fast stop:

| Status | Meaning | Fact write | Audit entry |
| --- | --- | --- | --- |
| `persisted` | The fact mutation and audit committed together | Yes | Exactly one |
| `skipped` | An import row was intentionally not admitted, for example an existing identity | No | No success entry |
| `failed` | The per-item transaction or validation failed | No committed change | No success entry |
| `not-attempted` | A stop policy ended the run before this position | No | No |

`failedId` is the first failed id in input order. `persistedIds`,
`skippedIds`, `failedIds`, and `notAttemptedIds` are derived from the same item
array, so counts cannot disagree with the returned list.

## Failure policy by operation

The operation chooses the policy explicitly:

- **CSV import:** `continue`. Independent rows are attempted in input order;
  one row's failure does not erase or prevent another row's valid commit.
- **Bulk update:** `stop`. The first failed edit ends the run. The result
  identifies the persisted prefix, the failed id, and the unattempted suffix.

Neither policy changes the atomicity boundary: each attempted item is still
one fact-plus-audit transaction. A caller may use `runPerItemBatch` with the
explicit `continue` or `stop` policy; the default is shown above.

## Contract API

The pure module exports:

- `BATCH_MUTATION_SEMANTICS`, the tracked invariant record;
- `commitFactAndAudit`, a small transaction-boundary adapter that stages both
  writes and invokes rollback when staging or commit fails;
- `runPerItemBatch`, which invokes one executor per input item and creates
  deterministic per-item results;
- `summarizeBatch`, which validates and canonicalizes a supplied outcome array;
- `BatchMutationResult`, `BatchItemOutcome`, and the operation/policy types.

The concrete Firestore adapter is in `src/lib/admin/content.server.ts`; it uses
`runTransaction` for each fact and stages the prepared audit in that same
transaction. The reference module intentionally remains free of Firestore,
audit-client, credential, and timer imports.

## Handler and UI handoff

Later implementation tasks should consume the result rather than reconstructing
counts from free-form errors:

- an import response should report persisted, skipped, failed, and
  unattempted counts and retain the item order;
- a bulk-update response should report the persisted prefix and failed id when
  it stops;
- user-facing copy should distinguish `partialSuccess` from a total failure,
  and should not imply that every row either committed or rolled back;
- retries must reuse the same per-item audit identity, and transaction retries
  must not duplicate a fact or audit write.

## Out of scope for this contract

The contract does not create, migrate, or touch fact-bank data, and it does not
change the Firestore REST client. A later corrected-replacement flow may consume
these per-item results, but it must not reintroduce a batch-level atomicity
claim or an ordinary re-key path.
