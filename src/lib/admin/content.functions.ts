import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "./middleware";
import { GENRES } from "./taxonomy";
import {
  FACT_STATUSES,
  QUANTITY_KINDS,
  type FactStatus,
} from "../../../shared/fact-lifecycle-contract.gen";

export const CANONICAL_CATEGORIES = GENRES;
export type CanonicalCategory = (typeof CANONICAL_CATEGORIES)[number];

/**
 * The `quantity_kind` values the fact edit input accepts: the shared contract's
 * closed set (Requirement 9.5, derived) plus the empty-string "auto" sentinel.
 */
const QUANTITY_KIND_OPTIONS = [...QUANTITY_KINDS, ""] as const;

// Named fact-status constants derived from the shared contract (Requirement
// 9.9): the overview count queries and status series below reference
// `STATUS.active` etc. rather than restating the raw status literal. No status
// literal is written here — keys and values both come from FACT_STATUSES.
const STATUS: { [K in FactStatus]: K } = (() => {
  const out = {} as { [K in FactStatus]: K };
  for (const value of FACT_STATUSES) out[value] = value as never;
  return out;
})();

const listInput = z.object({
  search: z.string().optional(),
  category: z.union([z.enum(CANONICAL_CATEGORIES), z.literal(""), z.string()]).optional(),
  family: z.string().optional(),
  playlistId: z.string().optional(),
  subject: z.string().optional(),
  angle: z.string().optional(),
  status: z.string().optional(),
  contentRating: z.string().optional(),
  surpriseFactor: z.number().int().min(0).max(3).optional(),
  minSurprise: z.number().int().min(0).max(3).optional(),
  sortField: z.enum(["subject", "angle", "true_number", "surprise_factor", "served_count"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(1000).optional(),
});

export const fetchFacts = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) => listInput.parse(data))
  .handler(async ({ data }) => {
    const { listFacts } = await import("./content.server");
    return listFacts(data);
  });

export const exportFactsData = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) => listInput.parse(data))
  .handler(async ({ data }) => {
    const { exportFacts } = await import("./content.server");
    return exportFacts(data);
  });

export const fetchFact = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) => z.object({ id: z.string().min(1) }).parse(data))
  .handler(async ({ data }) => {
    const { getFact } = await import("./content.server");
    return getFact(data.id);
  });

const editInput = z.object({
  id: z.string().min(1),
  subject: z.string().optional(),
  category: z.union([z.enum(CANONICAL_CATEGORIES), z.literal("")]).optional(),
  sub_category: z.string().optional(),
  angle: z.string().optional(),
  true_number: z.number().optional(),
  unit: z.string().optional(),
  claim_template: z.string().optional(),
  context: z.string().optional(),
  question: z.string().optional(),
  surprise_factor: z.number().int().min(0).max(3).optional(),
  content_rating: z.enum(["standard", "after_dark"]).optional(),
  source_urls: z.array(z.string()).optional(),
  // Derived from the shared contract (Requirement 9.5): the closed set plus the
  // "auto" sentinel, never restated as a hand-written literal list here.
  quantity_kind: z.enum(QUANTITY_KIND_OPTIONS).optional(),
  plausible_min: z.string().optional(),
  plausible_max: z.string().optional(),
});

export const saveFact = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) => editInput.parse(data))
  .handler(async ({ data, context }) => {
    const caller = context.user;
    const { updateFact } = await import("./content.server");
    const updated = await updateFact(data);
    const { logAdminAction } = await import("@/lib/firebase/audit.server");
    await logAdminAction(caller, {
      action: "fact.update",
      targetType: "fact",
      targetId: data.id,
      details: `Updated fact ${data.id}`,
      after: data as Record<string, unknown>,
    });
    return updated;
  });

/**
 * Audit `targetId` for a bulk fact update. A batch that persisted exactly one
 * edit is attributed to that fact; any other batch gets a generated batch id,
 * so the field is never empty and the edited ids travel in the entry payload.
 */
