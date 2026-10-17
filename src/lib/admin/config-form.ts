import { GAME_MODE_IDS, parseModeVisibility, type ModeVisibility } from "./mode-visibility";

/**
 * The editable Remote Config form on /admin/config, and the one place that
 * decides whether it differs from what is published. The page builds both the
 * form state and the comparison baseline with `configFormFromServer`, and
 * compares canonical forms, so defaults, key order and absent-vs-undefined
 * fields can never make an unedited form look dirty.
 */
export interface ConfigFormVariant {
  conditionName: string;
  expression: string;
  tagColor: string;
  topics: string[];
}

export interface ConfigFormCustomParam {
  value: string;
  valueType?: "STRING" | "BOOLEAN" | "NUMBER" | "JSON";
  description?: string;
}

export interface ConfigForm {
  defaultTopics: string[];
  variants: ConfigFormVariant[];
  enableInterstitialAds: boolean;
  interstitialAdFrequency: number;
  enableRewardedAds: boolean;
  enableBannerAds: boolean;
  allowedEmails: string[];
  modeVisibility: ModeVisibility;
  customParameters: Record<string, ConfigFormCustomParam>;
}

export type ConfigFormSection = keyof ConfigForm;

export const CONFIG_FORM_SECTION_LABELS: Record<ConfigFormSection, string> = {
  defaultTopics: "Default topics",
  variants: "Topic variants",
  enableInterstitialAds: "Interstitial ads",
  interstitialAdFrequency: "Interstitial frequency",
  enableRewardedAds: "Rewarded ads",
  enableBannerAds: "Banner ads",
  allowedEmails: "Email allowlist",
  modeVisibility: "Game mode visibility",
  customParameters: "Custom parameters",
};

const SECTIONS = Object.keys(CONFIG_FORM_SECTION_LABELS) as ConfigFormSection[];

/** Form values for a server config, with the same defaults the page shows. */
export function configFormFromServer(
  data: Partial<ConfigForm> | null | undefined,
  fallbackTopics: readonly string[],
): ConfigForm {
  return {
    defaultTopics: data?.defaultTopics?.length ? [...data.defaultTopics] : [...fallbackTopics],
    variants: (data?.variants ?? []).map((variant) => ({ ...variant, topics: [...variant.topics] })),
    enableInterstitialAds: data?.enableInterstitialAds ?? false,
    interstitialAdFrequency: data?.interstitialAdFrequency ?? 3,
    enableRewardedAds: data?.enableRewardedAds ?? true,
    enableBannerAds: data?.enableBannerAds ?? false,
    allowedEmails: [...(data?.allowedEmails ?? [])],
    modeVisibility: { ...parseModeVisibility(undefined), ...(data?.modeVisibility ?? {}) },
    customParameters: Object.fromEntries(
      Object.entries(data?.customParameters ?? {}).map(([key, value]) => [key, { ...value }]),
    ),
  };
}

/** JSON with sorted object keys and undefined fields dropped. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, current) => {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      return Object.fromEntries(
        Object.keys(current)
          .sort()
          .filter((key) => (current as Record<string, unknown>)[key] !== undefined)
          .map((key) => [key, (current as Record<string, unknown>)[key]]),
      );
    }
    return current;
  });
}

function sectionValue(form: ConfigForm, section: ConfigFormSection): unknown {
  if (section === "modeVisibility") {
    // Every known mode, in a fixed order, as a strict boolean.
    return GAME_MODE_IDS.map((id) => form.modeVisibility[id] === true);
  }
  return form[section];
}

/** Sections whose values differ between the edited form and the published baseline. */
export function changedConfigSections(current: ConfigForm, baseline: ConfigForm): ConfigFormSection[] {
  return SECTIONS.filter(
    (section) => canonical(sectionValue(current, section)) !== canonical(sectionValue(baseline, section)),
  );
}
