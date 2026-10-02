import { describe, expect, it } from "vitest";
import { bearerSecretMatches } from "@/lib/admin/shared-secret.server";

describe("bearerSecretMatches", () => {
  it("fails closed for empty expected secret", () => {
    expect(bearerSecretMatches("Bearer anything", "")).toBe(false);
  });

  it("accepts a matching Bearer token", () => {
    expect(bearerSecretMatches("Bearer secret", "secret")).toBe(true);
    expect(bearerSecretMatches("bearer secret", "secret")).toBe(true);
  });

  it("rejects wrong, missing, or empty tokens", () => {
    expect(bearerSecretMatches("Bearer wrong", "secret")).toBe(false);
    expect(bearerSecretMatches(null, "secret")).toBe(false);
    expect(bearerSecretMatches("Bearer ", "secret")).toBe(false);
  });

  it("still matches a bare token after Bearer prefix strip fails to apply", () => {
    // Preserves prior cronSecretMatches / opsAssistantSecretMatches behavior.
    expect(bearerSecretMatches("secret", "secret")).toBe(true);
  });
});
