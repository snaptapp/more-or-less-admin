/**
 * Read-only Fact Bank ops surface for the Notion Ops Assistant.
 *
 * Reuses Admin bank observability and Firestore reads. Does not reimplement
 * Foundry validation, mutate fact_bank, or write deployed JSON.
 */
import {
  createDoc,
  getDoc,
  listDocs,
  patchDoc,
  type FirestoreDoc,
} from "../firebase/firestore.server";
import {
  EXPORTED_DELTA_DEFINITION,
  HYDRATION_EXPLANATION,
  fetchDeployedBank,
  getBankObservability,
  toFact,
  type BankObservabilityDependencies,
  type FactRecord,
} from "./content.server";
import { STATUS } from "./contract";
import { listSubjects } from "./ops.server";

export type FactbankDimension =
  | "topic"
  | "match_scope"
  | "genre"
  | "difficulty"
  | "status"
  | "source";

export const FACTBANK_DIMENSIONS: readonly FactbankDimension[] = [
  "topic",
  "match_scope",
  "genre",
  "difficulty",
  "status",
  "source",
] as const;

const SCAN_PAGE_SIZE = 300;
const DEFAULT_SCAN_CAP = 12_000;
const EXAMPLE_CAP = 8;

export interface OpsFactbankDependencies extends BankObservabilityDependencies {
  readonly scanCap?: number;
  readonly now?: () => Date;
}

function nowIso(deps: OpsFactbankDependencies): string {
  return (deps.now ?? (() => new Date()))().toISOString();
}

async function listFactDocs(cap: number): Promise<FirestoreDoc[]> {
  const docs: FirestoreDoc[] = [];
  let pageToken: string | undefined;
  do {
    const page = await listDocs("fact_bank", { pageSize: SCAN_PAGE_SIZE, pageToken });
    docs.push(...page.docs);
    pageToken = page.nextPageToken;
    if (docs.length >= cap) break;
  } while (pageToken);
  return docs.slice(0, cap);
}

async function loadFacts(deps: OpsFactbankDependencies): Promise<{
  facts: FactRecord[];
  scanned: number;
  capped: boolean;
}> {
  const cap = deps.scanCap ?? DEFAULT_SCAN_CAP;
  const docs = await listFactDocs(cap + 1);
  const capped = docs.length > cap;
  const facts = docs.slice(0, cap).map(toFact);
  return { facts, scanned: facts.length, capped };
}

function healthStatus(input: {
  deployedKnown: boolean;
  firestoreActive: number;
  servingCount: number | null;
}): "healthy" | "warning" | "critical" | "unknown" {
  if (!input.deployedKnown || input.servingCount === null) {
    return "unknown";
  }
  if (input.firestoreActive > 0 && input.servingCount === 0) {
    return "critical";
  }
  return "healthy";
}

/**
 * Three-layer health: Firestore canonical, deployed serving snapshot, pack KV role note.
 *
 * In this codebase the exported JSON becomes the Worker-embedded serving bank
 * only after hydration PR merge + deploy. There is no separate live "export KV
 * fact bank"; TRIVIA_CACHE caches packs, not bank rows.
 */
export async function factbankHealth(deps: OpsFactbankDependencies = {}) {
  const checkedAt = nowIso(deps);
  const obs = await getBankObservability(deps);
  const serving =
    obs.deployed.state === "known"
      ? {
          total_facts: obs.deployed.factCount,
          version: obs.deployed.bankVersion,
          ddm_version: obs.deployed.ddmVersion,
          updated_at: null as string | null,
          source: "game_worker_/api/bank/version",
        }
      : null;

  const firestoreActive = obs.firestore.active;
  const servingCount = serving?.total_facts ?? null;
  const delta = obs.exportedDelta;
  const status = healthStatus({
    deployedKnown: obs.deployed.state === "known",
    firestoreActive,
    servingCount,
  });

  return {
    checked_at: checkedAt,
    hydration_explanation: HYDRATION_EXPLANATION,
    exported_delta_definition: EXPORTED_DELTA_DEFINITION,
    firestore: {
      total_facts: obs.firestore.total,
      active_facts: obs.firestore.active,
      lifecycle: obs.firestore.lifecycle,
    },
    export: {
      note:
        "Export artifact becomes the deployed serving snapshot after hydration PR merge and Worker deployment. This endpoint reports the deployed serving stamp as the published export players hit.",
      total_facts: servingCount,
      generated_at: null as string | null,
      version: null,
    },
    kv: {
      note:
        "Cloudflare TRIVIA_CACHE stores generated packs keyed by topic, not fact_bank rows. Use Cloudflare State Inspector for KV reachability.",
      role: "pack_cache_not_fact_bank",
      total_facts: null as number | null,
      version: null as string | null,
      updated_at: null as string | null,
    },
    serving,
    drift: {
      firestore_vs_export: delta,
      export_vs_kv: null as number | null,
      firestore_active_vs_serving: delta,
      first_divergence:
        obs.deployed.state !== "known"
          ? "serving_unknown"
          : delta === 0
            ? "none"
            : "firestore→serving",
    },
    deployed_raw: obs.deployed,
    status,
  };
}

