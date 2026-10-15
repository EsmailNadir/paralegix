"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bold, Italic, List, ChevronDown, AlignLeft, AlignCenter, AlignRight, Pipette, Redo2, Undo2 } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import Dropdown from "@/components/ui/Dropdown";
import { useMountTransition } from "@/hooks/useMountTransition";
import { menuAnim } from "@/components/ui/transitionClasses";
import type { FontSample } from "@/lib/pdfFontSampling";
import { OVERLAY_FONT_SIZES, type PlacementStyleDraft } from "./templateOverlayTypes";

const FONT_FAMILY_OPTIONS = [
  { value: "times", label: "Times New Roman" },
  { value: "cambria", label: "Cambria" },
  { value: "pt-serif", label: "PT Serif" },
  { value: "helvetica", label: "Helvetica" },
  { value: "calibri", label: "Calibri" },
  { value: "pt-sans", label: "PT Sans" },
  { value: "courier", label: "Courier New" },
];

const AUTO_SIZE = "auto";

/** The size list, with the box's own size added when it is not one of the
 *  presets: a size matched from the document's text (10.5pt, say) has to
 *  stay visible in the control, or the control would read as blank. */
function fontSizeOptions(current: number | null) {
  const sizes: number[] = [...OVERLAY_FONT_SIZES];
  if (current != null && !sizes.includes(current)) sizes.push(current);
  sizes.sort((a, b) => a - b);
  return [{ value: AUTO_SIZE, label: "Auto" }, ...sizes.map((size) => ({ value: String(size), label: String(size) }))];
}

const TEXT_ALIGN_OPTIONS = [
  { value: "left", label: "Align left" },
  { value: "center", label: "Align center" },
  { value: "right", label: "Align right" },
];

/**
 * Font family/size/bold/italic/alignment/color for the selected placement,
 * laid out as the same persistent toolbar row `TemplateFormattingToolbar`
 * gives the full HTML editor rather than a popover on the box itself.
 * Always present (so this part of the chrome never changes height); every
 * control disables itself when nothing styleable is selected. Undo/redo,
 * links, underline and paragraph spacing have no equivalent for a
 * fixed-position box on a stamped PDF, so unlike the full editor's bar this
 * one only carries the controls that actually apply. Helvetica/Times/Courier
 * are pdf-lib's built-in fonts; the rest are real fonts the stamping path
 * fontkit-embeds (see `backend/src/modules/templates/fonts`).
 *
 * Font family/size/alignment always drive the whole selected placement's
 * style (`onChange`/`SET_STYLE`): those stay whole-box properties even for
 * a rich text box. Bold/italic/color/bullet do too UNLESS `richEditing` is
 * true (the selected placement is a 'textbox' currently being edited): then
 * they act on the live text selection inside that box instead
 * (`onRichCommand`, routed by the caller to the box's imperative handle),
 * and their active state reflects the caret's own formatting (`richFormat`)
 * rather than the whole placement's. "Bullet" isn't real list markup (a
 * rich run is plain styled text, not HTML): it's a per-paragraph flag,
 * rendered as a bullet prefix on that paragraph's first wrapped line, same
 * transform on the canvas preview and the PDF stamp.
 *
 * A chosen size is a maximum: text that does not fit the box shrinks. The
 * size the text actually renders at (`fittedSize`) is shown beside the
 * control whenever it is smaller, so a box set to 14 that prints at 9 says
 * so instead of looking like a 14 that came out small.
 */
