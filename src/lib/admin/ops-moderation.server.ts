/**
 * Moderation inbox for the Ops Assistant.
 *
 * Lists the same pending `trivia_reports` queue the admin inbox shows, runs the
 * existing read-only copilot, and applies one inbox button through `resolveReport`.
 * Lifecycle changes stay on that path, including the Foundry-only pending to active edge.
 */

import type { AdminUser } from "@/lib/firebase/verify.server";
import type { CopilotReview, CopilotVerdict } from "./report-copilot.server";
import {
  findDuplicateFactsForReport,
  findFactForReport,
  getReport,
  listReports,
  resolveReport,
  type FactRecord,
  type ReportRecord,
} from "./content.server";
import { logAdminAction } from "@/lib/firebase/audit.server";
import { countCollection } from "@/lib/firebase/firestore.server";

const QUEUE_LIMIT = 100;

const OPS_ACTOR: AdminUser = {
  uid: "ops-assistant",
  email: "ops-assistant@snaptapp.us",
  name: "More-or-Less Ops Assistant",
  isClaimAdmin: false,
};

export const MODERATION_ACTIONS = [
  "retire_fact",
  "fix_number",
  "reject",
  "resolve_only",
  "add_to_bank",
  "resolve_duplicate",
  "edit_fact",
  "resolve_as_is",
] as const;

export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

export class ModerationRequestError extends Error {
  readonly status: 400 | 404;

  constructor(message: string, status: 400 | 404) {
    super(message);
    this.name = "ModerationRequestError";
    this.status = status;
  }
}

export interface ModerationButton {
  action: ModerationAction;
  label: string;
  factId?: string;
  keepFactId?: string;
  retireFactIds?: string[];
  requires?: Array<"correctedNumber" | "factUpdates">;
}

export interface ModerationFactSummary {
  id: string;
  subject: string;
  angle: string;
  question: string;
  claim_template: string;
  true_number: number | null;
  unit: string;
  status: string;
  quality_flags: string[];
  context: string;
  source_urls: string[];
}

export interface ModerationQueueItem {
  report: {
    id: string;
    topic: string;
    claimStatement: string;
    explanation: string;
    presentedNumber: number | null;
    trueNumber: number | null;
    unit: string;
    reason: string;
    feedbackText: string;
    status: string;
    createdAt: string | null;
    qualityFlags: string[];
    duplicateFactIds: string[];
    ombudsmanVerdict: string | null;
    factId: string | null;
  };
  fact: ModerationFactSummary | null;
  duplicates: ModerationFactSummary[];
  buttons: ModerationButton[];
}

export interface ModerationFactUpdates {
  question?: string;
  claim_template?: string;
  true_number?: number;
  unit?: string;
  plausible_min?: string;
  plausible_max?: string;
  quantity_kind?: string;
  explanation?: string;
  context?: string;
  surprise_factor?: number;
}

export interface ModerationActInput {
  reportId: string;
  action: ModerationAction;
  correctedNumber?: number;
  factUpdates?: ModerationFactUpdates;
  note?: string;
  keepFactId?: string;
  copilot?: {
    verdict: string;
    confidence: string;
    score: number;
    needsReview: boolean;
  };
}

export interface ModerationRecommendation {
  apply: boolean;
  reason: string;
  action: ModerationAction | null;
  label: string | null;
  factId?: string;
  keepFactId?: string;
  retireFactIds?: string[];
  correctedNumber?: number;
  factUpdates?: ModerationFactUpdates;
}

function summarizeFact(fact: FactRecord): ModerationFactSummary {
  return {
    id: fact.id,
    subject: fact.subject,
    angle: fact.angle,
    question: fact.question,
    claim_template: fact.claim_template,
    true_number: fact.true_number,
    unit: fact.unit,
    status: fact.status,
    quality_flags: fact.quality_flags ?? [],
    context: fact.context,
    source_urls: fact.source_urls ?? [],
  };
}

function summarizeReport(report: ReportRecord): ModerationQueueItem["report"] {
  return {
    id: report.id,
    topic: report.topic,
    claimStatement: report.claimStatement,
    explanation: report.explanation,
    presentedNumber: report.presentedNumber,
    trueNumber: report.trueNumber,
    unit: report.unit,
    reason: report.reason,
    feedbackText: report.feedbackText,
    status: report.status,
    createdAt: report.createdAt,
    qualityFlags: report.qualityFlags ?? [],
    duplicateFactIds: report.duplicateFactIds ?? [],
    ombudsmanVerdict: report.ombudsmanVerdict ?? null,
    factId: report.factId ?? null,
  };
}

