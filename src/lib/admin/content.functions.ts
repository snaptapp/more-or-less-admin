import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const listInput = z.object({
  search: z.string().optional(),
  status: z.string().optional(),
  contentRating: z.string().optional(),
  difficulty: z.string().optional(),
  minSurprise: z.number().int().min(1).max(10).optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
});

export const fetchFacts = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => listInput.parse(data))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("../firebase/verify.server");
    await requireAdmin();
    const { listFacts } = await import("./content.server");
    return listFacts(data);
  });

export const fetchFact = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => z.object({ id: z.string().min(1) }).parse(data))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("../firebase/verify.server");
    await requireAdmin();
    const { getFact } = await import("./content.server");
    return getFact(data.id);
  });

const editInput = z.object({
  id: z.string().min(1),
  subject: z.string().min(1).optional(),
  angle: z.string().min(1).optional(),
  true_number: z.number().optional(),
  unit: z.string().optional(),
  claim_template: z.string().optional(),
  context: z.string().optional(),
  question: z.string().optional(),
  surprise_factor: z.number().int().min(1).max(10).optional(),
  difficulty_hint: z.enum(["casual", "medium", "hard"]).optional(),
  content_rating: z.enum(["standard", "after_dark"]).optional(),
  source_urls: z.array(z.string()).optional(),
});

export const saveFact = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => editInput.parse(data))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("../firebase/verify.server");
    await requireAdmin();
    const { updateFact } = await import("./content.server");
    return updateFact(data);
  });

export const changeFactStatus = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        id: z.string().min(1),
        status: z.enum(["active", "disputed", "retired"]),
        reason: z.string().optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("../firebase/verify.server");
    await requireAdmin();
    const { setFactStatus } = await import("./content.server");
    return setFactStatus(data);
  });

export const addFact = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        subject: z.string().min(1),
        angle: z.string().min(1),
        true_number: z.number(),
        unit: z.string(),
        claim_template: z.string().min(1),
        context: z.string(),
        question: z.string().min(1),
        surprise_factor: z.number().int().min(1).max(10),
        difficulty_hint: z.enum(["casual", "medium", "hard"]),
        content_rating: z.enum(["standard", "after_dark"]),
        source_urls: z.array(z.string()),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("../firebase/verify.server");
    await requireAdmin();
    const { createFact } = await import("./content.server");
    return createFact(data);
  });

export const fetchReports = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z.object({ status: z.string().optional(), limit: z.number().optional() }).parse(data),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("../firebase/verify.server");
    await requireAdmin();
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

export const actOnReport = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        reportId: z.string().min(1),
        action: z.enum(["retire_fact", "fix_number", "reject"]),
        factId: z.string().optional(),
        correctedNumber: z.number().optional(),
        note: z.string().optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("../firebase/verify.server");
    await requireAdmin();
    const { resolveReport } = await import("./content.server");
    return resolveReport(data);
  });

/** Confirms the service-account connection and reports collection sizes. */
export const fetchOverview = createServerFn({ method: "GET" }).handler(async () => {
  const { requireAdmin } = await import("../firebase/verify.server");
  const user = await requireAdmin();
  const { countCollection } = await import("../firebase/firestore.server");
  const [active, disputed, retired, pending] = await Promise.all([
    countCollection("fact_bank", [{ field: "status", op: "EQUAL", value: "active" }]),
    countCollection("fact_bank", [{ field: "status", op: "EQUAL", value: "disputed" }]),
    countCollection("fact_bank", [{ field: "status", op: "EQUAL", value: "retired" }]),
    countCollection("trivia_reports", [
      { field: "status", op: "EQUAL", value: "pending_review" },
    ]),
  ]);
  return { user, active, disputed, retired, pending };
});
