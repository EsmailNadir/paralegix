"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Tooltip from "@/components/ui/Tooltip";
import {
  Undo2,
  Redo2,
  UnfoldVertical,
  Minus,
  Plus,
  Link2,
  Bold,
  Italic,
  Underline,
  List,
  ListOrdered,
  ChevronDown,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
} from "lucide-react";
import Dropdown from "@/components/ui/Dropdown";
import { useMountTransition } from "@/hooks/useMountTransition";
import { menuAnim } from "@/components/ui/transitionClasses";
import { FONT_FAMILIES, FONT_SIZES } from "@/types/signature";
import { LINE_SPACING_OPTIONS, TEXT_ALIGN_OPTIONS, type ToolbarStyleState } from "./templateEditorTypes";

interface TemplateFormattingToolbarProps {
  styleState: ToolbarStyleState;
  onToolbarButtonMouseDown: (e: React.MouseEvent) => void;
  onToolbarControlMouseDown: (e: React.MouseEvent) => void;
  onUndo: () => void;
  onRedo: () => void;
  onFontFamilyChange: (fontFamily: string) => void;
  onFontSizeChange: (fontSize: number) => void;
  onLineSpacingChange: (lineHeight: string) => void;
  onSpaceBeforeChange: (value: number) => void;
  onSpaceAfterChange: (value: number) => void;
  onTextAlignChange: (textAlign: string) => void;
  onInsertLink: () => void;
  onBoldToggle: () => void;
  onItalicToggle: () => void;
  onUnderlineToggle: () => void;
  onBulletListToggle: () => void;
  onNumberedListToggle: () => void;
  onColorChange: (color: string) => void;
}

