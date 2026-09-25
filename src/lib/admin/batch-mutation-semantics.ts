/**
 * Contract-only batch mutation semantics.
 *
 * This module deliberately has no Firestore, network, or clock dependencies. It
 * describes the boundary that the transaction implementation and the later
 * import/bulk handlers must satisfy. A caller supplies an executor for one
 * fact at a time; the executor is responsible for committing the fact mutation
 * and its audit entry in the same transaction. This file only records the
 * deterministic, per-item result contract around those executions.
 *
 * The batch itself is not an atomic unit. Once one item commits, a later item
 * may fail without rolling the earlier item back. A consumer must therefore use
 * the returned item results and counts instead of assuming all-or-nothing
 * success.
 */

/** The atomicity and result guarantees shared by import and bulk operations. */
export const BATCH_MUTATION_SEMANTICS = Object.freeze({
  atomicity: "per-item" as const,
  transactionScope: "one-fact" as const,
  auditEntriesPerPersistedFact: 1 as const,
  factAndAudit: "same-transaction" as const,
  batchAtomic: false as const,
  ordering: "input-order" as const,
  partialResults: "deterministic" as const,
});

/** Operations that use the per-item batch contract. */
export const BATCH_OPERATIONS = ["import", "bulk-update"] as const;
export type BatchOperation = (typeof BATCH_OPERATIONS)[number];

/** Whether a failed item permits the caller to attempt later items. */
export const BATCH_FAILURE_POLICIES = ["continue", "stop"] as const;
export type BatchFailurePolicy = (typeof BATCH_FAILURE_POLICIES)[number];

/** A stable, serializable description of one item failure. */
export interface BatchItemFailure {
  readonly code: string;
  readonly message: string;
}

/**
 * The outcome of one attempted (or deliberately unattempted) input item.
 *
 * `persisted` is intentionally paired with `auditCommitted: true`: a caller
 * cannot report a fact as persisted unless the fact write and its audit write
 * were committed together. The runner never generates an audit id or a
 * timestamp, so result construction remains independent of clocks and random
 * values.
 */
export type BatchItemOutcome =
  | { readonly status: "persisted"; readonly auditCommitted: true }
  | { readonly status: "skipped"; readonly reason: string }
  | { readonly status: "failed"; readonly failure: BatchItemFailure }
  | { readonly status: "not-attempted"; readonly reason: string };

export type BatchItemStatus = BatchItemOutcome["status"];

/** One result entry, always positioned at the same index as its input item. */
export interface BatchItemResult {
  readonly index: number;
  readonly id: string;
  readonly status: BatchItemStatus;
  readonly reason?: string;
  readonly failure?: BatchItemFailure;
}

/** Counts derived from the result entries; no counter is supplied by callers. */
export interface BatchResultCounts {
  readonly total: number;
  readonly persisted: number;
  readonly skipped: number;
  readonly failed: number;
  readonly notAttempted: number;
}

/** The stable response shape returned for every batch. */
export interface BatchMutationResult {
  readonly operation: BatchOperation;
  readonly failurePolicy: BatchFailurePolicy;
  readonly atomicity: "per-item";
  readonly batchAtomic: false;
  readonly total: number;
  readonly items: readonly BatchItemResult[];
  readonly counts: BatchResultCounts;
  readonly persistedIds: readonly string[];
  readonly skippedIds: readonly string[];
  readonly failedIds: readonly string[];
  readonly notAttemptedIds: readonly string[];
  /** The first failed id in input order, or null when no item failed. */
  readonly failedId: string | null;
  /** True only when at least one item committed/skipped and another did not. */
  readonly partialSuccess: boolean;
  /** True when no item failed and no item was left unattempted. */
  readonly successful: boolean;
}

/** Error raised when an outcome violates the tracked contract. */
export class BatchSemanticsError extends Error {
  override readonly name = "BatchSemanticsError";

  constructor(message: string) {
    super(message);
  }
}

/**
 * The failure policy used by each operation when the caller does not choose
 * one. Import keeps processing independent rows; bulk update stops at the first
 * failed edit so its persisted prefix is unambiguous.
 */
export const DEFAULT_FAILURE_POLICY: Readonly<Record<BatchOperation, BatchFailurePolicy>> =
  Object.freeze({
    import: "continue",
    "bulk-update": "stop",
  });

export function defaultFailurePolicy(operation: BatchOperation): BatchFailurePolicy {
  if (operation === "import") return "continue";
  if (operation === "bulk-update") return "stop";
  throw new BatchSemanticsError(`Unknown batch operation: ${String(operation)}`);
}

