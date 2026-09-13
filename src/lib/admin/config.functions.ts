import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "./middleware";

const VariantSchema = z.object({
  conditionName: z.string().min(1),
  expression: z.string().min(1),
  tagColor: z.string().optional(),
  topics: z.array(z.string().min(1)).min(1),
});

const SaveConfigInputSchema = z.object({
  defaultTopics: z.array(z.string().min(1)).min(1),
  variants: z.array(VariantSchema),
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
.inputValidator((data) => SaveConfigInputSchema.parse(data))
  .handler(async ({ data, context }) => {
    const caller = context.user;
    const { publishTopicSuggestionsConfig } = await import("@/lib/firebase/remote_config.server");
    const { logAdminAction } = await import("@/lib/firebase/audit.server");

    const updated = await publishTopicSuggestionsConfig(
      {
        defaultTopics: data.defaultTopics,
        variants: data.variants,
      },
      data.etag,
      caller.email ?? caller.uid,
    );

    await logAdminAction(caller, {
      action: "update_remote_config_topics",
      targetType: "system",
      targetId: "custom_topic_suggestions",
      details: `${caller.email ?? caller.uid} published ${data.defaultTopics.length} default topics and ${data.variants.length} variant rules (version ${updated.versionNumber ?? "new"})`,
      after: {
        defaultTopics: data.defaultTopics,
        variants: data.variants,
        versionNumber: updated.versionNumber,
      },
    });

    return updated;
  });
