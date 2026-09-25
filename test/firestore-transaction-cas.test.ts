/**
 * REST-level contract tests for Firestore transaction masks and CAS writes.
 *
 * These tests deliberately use a recording fetch double rather than the
 * in-memory Firestore service double. That lets them assert the exact v1 REST
 * request bodies while keeping credentials, network, and production Firestore
 * out of the test process.
 */
import { describe, expect, it, vi } from "vitest";
import { blockedNetworkAttempts } from "./setup";

vi.mock("@/lib/firebase/credentials.server", () => ({
  getAccessToken: async () => "test-access-token",
  getServiceAccount: () => ({ project_id: "test-project" }),
}));

import { runTransaction } from "@/lib/firebase/firestore.server";

const DATABASE = "projects/test-project/databases/(default)";
const DOCUMENT = `${DATABASE}/documents/fact_bank/abc`;
const UPDATE_TIME = "2026-09-23T12:34:56.123456Z";
const UPDATED_AT = "2026-09-23T12:35:00.000000Z";

type JsonObject = Record<string, unknown>;

interface RestCall {
  url: string;
  method: string;
  body: unknown;
}

interface CommitFailure {
  status: number;
  statusName?: string;
  message: string;
}

interface TransactionRestDouble {
  fetch: (input: unknown, init?: RequestInit) => Promise<Response>;
  calls: RestCall[];
  beginCount(): number;
  commitCount(): number;
  rollbackCount(): number;
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

function transactionToken(attempt: number): string {
  return btoa(`transaction-${attempt}`);
}

function createTransactionRestDouble(
  commitFailures: CommitFailure[] = [],
): TransactionRestDouble {
  const calls: RestCall[] = [];
  const failures = commitFailures.slice();
  let transactionCount = 0;
  let begins = 0;
  let commits = 0;
  let rollbacks = 0;

  const fetch = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ url, method: init.method ?? "GET", body });

    if (url.endsWith(":beginTransaction")) {
      begins += 1;
      transactionCount += 1;
      return response({ transaction: transactionToken(transactionCount) });
    }
    if (url.endsWith(":batchGet")) {
      return response([
        {
          found: {
            name: DOCUMENT,
            fields: { status: { stringValue: "active" } },
            createTime: "2026-09-23T12:00:00.000000Z",
            updateTime: UPDATE_TIME,
          },
        },
      ]);
    }
    if (url.endsWith(":commit")) {
      commits += 1;
      const failure = failures.shift();
      if (failure) {
        return response(
          {
            error: {
              code: failure.status,
              ...(failure.statusName ? { status: failure.statusName } : {}),
              message: failure.message,
            },
          },
          failure.status,
        );
      }
      return response({ writeResults: [] });
    }
    if (url.endsWith(":rollback")) {
      rollbacks += 1;
      return response({});
    }
    throw new Error(`Unexpected REST request: ${url}`);
  };

  return {
    fetch,
    calls,
    beginCount: () => begins,
    commitCount: () => commits,
    rollbackCount: () => rollbacks,
  };
}

function callBody(call: RestCall | undefined): JsonObject {
  expect(call).toBeDefined();
  if (!call || typeof call.body !== "object" || call.body === null || Array.isArray(call.body)) {
    throw new Error("Expected a JSON object REST body");
  }
  return call.body as JsonObject;
}

function commitCall(double: TransactionRestDouble): RestCall {
  const call = double.calls.find((entry) => entry.url.endsWith(":commit"));
  expect(call).toBeDefined();
  if (!call) throw new Error("Expected a commit request");
  return call;
}

function installFetch(double: TransactionRestDouble): void {
  vi.stubGlobal("fetch", double.fetch);
}

