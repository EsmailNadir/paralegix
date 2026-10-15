"use client";

import { Search } from "lucide-react";
import { INPUT_CLS } from "@/components/ui/inputClasses";

/** Full-width input matching `INPUT_CLS`, used by every text field in the
 *  file-picker modals (search, task filter, new-folder name). */
export const FILE_PICKER_INPUT_CLASS = `w-full ${INPUT_CLS}`;

/**
 * Search box shared by the "browse files and select" modals (`FilePickerModal`,
 * `MessageFilePicker`): a text input that submits on Enter or the button click.
 * Neither picker searches as-you-type, so there is no debounce to share here.
 */
export default function FilePickerSearchRow({
  value,
  onChange,
  onSubmit,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
}) {
  return (
    <div className="flex gap-2">
      <input
        className={FILE_PICKER_INPUT_CLASS}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onSubmit()}
        placeholder={placeholder}
      />
      <button
        onClick={onSubmit}
        className="px-3 py-2 rounded-md bg-surface-alt border border-outline hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
      >
        <Search size={16} className="text-on-surface-secondary" />
      </button>
    </div>
  );
}
