import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { Card, CardLabel, CardTitle } from "./Card";
import { ProgressBar } from "./ProgressBar";

export type TierState = "completed" | "active" | "locked";

export interface TierRowProps extends HTMLAttributes<HTMLDivElement> {
  /** Eyebrow, e.g. "Tier 2 • 6/10 games". */
  eyebrow: string;
  /** Reward name. */
  title: string;
  /** Progress state of this tier. */
  state: TierState;
  /** Completed steps, for the active tier. */
  value?: number;
  /** Total steps, for the active tier. */
  max?: number;
  /** Action rendered inside the row, e.g. a collect button. */
  action?: ReactNode;
}

/** One milestone in a reward track. */
export const TierRow = forwardRef<HTMLDivElement, TierRowProps>(
  ({ eyebrow, title, state, value = 0, max = 1, action, className, ...props }, ref) => (
    <Card
      ref={ref}
      variant={state === "active" ? "active" : state === "locked" ? "locked" : "default"}
      className={cn(className)}
      {...props}
    >
      <CardLabel>{eyebrow}</CardLabel>
      <CardTitle>{title}</CardTitle>
      {state === "active" ? (
        <div style={{ display: "grid", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
          <ProgressBar label={`${title} progress`} value={value} max={max} />
          <span className="ds-label">
            {value} / {max}
          </span>
        </div>
      ) : null}
      {action ? <div style={{ marginTop: "var(--space-3)" }}>{action}</div> : null}
    </Card>
  ),
);
TierRow.displayName = "TierRow";