function bulkUpdateTargetId(editedIds: string[]): string {
  if (editedIds.length === 1) return editedIds[0];
  return `bulk_update_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export const bulkUpdateFacts = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) =>
    z.object({ updates: z.array(editInput).min(1).max(200) }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const caller = context.user;
    const { bulkUpdateFacts, BulkUpdatePartialFailureError } = await import("./content.server");
    const { logAdminAction } = await import("@/lib/firebase/audit.server");

    // Exactly one entry per batch that wrote anything: the successful batch, or
    // the persisted prefix of a partial failure. A batch rejected before its
    // first write never reaches here, so it leaves no audit trail.
    const writeAuditEntry = async (
      result: { count: number; editedIds: string[] },
      failedId?: string,
    ) => {
      await logAdminAction(caller, {
        action: "fact.bulk_update",
        targetType: "fact",
        targetId: bulkUpdateTargetId(result.editedIds),
        details: failedId
          ? `Bulk updated ${result.count} of ${data.updates.length} facts before failing at ${failedId}`
          : `Bulk updated ${result.count} facts`,
        after: {
          count: result.count,
          editedIds: result.editedIds,
          ...(failedId ? { failedId } : {}),
        },
      });
    };

    let result: { count: number; editedIds: string[] };
    try {
      result = await bulkUpdateFacts(data.updates);
    } catch (err) {
      // Partial failure already persisted a prefix, so it is audited before the
      // error surfaces; a validation rejection wrote nothing and is re-raised
      // untouched so the caller sees which rule it violated.
      if (err instanceof BulkUpdatePartialFailureError) {
        await writeAuditEntry(err.result, err.failedId);
      }
      throw err;
    }

    await writeAuditEntry(result);
    return result;
  });

export const changeFactStatus = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) =>
    z
      .object({
        id: z.string().min(1),
        // Accepted status targets derive from the shared contract's declared
        // set (Requirement 9.1) rather than a hand-written literal list.
        status: z.enum(FACT_STATUSES),
        reason: z.string().optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const caller = context.user;
    const { setFactStatus } = await import("./content.server");
    const updated = await setFactStatus(data);
    const { logAdminAction } = await import("@/lib/firebase/audit.server");
    await logAdminAction(caller, {
      action: `fact.status_${data.status}`,
      targetType: "fact",
      targetId: data.id,
      details: `Status changed to ${data.status}${data.reason ? ` (${data.reason})` : ""}`,
      after: { status: data.status, reason: data.reason },
    });
    return updated;
  });

export const addFact = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) =>
    z
      .object({
        subject: z.string().min(1),
        category: z.union([z.enum(CANONICAL_CATEGORIES), z.literal("")]).optional(),
        sub_category: z.string().optional(),
        angle: z.string().optional().default(""),
        true_number: z.number(),
        unit: z.string().optional().default(""),
        claim_template: z.string().optional().default(""),
        context: z.string().optional().default(""),
        question: z.string().optional().default(""),
        surprise_factor: z.number().int().min(0).max(3).default(2),
        content_rating: z.enum(["standard", "after_dark"]).default("standard"),
        source_urls: z.array(z.string()).default([]),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const caller = context.user;
    const { createFact } = await import("./content.server");
    const created = await createFact(data);
    const { logAdminAction } = await import("@/lib/firebase/audit.server");
    await logAdminAction(caller, {
      action: "fact.create",
      targetType: "fact",
      targetId: created.id,
      details: `Created fact for ${data.subject} / ${data.angle}`,
      after: data as Record<string, unknown>,
    });
    return created;
  });

const bulkFactSchema = z.object({
  subject: z.string().min(1),
  angle: z.string().min(1),
  true_number: z.number(),
  unit: z.string().optional().default(""),
  claim_template: z.string().optional().default(""),
  context: z.string().optional().default(""),
  question: z.string().optional().default(""),
  surprise_factor: z.number().int().min(0).max(3).optional().default(2),
  content_rating: z.enum(["standard", "after_dark"]).optional().default("standard"),
  source_urls: z.array(z.string()).optional().default([]),
});

export const bulkImportFacts = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) =>
    z.object({ facts: z.array(bulkFactSchema).min(1).max(500) }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const caller = context.user;
    const { importFactsBatch } = await import("./content.server");
    const result = await importFactsBatch(data.facts);
    // The import writes fact_bank documents but has no single document target, so the
    // audit entry is keyed by a generated import-batch id (non-empty per Requirement 3.8).
    const importBatchId = `import_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const { logAdminAction } = await import("@/lib/firebase/audit.server");
    await logAdminAction(caller, {
      action: "fact.bulk_import",
      targetType: "fact",
      targetId: importBatchId,
      details: `Bulk imported ${result.imported} facts (${result.skipped} skipped)`,
      after: {
        batchId: importBatchId,
        importedCount: result.imported,
        skippedCount: result.skipped,
        errors: result.errors,
      },
    });
    return result;
  });

