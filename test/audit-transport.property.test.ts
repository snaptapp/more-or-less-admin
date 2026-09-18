/**
 * Feature: admin-quality-gates-and-shared-contracts
 *
 * Property 17: Audit entries survive transport with scalar fields intact
 *   *For any* audit log entry, transporting the entry through the TanStack Start
 *   serializer preserves `adminUid`, `action`, `targetType`, `targetId`, and
 *   `createdAt` unchanged and delivers `before` and `after` either as
 *   serializer-accepted values or as `null`.
 *   Validates: Requirements 3.7
 *
 * What "transport" means here
 * --------------------------
 * The read path under test is the real one, end to end:
 *
 *   seeded `admin_audit_logs` documents (Firestore double)
 *     → `listAuditLogs(100)`            (src/lib/firebase/audit.server.ts)
 *     → `fetchAuditLogEntries` handler  (src/lib/admin/roles.functions.ts)
 *     → serializer                      → client-side value
 *
 * TanStack Start's serializer has two halves and this file exercises both:
 *
 *  1. **Compile time** — `createServerFn(...).handler(fn)` runs its return type
 *     through `ValidateSerializableInput<TRegister, T>` from
 *     `@tanstack/router-core`, which is precisely what rejected the old
 *     `Record<string, unknown> | null` shape of `AuditLogEntry.before` (the
 *     Requirement 3.7 error at `roles.functions.ts:46`). The `Accepts<T>` alias
 *     below applies that same real type, and the two `const` witnesses are
 *     enforced by `npx tsc --noEmit`: a shape the serializer rejects makes this
 *     file fail to compile. The legacy-shape witness is the negative control, so
 *     the check cannot pass vacuously.
 *
 *  2. **Run time** — the wire encoder is `seroval` (`@tanstack/router-core`
 *     builds its serializer on it — see
 *     `router-core/dist/esm/ssr/serializer/transformer.d.ts`, whose
 *     `makeSerovalPlugin` produces `seroval` `Plugin`s). This file round-trips
 *     the delivered array through `seroval`'s `toJSONAsync` → `fromJSON`, which
 *     is the genuine encoder rather than a proxy for it. A plain JSON round trip
 *     runs alongside it and must agree, so the property also holds under the
 *     weaker `JSON.parse(JSON.stringify(...))` reading of "serializer-accepted".
 *
 *     `getDefaultSerovalPlugins()` is deliberately *not* used: it reads the
 *     ambient Start options, which require a running Start instance. No audit
 *     field needs a custom adapter — every value is plain JSON data — so the
 *     plugin-free encoder is the faithful configuration for this payload.
 *
 * Hermetic import
 * ---------------
 * Same approach as `test/server-functions.property.test.ts`: a recording
 * `createServerFn` captures each declaration's handler (TanStack does not expose
 * it on the object `.handler()` returns), `@/lib/admin/middleware` is mocked away
 * so importing `roles.functions.ts` does not pull in the Firebase web SDK, and
 * `@/lib/firebase/firestore.server` is the in-memory double. `audit.server.ts`
 * itself is **not** mocked — `listAuditLogs` is the code under test.
 */
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { fromJSON, toJSONAsync } from "seroval";
import type { Serializable, ValidateSerializable } from "@tanstack/router-core";

import {
  blockedNetworkAttempts,
  firestoreDouble,
  type AdminUser,
  type AuditLogEntry,
  type JsonValue,
} from "./setup";

// ---------------------------------------------------------------------------
// Recording harness (hoisted above the `vi.mock` factories)
// ---------------------------------------------------------------------------

/** A server-fn handler as TanStack invokes it. */
type ServerFnHandler = (ctx: {
  data?: unknown;
  context?: unknown;
}) => Promise<AuditLogEntry[]>;

