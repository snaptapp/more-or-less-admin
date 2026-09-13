/**
 * Firebase Remote Config REST client for Cloudflare Worker environment.
 * Uses service account OAuth2 tokens from credentials.server.ts.
 */

import { getAccessToken, getServiceAccount } from "./credentials.server";

const REMOTE_CONFIG_SCOPE = "https://www.googleapis.com/auth/firebase.remoteconfig";

export interface RemoteConfigCondition {
  name: string;
  expression: string;
  tagColor?: string;
}

export interface RemoteConfigParameter {
  defaultValue?: {
    value?: string;
    useInAppDefault?: boolean;
  };
  conditionalValues?: Record<string, { value?: string; useInAppDefault?: boolean }>;
  description?: string;
  valueType?: "STRING" | "BOOLEAN" | "NUMBER" | "JSON";
}

export interface RemoteConfigTemplate {
  parameters?: Record<string, RemoteConfigParameter>;
  conditions?: RemoteConfigCondition[];
  parameterGroups?: Record<string, unknown>;
  version?: {
    versionNumber?: string;
    updateTime?: string;
    updateUser?: { email?: string };
    updateDescription?: string;
    updateOrigin?: string;
    updateType?: string;
  };
  etag: string;
}

export interface TopicSuggestionConfig {
  defaultTopics: string[];
  variants: {
    conditionName: string;
    expression: string;
    tagColor: string;
    topics: string[];
  }[];
  etag: string;
  versionNumber?: string;
  updatedAt?: string;
  updatedBy?: string;
}

const PARAM_KEY = "custom_topic_suggestions";

/**
 * Fetch the raw Remote Config template and ETag from Firebase.
 */
export async function getRemoteConfigTemplate(): Promise<RemoteConfigTemplate> {
  const account = getServiceAccount();
  const token = await getAccessToken([REMOTE_CONFIG_SCOPE]);
  const url = `https://firebaseremoteconfig.googleapis.com/v1/projects/${account.project_id}/remoteConfig`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to fetch Remote Config (${response.status}): ${errorText}`);
  }

  const etag = response.headers.get("ETag") || response.headers.get("etag") || "*";
  const template = (await response.json()) as RemoteConfigTemplate;
  template.etag = etag;
  return template;
}

/**
 * Parse the topic suggestions configuration (default topics and targeted variants).
 */
export async function getTopicSuggestionsConfig(): Promise<TopicSuggestionConfig> {
  const template = await getRemoteConfigTemplate();
  const param = template.parameters?.[PARAM_KEY];
  const conditionsMap = new Map<string, RemoteConfigCondition>();
  for (const c of template.conditions ?? []) {
    conditionsMap.set(c.name, c);
  }

  let defaultTopics: string[] = [];
  if (param?.defaultValue?.value) {
    try {
      const parsed = JSON.parse(param.defaultValue.value);
      if (Array.isArray(parsed)) {
        defaultTopics = parsed.map((item) => String(item).trim()).filter(Boolean);
      }
    } catch {
      defaultTopics = param.defaultValue.value.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }

  const variants: TopicSuggestionConfig["variants"] = [];
  if (param?.conditionalValues) {
    for (const [condName, condVal] of Object.entries(param.conditionalValues)) {
      const cond = conditionsMap.get(condName);
      let topics: string[] = [];
      if (condVal?.value) {
        try {
          const parsed = JSON.parse(condVal.value);
          if (Array.isArray(parsed)) {
            topics = parsed.map((item) => String(item).trim()).filter(Boolean);
          }
        } catch {
          topics = condVal.value.split(",").map((s) => s.trim()).filter(Boolean);
        }
      }
      variants.push({
        conditionName: condName,
        expression: cond?.expression ?? "",
        tagColor: cond?.tagColor ?? "BLUE",
        topics,
      });
    }
  }

  return {
    defaultTopics,
    variants,
    etag: template.etag,
    versionNumber: template.version?.versionNumber,
    updatedAt: template.version?.updateTime,
    updatedBy: template.version?.updateUser?.email,
  };
}

/**
 * Update the topic suggestions parameter & associated conditions in Remote Config and publish.
 */
export async function publishTopicSuggestionsConfig(
  newConfig: {
    defaultTopics: string[];
    variants: {
      conditionName: string;
      expression: string;
      tagColor?: string;
      topics: string[];
    }[];
  },
  etag: string,
  userEmail?: string,
): Promise<TopicSuggestionConfig> {
  const template = await getRemoteConfigTemplate();
  const account = getServiceAccount();
  const token = await getAccessToken([REMOTE_CONFIG_SCOPE]);

  // Ensure parameters object exists
  if (!template.parameters) template.parameters = {};

  // Build conditionalValues map
  const conditionalValues: Record<string, { value: string }> = {};
  const newConditionNames = new Set<string>();

  for (const variant of newConfig.variants) {
    conditionalValues[variant.conditionName] = {
      value: JSON.stringify(variant.topics),
    };
    newConditionNames.add(variant.conditionName);
  }

  // Update or set parameter
  template.parameters[PARAM_KEY] = {
    ...template.parameters[PARAM_KEY],
    defaultValue: {
      value: JSON.stringify(newConfig.defaultTopics),
    },
    conditionalValues: Object.keys(conditionalValues).length > 0 ? conditionalValues : undefined,
    description: "Rotating custom topic suggestions on solo config screen",
    valueType: "JSON",
  };

  // Merge conditions (preserve existing conditions for other parameters, add/update topic conditions)
  const existingConditions = template.conditions ?? [];
  const updatedConditions: RemoteConfigCondition[] = [];

  // Keep conditions that don't belong to topics or update topic conditions
  const processedTopicConditions = new Set<string>();
  for (const cond of existingConditions) {
    const matchingVariant = newConfig.variants.find((v) => v.conditionName === cond.name);
    if (matchingVariant) {
      updatedConditions.push({
        name: matchingVariant.conditionName,
        expression: matchingVariant.expression,
        tagColor: matchingVariant.tagColor ?? "BLUE",
      });
      processedTopicConditions.add(cond.name);
    } else if (!newConditionNames.has(cond.name)) {
      updatedConditions.push(cond);
    }
  }

  // Add any brand new conditions
  for (const variant of newConfig.variants) {
    if (!processedTopicConditions.has(variant.conditionName)) {
      updatedConditions.push({
        name: variant.conditionName,
        expression: variant.expression,
        tagColor: variant.tagColor ?? "BLUE",
      });
    }
  }

  template.conditions = updatedConditions;

  // Publish to Remote Config
  const url = `https://firebaseremoteconfig.googleapis.com/v1/projects/${account.project_id}/remoteConfig`;
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; UTF-8",
      "If-Match": etag || "*",
    },
    body: JSON.stringify({
      parameters: template.parameters,
      conditions: template.conditions,
      parameterGroups: template.parameterGroups,
      version: {
        updateDescription: `Updated custom topic suggestions via Admin Portal by ${userEmail ?? "admin"}`,
      },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to publish Remote Config (${response.status}): ${err}`);
  }

  const updatedTemplate = (await response.json()) as RemoteConfigTemplate;
  const newEtag = response.headers.get("ETag") || response.headers.get("etag") || "*";

  return {
    defaultTopics: newConfig.defaultTopics,
    variants: newConfig.variants.map((v) => ({
      ...v,
      tagColor: v.tagColor ?? "BLUE",
    })),
    etag: newEtag,
    versionNumber: updatedTemplate.version?.versionNumber,
    updatedAt: updatedTemplate.version?.updateTime,
    updatedBy: updatedTemplate.version?.updateUser?.email ?? userEmail,
  };
}
