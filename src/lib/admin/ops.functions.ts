import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "./middleware";

export const fetchSubjects = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) =>
    z
      .object({
        search: z.string().optional(),
        category: z.string().optional(),
        family: z.string().optional(),
        playlistId: z.string().optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const { listSubjects } = await import("./ops.server");
    return listSubjects(data);
  });

export const createTopic = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) =>
    z
      .object({
        subject: z.string().min(1),
        category: z.string().min(1),
        sub_category: z.string().optional(),
        aliases: z.array(z.string()).optional(),
        playlist_ids: z.array(z.string()).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const caller = context.user;
    const { createSubject } = await import("./ops.server");
    const created = await createSubject(data);
    const { logAdminAction } = await import("@/lib/firebase/audit.server");
    await logAdminAction(caller, {
      action: "subject.create",
      targetType: "subject",
      targetId: created.id,
      details: `Created topic ${data.subject}`,
      after: data as Record<string, unknown>,
    });
    return created;
  });

export const saveSubject = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) =>
    z
      .object({
        id: z.string().min(1),
        category: z.string().optional(),
        sub_category: z.string().optional(),
        aliases: z.array(z.string()).optional(),
        crawl_notes: z.string().optional(),
        playlist_ids: z.array(z.string()).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const caller = context.user;
    const { updateSubject } = await import("./ops.server");
    const updated = await updateSubject(data);
    const { logAdminAction } = await import("@/lib/firebase/audit.server");
    await logAdminAction(caller, {
      action: "subject.update",
      targetType: "subject",
      targetId: data.id,
      details: `Updated subject ${data.id}`,
      after: data as Record<string, unknown>,
    });
    return updated;
  });

export const fetchPlaylists = createServerFn({ method: "POST" }).middleware([authMiddleware]).handler(async () => {
  const { listPlaylists } = await import("./ops.server");
  return listPlaylists();
});

export const createPlaylistAction = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) =>
    z
      .object({
        name: z.string().min(1),
        aliases: z.array(z.string()).optional(),
        topic_keys: z.array(z.string()).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const caller = context.user;
    const { createPlaylist } = await import("./ops.server");
    const created = await createPlaylist(data);
    const { logAdminAction } = await import("@/lib/firebase/audit.server");
    await logAdminAction(caller, {
      action: "playlist.create",
      targetType: "playlist",
      targetId: created.id,
      details: `Created playlist ${data.name}`,
      after: data as Record<string, unknown>,
    });
    return created;
  });

export const savePlaylist = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) =>
    z
      .object({
        id: z.string().min(1),
        name: z.string().optional(),
        aliases: z.array(z.string()).optional(),
        topic_keys: z.array(z.string()).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const caller = context.user;
    const { updatePlaylist } = await import("./ops.server");
    const updated = await updatePlaylist(data);
    const { logAdminAction } = await import("@/lib/firebase/audit.server");
    await logAdminAction(caller, {
      action: "playlist.update",
      targetType: "playlist",
      targetId: data.id,
      details: `Updated playlist ${data.id}`,
      after: data as Record<string, unknown>,
    });
    return updated;
  });

export const fetchCrawlQueue = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) => z.object({ status: z.string().optional() }).parse(data))
  .handler(async ({ data }) => {
    const { listCrawlQueue } = await import("./ops.server");
    return listCrawlQueue(data);
  });

