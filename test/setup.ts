/**
 * Shared Vitest setup for the ops portal test suite.
 *
 * Feature: admin-quality-gates-and-shared-contracts
 *
 * This file is wired as `setupFiles` in `vitest.config.ts`, so everything here
 * runs once per test file, before that file's tests.
 *
 * Sections (keep them separate — later tasks extend this file additively):
 *   1. NetworkAccessError               — the error every blocked request throws
 *   2. Target classification            — which hosts/URLs count as which service
 *   3. fetch guard                      — `vi.stubGlobal("fetch", ...)` + attempt log
 *   4. Per-test lifecycle               — install/reset hooks
 *   5. In-memory service doubles        — RESERVED for task 6.4 (Firestore,
 *      Firebase Auth, Remote Config, Go agent, audit log). Add them below the
 *      marker; nothing above needs to change.
 */
import { beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// 1. NetworkAccessError
// ---------------------------------------------------------------------------

/** Service categories the network guard recognises (Requirement 6.14). */
export type NetworkTargetCategory =
  | "firestore"
  | "firebase-auth"
  | "remote-config"
  | "go-agent"
  | "unclassified";

/**
 * Thrown when a test attempts an outbound request. The message names the
 * attempted target so the failing test says *what* it tried to reach
 * (Requirement 6.14).
 */
export class NetworkAccessError extends Error {
  override readonly name = "NetworkAccessError";

  /** The request target as the test presented it (URL string). */
  readonly target: string;

  /** Which guarded service the target was classified as. */
  readonly category: NetworkTargetCategory;

  constructor(target: string, category: NetworkTargetCategory) {
    super(
      `NetworkAccessError: blocked outbound request to ${category} target "${target}". ` +
      "Tests must use the in-memory doubles from test/setup.ts — no credential, " +
      "emulator, or deployed service may be reached.",
    );
    this.target = target;
    this.category = category;
  }
}

// ---------------------------------------------------------------------------
// 2. Target classification
// ---------------------------------------------------------------------------

/**
 * Host/URL fragments per guarded service, taken from the production call sites:
 *   - Firestore REST         → src/lib/firebase/firestore.server.ts
 *   - Firebase Auth          → src/lib/firebase/verify.server.ts (JWKS),
 *                              src/lib/admin/roles.server.ts (Identity Toolkit),
 *                              src/lib/firebase/credentials.server.ts (token mint)
 *   - Remote Config          → src/lib/firebase/remote_config.server.ts
 *   - Go agent               → src/lib/admin/goagent.server.ts (GO_AGENT_URL, Cloud Run)
 */
const GUARDED_TARGET_FRAGMENTS: ReadonlyArray<readonly [NetworkTargetCategory, string]> = [
  ["firestore", "firestore.googleapis.com"],
  ["firestore", "firestore.sandbox.googleapis.com"],
  ["firebase-auth", "identitytoolkit.googleapis.com"],
  ["firebase-auth", "securetoken.google.com"],
  ["firebase-auth", "securetoken.googleapis.com"],
  ["firebase-auth", "service_accounts/v1/jwk"],
  ["firebase-auth", "oauth2.googleapis.com"],
  ["remote-config", "firebaseremoteconfig.googleapis.com"],
  ["go-agent", ".run.app"],
];

function targetToString(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input && typeof input === "object" && "url" in input) {
    const { url } = input as { url: unknown };
    if (typeof url === "string") return url;
  }
  return String(input);
}

/**
 * Classify a request target. Returns the guarded category, or `"unclassified"`
 * for anything else — the guard blocks unclassified targets too, so a test can
 * never silently depend on the network.
 */
export function classifyNetworkTarget(input: unknown): NetworkTargetCategory {
  const target = targetToString(input).toLowerCase();
  for (const [category, fragment] of GUARDED_TARGET_FRAGMENTS) {
    if (target.includes(fragment)) return category;
  }
  const goAgentUrl = (process.env["GO_AGENT_URL"] ?? "").trim().toLowerCase();
  if (goAgentUrl.length > 0 && target.includes(goAgentUrl)) return "go-agent";
  return "unclassified";
}

// ---------------------------------------------------------------------------
// 3. fetch guard
// ---------------------------------------------------------------------------

export interface BlockedNetworkAttempt {
  target: string;
  category: NetworkTargetCategory;
}

const blockedAttempts: BlockedNetworkAttempt[] = [];

/** Every request the guard blocked since the last reset, in attempt order. */
export function blockedNetworkAttempts(): readonly BlockedNetworkAttempt[] {
  return blockedAttempts.slice();
}

/** Clear the recorded attempt log (called automatically before each test). */
export function clearBlockedNetworkAttempts(): void {
  blockedAttempts.length = 0;
}

/**
 * Install the `fetch` guard. Every call records the attempt and rejects with a
 * `NetworkAccessError` naming the target — the stub never returns a response,
 * so a test that reaches for the network fails rather than hanging.
 *
 * The guard rejects (rather than throwing synchronously) to match real `fetch`
 * semantics. Production call sites wrap `fetch` in try/catch, so a test that
 * needs to prove *no* request was attempted asserts on
 * `blockedNetworkAttempts()` instead of relying on the rejection propagating.
 */
export function installNetworkGuard(): void {
  vi.stubGlobal("fetch", async (input: unknown, ..._rest: unknown[]): Promise<never> => {
    const target = targetToString(input);
    const category = classifyNetworkTarget(input);
    blockedAttempts.push({ target, category });
    throw new NetworkAccessError(target, category);
  });
}

/** Restore the real `fetch` and clear the attempt log. */
export function resetNetworkGuard(): void {
  vi.unstubAllGlobals();
  clearBlockedNetworkAttempts();
}