function dimensionKey(
  dimension: FactbankDimension,
  fact: FactRecord,
  subjectMeta: Map<string, { category: string; sub_category: string }>,
): string {
  switch (dimension) {
    case "topic":
      return fact.subject || "(missing topic)";
    case "genre":
      return (
        fact.category ||
        subjectMeta.get(fact.subject_key)?.category ||
        subjectMeta.get(fact.subject.toLowerCase())?.category ||
        "(uncategorised)"
      );
    case "match_scope":
      return (
        subjectMeta.get(fact.subject_key)?.sub_category ||
        subjectMeta.get(fact.subject.toLowerCase())?.sub_category ||
        "(no match scope)"
      );
    case "difficulty":
      return fact.difficulty_hint?.trim() || "(unset)";
    case "status":
      return String(fact.status || "(unset)");
    case "source":
      if (fact.source_urls.length) return "has_source_urls";
      if (fact.verifier_model) return `verifier:${fact.verifier_model}`;
      return "missing_source";
    default: {
      const _exhaustive: never = dimension;
      return _exhaustive;
    }
  }
}

/** Aggregated distribution for one taxonomy/status dimension. */
export async function factbankBreakdown(
  dimension: FactbankDimension,
  deps: OpsFactbankDependencies = {},
) {
  const checkedAt = nowIso(deps);
  if (!FACTBANK_DIMENSIONS.includes(dimension)) {
    throw new Error(`Unsupported dimension: ${dimension}`);
  }

  const [{ facts, scanned, capped }, subjects] = await Promise.all([
    loadFacts(deps),
    listSubjects({}),
  ]);

  const subjectMeta = new Map<string, { category: string; sub_category: string }>();
  for (const subject of subjects.subjects) {
    subjectMeta.set(subject.id, {
      category: subject.category,
      sub_category: subject.sub_category,
    });
    subjectMeta.set(subject.subject.toLowerCase(), {
      category: subject.category,
      sub_category: subject.sub_category,
    });
  }

  const counts = new Map<string, { total: number; active: number }>();
  for (const fact of facts) {
    const key = dimensionKey(dimension, fact, subjectMeta);
    const entry = counts.get(key) ?? { total: 0, active: 0 };
    entry.total += 1;
    if (fact.status === STATUS.active) entry.active += 1;
    counts.set(key, entry);
  }

  const buckets = [...counts.entries()]
    .map(([key, stats]) => ({ key, ...stats }))
    .sort((a, b) => a.active - b.active || a.total - b.total || a.key.localeCompare(b.key));

  return {
    checked_at: checkedAt,
    dimension,
    scanned,
    capped,
    bucket_count: buckets.length,
    thinnest: buckets.slice(0, 25),
    densest: [...buckets].reverse().slice(0, 15),
  };
}

type ValidationRule =
  | "missing_subject"
  | "missing_angle"
  | "missing_true_number"
  | "invalid_comparison_value"
  | "missing_source"
  | "missing_scope"
  | "missing_question"
  | "duplicate_quality_flag";

function validateFact(
  fact: FactRecord,
  subjectMeta: Map<string, { category: string; sub_category: string }>,
): ValidationRule[] {
  const rules: ValidationRule[] = [];
  if (!fact.subject.trim()) rules.push("missing_subject");
  if (!fact.angle.trim()) rules.push("missing_angle");
  if (fact.true_number === null || fact.true_number === undefined) {
    rules.push("missing_true_number");
  } else if (!Number.isFinite(fact.true_number)) {
    rules.push("invalid_comparison_value");
  }
  if (!fact.source_urls.length && !fact.verifier_model) rules.push("missing_source");
  const scope =
    subjectMeta.get(fact.subject_key)?.sub_category ||
    subjectMeta.get(fact.subject.toLowerCase())?.sub_category ||
    "";
  if (!fact.category && !scope) rules.push("missing_scope");
  if (!fact.question.trim() && !fact.claim_template.trim()) rules.push("missing_question");
  if (
    fact.quality_flags.some((flag) =>
      ["duplicate_question", "conflicting_answer"].includes(flag),
    )
  ) {
    rules.push("duplicate_quality_flag");
  }
  return rules;
}

