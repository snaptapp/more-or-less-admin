/**
 * Firebase Remote Config REST client for Cloudflare Worker environment.
 * Uses service account OAuth2 tokens from credentials.server.ts.
 */

import { getAccessToken, getServiceAccount } from "./credentials.server";
import {
  MODE_VISIBILITY_KEYS,
  applyModeVisibility,
  modesWithConditionalValues,
  parseModeVisibility,
  type GameModeId,
  type ModeVisibility,
} from "@/lib/admin/mode-visibility";

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
    description?: string;
    updateOrigin?: string;
    updateType?: string;
  };
  etag: string;
}

export interface CustomParamEntry {
  value: string;
  valueType?: "STRING" | "BOOLEAN" | "NUMBER" | "JSON";
  description?: string;
}

export interface TopicSuggestionConfig {
  defaultTopics: string[];
  variants: {
    conditionName: string;
    expression: string;
    tagColor: string;
    topics: string[];
  }[];
  // Active Remote Config options in More or Less
  enableInterstitialAds: boolean;
  interstitialAdFrequency: number;
  enableRewardedAds: boolean;
  enableBannerAds: boolean;
  allowedEmails: string[];
  // Client mode visibility (`mode_<id>_visible`)
  modeVisibility: ModeVisibility;
  modesWithOverrides: GameModeId[];
  // Dynamic custom parameters
  customParameters: Record<string, CustomParamEntry>;
  etag: string;
  versionNumber?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface RemoteConfigPublishInput {
  defaultTopics: string[];
  variants: {
    conditionName: string;
    expression: string;
    tagColor?: string;
    topics: string[];
  }[];
  enableInterstitialAds?: boolean;
  interstitialAdFrequency?: number;
  enableRewardedAds?: boolean;
  enableBannerAds?: boolean;
  allowedEmails?: string[];
  modeVisibility?: Partial<ModeVisibility>;
  customParameters?: Record<string, CustomParamEntry>;
}

const PARAM_KEY = "custom_topic_suggestions";
const KNOWN_PARAM_KEYS = new Set([
  PARAM_KEY,
  "enable_interstitial_ads",
  "interstitial_ad_frequency_rounds",
  "enable_rewarded_ads",
  "enable_banner_ads",
  "allowed_emails",
  ...MODE_VISIBILITY_KEYS,
]);

const VALID_TAG_COLORS = new Set([
  "BLUE",
  "BROWN",
  "CYAN",
  "DEEP_ORANGE",
  "GREEN",
  "INDIGO",
  "LIME",
  "ORANGE",
  "PINK",
  "PURPLE",
  "TEAL",
  "GRAY",
]);

function normalizeTagColor(tagColor?: string): string {
  const token = (tagColor ?? "BLUE").trim();
  if (!token) return "BLUE";
  const upper = token.toUpperCase();
  if (upper === "AMBER") return "ORANGE";
  if (upper === "NEUTRAL" || upper === "GREY") return "GRAY";
  return VALID_TAG_COLORS.has(upper) ? upper : "BLUE";
}

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

  const etag = response.headers.get("ETag") || response.headers.get("etag");
  if (!etag) {
    throw new Error("Firebase Remote Config did not return an ETag; refusing to use an unverified template.");
  }
  const template = (await response.json()) as RemoteConfigTemplate;
  template.etag = etag;
  return template;
}