export const queueCrawl = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) =>
    z
      .object({
        subject: z.string().min(1),
        priority: z.number().int().min(0).max(100),
        refresh: z.boolean(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const caller = context.user;
    const { enqueueCrawl } = await import("./ops.server");
    const enqueued = await enqueueCrawl(data);
    const { logAdminAction } = await import("@/lib/firebase/audit.server");
    await logAdminAction(caller, {
      action: "crawl.enqueue",
      targetType: "crawl_job",
      targetId: enqueued.expandedFrom ?? enqueued.items[0]?.id ?? data.subject,
      details: enqueued.expandedFrom
        ? `Enqueued ${enqueued.items.length} topics from playlist ${enqueued.expandedFrom}`
        : `Enqueued crawl for ${data.subject} with priority ${data.priority}`,
      after: data as Record<string, unknown>,
    });
    return enqueued;
  });

export const updateCrawlPriority = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) =>
    z.object({ id: z.string().min(1), priority: z.number().int().min(0).max(100) }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const caller = context.user;
    const { setCrawlPriority } = await import("./ops.server");
    const updated = await setCrawlPriority(data);
    const { logAdminAction } = await import("@/lib/firebase/audit.server");
    await logAdminAction(caller, {
      action: "crawl.priority",
      targetType: "crawl_job",
      targetId: data.id,
      details: `Set crawl priority for ${data.id} to ${data.priority}`,
      after: { priority: data.priority },
    });
    return updated;
  });

export const triggerCrawlAction = createServerFn({ method: "POST" }).middleware([authMiddleware]).handler(async ({ context }) => {
  const caller = context.user;
  const { triggerFoundryWorkflow } = await import("./ops.server");
  return triggerFoundryWorkflow(caller);
});

export const fetchPlayers = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) => z.object({ search: z.string().optional() }).parse(data))
  .handler(async ({ data }) => {
    const { findPlayers } = await import("./ops.server");
    return findPlayers(data);
  });

export const fetchPlayer = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) => z.object({ id: z.string().min(1) }).parse(data))
  .handler(async ({ data }) => {
    const { getPlayer } = await import("./ops.server");
    return getPlayer(data.id);
  });

export const togglePremium = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) =>
    z.object({ id: z.string().min(1), isPremium: z.boolean() }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const caller = context.user;
    const { setPremium } = await import("./ops.server");
    return setPremium(data, caller);
  });

export const fetchDailySchedule = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) =>
    z.object({ limit: z.number().optional() }).parse(data),
  )
  .handler(async ({ data }) => {
    const { listDailyPacks } = await import("./ops.server");
    const packs = await listDailyPacks(data?.limit ?? 100);
    return { packs };
  });

export const fetchDaily = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) =>
    z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(data),
  )
  .handler(async ({ data }) => {
    const { getDailyPack, getDailyLeaderboard } = await import("./ops.server");
    const [pack, leaderboard] = await Promise.all([
      getDailyPack(data.date),
      getDailyLeaderboard(data.date),
    ]);
    return { pack, leaderboard };
  });

export const generateDailyPack = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) =>
    z.object({
      category: z.string().optional(),
      subject: z.string().optional(),
    }).parse(data),
  )
  .handler(async ({ data }) => {
    const { generateDailyPackFromFactBank } = await import("./ops.server");
    return generateDailyPackFromFactBank(data);
  });

export const preScheduleDailyPack = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) =>
    z
      .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        category: z.string().min(1),
        rounds: z.array(z.record(z.any())),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const caller = context.user;
    const { scheduleDailyPack } = await import("./ops.server");
    return scheduleDailyPack(data, caller);
  });

export const deleteDailyPackAction = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) =>
    z
      .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const caller = context.user;
    const { deleteDailyPack } = await import("./ops.server");
    return deleteDailyPack(data.date, caller);
  });

export const moderateLeaderboardEntry = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) =>
    z
      .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        uid: z.string().min(1),
        reason: z.string().optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const caller = context.user;
    const { removeDailyLeaderboardEntry } = await import("./ops.server");
    return removeDailyLeaderboardEntry(data, caller);
  });

export const fetchGameAnalytics = createServerFn({ method: "POST" }).middleware([authMiddleware])
  .inputValidator((data: unknown) => z.object({ since: z.string().optional() }).parse(data))
  .handler(async ({ data }) => {
    const { getGameAnalytics } = await import("./ops.server");
    return getGameAnalytics(data);
  });
