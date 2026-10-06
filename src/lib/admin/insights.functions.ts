import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "./middleware";

const schema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rows: z
    .array(
      z.object({
        event: z.enum(["cta_click", "outbound_click"]),
        location: z.string().min(1).max(60),
        count: z.number().int().min(0).max(100_000_000),
      }),
    )
    .min(1)
    .max(50),
  notes: z.string().max(1000).optional(),
});

export const summarizeInsights = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator((d: unknown) => schema.parse(d))
  .handler(async ({ data }) => {
    const { summarizePlacements } = await import("./insights.server");
    return { summary: await summarizePlacements(data) };
  });
