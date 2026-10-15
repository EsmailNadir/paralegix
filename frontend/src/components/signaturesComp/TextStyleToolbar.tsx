'use client';

import { useRef, useState, useEffect } from 'react';
import { Bold, Italic, ChevronDown, Plus } from 'lucide-react';
import Tooltip from "@/components/ui/Tooltip";
import Dropdown from '@/components/ui/Dropdown';
import { useMountTransition } from '@/hooks/useMountTransition';
import { menuAnim } from '@/components/ui/transitionClasses';
import { FONT_FAMILIES, FONT_SIZES, TEXT_COLORS } from '@/types/signature';

interface TextStyleToolbarProps {
  fontFamily: string;
  fontSize: number;
  isBold: boolean;
  isItalic: boolean;
  color: string;
  onFontFamilyChange: (family: string) => void;
  onFontSizeChange: (size: number) => void;
  onBoldToggle: () => void;
  onItalicToggle: () => void;
  onColorChange: (color: string) => void;
  onSaveSelection?: () => void;
}

// Prevent focus from leaving the contentEditable when clicking toolbar controls
const preventFocusLoss = (e: React.MouseEvent) => e.preventDefault();

export default function TextStyleToolbar({
  fontFamily,
  fontSize,
  isBold,
  isItalic,
  color,
  onFontFamilyChange,
  onFontSizeChange,
  onBoldToggle,
  onItalicToggle,
  onColorChange,
  onSaveSelection,
}: TextStyleToolbarProps) {
  const colorInputRef = useRef<HTMLInputElement>(null);
  const colorMenuRef = useRef<HTMLDivElement>(null);
  const [showColors, setShowColors] = useState(false);
  const { mounted: colorMenuMounted, exiting: colorMenuExiting } = useMountTransition(showColors, 150);

  // Close the color menu when clicking outside of it
  useEffect(() => {
    if (!showColors) return;
    const handleClick = (e: MouseEvent) => {
      if (colorMenuRef.current && !colorMenuRef.current.contains(e.target as Node)) {
        setShowColors(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showColors]);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Font family */}
      <Dropdown
        value={fontFamily}
        onChange={onFontFamilyChange}
        options={FONT_FAMILIES.map((font) => ({
          value: font.value,
          label: font.label,
        }))}
        onMouseDown={onSaveSelection}
        className="w-[180px]"
        buttonClassName="h-9 rounded-md border-input-border bg-input-bg px-2 text-sm"
      />

      {/* Font size */}
      <Dropdown
        value={String(fontSize)}
        onChange={(value) => onFontSizeChange(Number(value))}
        options={FONT_SIZES.map((size) => ({
          value: String(size),
          label: `${size}px`,
        }))}
        onMouseDown={onSaveSelection}
        className="w-[86px]"
        buttonClassName="h-9 rounded-md border-input-border bg-input-bg px-2 text-sm"
      />

      {/* Bold */}
      <Tooltip title="Bold" enterDelay={300}>
        <button
          onMouseDown={preventFocusLoss}
          onClick={onBoldToggle}
          className={`h-9 w-9 flex items-center justify-center rounded-lg border transition-colors cursor-pointer ${
            isBold
              ? 'bg-accent-solid text-accent-foreground border-accent-control-ring'
              : 'bg-surface border-outline-subtle text-on-surface hover:bg-surface-hover'
          }`}
          aria-label="Toggle bold"
        >
          <Bold className="w-4 h-4" />
        </button>
      </Tooltip>

      {/* Italic */}
      <Tooltip title="Italic" enterDelay={300}>
        <button
          onMouseDown={preventFocusLoss}
          onClick={onItalicToggle}
          className={`h-9 w-9 flex items-center justify-center rounded-lg border transition-colors cursor-pointer ${
            isItalic
              ? 'bg-accent-solid text-accent-foreground border-accent-control-ring'
              : 'bg-surface border-outline-subtle text-on-surface hover:bg-surface-hover'
          }`}
          aria-label="Toggle italic"
        >
          <Italic className="w-4 h-4" />
        </button>
      </Tooltip>

      {/* Divider */}
      <div className="w-px h-6 bg-outline-subtle mx-1" />

      {/* Text color dropdown */}
      <div ref={colorMenuRef} className="relative">
        <Tooltip title="Text color" enterDelay={300}>
          <button
            onMouseDown={(e) => {
              preventFocusLoss(e);
              onSaveSelection?.();
            }}
            onClick={() => setShowColors((v) => !v)}
            className="h-9 flex items-center gap-1.5 px-2 rounded-lg border border-outline-subtle bg-surface text-on-surface hover:bg-surface-hover transition-colors cursor-pointer"
            aria-label="Text color"
            aria-haspopup="true"
            aria-expanded={showColors}
          >
            <span className="flex flex-col items-center">
              <span className="text-xs font-semibold leading-none">A</span>
              <span
                className="mt-0.5 h-1.5 w-4 rounded-sm border border-black/10"
                style={{ backgroundColor: color }}
              />
            </span>
            <ChevronDown className={`w-3.5 h-3.5 text-on-surface-muted transition-transform ${showColors ? 'rotate-180' : ''}`} />
          </button>
        </Tooltip>

        {colorMenuMounted && (
          <div
            onMouseDown={preventFocusLoss}
            className={`absolute left-0 top-full mt-1 z-50 w-max origin-top-left rounded-lg border border-outline-subtle bg-surface p-2.5 shadow-lg ${menuAnim(colorMenuExiting)}`}
          >
            <div className="grid grid-cols-4 gap-2">
              {TEXT_COLORS.map((c) => (
                <Tooltip key={c} title={c} enterDelay={300}>
                  <button
                    onMouseDown={preventFocusLoss}
                    onClick={() => {
                      onColorChange(c);
                      setShowColors(false);
                    }}
                    className={`h-7 w-7 rounded-md border transition-transform cursor-pointer hover:scale-105 ${
                      color.toLowerCase() === c.toLowerCase()
                        ? 'border-accent-control-ring ring-2 ring-focus-ring'
                        : 'border-black/10 dark:border-white/15'
                    }`}
                    style={{ backgroundColor: c }}
                    aria-label={`Text color ${c}`}
                  />
                </Tooltip>
              ))}
            </div>

            <div className="my-2 h-px bg-outline-subtle" />

            {/* Custom color */}
            <button
              onMouseDown={preventFocusLoss}
              onClick={() => colorInputRef.current?.click()}
              className="flex w-full items-center gap-2 whitespace-nowrap rounded-md px-1.5 py-1.5 text-sm text-on-surface hover:bg-surface-hover transition-colors cursor-pointer"
            >
              <span
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-outline-subtle overflow-hidden"
                style={{ background: 'conic-gradient(red, yellow, lime, aqua, blue, magenta, red)' }}
              >
                <Plus className="h-3 w-3 text-white drop-shadow" />
              </span>
              Custom color
              <input
                ref={colorInputRef}
                type="color"
                value={color}
                onChange={(e) => onColorChange(e.target.value)}
                className="sr-only"
                tabIndex={-1}
              />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
