import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "@/lib/firebase/verify.server";

export const fetchSubjects = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z.object({ search: z.string().optional(), category: z.string().optional() }).parse(data),
  )
  .handler(async ({ data }) => {
    await requireAdmin();
    const { listSubjects } = await import("./ops.server");
    return listSubjects(data);
  });

export const saveSubject = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        id: z.string().min(1),
        category: z.string().optional(),
        sub_category: z.string().optional(),
        aliases: z.array(z.string()).optional(),
        crawl_notes: z.string().optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const caller = await requireAdmin();
    const { updateSubject } = await import("./ops.server");
    return updateSubject(caller, data);
  });

export const fetchCrawlQueue = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => z.object({ status: z.string().optional() }).parse(data))
  .handler(async ({ data }) => {
    await requireAdmin();
    const { listCrawlQueue } = await import("./ops.server");
    return listCrawlQueue(data);
  });

export const queueCrawl = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        subject: z.string().min(1),
        priority: z.number().int().min(0).max(100),
        refresh: z.boolean(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const caller = await requireAdmin();
    const { enqueueCrawl } = await import("./ops.server");
    return enqueueCrawl(caller, data);
  });

export const updateCrawlPriority = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z.object({ id: z.string().min(1), priority: z.number().int().min(0).max(100) }).parse(data),
  )
  .handler(async ({ data }) => {
    const caller = await requireAdmin();
    const { setCrawlPriority } = await import("./ops.server");
    return setCrawlPriority(caller, data);
  });

export const triggerCrawlAction = createServerFn({ method: "POST" }).handler(async () => {
  const caller = await requireAdmin();
  const { triggerFoundryWorkflow } = await import("./ops.server");
  return triggerFoundryWorkflow(caller);
});

export const fetchPlayers = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => z.object({ search: z.string().optional() }).parse(data))
  .handler(async ({ data }) => {
    await requireAdmin();
    const { findPlayers } = await import("./ops.server");
    return findPlayers(data);
  });

export const fetchPlayer = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => z.object({ id: z.string().min(1) }).parse(data))
  .handler(async ({ data }) => {
    await requireAdmin();
    const { getPlayer } = await import("./ops.server");
    return getPlayer(data.id);
  });

export const togglePremium = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z.object({ id: z.string().min(1), isPremium: z.boolean() }).parse(data),
  )
  .handler(async ({ data }) => {
    const caller = await requireAdmin();
    const { setPremium } = await import("./ops.server");
    return setPremium(caller, data);
  });

export const fetchDaily = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(data),
  )
  .handler(async ({ data }) => {
    await requireAdmin();
    const { getDailyPack, getDailyLeaderboard } = await import("./ops.server");
    const [pack, leaderboard] = await Promise.all([
      getDailyPack(data.date),
      getDailyLeaderboard(data.date),
    ]);
    return { pack, leaderboard };
  });

export const preScheduleDailyPack = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        category: z.string().min(1),
        rounds: z.array(z.record(z.any())),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const caller = await requireAdmin();
    const { scheduleDailyPack } = await import("./ops.server");
    return scheduleDailyPack(caller, data);
  });

export const moderateLeaderboardEntry = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        uid: z.string().min(1),
        reason: z.string().optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const caller = await requireAdmin();
    const { removeDailyLeaderboardEntry } = await import("./ops.server");
    return removeDailyLeaderboardEntry(caller, data);
  });

export const fetchGameAnalytics = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => z.object({ since: z.string().optional() }).parse(data))
  .handler(async ({ data }) => {
    await requireAdmin();
    const { getGameAnalytics } = await import("./ops.server");
    return getGameAnalytics(data);
  });
