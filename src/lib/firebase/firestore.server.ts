/**
 * Thin Firestore REST client for the admin portal.
 *
 * Uses the REST API rather than firebase-admin because the app's server
 * runtime is a Cloudflare Worker (no native Node modules).
 */
import { getAccessToken, getServiceAccount } from "./credentials.server";
import { forwardAuditEntries, isAuditPath } from "@/lib/analytics/audit-amplitude.server";

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface FirestoreValue {
  [key: string]: unknown;
}

export interface FirestoreDoc {
  id: string;
  path: string;
  data: Record<string, Json>;
  createTime?: string;
  updateTime?: string;
}

const TIMESTAMP_KEYS = new Set([
  "verified_at",
  "last_served_at",
  "createdAt",
  "created_at",
  "last_crawled_at",
  "enqueued_at",
  "completed_at",
  "startedAt",
  "endedAt",
  "updated_at",
  "resolved_at",
  "playedAt",
  "draftedAt",
]);

/**
 * Builds the base URL for the configured Firestore database's document API.
 *
 * @returns The Firestore REST document endpoint URL.
 */
function baseUrl(): string {
  const { project_id } = getServiceAccount();
  return `https://firestore.googleapis.com/v1/projects/${project_id}/databases/(default)/documents`;
}

export function decodeValue(value: FirestoreValue | undefined): Json {
  if (!value) return null;
  if ("nullValue" in value) return null;
  if ("stringValue" in value) return value["stringValue"] as string;
  if ("booleanValue" in value) return value["booleanValue"] as boolean;
  if ("integerValue" in value) return Number(value["integerValue"]);
  if ("doubleValue" in value) return value["doubleValue"] as number;
  if ("timestampValue" in value) return value["timestampValue"] as string;
  if ("referenceValue" in value) return value["referenceValue"] as string;
  if ("bytesValue" in value) return value["bytesValue"] as string;
  if ("geoPointValue" in value) return value["geoPointValue"] as Json;
  if ("arrayValue" in value) {
    const arr = (value["arrayValue"] as { values?: FirestoreValue[] }).values ?? [];
    return arr.map((entry) => decodeValue(entry));
  }
  if ("mapValue" in value) {
    const fields = (value["mapValue"] as { fields?: Record<string, FirestoreValue> }).fields ?? {};
    return decodeFields(fields);
  }
  return null;
}

export function decodeFields(fields: Record<string, FirestoreValue>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [key, value] of Object.entries(fields)) out[key] = decodeValue(value);
  return out;
}

export function encodeValue(value: unknown, key?: string): FirestoreValue {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === "string") {
    if (key && TIMESTAMP_KEYS.has(key) && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
      return { timestampValue: value };
    }
    return { stringValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map((entry) => encodeValue(entry)) } };
  }
  if (typeof value === "object") {
    return { mapValue: { fields: encodeFields(value as Record<string, unknown>) } };
  }
  return { nullValue: null };
}

export function encodeFields(data: Record<string, unknown>): Record<string, FirestoreValue> {
  const out: Record<string, FirestoreValue> = {};
  for (const [key, value] of Object.entries(data)) out[key] = encodeValue(value, key);
  return out;
}

