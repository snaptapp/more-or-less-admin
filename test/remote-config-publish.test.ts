import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/credentials.server", () => ({
  getAccessToken: vi.fn(async () => "test-token"),
  getServiceAccount: vi.fn(() => ({
    project_id: "test-project",
    client_email: "admin@example.com",
    private_key: "unused",
  })),
}));

import { publishTopicSuggestionsConfig, type RemoteConfigTemplate } from "@/lib/firebase/remote_config.server";

function remoteResponse(template: RemoteConfigTemplate, etag?: string): Response {
  return new Response(JSON.stringify(template), {
    status: 200,
    headers: etag ? { "Content-Type": "application/json", ETag: etag } : { "Content-Type": "application/json" },
  });
}

const INPUT = {
  defaultTopics: ["Space", "Food"],
  variants: [],
  enableInterstitialAds: false,
  interstitialAdFrequency: 3,
  enableRewardedAds: true,
  enableBannerAds: false,
  allowedEmails: ["@example.com"],
  customParameters: {},
};

const TEMPLATE: RemoteConfigTemplate = {
  parameters: {},
  conditions: [],
  etag: "",
  version: { versionNumber: "2" },
};

describe("Remote Config publishing", () => {
  it("returns success only after Firebase read-back confirms the published ETag", async () => {
    const publishedTemplate: RemoteConfigTemplate = {
      ...TEMPLATE,
      parameters: {
        custom_topic_suggestions: { defaultValue: { value: JSON.stringify(INPUT.defaultTopics) } },
      },
      version: { versionNumber: "3" },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(remoteResponse(TEMPLATE, "etag-1"))
      .mockResolvedValueOnce(remoteResponse(publishedTemplate, "etag-2"))
      .mockResolvedValueOnce(remoteResponse(publishedTemplate, "etag-2"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishTopicSuggestionsConfig(INPUT, "etag-1", "admin@example.com");

    expect(result.defaultTopics).toEqual(INPUT.defaultTopics);
    expect(result.etag).toBe("etag-2");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "PUT",
      headers: expect.objectContaining({ "If-Match": "etag-1" }),
    });
  });

  it("rejects success when a different ETag appears during read-back", async () => {
    const publishedTemplate: RemoteConfigTemplate = {
      ...TEMPLATE,
      parameters: {
        custom_topic_suggestions: { defaultValue: { value: JSON.stringify(INPUT.defaultTopics) } },
      },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(remoteResponse(TEMPLATE, "etag-1"))
      .mockResolvedValueOnce(remoteResponse(publishedTemplate, "etag-2"))
      .mockResolvedValueOnce(remoteResponse(TEMPLATE, "etag-3"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(publishTopicSuggestionsConfig(INPUT, "etag-1")).rejects.toThrow(
      "read-back returned a different version",
    );
  });

  it("refuses to force-publish when the fetched template has no ETag", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(remoteResponse(TEMPLATE));
    vi.stubGlobal("fetch", fetchMock);

    await expect(publishTopicSuggestionsConfig(INPUT, "etag-1")).rejects.toThrow(
      "did not return an ETag",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
