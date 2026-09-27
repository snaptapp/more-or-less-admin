import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "./middleware";
import { GENRES } from "./taxonomy";
import { QK } from "./contract";
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
    // The admin export is the active bank snapshot. Pending admission rows are
    // intentionally excluded even if a caller supplies a broader status filter.
    return exportFacts({ ...data, status: STATUS.active });
  });

export const fetchBankObservability = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async () => {
    const { getBankObservability } = await import("./content.server");
    return getBankObservability();
  });

export const fetchFact = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) => z.object({ id: z.string().min(1) }).parse(data))
  .handler(async ({ data }) => {
    const { getFact } = await import("./content.server");
    return getFact(data.id);
  });

const editInput = z.object({
  id: z.string().min(1),
  // Keep the identity fields in the wire shape for exact-value compatibility;
  // `updateFact` compares them with the persisted document before writing.
  // They are never assignable fields and never authorize a re-key.
  subject: z.string().optional(),
  category: z.union([z.enum(CANONICAL_CATEGORIES), z.literal("")]).optional(),
  sub_category: z.string().optional(),
  angle: z.string().optional(),
  true_number: z.number().optional(),
  unit: z.string().optional(),
  claim_template: z.string().optional(),
  // `explanation` is canonical for new admissions; `context` remains accepted
  // for legacy editors and stored documents.
  explanation: z.string().optional(),
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
}).strip();

export const saveFact = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) => editInput.parse(data))
  .handler(async ({ data, context }) => {
    const caller = context.user;
    const { buildAuditEntry } = await import("@/lib/firebase/audit.server");
    const audit = buildAuditEntry(caller, {
      action: "fact.update",
      targetType: "fact",
      targetId: data.id,
      details: `Updated fact ${data.id}`,
      after: data as Record<string, unknown>,
    });
    const { updateFact } = await import("./content.server");
    // The prepared entry is passed into the fact transaction. Its id and
    // timestamp are allocated before runTransaction can retry the callback.
    return updateFact(data, audit);
  });

function bulkAuditTargetId(update: unknown, index: number): string {
  if (update !== null && typeof update === "object" && "id" in update) {
    const id = (update as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return `invalid_bulk_update_${index + 1}`;
}

export const bulkUpdateFacts = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) =>
    z.object({ updates: z.array(editInput).min(1).max(200) }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const caller = context.user;
    const { bulkUpdateFacts } = await import("./content.server");
    const { buildAuditEntry } = await import("@/lib/firebase/audit.server");
    const audits = data.updates.map((update, index) => {
      const targetId = bulkAuditTargetId(update, index);
      return buildAuditEntry(caller, {
        action: "fact.bulk_update",
        targetType: "fact",
        targetId,
        details:
          `Bulk update item ${index + 1} of ${data.updates.length} for fact ${targetId}; ` +
          "items commit independently and the batch is not atomic.",
        after: {
          update: update as Record<string, unknown>,
          itemIndex: index,
          batchSize: data.updates.length,
          batchAtomic: false,
        },
      });
    });
    return bulkUpdateFacts(data.updates, audits);
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
    const { buildAuditEntry } = await import("@/lib/firebase/audit.server");
    const audit = buildAuditEntry(caller, {
      action: `fact.status_${data.status}`,
      targetType: "fact",
      targetId: data.id,
      details: `Status changed to ${data.status}${data.reason ? ` (${data.reason})` : ""}`,
      after: { status: data.status, reason: data.reason ?? null },
    });
    const { setFactStatus } = await import("./content.server");
    return setFactStatus(data, audit);
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
        explanation: z.string().optional(),
        question: z.string().optional().default(""),
        surprise_factor: z.number().int().min(0).max(3).default(2),
        quantity_kind: z.union([z.enum(QUANTITY_KINDS), z.literal("")]).default(QK.count),
        plausible_min: z.string().optional(),
        plausible_max: z.string().optional(),
        content_rating: z.enum(["standard", "after_dark"]).default("standard"),
        source_urls: z.array(z.string()).default([]),
      })
      .strip()
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
  category: z.union([z.enum(CANONICAL_CATEGORIES), z.literal("")]).optional(),
  sub_category: z.string().optional(),
  angle: z.string().min(1),
  true_number: z.number(),
  unit: z.string().optional().default(""),
  claim_template: z.string().optional().default(""),
  context: z.string().optional().default(""),
  explanation: z.string().optional(),
  question: z.string().optional().default(""),
  surprise_factor: z.number().int().min(0).max(3).optional().default(2),
  quantity_kind: z.union([z.enum(QUANTITY_KINDS), z.literal("")]).optional().default(QK.count),
  plausible_min: z.string().optional(),
  plausible_max: z.string().optional(),
  content_rating: z.enum(["standard", "after_dark"]).optional().default("standard"),
  source_urls: z.array(z.string()).optional().default([]),
}).strip();