/** Inbox buttons for one pending report. Matches the admin report card. */
export function moderationButtons(
  report: ReportRecord,
  fact: FactRecord | null,
  duplicates: FactRecord[],
): ModerationButton[] {
  if (duplicates.length > 0 && fact) {
    const all = [fact, ...duplicates];
    const keepers = all.map((keep) => ({
      action: "resolve_duplicate" as const,
      label: `Keep ${keep.id} and retire the other conflicting facts`,
      keepFactId: keep.id,
      retireFactIds: all.filter((other) => other.id !== keep.id).map((other) => other.id),
    }));
    return [...keepers, { action: "reject", label: "Reject report" }];
  }

  const buttons: ModerationButton[] = [];
  if (fact) {
    buttons.push({ action: "retire_fact", label: "Accept & retire fact", factId: fact.id });
    buttons.push({
      action: "fix_number",
      label: "Accept & fix number",
      factId: fact.id,
      requires: ["correctedNumber"],
    });
    buttons.push({
      action: "edit_fact",
      label: "Edit Fact Details",
      factId: fact.id,
      requires: ["factUpdates"],
    });
    const flags = [...(fact.quality_flags ?? []), ...(report.qualityFlags ?? [])];
    if (flags.length > 0) {
      buttons.push({
        action: "resolve_as_is",
        label: "Accept As-Is (Clear Flags)",
        factId: fact.id,
      });
    }
  } else {
    buttons.push({ action: "resolve_only", label: "Accept & resolve report" });
    buttons.push({
      action: "add_to_bank",
      label: "Accept & add to fact bank",
      requires: ["correctedNumber"],
    });
  }
  buttons.push({ action: "reject", label: "Reject report" });
  return buttons;
}

async function loadPendingItem(reportId: string): Promise<ModerationQueueItem> {
  const report = await getReport(reportId);
  if (!report || report.status !== "pending_review") {
    throw new ModerationRequestError("Report not found or no longer pending.", 404);
  }
  const pending = await listReports({ status: "pending_review", limit: QUEUE_LIMIT });
  const reports = pending.some((item) => item.id === report.id) ? pending : [report, ...pending];
  const fact = await findFactForReport(report);
  const duplicates = await findDuplicateFactsForReport(report, fact, reports);
  return {
    report: summarizeReport(report),
    fact: fact ? summarizeFact(fact) : null,
    duplicates: duplicates.map(summarizeFact),
    buttons: moderationButtons(report, fact, duplicates),
  };
}

/** Pending moderation inbox: full count, plus one page of reports, facts, and buttons. */
export async function moderationQueue(offset = 0): Promise<{
  status: "pending_review";
  count: number;
  limit: number;
  offset: number;
  next_offset: number | null;
  truncated: boolean;
  checked_at: string;
  items: ModerationQueueItem[];
}> {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ModerationRequestError("offset must be a non-negative integer.", 400);
  }
  const [count, reports] = await Promise.all([
    countCollection("trivia_reports", [{ field: "status", op: "EQUAL", value: "pending_review" }]),
    listReports({ status: "pending_review", limit: QUEUE_LIMIT, offset }),
  ]);
  const items = await Promise.all(
    reports.map(async (report) => {
      const fact = await findFactForReport(report);
      const duplicates = await findDuplicateFactsForReport(report, fact, reports);
      return {
        report: summarizeReport(report),
        fact: fact ? summarizeFact(fact) : null,
        duplicates: duplicates.map(summarizeFact),
        buttons: moderationButtons(report, fact, duplicates),
      };
    }),
  );
  const nextOffset = offset + items.length;
  const truncated = items.length === QUEUE_LIMIT && nextOffset < count;
  return {
    status: "pending_review",
    count,
    limit: QUEUE_LIMIT,
    offset,
    next_offset: truncated ? nextOffset : null,
    truncated,
    checked_at: new Date().toISOString(),
    items,
  };
}

function buttonForAction(item: ModerationQueueItem, input: ModerationActInput): ModerationButton {
  const match = item.buttons.find((button) => {
    if (button.action !== input.action) return false;
    if (button.action === "resolve_duplicate") return button.keepFactId === input.keepFactId;
    return true;
  });
  if (!match) {
    const labels = item.buttons.map((button) => button.label).join("; ");
    throw new ModerationRequestError(
      `That moderation button is not available for this report. Available: ${labels}`,
      400,
    );
  }
  return match;
}

function requireFiniteNumber(value: number | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ModerationRequestError(`${label} is required for this button.`, 400);
  }
  return value;
}