/**
 * Parse the full Remote Config configuration including topics, ad settings, allowlist, and custom parameters.
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

  // Parse active parameters in place
  const enableInterstitialAds =
    template.parameters?.["enable_interstitial_ads"]?.defaultValue?.value === "true";

  const rawFreq = template.parameters?.["interstitial_ad_frequency_rounds"]?.defaultValue?.value;
  const interstitialAdFrequency = rawFreq ? Math.max(1, parseInt(rawFreq, 10) || 3) : 3;

  const rawRewarded = template.parameters?.["enable_rewarded_ads"]?.defaultValue?.value;
  const enableRewardedAds = rawRewarded !== undefined ? rawRewarded === "true" : true;

  const enableBannerAds =
    template.parameters?.["enable_banner_ads"]?.defaultValue?.value === "true";

  const rawAllowed = template.parameters?.["allowed_emails"]?.defaultValue?.value ?? "";
  const allowedEmails = rawAllowed
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  // Discover any parameters beyond the known set
  const customParameters: Record<string, CustomParamEntry> = {};
  for (const [key, p] of Object.entries(template.parameters ?? {})) {
    if (!KNOWN_PARAM_KEYS.has(key)) {
      customParameters[key] = {
        value: p.defaultValue?.value ?? "",
        valueType: p.valueType,
        description: p.description,
      };
    }
  }

  return {
    defaultTopics,
    variants,
    enableInterstitialAds,
    interstitialAdFrequency,
    enableRewardedAds,
    enableBannerAds,
    allowedEmails,
    modeVisibility: parseModeVisibility(template.parameters),
    modesWithOverrides: modesWithConditionalValues(template.parameters),
    customParameters,
    etag: template.etag,
    versionNumber: template.version?.versionNumber,
    updatedAt: template.version?.updateTime,
    updatedBy: template.version?.updateUser?.email,
  };
}

/**
 * Update the topic suggestions, ad flags, allowlist, and custom parameters in Remote Config and publish.
 */
