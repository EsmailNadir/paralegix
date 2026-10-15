"use client";

import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Highlight from '@tiptap/extension-highlight';
import { Color } from '@tiptap/extension-color';
import { TextStyle } from '@tiptap/extension-text-style';
import FontSize from '@tiptap/extension-text-style/font-size';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import Mention from '@tiptap/extension-mention';
import { useEffect, useState, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Highlighter } from 'lucide-react';
import { useMountTransition } from '@/hooks/useMountTransition';
import { menuAnim } from '@/components/ui/transitionClasses';
import type { Editor } from '@tiptap/react';
import type { FirmMember } from '@/hooks/useFirmMembers';
import { createMentionSuggestion } from './mentionSuggestion';
import Tooltip from "@/components/ui/Tooltip";

type HeadingLevel = 1 | 2 | 3;

interface ParagraphStyleOption {
  value: string;
  label: string;
  level?: HeadingLevel;
  textClass: string;
}

/** Mirrors the "Normal text / Heading 1-3" style picker in Google Docs and Word. */
const PARAGRAPH_STYLES: ParagraphStyleOption[] = [
  { value: 'paragraph', label: 'Normal text', textClass: 'text-sm' },
  { value: 'h1', label: 'Heading 1', level: 1, textClass: 'text-lg font-bold' },
  { value: 'h2', label: 'Heading 2', level: 2, textClass: 'text-base font-bold' },
  { value: 'h3', label: 'Heading 3', level: 3, textClass: 'text-sm font-bold' },
];

interface FontSizeOption {
  label: string;
  value: string | null;
}

/**
 * Point sizes mirrored from Word/Docs' size picker. The editor's own default text
 * size is 14px (from the `prose-sm` class), so that entry uses `value: null` to
 * clear back to it rather than pinning an explicit style.
 */
const FONT_SIZES: FontSizeOption[] = [
  { label: '10', value: '10px' },
  { label: '12', value: '12px' },
  { label: '14', value: null },
  { label: '16', value: '16px' },
  { label: '18', value: '18px' },
  { label: '20', value: '20px' },
  { label: '24', value: '24px' },
  { label: '28', value: '28px' },
  { label: '32', value: '32px' },
  { label: '36', value: '36px' },
  { label: '48', value: '48px' },
];

interface SwatchColor {
  label: string;
  value: string;
}

/** Text colors, in Word/Docs-style palette order. */
const TEXT_COLORS: SwatchColor[] = [
  { label: 'Black', value: '#000000' },
  { label: 'Gray', value: '#6B7280' },
  { label: 'Red', value: '#DC2626' },
  { label: 'Orange', value: '#EA580C' },
  { label: 'Green', value: '#16A34A' },
  { label: 'Blue', value: '#2563EB' },
  { label: 'Purple', value: '#9333EA' },
  { label: 'Pink', value: '#DB2777' },
];

/** Pastel highlighter shades, matching the light-on-dark-text look of a real highlighter pen. */
const HIGHLIGHT_COLORS: SwatchColor[] = [
  { label: 'Yellow', value: '#FEF08A' },
  { label: 'Green', value: '#BBF7D0' },
  { label: 'Blue', value: '#BFDBFE' },
  { label: 'Purple', value: '#E9D5FF' },
  { label: 'Pink', value: '#FBCFE8' },
  { label: 'Orange', value: '#FED7AA' },
  { label: 'Red', value: '#FECACA' },
  { label: 'Gray', value: '#E5E7EB' },
];

/**
 * Toolbar dropdown shell shared by the style, text-color, and highlight pickers:
 * owns its own open state, outside-click close, and the standard menu animation.
 *
 * The menu is portalled to `document.body` and positioned in fixed coordinates
 * rather than sitting `absolute` under the trigger. The toolbar row scrolls
 * horizontally on mobile (`overflow-x-auto`), and per the CSS spec that forces
 * its `overflow-y` to also become non-visible - an inline menu would be
 * silently clipped the moment its trigger sits near the toolbar's bottom edge.
 */