const harness = vi.hoisted(() => {
  interface ChainState {
    factoryOptions: Record<string, unknown> | undefined;
    middleware: unknown[];
    validator: unknown;
  }

  /** token object returned by `.handler()` → what the module actually exports. */
  const registry = new Map<object, { handler: unknown }>();

  const makeChain = (state: ChainState): Record<string, unknown> => ({
    options: state.factoryOptions,
    middleware: (list: unknown[]) =>
      makeChain({ ...state, middleware: [...state.middleware, ...list] }),
    validator: (fn: unknown) => makeChain({ ...state, validator: fn }),
    inputValidator: (fn: unknown) => makeChain({ ...state, validator: fn }),
    handler: (fn: unknown) => {
      const token = { __recordedServerFn: true };
      registry.set(token, { handler: fn });
      return token;
    },
  });

  const createServerFn = (options?: Record<string, unknown>) =>
    makeChain({ factoryOptions: options, middleware: [], validator: null });

  const createMiddleware = (): Record<string, unknown> => {
    const chain: Record<string, unknown> = {
      options: {},
      client: () => chain,
      server: () => chain,
      middleware: () => chain,
      validator: () => chain,
      inputValidator: () => chain,
    };
    return chain;
  };

  const authMiddleware = { __stubAuthMiddleware: true, options: {} };
  const authedServerFn = (options?: Record<string, unknown>) => {
    const chain = createServerFn(options) as {
      middleware: (list: unknown[]) => Record<string, unknown>;
    };
    return chain.middleware([authMiddleware]);
  };

  return { registry, createServerFn, createMiddleware, authMiddleware, authedServerFn };
});

vi.mock("@tanstack/react-start", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createServerFn: harness.createServerFn,
    createMiddleware: harness.createMiddleware,
  };
});

vi.mock("@/lib/admin/middleware", () => ({
  authMiddleware: harness.authMiddleware,
  authedServerFn: harness.authedServerFn,
}));

// The read path's only I/O. `audit.server.ts` is intentionally left real.
vi.mock("@/lib/firebase/firestore.server", async () => {
  const { firestoreDouble } = await import("./setup");
  return firestoreDouble().module;
});

// ---------------------------------------------------------------------------
// Static half of the serializer check (enforced by `npx tsc --noEmit`)
// ---------------------------------------------------------------------------

/**
 * `true` exactly when the TanStack serializer accepts `T`. This is TanStack's
 * own `ValidateSerializable` applied against the registered `Serializable`
 * union: a type it rejects is rewritten to carry a `SerializationError`, which
 * `T` is then not assignable to.
 */
type Accepts<T> = [T] extends [ValidateSerializable<T, Serializable>] ? true : false;

/**
 * Constraint-carrying identities. `boolean` satisfies neither, so a verdict that
 * failed to resolve to a literal is a compile error rather than a silent pass.
 */
type ExpectTrue<T extends true> = T;
type ExpectFalse<T extends false> = T;

/** The shape `AuditLogEntry.before`/`after` carried before the Requirement 3.7 fix. */
interface LegacyAuditLogEntry {
  adminUid: string;
  action: string;
  targetType: AuditLogEntry["targetType"];
  targetId: string;
  createdAt?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

/**
 * Compile-time assertions. Each `const` is annotated with a literal type derived
 * from `Accepts<...>`, so the initializer only typechecks if the verdict is the
 * one written here. `AUDIT_ENTRIES_ACCEPTED` fails to compile if the transported
 * type ever regresses to something the serializer rejects;
 * `LEGACY_SHAPE_ACCEPTED` fails to compile if `Accepts` stopped discriminating,
 * which keeps the positive assertion from passing vacuously.
 */
const AUDIT_ENTRIES_ACCEPTED: ExpectTrue<Accepts<AuditLogEntry[]>> = true;
const LEGACY_SHAPE_ACCEPTED: ExpectFalse<Accepts<LegacyAuditLogEntry[]>> = false;

// ---------------------------------------------------------------------------
// Runtime transport
// ---------------------------------------------------------------------------

/** Round trip through `seroval`, the encoder the Start serializer is built on. */
async function transportViaSerializer<T>(value: T): Promise<T> {
  return fromJSON<T>(await toJSONAsync(value));
}

/** The weaker "serializer-accepted" reading: a plain JSON round trip. */
function transportViaJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Structural `JsonValue` predicate — what `before`/`after` are declared to be. */
function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry));
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every((entry) => isJsonValue(entry));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const TARGET_TYPES = [
  "fact",
  "report",
  "user",
  "subject",
  "playlist",
  "crawl_job",
  "daily_pack",
  "leaderboard",
  "system",
] as const;

/** Object keys that are safe to place on a plain object. */
const jsonKey = fc
  .string({ minLength: 1, maxLength: 8 })
  .filter((key) => key !== "__proto__" && key !== "constructor");

/**
 * JSON scalars, weighted so the falsy ones Requirement 3.7 cares about (`0`,
 * `""`, `false`, `null`) show up often: `listAuditLogs` reads `before`/`after`
 * with `??`, and a regression to `||` would silently turn each of them into
 * `null`.
 */