export async function publishTopicSuggestionsConfig(
  newConfig: RemoteConfigPublishInput,
  etag: string,
  userEmail?: string,
): Promise<TopicSuggestionConfig> {
  const template = await getRemoteConfigTemplate();
  const account = getServiceAccount();
  const token = await getAccessToken([REMOTE_CONFIG_SCOPE]);
  const priorTopicConditionNames = new Set(
    Object.keys(template.parameters?.[PARAM_KEY]?.conditionalValues ?? {}),
  );

  // Ensure parameters object exists
  if (!template.parameters) template.parameters = {};

  // Build conditionalValues map for topics
  const conditionalValues: Record<string, { value: string }> = {};
  const newConditionNames = new Set<string>();

  for (const variant of newConfig.variants) {
    conditionalValues[variant.conditionName] = {
      value: JSON.stringify(variant.topics),
    };
    newConditionNames.add(variant.conditionName);
  }

  // Update or set custom_topic_suggestions parameter
  template.parameters[PARAM_KEY] = {
    ...template.parameters[PARAM_KEY],
    defaultValue: {
      value: JSON.stringify(newConfig.defaultTopics),
    },
    conditionalValues: Object.keys(conditionalValues).length > 0 ? conditionalValues : undefined,
    description: "Rotating custom topic suggestions on solo config screen",
    valueType: "JSON",
  };

  // Update monetization and access parameters if provided
  if (newConfig.enableInterstitialAds !== undefined) {
    template.parameters["enable_interstitial_ads"] = {
      ...template.parameters["enable_interstitial_ads"],
      defaultValue: { value: String(newConfig.enableInterstitialAds) },
      valueType: "BOOLEAN",
      description: "Display full-screen ads between finished game rounds on mobile",
    };
  }

  if (newConfig.interstitialAdFrequency !== undefined) {
    template.parameters["interstitial_ad_frequency_rounds"] = {
      ...template.parameters["interstitial_ad_frequency_rounds"],
      defaultValue: { value: String(newConfig.interstitialAdFrequency) },
      valueType: "NUMBER",
      description: "Number of completed rounds/packs required between interstitial ad displays",
    };
  }

  if (newConfig.enableRewardedAds !== undefined) {
    template.parameters["enable_rewarded_ads"] = {
      ...template.parameters["enable_rewarded_ads"],
      defaultValue: { value: String(newConfig.enableRewardedAds) },
      valueType: "BOOLEAN",
      description: "Allow players to watch opt-in rewarded video ads to revive in Cutthroat sudden-death mode",
    };
  }

  if (newConfig.enableBannerAds !== undefined) {
    template.parameters["enable_banner_ads"] = {
      ...template.parameters["enable_banner_ads"],
      defaultValue: { value: String(newConfig.enableBannerAds) },
      valueType: "BOOLEAN",
      description: "Display banner ads on eligible non-gameplay screens",
    };
  }

  if (newConfig.allowedEmails !== undefined) {
    template.parameters["allowed_emails"] = {
      ...template.parameters["allowed_emails"],
      defaultValue: { value: newConfig.allowedEmails.join(",") },
      valueType: "STRING",
      description: "Comma-separated email addresses or domain suffixes granted runtime testing/access",
    };
  }

  if (newConfig.modeVisibility) {
    applyModeVisibility(template.parameters, newConfig.modeVisibility);
  }

  // Merge custom dynamic parameters if provided
  if (newConfig.customParameters) {
    for (const [key, customParam] of Object.entries(newConfig.customParameters)) {
      if (customParam.value === "" && !template.parameters[key]) {
        continue;
      }
      template.parameters[key] = {
        ...template.parameters[key],
        defaultValue: { value: customParam.value },
        valueType: customParam.valueType ?? "STRING",
        description: customParam.description ?? template.parameters[key]?.description,
      };
    }
  }

  // Rebuild topic conditions in UI priority order, preserving unrelated conditions.
  const existingConditions = template.conditions ?? [];
  const nonTopicConditions = existingConditions.filter(
    (cond) => !newConditionNames.has(cond.name) && !priorTopicConditionNames.has(cond.name),
  );
  const topicConditions = newConfig.variants.map((variant) => ({
    name: variant.conditionName,
    expression: variant.expression,
    tagColor: normalizeTagColor(variant.tagColor),
  }));
  template.conditions = [...nonTopicConditions, ...topicConditions];

  // Publish to Remote Config
  const url = `https://firebaseremoteconfig.googleapis.com/v1/projects/${account.project_id}/remoteConfig`;
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; UTF-8",
      "If-Match": etag,
    },
    body: JSON.stringify({
      parameters: template.parameters,
      conditions: template.conditions,
      parameterGroups: template.parameterGroups,
      version: {
        description: `Updated Remote Config parameters via Admin Portal by ${userEmail ?? "admin"}`,
      },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to publish Remote Config (${response.status}): ${err}`);
  }

  const updatedTemplate = (await response.json()) as RemoteConfigTemplate;
  const newEtag = response.headers.get("ETag") || response.headers.get("etag");
  if (!newEtag) {
    throw new Error("Firebase accepted the Remote Config publish but returned no ETag, so the publish could not be verified.");
  }

  const verifiedTemplate = await getRemoteConfigTemplate();
  if (verifiedTemplate.etag !== newEtag) {
    throw new Error("Firebase accepted the Remote Config publish, but read-back returned a different version. Reload the config before retrying.");
  }

  // Re-read current custom parameters
  const currentCustomParams: Record<string, CustomParamEntry> = {};
  for (const [key, p] of Object.entries(updatedTemplate.parameters ?? {})) {
    if (!KNOWN_PARAM_KEYS.has(key)) {
      currentCustomParams[key] = {
        value: p.defaultValue?.value ?? "",
        valueType: p.valueType,
        description: p.description,
      };
    }
  }

  return {
    defaultTopics: newConfig.defaultTopics,
    variants: newConfig.variants.map((v) => ({
      ...v,
      tagColor: normalizeTagColor(v.tagColor),
    })),
    enableInterstitialAds:
      newConfig.enableInterstitialAds ??
      (updatedTemplate.parameters?.["enable_interstitial_ads"]?.defaultValue?.value === "true"),
    interstitialAdFrequency:
      newConfig.interstitialAdFrequency ??
      (parseInt(updatedTemplate.parameters?.["interstitial_ad_frequency_rounds"]?.defaultValue?.value ?? "3", 10) || 3),
    enableRewardedAds:
      newConfig.enableRewardedAds ??
      (updatedTemplate.parameters?.["enable_rewarded_ads"]?.defaultValue?.value !== "false"),
    enableBannerAds:
      newConfig.enableBannerAds ??
      (updatedTemplate.parameters?.["enable_banner_ads"]?.defaultValue?.value === "true"),
    allowedEmails:
      newConfig.allowedEmails ??
      (updatedTemplate.parameters?.["allowed_emails"]?.defaultValue?.value ?? "")
        .split(/[\s,]+/)
        .filter(Boolean),
    modeVisibility: parseModeVisibility(updatedTemplate.parameters),
    modesWithOverrides: modesWithConditionalValues(updatedTemplate.parameters),
    customParameters: currentCustomParams,
    etag: newEtag,
    versionNumber: updatedTemplate.version?.versionNumber,
    updatedAt: updatedTemplate.version?.updateTime,
    updatedBy: updatedTemplate.version?.updateUser?.email ?? userEmail,
  };
}
