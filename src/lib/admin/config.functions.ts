import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "./middleware";
import { GAME_MODE_IDS } from "./mode-visibility";

const VariantSchema = z.object({
  conditionName: z.string().min(1),
  expression: z.string().min(1),
  tagColor: z.string().optional(),
  topics: z.array(z.string().min(1)).min(1),
});

const CustomParamSchema = z.object({
  value: z.string(),
  valueType: z.enum(["STRING", "BOOLEAN", "NUMBER", "JSON"]).optional(),
  description: z.string().optional(),
});

const SaveConfigInputSchema = z.object({
  defaultTopics: z.array(z.string().min(1)).min(1),
  variants: z.array(VariantSchema).superRefine((items, ctx) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      if (seen.has(item.conditionName)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, "conditionName"], message: "Condition names must be unique." });
      }
      seen.add(item.conditionName);
    });
  }),
  enableInterstitialAds: z.boolean().optional(),
  interstitialAdFrequency: z.number().int().min(1).max(50).optional(),
  enableRewardedAds: z.boolean().optional(),
  enableBannerAds: z.boolean().optional(),
  allowedEmails: z.array(z.string()).optional(),
  modeVisibility: z.object(Object.fromEntries(GAME_MODE_IDS.map((id) => [id, z.boolean()])) as Record<(typeof GAME_MODE_IDS)[number], z.ZodBoolean>).partial().strict().optional(),
  customParameters: z.record(CustomParamSchema).optional(),
  etag: z.string(),
});

export const fetchRemoteConfigTopics = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async () => {
    const { getTopicSuggestionsConfig } = await import("@/lib/firebase/remote_config.server");
    return getTopicSuggestionsConfig();
  });

export const saveRemoteConfigTopics = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data) => SaveConfigInputSchema.parse(data))
  .handler(async ({ data, context }) => {
    const caller = context.user;
    const { publishTopicSuggestionsConfig } = await import("@/lib/firebase/remote_config.server");
    const { logAdminAction } = await import("@/lib/firebase/audit.server");

    const updated = await publishTopicSuggestionsConfig(
      {
        defaultTopics: data.defaultTopics,
        variants: data.variants,
        enableInterstitialAds: data.enableInterstitialAds,
        interstitialAdFrequency: data.interstitialAdFrequency,
        enableRewardedAds: data.enableRewardedAds,
        enableBannerAds: data.enableBannerAds,
        allowedEmails: data.allowedEmails,
        modeVisibility: data.modeVisibility,
        customParameters: data.customParameters,
      },
      data.etag,
      caller.email ?? caller.uid,
    );

    await logAdminAction(caller, {
      action: "update_remote_config_topics",
      targetType: "system",
      targetId: "custom_topic_suggestions",
      details: `${caller.email ?? caller.uid} published Remote Config (${data.defaultTopics.length} default topics, ${data.variants.length} variant rules, version ${updated.versionNumber ?? "new"})`,
      after: {
        defaultTopics: data.defaultTopics,
        variants: data.variants,
        enableInterstitialAds: updated.enableInterstitialAds,
        interstitialAdFrequency: updated.interstitialAdFrequency,
        enableRewardedAds: updated.enableRewardedAds,
        enableBannerAds: updated.enableBannerAds,
        allowedEmails: updated.allowedEmails,
        modeVisibility: updated.modeVisibility,
        customParameters: updated.customParameters,
        versionNumber: updated.versionNumber,
      },
    });

    return updated;
  });
