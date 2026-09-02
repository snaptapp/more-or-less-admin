import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "./middleware";

const listInput = z.object({
  search: z.string().optional(),
  status: z.string().optional(),
  contentRating: z.string().optional(),
  minSurprise: z.number().int().min(0).max(3).optional(),
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
  angle: z.string().optional(),
  true_number: z.number().optional(),
  unit: z.string().optional(),
  claim_template: z.string().optional(),
  context: z.string().optional(),
  question: z.string().optional(),
  surprise_factor: z.number().int().min(0).max(3).optional(),
  content_rating: z.enum(["standard", "after_dark"]).optional(),
  source_urls: z.array(z.string()).optional(),
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

export const bulkUpdateFacts = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) =>
    z.object({ updates: z.array(editInput).min(1).max(200) }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const caller = context.user;
    const { bulkUpdateFacts } = await import("./content.server");
    const count = await bulkUpdateFacts(data.updates);
    const { logAdminAction } = await import("@/lib/firebase/audit.server");
    await logAdminAction(caller, {
      action: "fact.bulk_update",
      targetType: "fact",
      details: `Bulk updated ${count} facts`,
    });
    return { count };
  });

export const changeFactStatus = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) =>
    z
      .object({
        id: z.string().min(1),
        status: z.enum(["active", "disputed", "retired"]),
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
    const { logAdminAction } = await import("@/lib/firebase/audit.server");
    await logAdminAction(caller, {
      action: "fact.bulk_import",
      targetType: "fact_bank",
      details: `Bulk imported ${result.imported} facts (${result.skipped} skipped)`,
      after: { importedCount: result.imported, skippedCount: result.skipped, errors: result.errors },
    });
    return result;
  });

export const fetchReports = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) =>
    z.object({ status: z.string().optional(), limit: z.number().optional() }).parse(data),
  )
  .handler(async ({ data }) => {
    const { listReports, findFactForReport } = await import("./content.server");
    const reports = await listReports(data);
    const withFacts = await Promise.all(
      reports.slice(0, 40).map(async (report) => ({
        report,
        fact: report.status === "pending_review" ? await findFactForReport(report) : null,
      })),
    );
    return withFacts;
  });

export const actOnReport = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) =>
    z
      .object({
        reportId: z.string().min(1),
        action: z.enum(["retire_fact", "fix_number", "reject", "resolve_only", "add_to_bank"]),
        factId: z.string().optional(),
        correctedNumber: z.number().optional(),
        note: z.string().optional(),
        topic: z.string().optional(),
        claimStatement: z.string().optional(),
        unit: z.string().optional(),
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

/** Confirms the admin connection and returns live collection counters via native Firestore count() */
export const fetchOverview = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const user = context.user;
    const { countCollection } = await import("@/lib/firebase/firestore.server");

    const [active, disputed, retired, pending] = await Promise.all([
      countCollection("fact_bank", [{ field: "status", op: "EQUAL", value: "active" }]),
      countCollection("fact_bank", [{ field: "status", op: "EQUAL", value: "disputed" }]),
      countCollection("fact_bank", [{ field: "status", op: "EQUAL", value: "retired" }]),
      countCollection("trivia_reports", [{ field: "status", op: "EQUAL", value: "pending_review" }]),
    ]);

    return {
      user,
      active,
      disputed,
      retired,
      pending,
    };
  });
