/**
 * Audit → Amplitude mirroring.
 *
 * Audit rows are forwarded only after Firestore accepts the write: once per
 * committed transaction (never per retry attempt, never for a failed commit)
 * and once per successful `createDoc`. The event carries identifiers only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/credentials.server", () => ({
  getAccessToken: async () => "test-access-token",
  getServiceAccount: () => ({ project_id: "test-project" }),
}));

const forwarded = vi.hoisted(() => [] as Array<Array<{ id: string; data: Record<string, unknown> }>>);

vi.mock("@/lib/analytics/audit-amplitude.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics/audit-amplitude.server")>();
  return {
    ...actual,
    forwardAuditEntries: async (entries: Array<{ id: string; data: Record<string, unknown> }>) => {
      if (entries.length > 0) forwarded.push([...entries]);
    },
  };
});

import { createDoc, runTransaction } from "@/lib/firebase/firestore.server";
import {
  AUDIT_EVENT_TYPE,
  forwardAuditEntries as realForward,
  isAuditPath,
  toAmplitudeEvent,
} from "@/lib/analytics/audit-amplitude.server";

const AUDIT = {
  adminUid: "uid-12345",
  adminEmail: "ops@snaptapp.us",
  action: "fact.update",
  targetType: "fact",
  targetId: "fact-1",
  details: "Updated fact fact-1",
  before: null,
  after: { status: "active" },
  createdAt: "2026-10-13T08:00:00.000Z",
};

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response;
}

function stubFirestore(commitStatuses: number[] = [200]): void {
  const statuses = commitStatuses.slice();
  vi.stubGlobal("fetch", async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith(":beginTransaction")) return response({ transaction: "dHg=" });
    if (url.endsWith(":rollback")) return response({});
    if (url.endsWith(":commit")) {
      const status = statuses.shift() ?? 200;
      return status === 200
        ? response({ writeResults: [] })
        : response({ error: { status: status === 409 ? "ABORTED" : "FAILED_PRECONDITION", message: "x" } }, status);
    }
    if (init.method === "POST") {
      return response({ name: "projects/test-project/databases/(default)/documents/x/y", fields: {} });
    }
    return response({});
  });
}

afterEach(() => {
  forwarded.length = 0;
  vi.unstubAllGlobals();
});

describe("audit forwarding from the Firestore layer", () => {
  it("forwards staged audit rows once, after the transaction commits", async () => {
    stubFirestore([200]);
    await runTransaction(async (tx) => {
      tx.set("fact_bank/fact-1", { status: "active" });
      tx.set("admin_audit_logs/audit-1", AUDIT);
    });
    expect(forwarded).toEqual([[{ id: "audit-1", data: AUDIT }]]);
  });

  it("forwards nothing when the commit fails", async () => {
    stubFirestore([400]);
    await expect(
      runTransaction(async (tx) => {
        tx.set("admin_audit_logs/audit-1", AUDIT);
      }),
    ).rejects.toThrow();
    expect(forwarded).toEqual([]);
  });

  it("forwards once across a contention retry", async () => {
    stubFirestore([409, 200]);
    await runTransaction(async (tx) => {
      tx.set("admin_audit_logs/audit-1", AUDIT);
    });
    expect(forwarded).toHaveLength(1);
  });

  it("forwards nothing for transactions without audit rows", async () => {
    stubFirestore([200]);
    await runTransaction(async (tx) => {
      tx.set("fact_bank/fact-1", { status: "active" });
    });
    expect(forwarded).toEqual([]);
  });

  it("forwards audit rows written with createDoc", async () => {
    stubFirestore();
    await createDoc("admin_audit_logs", "audit-2", AUDIT);
    await createDoc("fact_bank", "fact-2", { status: "pending" });
    expect(forwarded).toEqual([[{ id: "audit-2", data: AUDIT }]]);
  });
});

describe("toAmplitudeEvent", () => {
  it("sends identifiers only, deduped by audit id", () => {
    const event = toAmplitudeEvent("audit-1", AUDIT);
    expect(event).toEqual({
      event_type: AUDIT_EVENT_TYPE,
      user_id: "uid-12345",
      insert_id: "audit-1",
      time: Date.parse(AUDIT.createdAt),
      event_properties: {
        action: "fact.update",
        target_type: "fact",
        target_id: "fact-1",
        audit_id: "audit-1",
        admin_uid: "uid-12345",
      },
    });
    expect(JSON.stringify(event)).not.toContain("ops@snaptapp.us");
    expect(JSON.stringify(event)).not.toContain("Updated fact");
  });

  it("uses device_id for uids shorter than Amplitude's 5-char minimum", () => {
    const event = toAmplitudeEvent("audit-1", { ...AUDIT, adminUid: "ops" });
    expect(event?.user_id).toBeUndefined();
    expect(event?.device_id).toBe("admin:ops");
  });

  it("skips rows missing an action or admin uid", () => {
    expect(toAmplitudeEvent("audit-1", { ...AUDIT, action: "" })).toBeNull();
    expect(toAmplitudeEvent("audit-1", { ...AUDIT, adminUid: undefined })).toBeNull();
    expect(toAmplitudeEvent("", AUDIT)).toBeNull();
  });

  it("recognises audit paths with or without a leading slash", () => {
    expect(isAuditPath("admin_audit_logs/a")).toBe(true);
    expect(isAuditPath("/admin_audit_logs/a")).toBe(true);
    expect(isAuditPath("fact_bank/admin_audit_logs")).toBe(false);
  });
});

describe("forwardAuditEntries", () => {
  it("makes no network call under the test mode", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await realForward([{ id: "audit-1", data: AUDIT }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