export default function TemplateOverlayFormattingBar({
  style,
  onChange,
  richEditing = false,
  richFormat,
  onRichCommand,
  onRichPrepare,
  sample = null,
  fittedSize = null,
  onMatchSample,
  sampleHint = false,
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
}: {
  style: PlacementStyleDraft | null;
  onChange: (next: Partial<PlacementStyleDraft>) => void;
  /** The size the selected box's text renders at after fitting, or null when
   *  it has nothing to fit. */
  fittedSize?: number | null;
  /** Applies the sampled font (family, size, weight, slant) to the selected
   *  box. Offered only while both a sample and a styleable box exist. */
  onMatchSample?: () => void;
  /** True while the reader can sample (Select mode) and nothing is sampled
   *  yet, so the bar can say how. */
  sampleHint?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  /** True when the selected placement is a 'textbox' currently in edit mode
   *  (a live contentEditable selection to route bold/italic/color/bullet to). */
  richEditing?: boolean;
  richFormat?: { bold: boolean; italic: boolean; color: string; bulletActive: boolean };
  onRichCommand?: (command: "bold" | "italic" | "foreColor" | "bullet", value?: string) => void;
  /** Called on a rich-mode button's mousedown, before the click, so the
   *  box's contentEditable selection is snapshotted while it's still live:
   *  needed because opening the color input (and, on some browsers, even a
   *  plain button click) can otherwise steal focus and collapse it first. */
  onRichPrepare?: () => void;
  /** The font behind the reader's own text selection in the underlying PDF,
   *  shown read-only so a new box can be set to match what is already on the
   *  page. Null when nothing in the document is selected. */
  sample?: FontSample | null;
}) {
  const disabled = !style;
  const effective: PlacementStyleDraft = style ?? {
    fontSize: null,
    fontFamily: "times",
    bold: false,
    italic: false,
    color: "#000000",
    textAlign: "left",
    bulletList: false,
  };
  const boldActive = richEditing ? Boolean(richFormat?.bold) : effective.bold;
  const italicActive = richEditing ? Boolean(richFormat?.italic) : effective.italic;
  const bulletActive = richEditing ? Boolean(richFormat?.bulletActive) : effective.bulletList;
  const colorActive = richEditing ? (richFormat?.color ?? effective.color) : effective.color;
  const richButtonProps = richEditing ? { onMouseDown: (e: React.MouseEvent) => { e.preventDefault(); onRichPrepare?.(); } } : {};

  const showFitted = style != null
    && fittedSize != null
    && (style.fontSize == null || fittedSize < style.fontSize);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <ToolbarIconButton label="Undo" active={false} disabled={!canUndo} onClick={() => onUndo?.()}>
        <Undo2 size={14} />
      </ToolbarIconButton>
      <ToolbarIconButton label="Redo" active={false} disabled={!canRedo} onClick={() => onRedo?.()}>
        <Redo2 size={14} />
      </ToolbarIconButton>

      <div className="w-px h-5 bg-outline mx-1" />

      <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-on-surface-muted">
        Font
      </span>
      <Dropdown
        portal
        disabled={disabled}
        value={effective.fontFamily}
        onChange={(value) => onChange({ fontFamily: value as PlacementStyleDraft["fontFamily"] })}
        options={FONT_FAMILY_OPTIONS}
        title="Font family"
        ariaLabel="Font family"
        className="min-w-[148px]"
        buttonClassName="h-8 rounded-md border-input-border bg-input-bg px-2 text-xs"
      />

      <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-on-surface-muted">
        Size
      </span>
      <Dropdown
        portal
        disabled={disabled}
        value={effective.fontSize == null ? AUTO_SIZE : String(effective.fontSize)}
        onChange={(value) => onChange({ fontSize: value === AUTO_SIZE ? null : Number(value) })}
        options={fontSizeOptions(effective.fontSize)}
        title="Font size"
        ariaLabel="Font size"
        className="w-[84px]"
        buttonClassName="h-8 rounded-md border-input-border bg-input-bg px-2 text-xs"
      />
      {showFitted && (
        <Tooltip
          title={style.fontSize == null
            ? "The automatic size this box's text renders at"
            : "The text does not fit the box at the chosen size, so it renders smaller. Enlarge the box or shorten the text to get the chosen size."}
          enterDelay={300}
        >
          <span className="text-[11px] tabular-nums text-on-surface-muted" data-testid="fitted-size">
            fits at {fittedSize}
          </span>
        </Tooltip>
      )}

      <AlignmentDropdown
        disabled={disabled}
        value={effective.textAlign}
        onChange={(value) => onChange({ textAlign: value as PlacementStyleDraft["textAlign"] })}
      />

      <ToolbarIconButton
        label="Bold"
        active={boldActive}
        disabled={disabled}
        onClick={() => (richEditing ? onRichCommand?.("bold") : onChange({ bold: !effective.bold }))}
        {...richButtonProps}
      >
        <Bold size={14} />
      </ToolbarIconButton>

      <ToolbarIconButton
        label="Italic"
        active={italicActive}
        disabled={disabled}
        onClick={() => (richEditing ? onRichCommand?.("italic") : onChange({ italic: !effective.italic }))}
        {...richButtonProps}
      >
        <Italic size={14} />
      </ToolbarIconButton>

      <ToolbarIconButton
        label="Bullet list"
        active={bulletActive}
        disabled={disabled}
        onClick={() => (richEditing ? onRichCommand?.("bullet") : onChange({ bulletList: !effective.bulletList }))}
        {...richButtonProps}
      >
        <List size={14} />
      </ToolbarIconButton>

      <div className="w-px h-5 bg-outline mx-1" />

      <ColorButton
        disabled={disabled}
        color={colorActive}
        onPrepare={richEditing ? onRichPrepare : undefined}
        onChange={(color) => (richEditing ? onRichCommand?.("foreColor", color) : onChange({ color }))}
      />

      {!sample && sampleHint && (
        <>
          <div className="w-px h-5 bg-outline mx-1" />
          <span className="text-[11px] text-on-surface-muted">
            Click or select text in the document to read its font
          </span>
        </>
      )}

      {sample && (
        <>
          <div className="w-px h-5 bg-outline mx-1" />
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-on-surface-muted">
            Selected text
          </span>
          <SampleSlot
            value={sample.familyLabel}
            className="min-w-[116px]"
            title={
              sample.family
                ? `Font of the highlighted text. Closest stampable family: ${FONT_FAMILY_LABELS[sample.family]}`
                : "The highlighted text uses more than one font"
            }
          />
          <SampleSlot
            value={sample.sizePt == null ? null : `${sample.sizePt} pt`}
            className="w-[62px]"
            title={sample.sizePt == null ? "The highlighted text uses more than one size" : "Size of the highlighted text"}
          />
          <SampleSlot
            value={sampleStyleLabel(sample)}
            className="w-[86px]"
            title={sampleStyleLabel(sample) == null ? "The highlighted text mixes weights or slants" : "Weight and slant of the highlighted text"}
          />
          <Tooltip
            title={disabled
              ? "Select a text, date or text box field to give it this font"
              : "Set the selected box to the sampled font, size, weight and slant"}
            enterDelay={300}
          >
            <button
              type="button"
              disabled={disabled}
              onClick={() => onMatchSample?.()}
              aria-label="Match selected text"
              className="inline-flex items-center gap-1.5 h-8 px-2 rounded-md border border-outline bg-surface text-xs font-medium text-on-surface hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              <Pipette size={13} /> Match
            </button>
          </Tooltip>
        </>
      )}
    </div>
  );
}