/**
 * A transaction boundary required by the contract. Implementations must make
 * `commit` visible only when both staged writes succeed, and must restore the
 * staged state when either staging step or commit fails.
 *
 * The transaction adapter is intentionally generic so this contract can be
 * tested without Firestore. The later Firestore implementation supplies the
 * concrete transaction rather than importing one here.
 */
export interface FactAuditTransaction<TFact, TAudit> {
  stageFact(fact: TFact): void;
  stageAudit(audit: TAudit): void;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/** Result of a successful per-item fact-plus-audit commit. */
export interface FactAuditCommitResult {
  readonly committed: true;
}

/**
 * Stage and commit one fact mutation and its audit entry as one unit.
 *
 * A rejection from any stage or commit is converted into a rejected promise
 * after asking the transaction to roll back. A caller can consequently map a
 * successful return to `persisted`, and a rejection to `failed`, without
 * guessing whether a half-written audit exists.
 */
export async function commitFactAndAudit<TFact, TAudit>(
  transaction: FactAuditTransaction<TFact, TAudit>,
  fact: TFact,
  audit: TAudit,
): Promise<FactAuditCommitResult> {
  try {
    transaction.stageFact(fact);
    transaction.stageAudit(audit);
    await transaction.commit();
    return { committed: true };
  } catch (error) {
    try {
      await transaction.rollback();
    } catch {
      /* Preserve the original stage/commit failure for the caller. */
    }
    throw error;
  }
}

/** An executor is invoked once for each item in input order. */
export type BatchItemExecutor = (
  id: string,
  index: number,
) => BatchItemOutcome | Promise<BatchItemOutcome>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertNonEmpty(value: unknown, label: string): asserts value is string {
  if (!isNonEmptyString(value)) {
    throw new BatchSemanticsError(`${label} must be a non-empty string`);
  }
}

function assertFailure(failure: unknown, label: string): asserts failure is BatchItemFailure {
  if (!isRecord(failure)) {
    throw new BatchSemanticsError(`${label} must be an object`);
  }
  assertNonEmpty(failure["code"], `${label}.code`);
  assertNonEmpty(failure["message"], `${label}.message`);
}

function assertOutcome(outcome: unknown, index: number): asserts outcome is BatchItemOutcome {
  if (!isRecord(outcome)) {
    throw new BatchSemanticsError(`outcome at index ${index} must be an object`);
  }
  switch (outcome["status"]) {
    case "persisted":
      if (outcome["auditCommitted"] !== true) {
        throw new BatchSemanticsError(
          `persisted outcome at index ${index} must report auditCommitted=true`,
        );
      }
      return;
    case "skipped":
      assertNonEmpty(outcome["reason"], `skipped outcome at index ${index}.reason`);
      return;
    case "failed":
      assertFailure(outcome["failure"], `failed outcome at index ${index}.failure`);
      return;
    case "not-attempted":
      assertNonEmpty(outcome["reason"], `not-attempted outcome at index ${index}.reason`);
      return;
    default:
      throw new BatchSemanticsError(`outcome at index ${index} has an unknown status`);
  }
}

function itemResult(
  id: string,
  index: number,
  outcome: BatchItemOutcome,
): BatchItemResult {
  if (outcome.status === "failed") {
    return Object.freeze({ index, id, status: outcome.status, failure: outcome.failure });
  }
  if (outcome.status === "skipped" || outcome.status === "not-attempted") {
    return Object.freeze({ index, id, status: outcome.status, reason: outcome.reason });
  }
  return Object.freeze({ index, id, status: outcome.status });
}

function failureFrom(error: unknown): BatchItemFailure {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "item_execution_failed",
    message: message.trim() || "Item execution failed",
  };
}

function notAttempted(id: string): BatchItemOutcome {
  return { status: "not-attempted", reason: "not attempted after an earlier item failed" };
}

function validateOperation(operation: unknown): asserts operation is BatchOperation {
  if (operation !== "import" && operation !== "bulk-update") {
    throw new BatchSemanticsError(`Unknown batch operation: ${String(operation)}`);
  }
}

function validatePolicy(policy: unknown): asserts policy is BatchFailurePolicy {
  if (policy !== "continue" && policy !== "stop") {
    throw new BatchSemanticsError(`Unknown batch failure policy: ${String(policy)}`);
  }
}

/**
 * Build a deterministic result from one outcome per input id.
 *
 * This function performs no I/O and sorts nothing: input order is the stable
 * result order. A `stop` policy requires every item after the first failure to
 * be explicitly marked `not-attempted`; a `continue` policy forbids that state.
 */
