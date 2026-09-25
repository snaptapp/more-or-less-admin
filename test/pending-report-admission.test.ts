import { beforeEach, describe, expect, it, vi } from "vitest";

import { factId, normalizeKey } from "@/lib/firebase/firestore.server";
import {
  PENDING_ADMISSION_COPY,
  canonicalExplanation,
  exportFacts,
  listFacts,
  listReports,
  resolveReport,
  toFact,
} from "@/lib/admin/content.server";
import { blockedNetworkAttempts, firestoreDouble } from "./setup";

vi.mock("@/lib/firebase/firestore.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/firebase/firestore.server")>();
  const { firestoreDouble: double } = await import("./setup");
  return {
    ...actual,
    ...double().module,
    // The report-admission assertions use the same canonical keying path as
    // production, rather than the older underscore-based test double.
    normalizeKey: actual.normalizeKey,
    factId: actual.factId,
  };
});

beforeEach(() => {
  firestoreDouble().reset();
});

describe("report pending admission and canonical explanation reads", () => {
  it("routes add_to_bank through pending admission and reports pending copy", async () => {
    const reportId = "report_add_pending";
    const subject = "Mount Everest";
    const claimStatement = "Mount Everest is {n} meters above sea level.";
    const reportExplanation = "The accepted elevation is maintained by the surveying authority.";
    const moderatorNote = "Verified against the current survey.";

    firestoreDouble().seed(`trivia_reports/${reportId}`, {
      status: "pending_review",
      topic: subject,
      claimStatement,
      explanation: reportExplanation,
      trueNumber: 8848,
      unit: "meters",
    });

    await resolveReport({
      reportId,
      action: "add_to_bank",
      topic: subject,
      claimStatement,
      correctedNumber: 8848,
      unit: "meters",
      note: moderatorNote,
    });

    const expectedId = await factId(normalizeKey(subject), normalizeKey(claimStatement));
    const factWrite = firestoreDouble().writes().find(
      (write) => write.collection === "fact_bank" && write.documentId === expectedId,
    );

    expect(factWrite).toBeDefined();
    expect(factWrite?.data?.status).toBe("pending");
    expect(factWrite?.data?.origin).toBe("report_add");
    expect(factWrite?.data?.explanation).toBe(reportExplanation);
    expect(factWrite?.data).not.toHaveProperty("context");
    expect(factWrite?.data).not.toHaveProperty("verified_at");
    expect(factWrite?.data).not.toHaveProperty("verifier_model");

    const report = firestoreDouble().document(`trivia_reports/${reportId}`);
    expect(report?.data["status"]).toBe("resolved");
    expect(report?.data["resolutionNote"]).toContain(PENDING_ADMISSION_COPY);
    expect(report?.data["resolutionNote"]).toContain("pending");
    expect(report?.data["resolutionNote"]).not.toContain("Added to fact bank");
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("uses canonical explanation with legacy context fallback across fact reads, search, export, and reports", async () => {
    firestoreDouble().seed("fact_bank/canonical_fact", {
      subject: "Canonical fact",
      subject_key: "canonical fact",
      angle: "Reveal",
      angle_key: "reveal",
      explanation: "canonical explanation phrase",
      context: "stale legacy phrase",
      status: "active",
    });
    firestoreDouble().seed("fact_bank/legacy_fact", {
      subject: "Legacy fact",
      subject_key: "legacy fact",
      angle: "Reveal",
      angle_key: "reveal",
      context: "legacy explanation phrase",
      status: "active",
    });
    firestoreDouble().seed("trivia_reports/report_canonical", {
      topic: "Report topic",
      status: "pending_review",
      explanation: "report canonical explanation",
      context: "report legacy explanation",
    });
    firestoreDouble().seed("trivia_reports/report_legacy", {
      topic: "Report topic",
      status: "pending_review",
      context: "report legacy explanation",
    });

    const canonical = toFact(firestoreDouble().document("fact_bank/canonical_fact")!);
    const legacy = toFact(firestoreDouble().document("fact_bank/legacy_fact")!);
    expect(canonical.context).toBe("canonical explanation phrase");
    expect(legacy.context).toBe("legacy explanation phrase");
    expect(canonicalExplanation({ explanation: "  ", context: "fallback" })).toBe("fallback");

    const listed = await listFacts({ search: "canonical explanation phrase", pageSize: 100 });
    expect(listed.facts.map((fact) => fact.id)).toEqual(["canonical_fact"]);

    const exported = await exportFacts({ search: "legacy explanation phrase", pageSize: 100 });
    expect(exported.map((fact) => fact.id)).toEqual(["legacy_fact"]);

    const reports = await listReports({});
    const reportById = new Map(reports.map((report) => [report.id, report]));
    expect(reportById.get("report_canonical")?.explanation).toBe("report canonical explanation");
    expect(reportById.get("report_legacy")?.explanation).toBe("report legacy explanation");
    expect(blockedNetworkAttempts()).toEqual([]);
  });
});