export const bulkImportFacts = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) =>
    z.object({ facts: z.array(bulkFactSchema).min(1).max(500) }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const caller = context.user;
    const { importFactsBatch } = await import("./content.server");
    const { buildAuditEntry, createAuditIdentity } = await import("@/lib/firebase/audit.server");
    // Allocate one stable identity per input position before any transaction can
    // retry. Skipped and failed rows never persist their prepared entry.
    const auditIdentities = data.facts.map(() => createAuditIdentity());
    return importFactsBatch(data.facts, ({ id, index, input }) =>
      buildAuditEntry(
        caller,
        {
          action: "fact.bulk_import",
          targetType: "fact",
          targetId: id,
          details:
            `CSV import item ${index + 1} of ${data.facts.length} for fact ${id}; ` +
            "rows commit independently and the import is not atomic.",
          after: {
            input: { ...input },
            itemIndex: index,
            batchSize: data.facts.length,
            batchAtomic: false,
          },
        },
        auditIdentities[index],
      ),
    );
  });

const correctedReplacementSchema = z.object({
  originalId: z.string().trim().min(1),
  replacement: bulkFactSchema
    .extend({
      number_pinned: z.boolean().optional(),
      pinned_reason: z.string().optional(),
    })
    .strip(),
  reason: z.string().optional(),
  originalUpdateTime: z.string().trim().min(1).optional(),
}).strip();

/**
 * Create a fresh pending correction and retire its immutable source as one
 * transaction. The server boundary prepares the audit identity before the
 * service can enter a retrying Firestore transaction.
 */
export const createCorrectedReplacement = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator((data: unknown) => correctedReplacementSchema.parse(data))
  .handler(async ({ data, context }) => {
    const caller = context.user;
    const { buildAuditEntry } = await import("@/lib/firebase/audit.server");
    const audit = buildAuditEntry(caller, {
      action: "fact.corrected_replacement",
      targetType: "fact",
      targetId: data.originalId,
      details: `Retired fact ${data.originalId} and created a corrected replacement`,
      after: {
        originalId: data.originalId,
        replacement: data.replacement,
        replacementStatus: STATUS.pending,
        reason: data.reason ?? null,
      },
    });
    const { createCorrectedReplacement: replace } = await import("./content.server");
    return replace(data, audit);
  });

/** Compatibility export for callers that use the shorter operation name. */
export const replaceFact = createCorrectedReplacement;

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
            claim_template: z.string().optional(),
            true_number: z.number().optional(),
            unit: z.string().optional(),
            plausible_min: z.string().optional(),
            plausible_max: z.string().optional(),
            quantity_kind: z.string().optional(),
            explanation: z.string().optional(),
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
    const { PENDING_ADMISSION_COPY, resolveReport } = await import("./content.server");
    const result = await resolveReport(data);
    const { logAdminAction } = await import("@/lib/firebase/audit.server");
    const details =
      data.action === "add_to_bank"
        ? `Report action: add_to_bank — ${PENDING_ADMISSION_COPY}`
        : `Report action: ${data.action}`;
    await logAdminAction(caller, {
      action: `report.${data.action}`,
      targetType: "report",
      targetId: data.reportId,
      details: `${details}${data.note ? ` - ${data.note}` : ""}`,
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
      pendingFacts,
      disputed,
      retired,
      reportsPending,
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
      countCollection("fact_bank", [{ field: "status", op: "EQUAL", value: STATUS.pending }]),
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

    const factStatusCounts: Record<FactStatus, number> = {
      [STATUS.pending]: pendingFacts,
      [STATUS.active]: active,
      [STATUS.disputed]: disputed,
      [STATUS.retired]: retired,
    };
    const series = {
      factStatus: FACT_STATUSES.map((status) => ({
        name: status,
        count: factStatusCounts[status],
      })) satisfies OverviewSeriesRow[],
      contentRating: [
        { name: "standard", count: ratingStandard },
        { name: "after_dark", count: ratingAfterDark },
      ] satisfies OverviewSeriesRow[],
      reports: [
        { name: "pending_review", count: reportsPending },
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
      pendingFacts,
      disputed,
      retired,
      // Keep the legacy `pending` field tied to reports for existing consumers;
      // pending fact-bank rows are exposed explicitly as `pendingFacts`.
      pending: reportsPending,
      reportsPending,
      crawlQueued,
      games7d,
      premium,
      series,
      gamesWindowed: gameAnalytics.windowed,
      gamesSampled: gameAnalytics.total,
      gamesIndexUnavailable: gameAnalytics.indexUnavailable || games7d === null,
    };
  });
