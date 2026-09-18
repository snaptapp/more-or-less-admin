/**
 * Coverage for the in-memory service doubles (task 6.4).
 *
 * Feature: admin-quality-gates-and-shared-contracts (Requirements 6.10, 6.14)
 *
 * These tests exercise the doubles themselves — the later mutation and
 * authorization tests rely on them behaving like the modules they replace, so a
 * regression here would silently weaken every assertion built on top. Nothing
 * in this file reaches a credential, an emulator, or a deployed service: each
 * test ends by asserting the network guard recorded no attempt.
 */
import { describe, expect, it, vi } from "vitest";
import {
  auditDouble,
  blockedNetworkAttempts,
  createAuditDouble,
  createFirebaseAuthDouble,
  createFirestoreDouble,
  createGoAgentDouble,
  createRemoteConfigDouble,
  firestoreDouble,
  type AdminUser,
} from "./setup";

const ADMIN: AdminUser = {
  uid: "admin-1",
  email: "ops@example.com",
  name: "Ops Operator",
  isClaimAdmin: true,
};

// The documented `vi.mock` pattern: the hoisted factory reaches the same
// per-test-file singleton the test body inspects.
vi.mock("@/lib/firebase/firestore.server", async () => {
  const { firestoreDouble: double } = await import("./setup");
  return double().module;
});

