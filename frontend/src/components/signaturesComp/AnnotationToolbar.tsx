'use client';

import { useState, useRef, useEffect } from 'react';
import Tooltip from "@/components/ui/Tooltip";
import { MousePointer, Type, PenTool, Undo2, Redo2, Download, ChevronDown } from 'lucide-react';
import type { ToolMode } from '@/types/signature';
import { useMountTransition } from '@/hooks/useMountTransition';
import { menuAnim } from '@/components/ui/transitionClasses';
import Spinner from '@/components/ui/Spinner';

export type DownloadFormat = 'pdf' | 'docx' | 'odt' | 'rtf' | 'txt';

interface AnnotationToolbarProps {
  mode: ToolMode;
  onModeChange: (mode: ToolMode) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onDownload: (format: DownloadFormat) => void;
  isDownloading: boolean;
  /**
   * Whether to offer the non-PDF export formats. Converting to them goes
   * through the authenticated convert endpoint, so an external signer on a
   * public signing link gets PDF only rather than options that always fail.
   */
  allowConvertFormats?: boolean;
}

const modes: { mode: ToolMode; icon: typeof MousePointer; label: string }[] = [
  { mode: 'select', icon: MousePointer, label: 'Select' },
  { mode: 'text', icon: Type, label: 'Text' },
  { mode: 'signature', icon: PenTool, label: 'Signature' },
];

const downloadFormats: { value: DownloadFormat; label: string }[] = [
  { value: 'pdf', label: 'PDF' },
  { value: 'docx', label: 'Word (DOCX)' },
  { value: 'odt', label: 'OpenDocument (ODT)' },
  { value: 'rtf', label: 'Rich Text (RTF)' },
  { value: 'txt', label: 'Plain Text (TXT)' },
];

export default function AnnotationToolbar({
  mode,
  onModeChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onDownload,
  isDownloading,
  allowConvertFormats = true,
}: AnnotationToolbarProps) {
  const [showFormats, setShowFormats] = useState(false);
  const { mounted, exiting } = useMountTransition(showFormats, 150);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!showFormats) return;
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowFormats(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showFormats]);

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {/* Mode buttons */}
      <div className="flex items-center bg-surface-alt rounded-lg p-1 gap-0.5">
        {modes.map(({ mode: m, icon: Icon, label }) => (
          <button
            key={m}
            onClick={() => onModeChange(m)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors cursor-pointer ${
              mode === m
                ? 'bg-accent-solid text-accent-foreground shadow-sm'
                : 'text-on-surface-secondary hover:text-on-surface hover:bg-surface-hover'
            }`}
            title={label}
          >
            <Icon className="w-4 h-4" />
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>

      {/* Divider */}
      <div className="w-px h-7 bg-outline-subtle mx-1" />

      {/* Undo / Redo */}
      <Tooltip title="Undo" enterDelay={300}>
        <span>
          <button
            onClick={onUndo}
            disabled={!canUndo}
            className="p-2 rounded-lg text-on-surface-secondary hover:text-on-surface hover:bg-surface-hover disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
            aria-label="Undo"
          >
            <Undo2 className="w-4 h-4" />
          </button>
        </span>
      </Tooltip>
      <Tooltip title="Redo" enterDelay={300}>
        <span>
          <button
            onClick={onRedo}
            disabled={!canRedo}
            className="p-2 rounded-lg text-on-surface-secondary hover:text-on-surface hover:bg-surface-hover disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
            aria-label="Redo"
          >
            <Redo2 className="w-4 h-4" />
          </button>
        </span>
      </Tooltip>

      {/* Divider */}
      <div className="w-px h-7 bg-outline-subtle mx-1" />

      {/* Download with format dropdown */}
      <div ref={dropdownRef} className="relative">
        <div className="inline-flex items-stretch overflow-hidden rounded-lg">
          {/* Main download button (PDF) */}
          <Tooltip title="Download as PDF" enterDelay={300}>
            <span className="inline-flex">
              <button
                onClick={() => onDownload('pdf')}
                disabled={isDownloading}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-accent-foreground bg-accent-solid hover:bg-accent-solid-hover disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
              >
                {isDownloading ? (
                  <Spinner size={16} />
                ) : (
                  <Download className="w-4 h-4" />
                )}
                <span className="hidden sm:inline">Download</span>
              </button>
            </span>
          </Tooltip>
          {/* Dropdown arrow */}
          {allowConvertFormats && (
            <Tooltip title="More download formats" enterDelay={300}>
              <span className="inline-flex border-l border-accent-control-ring/60">
                <button
                  onClick={() => setShowFormats((v) => !v)}
                  disabled={isDownloading}
                  className="flex items-center px-2 text-accent-foreground bg-accent-solid hover:bg-accent-solid-hover disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                  aria-label="More download formats"
                >
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showFormats ? 'rotate-180' : ''}`} />
                </button>
              </span>
            </Tooltip>
          )}
        </div>

        {/* Format dropdown */}
        {allowConvertFormats && mounted && (
          <div className={`absolute right-0 top-full mt-1 bg-surface border border-outline-subtle rounded-xl shadow-lg z-50 min-w-[180px] p-1 origin-top-right ${menuAnim(exiting)}`}>
            {downloadFormats.map((f) => (
              <button
                key={f.value}
                onClick={() => {
                  setShowFormats(false);
                  onDownload(f.value);
                }}
                className="w-full text-left px-2.5 py-2 rounded-lg text-sm text-on-surface hover:bg-surface-hover transition-colors cursor-pointer"
              >
                {f.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
