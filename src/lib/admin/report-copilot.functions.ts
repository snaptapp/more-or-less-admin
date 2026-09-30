import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "./middleware";

/** Read-only copilot review of a pending report. Never writes Firestore. */
export const runReportCopilot = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator((data: unknown) => z.object({ reportId: z.string().min(1) }).parse(data))
  .handler(async ({ data }) => {
    const { listReports, findFactForReport } = await import("./content.server");
    const { reviewReportWithCopilot } = await import("./report-copilot.server");
    const reports = await listReports({ status: "pending_review", limit: 200 });
    const report = reports.find((r) => r.id === data.reportId);
    if (!report) throw new Error("Report not found or no longer pending.");
    const fact = await findFactForReport(report);
    return reviewReportWithCopilot({
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
  });