/** The dropdown label for each stampable family, so the sampled font's tooltip
 *  can name the option the reader would have to pick to match it. */
const FONT_FAMILY_LABELS: Record<string, string> = Object.fromEntries(
  FONT_FAMILY_OPTIONS.map((option) => [option.value, option.label])
);

/**
 * Weight and slant as one word, or null when the selection mixes either of
 * them. Blanking on a mix of only one of the two is deliberate: "Bold" over a
 * selection whose slant varies would be read as "Bold, not italic".
 */
function sampleStyleLabel(sample: FontSample): string | null {
  if (sample.bold === null || sample.italic === null) return null;
  if (sample.bold && sample.italic) return "Bold italic";
  if (sample.bold) return "Bold";
  if (sample.italic) return "Italic";
  return "Regular";
}

/**
 * One read-only value from the sampled font, shaped like the bar's own
 * dropdowns so the group reads as part of the same row.
 *
 * A null value draws an empty slot rather than a placeholder. That is what a
 * word processor does for a selection spanning two fonts, and it is the only
 * honest answer: there is no single value to show, and picking the first run's
 * would quietly mislead someone trying to match it.
 */
function SampleSlot({ value, className, title }: { value: string | null; className: string; title: string }) {
  return (
    <Tooltip title={title} enterDelay={300}>
      <div className={`flex h-8 items-center truncate rounded-md border border-input-border bg-input-bg px-2 text-xs text-on-surface ${className}`}>
        {value ?? ""}
      </div>
    </Tooltip>
  );
}

