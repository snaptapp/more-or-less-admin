/**
 * Replays the synchronized Go key/identity fixture against the Admin helpers.
 *
 * The fixture is read from the vendored shared handoff, so this test exercises
 * the same canonical vectors as the Go reference without invoking Firestore,
 * credentials, or any other network service.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { factId, normalizeKey } from "@/lib/firebase/firestore.server";
import { blockedNetworkAttempts } from "./setup";

interface NormalizationVector {
  readonly name: string;
  readonly input: string;
  readonly key: string;
}

interface FactIdVector {
  readonly name: string;
  readonly subject: string;
  readonly angle: string;
  readonly subject_key: string;
  readonly angle_key: string;
  readonly fact_id: string;
}

interface KeyNormalizationFixture {
  readonly schema: string;
  readonly normalization_vectors: readonly NormalizationVector[];
  readonly fact_id_vectors: readonly FactIdVector[];
}

const FIXTURE = JSON.parse(
  readFileSync(new URL("../shared/ddm/fixtures/key_normalization.json", import.meta.url), "utf8"),
) as KeyNormalizationFixture;

describe("canonical Admin key and fact identity", () => {
  it("replays every normalized subject/angle key from the synchronized fixture", () => {
    expect(FIXTURE.schema).toBe("key_normalization/1");
    expect(FIXTURE.normalization_vectors.length).toBeGreaterThan(0);

    for (const vector of FIXTURE.normalization_vectors) {
      expect(normalizeKey(vector.input), vector.name).toBe(vector.key);
    }

    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("replays every fact ID from the synchronized fixture", async () => {
    expect(FIXTURE.fact_id_vectors.length).toBeGreaterThan(0);

    for (const vector of FIXTURE.fact_id_vectors) {
      const subjectKey = normalizeKey(vector.subject);
      const angleKey = normalizeKey(vector.angle);

      expect(subjectKey, vector.name).toBe(vector.subject_key);
      expect(angleKey, vector.name).toBe(vector.angle_key);
      expect(await factId(subjectKey, angleKey), vector.name).toBe(vector.fact_id);
    }

    expect(blockedNetworkAttempts()).toEqual([]);
  });
});
