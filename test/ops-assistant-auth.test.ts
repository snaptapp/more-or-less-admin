import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  opsAssistantSecretMatches,
  requireOpsAssistantAuth,
} from "@/lib/admin/ops-assistant-auth.server";

describe("ops assistant auth", () => {
  const previousAssistant = process.env["OPS_ASSISTANT_SECRET"];
  const previousCron = process.env["OPS_CRON_SECRET"];

  beforeEach(() => {
    delete process.env["OPS_ASSISTANT_SECRET"];
    delete process.env["OPS_CRON_SECRET"];
  });

  afterEach(() => {
    if (previousAssistant === undefined) delete process.env["OPS_ASSISTANT_SECRET"];
    else process.env["OPS_ASSISTANT_SECRET"] = previousAssistant;
    if (previousCron === undefined) delete process.env["OPS_CRON_SECRET"];
    else process.env["OPS_CRON_SECRET"] = previousCron;
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

  it("falls back to OPS_CRON_SECRET when assistant secret is unset", () => {
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
