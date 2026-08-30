import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../lib/cn";
import { ProgressBar } from "./ProgressBar";

export interface ShotClockProps extends HTMLAttributes<HTMLDivElement> {
  /** Seconds remaining. */
  remaining: number;
  /** Total seconds in the round. */
  total: number;
  /** Label shown next to the readout. */
  label?: string;
}

/** Round countdown: mono readout plus a draining track that turns red when low. */
export const ShotClock = forwardRef<HTMLDivElement, ShotClockProps>(
  ({ remaining, total, label = "Shot clock", className, ...props }, ref) => {
    const low = remaining / total <= 0.25;
    return (
      <div ref={ref} className={cn("ds-timer", className)} {...props}>
        <div className="ds-timer__row">
          <span className="ds-label">{label}</span>
          <span className={cn("ds-timer__value", low && "ds-timer__value--low")}>
            {remaining.toFixed(1)}s
          </span>
        </div>
        <ProgressBar
          label={label}
          value={remaining}
          max={total}
          tone={low ? "red" : "lime"}
        />
      </div>
    );
  },
);
ShotClock.displayName = "ShotClock";
