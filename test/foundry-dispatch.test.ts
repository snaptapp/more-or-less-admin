import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getFoundryDispatchStatus,
  triggerFoundryWorkflow,
} from "@/lib/admin/ops.server";

const originalGitHubToken = process.env["GITHUB_TOKEN"];
const originalGhToken = process.env["GH_TOKEN"];
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  delete process.env["GITHUB_TOKEN"];
  delete process.env["GH_TOKEN"];
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  if (originalGitHubToken === undefined) delete process.env["GITHUB_TOKEN"];
  else process.env["GITHUB_TOKEN"] = originalGitHubToken;
  if (originalGhToken === undefined) delete process.env["GH_TOKEN"];
  else process.env["GH_TOKEN"] = originalGhToken;
});

describe("Foundry dispatch configuration", () => {
  it("returns configured false without fetching when the Worker secret is absent", async () => {
    await expect(getFoundryDispatchStatus()).resolves.toEqual({ configured: false });
    await expect(triggerFoundryWorkflow()).resolves.toEqual({
      configured: false,
      ok: false,
      message: "On-demand dispatch is not configured. Topics remain queued for nightly hydration.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dispatches the exact Fact Foundry workflow payload through mocked fetch", async () => {
    process.env["GITHUB_TOKEN"] = "worker-secret";
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(triggerFoundryWorkflow()).resolves.toEqual({
      configured: true,
      ok: true,
      message: "Fact Foundry workflow triggered successfully on GitHub Actions.",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://api.github.com/repos/snaptapp/more-or-less/actions/workflows/fact-foundry.yml/dispatches",
    );
    expect(request?.method).toBe("POST");
    expect(request?.headers).toEqual({
      Authorization: "Bearer worker-secret",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "more-or-less-admin",
    });
    expect(request?.body).toBe(
      JSON.stringify({
        ref: "main",
        inputs: {
          subjects: "",
          refresh_stale_days: "0",
          facts_per_subject: "8",
        },
      }),
    );
  });

  it("surfaces a non-2xx response without claiming success", async () => {
    process.env["GH_TOKEN"] = "worker-secret";
    fetchMock.mockResolvedValue(
      new Response("Workflow dispatch is unavailable", {
        status: 422,
        statusText: "Unprocessable Entity",
      }),
    );

    await expect(triggerFoundryWorkflow()).resolves.toEqual({
      configured: true,
      ok: false,
      message: "GitHub Action dispatch failed (422): Workflow dispatch is unavailable",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
