import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";
import type { JSONValue } from "@notionhq/workers/types";

function asJson(value: unknown): JSONValue {
  return JSON.parse(JSON.stringify(value)) as JSONValue;
}

/**
 * Shared Cloudflare State Inspector for Notion Custom Agents.
 *
 * Allowlisted projects only. Read-only Cloudflare API calls.
 *
 * Secrets:
 *   CLOUDFLARE_API_TOKEN
 *   CLOUDFLARE_ACCOUNT_ID
 */
const worker = new Worker();
export default worker;

type ProjectKey = "more-or-less" | "trackdub";

type ProjectConfig = {
  key: ProjectKey;
  label: string;
  scriptName: string;
  kvNamespaces: string[];
  durableObjects: string[];
  routesHint: string[];
};

const PROJECTS: Record<ProjectKey, ProjectConfig> = {
  "more-or-less": {
    key: "more-or-less",
    label: "More or Less",
    scriptName: "more-or-less",
    kvNamespaces: ["TRIVIA_CACHE"],
    durableObjects: ["PartyRoom"],
    routesHint: ["game worker / party rooms"],
  },
  trackdub: {
    key: "trackdub",
    label: "Trackdub",
    scriptName: "trackdub-api",
    kvNamespaces: [],
    durableObjects: [],
    routesHint: ["api.trackdub.com"],
  },
};

function projectConfig(project: string): ProjectConfig {
  if (project !== "more-or-less" && project !== "trackdub") {
    throw new Error('project must be "more-or-less" or "trackdub"');
  }
  return PROJECTS[project];
}

function cfAuth(): { token: string; accountId: string } {
  const token = (process.env.CLOUDFLARE_API_TOKEN ?? "").trim();
  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not configured");
  if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is not configured");
  return { token, accountId };
}

async function cfGet(path: string): Promise<JSONValue> {
  const { token } = cfAuth();
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  const body = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    errors?: Array<{ message?: string }>;
    result?: unknown;
  };
  if (!response.ok || body.success === false) {
    const message = body.errors?.[0]?.message ?? `Cloudflare API HTTP ${response.status}`;
    throw new Error(message);
  }
  return asJson(body.result ?? null);
}

/**
 * Presence + non-source metadata only.
 * Uses the Worker settings endpoint — never the download-script API
 * (`GET .../workers/scripts/{name}`), which returns production source.
 */
async function workerDetails(scriptName: string) {
  const { accountId } = cfAuth();
  try {
    const settings = (await cfGet(
      `/accounts/${accountId}/workers/scripts/${scriptName}/settings`,
    )) as { usage_model?: string; logpush?: boolean; bindings?: unknown[] };
    return {
      found: true,
      metadata: {
        usage_model: settings?.usage_model ?? null,
        logpush: settings?.logpush ?? null,
        binding_count: Array.isArray(settings?.bindings) ? settings.bindings.length : null,
      },
    };
  } catch (error) {
    return {
      found: false,
      error: error instanceof Error ? error.message : "Worker lookup failed",
    };
  }
}

async function deploymentHistory(scriptName: string) {
  const { accountId } = cfAuth();
  try {
    const result = await cfGet(
      `/accounts/${accountId}/workers/scripts/${scriptName}/deployments`,
    );
    return { found: true, deployments: result };
  } catch (error) {
    return {
      found: false,
      error: error instanceof Error ? error.message : "Deployment history unavailable",
    };
  }
}

async function bindingInventory(scriptName: string) {
  const { accountId } = cfAuth();
  try {
    const settings = (await cfGet(
      `/accounts/${accountId}/workers/scripts/${scriptName}/settings`,
    )) as {
      bindings?: Array<{ name?: string; type?: string; class_name?: string }>;
    };
    const bindings = Array.isArray(settings?.bindings) ? settings.bindings : [];
    return {
      found: true,
      present: bindings.length,
      bindings: bindings.map((binding) => ({
        name: binding.name ?? "(unnamed)",
        type: binding.type ?? "(unknown)",
        class_name: binding.class_name ?? null,
      })),
    };
  } catch (error) {
    return {
      found: false,
      error: error instanceof Error ? error.message : "Bindings unavailable",
    };
  }
}

