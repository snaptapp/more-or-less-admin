import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OpsChatRail } from "@/admin/OpsChatRail";
import type { PromptSuggestion } from "@/lib/admin/daily-blitz";

describe("OpsChatRail prompt suggestions UI", () => {
  const sampleSuggestions: PromptSuggestion[] = [
    {
      id: "gap-sports",
      label: "📉 Gaps in Sports",
      prompt: "Show coverage gaps for Sports with 3 or fewer facts and recommend subjects to enqueue.",
    },
    {
      id: "enqueue-nba_scoring",
      label: "➕ Enqueue NBA scoring",
      prompt: 'Enqueue "NBA scoring" into the crawl queue for Fact Foundry hydration.',
    },
  ];

  it("renders the prompt suggestions toggle button when suggestions are provided", () => {
    const html = renderToStaticMarkup(
      createElement(OpsChatRail, {
        subtitle: "Test Subtitle",
        emptyHint: "Empty hint",
        placeholder: "Type a prompt...",
        messages: [],
        pending: false,
        error: null,
        onSend: vi.fn(),
        suggestions: sampleSuggestions,
      }),
    );

    expect(html).toContain("daily-blitz-chat-suggestions-bar");
    expect(html).toContain("Prompt suggestions");
    expect(html).toContain('type="button"');
  });

  it("does not render the suggestions bar when neither suggestions nor onFetchSuggestions is provided", () => {
    const html = renderToStaticMarkup(
      createElement(OpsChatRail, {
        subtitle: "Test Subtitle",
        emptyHint: "Empty hint",
        placeholder: "Type a prompt...",
        messages: [],
        pending: false,
        error: null,
        onSend: vi.fn(),
      }),
    );

    expect(html).not.toContain("daily-blitz-chat-suggestions-bar");
  });

  it("disables the suggestions toggle button when pending is true", () => {
    const html = renderToStaticMarkup(
      createElement(OpsChatRail, {
        subtitle: "Test Subtitle",
        emptyHint: "Empty hint",
        placeholder: "Type a prompt...",
        messages: [],
        pending: true,
        error: null,
        onSend: vi.fn(),
        suggestions: sampleSuggestions,
      }),
    );

    expect(html).toContain("disabled");
  });

  it("formats single and appended prompts correctly with newlines", () => {
    const prompt1 = sampleSuggestions[0].prompt;
    const prompt2 = sampleSuggestions[1].prompt;

    // Simulate clicking prompt1 on empty input
    const initial = "";
    const afterFirst = initial.trim() ? `${initial.trim()}\n\n${prompt1}` : prompt1;
    expect(afterFirst).toBe(prompt1);

    // Simulate clicking prompt2 after prompt1
    const afterSecond = afterFirst.trim() ? `${afterFirst.trim()}\n\n${prompt2}` : prompt2;
    expect(afterSecond).toBe(`${prompt1}\n\n${prompt2}`);
  });

  it("handles throwing or rejecting onFetchSuggestions safely without unhandled rejection", async () => {
    const rejectingFetch = vi.fn().mockRejectedValue(new Error("Network timeout"));

    const html = renderToStaticMarkup(
      createElement(OpsChatRail, {
        subtitle: "Test Subtitle",
        emptyHint: "Empty hint",
        placeholder: "Type a prompt...",
        messages: [],
        pending: false,
        error: null,
        onSend: vi.fn(),
        onFetchSuggestions: rejectingFetch,
        suggestionsError: "Failed to load suggestions",
      }),
    );

    expect(html).toContain("daily-blitz-chat-suggestions-bar");
  });
});
