"use client";

import Tooltip from "@/components/ui/Tooltip";
import { Check } from "lucide-react";
import { FOLDER_COLORS } from "./folderColors";

interface FolderColorPickerProps {
  /** Currently selected color key (e.g. "amber"). */
  value: string;
  onChange: (colorKey: string) => void;
}

// Shared swatch row for choosing a folder's color. Used by every file surface
// (matter/task file manager, the firm-wide Files page) so the available colors
// and the chosen color's meaning stay identical everywhere. Renders as a compact
// row of solid color dots rather than large labeled boxes.
export default function FolderColorPicker({ value, onChange }: FolderColorPickerProps) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      {Object.entries(FOLDER_COLORS).map(([colorKey, color]) => {
        const selected = value === colorKey;
        return (
          <Tooltip key={colorKey} title={colorKey.charAt(0).toUpperCase() + colorKey.slice(1)} enterDelay={300}>
            <button
              type="button"
              aria-label={colorKey}
              aria-pressed={selected}
              onClick={() => onChange(colorKey)}
              className={`flex h-7 w-7 items-center justify-center rounded-full ${color.swatch} transition-transform hover:scale-110 cursor-pointer ring-offset-2 ring-offset-surface ${
                selected ? `ring-2 ${color.ring}` : "ring-0"
              }`}
            >
              {selected && <Check size={14} strokeWidth={3} className="text-white drop-shadow" />}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