function cleanUpdates(updates: ModerationFactUpdates | undefined): ModerationFactUpdates {
  if (!updates) {
    throw new ModerationRequestError("factUpdates is required for Edit Fact Details.", 400);
  }
  const next: ModerationFactUpdates = {};
  if (updates.question !== undefined) next.question = updates.question;
  if (updates.claim_template !== undefined) next.claim_template = updates.claim_template;
  if (updates.true_number !== undefined) next.true_number = updates.true_number;
  if (updates.unit !== undefined) next.unit = updates.unit;
  if (updates.plausible_min !== undefined) next.plausible_min = updates.plausible_min;
  if (updates.plausible_max !== undefined) next.plausible_max = updates.plausible_max;
  if (updates.quantity_kind !== undefined) next.quantity_kind = updates.quantity_kind;
  if (updates.explanation !== undefined) next.explanation = updates.explanation;
  if (updates.context !== undefined) next.context = updates.context;
  if (updates.surprise_factor !== undefined) next.surprise_factor = updates.surprise_factor;
  if (Object.keys(next).length === 0) {
    throw new ModerationRequestError("factUpdates must change at least one fact field.", 400);
  }
  return next;
}

/** Press one inbox button for a pending report. */
export async function moderationAct(input: ModerationActInput): Promise<{ ok: true; reportId: string; action: ModerationAction }> {
  const reportId = input.reportId.trim();
  if (!reportId) throw new ModerationRequestError("reportId is required.", 400);
  if (!MODERATION_ACTIONS.includes(input.action)) {
    throw new ModerationRequestError(`Unknown moderation action '${input.action}'.`, 400);
  }

  const item = await loadPendingItem(reportId);
  const button = buttonForAction(item, input);
  const note = input.note?.trim()
    ? `${input.note.trim()} | via Ops Assistant`
    : "via Ops Assistant";

  const correctedNumber =
    input.action === "fix_number" || input.action === "add_to_bank"
      ? requireFiniteNumber(input.correctedNumber, "correctedNumber")
      : input.correctedNumber;
  const factUpdates = input.action === "edit_fact" ? cleanUpdates(input.factUpdates) : input.factUpdates;

  await resolveReport({
    reportId,
    action: input.action,
    factId: button.factId ?? item.fact?.id,
    correctedNumber,
    factUpdates,
    note,
    topic: item.report.topic,
    claimStatement: item.report.claimStatement,
    unit: item.report.unit,
    keepFactId: button.keepFactId,
    retireFactIds: button.retireFactIds,
  });

  const copilot = input.copilot;
  await logAdminAction(OPS_ACTOR, {
    action: `report.${input.action}`,
    targetType: "report",
    targetId: reportId,
    details: `Report action: ${input.action} | via Ops Assistant${copilot ? ` | copilot ${copilot.verdict} (${copilot.confidence}, ${copilot.score})` : " | no copilot review"}`,
    after: {
      action: input.action,
      factId: button.factId ?? item.fact?.id ?? null,
      correctedNumber: correctedNumber ?? null,
      keepFactId: button.keepFactId ?? null,
      retireFactIds: button.retireFactIds ?? null,
      note,
      copilot: copilot ?? null,
    },
  });

  return { ok: true, reportId, action: input.action };
}

function hasButton(buttons: ModerationButton[], action: ModerationAction): ModerationButton | undefined {
  return buttons.find((button) => button.action === action);
}

function suggestedUpdates(suggested: CopilotReview["suggested"]): ModerationFactUpdates {
  const updates: ModerationFactUpdates = {};
  if (suggested.question) updates.question = suggested.question;
  if (suggested.claim_template) updates.claim_template = suggested.claim_template;
  if (suggested.unit) updates.unit = suggested.unit;
  if (suggested.context) updates.context = suggested.context;
  if (typeof suggested.true_number === "number" && Number.isFinite(suggested.true_number)) {
    updates.true_number = suggested.true_number;
  }
  return updates;
}

