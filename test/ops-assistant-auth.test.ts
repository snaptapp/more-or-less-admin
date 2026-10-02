import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  opsAssistantSecretMatches,
  requireOpsAssistantAuth,
} from "@/lib/admin/ops-assistant-auth.server";

describe("ops assistant auth", () => {
  const previousAssistant = process.env["OPS_ASSISTANT_SECRET"];
  const previousCron = process.env["OPS_CRON_SECRET"];
  const previousCronFallback = process.env["OPS_ASSISTANT_ALLOW_CRON_FALLBACK"];

  beforeEach(() => {
    delete process.env["OPS_ASSISTANT_SECRET"];
    delete process.env["OPS_CRON_SECRET"];
    delete process.env["OPS_ASSISTANT_ALLOW_CRON_FALLBACK"];
  });

  afterEach(() => {
    if (previousAssistant === undefined) delete process.env["OPS_ASSISTANT_SECRET"];
    else process.env["OPS_ASSISTANT_SECRET"] = previousAssistant;
    if (previousCron === undefined) delete process.env["OPS_CRON_SECRET"];
    else process.env["OPS_CRON_SECRET"] = previousCron;
    if (previousCronFallback === undefined) delete process.env["OPS_ASSISTANT_ALLOW_CRON_FALLBACK"];
    else process.env["OPS_ASSISTANT_ALLOW_CRON_FALLBACK"] = previousCronFallback;
  });

  it("fails closed when no secret is configured", () => {
    const result = requireOpsAssistantAuth("Bearer anything");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.status).toBe(503);
  });

  it("accepts OPS_ASSISTANT_SECRET bearer tokens", () => {
    process.env["OPS_ASSISTANT_SECRET"] = "assistant-secret";
    expect(opsAssistantSecretMatches("Bearer assistant-secret")).toBe(true);
    expect(requireOpsAssistantAuth("Bearer assistant-secret")).toEqual({ ok: true });
    expect(opsAssistantSecretMatches("Bearer wrong")).toBe(false);
  });

  it("returns 401 when the bearer token does not match OPS_ASSISTANT_SECRET", () => {
    process.env["OPS_ASSISTANT_SECRET"] = "assistant-secret";
    const result = requireOpsAssistantAuth("Bearer wrong-token");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.status).toBe(401);
    expect(result.error).toBe("Unauthorized.");
  });

  it("returns 401 when Authorization is missing but OPS_ASSISTANT_SECRET is set", () => {
    process.env["OPS_ASSISTANT_SECRET"] = "assistant-secret";
    const result = requireOpsAssistantAuth(null);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.status).toBe(401);
  });

  it("does not accept OPS_CRON_SECRET without OPS_ASSISTANT_SECRET by default", () => {
    process.env["OPS_CRON_SECRET"] = "cron-secret";
    expect(opsAssistantSecretMatches("Bearer cron-secret")).toBe(false);
    const result = requireOpsAssistantAuth("Bearer cron-secret");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.status).toBe(503);
  });

  it("falls back to OPS_CRON_SECRET when OPS_ASSISTANT_ALLOW_CRON_FALLBACK=1", () => {
    process.env["OPS_ASSISTANT_ALLOW_CRON_FALLBACK"] = "1";
    process.env["OPS_CRON_SECRET"] = "cron-secret";
    expect(opsAssistantSecretMatches("Bearer cron-secret")).toBe(true);
    expect(requireOpsAssistantAuth("Bearer cron-secret")).toEqual({ ok: true });
  });

  it("prefers OPS_ASSISTANT_SECRET over OPS_CRON_SECRET", () => {
    process.env["OPS_ASSISTANT_SECRET"] = "assistant-secret";
    process.env["OPS_CRON_SECRET"] = "cron-secret";
    expect(opsAssistantSecretMatches("Bearer assistant-secret")).toBe(true);
    expect(opsAssistantSecretMatches("Bearer cron-secret")).toBe(false);
  });
});