const jsonScalar: fc.Arbitrary<JsonValue> = fc.oneof(
  { arbitrary: fc.constantFrom<JsonValue>(0, "", false, null), weight: 4 },
  { arbitrary: fc.string({ maxLength: 12 }), weight: 2 },
  { arbitrary: fc.integer({ min: -1_000_000, max: 1_000_000 }), weight: 2 },
  {
    arbitrary: fc
      .double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true })
      .map((value) => (value === 0 ? 0 : value)),
    weight: 1,
  },
  { arbitrary: fc.boolean(), weight: 1 },
);

/** Arbitrary `JsonValue`, including nested objects and arrays. */
function jsonValueArb(depth: number): fc.Arbitrary<JsonValue> {
  if (depth <= 0) return jsonScalar;
  return fc.oneof(
    { arbitrary: jsonScalar, weight: 3 },
    { arbitrary: fc.array(jsonValueArb(depth - 1), { maxLength: 3 }), weight: 1 },
    {
      arbitrary: fc.dictionary(jsonKey, jsonValueArb(depth - 1), { maxKeys: 3 }),
      weight: 2,
    },
  );
}

/** One generated audit document, exactly as `logAdminAction` would persist it. */
interface SeededAuditDoc {
  id: string;
  adminUid: string;
  adminEmail: string | null;
  action: string;
  targetType: AuditLogEntry["targetType"];
  targetId: string;
  details: string | null;
  before: JsonValue;
  after: JsonValue;
  createdAt: string;
}

const auditDocArb = (index: number): fc.Arbitrary<SeededAuditDoc> =>
  fc.record({
    id: fc.constant(`audit_${String(index).padStart(4, "0")}`),
    adminUid: fc.string({ minLength: 1, maxLength: 24 }),
    adminEmail: fc.option(fc.string({ minLength: 1, maxLength: 24 }), { nil: null }),
    action: fc.string({ minLength: 1, maxLength: 24 }),
    targetType: fc.constantFrom(...TARGET_TYPES),
    targetId: fc.string({ minLength: 1, maxLength: 24 }),
    details: fc.option(fc.string({ maxLength: 24 }), { nil: null }),
    before: jsonValueArb(3),
    after: jsonValueArb(3),
    // Distinct, ordered timestamps so the `createdAt DESCENDING` query is
    // deterministic; entries are matched by id regardless.
    createdAt: fc.constant(new Date(Date.UTC(2024, 0, 1) + index * 1000).toISOString()),
  });

const auditDocsArb: fc.Arbitrary<SeededAuditDoc[]> = fc
  .integer({ min: 1, max: 4 })
  .chain((count) => fc.tuple(...Array.from({ length: count }, (_, i) => auditDocArb(i))))
  .map((docs) => [...docs]);

// ---------------------------------------------------------------------------
// The read path
// ---------------------------------------------------------------------------

const ADMIN_USER: AdminUser = {
  uid: "admin-under-test",
  email: "ops@snaptapp.us",
  name: "Ops Tester",
  isClaimAdmin: true,
};

/** Resolve the real `fetchAuditLogEntries` handler through the recording chain. */
async function fetchAuditLogEntriesHandler(): Promise<ServerFnHandler> {
  const rolesFunctions = (await import("@/lib/admin/roles.functions")) as Record<string, unknown>;
  const exported = rolesFunctions["fetchAuditLogEntries"];
  expect(typeof exported).toBe("object");
  const record = harness.registry.get(exported as object);
  expect(record, "fetchAuditLogEntries did not register a handler").toBeTruthy();
  return record!.handler as ServerFnHandler;
}

/** Seed the documents, run the server function, and transport the result. */
async function readAndTransport(
  handler: ServerFnHandler,
  docs: readonly SeededAuditDoc[],
): Promise<{
  delivered: AuditLogEntry[];
  viaSerializer: AuditLogEntry[];
  viaJson: AuditLogEntry[];
}> {
  const firestore = firestoreDouble();
  firestore.reset();
  for (const doc of docs) {
    const { id, ...fields } = doc;
    firestore.seed(`admin_audit_logs/${id}`, fields);
  }

  const delivered = await handler({ data: undefined, context: { user: ADMIN_USER } });
  return {
    delivered,
    viaSerializer: await transportViaSerializer(delivered),
    viaJson: transportViaJson(delivered),
  };
}

// ---------------------------------------------------------------------------
// Property 17
// ---------------------------------------------------------------------------