/** Aggregated validator results (not per-row dumps). */
export async function factbankValidate(deps: OpsFactbankDependencies = {}) {
  const checkedAt = nowIso(deps);
  const [{ facts, scanned, capped }, subjects] = await Promise.all([
    loadFacts(deps),
    listSubjects({}),
  ]);
  const subjectMeta = new Map<string, { category: string; sub_category: string }>();
  for (const subject of subjects.subjects) {
    subjectMeta.set(subject.id, {
      category: subject.category,
      sub_category: subject.sub_category,
    });
    subjectMeta.set(subject.subject.toLowerCase(), {
      category: subject.category,
      sub_category: subject.sub_category,
    });
  }

  const byRule: Record<string, number> = {};
  const examples: Array<{
    id: string;
    subject: string;
    status: string;
    rules: ValidationRule[];
  }> = [];
  let valid = 0;
  let warnings = 0;
  let errors = 0;

  for (const fact of facts) {
    const rules = validateFact(fact, subjectMeta);
    if (!rules.length) {
      valid += 1;
      continue;
    }
    const isError = rules.some((rule) =>
      [
        "missing_true_number",
        "invalid_comparison_value",
        "missing_subject",
        "missing_angle",
      ].includes(rule),
    );
    if (isError) errors += 1;
    else warnings += 1;
    for (const rule of rules) byRule[rule] = (byRule[rule] ?? 0) + 1;
    if (examples.length < EXAMPLE_CAP) {
      examples.push({
        id: fact.id,
        subject: fact.subject,
        status: String(fact.status),
        rules,
      });
    }
  }

  return {
    checked_at: checkedAt,
    scanned,
    capped,
    valid,
    warnings,
    errors,
    by_rule: byRule,
    examples,
    authority_note:
      "Aggregated from Admin FactRecord fields. Foundry lint remains the semantic authority for banked-fact promotion.",
  };
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Duplicate clusters: exact claim text, subject+value, normalized comparison. */
export async function factbankDuplicates(deps: OpsFactbankDependencies = {}) {
  const checkedAt = nowIso(deps);
  const { facts, scanned, capped } = await loadFacts(deps);

  const byQuestion = new Map<string, FactRecord[]>();
  const bySubjectValue = new Map<string, FactRecord[]>();
  const byNormalizedClaim = new Map<string, FactRecord[]>();

  for (const fact of facts) {
    if (fact.status !== STATUS.active && fact.status !== STATUS.pending) continue;
    const q = normalizeText(fact.question || fact.claim_template);
    if (q) {
      const list = byQuestion.get(q) ?? [];
      list.push(fact);
      byQuestion.set(q, list);
    }
    if (fact.subject_key && fact.true_number !== null) {
      const key = `${fact.subject_key}::${fact.true_number}`;
      const list = bySubjectValue.get(key) ?? [];
      list.push(fact);
      bySubjectValue.set(key, list);
    }
    const claim = normalizeText(fact.claim_template || fact.question);
    if (claim) {
      const list = byNormalizedClaim.get(claim) ?? [];
      list.push(fact);
      byNormalizedClaim.set(claim, list);
    }
  }

  const toClusters = (map: Map<string, FactRecord[]>, kind: string) =>
    [...map.entries()]
      .filter(([, rows]) => rows.length > 1)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 25)
      .map(([key, rows]) => ({
        kind,
        key,
        count: rows.length,
        ids: rows.slice(0, 10).map((row) => row.id),
        subjects: [...new Set(rows.map((row) => row.subject))].slice(0, 5),
      }));

  const exact_question = toClusters(byQuestion, "exact_question_or_claim");
  const subject_value = toClusters(bySubjectValue, "same_subject_same_value");
  const normalized_comparison = toClusters(byNormalizedClaim, "same_normalized_comparison");

  return {
    checked_at: checkedAt,
    scanned,
    capped,
    summary: {
      exact_question_clusters: exact_question.length,
      subject_value_clusters: subject_value.length,
      normalized_comparison_clusters: normalized_comparison.length,
      near_duplicates: 0,
    },
    exact_question,
    subject_value,
    normalized_comparison,
    near_duplicates_note:
      "Near-duplicate similarity is not implemented; only deterministic exact/normalized matches are reported.",
  };
}

