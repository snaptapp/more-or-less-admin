/**
 * Feature: admin-quality-gates-and-shared-contracts
 *
 * Requirement 6.8 — `toFact` applied to a `fact_bank` document whose data
 * object is empty yields every declared default: the empty string for each
 * string field declared without a fallback, `null` for each nullable field
 * (including `true_number`, `surprise_factor` and `derivation`), empty arrays
 * for `source_urls` and `quality_flags`, `0` for `served_count`, `standard` for
 * `content_rating`, `active` for `status`, and `false` for `number_pinned`.
 *
 * Why the whole record is asserted, not just the fields the requirement names
 * --------------------------------------------------------------------------
 * The requirement enumerates the interesting defaults, but the risk it guards
 * against is a *newly added* field arriving with the wrong default — an empty
 * string where the client expects `null`, or `null` where it expects `[]`. So
 * this test asserts the entire returned object with `toEqual` against the
 * expected default record, and then proves the returned key set is exactly the
 * declared `FactRecord` member set, read out of the interface with the
 * TypeScript AST rather than transcribed. Adding a field to `FactRecord`
 * therefore fails here until its default is written down, which is the point.
 *
 * Relationship to task 6.5
 * ------------------------
 * `test/fact-mutations.property.test.ts` (Property 21) owns the
 * `surprise_factor` canonicalization across the legacy 0-10 range. This file
 * asserts only the empty-document case of that field (`null`) as one entry in
 * the default record, and adds no further coverage of the mapping.
 *
 * `toFact` is pure over a `FirestoreDoc`, so the document is constructed
 * directly and no store is touched. Firestore is still replaced with the
 * in-memory double so that importing `content.server` cannot reach a
 * credential, emulator, or deployed service (Requirements 6.10, 6.14).
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { blockedNetworkAttempts, firestoreDouble, type FirestoreDoc } from "./setup";

vi.mock("@/lib/firebase/firestore.server", async () => {
  const { firestoreDouble: double } = await import("./setup");
  return double().module;
});

import { toFact, type FactRecord } from "@/lib/admin/content.server";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT_SERVER = "src/lib/admin/content.server.ts";

// ---------------------------------------------------------------------------
// The declared FactRecord member set, read out of the interface
// ---------------------------------------------------------------------------

/**
 * Every property name declared by `interface FactRecord`, so the key-set
 * assertion below tracks the declaration instead of a copy of it.
 */
