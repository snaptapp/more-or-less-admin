/**
 * Minimal smoke coverage for the test harness itself (task 5.1).
 *
 * Feature: admin-quality-gates-and-shared-contracts
 *
 * These assertions only prove the runner starts and the network guard is live
 * for every test file. The real authorization/mutation coverage arrives in
 * tasks 5.3-5.5 and 6.3-6.7.
 */
import { describe, expect, it } from "vitest";
import {
  NetworkAccessError,
  blockedNetworkAttempts,
  classifyNetworkTarget,
} from "./setup";

describe("network guard", () => {
  it("blocks a Firestore request with a NetworkAccessError naming the target", async () => {
    const url =
      "https://firestore.googleapis.com/v1/projects/more-or-less-505908/databases/(default)/documents/fact_bank";

    await expect(fetch(url)).rejects.toThrow(NetworkAccessError);
    expect(blockedNetworkAttempts()).toEqual([{ target: url, category: "firestore" }]);
  });

  it.each([
    ["https://firestore.googleapis.com/v1/projects/p/databases/(default)/documents", "firestore"],
    ["https://identitytoolkit.googleapis.com/v1/projects/p/accounts:query", "firebase-auth"],
    [
      "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
      "firebase-auth",
    ],
    ["https://firebaseremoteconfig.googleapis.com/v1/projects/p/remoteConfig", "remote-config"],
    ["https://agent-go-abc123-uc.a.run.app/pack", "go-agent"],
    ["https://example.com/anything", "unclassified"],
  ] as const)("classifies %s as %s", (url, category) => {
    expect(classifyNetworkTarget(url)).toBe(category);
  });
});
