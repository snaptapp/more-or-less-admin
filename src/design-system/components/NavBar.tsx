import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/cn";

export interface NavBarProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  /** Screen title, rendered in the display face. */
  title: ReactNode;
  /** Leading control, usually a back or close button. */
  leading?: ReactNode;
  /** Trailing controls, usually icon buttons. */
  trailing?: ReactNode;
}

/** Top app bar for a screen. */
export const NavBar = forwardRef<HTMLElement, NavBarProps>(
  ({ title, leading, trailing, className, ...props }, ref) => (
    <header ref={ref} className={cn("ds-navbar", className)} {...props}>
      <div>{leading}</div>
      <h1 className="ds-navbar__title">{title}</h1>
      <div style={{ display: "flex", gap: "var(--space-2)" }}>{trailing}</div>
    </header>
  ),
);
NavBar.displayName = "NavBar";
