"use client";

import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import type { ThemePreference } from "@/types/preferences";

const THEME_OPTIONS: Array<{
  value: ThemePreference;
  label: string;
  Icon: LucideIcon;
}> = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
];

/**
 * Shared light/dark/system chooser for app settings surfaces. This owns only
 * the visual control; persistence remains with the law-firm or client caller.
 */
export default function ThemeSelector({
  value,
  onChange,
  includeSystem = true,
  disabled = false,
}: {
  value: ThemePreference;
  onChange: (value: ThemePreference) => void;
  includeSystem?: boolean;
  disabled?: boolean;
}) {
  const options = includeSystem
    ? THEME_OPTIONS
    : THEME_OPTIONS.filter((option) => option.value !== "system");

  return (
    <div className="flex gap-3">
      {options.map(({ value: optionValue, label, Icon }) => {
        const active = value === optionValue;
        return (
          <button
            key={optionValue}
            type="button"
            onClick={() => onChange(optionValue)}
            disabled={disabled}
            aria-pressed={active}
            className={[
              "flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed",
              active
                ? "bg-accent-solid border border-accent-solid text-accent-foreground shadow-sm"
                : "bg-surface border border-outline text-on-surface-secondary hover:border-accent-border-soft hover:shadow-md",
            ].join(" ")}
          >
            <Icon size={16} strokeWidth={active ? 2.2 : 1.8} />
            {label}
          </button>
        );
      })}
    </div>
  );
}