function ToolbarDropdown({
  trigger,
  children,
}: {
  trigger: (opts: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { mounted, exiting } = useMountTransition(open, 150);
  const anchorRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  // Follows the trigger on scroll/resize and flips above it when there isn't
  // room below, same as the portal mode in ui/Dropdown.tsx.
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const menuH = menuRef.current?.offsetHeight ?? 0;
      const spaceBelow = window.innerHeight - rect.bottom;
      const openUp = menuH > 0 && spaceBelow < menuH + 8 && rect.top > spaceBelow;
      setPos({
        top: openUp ? Math.max(8, rect.top - menuH - 4) : rect.bottom + 4,
        left: rect.left,
      });
    };
    update();
    const raf = requestAnimationFrame(update);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  return (
    <div className="relative shrink-0" ref={anchorRef}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {mounted &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            style={{ position: 'fixed', top: pos.top, left: pos.left }}
            className={`z-[9999] origin-top ${menuAnim(exiting)}`}
          >
            {children(() => setOpen(false))}
          </div>,
          document.body
        )}
    </div>
  );
}

/** Swatch grid used by both the text-color and highlight-color dropdowns. */
function ColorSwatchGrid({
  colors,
  activeColor,
  onPick,
  clearLabel,
  onClear,
}: {
  colors: SwatchColor[];
  activeColor: string | null;
  onPick: (color: string) => void;
  clearLabel: string;
  onClear: () => void;
}) {
  return (
    <div className="p-2 bg-surface border border-outline rounded-lg shadow-lg w-[164px]">
      <div className="grid grid-cols-4 gap-1.5">
        {colors.map((color) => (
          <Tooltip key={color.value} title={color.label} enterDelay={300}>
            <button
              type="button"
              onClick={() => onPick(color.value)}
              style={{ backgroundColor: color.value }}
              className={`w-8 h-8 rounded border cursor-pointer transition-all ${
                activeColor === color.value
                  ? 'border-accent-control-ring ring-2 ring-focus-ring ring-offset-1 ring-offset-surface'
                  : 'border-outline hover:scale-105'
              }`}
            />
          </Tooltip>
        ))}
      </div>
      <button
        type="button"
        onClick={onClear}
        className="mt-2 w-full text-xs font-medium text-on-surface-secondary hover:bg-surface-hover rounded px-2 py-1 cursor-pointer text-left"
      >
        {clearLabel}
      </button>
    </div>
  );
}

interface TiptapEditorProps {
  content: string;
  onChange: (content: string) => void;
  placeholder?: string;
  editable?: boolean;
  className?: string;
  /** When provided, enables @mention autocomplete of these firm members. */
  mentionMembers?: FirmMember[];
  /** Reports the ids of members currently @mentioned in the document. */
  onMentionsChange?: (ids: string[]) => void;
}

/** Collect mention-node ids from the current document. */
function collectMentionIds(editor: Editor): string[] {
  const ids: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'mention' && node.attrs.id) ids.push(node.attrs.id as string);
  });
  return Array.from(new Set(ids));
}

