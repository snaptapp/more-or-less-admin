/**
 * Read-only crawl queue for the Ops Assistant.
 * Uses the same `crawl_queue` listing as the admin Facts chat. Does not enqueue.
 */

import { listCrawlQueue, type CrawlRecord } from "./ops.server";

const STATUSES = ["queued", "processing", "done", "completed"] as const;
const DONE = new Set(["done", "completed"]);

export class CrawlRequestError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "CrawlRequestError";
  }
}

export async function opsCrawlQueue(status?: string): Promise<{
  count: number;
  by_status: Record<string, number>;
  status: string;
  limit: number;
  truncated: boolean;
  checked_at: string;
  items: CrawlRecord[];
}> {
  const filter = status?.trim() ?? "";
  if (filter && !STATUSES.includes(filter as (typeof STATUSES)[number])) {
    throw new CrawlRequestError(`status must be one of: ${STATUSES.join(", ")}.`);
  }
  const listed = filter && filter !== "done" ? await listCrawlQueue({ status: filter }) : await listCrawlQueue({});
  const items = filter === "done" ? listed.filter((item) => DONE.has(item.status)) : listed;
  const by_status: Record<string, number> = {};
  for (const item of items) {
    by_status[item.status] = (by_status[item.status] ?? 0) + 1;
  }
  return {
    count: items.length,
    by_status,
    status: filter || "all",
    limit: 200,
    truncated: listed.length >= 200,
    checked_at: new Date().toISOString(),
    items,
  };
}
