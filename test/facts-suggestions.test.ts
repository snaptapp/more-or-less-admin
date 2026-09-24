import { describe, expect, it, vi, beforeEach } from "vitest";
import { firestoreDouble } from "./setup";

vi.mock("@/lib/firebase/firestore.server", async () => {
  const { firestoreDouble: double } = await import("./setup");
  return double().module;
});

describe("getFactBankPromptSuggestions", () => {
  beforeEach(() => {
    firestoreDouble().reset();
  });

  it("returns empty suggestions when no subjects, queue, or playlists exist", async () => {
    const { getFactBankPromptSuggestions } = await import("@/lib/admin/facts-suggestions.server");
    const suggestions = await getFactBankPromptSuggestions();
    expect(suggestions).toEqual([]);
    expect(firestoreDouble().writeCount()).toBe(0);
  });

  it("produces thin category and thin subject prompt suggestions based on fact_count <= 3", async () => {
    const { getFactBankPromptSuggestions } = await import("@/lib/admin/facts-suggestions.server");

    firestoreDouble().seed("fact_subjects/nba-scoring", {
      subject: "NBA scoring",
      category: "Sports",
      sub_category: "Basketball",
      fact_count: 1,
      aliases: [],
      playlist_ids: [],
    });
    firestoreDouble().seed("fact_subjects/formula-1", {
      subject: "Formula 1",
      category: "Sports",
      sub_category: "Racing",
      fact_count: 2,
      aliases: [],
      playlist_ids: [],
    });

    const suggestions = await getFactBankPromptSuggestions();

    expect(suggestions.length).toBeGreaterThanOrEqual(2);
    // Priority 1: Top thin genre
    expect(suggestions[0]).toEqual({
      id: "gap-sports",
      label: "📉 Gaps in Sports",
      prompt: "Show coverage gaps for Sports with 3 or fewer facts and recommend subjects to enqueue.",
    });

    // Priority 2 & 3: Thin subjects
    expect(suggestions[1]).toEqual({
      id: "enqueue-nba_scoring",
      label: "➕ Enqueue NBA scoring",
      prompt: 'Enqueue "NBA scoring" into the crawl queue for Fact Foundry hydration.',
    });
    expect(suggestions[2]).toEqual({
      id: "enqueue-formula_1",
      label: "➕ Enqueue Formula 1",
      prompt: 'Enqueue "Formula 1" into the crawl queue for Fact Foundry hydration.',
    });

    expect(firestoreDouble().writeCount()).toBe(0);
  });

  it("includes crawl queue inspection and foundry dispatch when queue items are present", async () => {
    const { getFactBankPromptSuggestions } = await import("@/lib/admin/facts-suggestions.server");

    firestoreDouble().seed("crawl_queue/job-1", {
      subject: "Mars Rover",
      status: "queued",
      priority: 10,
      requested_by: "manual",
    });
    firestoreDouble().seed("crawl_queue/job-2", {
      subject: "Apollo 11",
      status: "processing",
      priority: 5,
      requested_by: "manual",
    });

    const suggestions = await getFactBankPromptSuggestions();

    const queueSuggestion = suggestions.find((s) => s.id === "queue-status");
    expect(queueSuggestion).toBeDefined();
    expect(queueSuggestion?.label).toBe("📋 Inspect crawl queue (1 queued)");
    expect(queueSuggestion?.prompt).toBe("List the crawl_queue jobs to check backlog and processing status.");

    const foundrySuggestion = suggestions.find((s) => s.id === "foundry-dispatch");
    expect(foundrySuggestion).toBeDefined();
    expect(foundrySuggestion?.label).toBe("🚀 Dispatch Fact Foundry");
    expect(foundrySuggestion?.prompt).toBe("Trigger the Fact Foundry workflow to crawl and verify queued subjects.");

    expect(firestoreDouble().writeCount()).toBe(0);
  });

  it("handles queue with only processing jobs correctly without claiming 0 queued", async () => {
    const { getFactBankPromptSuggestions } = await import("@/lib/admin/facts-suggestions.server");

    firestoreDouble().seed("crawl_queue/job-1", {
      subject: "Moon Landing",
      status: "processing",
      priority: 5,
      requested_by: "manual",
    });

    const suggestions = await getFactBankPromptSuggestions();

    const queueSuggestion = suggestions.find((s) => s.id === "queue-status");
    expect(queueSuggestion).toBeDefined();
    expect(queueSuggestion?.label).toBe("📋 Inspect crawl queue (1 processing)");

    // No queued jobs, so no dispatch suggestion
    const foundrySuggestion = suggestions.find((s) => s.id === "foundry-dispatch");
    expect(foundrySuggestion).toBeUndefined();
  });

  it("includes first playlist with non-empty topic_keys using stable id", async () => {
    const { getFactBankPromptSuggestions } = await import("@/lib/admin/facts-suggestions.server");

    firestoreDouble().seed("fact_playlists/pl-empty", {
      name: "Empty Playlist",
      aliases: [],
      topic_keys: [],
    });
    firestoreDouble().seed("fact_playlists/pl-space", {
      name: "Space Exploration",
      aliases: ["Space"],
      topic_keys: ["mars-rover", "apollo-11"],
    });

    const suggestions = await getFactBankPromptSuggestions();

    const playlistSuggestion = suggestions.find((s) => s.id.startsWith("playlist-"));
    expect(playlistSuggestion).toBeDefined();
    expect(playlistSuggestion?.id).toBe("playlist-pl-space");
    expect(playlistSuggestion?.label).toBe("🎵 Enqueue Space Exploration playlist");
    expect(playlistSuggestion?.prompt).toBe(
      'Expand the "Space Exploration" playlist and enqueue its topics to the crawl queue for Fact Foundry.',
    );
  });

  it("caps suggestions to a maximum of 6 items", async () => {
    const { getFactBankPromptSuggestions } = await import("@/lib/admin/facts-suggestions.server");

    firestoreDouble().seed("fact_subjects/s1", { subject: "S1", category: "Cat1", fact_count: 1, sub_category: "", aliases: [], playlist_ids: [] });
    firestoreDouble().seed("fact_subjects/s2", { subject: "S2", category: "Cat1", fact_count: 1, sub_category: "", aliases: [], playlist_ids: [] });
    firestoreDouble().seed("fact_subjects/s3", { subject: "S3", category: "Cat2", fact_count: 2, sub_category: "", aliases: [], playlist_ids: [] });
    firestoreDouble().seed("crawl_queue/q1", { subject: "Q1", status: "queued", priority: 1, requested_by: "user" });
    firestoreDouble().seed("fact_playlists/p1", { name: "P1", aliases: [], topic_keys: ["s1"] });

    const suggestions = await getFactBankPromptSuggestions();
    expect(suggestions.length).toBeLessThanOrEqual(6);
    expect(firestoreDouble().writeCount()).toBe(0);
  });
});