export function TemplateFormattingToolbar({
  styleState,
  onToolbarButtonMouseDown,
  onToolbarControlMouseDown,
  onUndo,
  onRedo,
  onFontFamilyChange,
  onFontSizeChange,
  onLineSpacingChange,
  onSpaceBeforeChange,
  onSpaceAfterChange,
  onTextAlignChange,
  onInsertLink,
  onBoldToggle,
  onItalicToggle,
  onUnderlineToggle,
  onBulletListToggle,
  onNumberedListToggle,
  onColorChange,
}: TemplateFormattingToolbarProps) {
  const colorInputRef = useRef<HTMLInputElement>(null);
  const spacingPopoutRef = useRef<HTMLDivElement>(null);
  const [showSpacingPopout, setShowSpacingPopout] = useState(false);
  const isCustomSpacing = !LINE_SPACING_OPTIONS.some((o) => o.value === styleState.lineHeight);
  const [customSpacingInput, setCustomSpacingInput] = useState(isCustomSpacing ? styleState.lineHeight : "");
  const [showCustomInput, setShowCustomInput] = useState(isCustomSpacing);
  const { mounted: spacingMounted, exiting: spacingExiting } = useMountTransition(showSpacingPopout, 150);

  useEffect(() => {
    if (isCustomSpacing) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs the user-editable custom-spacing input to the incoming line-height style
      setShowCustomInput(true);
      setCustomSpacingInput(styleState.lineHeight);
    } else {
      setShowCustomInput(false);
      setCustomSpacingInput("");
    }
  }, [styleState.lineHeight, isCustomSpacing]);

  // Close spacing popout on outside click
  useEffect(() => {
    if (!showSpacingPopout) return;
    const handleClick = (e: MouseEvent) => {
      if (spacingPopoutRef.current && !spacingPopoutRef.current.contains(e.target as Node)) {
        setShowSpacingPopout(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showSpacingPopout]);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <ToolbarIconButton
        label="Undo"
        active={false}
        onMouseDown={onToolbarButtonMouseDown}
        onClick={onUndo}
      >
        <Undo2 size={14} />
      </ToolbarIconButton>

      <ToolbarIconButton
        label="Redo"
        active={false}
        onMouseDown={onToolbarButtonMouseDown}
        onClick={onRedo}
      >
        <Redo2 size={14} />
      </ToolbarIconButton>

      <div className="w-px h-5 bg-outline mx-1" />

      <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-on-surface-muted">
        Font
      </span>
      <Dropdown
        portal
        value={styleState.fontFamily}
        onMouseDown={onToolbarControlMouseDown}
        onChange={onFontFamilyChange}
        options={FONT_FAMILIES.map((font) => ({
          value: font.value,
          label: font.label,
        }))}
        title="Font family"
        aria-label="Font family"
        className="min-w-[148px]"
        buttonClassName="h-8 rounded-md border-input-border bg-input-bg px-2 text-xs"
      />

      <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-on-surface-muted">
        Size
      </span>
      <Dropdown
        portal
        value={String(styleState.fontSize)}
        onMouseDown={onToolbarControlMouseDown}
        onChange={(value) => onFontSizeChange(Number(value))}
        options={FONT_SIZES.map((size) => ({
          value: String(size),
          label: `${size}px`,
        }))}
        title="Font size"
        aria-label="Font size"
        className="w-[84px]"
        buttonClassName="h-8 rounded-md border-input-border bg-input-bg px-2 text-xs"
      />

      {/* ─── Spacing popout ─────────────────────────────────── */}
      <div className="relative" ref={spacingPopoutRef}>
        <Tooltip title="Line & paragraph spacing" enterDelay={300}>
          <button
            type="button"
            onMouseDown={onToolbarButtonMouseDown}
            onClick={() => setShowSpacingPopout((prev) => !prev)}
            aria-label="Line & paragraph spacing"
            className={`inline-flex items-center justify-center h-8 w-8 rounded-md border transition-colors cursor-pointer ${
              showSpacingPopout
                ? "bg-accent-solid text-accent-foreground border-accent-control-ring"
                : "bg-surface text-on-surface border-outline hover:bg-surface-hover"
            }`}
          >
            <UnfoldVertical size={14} />
          </button>
        </Tooltip>

        {spacingMounted && (
          <div className={`absolute top-full left-0 mt-1.5 z-50 w-[272px] rounded-xl border border-outline bg-surface shadow-xl p-4 space-y-4 origin-top ${menuAnim(spacingExiting)}`}>
            {/* Line spacing */}
            <div>
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-on-surface-muted mb-2 block">
                Line Spacing
              </span>
              <div className="grid grid-cols-4 gap-1.5">
                {LINE_SPACING_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onMouseDown={onToolbarButtonMouseDown}
                    onClick={() => {
                      setShowCustomInput(false);
                      setCustomSpacingInput("");
                      onLineSpacingChange(option.value);
                    }}
                    className={`px-1 py-1.5 rounded-md text-[11px] font-medium transition-colors cursor-pointer border text-center truncate ${
                      !showCustomInput && styleState.lineHeight === option.value
                        ? "bg-accent-solid text-accent-foreground border-accent-solid shadow-sm"
                        : "bg-input-bg text-on-surface border-outline-subtle hover:border-outline hover:bg-surface-hover"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onMouseDown={onToolbarButtonMouseDown}
                  onClick={() => {
                    setShowCustomInput(true);
                    setCustomSpacingInput(styleState.lineHeight);
                  }}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-semibold uppercase tracking-wide transition-colors cursor-pointer border ${
                    showCustomInput
                      ? "bg-accent-solid text-accent-foreground border-accent-solid shadow-sm"
                      : "bg-input-bg text-on-surface-muted border-outline-subtle hover:border-outline hover:bg-surface-hover"
                  }`}
                >
                  Custom
                </button>
                {showCustomInput && (
                  <Tooltip title="Custom line spacing" enterDelay={300}>
                    <input
                      type="number"
                      min="0.5"
                      max="5"
                      step="0.05"
                      value={customSpacingInput}
                      onMouseDown={onToolbarControlMouseDown}
                      onChange={(e) => setCustomSpacingInput(e.target.value)}
                      onBlur={(e) => {
                        const val = Number.parseFloat(e.target.value.trim());
                        if (Number.isFinite(val) && val >= 0.5 && val <= 5) {
                          onLineSpacingChange(String(Math.round(val * 100) / 100));
                        } else {
                          setCustomSpacingInput(styleState.lineHeight);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                      aria-label="Custom line spacing"
          className="h-7 w-[66px] rounded-md border border-input-border bg-input-bg px-2 text-center text-xs text-on-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                    />
                  </Tooltip>
                )}
              </div>
            </div>

            <div className="h-px bg-outline-subtle" />

            {/* Paragraph spacing */}
            <div>
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-on-surface-muted mb-2 block">
                Paragraph Spacing
              </span>
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-on-surface-secondary">Before</span>
      <div className="inline-flex h-7 items-center overflow-hidden rounded-md border border-input-border bg-input-bg">
                    <button
                      type="button"
                      onMouseDown={onToolbarButtonMouseDown}
                      onClick={() => onSpaceBeforeChange(Math.max(0, styleState.spaceBefore - 2))}
                      className="w-7 h-full flex items-center justify-center text-on-surface-muted hover:text-on-surface hover:bg-surface-hover transition-colors cursor-pointer"
                    >
                      <Minus size={12} />
                    </button>
                    <Tooltip title="Space before (px)" enterDelay={300}>
                      <input
                        type="number"
                        min="0"
                        max="200"
                        step="1"
                        value={Math.round(styleState.spaceBefore)}
                        onMouseDown={onToolbarControlMouseDown}
                        onChange={(e) => {
                          const val = Number.parseFloat(e.target.value);
                          if (Number.isFinite(val) && val >= 0) onSpaceBeforeChange(val);
                        }}
                        aria-label="Space before paragraph"
            className="h-full w-[38px] border-x border-input-border bg-transparent text-center text-xs text-on-surface focus:outline-none"
                      />
                    </Tooltip>
                    <button
                      type="button"
                      onMouseDown={onToolbarButtonMouseDown}
                      onClick={() => onSpaceBeforeChange(styleState.spaceBefore + 2)}
                      className="w-7 h-full flex items-center justify-center text-on-surface-muted hover:text-on-surface hover:bg-surface-hover transition-colors cursor-pointer"
                    >
                      <Plus size={12} />
                    </button>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-on-surface-secondary">After</span>
      <div className="inline-flex h-7 items-center overflow-hidden rounded-md border border-input-border bg-input-bg">
                    <button
                      type="button"
                      onMouseDown={onToolbarButtonMouseDown}
                      onClick={() => onSpaceAfterChange(Math.max(0, styleState.spaceAfter - 2))}
                      className="w-7 h-full flex items-center justify-center text-on-surface-muted hover:text-on-surface hover:bg-surface-hover transition-colors cursor-pointer"
                    >
                      <Minus size={12} />
                    </button>
                    <Tooltip title="Space after (px)" enterDelay={300}>
                      <input
                        type="number"
                        min="0"
                        max="200"
                        step="1"
                        value={Math.round(styleState.spaceAfter)}
                        onMouseDown={onToolbarControlMouseDown}
                        onChange={(e) => {
                          const val = Number.parseFloat(e.target.value);
                          if (Number.isFinite(val) && val >= 0) onSpaceAfterChange(val);
                        }}
                        aria-label="Space after paragraph"
            className="h-full w-[38px] border-x border-input-border bg-transparent text-center text-xs text-on-surface focus:outline-none"
                      />
                    </Tooltip>
                    <button
                      type="button"
                      onMouseDown={onToolbarButtonMouseDown}
                      onClick={() => onSpaceAfterChange(styleState.spaceAfter + 2)}
                      className="w-7 h-full flex items-center justify-center text-on-surface-muted hover:text-on-surface hover:bg-surface-hover transition-colors cursor-pointer"
                    >
                      <Plus size={12} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <AlignmentDropdown
        value={styleState.textAlign}
        onMouseDown={onToolbarButtonMouseDown}
        onChange={onTextAlignChange}
      />

      <ToolbarIconButton
        label="Insert link"
        active={styleState.isLink}
        onMouseDown={onToolbarButtonMouseDown}
        onClick={onInsertLink}
      >
        <Link2 size={14} />
      </ToolbarIconButton>

      <ToolbarIconButton
        label="Bold"
        active={styleState.isBold}
        onMouseDown={onToolbarButtonMouseDown}
        onClick={onBoldToggle}
      >
        <Bold size={14} />
      </ToolbarIconButton>

      <ToolbarIconButton
        label="Italic"
        active={styleState.isItalic}
        onMouseDown={onToolbarButtonMouseDown}
        onClick={onItalicToggle}
      >
        <Italic size={14} />
      </ToolbarIconButton>

      <ToolbarIconButton
        label="Underline"
        active={styleState.isUnderline}
        onMouseDown={onToolbarButtonMouseDown}
        onClick={onUnderlineToggle}
      >
        <Underline size={14} />
      </ToolbarIconButton>

      <div className="w-px h-5 bg-outline mx-1" />

      <ToolbarIconButton
        label="Bullet list"
        active={styleState.isBulletList}
        onMouseDown={onToolbarButtonMouseDown}
        onClick={onBulletListToggle}
      >
        <List size={14} />
      </ToolbarIconButton>

      <ToolbarIconButton
        label="Numbered list"
        active={styleState.isNumberedList}
        onMouseDown={onToolbarButtonMouseDown}
        onClick={onNumberedListToggle}
      >
        <ListOrdered size={14} />
      </ToolbarIconButton>

      <div className="w-px h-5 bg-outline mx-1" />

      <Tooltip title="Text color" enterDelay={300}>
        <button
          type="button"
          onMouseDown={(e) => {
            onToolbarButtonMouseDown(e);
            colorInputRef.current?.click();
          }}
          className="inline-flex items-center gap-2 h-8 px-2 rounded-md border border-outline bg-surface text-on-surface hover:bg-surface-hover transition-colors cursor-pointer"
          aria-label="Text color"
        >
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-on-surface-muted">
          Color
        </span>
        <span
          className="w-4 h-4 rounded-full border border-outline"
          style={{ backgroundColor: styleState.color }}
        />
        <input
          ref={colorInputRef}
          type="color"
          value={styleState.color}
          onChange={(e) => onColorChange(e.target.value)}
          className="sr-only"
          tabIndex={-1}
        />
      </button>
      </Tooltip>
    </div>
  );
}

function AlignmentDropdown({
  value,
  onMouseDown,
  onChange,
}: {
  value: string;
  onMouseDown: (e: React.MouseEvent) => void;
  onChange: (textAlign: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { mounted, exiting } = useMountTransition(open, 150);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  return (
    <div ref={menuRef} className="relative">
      <Tooltip title="Paragraph alignment" enterDelay={300}>
        <button
          type="button"
          onMouseDown={(event) => {
            onMouseDown(event);
            setOpen((current) => !current);
          }}
          className="inline-flex items-center gap-2 h-8 px-2 rounded-md border border-outline bg-surface text-on-surface hover:bg-surface-hover transition-colors cursor-pointer"
          aria-label="Paragraph alignment"
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

      {mounted ? (
        <div className={`absolute left-0 top-[calc(100%+8px)] z-20 flex gap-1 rounded-xl border border-outline bg-white p-2 shadow-xl dark:bg-surface-alt origin-top ${menuAnim(exiting)}`}>
          {TEXT_ALIGN_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                onMouseDown(event);
                onChange(option.value);
                setOpen(false);
              }}
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
  if (value === "justify") return <AlignJustify className={className} />;
  return <AlignLeft className={className} />;
}

interface ToolbarIconButtonProps {
  active: boolean;
  label: string;
  onMouseDown: (e: React.MouseEvent) => void;
  onClick: () => void;
  children: ReactNode;
}

function ToolbarIconButton({ active, label, onMouseDown, onClick, children }: ToolbarIconButtonProps) {
  return (
    <button
      type="button"
      onMouseDown={onMouseDown}
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`inline-flex items-center justify-center h-8 w-8 rounded-md border transition-colors cursor-pointer ${
        active
          ? "bg-accent-solid text-accent-foreground border-accent-control-ring"
          : "bg-surface text-on-surface border-outline hover:bg-surface-hover"
      }`}
    >
      {children}
    </button>
  );
}