// ---------------------------------------------------------------------------
// 4. Per-test lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearBlockedNetworkAttempts();
  installNetworkGuard();
});

afterEach(() => {
  resetNetworkGuard();
});

// ---------------------------------------------------------------------------
// 5. In-memory service doubles — added by task 6.4
//    (Firestore create/patch/get/query, Firebase Auth, Remote Config,
//     Go agent, audit log). Append below this marker.
// ---------------------------------------------------------------------------
// Usage pattern
// -------------
// Each double is a factory that returns the *module surface* it stands in for
// (typed as a `Pick<>` of the real module, so a signature change in `src/`
// breaks compilation here) plus an inspection handle. Nothing below installs a
// module mock: different test files mock different modules, so each test file
// opts in explicitly. The lazily created singletons at the bottom of this file
// exist so a hoisted `vi.mock` factory can reach the same instance the test
// body inspects:
//
//     import { describe, expect, it, vi } from "vitest";
//     import { firestoreDouble, auditDouble } from "./setup";
//
//     vi.mock("@/lib/firebase/firestore.server", async () => {
//       const { firestoreDouble } = await import("./setup");
//       return firestoreDouble().module;
//     });
//
//     it("writes nothing when the payload is invalid", async () => {
//       const { setFactStatus } = await import("@/lib/admin/content.server");
//       firestoreDouble().seed("fact_bank/abc", { status: "active" });
//       await expect(setFactStatus("abc", "nonsense")).rejects.toThrow();
//       expect(firestoreDouble().writeCount()).toBe(0);       // Requirement 6.4
//       expect(auditDouble().entries()).toHaveLength(0);      // Requirement 6.7
//       expect(blockedNetworkAttempts()).toEqual([]);         // Requirement 6.14
//     });
//
// A test that injects its dependency instead of mocking a module can use the
// `create*Double()` factory directly. Every double created either way is
// registered for automatic per-test reset (see the `beforeEach` at the end).

// --- Shared types, borrowed from the real modules -------------------------

type FirestoreModule = typeof import("@/lib/firebase/firestore.server");
type RolesModule = typeof import("@/lib/admin/roles.server");
type RemoteConfigModule = typeof import("@/lib/firebase/remote_config.server");
type GoAgentModule = typeof import("@/lib/admin/goagent.server");
type AuditModule = typeof import("@/lib/firebase/audit.server");

export type Json = import("@/lib/firebase/firestore.server").Json;
export type FirestoreDoc = import("@/lib/firebase/firestore.server").FirestoreDoc;
export type QueryFilter = import("@/lib/firebase/firestore.server").QueryFilter;
export type AdminUserRecord = import("@/lib/admin/roles.server").AdminUserRecord;
export type RemoteConfigCondition =
  import("@/lib/firebase/remote_config.server").RemoteConfigCondition;
export type RemoteConfigParameter =
  import("@/lib/firebase/remote_config.server").RemoteConfigParameter;
export type RemoteConfigTemplate =
  import("@/lib/firebase/remote_config.server").RemoteConfigTemplate;
export type TopicSuggestionConfig =
  import("@/lib/firebase/remote_config.server").TopicSuggestionConfig;
export type GoPackRequest = import("@/lib/admin/goagent.server").GoPackRequest;
export type GoPackResult = import("@/lib/admin/goagent.server").GoPackResult;
export type EditableRound = import("@/lib/admin/daily-blitz").EditableRound;
export type AdminUser = import("@/lib/firebase/verify.server").AdminUser;
export type AuditLogEntry = import("@/lib/firebase/audit.server").AuditLogEntry;
export type JsonValue = import("@/lib/firebase/audit.server").JsonValue;

// --- Reset registry ------------------------------------------------------

/** Every double exposes `reset()`, which the shared `beforeEach` calls. */
export interface ResettableDouble {
  reset(): void;
}

const registeredDoubles: ResettableDouble[] = [];

function registerDouble<T extends ResettableDouble>(double: T): T {
  registeredDoubles.push(double);
  return double;
}

/** Reset every double created in this test file (called before each test). */
export function resetAllDoubles(): void {
  for (const double of registeredDoubles) double.reset();
}

/**
 * A per-test-file lazy singleton. `test/setup.ts` is re-evaluated for every
 * test file, so each file gets its own instance and files cannot leak state
 * into one another.
 */
function lazySingleton<T extends ResettableDouble>(factory: () => T): () => T {
  let instance: T | null = null;
  return () => {
    if (instance === null) instance = factory();
    return instance;
  };
}

// --- Value plumbing shared by the Firestore + audit doubles ---------------

/**
 * Mirror of a `encodeFields` → `decodeFields` round trip: whatever a caller
 * hands the real client comes back out of Firestore as `Json`. `undefined`,
 * functions, symbols and bigints all encode as `nullValue`, so they read back
 * as `null`.
 */
export function toJson(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((entry) => toJson(entry));
  if (typeof value === "object") {
    const out: { [key: string]: Json } = {};
    for (const [key, entry] of Object.entries(value)) out[key] = toJson(entry);
    return out;
  }
  return null;
}

function toJsonRecord(data: Record<string, unknown>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [key, value] of Object.entries(data)) out[key] = toJson(value);
  return out;
}

function cloneJson(value: Json): Json {
  if (Array.isArray(value)) return value.map((entry) => cloneJson(entry));
  if (value !== null && typeof value === "object") {
    const out: { [key: string]: Json } = {};
    for (const [key, entry] of Object.entries(value)) out[key] = cloneJson(entry);
    return out;
  }
  return value;
}

function cloneJsonRecord(data: Record<string, Json>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [key, value] of Object.entries(data)) out[key] = cloneJson(value);
  return out;
}

