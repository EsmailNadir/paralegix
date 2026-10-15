// Shared types and option constants for the template editor and its toolbar/ruler
// sub-components. Kept in a neutral module so the leaf components and the main
// editor can both import them without creating a circular dependency.

export const LINE_SPACING_OPTIONS = [
  { value: "1", label: "Single" },
  { value: "1.15", label: "1.15" },
  { value: "1.5", label: "1.5" },
  { value: "2", label: "Double" },
] as const;

export const TEXT_ALIGN_OPTIONS = [
  { value: "left", label: "Align left" },
  { value: "center", label: "Center" },
  { value: "right", label: "Align right" },
  { value: "justify", label: "Justify" },
] as const;

export type ToolbarStyleState = {
  fontFamily: string;
  fontSize: number;
  lineHeight: string;
  spaceBefore: number;
  spaceAfter: number;
  textAlign: string;
  isLink: boolean;
  isBold: boolean;
  isItalic: boolean;
  isUnderline: boolean;
  isBulletList: boolean;
  isNumberedList: boolean;
  color: string;
};

export type ActiveParagraphMetrics = {
  id: string;
  // Display bounds for the ruler bar. May be expanded to the widest sibling in
  // the paragraph's column so short lines still show a full-width bar.
  left: number;
  width: number;
  // The paragraph's real DOM bounds. Barrier drags must start from these:
  // dragging from the expanded display bounds would stamp another sibling's
  // left/width onto the paragraph and visibly move it.
  actualLeft: number;
  actualWidth: number;
  pageWidth: number;
};