export function summarizeBatch(
  operation: BatchOperation,
  ids: readonly string[],
  outcomes: readonly BatchItemOutcome[],
  failurePolicy: BatchFailurePolicy = defaultFailurePolicy(operation),
): BatchMutationResult {
  validateOperation(operation);
  validatePolicy(failurePolicy);
  if (!Array.isArray(ids)) {
    throw new BatchSemanticsError("batch ids must be an array");
  }
  if (!Array.isArray(outcomes)) {
    throw new BatchSemanticsError("batch outcomes must be an array");
  }
  const inputIds = [...ids];
  if (inputIds.length !== outcomes.length) {
    throw new BatchSemanticsError(
      `batch has ${inputIds.length} ids but ${outcomes.length} outcomes; one outcome is required per id`,
    );
  }

  const items: BatchItemResult[] = [];
  const persistedIds: string[] = [];
  const skippedIds: string[] = [];
  const failedIds: string[] = [];
  const notAttemptedIds: string[] = [];
  let failureSeen = false;

  for (let index = 0; index < inputIds.length; index += 1) {
    const id = inputIds[index];
    assertNonEmpty(id, `batch id at index ${index}`);
    const outcome: unknown = outcomes[index];
    assertOutcome(outcome, index);

    if (failurePolicy === "stop") {
      if (!failureSeen && outcome.status === "not-attempted") {
        throw new BatchSemanticsError(
          `stop policy cannot mark index ${index} not-attempted before a failure`,
        );
      }
      if (failureSeen && outcome.status !== "not-attempted") {
        throw new BatchSemanticsError(
          `stop policy requires outcome at index ${index} to be not-attempted after a failure`,
        );
      }
    } else if (outcome.status === "not-attempted") {
      throw new BatchSemanticsError(
        `continue policy cannot leave item at index ${index} not-attempted`,
      );
    }

    if (outcome.status === "failed") {
      failureSeen = true;
      failedIds.push(id);
    } else if (outcome.status === "persisted") {
      persistedIds.push(id);
    } else if (outcome.status === "skipped") {
      skippedIds.push(id);
    } else {
      notAttemptedIds.push(id);
    }
    items.push(itemResult(id, index, outcome));
  }

  const counts: BatchResultCounts = Object.freeze({
    total: inputIds.length,
    persisted: persistedIds.length,
    skipped: skippedIds.length,
    failed: failedIds.length,
    notAttempted: notAttemptedIds.length,
  });
  const successful = failedIds.length === 0 && notAttemptedIds.length === 0;
  const partialSuccess =
    (persistedIds.length > 0 || skippedIds.length > 0) && !successful;

  return Object.freeze({
    operation,
    failurePolicy,
    atomicity: "per-item",
    batchAtomic: false,
    total: inputIds.length,
    items: Object.freeze(items),
    counts,
    persistedIds: Object.freeze(persistedIds),
    skippedIds: Object.freeze(skippedIds),
    failedIds: Object.freeze(failedIds),
    notAttemptedIds: Object.freeze(notAttemptedIds),
    failedId: failedIds[0] ?? null,
    partialSuccess,
    successful,
  });
}

/**
 * Run one executor call per item and produce the canonical partial result.
 *
 * The executor is never called after the first failure under a `stop` policy;
 * those positions are recorded as `not-attempted`. Under a `continue` policy,
 * later items are attempted independently. A thrown error is normalized to a
 * stable code/message pair and does not abort the continuation policy.
 */
export async function runPerItemBatch(
  operation: BatchOperation,
  ids: readonly string[],
  execute: BatchItemExecutor,
  failurePolicy: BatchFailurePolicy = defaultFailurePolicy(operation),
): Promise<BatchMutationResult> {
  validateOperation(operation);
  validatePolicy(failurePolicy);
  if (typeof execute !== "function") {
    throw new BatchSemanticsError("batch executor must be a function");
  }
  if (!Array.isArray(ids)) {
    throw new BatchSemanticsError("batch ids must be an array");
  }
  const inputIds = [...ids];
  for (let index = 0; index < inputIds.length; index += 1) {
    assertNonEmpty(inputIds[index], `batch id at index ${index}`);
  }

  const outcomes: BatchItemOutcome[] = [];
  for (let index = 0; index < inputIds.length; index += 1) {
    const id = inputIds[index];
    try {
      outcomes.push(await execute(id, index));
    } catch (error) {
      outcomes.push({ status: "failed", failure: failureFrom(error) });
    }

    const latest = outcomes[index];
    assertOutcome(latest, index);
    if (failurePolicy === "stop" && latest.status === "failed") {
      for (let remaining = index + 1; remaining < inputIds.length; remaining += 1) {
        outcomes.push(notAttempted(inputIds[remaining]));
      }
      break;
    }
  }

  return summarizeBatch(operation, inputIds, outcomes, failurePolicy);
}
