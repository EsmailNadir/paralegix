import { useCallback, type RefObject } from 'react';
import { getOffsetWithinBlock, resolveOffsetWithinBlock, SEL_PAGE_P } from './templateEditorDom';

export type SelectionSnapshot = {
  kind: "paragraph" | "textbox";
  targetId: string;
  start: number;
  end: number;
};

/** Keep selection positions independent of DOM nodes replaced by pagination and undo. */
export function useTemplateEditorSelection(
  editorRef: RefObject<HTMLDivElement | null>,
  savedRangeRef: RefObject<Range | null>,
  activeEditableRef: RefObject<HTMLElement | null>,
) {
  const getCursorCharOffset = useCallback((): number => {
    const sel = window.getSelection();
    const editor = editorRef.current;
    if (!sel?.rangeCount || !editor) return 0;
    const range = sel.getRangeAt(0);
    const pre = document.createRange();
    try {
      pre.setStart(editor, 0);
      pre.setEnd(range.startContainer, range.startOffset);
      return pre.toString().length;
    } catch {
      return 0;
    }
  }, [editorRef]);

  // Moves cursor to the given character offset within the editor.
  const restoreCursorToOffset = useCallback((offset: number) => {
    const editor = editorRef.current;
    const sel = window.getSelection();
    if (!editor || !sel) return;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const t = node as Text;
      if (remaining <= t.length) {
        const range = document.createRange();
        range.setStart(t, remaining);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        savedRangeRef.current = range.cloneRange();
        activeEditableRef.current = editor;
        return;
      }
      remaining -= t.length;
    }
    // Fallback: start of first paragraph
    const firstP = editor.querySelector<HTMLElement>(".pdf-page > p");
    if (firstP) {
      const range = document.createRange();
      const target = firstP.firstChild ?? firstP;
      range.setStart(target, 0);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      savedRangeRef.current = range.cloneRange();
      activeEditableRef.current = editor;
    }
  }, [activeEditableRef, editorRef, savedRangeRef]);

  const getSelectionSnapshot = useCallback((): SelectionSnapshot | null => {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return null;

    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    if (!container || !editorRef.current?.contains(container)) return null;

    const paragraph = container.closest<HTMLElement>(SEL_PAGE_P);
    if (paragraph?.dataset.paragraphId) {
      return {
        kind: "paragraph",
        targetId: paragraph.dataset.paragraphId,
        start: getOffsetWithinBlock(paragraph, range.startContainer, range.startOffset),
        end: getOffsetWithinBlock(paragraph, range.endContainer, range.endOffset),
      };
    }

    const textBoxEditor = container.closest<HTMLElement>("[data-template-text-box-editor]");
    const textBox = textBoxEditor?.closest<HTMLElement>("[data-template-text-box-id]");
    if (textBoxEditor && textBox?.dataset.templateTextBoxId) {
      return {
        kind: "textbox",
        targetId: textBox.dataset.templateTextBoxId,
        start: getOffsetWithinBlock(textBoxEditor, range.startContainer, range.startOffset),
        end: getOffsetWithinBlock(textBoxEditor, range.endContainer, range.endOffset),
      };
    }

    return null;
  }, [editorRef]);

  const restoreSelectionSnapshot = useCallback((snapshot: SelectionSnapshot | null) => {
    if (!snapshot || !editorRef.current) return false;

    const block = snapshot.kind === "paragraph"
      ? editorRef.current.querySelector<HTMLElement>(`[data-paragraph-id="${snapshot.targetId}"]`)
      : editorRef.current
        .querySelector<HTMLElement>(`[data-template-text-box-id="${snapshot.targetId}"]`)
        ?.querySelector<HTMLElement>("[data-template-text-box-editor]");

    if (!block) return false;

    const startPosition = resolveOffsetWithinBlock(block, snapshot.start);
    const endPosition = resolveOffsetWithinBlock(block, snapshot.end);
    const selection = window.getSelection();
    if (!selection) return false;

    const range = document.createRange();
    range.setStart(startPosition.node, startPosition.offset);
    range.setEnd(endPosition.node, endPosition.offset);
    selection.removeAllRanges();
    selection.addRange(range);
    savedRangeRef.current = range.cloneRange();

    if (snapshot.kind === "textbox") {
      block.focus();
    }

    return true;
  }, [editorRef, savedRangeRef]);

  return { getCursorCharOffset, restoreCursorToOffset, getSelectionSnapshot, restoreSelectionSnapshot };
}
