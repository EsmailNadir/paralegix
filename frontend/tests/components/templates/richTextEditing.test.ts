/**
 * The DOM plumbing under a rich text box: what the contentEditable is built
 * from, and what it serializes back to. Nothing here reaches execCommand
 * (jsdom has none); the hydrate and serialize halves are the part that has
 * to agree, or a box reopens with different content than it was saved with.
 */
import {
  isCaretInBulletedBlock,
  renderRichTextToEditable,
  serializeEditableToRichText,
  toggleBulletAtSelection,
} from '@/components/templatesComp/richTextEditing';
import type { TemplateRichTextBlock } from '@/types/template';

const base = { bold: false, italic: false, color: '#000000' };

function placeCaret(node: Node, offset = 0) {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

describe('render and serialize', () => {
  it('round-trips styled runs, a field chip and a bullet', () => {
    const blocks: TemplateRichTextBlock[] = [
      {
        bullet: true,
        runs: [
          { text: 'Dear ', ...base },
          { text: '{salutation}', fieldName: 'salutation', bold: true, italic: false, color: '#1a56db' },
          { text: ',', ...base, italic: true },
        ],
      },
      { bullet: false, runs: [{ text: 'Regards', ...base }] },
    ];
    const root = document.createElement('div');
    renderRichTextToEditable(root, blocks);

    expect(serializeEditableToRichText(root, base)).toEqual(blocks);
  });

  it('reads a browser-made bold span back as a bold run', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div>plain <span style="font-weight: bold;">strong</span></div>';

    expect(serializeEditableToRichText(root, base)).toEqual([
      { bullet: false, runs: [{ text: 'plain ', ...base }, { text: 'strong', ...base, bold: true }] },
    ]);
  });

  it('keeps text typed before the first Enter as its own block', () => {
    const root = document.createElement('div');
    root.innerHTML = 'first line<div>second</div>';

    expect(serializeEditableToRichText(root, base).map((b) => b.runs[0].text)).toEqual(['first line', 'second']);
  });

  it('serializes an empty box as one empty run rather than nothing', () => {
    const root = document.createElement('div');
    renderRichTextToEditable(root, []);
    expect(serializeEditableToRichText(root, base)).toEqual([{ bullet: false, runs: [{ text: '', ...base }] }]);
  });
});

describe('bullet toggle', () => {
  it('adds and removes the marker on the caret block, and reports it', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    renderRichTextToEditable(root, [{ bullet: false, runs: [{ text: 'item', ...base }] }]);
    placeCaret(root.firstElementChild!.firstChild!.firstChild!, 1);

    expect(isCaretInBulletedBlock(root)).toBe(false);
    expect(toggleBulletAtSelection(root)).toBe(true);
    expect(isCaretInBulletedBlock(root)).toBe(true);
    expect(serializeEditableToRichText(root, base)[0].bullet).toBe(true);

    toggleBulletAtSelection(root);
    expect(serializeEditableToRichText(root, base)[0].bullet).toBe(false);
    root.remove();
  });
});
