import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../lib/cn";

export type ProgressTone = "lime" | "red" | "purple";

export interface ProgressBarProps extends HTMLAttributes<HTMLDivElement> {
  /** Current value. */
  value: number;
  /** Maximum value. Defaults to 100. */
  max?: number;
  /** Fill color role. */
  tone?: ProgressTone;
  /** Accessible name of the progress track. */
  label: string;
}

/** Progress / countdown track used for shot clocks and reward tiers. */
export const ProgressBar = forwardRef<HTMLDivElement, ProgressBarProps>(
  ({ value, max = 100, tone = "lime", label, className, ...props }, ref) => {
    const pct = Math.max(0, Math.min(100, (value / max) * 100));
    return (
      <div
        ref={ref}
        role="progressbar"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        className={cn("ds-progress", className)}
        {...props}
      >
        <div
          className={cn("ds-progress__fill", `ds-progress__fill--${tone}`)}
          style={{ width: `${pct}%` }}
        />
      </div>
    );
  },
);
ProgressBar.displayName = "ProgressBar";