/** Read a (possibly dotted) Firestore field path out of a decoded document. */
function readFieldPath(data: Record<string, Json>, fieldPath: string): Json {
  const segments = fieldPath.split(".");
  let current: Json = data;
  for (const segment of segments) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return null;
    current = current[segment] ?? null;
  }
  return current;
}

/**
 * Total ordering over `Json`, used for both filters and `orderBy`. Nulls sort
 * first (as they do in Firestore); anything not directly comparable falls back
 * to its string form, which is enough for the fixture data tests use.
 */
function compareJson(left: Json, right: Json): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  if (typeof left === "number" && typeof right === "number") {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return left === right ? 0 : left ? 1 : -1;
  }
  const a = typeof left === "string" ? left : JSON.stringify(left);
  const b = typeof right === "string" ? right : JSON.stringify(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

// --- 5a. Firestore double ------------------------------------------------

/** The `firestore.server` surface the double stands in for. */
export type FirestoreDoubleModule = Pick<
  FirestoreModule,
  | "createDoc"
  | "patchDoc"
  | "getDoc"
  | "listDocs"
  | "runQuery"
  | "deleteDoc"
  | "countCollection"
  | "factId"
  | "normalizeKey"
  | "isFirestoreIndexError"
>;

/** One recorded mutation. Read operations are recorded separately. */
export interface RecordedFirestoreWrite {
  kind: "create" | "patch" | "delete";
  path: string;
  collection?: string;
  documentId?: string;
  data?: Record<string, Json>;
  deletePaths?: string[];
}

export interface RecordedFirestoreRead {
  kind: "get" | "list" | "query" | "count";
  target: string;
}

export interface FirestoreDouble extends ResettableDouble {
  /** Hand this to a `vi.mock` factory for `@/lib/firebase/firestore.server`. */
  module: FirestoreDoubleModule;
  /** Seed a document at `collection/id` (no write is recorded). */
  seed(path: string, data: Record<string, unknown>): FirestoreDoc;
  /** Seed several documents at once. */
  seedMany(entries: Record<string, Record<string, unknown>>): void;
  /** Snapshot of every stored document, ordered by path. */
  documents(): readonly FirestoreDoc[];
  /** A single stored document, or null. */
  document(path: string): FirestoreDoc | null;
  /** Every mutation since the last reset, in call order. */
  writes(): readonly RecordedFirestoreWrite[];
  /** Number of mutations since the last reset (Requirement 6.4: assert 0). */
  writeCount(): number;
  /** Every read since the last reset, in call order. */
  reads(): readonly RecordedFirestoreRead[];
  /** Make the next mutation reject, mimicking a mid-batch Firestore failure. */
  failNextWrite(message?: string): void;
  reset(): void;
}

interface StoredDoc {
  data: Record<string, Json>;
  createTime: string;
  updateTime: string;
}

function inCollection(path: string, collection: string, allDescendants: boolean): boolean {
  const segments = path.split("/");
  if (segments.length < 2) return false;
  const parentPath = segments.slice(0, -1).join("/");
  if (parentPath === collection) return true;
  return allDescendants && segments[segments.length - 2] === collection;
}

function matchesFilter(data: Record<string, Json>, filter: QueryFilter): boolean {
  const actual = readFieldPath(data, filter.field);
  const expected = toJson(filter.value);
  switch (filter.op) {
    case "EQUAL":
      return compareJson(actual, expected) === 0;
    case "NOT_EQUAL":
      return compareJson(actual, expected) !== 0;
    case "LESS_THAN":
      return compareJson(actual, expected) < 0;
    case "LESS_THAN_OR_EQUAL":
      return compareJson(actual, expected) <= 0;
    case "GREATER_THAN":
      return compareJson(actual, expected) > 0;
    case "GREATER_THAN_OR_EQUAL":
      return compareJson(actual, expected) >= 0;
    case "ARRAY_CONTAINS":
      return (
        Array.isArray(actual) && actual.some((entry) => compareJson(entry, expected) === 0)
      );
  }
}

/**
 * In-memory stand-in for the Firestore REST client (Requirement 6.10).
 *
 * Semantics that matter for the mutation tests:
 *   - `createDoc` rejects on an existing id, the way the REST API returns 409.
 *   - `patchDoc` merges the supplied top-level fields, removes `deletePaths`,
 *     and upserts when the document is absent (matching REST `PATCH`).
 *   - `getDoc` resolves to null for a missing document rather than throwing.
 *   - `runQuery` applies filters, `orderBy`, `offset` and a default limit of 50.
 *   - Every stored value is a `Json` round trip of what the caller passed, so a
 *     test sees exactly what the real encoder/decoder pair would produce.
 */
export function createFirestoreDouble(): FirestoreDouble {
  const store = new Map<string, StoredDoc>();
  const writeLog: RecordedFirestoreWrite[] = [];
  const readLog: RecordedFirestoreRead[] = [];
  const pendingWriteFailures: string[] = [];
  let clock = 0;

  function nextTimestamp(): string {
    clock += 1;
    return new Date(Date.UTC(2024, 0, 1, 0, 0, 0, 0) + clock).toISOString();
  }

  function toFirestoreDoc(path: string, stored: StoredDoc): FirestoreDoc {
    return {
      id: path.split("/").pop() ?? path,
      path,
      data: cloneJsonRecord(stored.data),
      createTime: stored.createTime,
      updateTime: stored.updateTime,
    };
  }

  function assertWriteAllowed(): void {
    const failure = pendingWriteFailures.shift();
    if (failure !== undefined) throw new Error(failure);
  }

  function put(path: string, data: Record<string, unknown>): FirestoreDoc {
    const timestamp = nextTimestamp();
    const existing = store.get(path);
    const stored: StoredDoc = {
      data: toJsonRecord(data),
      createTime: existing?.createTime ?? timestamp,
      updateTime: timestamp,
    };
    store.set(path, stored);
    return toFirestoreDoc(path, stored);
  }

  function matchingDocs(options: {
    collection: string;
    allDescendants?: boolean;
    filters?: QueryFilter[];
  }): { path: string; stored: StoredDoc }[] {
    const filters = options.filters ?? [];
    return Array.from(store.entries())
      .filter(([path]) => inCollection(path, options.collection, options.allDescendants === true))
      .filter(([, stored]) => filters.every((filter) => matchesFilter(stored.data, filter)))
      .map(([path, stored]) => ({ path, stored }));
  }

  const module: FirestoreDoubleModule = {
    createDoc: async (collection, documentId, data) => {
      assertWriteAllowed();
      const path = `${collection}/${documentId}`;
      if (store.has(path)) {
        throw new Error(`Firestore request failed (409): Document already exists: ${path}`);
      }
      writeLog.push({
        kind: "create",
        path,
        collection,
        documentId,
        data: toJsonRecord(data),
      });
      return put(path, data);
    },

    patchDoc: async (path, data, deletePaths) => {
      assertWriteAllowed();
      const existing = store.get(path);
      const merged: Record<string, unknown> = { ...(existing?.data ?? {}), ...data };
      for (const key of deletePaths ?? []) delete merged[key];
      writeLog.push({
        kind: "patch",
        path,
        data: toJsonRecord(data),
        ...(deletePaths ? { deletePaths: deletePaths.slice() } : {}),
      });
      return put(path, merged);
    },

    deleteDoc: async (path, precondition) => {
      assertWriteAllowed();
      const normalized = path.replace(/^\//, "");
      const exists = store.has(normalized);
      if (precondition?.exists === true && !exists) {
        throw new Error(`Firestore request failed (404): Document does not exist: ${normalized}`);
      }
      if (precondition?.exists === false && exists) {
        throw new Error(`Firestore request failed (409): Document already exists: ${normalized}`);
      }
      writeLog.push({ kind: "delete", path: normalized });
      store.delete(normalized);
    },

    getDoc: async (path) => {
      readLog.push({ kind: "get", target: path });
      const stored = store.get(path);
      return stored ? toFirestoreDoc(path, stored) : null;
    },

    listDocs: async (collection, options = {}) => {
      readLog.push({ kind: "list", target: collection });
      const orderBy = options.orderBy;
      const docs = matchingDocs({ collection })
        .sort((left, right) =>
          orderBy
            ? compareJson(
              readFieldPath(left.stored.data, orderBy),
              readFieldPath(right.stored.data, orderBy),
            )
            : compareJson(left.path, right.path),
        )
        .slice(0, options.pageSize ?? 50)
        .map(({ path, stored }) => toFirestoreDoc(path, stored));
      return { docs };
    },

    runQuery: async (options) => {
      readLog.push({ kind: "query", target: options.collection });
      const orderBy = options.orderBy;
      const ordered = matchingDocs(options).sort((left, right) => {
        if (!orderBy) return compareJson(left.path, right.path);
        const direction = orderBy.direction === "DESCENDING" ? -1 : 1;
        return (
          direction *
          compareJson(
            readFieldPath(left.stored.data, orderBy.field),
            readFieldPath(right.stored.data, orderBy.field),
          )
        );
      });
      const offset = options.offset ?? 0;
      return ordered
        .slice(offset, offset + (options.limit ?? 50))
        .map(({ path, stored }) => toFirestoreDoc(path, stored));
    },

    countCollection: async (collection, filters = [], options) => {
      readLog.push({ kind: "count", target: collection });
      return matchingDocs({
        collection,
        filters,
        ...(options?.allDescendants ? { allDescendants: true } : {}),
      }).length;
    },

    // The real implementations are pure, so the double reuses their behaviour
    // verbatim rather than approximating it.
    factId: async (subjectKey, angleKey) => {
      const digest = await crypto.subtle.digest(
        "SHA-1",
        new TextEncoder().encode(`${subjectKey}|${angleKey}`),
      );
      return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 16);
    },

    normalizeKey: (value) =>
      value
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, ""),

    isFirestoreIndexError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      return /FAILED_PRECONDITION|requires an index|requires additional indexing|COLLECTION_GROUP/i.test(
        message,
      );
    },
  };

  return registerDouble({
    module,
    seed: (path, data) => put(path, data),
    seedMany: (entries) => {
      for (const [path, data] of Object.entries(entries)) put(path, data);
    },
    documents: () =>
      Array.from(store.entries())
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([path, stored]) => toFirestoreDoc(path, stored)),
    document: (path) => {
      const stored = store.get(path);
      return stored ? toFirestoreDoc(path, stored) : null;
    },
    writes: () => writeLog.slice(),
    writeCount: () => writeLog.length,
    reads: () => readLog.slice(),
    failNextWrite: (message = "Firestore request failed (500): injected test failure") => {
      pendingWriteFailures.push(message);
    },
    reset: () => {
      store.clear();
      writeLog.length = 0;
      readLog.length = 0;
      pendingWriteFailures.length = 0;
      clock = 0;
    },
  });
}

