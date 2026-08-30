import { forwardRef, useId, type InputHTMLAttributes } from "react";
import { cn } from "../lib/cn";

export interface CodeInputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Accessible label; rendered visually unless `hideLabel`. */
  label: string;
  /** Hide the label visually while keeping it for assistive tech. */
  hideLabel?: boolean;
  /** Error message; also marks the field invalid. */
  error?: string;
}

/** Mono text field used for room codes, custom topics, and search. */
export const CodeInput = forwardRef<HTMLInputElement, CodeInputProps>(
  ({ label, hideLabel = false, error, className, id, ...props }, ref) => {
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const errorId = `${inputId}-error`;

    return (
      <div className="ds-field">
        <label
          htmlFor={inputId}
          className="ds-label"
          style={hideLabel ? { position: "absolute", clip: "rect(0 0 0 0)", width: 1, height: 1, overflow: "hidden" } : undefined}
        >
          {label}
        </label>
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={cn("ds-input", "ds-focusable", className)}
          {...props}
        />
        {error ? (
          <p id={errorId} className="ds-label" style={{ color: "var(--ds-arena-color-red)" }}>
            {error}
          </p>
        ) : null}
      </div>
    );
  },
);
CodeInput.displayName = "CodeInput";