describe("Firestore double", () => {
  it("round-trips create → get and records the write", async () => {
    const firestore = createFirestoreDouble();

    const created = await firestore.module.createDoc("fact_bank", "abc123", {
      subject: "Giraffe",
      true_number: 7,
      source_urls: ["https://example.com"],
      derivation: null,
      dropped: undefined,
    });

    expect(created.id).toBe("abc123");
    expect(created.path).toBe("fact_bank/abc123");
    expect(created.data).toEqual({
      subject: "Giraffe",
      true_number: 7,
      source_urls: ["https://example.com"],
      derivation: null,
      dropped: null,
    });

    const fetched = await firestore.module.getDoc("fact_bank/abc123");
    expect(fetched?.data).toEqual(created.data);
    expect(await firestore.module.getDoc("fact_bank/missing")).toBeNull();

    expect(firestore.writeCount()).toBe(1);
    expect(firestore.writes()[0]).toMatchObject({
      kind: "create",
      path: "fact_bank/abc123",
      collection: "fact_bank",
      documentId: "abc123",
    });
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("rejects a duplicate create and records no second write", async () => {
    const firestore = createFirestoreDouble();
    await firestore.module.createDoc("fact_bank", "dup", { status: "active" });

    await expect(
      firestore.module.createDoc("fact_bank", "dup", { status: "active" }),
    ).rejects.toThrow(/409/);

    expect(firestore.writeCount()).toBe(1);
  });

  it("patches only the supplied fields and deletes the listed paths", async () => {
    const firestore = createFirestoreDouble();
    firestore.seed("fact_bank/abc", {
      status: "active",
      retired_reason: "stale",
      subject: "Giraffe",
    });
    expect(firestore.writeCount()).toBe(0); // seeding is not a write

    const patched = await firestore.module.patchDoc(
      "fact_bank/abc",
      { status: "retired", updated_at: "2024-05-01T00:00:00.000Z" },
      ["retired_reason"],
    );

    expect(patched.data).toEqual({
      status: "retired",
      updated_at: "2024-05-01T00:00:00.000Z",
      subject: "Giraffe",
    });
    expect(firestore.writes()).toEqual([
      {
        kind: "patch",
        path: "fact_bank/abc",
        data: { status: "retired", updated_at: "2024-05-01T00:00:00.000Z" },
        deletePaths: ["retired_reason"],
      },
    ]);
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("queries with filters, ordering, and a limit", async () => {
    const firestore = createFirestoreDouble();
    firestore.seedMany({
      "fact_bank/a": { status: "active", served_count: 3, quality_flags: ["year_mismatch"] },
      "fact_bank/b": { status: "active", served_count: 1, quality_flags: [] },
      "fact_bank/c": { status: "retired", served_count: 9, quality_flags: [] },
      "other/d": { status: "active", served_count: 0, quality_flags: [] },
    });

    const active = await firestore.module.runQuery({
      collection: "fact_bank",
      filters: [{ field: "status", op: "EQUAL", value: "active" }],
      orderBy: { field: "served_count", direction: "DESCENDING" },
    });
    expect(active.map((doc) => doc.id)).toEqual(["a", "b"]);

    const flagged = await firestore.module.runQuery({
      collection: "fact_bank",
      filters: [{ field: "quality_flags", op: "ARRAY_CONTAINS", value: "year_mismatch" }],
    });
    expect(flagged.map((doc) => doc.id)).toEqual(["a"]);

    const limited = await firestore.module.runQuery({ collection: "fact_bank", limit: 1 });
    expect(limited).toHaveLength(1);

    expect(await firestore.module.countCollection("fact_bank")).toBe(3);
    expect(firestore.writeCount()).toBe(0);
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("fails an injected write and leaves the document untouched", async () => {
    const firestore = createFirestoreDouble();
    firestore.seed("fact_bank/abc", { status: "active" });
    firestore.failNextWrite();

    await expect(
      firestore.module.patchDoc("fact_bank/abc", { status: "retired" }),
    ).rejects.toThrow(/injected test failure/);

    expect(firestore.document("fact_bank/abc")?.data).toEqual({ status: "active" });
    expect(firestore.writeCount()).toBe(0);
  });

  it("reuses the real pure helpers for factId and normalizeKey", async () => {
    const firestore = createFirestoreDouble();

    const id = await firestore.module.factId("giraffe", "neck_vertebrae_count");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(await firestore.module.factId("giraffe", "neck_vertebrae_count")).toBe(id);
    expect(await firestore.module.factId("giraffe", "other_angle")).not.toBe(id);

    expect(firestore.module.normalizeKey("  Neck Vertebrae -- Count! ")).toBe(
      "neck_vertebrae_count",
    );
    expect(firestore.module.isFirestoreIndexError(new Error("requires an index"))).toBe(true);
  });

  it("serves the singleton through a vi.mock factory and resets between tests", async () => {
    const { createDoc, getDoc } = await import("@/lib/firebase/firestore.server");

    // Nothing seeded this instance in this test, proving the per-test reset.
    expect(firestoreDouble().documents()).toEqual([]);

    await createDoc("crawl_queue", "job-1", { subject: "Giraffe", status: "queued" });
    const doc = await getDoc("crawl_queue/job-1");

    expect(doc?.data).toEqual({ subject: "Giraffe", status: "queued" });
    expect(firestoreDouble().writeCount()).toBe(1);
    expect(blockedNetworkAttempts()).toEqual([]);
  });
});

describe("audit log double", () => {
  it("records exactly one well-formed entry per logged action", async () => {
    const audit = createAuditDouble();

    await audit.module.logAdminAction(ADMIN, {
      action: "fact.status_change",
      targetType: "fact",
      targetId: "abc123",
      details: "active → retired",
      before: { status: "active" },
      after: { status: "retired" },
    });

    expect(audit.entryCount()).toBe(1);
    const [entry] = audit.entries();
    expect(entry.adminUid).toBe(ADMIN.uid);
    expect(entry.adminEmail).toBe(ADMIN.email);
    expect(entry.action).toBe("fact.status_change");
    expect(entry.targetType).toBe("fact");
    expect(entry.targetId).toBe("abc123");
    expect(entry.before).toEqual({ status: "active" });
    expect(entry.after).toEqual({ status: "retired" });
    expect(entry.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("lists entries newest first and honours the limit", async () => {
    const audit = createAuditDouble();
    for (const targetId of ["one", "two", "three"]) {
      await audit.module.logAdminAction(ADMIN, {
        action: "fact.update",
        targetType: "fact",
        targetId,
      });
    }

    const listed = await audit.module.listAuditLogs(2);
    expect(listed.map((entry) => entry.targetId)).toEqual(["three", "two"]);
  });

  it("starts empty in every test", () => {
    expect(auditDouble().entries()).toEqual([]);
  });
});

describe("Firebase Auth double", () => {
  it("deduplicates listed users by email, preferring the admin record", async () => {
    const auth = createFirebaseAuthDouble();
    auth.seedUser({
      uid: "u1",
      email: "ops@example.com",
      isAdmin: false,
      createdAt: "2024-01-01T00:00:00.000Z",
      lastSignInAt: "2024-02-01T00:00:00.000Z",
    });
    auth.seedUser({
      uid: "u2",
      email: "OPS@example.com",
      isAdmin: true,
      createdAt: "2024-01-02T00:00:00.000Z",
    });
    auth.seedUser({ uid: "anon", email: null, createdAt: "2023-01-01T00:00:00.000Z" });

    const users = await auth.module.listAuthUsers();
    expect(users.map((user) => user.uid)).toEqual(["u2", "anon"]);
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("grants the admin claim, mirrors it, and records the change", async () => {
    const auth = createFirebaseAuthDouble();
    auth.seedUser({ uid: "u1", email: "Ops@Example.com" });
    const mirrored: { email: string; isAdmin: boolean }[] = [];

    const updated = await auth.module.setAdminClaim("u1", true, async (email, isAdmin) => {
      mirrored.push({ email, isAdmin });
    });

    expect(updated.isAdmin).toBe(true);
    expect(mirrored).toEqual([{ email: "ops@example.com", isAdmin: true }]);
    expect(auth.claimChanges()).toEqual([{ uid: "u1", admin: true }]);
    expect(auth.users()[0].isAdmin).toBe(true);
  });

  it("rejects a claim change for an unknown uid without recording it", async () => {
    const auth = createFirebaseAuthDouble();

    await expect(auth.module.setAdminClaim("nobody", true)).rejects.toThrow("User not found");
    expect(auth.claimChanges()).toEqual([]);
  });
});

describe("Remote Config double", () => {
  it("reads back seeded topic suggestions", async () => {
    const remoteConfig = createRemoteConfigDouble();
    remoteConfig.seedTopicSuggestions({
      defaultTopics: ["Space", "Sports"],
      variants: [
        {
          conditionName: "after_dark",
          expression: "app.userProperty['mode'] == 'after_dark'",
          tagColor: "PURPLE",
          topics: ["Late Night"],
        },
      ],
    });

    const config = await remoteConfig.module.getTopicSuggestionsConfig();
    expect(config.defaultTopics).toEqual(["Space", "Sports"]);
    expect(config.variants).toEqual([
      {
        conditionName: "after_dark",
        expression: "app.userProperty['mode'] == 'after_dark'",
        tagColor: "PURPLE",
        topics: ["Late Night"],
      },
    ]);
    expect(config.etag).toBe(remoteConfig.etag());
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("publishes with a matching ETag and records the publish", async () => {
    const remoteConfig = createRemoteConfigDouble();
    const etag = remoteConfig.etag();

    const published = await remoteConfig.module.publishTopicSuggestionsConfig(
      { defaultTopics: ["Space"], variants: [] },
      etag,
      "ops@example.com",
    );

    expect(published.defaultTopics).toEqual(["Space"]);
    expect(published.updatedBy).toBe("ops@example.com");
    expect(remoteConfig.publishes()).toHaveLength(1);
    expect(remoteConfig.etag()).not.toBe(etag);

    const reread = await remoteConfig.module.getTopicSuggestionsConfig();
    expect(reread.defaultTopics).toEqual(["Space"]);
  });

  it("rejects a publish that presents a stale ETag", async () => {
    const remoteConfig = createRemoteConfigDouble();

    await expect(
      remoteConfig.module.publishTopicSuggestionsConfig(
        { defaultTopics: ["Space"], variants: [] },
        "etag-stale",
      ),
    ).rejects.toThrow(/409/);

    expect(remoteConfig.publishes()).toEqual([]);
  });

  it("hands out an independent template copy on every read", async () => {
    const remoteConfig = createRemoteConfigDouble();
    remoteConfig.seedConditions([{ name: "after_dark", expression: "true", tagColor: "PURPLE" }]);

    const first = await remoteConfig.module.getRemoteConfigTemplate();
    first.conditions?.push({ name: "mutated", expression: "false" });

    const second = await remoteConfig.module.getRemoteConfigTemplate();
    expect(second.conditions?.map((condition) => condition.name)).toEqual(["after_dark"]);
  });
});

describe("Go agent double", () => {
  it("returns a deterministic stub pack and records the request", async () => {
    const goAgent = createGoAgentDouble();
    expect(goAgent.module.goAgentConfigured()).toBe(true);

    const pack = await goAgent.module.generatePackViaGoAgent({
      topic: "Deep Sea",
      numRounds: 3,
      difficulty: "medium",
    });

    expect(pack.is_valid).toBe(true);
    expect(pack.category).toBe("Deep Sea");
    expect(pack.rounds).toHaveLength(3);
    expect(pack.rounds[0]).toMatchObject({ round_number: 1, topic: "Deep Sea" });
    expect(goAgent.requests()).toEqual([
      { topic: "Deep Sea", numRounds: 3, difficulty: "medium" },
    ]);
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("honours an overridden pack, an unconfigured agent, and an injected failure", async () => {
    const goAgent = createGoAgentDouble();

    goAgent.setConfigured(false);
    expect(goAgent.module.goAgentConfigured()).toBe(false);

    goAgent.setPackResult({ category: "Override", status_message: "stubbed" });
    const overridden = await goAgent.module.generatePackViaGoAgent({ topic: "Space" });
    expect(overridden.category).toBe("Override");
    expect(overridden.status_message).toBe("stubbed");

    goAgent.failNextPack();
    await expect(goAgent.module.generatePackViaGoAgent({ topic: "Space" })).rejects.toThrow(
      /injected test failure/,
    );
    expect(goAgent.requests()).toHaveLength(2);
  });

  it("rejects an empty topic the way the real client does", async () => {
    const goAgent = createGoAgentDouble();

    await expect(goAgent.module.generatePackViaGoAgent({ topic: "   " })).rejects.toThrow(
      "Topic is required for a Go agent draft.",
    );
    expect(goAgent.requests()).toEqual([]);
  });
});
