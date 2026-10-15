"use client";

import SegmentedToggle from "@/components/ui/SegmentedToggle";
import type { TemplateVersion } from "@/types/preferences";

const VERSION_OPTIONS: { value: TemplateVersion; label: string }[] = [
  { value: "overlay", label: "Overlay" },
  { value: "full-editor", label: "Full editor" },
  { value: "word-first", label: "Word-first (JJ)" },
];

/**
 * Picks which template experience the Templates page shows: Document Overlay
 * uploads, the full HTML / DOCX editor, or the Word-first library. Rendered in
 * the header of every version, so the person can always switch back.
 */
export default function TemplateVersionToggle({
  value,
  onChange,
}: {
  value: TemplateVersion;
  onChange: (next: TemplateVersion) => void;
}) {
  return (
    <SegmentedToggle
      ariaLabel="Template version"
      options={VERSION_OPTIONS}
      value={value}
      onChange={onChange}
    />
  );
}
