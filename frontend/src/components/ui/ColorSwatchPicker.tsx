"use client";

import { Check } from "lucide-react";

/**
 * Compact palette picker for stored hex colors. Status enums use StatusBadge;
 * this control is for editable colors such as matter and lead pipeline stages.
 */
export default function ColorSwatchPicker({
  colors,
  value,
  onChange,
  size = "md",
  showCheck = true,
}: {
  colors: readonly string[];
  value: string | null;
  onChange: (color: string) => void;
  size?: "sm" | "md";
  showCheck?: boolean;
}) {
  const sizeClass = size === "sm" ? "h-6 w-6" : "h-7 w-7";

  return (
    <div className="flex flex-wrap items-center gap-2">
      {colors.map((color) => {
        const selected = value === color;
        return (
          <button
            key={color}
            type="button"
            onClick={() => onChange(color)}
            className={`flex ${sizeClass} items-center justify-center rounded-full transition-transform hover:scale-110 cursor-pointer ${
              selected
                ? "ring-2 ring-offset-2 ring-offset-[color:var(--surface)] ring-on-surface-muted"
                : ""
            }`}
            style={{ backgroundColor: color }}
            aria-label={`Color ${color}`}
            aria-pressed={selected}
          >
            {selected && showCheck ? <Check size={14} className="text-white" /> : null}
          </button>
        );
      })}
    </div>
  );
}