export const fetchReports = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) =>
    z.object({ status: z.string().optional(), limit: z.number().optional() }).parse(data),
  )
  .handler(async ({ data }) => {
    const { listReports, findFactForReport, findDuplicateFactsForReport } = await import("./content.server");
    const reports = await listReports(data);
    const withFacts = await Promise.all(
      reports.slice(0, 40).map(async (report) => {
        const fact = report.status === "pending_review" ? await findFactForReport(report) : null;
        const duplicateFacts =
          report.status === "pending_review"
            ? await findDuplicateFactsForReport(report, fact, reports)
            : [];
        return {
          report,
          fact,
          duplicateFacts,
        };
      }),
    );
    return withFacts;
  });

export const actOnReport = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) =>
    z
      .object({
        reportId: z.string().min(1),
        action: z.enum([
          "retire_fact",
          "fix_number",
          "reject",
          "resolve_only",
          "add_to_bank",
          "resolve_duplicate",
          "edit_fact",
          "resolve_as_is",
        ]),
        factId: z.string().optional(),
        correctedNumber: z.number().optional(),
        factUpdates: z
          .object({
            question: z.string().optional(),
            true_number: z.number().optional(),
            unit: z.string().optional(),
            plausible_min: z.string().optional(),
            plausible_max: z.string().optional(),
            quantity_kind: z.string().optional(),
            context: z.string().optional(),
            surprise_factor: z.number().optional(),
            angle: z.string().optional(),
            subject: z.string().optional(),
          })
          .optional(),
        note: z.string().optional(),
        topic: z.string().optional(),
        claimStatement: z.string().optional(),
        unit: z.string().optional(),
        keepFactId: z.string().optional(),
        retireFactId: z.string().optional(),
        retireFactIds: z.array(z.string()).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const caller = context.user;
    const { resolveReport } = await import("./content.server");
    const result = await resolveReport(data);
    const { logAdminAction } = await import("@/lib/firebase/audit.server");
    await logAdminAction(caller, {
      action: `report.${data.action}`,
      targetType: "report",
      targetId: data.reportId,
      details: `Report action: ${data.action}${data.note ? ` - ${data.note}` : ""}`,
      after: data as Record<string, unknown>,
    });
    return result;
  });

export const flushReports = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator((data: unknown) =>
    z.object({ limit: z.number().int().positive().optional() }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const caller = context.user;
    const { flushStaleReports } = await import("./content.server");
    const result = await flushStaleReports(data.limit);
    const { logAdminAction } = await import("@/lib/firebase/audit.server");
    await logAdminAction(caller, {
      action: "report.flush_stale",
      targetType: "system",
      targetId: "trivia_reports",
      details: `Flushed ${result.flushed} stale reports (checked ${result.totalChecked})`,
      after: {
        flushed: result.flushed,
        totalChecked: result.totalChecked,
      },
    });
    return result;
  });

export type OverviewSeriesRow = { name: string; count: number };