function AlignmentDropdown({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (textAlign: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { mounted, exiting } = useMountTransition(open, 150);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  return (
    <div ref={menuRef} className="relative">
      <Tooltip title="Text alignment" enterDelay={300}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-2 h-8 px-2 rounded-md border border-outline bg-surface text-on-surface hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
          aria-label="Text alignment"
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-on-surface-muted">
            Align
          </span>
          <AlignmentIcon value={value} className="h-4 w-4" />
          <ChevronDown className="h-3.5 w-3.5 text-on-surface-muted" />
        </button>
      </Tooltip>

      {mounted && !disabled ? (
        <div className={`absolute left-0 top-[calc(100%+8px)] z-20 flex gap-1 rounded-xl border border-outline bg-white p-2 shadow-xl dark:bg-surface-alt origin-top ${menuAnim(exiting)}`}>
          {TEXT_ALIGN_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => { onChange(option.value); setOpen(false); }}
              className={`inline-flex h-10 w-10 items-center justify-center rounded-lg border transition-colors cursor-pointer ${
                value === option.value
                  ? "border-blue-200 bg-blue-50 text-blue-700 dark:border-accent-control-ring/40 dark:bg-blue-500/15 dark:text-blue-300"
                  : "border-transparent text-on-surface-muted hover:bg-surface-hover hover:text-on-surface"
              }`}
              title={option.label}
              aria-label={option.label}
            >
              <AlignmentIcon value={option.value} className="h-5 w-5" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AlignmentIcon({ value, className }: { value: string; className?: string }) {
  if (value === "center") return <AlignCenter className={className} />;
  if (value === "right") return <AlignRight className={className} />;
  return <AlignLeft className={className} />;
}

function ColorButton({
  color,
  disabled,
  onPrepare,
  onChange,
}: {
  color: string;
  disabled: boolean;
  /** Opening the native color picker always steals focus, so a rich-mode
   *  caller snapshots the box's selection here first, restoring it once a
   *  color comes back from `onChange`. */
  onPrepare?: () => void;
  onChange: (color: string) => void;
}) {
  const colorInputRef = useRef<HTMLInputElement>(null);
  return (
    <Tooltip title="Text color" enterDelay={300}>
      <button
        type="button"
        disabled={disabled}
        onMouseDown={(e) => { if (!disabled) { e.preventDefault(); onPrepare?.(); colorInputRef.current?.click(); } }}
        className="inline-flex items-center gap-2 h-8 px-2 rounded-md border border-outline bg-surface text-on-surface hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
        aria-label="Text color"
      >
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-on-surface-muted">
          Color
        </span>
        <span className="w-4 h-4 rounded-full border border-outline" style={{ backgroundColor: color }} />
        <input
          ref={colorInputRef}
          type="color"
          value={color}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="sr-only"
          tabIndex={-1}
        />
      </button>
    </Tooltip>
  );
}

interface ToolbarIconButtonProps {
  active: boolean;
  disabled: boolean;
  label: string;
  onClick: () => void;
  onMouseDown?: (e: React.MouseEvent) => void;
  children: ReactNode;
}

function ToolbarIconButton({ active, disabled, label, onClick, onMouseDown, children }: ToolbarIconButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onMouseDown={onMouseDown}
      title={label}
      aria-label={label}
      className={`inline-flex items-center justify-center h-8 w-8 rounded-md border transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
        active
          ? "bg-accent-solid text-accent-foreground border-accent-control-ring"
          : "bg-surface text-on-surface border-outline hover:bg-surface-hover"
      }`}
    >
      {children}
    </button>
  );
}