// --- 5b. Audit log double ------------------------------------------------

/** The `audit.server` surface the double stands in for. */
export type AuditDoubleModule = Pick<AuditModule, "logAdminAction" | "listAuditLogs">;

/** A recorded entry: the persisted shape plus the admin who triggered it. */
export interface RecordedAuditEntry extends AuditLogEntry {
  id: string;
  createdAt: string;
}

export interface AuditDouble extends ResettableDouble {
  /** Hand this to a `vi.mock` factory for `@/lib/firebase/audit.server`. */
  module: AuditDoubleModule;
  /** Every entry recorded since the last reset, in call order. */
  entries(): readonly RecordedAuditEntry[];
  /** Entry count — Requirement 6.7 asserts exactly one per privileged mutation. */
  entryCount(): number;
  /** Make the next `logAdminAction` call reject. */
  failNextLog(message?: string): void;
  reset(): void;
}

/**
 * In-memory stand-in for the admin audit log (Requirements 6.7, 6.10). Entries
 * carry the same fields `logAdminAction` persists, so a test can assert on
 * `action`, `targetType` and `targetId` directly.
 */
export function createAuditDouble(): AuditDouble {
  const entries: RecordedAuditEntry[] = [];
  const pendingFailures: string[] = [];
  let sequence = 0;

  const module: AuditDoubleModule = {
    logAdminAction: async (adminUser, entry) => {
      const failure = pendingFailures.shift();
      if (failure !== undefined) throw new Error(failure);
      sequence += 1;
      entries.push({
        id: `audit_${String(sequence).padStart(4, "0")}`,
        adminUid: adminUser.uid,
        adminEmail: adminUser.email,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        details: entry.details ?? undefined,
        before: toJson(entry.before ?? null),
        after: toJson(entry.after ?? null),
        createdAt: new Date(Date.UTC(2024, 0, 1, 0, 0, 0, 0) + sequence).toISOString(),
      });
    },

    // Newest first, matching the real `createdAt DESCENDING` query.
    listAuditLogs: async (limitCount = 100) => entries.slice().reverse().slice(0, limitCount),
  };

  return registerDouble({
    module,
    entries: () => entries.slice(),
    entryCount: () => entries.length,
    failNextLog: (message = "audit log write failed") => {
      pendingFailures.push(message);
    },
    reset: () => {
      entries.length = 0;
      pendingFailures.length = 0;
      sequence = 0;
    },
  });
}