/** Explicit layer divergence report. */
export async function factbankDrift(deps: OpsFactbankDependencies = {}) {
  const health = await factbankHealth(deps);
  return {
    checked_at: health.checked_at,
    layers: {
      firestore_canonical: health.firestore,
      export_published_as_serving: health.export,
      serving_players_hit: health.serving,
      pack_kv: health.kv,
    },
    drift: health.drift,
    status: health.status,
    hydration_explanation: health.hydration_explanation,
    recommendation:
      health.drift.first_divergence === "none"
        ? "No Firestore-active vs serving divergence detected."
        : health.drift.first_divergence === "serving_unknown"
          ? "Cannot compare: GAME_WORKER_URL bank-version endpoint is unavailable."
          : "Divergence starts at Firestore → serving publication (export → hydration PR → Worker deploy).",
  };
}

/** Topic / match-scope inspection for conversational queries like "Inspect Disco". */
export async function factbankInspect(
  topicOrScope: string,
  deps: OpsFactbankDependencies = {},
) {
  const checkedAt = nowIso(deps);
  const query = topicOrScope.trim();
  if (!query) throw new Error("topic_or_scope is required");

  const [{ facts, scanned, capped }, subjects, deployed] = await Promise.all([
    loadFacts(deps),
    listSubjects({ search: query }),
    fetchDeployedBank(deps),
  ]);

  const q = query.toLowerCase();
  const matchedSubjects = subjects.subjects.filter(
    (subject) =>
      subject.subject.toLowerCase().includes(q) ||
      subject.sub_category.toLowerCase().includes(q) ||
      subject.category.toLowerCase().includes(q) ||
      subject.aliases.some((alias) => alias.toLowerCase().includes(q)),
  );
  const subjectKeys = new Set(matchedSubjects.map((subject) => subject.id));
  const matchedFacts = facts.filter(
    (fact) =>
      subjectKeys.has(fact.subject_key) ||
      fact.subject.toLowerCase().includes(q) ||
      (fact.category ?? "").toLowerCase().includes(q),
  );

  const active = matchedFacts.filter((fact) => fact.status === STATUS.active);
  const validation = matchedFacts.flatMap((fact) => {
    const meta = new Map<string, { category: string; sub_category: string }>();
    for (const subject of matchedSubjects) {
      meta.set(subject.id, {
        category: subject.category,
        sub_category: subject.sub_category,
      });
    }
    return validateFact(fact, meta).map((rule) => ({ id: fact.id, rule }));
  });

  return {
    checked_at: checkedAt,
    query,
    matched_subjects: matchedSubjects.slice(0, 20).map((subject) => ({
      id: subject.id,
      subject: subject.subject,
      genre: subject.category,
      match_scope: subject.sub_category,
      fact_count: subject.fact_count,
    })),
    facts: matchedFacts.length,
    active: active.length,
    pending: matchedFacts.filter((fact) => fact.status === STATUS.pending).length,
    validation_warnings: validation.length,
    validation_examples: validation.slice(0, EXAMPLE_CAP),
    serving_bank_total_facts:
      deployed.state === "known" ? deployed.factCount : null,
    serving_bank_version: deployed.state === "known" ? deployed.bankVersion : null,
    sample_ids: active.slice(0, 10).map((fact) => fact.id),
    scanned,
    capped,
  };
}

type SnapshotDoc = {
  checked_at: string;
  firestore_active: number;
  firestore_total: number;
  serving_facts: number | null;
  serving_version: string | null;
  validation_errors: number | null;
  validation_warnings: number | null;
  status: string;
};

async function readPreviousSnapshot(): Promise<SnapshotDoc | null> {
  const doc = await getDoc("ops_assistant_snapshots/factbank_latest");
  if (!doc) return null;
  const d = doc.data;
  return {
    checked_at: typeof d["checked_at"] === "string" ? d["checked_at"] : "",
    firestore_active: typeof d["firestore_active"] === "number" ? d["firestore_active"] : 0,
    firestore_total: typeof d["firestore_total"] === "number" ? d["firestore_total"] : 0,
    serving_facts: typeof d["serving_facts"] === "number" ? d["serving_facts"] : null,
    serving_version: typeof d["serving_version"] === "string" ? d["serving_version"] : null,
    validation_errors:
      typeof d["validation_errors"] === "number" ? d["validation_errors"] : null,
    validation_warnings:
      typeof d["validation_warnings"] === "number" ? d["validation_warnings"] : null,
    status: typeof d["status"] === "string" ? d["status"] : "unknown",
  };
}

