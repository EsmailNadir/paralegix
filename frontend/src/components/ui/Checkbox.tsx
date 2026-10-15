"use client";

import React, { useId } from "react";

interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** When provided the component renders its own <label> wrapping the box + text. */
  label?: React.ReactNode;
  /** Secondary text below the label. Only rendered when label is also provided. */
  description?: React.ReactNode;
  disabled?: boolean;
  /** Applied to the <label> wrapper when label is given, or to the box div otherwise. */
  className?: string;
  id?: string;
  /** Box size. "sm" (16px) is the default; "md" (20px) gives a larger, easier hit target. */
  size?: "sm" | "md";
}

/**
 * Custom-styled checkbox. Two usage modes:
 *
 *   // Standalone - renders its own <label>:
 *   <Checkbox checked={x} onChange={setX} label="Billable" />
 *
 *   // Box-only - drop inside an existing <label> instead of a native <input>:
 *   <label className="flex items-center gap-2 ...">
 *     <Checkbox checked={x} onChange={setX} />
 *     <span>Name</span>
 *   </label>
 */
export default function Checkbox({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  className,
  id: providedId,
  size = "sm",
}: CheckboxProps) {
  const autoId = useId();
  const id = providedId ?? autoId;
  const boxSize = size === "md" ? "w-5 h-5" : "w-4 h-4";
  const check = size === "md" ? { w: "11", h: "9", vb: "0 0 11 9", d: "M1.25 4.5L4.25 7.5L9.75 1.5" } : { w: "9", h: "7", vb: "0 0 9 7", d: "M1 3L3.5 5.5L8 1" };

  const box = (
    <div
      className={[
        `relative shrink-0 ${boxSize} rounded`,
        "focus-within:ring-2 focus-within:ring-accent-control-ring focus-within:ring-offset-1",
        "focus-within:ring-offset-[color:var(--surface)]",
        label === undefined && description === undefined ? className : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* visual layer */}
      <div
        aria-hidden="true"
        className={[
          `${boxSize} rounded flex items-center justify-center transition-colors duration-150 border pointer-events-none`,
          checked
            ? "bg-accent-selection border-accent-selection"
            : "bg-input-bg border-input-border",
        ].join(" ")}
      >
        {checked && (
          <svg
            width={check.w}
            height={check.h}
            viewBox={check.vb}
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="pointer-events-none"
          >
            <path
              d={check.d}
              stroke="var(--accent-foreground)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </div>
      {/* native input - transparent, sits on top to capture all pointer/keyboard events */}
      <input
        type="checkbox"
        id={label !== undefined ? id : undefined}
        checked={checked}
        disabled={disabled}
        onChange={(e) => {
          if (disabled) return;
          onChange(e.target.checked);
        }}
        className={[
          "absolute inset-0 w-full h-full opacity-0",
          disabled ? "cursor-not-allowed" : "cursor-pointer",
        ].join(" ")}
      />
    </div>
  );

  if (label !== undefined || description !== undefined) {
    return (
      <label
        htmlFor={id}
        className={[
          "flex items-center gap-2.5",
          disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {box}
        <span className="flex flex-col">
          {label !== undefined && (
            <span className="text-sm text-on-surface select-none leading-tight">
              {label}
            </span>
          )}
          {description !== undefined && (
            <span className="text-xs text-on-surface-muted mt-0.5 leading-normal">
              {description}
            </span>
          )}
        </span>
      </label>
    );
  }

  return box;
}