function bindingMatchesExpected(
  bindings: Array<{ name: string; type: string; class_name: string | null }>,
  expected: string,
): boolean {
  return bindings.some(
    (binding) => binding.name === expected || binding.class_name === expected,
  );
}

worker.tool("production_health", {
  title: "Cloudflare Production Health",
  description:
    "Use for high-level Cloudflare production health of an allowlisted project (more-or-less or trackdub). Returns worker presence, recent deployment info when available, and binding inventory summary.",
  schema: j.object({
    project: j
      .enum("more-or-less", "trackdub")
      .describe("Allowlisted project key."),
  }),
  hints: { readOnlyHint: true },
  execute: async ({ project }) => {
    const checkedAt = new Date().toISOString();
    const config = projectConfig(project);
    const [worker, deployments, bindings] = await Promise.all([
      workerDetails(config.scriptName),
      deploymentHistory(config.scriptName),
      bindingInventory(config.scriptName),
    ]);

    const inventoryBindings =
      bindings.found && Array.isArray(bindings.bindings) ? bindings.bindings : [];
    const missingExpectedKv = config.kvNamespaces.filter(
      (name) => bindings.found && !bindingMatchesExpected(inventoryBindings, name),
    );
    const missingExpectedDurableObjects = config.durableObjects.filter(
      (name) => bindings.found && !bindingMatchesExpected(inventoryBindings, name),
    );
    const missingExpected = [...missingExpectedKv, ...missingExpectedDurableObjects];

    const status =
      !worker.found
        ? "critical"
        : missingExpected.length
          ? "warning"
          : "healthy";

    return asJson({
      project: config.key,
      label: config.label,
      checked_at: checkedAt,
      worker: {
        script_name: config.scriptName,
        deployment: worker.found ? "present" : "missing",
        details: worker,
      },
      traffic: {
        note: "Request/error analytics require Cloudflare analytics API scope; not included in this read.",
      },
      bindings: {
        expected_kv: config.kvNamespaces,
        expected_durable_objects: config.durableObjects,
        inventory: bindings,
        missing_expected_kv: missingExpectedKv,
        missing_expected_durable_objects: missingExpectedDurableObjects,
      },
      kv: {
        configured_names: config.kvNamespaces,
        reachable: bindings.found
          ? missingExpectedKv.length === 0 && config.kvNamespaces.length > 0
          : null,
      },
      durable_objects: {
        configured: config.durableObjects.length > 0,
        names: config.durableObjects,
        missing_expected: missingExpectedDurableObjects,
      },
      deployments,
      status,
    });
  },
});

worker.tool("deployment_history", {
  title: "Cloudflare Deployment History",
  description:
    "Use when asked what recently deployed for an allowlisted Cloudflare project.",
  schema: j.object({
    project: j.enum("more-or-less", "trackdub").describe("Allowlisted project key."),
  }),
  hints: { readOnlyHint: true },
  execute: async ({ project }) => {
    const config = projectConfig(project);
    return asJson({
      project: config.key,
      checked_at: new Date().toISOString(),
      ...(await deploymentHistory(config.scriptName)),
    });
  },
});

worker.tool("worker_health", {
  title: "Cloudflare Worker Health",
  description:
    "Use for Worker script presence and basic metadata for an allowlisted project.",
  schema: j.object({
    project: j.enum("more-or-less", "trackdub").describe("Allowlisted project key."),
  }),
  hints: { readOnlyHint: true },
  execute: async ({ project }) => {
    const config = projectConfig(project);
    return asJson({
      project: config.key,
      checked_at: new Date().toISOString(),
      ...(await workerDetails(config.scriptName)),
    });
  },
});