describe("Feature: admin-quality-gates-and-shared-contracts, Property 17: Audit entries survive transport with scalar fields intact", () => {
  it("accepts the transported entry type at compile time and rejects the pre-fix shape", () => {
    // The verdicts themselves are enforced by `tsc` (see the `const`
    // annotations); these assertions keep them from being dead code and make the
    // negative control visible in the test report.
    expect(AUDIT_ENTRIES_ACCEPTED).toBe(true);
    expect(LEGACY_SHAPE_ACCEPTED).toBe(false);
  });

  it("preserves adminUid, action, targetType, targetId and createdAt, and delivers before/after as a JsonValue or null", async () => {
    const handler = await fetchAuditLogEntriesHandler();

    await fc.assert(
      fc.asyncProperty(auditDocsArb, async (docs) => {
        const { delivered, viaSerializer, viaJson } = await readAndTransport(handler, docs);

        expect(delivered).toHaveLength(docs.length);

        for (const seeded of docs) {
          for (const [label, transported] of [
            ["seroval", viaSerializer],
            ["json", viaJson],
          ] as const) {
            const entry = transported.find((candidate) => candidate.id === seeded.id);
            expect(entry, `${label}: entry ${seeded.id} was not delivered`).toBeTruthy();
            if (!entry) return;

            // The five scalar fields arrive unchanged (Requirement 3.7).
            expect(entry.adminUid, `${label}: adminUid`).toBe(seeded.adminUid);
            expect(entry.action, `${label}: action`).toBe(seeded.action);
            expect(entry.targetType, `${label}: targetType`).toBe(seeded.targetType);
            expect(entry.targetId, `${label}: targetId`).toBe(seeded.targetId);
            expect(entry.createdAt, `${label}: createdAt`).toBe(seeded.createdAt);

            // `before`/`after` are a JsonValue or null — and identical to what
            // was stored, so a falsy payload is not coerced to null.
            for (const field of ["before", "after"] as const) {
              const value = entry[field];
              expect(isJsonValue(value), `${label}: ${field} is not a JsonValue`).toBe(true);
              expect(value, `${label}: ${field}`).toEqual(seeded[field]);
              if (seeded[field] !== null) {
                expect(value, `${label}: ${field} was coerced to null`).not.toBeNull();
              }
            }
          }
        }

        // Transporting through the real encoder and through JSON agree.
        expect(viaSerializer).toEqual(viaJson);
        expect(blockedNetworkAttempts()).toEqual([]);
      }),
      { numRuns: 120 },
    );
  }, 30_000);

  it("does not coerce the falsy payloads 0, empty string and false to null", async () => {
    // The concrete regression the property guards against, pinned as an example:
    // `listAuditLogs` must read `before`/`after` with `??`, not `||`.
    const handler = await fetchAuditLogEntriesHandler();
    const falsy: JsonValue[] = [0, "", false];

    const docs: SeededAuditDoc[] = falsy.map((payload, index) => ({
      id: `audit_${String(index).padStart(4, "0")}`,
      adminUid: `admin-${index}`,
      adminEmail: null,
      action: "bulk_update_facts",
      targetType: "fact",
      targetId: `fact-${index}`,
      details: null,
      before: payload,
      after: payload,
      createdAt: new Date(Date.UTC(2024, 0, 1) + index * 1000).toISOString(),
    }));

    const { viaSerializer } = await readAndTransport(handler, docs);

    for (const [index, payload] of falsy.entries()) {
      const entry = viaSerializer.find(
        (candidate) => candidate.id === `audit_${String(index).padStart(4, "0")}`,
      );
      expect(entry).toBeTruthy();
      expect(entry?.before).toBe(payload);
      expect(entry?.after).toBe(payload);
    }
  });

  it("delivers a null createdAt and a missing before/after as null", async () => {
    const handler = await fetchAuditLogEntriesHandler();
    const firestore = firestoreDouble();
    firestore.reset();
    firestore.seed("admin_audit_logs/audit_0000", {
      adminUid: "admin-0",
      adminEmail: null,
      action: "grant_admin",
      targetType: "user",
      targetId: "user-0",
      // no `before`, no `after`, no `createdAt`
    });

    const transported = await transportViaSerializer(
      await handler({ data: undefined, context: { user: ADMIN_USER } }),
    );

    expect(transported).toHaveLength(1);
    const entry = transported[0]!;
    expect(entry.adminUid).toBe("admin-0");
    expect(entry.action).toBe("grant_admin");
    expect(entry.targetType).toBe("user");
    expect(entry.targetId).toBe("user-0");
    expect(entry.createdAt).toBeNull();
    expect(entry.before).toBeNull();
    expect(entry.after).toBeNull();
    expect(blockedNetworkAttempts()).toEqual([]);
  });
});
