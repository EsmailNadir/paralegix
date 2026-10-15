"use client";

import { useEffect, useRef } from "react";
import { Plus, X } from "lucide-react";
import { FIELD_LABEL_BLOCK_CLS, FULL_INPUT_CLS } from "@/components/ui/inputClasses";

interface OptionListEditorProps {
  /** The choices, in display order. An empty list renders one blank row. */
  options: string[];
  onChange: (options: string[]) => void;
  /** Visible label above the rows, e.g. "Options *". */
  label?: string;
}

/**
 * Edits the choices of a dropdown field: one input per option, a remove button
 * on each row, and an "Add option" control. Enter in a row inserts a blank row
 * below it and moves focus there; Backspace in an empty row removes it and moves
 * focus to the row above. The last remaining row cannot be removed.
 */
export default function OptionListEditor({ options, onChange, label = "Options" }: OptionListEditorProps) {
  const rows = options.length > 0 ? options : [""];
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const focusIndex = useRef<number | null>(null);

  useEffect(() => {
    if (focusIndex.current === null) return;
    inputRefs.current[focusIndex.current]?.focus();
    focusIndex.current = null;
  });

  const setAt = (index: number, value: string) =>
    onChange(rows.map((o, i) => (i === index ? value : o)));

  const insertAfter = (index: number) => {
    focusIndex.current = index + 1;
    onChange([...rows.slice(0, index + 1), "", ...rows.slice(index + 1)]);
  };

  const removeAt = (index: number) => {
    if (rows.length === 1) return;
    onChange(rows.filter((_, i) => i !== index));
  };

  return (
    <div>
      <p className={FIELD_LABEL_BLOCK_CLS}>{label}</p>
      <div className="space-y-2">
        {rows.map((opt, index) => (
          <div key={index} className="flex items-center gap-2">
            <input
              ref={(el) => {
                inputRefs.current[index] = el;
              }}
              type="text"
              value={opt}
              onChange={(e) => setAt(index, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  insertAfter(index);
                } else if (e.key === "Backspace" && opt === "" && rows.length > 1) {
                  e.preventDefault();
                  focusIndex.current = Math.max(0, index - 1);
                  removeAt(index);
                }
              }}
              placeholder={`Option ${index + 1}`}
              aria-label={`Option ${index + 1}`}
              className={FULL_INPUT_CLS}
            />
            <button
              type="button"
              onClick={() => removeAt(index)}
              disabled={rows.length === 1}
              className="shrink-0 rounded-md border border-outline p-2 text-on-surface-muted hover:text-on-surface hover:bg-surface-hover transition-transform active:scale-[0.96] motion-reduce:active:scale-100 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              aria-label={`Remove option ${index + 1}`}
            >
              <X size={15} />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => insertAfter(rows.length - 1)}
        className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-accent-emphasis hover:text-accent-emphasis cursor-pointer"
      >
        <Plus size={14} /> Add option
      </button>
    </div>
  );
}
