import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export const fetchSubjects = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z.object({ search: z.string().optional(), category: z.string().optional() }).parse(data),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("../firebase/verify.server");
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
    const { requireAdmin } = await import("../firebase/verify.server");
    await requireAdmin();
    const { updateSubject } = await import("./ops.server");
    return updateSubject(data);
  });

export const fetchCrawlQueue = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => z.object({ status: z.string().optional() }).parse(data))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("../firebase/verify.server");
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
    const { requireAdmin } = await import("../firebase/verify.server");
    await requireAdmin();
    const { enqueueCrawl } = await import("./ops.server");
    return enqueueCrawl(data);
  });

export const updateCrawlPriority = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z.object({ id: z.string().min(1), priority: z.number().int().min(0).max(100) }).parse(data),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("../firebase/verify.server");
    await requireAdmin();
    const { setCrawlPriority } = await import("./ops.server");
    return setCrawlPriority(data);
  });

export const fetchPlayers = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => z.object({ search: z.string().optional() }).parse(data))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("../firebase/verify.server");
    await requireAdmin();
    const { findPlayers } = await import("./ops.server");
    return findPlayers(data);
  });

export const fetchPlayer = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => z.object({ id: z.string().min(1) }).parse(data))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("../firebase/verify.server");
    await requireAdmin();
    const { getPlayer } = await import("./ops.server");
    return getPlayer(data.id);
  });

export const togglePremium = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z.object({ id: z.string().min(1), isPremium: z.boolean() }).parse(data),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("../firebase/verify.server");
    await requireAdmin();
    const { setPremium } = await import("./ops.server");
    return setPremium(data);
  });

export const fetchDaily = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(data),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("../firebase/verify.server");
    await requireAdmin();
    const { getDailyPack, getDailyLeaderboard } = await import("./ops.server");
    const [pack, leaderboard] = await Promise.all([
      getDailyPack(data.date),
      getDailyLeaderboard(data.date),
    ]);
    return { pack, leaderboard };
  });

export const fetchGameAnalytics = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => z.object({ since: z.string().optional() }).parse(data))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("../firebase/verify.server");
    await requireAdmin();
    const { getGameAnalytics } = await import("./ops.server");
    return getGameAnalytics(data);
  });
