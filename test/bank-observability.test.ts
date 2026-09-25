import { beforeEach, describe, expect, it, vi } from "vitest";
import { blockedNetworkAttempts, firestoreDouble } from "./setup";

vi.mock("@/lib/firebase/firestore.server", async () => {
  const { firestoreDouble } = await import("./setup");
  return firestoreDouble().module;
});

import { fetchDeployedBank, getBankObservability } from "@/lib/admin/content.server";

const ENV = { GAME_WORKER_URL: "https://game.example.test" };

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe("deployed bank observability", () => {
  beforeEach(() => {
    firestoreDouble().seedMany({
      "fact_bank/active-1": { status: "active" },
      "fact_bank/active-2": { status: "active" },
      "fact_bank/active-3": { status: "active" },
      "fact_bank/pending-1": { status: "pending" },
      "fact_bank/disputed-1": { status: "disputed" },
      "fact_bank/retired-1": { status: "retired" },
    });
  });

  it("fetches the exact Worker endpoint and reports lifecycle plus a defined delta", async () => {
    const fetchMock = vi.fn(async () =>
      response({ bank_version: "bank-2026-09-24", fact_count: 5, ddm_version: "ddm-4" }),
    );

    const result = await getBankObservability({
      env: ENV,
      fetch: fetchMock as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://game.example.test/api/bank/version");
    expect(init.method).toBe("GET");
    expect(result.deployed).toEqual({
      state: "known",
      stale: false,
      bankVersion: "bank-2026-09-24",
      factCount: 5,
      ddmVersion: "ddm-4",
    });
    expect(result.firestore).toEqual({
      lifecycle: { active: 3, pending: 1, disputed: 1, retired: 1 },
      total: 6,
      active: 3,
    });
    expect(result.exportedDelta).toBe(-2);
    expect(result.exportedDeltaDefinition).toContain("active lifecycle count minus deployed fact_count");
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("marks an unavailable endpoint unknown/stale without fabricating a deployment", async () => {
    const fetchMock = vi.fn(async () => response({ error: "unavailable" }, 503));

    const result = await getBankObservability({
      env: ENV,
      fetch: fetchMock as typeof fetch,
    });

    expect(result.deployed).toEqual({
      state: "unknown",
      stale: true,
      reason: "The Game Worker bank-version endpoint returned HTTP 503.",
    });
    expect(result.deployed).not.toHaveProperty("bankVersion");
    expect(result.deployed).not.toHaveProperty("factCount");
    expect(result.exportedDelta).toBeNull();
  });

  it("rejects malformed deployment payloads as unknown/stale", async () => {
    const fetchMock = vi.fn(async () => response({ bank_version: "bank-1", fact_count: -1 }));

    const result = await fetchDeployedBank({ env: ENV, fetch: fetchMock as typeof fetch });

    expect(result.state).toBe("unknown");
    if (result.state !== "unknown") throw new Error("expected unknown deployment");
    expect(result.stale).toBe(true);
    expect(result.reason).toContain("invalid response");
  });

  it("fails closed without making a request when GAME_WORKER_URL is absent", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("must not be called");
    });

    const result = await fetchDeployedBank({ env: {}, fetch: fetchMock as typeof fetch });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.state).toBe("unknown");
    if (result.state !== "unknown") throw new Error("expected unknown deployment");
    expect(result.stale).toBe(true);
    expect(result.reason).toContain("GAME_WORKER_URL");
  });
});