/** Confirms the admin connection and returns live collection counters via native Firestore count() */
export const fetchOverview = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const user = context.user;
    const { countCollection, isFirestoreIndexError } = await import("@/lib/firebase/firestore.server");
    const { getGameAnalytics } = await import("./ops.server");

    const since7d = new Date(Date.now() - 7 * 86_400_000).toISOString();

    const categoryCountsPromise = Promise.all(
      CANONICAL_CATEGORIES.map(async (category) => ({
        name: category,
        count: await countCollection("fact_bank", [
          { field: "status", op: "EQUAL", value: STATUS.active },
          { field: "category", op: "EQUAL", value: category },
        ]),
      })),
    );

    const [
      active,
      disputed,
      retired,
      pending,
      reportsResolved,
      reportsRejected,
      ratingStandard,
      ratingAfterDark,
      crawlQueued,
      crawlProcessing,
      crawlDone,
      premium,
      games7d,
      categoryCounts,
      gameAnalytics,
    ] = await Promise.all([
      countCollection("fact_bank", [{ field: "status", op: "EQUAL", value: STATUS.active }]),
      countCollection("fact_bank", [{ field: "status", op: "EQUAL", value: STATUS.disputed }]),
      countCollection("fact_bank", [{ field: "status", op: "EQUAL", value: STATUS.retired }]),
      countCollection("trivia_reports", [{ field: "status", op: "EQUAL", value: "pending_review" }]),
      countCollection("trivia_reports", [{ field: "status", op: "EQUAL", value: "resolved" }]),
      countCollection("trivia_reports", [{ field: "status", op: "EQUAL", value: "rejected" }]),
      countCollection("fact_bank", [
        { field: "status", op: "EQUAL", value: STATUS.active },
        { field: "content_rating", op: "EQUAL", value: "standard" },
      ]),
      countCollection("fact_bank", [
        { field: "status", op: "EQUAL", value: STATUS.active },
        { field: "content_rating", op: "EQUAL", value: "after_dark" },
      ]),
      countCollection("crawl_queue", [{ field: "status", op: "EQUAL", value: "queued" }]),
      countCollection("crawl_queue", [{ field: "status", op: "EQUAL", value: "processing" }]),
      countCollection("crawl_queue", [{ field: "status", op: "EQUAL", value: "done" }]),
      countCollection("users", [{ field: "isPremium", op: "EQUAL", value: true }]),
      countCollection(
        "game_history",
        [{ field: "playedAt", op: "GREATER_THAN_OR_EQUAL", value: since7d }],
        { allDescendants: true },
      ).catch((error: unknown) => {
        if (isFirestoreIndexError(error)) return null;
        throw error;
      }),
      categoryCountsPromise,
      getGameAnalytics({ since: since7d }),
    ]);

    const series = {
      factStatus: [
        { name: STATUS.active, count: active },
        { name: STATUS.disputed, count: disputed },
        { name: STATUS.retired, count: retired },
      ] satisfies OverviewSeriesRow[],
      contentRating: [
        { name: "standard", count: ratingStandard },
        { name: "after_dark", count: ratingAfterDark },
      ] satisfies OverviewSeriesRow[],
      reports: [
        { name: "pending_review", count: pending },
        { name: "resolved", count: reportsResolved },
        { name: "rejected", count: reportsRejected },
      ] satisfies OverviewSeriesRow[],
      crawl: [
        { name: "queued", count: crawlQueued },
        { name: "processing", count: crawlProcessing },
        { name: "done", count: crawlDone },
      ] satisfies OverviewSeriesRow[],
      categories: categoryCounts
        .filter((row) => row.count > 0)
        .sort((a, b) => b.count - a.count) satisfies OverviewSeriesRow[],
      gamesByMode: gameAnalytics.byMode satisfies OverviewSeriesRow[],
    };

    return {
      user,
      active,
      disputed,
      retired,
      pending,
      crawlQueued,
      games7d,
      premium,
      series,
      gamesWindowed: gameAnalytics.windowed,
      gamesSampled: gameAnalytics.total,
      gamesIndexUnavailable: gameAnalytics.indexUnavailable || games7d === null,
    };
  });
