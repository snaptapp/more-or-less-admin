import { beforeEach, describe, expect, it, vi } from "vitest";
import { firestoreDouble } from "./setup";

vi.mock("@/lib/firebase/firestore.server", async () => {
  const { firestoreDouble } = await import("./setup");
  return firestoreDouble().module;
});

import {
  factbankBreakdown,
  factbankDrift,
  factbankDuplicates,
  factbankHealth,
  factbankInspect,
  factbankValidate,
  molSystemSnapshot,
} from "@/lib/admin/ops-factbank.server";

const ENV = { GAME_WORKER_URL: "https://game.example.test" };

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe("ops factbank tools", () => {
  beforeEach(() => {
    firestoreDouble().seedMany({
      "fact_bank/a1": {
        status: "active",
        subject: "Disco",
        subject_key: "disco",
        angle: "Peak year",
        angle_key: "peak-year",
        true_number: 1978,
        unit: "year",
        question: "In what year did disco peak?",
        claim_template: "Disco peaked in YEAR",
        source_urls: ["https://example.com/disco"],
        verifier_model: "foundry",
        category: "Music",
        content_rating: "standard",
        quality_flags: [],
      },
      "fact_bank/a2": {
        status: "active",
        subject: "Disco",
        subject_key: "disco",
        angle: "Peak year dup",
        angle_key: "peak-year-dup",
        true_number: 1978,
        unit: "year",
        question: "In what year did disco peak?",
        claim_template: "Disco peaked in YEAR",
        source_urls: ["https://example.com/disco"],
        verifier_model: "foundry",
        category: "Music",
        content_rating: "standard",
        quality_flags: ["duplicate_question"],
      },
      "fact_bank/p1": {
        status: "pending",
        subject: "Jazz",
        subject_key: "jazz",
        angle: "Birth",
        angle_key: "birth",
        true_number: null,
        unit: "year",
        question: "",
        claim_template: "",
        source_urls: [],
        verifier_model: "",
        category: null,
        content_rating: "standard",
        quality_flags: [],
      },
      "fact_subjects/disco": {
        subject: "Disco",
        category: "Music",
        sub_category: "Genres",
        aliases: [],
        playlist_ids: [],
        fact_count: 2,
        crawl_notes: "",
      },
      "fact_subjects/jazz": {
        subject: "Jazz",
        category: "Music",
        sub_category: "Genres",
        aliases: [],
        playlist_ids: [],
        fact_count: 0,
        crawl_notes: "",
      },
    });
  });

  it("reports firestore vs serving drift in health", async () => {
    const fetchMock = vi.fn(async () =>
      response({ bank_version: "bank-1", fact_count: 2, ddm_version: "ddm-4" }),
    );

    const health = await factbankHealth({
      env: ENV,
      fetch: fetchMock as typeof fetch,
    });

    expect(health.firestore.active_facts).toBe(2);
    expect(health.serving?.total_facts).toBe(2);
    expect(health.drift.firestore_active_vs_serving).toBe(0);
    expect(health.drift.first_divergence).toBe("none");
    expect(health.status).toBe("healthy");
    expect(health.kv.role).toBe("pack_cache_not_fact_bank");
  });

  it("marks serving unknown when the game worker is down", async () => {
    const health = await factbankHealth({
      env: ENV,
      fetch: vi.fn(async () => response({}, 503)) as typeof fetch,
    });
    expect(health.status).toBe("unknown");
    expect(health.drift.first_divergence).toBe("serving_unknown");
  });

  it("breaks down active facts by genre", async () => {
    const result = await factbankBreakdown("genre", { scanCap: 100 });
    expect(result.dimension).toBe("genre");
    expect(result.thinnest.some((bucket) => bucket.key === "Music")).toBe(true);
  });

  it("aggregates validation errors without dumping every row", async () => {
    const result = await factbankValidate({ scanCap: 100 });
    expect(result.errors).toBeGreaterThan(0);
    expect(result.by_rule.missing_true_number).toBeGreaterThan(0);
    expect(result.examples.length).toBeGreaterThan(0);
    expect(result.examples.length).toBeLessThanOrEqual(8);
    expect(result.scanned).toBeGreaterThan(0);
    expect(typeof result.capped).toBe("boolean");
  });

  it("finds exact question duplicate clusters", async () => {
    const result = await factbankDuplicates({ scanCap: 100 });
    expect(result.summary.exact_question_clusters).toBeGreaterThan(0);
    expect(result.exact_question[0]?.count).toBeGreaterThanOrEqual(2);
  });

  it("inspects a topic query", async () => {
    const result = await factbankInspect("Disco", {
      env: ENV,
      fetch: vi.fn(async () =>
        response({ bank_version: "bank-1", fact_count: 2, ddm_version: "ddm-4" }),
      ) as typeof fetch,
      scanCap: 100,
    });
    expect(result.active).toBe(2);
    expect(result.matched_subjects[0]?.subject).toBe("Disco");
  });

  it("matches genre-only inspect queries via subject category", async () => {
    const result = await factbankInspect("Music", {
      env: ENV,
      fetch: vi.fn(async () =>
        response({ bank_version: "bank-1", fact_count: 2, ddm_version: "ddm-4" }),
      ) as typeof fetch,
      scanCap: 100,
    });
    expect(result.matched_subjects.length).toBeGreaterThan(0);
    expect(result.matched_subjects.every((subject) => subject.genre === "Music")).toBe(true);
    expect(result.active).toBe(2);
  });

  it("returns drift recommendation from the first divergent layer", async () => {
    const drift = await factbankDrift({
      env: ENV,
      fetch: vi.fn(async () =>
        response({ bank_version: "bank-1", fact_count: 1, ddm_version: "ddm-4" }),
      ) as typeof fetch,
    });
    expect(drift.drift.first_divergence).toBe("firestore→serving");
    expect(drift.recommendation).toContain("Firestore → serving");
  });

  it("composes a system snapshot with change lines when a previous snapshot exists", async () => {
    firestoreDouble().seedMany({
      "ops_assistant_snapshots/factbank_latest": {
        checked_at: "2026-10-01T00:00:00.000Z",
        firestore_active: 1,
        firestore_total: 2,
        serving_facts: 1,
        serving_version: "bank-0",
        validation_errors: 0,
        validation_warnings: 0,
        status: "warning",
      },
    });

    const snapshot = await molSystemSnapshot({
      env: ENV,
      fetch: vi.fn(async () =>
        response({ bank_version: "bank-1", fact_count: 2, ddm_version: "ddm-4" }),
      ) as typeof fetch,
      scanCap: 100,
      persist: false,
      includeValidation: true,
    });

    expect(snapshot.game.production_status).toBeTruthy();
    expect(snapshot.persist).toBe(false);
    expect(snapshot.recent_change.lines.some((line) => line.includes("fact_count_active"))).toBe(
      true,
    );
    expect(snapshot.validation_summary?.scanned).toBeGreaterThan(0);
    expect(typeof snapshot.validation_summary?.capped).toBe("boolean");
  });

  it("does not write snapshot bookkeeping unless persist is explicitly true", async () => {
    const writesBefore = firestoreDouble().writeCount();
    const snapshot = await molSystemSnapshot({
      env: ENV,
      fetch: vi.fn(async () =>
        response({ bank_version: "bank-1", fact_count: 2, ddm_version: "ddm-4" }),
      ) as typeof fetch,
      scanCap: 100,
      includeValidation: false,
    });

    expect(snapshot.persist).toBe(false);
    expect(firestoreDouble().document("ops_assistant_snapshots/factbank_latest")).toBeNull();
    expect(firestoreDouble().writeCount()).toBe(writesBefore);
  });
});
