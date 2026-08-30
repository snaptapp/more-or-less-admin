import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/cn";

export interface TabBarItem {
  /** Stable key for the destination. */
  id: string;
  /** Mono uppercase label. */
  label: string;
  /** Optional glyph above the label. */
  icon?: ReactNode;
}

export interface TabBarProps extends HTMLAttributes<HTMLElement> {
  /** Destinations, left to right. */
  items: TabBarItem[];
  /** Currently active item id. */
  activeId: string;
  /** Fired with the id of the tapped destination. */
  onSelect?: (id: string) => void;
}

/** Bottom navigation between the app's primary surfaces. */
export const TabBar = forwardRef<HTMLElement, TabBarProps>(
  ({ items, activeId, onSelect, className, ...props }, ref) => (
    <nav ref={ref} aria-label="Primary" className={cn("ds-tabbar", className)} {...props}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-current={item.id === activeId ? "page" : undefined}
          onClick={() => onSelect?.(item.id)}
          className="ds-tabbar__item ds-focusable"
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </nav>
  ),
);
TabBar.displayName = "TabBar";