describe("FirestoreTransaction REST contract", () => {
  it("reads before queued writes and emits an exact masked CAS update", async () => {
    const double = createTransactionRestDouble();
    installFetch(double);

    const result = await runTransaction(async (tx) => {
      const current = await tx.get("fact_bank/abc");
      expect(current?.updateTime).toBe(UPDATE_TIME);
      tx.update(
        "fact_bank/abc",
        { status: "retired", updated_at: UPDATED_AT },
        { updateTime: UPDATE_TIME },
      );
      // set is intentionally a full-document replace: it has no update mask.
      tx.set("admin_audit_logs/audit-1", { action: "fact.status_change" });
      return current?.data.status;
    });

    expect(result).toBe("active");
    expect(double.calls.map((call) => call.url.split("/documents").at(-1))).toEqual([
      ":beginTransaction",
      ":batchGet",
      ":commit",
    ]);
    expect(double.calls[0]?.method).toBe("POST");
    expect(callBody(double.calls[0])).toEqual({ options: { readWrite: {} } });
    expect(callBody(double.calls[1])).toEqual({
      documents: [DOCUMENT],
      transaction: transactionToken(1),
    });
    expect(callBody(commitCall(double))).toEqual({
      database: DATABASE,
      transaction: transactionToken(1),
      writes: [
        {
          update: {
            name: DOCUMENT,
            fields: {
              status: { stringValue: "retired" },
              updated_at: { timestampValue: UPDATED_AT },
            },
          },
          updateMask: { fieldPaths: ["status", "updated_at"] },
          currentDocument: { updateTime: UPDATE_TIME },
        },
        {
          update: {
            name: `${DATABASE}/documents/admin_audit_logs/audit-1`,
            fields: { action: { stringValue: "fact.status_change" } },
          },
        },
      ],
    });
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("rejects a read queued after a write instead of sending an invalid transaction", async () => {
    const double = createTransactionRestDouble();
    installFetch(double);

    await expect(
      runTransaction(async (tx) => {
        tx.set("fact_bank/abc", { status: "active" });
        await tx.get("fact_bank/abc");
      }),
    ).rejects.toThrow(/reads must occur before queued writes/);

    expect(double.calls.map((call) => call.url.split("/documents").at(-1))).toEqual([
      ":beginTransaction",
      ":rollback",
    ]);
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it.each([
    {
      label: "ABORTED",
      failure: { status: 409, statusName: "ABORTED", message: "transaction was aborted" },
    },
    {
      label: "contention",
      failure: {
        status: 409,
        statusName: "ABORTED",
        message: "Too much contention on these documents",
      },
    },
  ])("retries the whole transaction for $label", async ({ failure }) => {
    const double = createTransactionRestDouble([failure]);
    installFetch(double);
    let workCalls = 0;

    await runTransaction(async (tx) => {
      workCalls += 1;
      const current = await tx.get("fact_bank/abc");
      tx.update("fact_bank/abc", { status: "retired" }, { updateTime: current?.updateTime });
    });

    expect(workCalls).toBe(2);
    expect(double.beginCount()).toBe(2);
    expect(double.commitCount()).toBe(2);
    expect(double.rollbackCount()).toBe(1);
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it.each([
    {
      label: "precondition",
      failure: {
        status: 400,
        statusName: "FAILED_PRECONDITION",
        message: "the transaction currentDocument precondition failed after it was aborted",
      },
    },
    {
      label: "authorization",
      failure: { status: 403, statusName: "PERMISSION_DENIED", message: "access denied" },
    },
    {
      label: "validation",
      failure: {
        status: 400,
        statusName: "INVALID_ARGUMENT",
        message: "invalid write",
      },
    },
  ])("does not retry an unrelated $label failure", async ({ failure }) => {
    const double = createTransactionRestDouble([failure]);
    installFetch(double);
    let workCalls = 0;

    await expect(
      runTransaction(async (tx) => {
        workCalls += 1;
        const current = await tx.get("fact_bank/abc");
        tx.update("fact_bank/abc", { status: "retired" }, { updateTime: current?.updateTime });
      }),
    ).rejects.toThrow(failure.message);

    expect(workCalls).toBe(1);
    expect(double.beginCount()).toBe(1);
    expect(double.commitCount()).toBe(1);
    expect(double.rollbackCount()).toBe(1);
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("does not retry a validation error raised by the transaction work", async () => {
    const double = createTransactionRestDouble();
    installFetch(double);
    let workCalls = 0;

    await expect(
      runTransaction(async () => {
        workCalls += 1;
        throw new Error("INVALID_ARGUMENT: work rejected the mutation");
      }),
    ).rejects.toThrow("INVALID_ARGUMENT: work rejected the mutation");

    expect(workCalls).toBe(1);
    expect(double.beginCount()).toBe(1);
    expect(double.commitCount()).toBe(0);
    expect(double.rollbackCount()).toBe(1);
    expect(blockedNetworkAttempts()).toEqual([]);
  });
});