function declaredFactRecordKeys(): string[] {
  const absolute = path.join(REPO_ROOT, CONTENT_SERVER);
  const sourceFile = ts.createSourceFile(
    absolute,
    readFileSync(absolute, "utf8"),
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );

  const declarations: string[][] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === "FactRecord") {
      declarations.push(
        node.members
          .filter(ts.isPropertySignature)
          .map((member) =>
            ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
              ? member.name.text
              : member.name.getText(sourceFile),
          ),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (declarations.length !== 1) {
    throw new Error(
      `expected exactly one FactRecord interface declaration in ${CONTENT_SERVER}, ` +
      `found ${declarations.length}`,
    );
  }
  return declarations[0];
}

const DECLARED_KEYS = declaredFactRecordKeys();

// ---------------------------------------------------------------------------
// The document under test and the expected default record
// ---------------------------------------------------------------------------

const EMPTY_DOC_ID = "fact_empty";

/** A `fact_bank` document whose data object carries nothing at all. */
function emptyDoc(): FirestoreDoc {
  return { id: EMPTY_DOC_ID, path: `fact_bank/${EMPTY_DOC_ID}`, data: {} };
}

/**
 * Every declared default, written out field by field. `updateTime` is optional
 * on `FactRecord` and is copied straight off the document, so an empty document
 * with no `updateTime` yields `undefined`.
 */
const EXPECTED_DEFAULTS: FactRecord = {
  id: EMPTY_DOC_ID,
  // String fields declared without a fallback → the empty string.
  subject: "",
  subject_key: "",
  angle: "",
  angle_key: "",
  unit: "",
  claim_template: "",
  context: "",
  question: "",
  verifier_model: "",
  quantity_kind: "",
  number_token: "",
  true_number_token: "",
  // Nullable fields → null.
  true_number: null,
  surprise_factor: null,
  difficulty_hint: null,
  previous_true_number: null,
  retired_reason: null,
  verified_at: null,
  last_served_at: null,
  category: null,
  derivation: null,
  plausible_min: null,
  plausible_max: null,
  quantity_spec: null,
  as_of_year: null,
  disputed_reason: null,
  pinned_reason: null,
  // Array fields → empty arrays.
  source_urls: [],
  quality_flags: [],
  // Scalars with a declared fallback.
  served_count: 0,
  content_rating: "standard",
  status: "active",
  number_pinned: false,
  updateTime: undefined,
};

describe("Feature: admin-quality-gates-and-shared-contracts, Requirement 6.8: `toFact` empty-document defaults", () => {
  it("declares a non-empty FactRecord member set, so the key assertion is not vacuous", () => {
    expect(DECLARED_KEYS.length).toBeGreaterThan(0);
    expect(new Set(DECLARED_KEYS).size).toBe(DECLARED_KEYS.length);
  });

  it("returns exactly the declared default for every FactRecord field", () => {
    // The whole object at once: a field whose default changes, or a new field
    // arriving with an unconsidered default, fails right here.
    expect(toFact(emptyDoc())).toEqual(EXPECTED_DEFAULTS);
  });

  it("returns exactly the fields FactRecord declares, no more and no fewer", () => {
    // Guards the assertion above: `toEqual` on a record that silently gained a
    // field would still need that field listed in EXPECTED_DEFAULTS, and this
    // makes the failure name the field rather than only its value.
    const returned = Object.keys(toFact(emptyDoc())).sort();
    expect(returned).toEqual([...DECLARED_KEYS].sort());
    // And the expected record covers the same set, so neither side drifts.
    expect(Object.keys(EXPECTED_DEFAULTS).sort()).toEqual([...DECLARED_KEYS].sort());
  });

  it("spells out each clause of Requirement 6.8 individually", () => {
    const fact = toFact(emptyDoc());

    // Empty strings for the no-fallback string fields.
    for (const key of [
      "subject",
      "subject_key",
      "angle",
      "angle_key",
      "unit",
      "claim_template",
      "context",
      "question",
      "verifier_model",
      "quantity_kind",
      "number_token",
    ] as const) {
      expect(fact[key], key).toBe("");
    }

    // Nulls, including the three the requirement names explicitly.
    for (const key of [
      "true_number",
      "surprise_factor",
      "derivation",
      "previous_true_number",
      "retired_reason",
      "verified_at",
      "last_served_at",
      "category",
      "plausible_min",
      "plausible_max",
      "as_of_year",
      "disputed_reason",
      "pinned_reason",
    ] as const) {
      expect(fact[key], key).toBeNull();
    }

    // Empty arrays, and the remaining scalar defaults.
    expect(fact.source_urls).toEqual([]);
    expect(fact.quality_flags).toEqual([]);
    expect(fact.served_count).toBe(0);
    expect(fact.content_rating).toBe("standard");
    expect(fact.status).toBe("active");
    expect(fact.number_pinned).toBe(false);

    // The id is the document id, and no read or write was needed to get here.
    expect(fact.id).toBe(EMPTY_DOC_ID);
    expect(firestoreDouble().writeCount()).toBe(0);
    expect(blockedNetworkAttempts()).toEqual([]);
  });

  it("hands back fresh arrays, so one record's defaults cannot leak into another", () => {
    const first = toFact(emptyDoc());
    const second = toFact(emptyDoc());

    expect(first.source_urls).not.toBe(second.source_urls);
    expect(first.quality_flags).not.toBe(second.quality_flags);

    first.source_urls.push("https://example.com/leaked");
    first.quality_flags.push("leaked_flag");

    expect(second.source_urls).toEqual([]);
    expect(second.quality_flags).toEqual([]);
    expect(toFact(emptyDoc())).toEqual(EXPECTED_DEFAULTS);
  });
});