// --- 5c. Firebase Auth double -------------------------------------------

/** The `roles.server` surface the double stands in for. */
export type FirebaseAuthDoubleModule = Pick<RolesModule, "listAuthUsers" | "setAdminClaim">;

export interface RecordedClaimChange {
  uid: string;
  admin: boolean;
}

export interface FirebaseAuthDouble extends ResettableDouble {
  /** Hand this to a `vi.mock` factory for `@/lib/admin/roles.server`. */
  module: FirebaseAuthDoubleModule;
  /** Seed one Firebase Auth user; unspecified fields take neutral defaults. */
  seedUser(user: Partial<AdminUserRecord> & { uid: string }): AdminUserRecord;
  /** Snapshot of every seeded user, keyed insertion order. */
  users(): readonly AdminUserRecord[];
  /** Every admin-claim mutation since the last reset, in call order. */
  claimChanges(): readonly RecordedClaimChange[];
  /** Make the next `setAdminClaim` call reject. */
  failNextClaimChange(message?: string): void;
  reset(): void;
}

/**
 * In-memory stand-in for the Identity Toolkit calls in `roles.server`
 * (Requirement 6.10). `listAuthUsers` reproduces the real deduplication —
 * one record per email address, preferring the admin record and then the most
 * recent sign-in, newest `createdAt` first.
 */
export function createFirebaseAuthDouble(): FirebaseAuthDouble {
  const users = new Map<string, AdminUserRecord>();
  const claimChanges: RecordedClaimChange[] = [];
  const pendingFailures: string[] = [];

  const module: FirebaseAuthDoubleModule = {
    listAuthUsers: async () => {
      const byEmail = new Map<string, AdminUserRecord[]>();
      const noEmail: AdminUserRecord[] = [];
      for (const user of users.values()) {
        const key = user.email?.toLowerCase() ?? "";
        if (!key) {
          noEmail.push(user);
          continue;
        }
        const group = byEmail.get(key) ?? [];
        group.push(user);
        byEmail.set(key, group);
      }
      const deduped: AdminUserRecord[] = [];
      for (const group of byEmail.values()) {
        const canonical =
          group.find((user) => user.isAdmin) ??
          group
            .slice()
            .sort((a, b) => (b.lastSignInAt ?? "").localeCompare(a.lastSignInAt ?? ""))[0];
        deduped.push({ ...canonical });
      }
      for (const user of noEmail) deduped.push({ ...user });
      deduped.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
      return deduped;
    },

    setAdminClaim: async (uid, admin, entitlementsWriter) => {
      const failure = pendingFailures.shift();
      if (failure !== undefined) throw new Error(failure);
      const current = users.get(uid);
      if (!current) throw new Error("User not found");
      const updated: AdminUserRecord = { ...current, isAdmin: admin };
      users.set(uid, updated);
      claimChanges.push({ uid, admin });
      if (current.email && entitlementsWriter) {
        await entitlementsWriter(current.email.toLowerCase(), admin);
      }
      return { ...updated };
    },
  };

  return registerDouble({
    module,
    seedUser: (user) => {
      const record: AdminUserRecord = {
        uid: user.uid,
        email: user.email ?? null,
        displayName: user.displayName ?? null,
        emailVerified: user.emailVerified ?? false,
        disabled: user.disabled ?? false,
        isAdmin: user.isAdmin ?? false,
        mfaEnrolled: user.mfaEnrolled ?? false,
        createdAt: user.createdAt ?? null,
        lastSignInAt: user.lastSignInAt ?? null,
      };
      users.set(record.uid, record);
      return { ...record };
    },
    users: () => Array.from(users.values()).map((user) => ({ ...user })),
    claimChanges: () => claimChanges.slice(),
    failNextClaimChange: (message = "Identity Toolkit request failed (500): injected test failure") => {
      pendingFailures.push(message);
    },
    reset: () => {
      users.clear();
      claimChanges.length = 0;
      pendingFailures.length = 0;
    },
  });
}

