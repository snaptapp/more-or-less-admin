import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../lib/cn";

export type CardVariant = "default" | "featured" | "active" | "locked";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Emphasis state of the surface. */
  variant?: CardVariant;
}

/** Base panel surface for every grouped block. */
export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ variant = "default", className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("ds-card", variant !== "default" && `ds-card--${variant}`, className)}
      {...props}
    />
  ),
);
Card.displayName = "Card";

export type CardTitleProps = HTMLAttributes<HTMLHeadingElement>;

/** Display-face title inside a Card. */
export const CardTitle = forwardRef<HTMLHeadingElement, CardTitleProps>(
  ({ className, ...props }, ref) => (
    <h3 ref={ref} className={cn("ds-card__title", className)} {...props} />
  ),
);
CardTitle.displayName = "CardTitle";

export type CardLabelProps = HTMLAttributes<HTMLParagraphElement>;

/** Mono uppercase eyebrow label inside a Card. */
export const CardLabel = forwardRef<HTMLParagraphElement, CardLabelProps>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn("ds-label", className)} {...props} />
  ),
);
CardLabel.displayName = "CardLabel";
