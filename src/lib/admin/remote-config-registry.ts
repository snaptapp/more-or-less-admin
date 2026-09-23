/**
 * Remote Config parameter descriptor registry.
 *
 * Defines metadata, defaults, categories, and UI hints for Remote Config parameters
 * in the More or Less client and edge worker.
 *
 * To add a new Remote Config parameter in the future:
 * 1. Add an entry to KNOWN_CONFIG_PARAMS below.
 * 2. It will automatically be typed, validated, and rendered in the admin portal.
 */

export type ConfigParamCategory = "monetization" | "access" | "gameplay" | "system" | "custom";

export type ConfigParamType = "BOOLEAN" | "NUMBER" | "STRING" | "JSON";

export interface ConfigParamDescriptor<T = unknown> {
  key: string;
  label: string;
  category: ConfigParamCategory;
  valueType: ConfigParamType;
  defaultValue: T;
  description: string;
  uiHint: "toggle" | "number" | "text" | "tags" | "textarea" | "custom";
  min?: number;
  max?: number;
}

export const KNOWN_CONFIG_PARAMS = {
  enable_interstitial_ads: {
    key: "enable_interstitial_ads",
    label: "Enable Interstitial Ads",
    category: "monetization",
    valueType: "BOOLEAN",
    defaultValue: false,
    description: "Display full-screen ads between finished game rounds on mobile (ad-free purchasers are exempt).",
    uiHint: "toggle",
  },
  interstitial_ad_frequency_rounds: {
    key: "interstitial_ad_frequency_rounds",
    label: "Interstitial Ad Frequency (Rounds)",
    category: "monetization",
    valueType: "NUMBER",
    defaultValue: 3,
    description: "Number of completed rounds/packs required between interstitial ad displays.",
    uiHint: "number",
    min: 1,
    max: 50,
  },
  enable_rewarded_ads: {
    key: "enable_rewarded_ads",
    label: "Enable Rewarded Ads",
    category: "monetization",
    valueType: "BOOLEAN",
    defaultValue: true,
    description: "Allow players to watch opt-in rewarded video ads to revive in Cutthroat sudden-death mode.",
    uiHint: "toggle",
  },
  enable_banner_ads: {
    key: "enable_banner_ads",
    label: "Enable Banner Ads",
    category: "monetization",
    valueType: "BOOLEAN",
    defaultValue: false,
    description: "Display banner ads on eligible non-gameplay screens.",
    uiHint: "toggle",
  },
  allowed_emails: {
    key: "allowed_emails",
    label: "Runtime Email Allowlist",
    category: "access",
    valueType: "STRING",
    defaultValue: "",
    description: "Comma-separated email addresses or domain suffixes (e.g. @snaptapp.us) granted runtime testing/access.",
    uiHint: "tags",
  },
  custom_topic_suggestions: {
    key: "custom_topic_suggestions",
    label: "Custom Topic Suggestions & Audience Overrides",
    category: "gameplay",
    valueType: "JSON",
    defaultValue: "[]",
    description: "Rotating custom topic suggestions on solo config screen with audience targeting and A/B variants.",
    uiHint: "custom",
  },
} as const satisfies Record<string, ConfigParamDescriptor>;

export type KnownConfigParamKey = keyof typeof KNOWN_CONFIG_PARAMS;
