import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../lib/cn";

export type ButtonVariant = "primary" | "danger" | "daily" | "skip" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual role of the action. */
  variant?: ButtonVariant;
  /** Control height and type scale. */
  size?: ButtonSize;
}

/** Chunky arcade action button with a press-compressing hard shadow. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", className, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        "ds-button",
        "ds-focusable",
        `ds-button--${variant}`,
        `ds-button--${size}`,
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = "Button";