worker.tool("binding_inventory", {
  title: "Cloudflare Binding Inventory",
  description:
    "Use when troubleshooting missing KV, DO, or other Worker bindings for an allowlisted project.",
  schema: j.object({
    project: j.enum("more-or-less", "trackdub").describe("Allowlisted project key."),
  }),
  hints: { readOnlyHint: true },
  execute: async ({ project }) => {
    const config = projectConfig(project);
    return asJson({
      project: config.key,
      checked_at: new Date().toISOString(),
      expected: {
        kv: config.kvNamespaces,
        durable_objects: config.durableObjects,
      },
      ...(await bindingInventory(config.scriptName)),
    });
  },
});

worker.tool("kv_summary", {
  title: "Cloudflare KV Summary",
  description:
    "Use for KV namespace binding presence for an allowlisted project. Does not dump KV keys.",
  schema: j.object({
    project: j.enum("more-or-less", "trackdub").describe("Allowlisted project key."),
  }),
  hints: { readOnlyHint: true },
  execute: async ({ project }) => {
    const config = projectConfig(project);
    const bindings = await bindingInventory(config.scriptName);
    const kvBindings =
      bindings.found && Array.isArray(bindings.bindings)
        ? bindings.bindings.filter((binding) => binding.type === "kv_namespace")
        : [];
    return asJson({
      project: config.key,
      checked_at: new Date().toISOString(),
      expected: config.kvNamespaces,
      kv_bindings: kvBindings,
      note: "More or Less TRIVIA_CACHE is a pack cache, not the Fact Bank serving snapshot.",
    });
  },
});

worker.tool("d1_summary", {
  title: "Cloudflare D1 Summary",
  description:
    "Use for D1 binding presence on an allowlisted project. Returns configured bindings only.",
  schema: j.object({
    project: j.enum("more-or-less", "trackdub").describe("Allowlisted project key."),
  }),
  hints: { readOnlyHint: true },
  execute: async ({ project }) => {
    const config = projectConfig(project);
    const bindings = await bindingInventory(config.scriptName);
    const d1 =
      bindings.found && Array.isArray(bindings.bindings)
        ? bindings.bindings.filter((binding) => binding.type === "d1")
        : [];
    return asJson({
      project: config.key,
      checked_at: new Date().toISOString(),
      d1_bindings: d1,
    });
  },
});

worker.tool("r2_summary", {
  title: "Cloudflare R2 Summary",
  description:
    "Use for R2 binding presence on an allowlisted project. Returns configured bindings only.",
  schema: j.object({
    project: j.enum("more-or-less", "trackdub").describe("Allowlisted project key."),
  }),
  hints: { readOnlyHint: true },
  execute: async ({ project }) => {
    const config = projectConfig(project);
    const bindings = await bindingInventory(config.scriptName);
    const r2 =
      bindings.found && Array.isArray(bindings.bindings)
        ? bindings.bindings.filter((binding) => binding.type === "r2_bucket")
        : [];
    return asJson({
      project: config.key,
      checked_at: new Date().toISOString(),
      r2_bindings: r2,
    });
  },
});

worker.tool("recent_runtime_errors", {
  title: "Cloudflare Recent Runtime Errors",
  description:
    "Use when correlating a broken experience with Worker runtime errors. Returns availability of error telemetry for the allowlisted project; may be limited by API token scopes.",
  schema: j.object({
    project: j.enum("more-or-less", "trackdub").describe("Allowlisted project key."),
  }),
  hints: { readOnlyHint: true },
  execute: async ({ project }) => {
    const config = projectConfig(project);
    const { accountId } = cfAuth();
    try {
      // Best-effort: Workers observability APIs vary by account entitlement.
      const result = await cfGet(
        `/accounts/${accountId}/workers/scripts/${config.scriptName}/tail/errors`,
      );
      return asJson({
        project: config.key,
        checked_at: new Date().toISOString(),
        available: true,
        result,
      });
    } catch (error) {
      return asJson({
        project: config.key,
        checked_at: new Date().toISOString(),
        available: false,
        error: error instanceof Error ? error.message : "Runtime errors unavailable",
        note: "Token may lack observability scope, or the endpoint is not enabled for this account.",
      });
    }
  },
});
