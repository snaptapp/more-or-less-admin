/**
 * Dynamic prompt suggestions for the Content/Facts chat strategist.
 * Assembles high-value, actionable prompt bubbles based on live fact bank coverage,
 * crawl queue status, and real playlists. Strictly read-only.
 */
import { normalizeKey } from "@/lib/firebase/firestore.server";
import { coverageGaps } from "./chat-tools";
import { listCrawlQueue, listPlaylists } from "./ops.server";
import type { PromptSuggestion } from "./daily-blitz";

export async function getFactBankPromptSuggestions(): Promise<PromptSuggestion[]> {
  const [gaps, queue, playlists] = await Promise.all([
    coverageGaps(3, 12),
    listCrawlQueue({}),
    listPlaylists(),
  ]);

  const suggestions: PromptSuggestion[] = [];

  // 1. Top thin genre (least-covered category)
  if (gaps.thinGenres.length > 0) {
    const topGenre = gaps.thinGenres[0].category;
    suggestions.push({
      id: `gap-${normalizeKey(topGenre)}`,
      label: `📉 Gaps in ${topGenre}`,
      prompt: `Show coverage gaps for ${topGenre} with 3 or fewer facts and recommend subjects to enqueue.`,
    });
  }

  // 2. Top thin subject (<= 3 facts)
  if (gaps.thinSubjects.length > 0) {
    const topSubject = gaps.thinSubjects[0].subject;
    suggestions.push({
      id: `enqueue-${normalizeKey(topSubject)}`,
      label: `➕ Enqueue ${topSubject}`,
      prompt: `Enqueue "${topSubject}" into the crawl queue for Fact Foundry hydration.`,
    });
  }

  // 3. Second thin subject (distinct from first)
  if (gaps.thinSubjects.length > 1 && gaps.thinSubjects[1].subject !== gaps.thinSubjects[0]?.subject) {
    const secondSubject = gaps.thinSubjects[1].subject;
    suggestions.push({
      id: `enqueue-${normalizeKey(secondSubject)}`,
      label: `➕ Enqueue ${secondSubject}`,
      prompt: `Enqueue "${secondSubject}" into the crawl queue for Fact Foundry hydration.`,
    });
  }

  // 4. Crawl queue status (if >= 1 queued or processing)
  const queuedCount = queue.filter((j) => j.status === "queued").length;
  const processingCount = queue.filter((j) => j.status === "processing").length;
  const activeCount = queuedCount + processingCount;
  if (activeCount > 0) {
    const labelCount = queuedCount > 0 ? `${queuedCount} queued` : `${processingCount} processing`;
    suggestions.push({
      id: "queue-status",
      label: `📋 Inspect crawl queue (${labelCount})`,
      prompt: "List the crawl_queue jobs to check backlog and processing status.",
    });
  }

  // 5. Foundry dispatch (if >= 1 queued)
  if (queuedCount > 0) {
    suggestions.push({
      id: "foundry-dispatch",
      label: "🚀 Dispatch Fact Foundry",
      prompt: "Trigger the Fact Foundry workflow to crawl and verify queued subjects.",
    });
  }

  // 6. First playlist with non-empty topic_keys
  const firstPlaylist = playlists.find((p) => p.topic_keys.length > 0);
  if (firstPlaylist) {
    suggestions.push({
      id: `playlist-${firstPlaylist.id}`,
      label: `🎵 Enqueue ${firstPlaylist.name} playlist`,
      prompt: `Expand the "${firstPlaylist.name}" playlist and enqueue its topics to the crawl queue for Fact Foundry.`,
    });
  }

  // 7. Second thin genre (tie-breaker if slots remain < 6)
  if (suggestions.length < 6 && gaps.thinGenres.length > 1 && gaps.thinGenres[1].category !== gaps.thinGenres[0]?.category) {
    const secondGenre = gaps.thinGenres[1].category;
    suggestions.push({
      id: `gap-${normalizeKey(secondGenre)}`,
      label: `📉 Gaps in ${secondGenre}`,
      prompt: `Show coverage gaps for ${secondGenre} with 3 or fewer facts and recommend subjects to enqueue.`,
    });
  }

  return suggestions.slice(0, 6);
}
