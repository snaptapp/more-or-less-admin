import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/credentials.server", () => ({
  getAccessToken: vi.fn(async () => "test-token"),
  getServiceAccount: vi.fn(() => ({
    project_id: "test-project",
    client_email: "admin@example.com",
    private_key: "unused",
  })),
}));

import {
  getRemoteConfigTemplate,
  publishTopicSuggestionsConfig,
  type RemoteConfigTemplate,
} from "@/lib/firebase/remote_config.server";

function remoteResponse(template: RemoteConfigTemplate, etag?: string): Response {
  return new Response(JSON.stringify(template), {
    status: 200,
    headers: etag
      ? { "Content-Type": "application/json", ETag: etag }
      : { "Content-Type": "application/json" },
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

/** The template Firebase stores for the PUT it just accepted. */
function templateFromPutBody(init: RequestInit | undefined, versionNumber: string): RemoteConfigTemplate {
  const body = JSON.parse(String(init?.body ?? "{}")) as RemoteConfigTemplate;
  return {
    parameters: body.parameters ?? {},
    conditions: body.conditions ?? [],
    etag: "",
    version: { versionNumber },
  };
}

/**
 * Serves the pre-publish GET, then the PUT, then every read-back. `readBack` gets
 * the stored template and the 1-based read-back attempt, so a test can simulate a
 * read that lags the publish.
 */
function mockTemplateApi(options: {
  seed: RemoteConfigTemplate;
  seedEtag?: string;
  putEtag?: string;
  readBack: (published: RemoteConfigTemplate, attempt: number) => Response;
}) {
  let published: RemoteConfigTemplate | null = null;
  let readBacks = 0;
  return vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      published = templateFromPutBody(init, "3");
      return remoteResponse(published, options.putEtag);
    }
    if (!published) return remoteResponse(options.seed, options.seedEtag);
    readBacks += 1;
    return options.readBack(published, readBacks);
  });
}

describe("Remote Config publishing", () => {
  it("loads the template when Firebase omits the ETag header", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(remoteResponse(TEMPLATE));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getRemoteConfigTemplate();

    expect(result.parameters).toEqual({});
    expect(result.etag).toBe("");
  });

  it("reports success once the read-back contains the submitted values", async () => {
    const fetchMock = mockTemplateApi({
      seed: TEMPLATE,
      seedEtag: "etag-1",
      putEtag: "etag-2",
      readBack: (published) => remoteResponse(published, "etag-2"),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishTopicSuggestionsConfig(INPUT, "etag-1", "admin@example.com", "2");

    expect(result.defaultTopics).toEqual(INPUT.defaultTopics);
    expect(result.enableInterstitialAds).toBe(false);
    expect(result.etag).toBe("etag-2");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "PUT",
      headers: expect.objectContaining({ "If-Match": "etag-1" }),
    });
  });

  it("reports success when the read-back version moved on but the values were saved", async () => {
    // Firebase can report a different ETag/version after a publish (a concurrent
    // edit, or a read that has not caught up). The values are what was published.
    const fetchMock = mockTemplateApi({
      seed: TEMPLATE,
      seedEtag: "etag-1",
      putEtag: "etag-2",
      readBack: (published) =>
        remoteResponse({ ...published, version: { versionNumber: "9", description: "another edit" } }, "etag-3"),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishTopicSuggestionsConfig(INPUT, "etag-1", "admin@example.com", "2");

    expect(result.defaultTopics).toEqual(INPUT.defaultTopics);
    expect(result.versionNumber).toBe("9");
    expect(result.etag).toBe("etag-3");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a lagging read-back before failing", async () => {
    const fetchMock = mockTemplateApi({
      seed: TEMPLATE,
      seedEtag: "etag-1",
      readBack: (published, attempt) =>
        attempt === 1 ? remoteResponse(TEMPLATE, "etag-1") : remoteResponse(published),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishTopicSuggestionsConfig(INPUT, "etag-1", "admin@example.com", "2");

    expect(result.defaultTopics).toEqual(INPUT.defaultTopics);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("preserves the page ETag so Firebase rejects stale client state", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(remoteResponse(TEMPLATE, "etag-current"))
      .mockResolvedValueOnce(new Response("ETag mismatch", { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(publishTopicSuggestionsConfig(INPUT, "etag-stale", "admin@example.com", "2")).rejects.toThrow(
      "Failed to publish Remote Config (409)",
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: expect.objectContaining({ "If-Match": "etag-stale" }),
    });
  });

  it("publishes without ETags only after matching the loaded version and verifying the values", async () => {
    const fetchMock = mockTemplateApi({
      seed: TEMPLATE,
      readBack: (published) => remoteResponse(published),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishTopicSuggestionsConfig(INPUT, "", "admin@example.com", "2");

    expect(result.defaultTopics).toEqual(INPUT.defaultTopics);
    expect(result.etag).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "PUT",
      headers: expect.objectContaining({ "If-Match": "*" }),
    });
  });

  it("rejects a publish whose values never appear on read-back", async () => {
    const fetchMock = mockTemplateApi({
      seed: TEMPLATE,
      readBack: () => remoteResponse({ ...TEMPLATE, version: { versionNumber: "3" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      publishTopicSuggestionsConfig(INPUT, "", "admin@example.com", "2"),
    ).rejects.toThrow("never returned the submitted values");
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("rejects a publish whose written mode-visibility key is missing on read-back", async () => {
    const fetchMock = mockTemplateApi({
      seed: TEMPLATE,
      readBack: (published) => {
        const parameters = { ...published.parameters };
        delete parameters["mode_standard_visible"];
        return remoteResponse({ ...published, parameters });
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      publishTopicSuggestionsConfig(
        { ...INPUT, modeVisibility: { standard: true } },
        "",
        "admin@example.com",
        "2",
      ),
    ).rejects.toThrow("mode_standard_visible");
  });

  it("rejects an ETag-free publish if the loaded template version is stale", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(remoteResponse(TEMPLATE));
    vi.stubGlobal("fetch", fetchMock);

    await expect(publishTopicSuggestionsConfig(INPUT, "", "admin@example.com", "1")).rejects.toThrow(
      "changed since you loaded it",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses an ETag-free publish without a loaded template version", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(remoteResponse({ ...TEMPLATE, version: undefined }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(publishTopicSuggestionsConfig(INPUT, "", "admin@example.com")).rejects.toThrow(
      "no ETag or usable template version",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