/** Map a copilot verdict onto one inbox button. `apply` is false when the verdict is not safe to press. */
export function recommendModerationAction(
  review: Pick<CopilotReview, "verdict" | "suggested" | "policy" | "duplicateResolution">,
  buttons: ModerationButton[],
): ModerationRecommendation {
  const blocked = review.verdict === "unclear" || review.policy.needsReview;
  const blockReason = review.verdict === "unclear"
    ? "Copilot verdict is unclear. Do not press a moderation button."
    : `Copilot needs closer review: ${review.policy.reasons.join(" ") || "low confidence"}. Do not press a moderation button.`;

  const named = (button: ModerationButton | undefined, extra: Partial<ModerationRecommendation> = {}): ModerationRecommendation => {
    if (!button) {
      return {
        apply: false,
        reason: "Copilot verdict does not match a button on this report.",
        action: null,
        label: null,
      };
    }
    return {
      apply: !blocked,
      reason: blocked ? blockReason : `Copilot verdict ${review.verdict} matches ${button.label}.`,
      action: button.action,
      label: button.label,
      factId: button.factId,
      keepFactId: button.keepFactId,
      retireFactIds: button.retireFactIds,
      ...extra,
    };
  };

  const verdict: CopilotVerdict = review.verdict;
  switch (verdict) {
    case "unclear":
      return { apply: false, reason: blockReason, action: null, label: null };
    case "uphold_fact":
      return named(hasButton(buttons, "resolve_as_is") ?? hasButton(buttons, "reject"));
    case "fix_number": {
      const number = review.suggested.true_number;
      if (typeof number !== "number" || !Number.isFinite(number)) {
        return {
          apply: false,
          reason: "Copilot wants a number fix but did not suggest a finite true_number.",
          action: "fix_number",
          label: hasButton(buttons, "fix_number")?.label ?? null,
        };
      }
      return named(hasButton(buttons, "fix_number"), { correctedNumber: number });
    }
    case "edit_fact": {
      const factUpdates = suggestedUpdates(review.suggested);
      if (Object.keys(factUpdates).length === 0) {
        return {
          apply: false,
          reason: "Copilot wants an edit but did not suggest any fact fields.",
          action: "edit_fact",
          label: hasButton(buttons, "edit_fact")?.label ?? null,
        };
      }
      return named(hasButton(buttons, "edit_fact"), { factUpdates });
    }
    case "retire_fact":
      return named(hasButton(buttons, "retire_fact"));
    case "resolve_duplicate": {
      const resolution = review.duplicateResolution;
      if (!resolution || resolution.action === "retire_all") {
        return {
          apply: false,
          reason: "Copilot would retire every conflicting fact. The inbox always keeps one. Do not press a button.",
          action: null,
          label: null,
        };
      }
      if (resolution.action === "reject_report") return named(hasButton(buttons, "reject"));
      const keep = buttons.find(
        (button) => button.action === "resolve_duplicate" && button.keepFactId === resolution.keepFactId,
      );
      return named(keep, {
        keepFactId: resolution.keepFactId ?? undefined,
        retireFactIds: resolution.retireFactIds,
      });
    }
    case "add_to_bank":
      return named(hasButton(buttons, "add_to_bank"), {
        correctedNumber: review.suggested.true_number,
      });
    case "resolve_as_is":
      return named(hasButton(buttons, "resolve_as_is"));
    case "reject":
      return named(hasButton(buttons, "reject"));
    default: {
      const exhausted: never = verdict;
      return exhausted;
    }
  }
}

/** Run the existing report copilot and name the inbox button it supports. */
export async function moderationCopilot(reportId: string): Promise<{
  reportId: string;
  review: CopilotReview;
  buttons: ModerationButton[];
  recommendation: ModerationRecommendation;
}> {
  const id = reportId.trim();
  if (!id) throw new ModerationRequestError("reportId is required.", 400);
  const item = await loadPendingItem(id);
  const { reviewReportWithCopilot } = await import("./report-copilot.server");
  const review = await reviewReportWithCopilot({
    topic: item.report.topic,
    claimStatement: item.report.claimStatement,
    presentedNumber: item.report.presentedNumber,
    trueNumber: item.report.trueNumber,
    unit: item.report.unit,
    reason: item.report.reason,
    feedbackText: item.report.feedbackText,
    qualityFlags: item.report.qualityFlags,
    fact: item.fact
      ? {
          id: item.fact.id,
          subject: item.fact.subject,
          angle: item.fact.angle,
          question: item.fact.question,
          claim_template: item.fact.claim_template,
          true_number: item.fact.true_number,
          unit: item.fact.unit,
          context: item.fact.context,
          source_urls: item.fact.source_urls,
          quality_flags: item.fact.quality_flags,
          status: item.fact.status,
        }
      : null,
    duplicateFacts: item.duplicates.map((d) => ({
      id: d.id,
      subject: d.subject,
      angle: d.angle,
      question: d.question,
      claim_template: d.claim_template,
      true_number: d.true_number,
      unit: d.unit,
      context: d.context,
      source_urls: d.source_urls,
      quality_flags: d.quality_flags,
      status: d.status,
    })),
  });
  const recommendation = recommendModerationAction(review, item.buttons);
  await logAdminAction(OPS_ACTOR, {
    action: "report.copilot_review",
    targetType: "report",
    targetId: id,
    details: `Copilot verdict: ${review.verdict} (${review.confidence}, score ${review.policy.score}) | via Ops Assistant`,
    after: {
      verdict: review.verdict,
      confidence: review.confidence,
      score: review.policy.score,
      needsReview: review.policy.needsReview,
      rationale: review.rationale,
      suggested: review.suggested,
      recommendation,
    },
  });
  return { reportId: id, review, buttons: item.buttons, recommendation };
}