// --- 5d. Remote Config double -------------------------------------------

/** The `remote_config.server` surface the double stands in for. */
export type RemoteConfigDoubleModule = Pick<
  RemoteConfigModule,
  "getRemoteConfigTemplate" | "getTopicSuggestionsConfig" | "publishTopicSuggestionsConfig"
>;

export interface RecordedRemoteConfigPublish {
  defaultTopics: string[];
  variants: { conditionName: string; expression: string; tagColor: string; topics: string[] }[];
  etag: string;
  userEmail?: string;
}

export interface RemoteConfigDouble extends ResettableDouble {
  /** Hand this to a `vi.mock` factory for `@/lib/firebase/remote_config.server`. */
  module: RemoteConfigDoubleModule;
  /** Replace a parameter in the stored template. */
  seedParameter(key: string, parameter: RemoteConfigParameter): void;
  /** Replace the stored conditions. */
  seedConditions(conditions: RemoteConfigCondition[]): void;
  /** Seed the topic-suggestions parameter + matching conditions in one call. */
  seedTopicSuggestions(config: {
    defaultTopics: string[];
    variants: { conditionName: string; expression: string; tagColor?: string; topics: string[] }[];
  }): void;
  /** The ETag a caller must present to publish. */
  etag(): string;
  /** Every publish since the last reset, in call order. */
  publishes(): readonly RecordedRemoteConfigPublish[];
  /** Make the next publish reject (e.g. to exercise the conflict path). */
  failNextPublish(message?: string): void;
  reset(): void;
}

const TOPIC_SUGGESTIONS_PARAM = "custom_topic_suggestions";