function toDoc(raw: { name: string; fields?: Record<string, FirestoreValue>; createTime?: string; updateTime?: string }): FirestoreDoc {
  const path = raw.name.split("/documents/")[1] ?? raw.name;
  return {
    id: path.split("/").pop() ?? path,
    path,
    data: decodeFields(raw.fields ?? {}),
    createTime: raw.createTime,
    updateTime: raw.updateTime,
  };
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken();
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try {
      const parsed = JSON.parse(text) as {
        error?: { message?: string; status?: string };
      };
      const detail = parsed.error?.message ?? text;
      message = parsed.error?.status ? `${parsed.error.status}: ${detail}` : detail;
    } catch {
      /* keep raw text */
    }
    throw new Error(`Firestore request failed (${response.status}): ${message}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export function isFirestoreIndexError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /FAILED_PRECONDITION|requires an index|requires additional indexing|COLLECTION_GROUP/i.test(
    message,
  );
}

export async function getDoc(path: string): Promise<FirestoreDoc | null> {
  try {
    const raw = await request<Parameters<typeof toDoc>[0]>(`${baseUrl()}/${path}`);
    return toDoc(raw);
  } catch (error) {
    if (error instanceof Error && /\(404\)/.test(error.message)) return null;
    throw error;
  }
}

export async function listDocs(
  collection: string,
  options: { pageSize?: number; pageToken?: string; orderBy?: string } = {},
): Promise<{ docs: FirestoreDoc[]; nextPageToken?: string }> {
  const params = new URLSearchParams({ pageSize: String(options.pageSize ?? 50) });
  if (options.pageToken) params.set("pageToken", options.pageToken);
  if (options.orderBy) params.set("orderBy", options.orderBy);
  const raw = await request<{
    documents?: Parameters<typeof toDoc>[0][];
    nextPageToken?: string;
  }>(`${baseUrl()}/${collection}?${params.toString()}`);
  return { docs: (raw.documents ?? []).map(toDoc), nextPageToken: raw.nextPageToken };
}

export interface QueryFilter {
  field: string;
  op:
    | "EQUAL"
    | "NOT_EQUAL"
    | "LESS_THAN"
    | "LESS_THAN_OR_EQUAL"
    | "GREATER_THAN"
    | "GREATER_THAN_OR_EQUAL"
    | "ARRAY_CONTAINS";
  value: unknown;
}

export async function runQuery(options: {
  collection: string;
  allDescendants?: boolean;
  filters?: QueryFilter[];
  orderBy?: { field: string; direction?: "ASCENDING" | "DESCENDING" };
  limit?: number;
  offset?: number;
}): Promise<FirestoreDoc[]> {
  const filters = options.filters ?? [];
  const structuredQuery: Record<string, unknown> = {
    from: [
      {
        collectionId: options.collection,
        ...(options.allDescendants ? { allDescendants: true } : {}),
      },
    ],
    limit: options.limit ?? 50,
  };
  if (options.offset) structuredQuery["offset"] = options.offset;
  if (filters.length === 1) {
    structuredQuery["where"] = {
      fieldFilter: {
        field: { fieldPath: filters[0].field },
        op: filters[0].op,
        value: encodeValue(filters[0].value, filters[0].field),
      },
    };
  } else if (filters.length > 1) {
    structuredQuery["where"] = {
      compositeFilter: {
        op: "AND",
        filters: filters.map((filter) => ({
          fieldFilter: {
            field: { fieldPath: filter.field },
            op: filter.op,
            value: encodeValue(filter.value, filter.field),
          },
        })),
      },
    };
  }
  if (options.orderBy) {
    structuredQuery["orderBy"] = [
      {
        field: { fieldPath: options.orderBy.field },
        direction: options.orderBy.direction ?? "ASCENDING",
      },
    ];
  }

  const raw = await request<{ document?: Parameters<typeof toDoc>[0] }[]>(
    `${baseUrl()}:runQuery`,
    { method: "POST", body: JSON.stringify({ structuredQuery }) },
  );
  return raw.filter((entry) => entry.document).map((entry) => toDoc(entry.document!));
}

/** Patch a subset of fields on an existing document. Paths listed in
 * `deletePaths` are added to the update mask but omitted from the body,
 * which deletes them from the document. */
export async function patchDoc(
  path: string,
  data: Record<string, unknown>,
  deletePaths?: string[],
): Promise<FirestoreDoc> {
  const params = new URLSearchParams();
  for (const key of Object.keys(data)) params.append("updateMask.fieldPaths", key);
  for (const key of deletePaths ?? []) params.append("updateMask.fieldPaths", key);
  const raw = await request<Parameters<typeof toDoc>[0]>(
    `${baseUrl()}/${path}?${params.toString()}`,
    { method: "PATCH", body: JSON.stringify({ fields: encodeFields(data) }) },
  );
  return toDoc(raw);
}

/** Create a document at an explicit id (fails if it already exists). */
export async function createDoc(
  collection: string,
  documentId: string,
  data: Record<string, unknown>,
): Promise<FirestoreDoc> {
  const params = new URLSearchParams({ documentId });
  const raw = await request<Parameters<typeof toDoc>[0]>(
    `${baseUrl()}/${collection}?${params.toString()}`,
    { method: "POST", body: JSON.stringify({ fields: encodeFields(data) }) },
  );
  if (isAuditPath(`${collection}/${documentId}`)) {
    await forwardAuditEntries([{ id: documentId, data }]);
  }
  return toDoc(raw);
}

export async function deleteDoc(
  path: string,
  precondition?: { updateTime?: string; exists?: boolean },
): Promise<void> {
  const params = new URLSearchParams();
  if (precondition?.updateTime) {
    params.set("currentDocument.updateTime", precondition.updateTime);
  }
  if (precondition?.exists !== undefined) {
    params.set("currentDocument.exists", String(precondition.exists));
  }
  const query = params.toString();
  const suffix = query ? `?${query}` : "";
  await request(`${baseUrl()}/${path.replace(/^\//, "")}${suffix}`, {
    method: "DELETE",
  });
}

function databaseResourceName(): string {
  const { project_id } = getServiceAccount();
  return `projects/${project_id}/databases/(default)`;
}

function documentResourceName(path: string): string {
  return `${databaseResourceName()}/documents/${path.replace(/^\//, "")}`;
}

/** A Firestore document precondition. `updateTime` is an exact server timestamp. */
export interface FirestoreTransactionPrecondition {
  updateTime?: string;
  exists?: boolean;
}

/** Optional compare-and-swap conditions and field deletions for a transaction update. */
export interface FirestoreTransactionUpdateOptions extends FirestoreTransactionPrecondition {
  /** Field paths to delete in the same masked update. */
  deletePaths?: readonly string[];
}

export interface FirestoreTransaction {
  /** Read a document. Transaction reads must be issued before queued writes. */
  get: (path: string) => Promise<FirestoreDoc | null>;
  /** Queue a full-document write with replace semantics; omitted fields are removed. */
  set: (path: string, data: Record<string, unknown>) => void;
  /** Queue a partial update with an explicit update mask and optional precondition. */
  update: (
    path: string,
    data: Record<string, unknown>,
    options?: FirestoreTransactionUpdateOptions,
  ) => void;
  /** Queue a document delete. */
  delete: (path: string) => void;
}

function transactionPrecondition(
  options: FirestoreTransactionUpdateOptions | undefined,
): FirestoreTransactionPrecondition | undefined {
  if (!options) return undefined;
  if (options.updateTime !== undefined && options.exists !== undefined) {
    throw new Error("Firestore transaction update accepts only one precondition");
  }
  if (options.updateTime !== undefined) return { updateTime: options.updateTime };
  if (options.exists !== undefined) return { exists: options.exists };
  return undefined;
}

function isTransactionContention(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /\b(?:FAILED_PRECONDITION|PERMISSION_DENIED|INVALID_ARGUMENT|NOT_FOUND|ALREADY_EXISTS|UNAUTHENTICATED)\b/.test(
      message,
    )
  ) {
    return false;
  }
  return (
    /\bABORTED\b/i.test(message) ||
    /too much contention/i.test(message) ||
    /aborted due to .*contention/i.test(message)
  );
}

