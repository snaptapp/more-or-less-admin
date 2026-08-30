import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../lib/cn";

export type AnswerChoice = "more" | "less" | "skip";

export interface AnswerButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Which answer this control commits. */
  choice: AnswerChoice;
}

/** Oversized round-answer control for the play surface. */
export const AnswerButton = forwardRef<HTMLButtonElement, AnswerButtonProps>(
  ({ choice, className, type = "button", children, ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn("ds-answer", "ds-focusable", `ds-answer--${choice}`, className)}
      {...props}
    >
      {children ?? choice}
    </button>
  ),
);
AnswerButton.displayName = "AnswerButton";
