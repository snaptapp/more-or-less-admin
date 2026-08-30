import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../lib/cn";

export type ResultOutcome = "correct" | "wrong";

export interface ResultBannerProps extends HTMLAttributes<HTMLDivElement> {
  /** Round outcome being announced. */
  outcome: ResultOutcome;
}

/** Full-width verdict banner shown between rounds. */
export const ResultBanner = forwardRef<HTMLDivElement, ResultBannerProps>(
  ({ outcome, className, children, ...props }, ref) => (
    <div
      ref={ref}
      role="status"
      className={cn("ds-banner", `ds-banner--${outcome}`, className)}
      {...props}
    >
      {children ?? (outcome === "correct" ? "Correct!" : "Wrong!")}
    </div>
  ),
);
ResultBanner.displayName = "ResultBanner";