async function rollbackTransaction(transaction: string): Promise<void> {
  try {
    await request(`${baseUrl()}:rollback`, {
      method: "POST",
      body: JSON.stringify({ transaction }),
    });
  } catch {
    /* Transaction may already be closed. */
  }
}

async function runTransactionOnce<T>(work: (tx: FirestoreTransaction) => Promise<T>): Promise<T> {
  const started = await request<{ transaction: string }>(`${baseUrl()}:beginTransaction`, {
    method: "POST",
    body: JSON.stringify({ options: { readWrite: {} } }),
  });
  const transaction = started.transaction;
  const writes: Record<string, unknown>[] = [];
  let result: T;
  // Audit rows staged in this attempt; forwarded only after commit succeeds.
  const auditWrites: { id: string; data: Record<string, unknown> }[] = [];
  let writesQueued = false;
  try {
    const tx: FirestoreTransaction = {
      get: async (path: string) => {
        if (writesQueued) {
          throw new Error("Firestore transaction reads must occur before queued writes");
        }
        const raw = await request<unknown>(`${baseUrl()}:batchGet`, {
          method: "POST",
          body: JSON.stringify({
            documents: [documentResourceName(path)],
            transaction,
          }),
        });
        const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
        for (const row of rows) {
          if (!row || typeof row !== "object") continue;
          const found = (row as { found?: Parameters<typeof toDoc>[0] }).found;
          if (found) return toDoc(found);
        }
        return null;
      },
      set: (path: string, data: Record<string, unknown>) => {
        // Deliberately no updateMask: Firestore treats set as full-document replace semantics.
        writesQueued = true;
        writes.push({
          update: {
            name: documentResourceName(path),
            fields: encodeFields(data),
          },
        });
        if (isAuditPath(path)) {
          auditWrites.push({ id: path.replace(/^\//, "").split("/").pop() ?? "", data });
        }
      },
      update: (path: string, data: Record<string, unknown>, options) => {
        const currentDocument = transactionPrecondition(options);
        writesQueued = true;
        const fieldPaths = [
          ...Object.keys(data),
          ...(options?.deletePaths ?? []),
        ];
        const write: Record<string, unknown> = {
          update: {
            name: documentResourceName(path),
            fields: encodeFields(data),
          },
          updateMask: { fieldPaths },
        };
        if (currentDocument) write["currentDocument"] = currentDocument;
        writes.push(write);
      },
      delete: (path: string) => {
        writesQueued = true;
        writes.push({ delete: documentResourceName(path) });
      },
    };
    result = await work(tx);
    await request(`${baseUrl()}:commit`, {
      method: "POST",
      body: JSON.stringify({
        database: databaseResourceName(),
        transaction,
        writes,
      }),
    });
  } catch (error) {
    await rollbackTransaction(transaction);
    throw error;
  }
  // Outside the try: forwarding never throws, and a committed transaction
  // must not be rolled back or retried on its account.
  await forwardAuditEntries(auditWrites);
  return result;
}

/**
 * Runs read/write work in a Firestore transaction, retrying only ABORTED or
 * contention failures. Authorization, validation, and precondition failures
 * are surfaced to the caller without another transaction attempt.
 *
 * @param work - Reads and queued writes against a single transaction
 * @returns The value returned by `work`
 */
export async function runTransaction<T>(work: (tx: FirestoreTransaction) => Promise<T>): Promise<T> {
  const attempts = 5;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await runTransactionOnce(work);
    } catch (error) {
      lastError = error;
      if (!isTransactionContention(error) || attempt === attempts - 1) throw error;
    }
  }
  throw lastError;
}

export async function countCollection(
  collection: string,
  filters: QueryFilter[] = [],
  options?: { allDescendants?: boolean },
): Promise<number> {
  const structuredQuery: Record<string, unknown> = {
    from: [
      {
        collectionId: collection,
        ...(options?.allDescendants ? { allDescendants: true } : {}),
      },
    ],
  };
  if (filters.length === 1) {
    structuredQuery["where"] = {
      fieldFilter: {
        field: { fieldPath: filters[0].field },
        op: filters[0].op,
        value: encodeValue(filters[0].value, filters[0].field),
      },
    };
  } else if (filters.length > 1) {
    structuredQuery["where"] = {
      compositeFilter: {
        op: "AND",
        filters: filters.map((filter) => ({
          fieldFilter: {
            field: { fieldPath: filter.field },
            op: filter.op,
            value: encodeValue(filter.value, filter.field),
          },
        })),
      },
    };
  }
  const raw = await request<{ result?: { aggregateFields?: Record<string, FirestoreValue> } }[]>(
    `${baseUrl()}:runAggregationQuery`,
    {
      method: "POST",
      body: JSON.stringify({
        structuredAggregationQuery: {
          structuredQuery,
          aggregations: [{ alias: "total", count: {} }],
        },
      }),
    },
  );
  const total = raw[0]?.result?.aggregateFields?.["total"];
  return total ? Number(decodeValue(total)) : 0;
}

/** 16-char SHA1 of `subject_key|angle_key`, matching the pipeline's fact ids. */
export async function factId(subjectKey: string, angleKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(`${subjectKey}|${angleKey}`),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