async function writeSnapshot(snapshot: SnapshotDoc): Promise<void> {
  const payload = { ...snapshot, updated_at: new Date().toISOString() };
  const existing = await getDoc("ops_assistant_snapshots/factbank_latest");
  if (existing) {
    await patchDoc("ops_assistant_snapshots/factbank_latest", payload);
    return;
  }
  await createDoc("ops_assistant_snapshots", "factbank_latest", payload);
}

function deltaLine(
  label: string,
  previous: number | null | undefined,
  current: number | null | undefined,
): string | null {
  if (previous === null || previous === undefined || current === null || current === undefined) {
    return null;
  }
  if (previous === current) return `${label}  ${current}  (unchanged)`;
  const sign = current - previous >= 0 ? "+" : "";
  return `${label}  ${previous} → ${current}  ${sign}${current - previous}`;
}

/**
 * Composed system snapshot for "Anything wrong with More or Less?".
 * Persist is opt-in (`persist: true` / `?persist=1`) so plain GETs stay read-only.
 * When enabled, writes tiny bookkeeping to ops_assistant_snapshots/factbank_latest.
 */
export async function molSystemSnapshot(
  deps: OpsFactbankDependencies & { readonly persist?: boolean; readonly includeValidation?: boolean } = {},
) {
  const checkedAt = nowIso(deps);
  const [health, previous, validation] = await Promise.all([
    factbankHealth(deps),
    readPreviousSnapshot(),
    deps.includeValidation === false
      ? Promise.resolve(null)
      : factbankValidate({ ...deps, scanCap: Math.min(deps.scanCap ?? DEFAULT_SCAN_CAP, 4000) }),
  ]);

  const current: SnapshotDoc = {
    checked_at: checkedAt,
    firestore_active: health.firestore.active_facts,
    firestore_total: health.firestore.total_facts,
    serving_facts: health.serving?.total_facts ?? null,
    serving_version: health.serving?.version ?? null,
    validation_errors: validation?.errors ?? null,
    validation_warnings: validation?.warnings ?? null,
    status: health.status,
  };

  if (deps.persist === true) {
    await writeSnapshot(current);
  }

  const changes = [
    deltaLine("fact_count_active", previous?.firestore_active, current.firestore_active),
    deltaLine("fact_count_total", previous?.firestore_total, current.firestore_total),
    deltaLine("serving_facts", previous?.serving_facts, current.serving_facts),
    deltaLine("validation_errors", previous?.validation_errors, current.validation_errors),
    deltaLine("validation_warnings", previous?.validation_warnings, current.validation_warnings),
    previous?.serving_version &&
    current.serving_version &&
    previous.serving_version !== current.serving_version
      ? `serving_version  ${previous.serving_version} → ${current.serving_version}`
      : null,
  ].filter((line): line is string => Boolean(line));

  const anomalies: string[] = [];
  if (health.status === "critical" || health.status === "warning") {
    anomalies.push(
      `Fact bank drift status=${health.status}; first_divergence=${health.drift.first_divergence}`,
    );
  }
  if (validation && validation.errors > 0) {
    anomalies.push(`Validation errors=${validation.errors} warnings=${validation.warnings}`);
  }
  if (health.deployed_raw.state === "unknown") {
    anomalies.push(`Serving stamp unknown: ${health.deployed_raw.reason}`);
  }

  return {
    checked_at: checkedAt,
    game: {
      production_status: health.status,
      serving: health.serving,
    },
    fact_bank: {
      firestore: health.firestore,
      export: health.export,
      kv: health.kv,
      drift: health.drift,
    },
    cloudflare: {
      note: "Use Cloudflare State Inspector tools (production_health / worker_health) for deployment, bindings, and runtime errors.",
    },
    recent_change: {
      previous_checked_at: previous?.checked_at ?? null,
      lines: changes,
    },
    anomalies,
    validation_summary: validation
      ? {
          valid: validation.valid,
          warnings: validation.warnings,
          errors: validation.errors,
          by_rule: validation.by_rule,
          scanned: validation.scanned,
          capped: validation.capped,
        }
      : null,
    persist: deps.persist === true,
  };
}