function parseTopicList(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean);
  } catch {
    /* fall through to the comma-separated form the real client also accepts */
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function copyParameter(parameter: RemoteConfigParameter): RemoteConfigParameter {
  const conditionalValues = parameter.conditionalValues
    ? Object.fromEntries(
      Object.entries(parameter.conditionalValues).map(([name, value]) => [name, { ...value }]),
    )
    : undefined;
  return {
    ...parameter,
    ...(parameter.defaultValue ? { defaultValue: { ...parameter.defaultValue } } : {}),
    ...(conditionalValues ? { conditionalValues } : {}),
  };
}

/**
 * In-memory stand-in for the Remote Config REST client (Requirement 6.10).
 * Holds one template, hands out a fresh copy on every read, and enforces the
 * ETag precondition on publish (`"*"` matches anything, as it does upstream).
 */
export function createRemoteConfigDouble(): RemoteConfigDouble {
  interface State {
    parameters: Record<string, RemoteConfigParameter>;
    conditions: RemoteConfigCondition[];
    parameterGroups: Record<string, unknown>;
    versionNumber: number;
    updateTime: string;
    updateUserEmail: string | null;
  }

  const initialState = (): State => ({
    parameters: {},
    conditions: [],
    parameterGroups: {},
    versionNumber: 1,
    updateTime: new Date(Date.UTC(2024, 0, 1)).toISOString(),
    updateUserEmail: null,
  });

  let state: State = initialState();
  const publishes: RecordedRemoteConfigPublish[] = [];
  const pendingFailures: string[] = [];

  function currentEtag(): string {
    return `etag-${state.versionNumber}`;
  }

  function snapshot(): RemoteConfigTemplate {
    return {
      parameters: Object.fromEntries(
        Object.entries(state.parameters).map(([key, value]) => [key, copyParameter(value)]),
      ),
      conditions: state.conditions.map((condition) => ({ ...condition })),
      parameterGroups: { ...state.parameterGroups },
      version: {
        versionNumber: String(state.versionNumber),
        updateTime: state.updateTime,
        ...(state.updateUserEmail ? { updateUser: { email: state.updateUserEmail } } : {}),
      },
      etag: currentEtag(),
    };
  }

  function applyTopicSuggestions(config: {
    defaultTopics: string[];
    variants: { conditionName: string; expression: string; tagColor?: string; topics: string[] }[];
    enableInterstitialAds?: boolean;
    interstitialAdFrequency?: number;
    enableRewardedAds?: boolean;
    enableBannerAds?: boolean;
    allowedEmails?: string[];
    customParameters?: Record<string, import("@/lib/firebase/remote_config.server").CustomParamEntry>;
  }): void {
    const priorConditionNames = new Set(
      Object.keys(state.parameters[TOPIC_SUGGESTIONS_PARAM]?.conditionalValues ?? {}),
    );
    const conditionalValues: Record<string, { value: string }> = {};
    const newConditionNames = new Set<string>();
    for (const variant of config.variants) {
      conditionalValues[variant.conditionName] = { value: JSON.stringify(variant.topics) };
      newConditionNames.add(variant.conditionName);
    }
    state.parameters[TOPIC_SUGGESTIONS_PARAM] = {
      ...state.parameters[TOPIC_SUGGESTIONS_PARAM],
      defaultValue: { value: JSON.stringify(config.defaultTopics) },
      ...(Object.keys(conditionalValues).length > 0 ? { conditionalValues } : {}),
      description: "Rotating custom topic suggestions on solo config screen",
      valueType: "JSON",
    };
    if (config.enableInterstitialAds !== undefined) {
      state.parameters["enable_interstitial_ads"] = {
        defaultValue: { value: String(config.enableInterstitialAds) },
        valueType: "BOOLEAN",
      };
    }
    if (config.interstitialAdFrequency !== undefined) {
      state.parameters["interstitial_ad_frequency_rounds"] = {
        defaultValue: { value: String(config.interstitialAdFrequency) },
        valueType: "NUMBER",
      };
    }
    if (config.enableRewardedAds !== undefined) {
      state.parameters["enable_rewarded_ads"] = {
        defaultValue: { value: String(config.enableRewardedAds) },
        valueType: "BOOLEAN",
      };
    }
    if (config.enableBannerAds !== undefined) {
      state.parameters["enable_banner_ads"] = {
        defaultValue: { value: String(config.enableBannerAds) },
        valueType: "BOOLEAN",
      };
    }
    if (config.allowedEmails !== undefined) {
      state.parameters["allowed_emails"] = {
        defaultValue: { value: config.allowedEmails.join(",") },
        valueType: "STRING",
      };
    }
    if (config.customParameters !== undefined) {
      for (const [k, v] of Object.entries(config.customParameters)) {
        state.parameters[k] = {
          defaultValue: { value: v.value },
          valueType: v.valueType ?? "STRING",
          description: v.description,
        };
      }
    }
    const preserved = state.conditions.filter(
      (condition) =>
        !newConditionNames.has(condition.name) && !priorConditionNames.has(condition.name),
    );
    state.conditions = [
      ...preserved,
      ...config.variants.map((variant) => ({
        name: variant.conditionName,
        expression: variant.expression,
        tagColor: variant.tagColor ?? "BLUE",
      })),
    ];
  }

  const module: RemoteConfigDoubleModule = {
    getRemoteConfigTemplate: async () => snapshot(),

    getTopicSuggestionsConfig: async () => {
      const template = snapshot();
      const parameter = template.parameters?.[TOPIC_SUGGESTIONS_PARAM];
      const conditions = new Map(
        (template.conditions ?? []).map((condition) => [condition.name, condition]),
      );
      const variants: TopicSuggestionConfig["variants"] = [];
      for (const [name, value] of Object.entries(parameter?.conditionalValues ?? {})) {
        const condition = conditions.get(name);
        variants.push({
          conditionName: name,
          expression: condition?.expression ?? "",
          tagColor: condition?.tagColor ?? "BLUE",
          topics: parseTopicList(value?.value),
        });
      }

      const enableInterstitialAds =
        template.parameters?.["enable_interstitial_ads"]?.defaultValue?.value === "true";
      const rawFreq = template.parameters?.["interstitial_ad_frequency_rounds"]?.defaultValue?.value;
      const interstitialAdFrequency = rawFreq ? Math.max(1, parseInt(rawFreq, 10) || 3) : 3;
      const rawRewarded = template.parameters?.["enable_rewarded_ads"]?.defaultValue?.value;
      const enableRewardedAds = rawRewarded !== undefined ? rawRewarded === "true" : true;
      const enableBannerAds =
        template.parameters?.["enable_banner_ads"]?.defaultValue?.value === "true";
      const rawAllowed = template.parameters?.["allowed_emails"]?.defaultValue?.value ?? "";
      const allowedEmails = rawAllowed ? rawAllowed.split(/[\s,]+/).filter(Boolean) : [];
      const customParameters: Record<string, import("@/lib/firebase/remote_config.server").CustomParamEntry> = {};
      const knownKeys = new Set([
        TOPIC_SUGGESTIONS_PARAM,
        "enable_interstitial_ads",
        "interstitial_ad_frequency_rounds",
        "enable_rewarded_ads",
        "enable_banner_ads",
        "allowed_emails",
      ]);
      for (const [key, p] of Object.entries(template.parameters ?? {})) {
        if (!knownKeys.has(key)) {
          customParameters[key] = {
            value: p.defaultValue?.value ?? "",
            valueType: p.valueType,
            description: p.description,
          };
        }
      }

      return {
        defaultTopics: parseTopicList(parameter?.defaultValue?.value),
        variants,
        enableInterstitialAds,
        interstitialAdFrequency,
        enableRewardedAds,
        enableBannerAds,
        allowedEmails,
        customParameters,
        etag: template.etag,
        versionNumber: template.version?.versionNumber,
        updatedAt: template.version?.updateTime,
        updatedBy: template.version?.updateUser?.email,
      };
    },

    publishTopicSuggestionsConfig: async (newConfig, etag, userEmail) => {
      const failure = pendingFailures.shift();
      if (failure !== undefined) throw new Error(failure);
      const presented = etag || "*";
      if (presented !== "*" && presented !== currentEtag()) {
        throw new Error(
          `Failed to publish Remote Config (409): ETag mismatch (presented ${presented}, current ${currentEtag()})`,
        );
      }
      applyTopicSuggestions(newConfig);
      state.versionNumber += 1;
      state.updateTime = new Date(
        Date.UTC(2024, 0, 1) + state.versionNumber * 1000,
      ).toISOString();
      state.updateUserEmail = userEmail ?? null;
      const variants = newConfig.variants.map((variant) => ({
        conditionName: variant.conditionName,
        expression: variant.expression,
        tagColor: variant.tagColor ?? "BLUE",
        topics: variant.topics.slice(),
      }));
      publishes.push({
        defaultTopics: newConfig.defaultTopics.slice(),
        variants,
        etag: currentEtag(),
        ...(userEmail ? { userEmail } : {}),
      });

      const customParameters: Record<string, import("@/lib/firebase/remote_config.server").CustomParamEntry> = {};
      if (newConfig.customParameters) {
        for (const [k, v] of Object.entries(newConfig.customParameters)) {
          customParameters[k] = { ...v };
        }
      }

      return {
        defaultTopics: newConfig.defaultTopics.slice(),
        variants,
        enableInterstitialAds:
          newConfig.enableInterstitialAds ??
          (state.parameters["enable_interstitial_ads"]?.defaultValue?.value === "true"),
        interstitialAdFrequency:
          newConfig.interstitialAdFrequency ??
          (parseInt(state.parameters["interstitial_ad_frequency_rounds"]?.defaultValue?.value ?? "3", 10) || 3),
        enableRewardedAds:
          newConfig.enableRewardedAds ??
          (state.parameters["enable_rewarded_ads"]?.defaultValue?.value !== "false"),
        enableBannerAds:
          newConfig.enableBannerAds ??
          (state.parameters["enable_banner_ads"]?.defaultValue?.value === "true"),
        allowedEmails:
          newConfig.allowedEmails ??
          (state.parameters["allowed_emails"]?.defaultValue?.value ?? "").split(/[\s,]+/).filter(Boolean),
        customParameters,
        etag: currentEtag(),
        versionNumber: String(state.versionNumber),
        updatedAt: state.updateTime,
        updatedBy: userEmail ?? undefined,
      };
    },
  };

  return registerDouble({
    module,
    seedParameter: (key, parameter) => {
      state.parameters[key] = copyParameter(parameter);
    },
    seedConditions: (conditions) => {
      state.conditions = conditions.map((condition) => ({ ...condition }));
    },
    seedTopicSuggestions: (config) => applyTopicSuggestions(config),
    etag: () => currentEtag(),
    publishes: () => publishes.slice(),
    failNextPublish: (message = "Failed to publish Remote Config (500): injected test failure") => {
      pendingFailures.push(message);
    },
    reset: () => {
      state = initialState();
      publishes.length = 0;
      pendingFailures.length = 0;
    },
  });
}

// --- 5e. Go agent double -------------------------------------------------

/** The `goagent.server` surface the double stands in for. */
export type GoAgentDoubleModule = Pick<GoAgentModule, "goAgentConfigured" | "generatePackViaGoAgent">;

export interface GoAgentDouble extends ResettableDouble {
  /** Hand this to a `vi.mock` factory for `@/lib/admin/goagent.server`. */
  module: GoAgentDoubleModule;
  /** Toggle what `goAgentConfigured()` reports (default: true). */
  setConfigured(configured: boolean): void;
  /** Override the pack the double returns for every subsequent call. */
  setPackResult(result: Partial<GoPackResult>): void;
  /** Make the next `generatePackViaGoAgent` call reject. */
  failNextPack(message?: string): void;
  /** Every pack request since the last reset, in call order. */
  requests(): readonly GoPackRequest[];
  reset(): void;
}

/** Deterministic filler round, so a stubbed pack is a valid `EditableRound[]`. */
function stubRound(roundNumber: number, topic: string): EditableRound {
  return {
    round_number: roundNumber,
    topic,
    claim_statement: `Stub claim ${roundNumber} about ${topic}`,
    presented_number: roundNumber * 10,
    true_number: roundNumber * 10 + 5,
    unit: "items",
    correct_direction: "MORE",
    explanation: `Stub explanation ${roundNumber}.`,
    surprise_factor: 1,
    difficulty: "casual",
  };
}

/**
 * In-memory stand-in for the Cloud Run Go agent (Requirement 6.10). No OIDC
 * token is minted and no request leaves the process; the double records what a
 * caller asked for and returns a deterministic, schema-valid pack.
 */
export function createGoAgentDouble(): GoAgentDouble {
  const requests: GoPackRequest[] = [];
  const pendingFailures: string[] = [];
  let configured = true;
  let override: Partial<GoPackResult> | null = null;

  const module: GoAgentDoubleModule = {
    goAgentConfigured: () => configured,

    generatePackViaGoAgent: async (input) => {
      const topic = input.topic.trim();
      if (!topic) throw new Error("Topic is required for a Go agent draft.");
      requests.push({ ...input });
      const failure = pendingFailures.shift();
      if (failure !== undefined) throw new Error(failure);
      const numRounds = Math.min(15, Math.max(1, input.numRounds ?? 15));
      const rounds =
        override?.rounds ??
        Array.from({ length: numRounds }, (_, index) => stubRound(index + 1, topic));
      return {
        category: override?.category ?? topic,
        status_message: override?.status_message ?? `Drafted ${rounds.length} DDM-gated rounds.`,
        is_valid: override?.is_valid ?? true,
        rounds,
      };
    },
  };

  return registerDouble({
    module,
    setConfigured: (value) => {
      configured = value;
    },
    setPackResult: (result) => {
      override = { ...result };
    },
    failNextPack: (message = "Go agent /pack failed (500): injected test failure") => {
      pendingFailures.push(message);
    },
    requests: () => requests.slice(),
    reset: () => {
      requests.length = 0;
      pendingFailures.length = 0;
      configured = true;
      override = null;
    },
  });
}

// --- 5f. Per-test-file singletons + reset hook ---------------------------

/** Firestore double shared by a test file's `vi.mock` factory and its tests. */
export const firestoreDouble = lazySingleton(createFirestoreDouble);
/** Audit-log double shared by a test file's `vi.mock` factory and its tests. */
export const auditDouble = lazySingleton(createAuditDouble);
/** Firebase Auth double shared by a test file's `vi.mock` factory and its tests. */
export const firebaseAuthDouble = lazySingleton(createFirebaseAuthDouble);
/** Remote Config double shared by a test file's `vi.mock` factory and its tests. */
export const remoteConfigDouble = lazySingleton(createRemoteConfigDouble);
/** Go agent double shared by a test file's `vi.mock` factory and its tests. */
export const goAgentDouble = lazySingleton(createGoAgentDouble);

// Every double is empty at the start of each test, so seeded documents,
// recorded writes and recorded audit entries never leak between tests.
beforeEach(() => {
  resetAllDoubles();
});
