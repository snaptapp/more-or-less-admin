import { beforeEach, describe, expect, it, vi } from "vitest";
import { firestoreDouble } from "./setup";

vi.mock("@/lib/firebase/firestore.server", async () => {
  const { firestoreDouble } = await import("./setup");
  return firestoreDouble().module;
});

import { opsCrawlQueue } from "@/lib/admin/ops-crawl.server";

describe("ops crawl queue", () => {
  beforeEach(() => {
    firestoreDouble().seedMany({
      "crawl_queue/nba": {
        subject: "NBA scoring",
        priority: 5,
        status: "queued",
        requested_by: "manual",
        refresh: false,
        enqueued_at: "2026-10-01T00:00:00.000Z",
      },
      "crawl_queue/disco": {
        subject: "Disco",
        priority: 1,
        status: "processing",
        requested_by: "cron",
        refresh: false,
        enqueued_at: "2026-10-02T00:00:00.000Z",
      },
    });
  });

  it("returns the count and each crawl job", async () => {
    const queue = await opsCrawlQueue();
    expect(queue.count).toBe(2);
    expect(queue.by_status).toEqual({ queued: 1, processing: 1 });
    expect(queue.items.map((item) => item.subject)).toEqual(["NBA scoring", "Disco"]);
  });

  it("filters to queued jobs", async () => {
    const queue = await opsCrawlQueue("queued");
    expect(queue.count).toBe(1);
    expect(queue.items[0]?.subject).toBe("NBA scoring");
  });
});
