"use client";

import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import { STATUS_VARIANTS, type StatusVariant } from "@/constants/statusMeta";
import { useMountTransition } from "@/hooks/useMountTransition";
import { menuAnim } from "@/components/ui/transitionClasses";

const PICKABLE_VARIANTS: StatusVariant[] = [
  "neutral", "info", "success", "purple", "warning", "teal", "indigo", "pink", "cyan", "danger",
];

/**
 * Small swatch-button + popover for recoloring the currently selected note
 * type, opened from next to the Note Type dropdown. Mirrors FolderColorPicker's
 * compact dot-row, drawing from the shared StatusVariant palette instead of
 * FOLDER_COLORS since note types already carry a variant (statusMeta.ts).
 */
export default function NoteTypeColorPicker({
  value,
  onChange,
  disabled,
}: {
  value: StatusVariant;
  onChange: (variant: StatusVariant) => Promise<unknown> | void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Stays mounted through the 150ms menu exit, like every other popover menu.
  const { mounted, exiting } = useMountTransition(open, 150);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handlePick = async (variant: StatusVariant) => {
    if (variant === value) { setOpen(false); return; }
    setSaving(true);
    try {
      await onChange(variant);
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div ref={ref} className="relative shrink-0">
      <Tooltip title="Change note type color" enterDelay={300}>
        <button
          type="button"
          aria-label="Change note type color"
          aria-haspopup="true"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen((prev) => !prev)}
          className="flex h-full w-8 items-center justify-center rounded-lg border border-outline hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          <span className={`size-3 rounded-full ${STATUS_VARIANTS[value].dot}`} />
        </button>
      </Tooltip>
      {mounted && (
        <div className={`absolute right-0 z-20 mt-2 flex w-44 flex-wrap items-center gap-2.5 rounded-lg border border-outline bg-surface p-3 shadow-lg origin-top-right ${menuAnim(exiting)}`}>
          {PICKABLE_VARIANTS.map((variant) => {
            const selected = variant === value;
            return (
              <Tooltip key={variant} title={variant.charAt(0).toUpperCase() + variant.slice(1)} enterDelay={300}>
                <button
                  type="button"
                  aria-label={variant}
                  aria-pressed={selected}
                  disabled={saving}
                  onClick={() => handlePick(variant)}
                  className={`flex h-6 w-6 items-center justify-center rounded-full ${STATUS_VARIANTS[variant].dot} transition-transform hover:scale-110 cursor-pointer ring-offset-2 ring-offset-surface disabled:opacity-50 disabled:cursor-not-allowed ${
                    selected ? "ring-2 ring-on-surface/50" : "ring-0"
                  }`}
                >
                  {selected && <Check size={12} strokeWidth={3} className="text-white drop-shadow" />}
                </button>
              </Tooltip>
            );
          })}
        </div>
      )}
    </div>
  );
}
