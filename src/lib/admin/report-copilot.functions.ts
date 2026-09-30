import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "./middleware";

/** Read-only copilot review of a pending report. Never writes Firestore. */
export const runReportCopilot = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator((data: unknown) => z.object({ reportId: z.string().min(1) }).parse(data))
  .handler(async ({ data, context }) => {
    const { listReports, findFactForReport } = await import("./content.server");
    const { reviewReportWithCopilot } = await import("./report-copilot.server");
    const reports = await listReports({ status: "pending_review", limit: 200 });
    const report = reports.find((r) => r.id === data.reportId);
    if (!report) throw new Error("Report not found or no longer pending.");
    const fact = await findFactForReport(report);
    const review = await reviewReportWithCopilot({
      topic: report.topic,
      claimStatement: report.claimStatement,
      presentedNumber: report.presentedNumber,
      trueNumber: report.trueNumber,
      unit: report.unit,
      reason: report.reason,
      feedbackText: report.feedbackText,
      fact: fact
        ? {
            subject: fact.subject,
            angle: fact.angle,
            question: fact.question,
            claim_template: fact.claim_template,
            true_number: fact.true_number,
            unit: fact.unit,
            context: fact.context,
            source_urls: fact.source_urls ?? [],
          }
        : null,
    });
    const { logAdminAction } = await import("@/lib/firebase/audit.server");
    await logAdminAction(context.user, {
      action: "report.copilot_review",
      targetType: "report",
      targetId: data.reportId,
      details: `Copilot verdict: ${review.verdict} (${review.confidence}, score ${review.policy.score})${review.policy.needsReview ? " - needs closer review" : ""}`,
      after: {
        verdict: review.verdict,
        confidence: review.confidence,
        modelConfidence: review.policy.modelConfidence,
        score: review.policy.score,
        needsReview: review.policy.needsReview,
        warnings: review.policy.reasons,
        factors: review.policy.factors,
        rationale: review.rationale,
        suggested: review.suggested,
        sources: review.sources,
        factId: fact?.id ?? null,
        model: review.model,
      } as unknown as Record<string, unknown>,
    });
    return review;
  });

/** Chronological audit trail (copilot runs + admin resolutions) for one report. */
export const fetchReportAudit = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator((data: unknown) => z.object({ reportId: z.string().min(1) }).parse(data))
  .handler(async ({ data }) => {
    const { listAuditLogs } = await import("@/lib/firebase/audit.server");
    const logs = await listAuditLogs(500);
    return logs
      .filter((l) => l.targetType === "report" && l.targetId === data.reportId)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  });
