import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../lib/cn";
import { Badge } from "./Badge";

export type StatTone = "correct" | "wrong";

export interface StatValueProps extends HTMLAttributes<HTMLDivElement> {
  /** The revealed number. */
  value: string | number;
  /** Unit shown under the number. */
  unit?: string;
  /** Coloring of the number. */
  tone?: StatTone;
}

/** Big reveal number with its unit pill. */
export const StatValue = forwardRef<HTMLDivElement, StatValueProps>(
  ({ value, unit, tone = "correct", className, ...props }, ref) => (
    <div ref={ref} className={cn("ds-stat", className)} {...props}>
      <span className={cn("ds-stat__value", `ds-stat__value--${tone}`)}>{value}</span>
      {unit ? <Badge tone={tone === "correct" ? "lime" : "neutral"}>{unit}</Badge> : null}
    </div>
  ),
);
StatValue.displayName = "StatValue";
