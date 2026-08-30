import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../lib/cn";

export interface TopicTileProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Whether this topic is the current selection. */
  selected?: boolean;
}

/** Selectable topic chip used in lobby topic pickers. */
export const TopicTile = forwardRef<HTMLButtonElement, TopicTileProps>(
  ({ selected = false, className, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      aria-pressed={selected}
      className={cn("ds-topic", "ds-focusable", className)}
      {...props}
    />
  ),
);
TopicTile.displayName = "TopicTile";