export default function TiptapEditor({
  content,
  onChange,
  placeholder = "Start typing...",
  editable = true,
  className = "",
  mentionMembers,
  onMentionsChange,
}: TiptapEditorProps) {
  const [, setEditorState] = useState(0); // Force re-render when editor state changes
  // Remembers the last color picked from each palette, so the split-button's
  // main click (not the chevron) can re-apply it without reopening the menu.
  const [lastTextColor, setLastTextColor] = useState(TEXT_COLORS[0].value);
  const [lastHighlightColor, setLastHighlightColor] = useState(HIGHLIGHT_COLORS[0].value);

  // Latest members read by the mention suggestion without recreating the editor
  // (the list loads async; recreating would reset the editor content).
  const membersRef = useRef<FirmMember[]>(mentionMembers || []);
  membersRef.current = mentionMembers || [];
  // Mention support is fixed at first render (the editor isn't recreated): notes
  // pass these props, templates don't.
  const mentionsEnabledRef = useRef<boolean>(!!onMentionsChange || !!mentionMembers);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // StarterKit (v3) now bundles Link + Underline; we register our own
        // custom-configured versions below, so disable the bundled ones to avoid
        // "Duplicate extension names" warnings.
        link: false,
        underline: false,
        heading: {
          levels: [1, 2, 3]
        },
        bulletList: {
          keepMarks: true,
          keepAttributes: false,
        },
        orderedList: {
          keepMarks: true,
          keepAttributes: false,
        },
        hardBreak: {
          keepMarks: true,
        },
        paragraph: {
          HTMLAttributes: {
            class: 'mb-2',
          },
        },
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {
          class: 'text-accent-emphasis underline hover:text-accent-emphasis-hover dark:hover:text-accent-emphasis-hover',
        },
      }),
      Placeholder.configure({
        placeholder,
      }),
      Highlight.configure({
        multicolor: true,
      }),
      TextStyle,
      Color,
      FontSize,
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      ...(mentionsEnabledRef.current
        ? [
            Mention.configure({
              HTMLAttributes: { class: 'mention text-accent-emphasis font-medium' },
              suggestion: createMentionSuggestion(() => membersRef.current),
            }),
          ]
        : []),
    ],
    content,
    editable,
    immediatelyRender: false, // Fix SSR hydration mismatch in Next.js
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
      if (onMentionsChange) onMentionsChange(collectMentionIds(editor));
      setEditorState(prev => prev + 1); // Force re-render to update button states
    },
    onSelectionUpdate: () => {
      setEditorState(prev => prev + 1); // Force re-render when selection changes
    },
    editorProps: {
      attributes: {
        class: 'prose prose-sm max-w-none focus:outline-none min-h-[120px] p-3 text-on-surface',
      },
    },
  });

  // Update content when it changes externally (e.g., template selection)
  useEffect(() => {
    if (editor && content !== editor.getHTML()) {
      editor.commands.setContent(content, { emitUpdate: false }); // Don't emit update event
      // eslint-disable-next-line react-hooks/set-state-in-effect -- forces re-render after imperatively syncing the Tiptap editor DOM
      setEditorState(prev => prev + 1); // Force re-render after content update
    }
  }, [content, editor]);

  // Force re-render on transaction updates to keep button states in sync
  useEffect(() => {
    if (!editor) return;

    const handleUpdate = () => {
      setEditorState(prev => prev + 1);
    };

    editor.on('transaction', handleUpdate);
    editor.on('selectionUpdate', handleUpdate);

    return () => {
      editor.off('transaction', handleUpdate);
      editor.off('selectionUpdate', handleUpdate);
    };
  }, [editor]);

  if (!editor) {
    return null;
  }

  const addLink = () => {
    const url = window.prompt('Enter URL:');
    if (url) {
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    }
  };

  const removeLink = () => {
    editor.chain().focus().unsetLink().run();
  };

  const currentStyle =
    PARAGRAPH_STYLES.find((style) => style.level && editor.isActive('heading', { level: style.level })) ??
    PARAGRAPH_STYLES[0];

  const applyParagraphStyle = (style: ParagraphStyleOption) => {
    if (style.level) {
      editor.chain().focus().setHeading({ level: style.level }).run();
    } else {
      editor.chain().focus().setParagraph().run();
    }
    setEditorState((prev) => prev + 1);
  };

  const activeFontSize = (editor.getAttributes('textStyle').fontSize as string | undefined) ?? null;
  const currentFontSize =
    FONT_SIZES.find((size) => size.value === activeFontSize) ??
    { label: activeFontSize ? activeFontSize.replace(/px$/, '') : '14', value: activeFontSize };

  const applyFontSize = (size: FontSizeOption) => {
    if (size.value) {
      editor.chain().focus().setFontSize(size.value).run();
    } else {
      editor.chain().focus().unsetFontSize().run();
    }
    setEditorState((prev) => prev + 1);
  };

  const activeTextColor = editor.getAttributes('textStyle').color as string | undefined;
  const activeHighlightColor = editor.isActive('highlight')
    ? (editor.getAttributes('highlight').color as string | undefined)
    : undefined;

  return (
    <div className={`border border-outline rounded-lg bg-surface ${className}`}>
      {/* Toolbar - scroll horizontally on mobile, wrap on desktop */}
      {editable && (
        <div className="border-b border-outline p-2 overflow-x-auto scrollbar-hide md:overflow-x-visible md:overflow-y-visible bg-surface-alt rounded-t-lg">
          <div className="flex gap-1 flex-nowrap md:flex-wrap min-w-max md:min-w-0">
          {/* Undo/Redo Group */}
          <Tooltip title="Undo (Ctrl+Z)" enterDelay={300}>
            <span>
              <button aria-label="Undo (Ctrl+Z)"
                type="button"
                onClick={() => editor.chain().focus().undo().run()}
                disabled={!editor.can().undo()}
                className="w-8 h-8 shrink-0 text-sm border border-outline bg-surface text-on-surface rounded flex items-center justify-center transition-all active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-surface"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                </svg>
              </button>
            </span>
          </Tooltip>

          <Tooltip title="Redo (Ctrl+Y)" enterDelay={300}>
            <span>
              <button aria-label="Redo (Ctrl+Y)"
                type="button"
                onClick={() => editor.chain().focus().redo().run()}
                disabled={!editor.can().redo()}
                className="w-8 h-8 shrink-0 text-sm border border-outline bg-surface text-on-surface rounded flex items-center justify-center transition-all active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-surface"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 10h-10a8 8 0 00-8 8v2M21 10l-6 6m6-6l-6-6" />
                </svg>
              </button>
            </span>
          </Tooltip>

          <div className="w-px h-8 bg-outline mx-1 shrink-0" />

          {/* Paragraph style dropdown - replaces separate H1/H2/H3 buttons, Google Docs-style */}
          <ToolbarDropdown
            trigger={({ open, toggle }) => (
              <Tooltip title="Text style" enterDelay={300}>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    toggle();
                  }}
                  className={`h-8 pl-2.5 pr-1.5 min-w-[112px] shrink-0 text-xs font-medium border rounded flex items-center justify-between gap-1 transition-all active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer ${
                    open
                      ? 'bg-accent-solid text-accent-foreground border-accent-control-ring'
                      : 'bg-surface text-on-surface border-outline hover:bg-surface-hover'
                  }`}
                >
                  <span className="truncate">{currentStyle.label}</span>
                  <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                </button>
              </Tooltip>
            )}
          >
            {(close) => (
              <div className="py-1 min-w-[160px] bg-surface border border-outline rounded-lg shadow-lg">
                {PARAGRAPH_STYLES.map((style) => (
                  <button
                    key={style.value}
                    type="button"
                    onClick={() => {
                      applyParagraphStyle(style);
                      close();
                    }}
                    className={`w-full text-left px-3 py-1.5 cursor-pointer hover:bg-surface-hover ${style.textClass} ${
                      currentStyle.value === style.value
                        ? 'bg-blue-50 text-blue-700 dark:bg-surface-hover dark:text-on-surface'
                        : 'text-on-surface'
                    }`}
                  >
                    {style.label}
                  </button>
                ))}
              </div>
            )}
          </ToolbarDropdown>

          {/* Font size dropdown */}
          <ToolbarDropdown
            trigger={({ open, toggle }) => (
              <Tooltip title="Font size" enterDelay={300}>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    toggle();
                  }}
                  className={`h-8 pl-2 pr-1 min-w-[52px] shrink-0 text-xs font-medium border rounded flex items-center justify-between gap-0.5 transition-all active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer ${
                    open
                      ? 'bg-accent-solid text-accent-foreground border-accent-control-ring'
                      : 'bg-surface text-on-surface border-outline hover:bg-surface-hover'
                  }`}
                >
                  <span className="truncate">{currentFontSize.label}</span>
                  <ChevronDown className="w-3 h-3 shrink-0" />
                </button>
              </Tooltip>
            )}
          >
            {(close) => (
              <div className="py-1 w-12 max-h-56 overflow-y-auto overflow-x-hidden styled-scrollbar bg-surface border border-outline rounded-lg shadow-lg">
                {FONT_SIZES.map((size) => (
                  <button
                    key={size.label}
                    type="button"
                    onClick={() => {
                      applyFontSize(size);
                      close();
                    }}
                    className={`w-full text-center px-1 py-1 text-sm cursor-pointer hover:bg-surface-hover ${
                      currentFontSize.label === size.label
                        ? 'bg-blue-50 text-blue-700 dark:bg-surface-hover dark:text-on-surface'
                        : 'text-on-surface'
                    }`}
                  >
                    {size.label}
                  </button>
                ))}
              </div>
            )}
          </ToolbarDropdown>

          <div className="w-px h-8 bg-outline mx-1 shrink-0" />

          {/* Text Formatting Group */}
          {/* Bold */}
          <Tooltip title="Bold (Ctrl+B)" enterDelay={300}>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                editor.chain().focus().toggleBold().run();
                setEditorState(prev => prev + 1);
              }}
              className={`w-8 h-8 shrink-0 text-sm font-bold border rounded flex items-center justify-center transition-all active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer ${
                editor.isActive('bold')
                  ? 'bg-accent-solid text-accent-foreground border-accent-control-ring'
                  : 'bg-surface text-on-surface border-outline hover:bg-surface-hover'
              }`}
            >
              B
            </button>
          </Tooltip>

          {/* Italic */}
          <Tooltip title="Italic (Ctrl+I)" enterDelay={300}>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                editor.chain().focus().toggleItalic().run();
                setEditorState(prev => prev + 1);
              }}
              className={`w-8 h-8 shrink-0 text-sm border rounded flex items-center justify-center transition-all active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer ${
                editor.isActive('italic')
                  ? 'bg-accent-solid text-accent-foreground border-accent-control-ring'
                  : 'bg-surface text-on-surface border-outline hover:bg-surface-hover'
              }`}
            >
              <span className="italic">I</span>
            </button>
          </Tooltip>

          {/* Underline */}
          <Tooltip title="Underline (Ctrl+U)" enterDelay={300}>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                editor.chain().focus().toggleUnderline().run();
                setEditorState(prev => prev + 1);
              }}
              className={`w-8 h-8 shrink-0 text-sm border rounded flex items-center justify-center transition-all active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer ${
                editor.isActive('underline')
                  ? 'bg-accent-solid text-accent-foreground border-accent-control-ring'
                  : 'bg-surface text-on-surface border-outline hover:bg-surface-hover'
              }`}
            >
              <span className="underline">U</span>
            </button>
          </Tooltip>

          <div className="w-px h-8 bg-outline mx-1 shrink-0" />

          {/* Text Color - split button: main click reapplies the last color, chevron opens the palette */}
          <div className="flex shrink-0 border border-outline rounded overflow-hidden">
            <Tooltip title="Text color" enterDelay={300}>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  editor.chain().focus().setColor(lastTextColor).run();
                  setEditorState(prev => prev + 1);
                }}
                className="w-8 h-8 flex flex-col items-center justify-center gap-0.5 border-r border-outline bg-surface text-on-surface hover:bg-surface-hover transition-all active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
              >
                <span className="text-xs font-bold leading-none">A</span>
                <span className="w-4 h-1 rounded-sm" style={{ backgroundColor: lastTextColor }} />
              </button>
            </Tooltip>
            <ToolbarDropdown
              trigger={({ open, toggle }) => (
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    toggle();
                  }}
                  aria-label="Choose text color"
                  className={`w-5 h-8 flex items-center justify-center transition-all active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer ${
                    open ? 'bg-surface-hover' : 'bg-surface hover:bg-surface-hover'
                  } text-on-surface`}
                >
                  <ChevronDown className="w-3 h-3" />
                </button>
              )}
            >
              {(close) => (
                <ColorSwatchGrid
                  colors={TEXT_COLORS}
                  activeColor={activeTextColor ?? null}
                  onPick={(color) => {
                    setLastTextColor(color);
                    editor.chain().focus().setColor(color).run();
                    setEditorState(prev => prev + 1);
                    close();
                  }}
                  clearLabel="Remove color"
                  onClear={() => {
                    editor.chain().focus().unsetColor().run();
                    setEditorState(prev => prev + 1);
                    close();
                  }}
                />
              )}
            </ToolbarDropdown>
          </div>

          {/* Highlight - split button, same shape as Text Color */}
          <div className="flex shrink-0 border border-outline rounded overflow-hidden">
            <Tooltip title="Highlight color" enterDelay={300}>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  editor.chain().focus().toggleHighlight({ color: lastHighlightColor }).run();
                  setEditorState(prev => prev + 1);
                }}
                className={`w-8 h-8 flex flex-col items-center justify-center gap-0.5 border-r border-outline transition-all active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer ${
                  editor.isActive('highlight')
                    ? 'bg-surface-hover'
                    : 'bg-surface hover:bg-surface-hover'
                } text-on-surface`}
              >
                <Highlighter className="w-3.5 h-3.5" />
                <span className="w-4 h-1 rounded-sm" style={{ backgroundColor: lastHighlightColor }} />
              </button>
            </Tooltip>
            <ToolbarDropdown
              trigger={({ open, toggle }) => (
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    toggle();
                  }}
                  aria-label="Choose highlight color"
                  className={`w-5 h-8 flex items-center justify-center transition-all active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer ${
                    open ? 'bg-surface-hover' : 'bg-surface hover:bg-surface-hover'
                  } text-on-surface`}
                >
                  <ChevronDown className="w-3 h-3" />
                </button>
              )}
            >
              {(close) => (
                <ColorSwatchGrid
                  colors={HIGHLIGHT_COLORS}
                  activeColor={activeHighlightColor ?? null}
                  onPick={(color) => {
                    setLastHighlightColor(color);
                    editor.chain().focus().setHighlight({ color }).run();
                    setEditorState(prev => prev + 1);
                    close();
                  }}
                  clearLabel="Remove highlight"
                  onClear={() => {
                    editor.chain().focus().unsetHighlight().run();
                    setEditorState(prev => prev + 1);
                    close();
                  }}
                />
              )}
            </ToolbarDropdown>
          </div>

          <div className="w-px h-8 bg-outline mx-1 shrink-0" />

          {/* Lists Group */}
          {/* Bullet List */}
          <Tooltip title="Bullet List" enterDelay={300}>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                editor.chain().focus().toggleBulletList().run();
                setEditorState(prev => prev + 1);
              }}
              className={`w-8 h-8 shrink-0 text-sm border-2 rounded flex items-center justify-center transition-all active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer ${
                editor.isActive('bulletList')
                  ? 'bg-accent-solid text-accent-foreground border-accent-control-ring'
                  : 'bg-surface text-on-surface border-outline hover:bg-surface-hover'
              }`}
            >
              <span className="text-2xl leading-none mb-1">•</span>
            </button>
          </Tooltip>

          {/* Ordered List */}
          <Tooltip title="Numbered List" enterDelay={300}>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                editor.chain().focus().toggleOrderedList().run();
                setEditorState(prev => prev + 1);
              }}
              className={`w-8 h-8 shrink-0 text-sm border rounded flex items-center justify-center transition-all active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer ${
                editor.isActive('orderedList')
                  ? 'bg-accent-solid text-accent-foreground border-accent-control-ring'
                  : 'bg-surface text-on-surface border-outline hover:bg-surface-hover'
              }`}
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <text x="2" y="8" fontSize="8" fontWeight="bold">1.</text>
                <text x="2" y="16" fontSize="8" fontWeight="bold">2.</text>
                <text x="2" y="24" fontSize="8" fontWeight="bold">3.</text>
                <line x1="12" y1="5" x2="22" y2="5" stroke="currentColor" strokeWidth="2"/>
                <line x1="12" y1="12" x2="22" y2="12" stroke="currentColor" strokeWidth="2"/>
                <line x1="12" y1="19" x2="22" y2="19" stroke="currentColor" strokeWidth="2"/>
              </svg>
            </button>
          </Tooltip>

          {/* NEW: Task List (Checkboxes) */}
          <Tooltip title="Add checklist / action items" enterDelay={300}>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                editor.chain().focus().toggleTaskList().run();
                setEditorState(prev => prev + 1);
              }}
              className={`px-2 h-8 shrink-0 text-xs font-medium border rounded flex items-center gap-1 transition-all active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer ${
                editor.isActive('taskList')
                  ? 'bg-green-500 text-white border-green-600'
                  : 'bg-surface text-on-surface border-outline hover:bg-surface-hover'
              }`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Tasks
            </button>
          </Tooltip>

          <div className="w-px h-8 bg-outline mx-1 shrink-0" />

          {/* Link */}
          <Tooltip title={editor.isActive('link') ? 'Remove Link' : 'Add Link'} enterDelay={300}>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                if (editor.isActive('link')) {
                  removeLink();
                } else {
                  addLink();
                }
                setEditorState(prev => prev + 1);
              }}
              className={`w-8 h-8 shrink-0 text-sm border rounded flex items-center justify-center transition-all active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer ${
                editor.isActive('link')
                  ? 'bg-accent-solid text-accent-foreground border-accent-control-ring'
                  : 'bg-surface text-on-surface border-outline hover:bg-surface-hover'
              }`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
            </button>
          </Tooltip>
          </div>
        </div>
      )}

      {/* Editor Content */}
      <EditorContent editor={editor} />
    </div>
  );
}

