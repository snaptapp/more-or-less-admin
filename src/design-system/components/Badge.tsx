import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../lib/cn";

export type BadgeTone = "neutral" | "lime" | "red" | "purple" | "amber";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** Semantic color of the badge. */
  tone?: BadgeTone;
}

/** Small mono uppercase pill for status, counters, and mode labels. */
export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ tone = "neutral", className, ...props }, ref) => (
    <span
      ref={ref}
      className={cn("ds-badge", tone !== "neutral" && `ds-badge--${tone}`, className)}
      {...props}
    />
  ),
);
Badge.displayName = "Badge";
