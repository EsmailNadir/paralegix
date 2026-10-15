import { createTemplateImageObjectElement } from "@/components/templatesComp/templateImageObjects";
/**
 * `templateEditorDom.ts`: the arithmetic and DOM surgery behind the template
 * editor, pulled out of the component so it can be driven without React.
 *
 * The functions here decide where a page ends, which image is in front of
 * which, where a caret can be put, and how far a paragraph moves. None of them
 * report a failure. A page boundary computed slightly wrong pushes a signature
 * block onto its own sheet; an image ordered wrong hides a clause behind a
 * letterhead; a caret target missing between two adjacent placeholders makes a
 * field impossible to edit out. Every one of those ships as a normal-looking
 * document.
 *
 * Two things this file deliberately does NOT test. `getToolbarStyleFromElement`
 * leans on `document.queryCommandState`, which jsdom does not implement, so a
 * spec for it would be measuring the gap rather than the code. And the paths
 * that fall back to `offsetHeight` cannot be reached meaningfully under jsdom,
 * which reports 0 for every element; fixtures below therefore carry explicit
 * `data-base-height` metadata, which is what a real imported template has.
 *
 * Where a function rounds, clamps or picks a nearest option, the cases below
 * sit on both sides of the boundary rather than in the comfortable middle, so
 * a changed comparison fails instead of landing on the same answer.
 */
import {
  applyTemplateImageObjectZIndex,
  applyTemplateImageZOrderInPage,
  collectPageFlowGroups,
  createTemplateDomId,
  defaultParagraphGap,
  detectFooterBandTop,
  ensureChipCaretTargets,
  findPreferredSplitOffset,
  getDefaultPageContentBottom,
  getFontCss,
  getClosestLineSpacing,
  getMedian,
  getNodeTextLength,
  getNodeTextValue,
  getOffsetWithinBlock,
  getPageColumnRightEdge,
  getParagraphHorizontalBounds,
  getParagraphLayoutTop,
  getTemplateImagePriorityIndex,
  inferAutoPageContentBottom,
  isDocxFile,
  isParagraphAwaitingNewText,
  isPdfFile,
  isSupportedTemplateFile,
  migratePageBackgroundImageToTemplateObject,
  moveImageInStack,
  moveImageToStackIndex,
  normalizeLinkHref,
  normalizeTemplateImagePrioritiesOnPage,
  normalizeTextAlign,
  preserveEditableGapSpans,
  refreshAutoPageContentBottom,
  resolveOffsetWithinBlock,
  sharesRulerColumn,
  sortTemplateImagesOnPage,
  stripZeroWidthSpaces,
} from '@/components/templatesComp/templateEditorDom';

const ZWS = '​';
const NBSP = ' ';

afterEach(() => {
  document.body.innerHTML = '';
});

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

function idsOf(elements: HTMLElement[]): string[] {
  return elements.map((el) => el.dataset.templateImageObjectId ?? '');
}

describe('image stack ordering', () => {
  /** Three image objects, listed in DOM order, each with a declared priority. */
  const pageWith = (...images: { id: string; priority?: string; behind?: boolean }[]) =>
    mount(
      `<div class="pdf-page">` +
        images
          .map(
            (image) =>
              `<div data-template-image-object-id="${image.id}"` +
              (image.priority === undefined ? '' : ` data-template-image-priority="${image.priority}"`) +
              (image.behind ? ' data-template-image-behind-text="true"' : '') +
              `></div>`,
          )
          .join('') +
        `</div>`,
    );

  it('orders by priority NUMERICALLY, not as text', () => {
    // Priority 9 against 10 is the case that separates the two. Compared as
    // strings "10" sorts before "9", so the image the user sent to the front
    // lands at the back and covers the clause underneath it.
    const page = pageWith({ id: 'nine', priority: '9' }, { id: 'ten', priority: '10' });

    expect(idsOf(sortTemplateImagesOnPage(page))).toEqual(['nine', 'ten']);
  });

  it('breaks a tie on DOM order rather than anything else', () => {
    // Both at priority 0, listed zulu-then-alpha so that a result which merely
    // happened to be sorted by id would be visible here. Painting order is the
    // tie-break the browser itself uses, so this keeps the stack stable.
    const page = pageWith({ id: 'zulu', priority: '0' }, { id: 'alpha', priority: '0' });

    expect(idsOf(sortTemplateImagesOnPage(page))).toEqual(['zulu', 'alpha']);
  });

  it('treats a missing or unparseable priority as zero', () => {
    const page = pageWith(
      { id: 'behindAll', priority: '-2' },
      { id: 'noPriority' },
      { id: 'garbage', priority: 'front' },
    );

    expect(idsOf(sortTemplateImagesOnPage(page))).toEqual(['behindAll', 'noPriority', 'garbage']);
  });

  it('renumbers the stack consecutively', () => {
    const page = pageWith(
      { id: 'a', priority: '5' },
      { id: 'b', priority: '40' },
      { id: 'c', priority: '5' },
    );

    normalizeTemplateImagePrioritiesOnPage(page);

    // Duplicate priorities make every later reorder ambiguous. Renumbering is
    // what turns a stack the user dragged into one that survives a reload.
    expect(idsOf(sortTemplateImagesOnPage(page)).map((id) => id)).toEqual(['a', 'c', 'b']);
    expect(
      Array.from(page.querySelectorAll<HTMLElement>('[data-template-image-object-id]')).map(
        (el) => `${el.dataset.templateImageObjectId}:${el.dataset.templateImagePriority}`,
      ),
    ).toEqual(['a:0', 'b:2', 'c:1']);
  });

  it('moves an image one step forward and renumbers the rest', () => {
    const page = pageWith({ id: 'a', priority: '0' }, { id: 'b', priority: '1' }, { id: 'c', priority: '2' });
    const a = page.querySelector<HTMLElement>('[data-template-image-object-id="a"]')!;

    expect(moveImageInStack(page, a, 1)).toBe(true);

    expect(idsOf(sortTemplateImagesOnPage(page))).toEqual(['b', 'a', 'c']);
  });

  it('moves an image one step back', () => {
    const page = pageWith({ id: 'a', priority: '0' }, { id: 'b', priority: '1' }, { id: 'c', priority: '2' });
    const c = page.querySelector<HTMLElement>('[data-template-image-object-id="c"]')!;

    expect(moveImageInStack(page, c, -1)).toBe(true);

    expect(idsOf(sortTemplateImagesOnPage(page))).toEqual(['a', 'c', 'b']);
  });

  it('refuses to move past either end and leaves the stack alone', () => {
    const page = pageWith({ id: 'a', priority: '0' }, { id: 'b', priority: '1' });
    const a = page.querySelector<HTMLElement>('[data-template-image-object-id="a"]')!;
    const b = page.querySelector<HTMLElement>('[data-template-image-object-id="b"]')!;

    // The return value drives whether the toolbar button appears disabled, and
    // an unguarded index would wrap the front image around to the back.
    expect(moveImageInStack(page, a, -1)).toBe(false);
    expect(moveImageInStack(page, b, 1)).toBe(false);
    expect(idsOf(sortTemplateImagesOnPage(page))).toEqual(['a', 'b']);
  });

  it('refuses to move an image that is not on the page', () => {
    const page = pageWith({ id: 'a', priority: '0' });
    const stranger = document.createElement('div');
    stranger.dataset.templateImageObjectId = 'elsewhere';

    expect(moveImageInStack(page, stranger, 1)).toBe(false);
  });

  it('moves an image to an absolute index', () => {
    const page = pageWith(
      { id: 'a', priority: '0' },
      { id: 'b', priority: '1' },
      { id: 'c', priority: '2' },
    );
    const a = page.querySelector<HTMLElement>('[data-template-image-object-id="a"]')!;

    expect(moveImageToStackIndex(page, a, 2)).toBe(true);

    // "Bring to front" is this call with the last index. Removing then
    // re-inserting is what keeps the other two in their relative order.
    expect(idsOf(sortTemplateImagesOnPage(page))).toEqual(['b', 'c', 'a']);
  });

  it('clamps an index beyond the stack instead of dropping the image', () => {
    const page = pageWith({ id: 'a', priority: '0' }, { id: 'b', priority: '1' });
    const a = page.querySelector<HTMLElement>('[data-template-image-object-id="a"]')!;

    expect(moveImageToStackIndex(page, a, 99)).toBe(true);
    expect(idsOf(sortTemplateImagesOnPage(page))).toEqual(['b', 'a']);
  });

  it('reports no change when the image is already at the target index', () => {
    const page = pageWith({ id: 'a', priority: '0' }, { id: 'b', priority: '1' });
    const a = page.querySelector<HTMLElement>('[data-template-image-object-id="a"]')!;

    // False means "nothing happened", which is what stops the editor pushing an
    // empty entry onto the undo stack for a no-op drag.
    expect(moveImageToStackIndex(page, a, 0)).toBe(false);
  });

  it('reports a one-based position and the stack size', () => {
    const page = pageWith({ id: 'a', priority: '0' }, { id: 'b', priority: '1' }, { id: 'c', priority: '2' });
    const b = page.querySelector<HTMLElement>('[data-template-image-object-id="b"]')!;

    // This is rendered to the user as "Layer 2 of 3", so a zero-based index
    // would read as "Layer 1 of 3" for the middle image.
    expect(getTemplateImagePriorityIndex(b)).toEqual({ index: 2, total: 3 });
  });

  it('has no position for an image outside any page', () => {
    const loose = document.createElement('div');
    loose.dataset.templateImageObjectId = 'loose';
    document.body.appendChild(loose);

    expect(getTemplateImagePriorityIndex(loose)).toBeNull();
  });

  it('puts a watermark behind body text and everything else in front of it', () => {
    const foreground = document.createElement('div');
    const watermark = document.createElement('div');
    watermark.dataset.templateImageBehindText = 'true';

    applyTemplateImageObjectZIndex(foreground);
    applyTemplateImageObjectZIndex(watermark);

    // Body paragraphs sit at z-index 1. An ordinary image below that cannot be
    // clicked to drag or resize, because the paragraph swallows the pointer.
    expect(foreground.style.zIndex).toBe('2');
    expect(watermark.style.zIndex).toBe('0');
  });

  it('rewrites DOM order to match the stack when applying z-order', () => {
    const page = pageWith(
      { id: 'front', priority: '2' },
      { id: 'back', priority: '0' },
      { id: 'middle', priority: '1' },
    );

    applyTemplateImageZOrderInPage(page);

    // Equal z-index values are resolved by document order, so the DOM has to
    // agree with the priorities or two images at the same layer flicker between
    // renders.
    expect(
      Array.from(page.children).map((el) => (el as HTMLElement).dataset.templateImageObjectId),
    ).toEqual(['back', 'middle', 'front']);
    // Controls and layer menus are positioned outside the page box.
    expect(page.style.overflow).toBe('visible');
  });
});

describe('promoting an imported page background to an image object', () => {
  it('sizes the object to the page and puts it behind the text', () => {
    const page = mount(
      `<div class="pdf-page" style="width:816px" data-base-min-height="1056">` +
        `<img class="pdf-page-background" src="scan.png" style="left:0px;top:0px">` +
        `</div>`,
    );
    const image = page.querySelector('img')!;

    migratePageBackgroundImageToTemplateObject(page, image, 0, 0);

    // The imported background becomes a selectable object so a user can replace
    // or crop it, but it must not jump in front of the text it was scanned
    // behind, and it must still cover the sheet.
    const object = page.querySelector<HTMLElement>('[data-template-image-object-id]')!;
    expect(object.style.width).toBe('816px');
    expect(object.style.height).toBe('1056px');
    expect(object.dataset.templateImageBehindText).toBe('true');
    expect(page.querySelector('img.pdf-page-background')).toBeNull();
  });

  it('stacks several backgrounds on one page in import order', () => {
    const page = mount(
      `<div class="pdf-page" style="width:816px" data-base-min-height="1056">` +
        `<img class="pdf-page-background" src="a.png">` +
        `<img class="pdf-page-background" src="b.png">` +
        `</div>`,
    );
    const [first, second] = Array.from(page.querySelectorAll('img'));

    migratePageBackgroundImageToTemplateObject(page, first, 0, 0);
    migratePageBackgroundImageToTemplateObject(page, second, 0, 1);

    // Negative, descending priorities keep both behind every ordinary image and
    // keep the second scan behind the first, which is the order the PDF drew
    // them in.
    expect(
      Array.from(page.querySelectorAll<HTMLElement>('[data-template-image-object-id]')).map(
        (el) => el.dataset.templateImagePriority,
      ),
    ).toEqual(['-1', '-2']);
  });
});

describe('line spacing', () => {
  it('keeps a ratio that matches a menu option', () => {
    expect(getClosestLineSpacing('1.5', 16)).toBe('1.5');
  });

  it('converts a pixel line height against the font size', () => {
    // Imported documents state line height in pixels. Read as a raw ratio, 24
    // is nowhere near any option and the toolbar shows "24" as custom spacing
    // on a perfectly ordinary 1.5-spaced paragraph.
    expect(getClosestLineSpacing('24px', 16)).toBe('1.5');
  });

  it('snaps a ratio just inside the tolerance to the menu option', () => {
    // 1.04 is four hundredths from single spacing, inside the window the module
    // treats as the same setting.
    expect(getClosestLineSpacing('1.04', 16)).toBe('1');
  });

  it('reports a ratio just outside the tolerance as custom', () => {
    // 1.06 is six hundredths out, and the pair brackets the threshold rather
    // than sitting somewhere either side of it would answer the same.
    expect(getClosestLineSpacing('1.06', 16)).toBe('1.06');
  });

  it('rounds a custom ratio to two decimals', () => {
    // 1.333... is what a third-party import produces. Showing the full float in
    // the toolbar's spacing box is not a value anyone can type back.
    expect(getClosestLineSpacing('1.3333333', 16)).toBe('1.33');
  });

  it('falls back to the editor default for normal, empty and nonsense', () => {
    // "normal" is what an unstyled element computes to; it is not a number and
    // must not be read as one.
    expect(getClosestLineSpacing('normal', 16)).toBe('1.15');
    expect(getClosestLineSpacing('', 16)).toBe('1.15');
    expect(getClosestLineSpacing('0', 16)).toBe('1.15');
    expect(getClosestLineSpacing('-2', 16)).toBe('1.15');
  });

  it('does not divide by zero on a pixel value with no font size', () => {
    // 24px against a font size of 0 would be an infinite ratio. The guard keeps
    // it a finite number so the toolbar shows something rather than "Infinity".
    expect(getClosestLineSpacing('24px', 0)).toBe('24');
  });
});

describe('text alignment and link normalisation', () => {
  it('maps the logical alignments onto the physical ones the toolbar shows', () => {
    // "start" and "end" are what a computed style reports for a default
    // paragraph. Unmapped, the toolbar shows no alignment selected at all.
    expect(normalizeTextAlign('start')).toBe('left');
    expect(normalizeTextAlign('end')).toBe('right');
  });

  it('keeps an alignment the toolbar offers', () => {
    expect(normalizeTextAlign('justify')).toBe('justify');
    expect(normalizeTextAlign('center')).toBe('center');
  });

  it('falls back to left for anything else', () => {
    expect(normalizeTextAlign('match-parent')).toBe('left');
    expect(normalizeTextAlign('')).toBe('left');
  });

  it('adds a scheme to a bare domain', () => {
    // Without a scheme the browser resolves the href against the app, so a link
    // to the client's own site opens a 404 inside Paralegix.
    expect(normalizeLinkHref('example.com')).toBe('https://example.com');
    expect(normalizeLinkHref('  example.com  ')).toBe('https://example.com');
  });

  it('recognises a bare email address as mail, not a domain', () => {
    expect(normalizeLinkHref('counsel@example.com')).toBe('mailto:counsel@example.com');
  });

  it('leaves an address that already carries a scheme, in any case', () => {
    expect(normalizeLinkHref('https://example.com/x')).toBe('https://example.com/x');
    expect(normalizeLinkHref('HTTP://EXAMPLE.COM')).toBe('HTTP://EXAMPLE.COM');
    expect(normalizeLinkHref('mailto:counsel@example.com')).toBe('mailto:counsel@example.com');
    expect(normalizeLinkHref('tel:+15551234567')).toBe('tel:+15551234567');
  });

  it('leaves an in-document or root-relative target alone', () => {
    // Prefixing these with https:// would send a reader off the document
    // entirely instead of to the clause the anchor names.
    expect(normalizeLinkHref('#schedule-2')).toBe('#schedule-2');
    expect(normalizeLinkHref('/matters/123')).toBe('/matters/123');
  });

  it('returns nothing for an empty or whitespace value', () => {
    // The empty result is what the caller uses to REMOVE a link. Turning it
    // into "https://" would leave a dead anchor in the document.
    expect(normalizeLinkHref('')).toBe('');
    expect(normalizeLinkHref('   ')).toBe('');
  });
});

describe('measuring text across nodes', () => {
  it('counts a line break as one character', () => {
    const block = mount('<p>ab<br>cd</p>');

    // Caret offsets are stored as character counts and restored after every
    // reformat. A <br> that counts as nothing shifts the caret one place left
    // for every line break above it in the paragraph.
    expect(getNodeTextLength(block)).toBe(5);
    expect(getNodeTextValue(block)).toBe('ab\ncd');
  });

  it('sums text across nested elements', () => {
    const block = mount('<p><span>ab</span><strong><em>cd</em></strong>e</p>');

    expect(getNodeTextLength(block)).toBe(5);
    expect(getNodeTextValue(block)).toBe('abcde');
  });

  it('counts an empty paragraph as nothing', () => {
    expect(getNodeTextLength(mount('<p></p>'))).toBe(0);
  });

  it('converts a caret position inside a nested run to a block offset', () => {
    const block = mount('<p><span>abc</span><em>def</em></p>');
    const em = block.querySelector('em')!;

    // Offset 2 inside "def" is offset 5 in the paragraph.
    expect(getOffsetWithinBlock(block, em.firstChild!, 2)).toBe(5);
  });

  it('counts a line break when converting a caret position', () => {
    const block = mount('<p>ab<br><span>cd</span></p>');
    const span = block.querySelector('span')!;

    // 2 for "ab", 1 for the break, 1 into "cd".
    expect(getOffsetWithinBlock(block, span.firstChild!, 1)).toBe(4);
  });

  it('round-trips an offset back to the node that holds it', () => {
    const block = mount('<p><span>abc</span><em>def</em></p>');

    const resolved = resolveOffsetWithinBlock(block, 5);

    // The pair has to agree or a reformat drops the caret somewhere the user
    // did not leave it, mid-word, in a document they are typing into.
    expect(resolved.node.textContent).toBe('def');
    expect(resolved.offset).toBe(2);
    expect(getOffsetWithinBlock(block, resolved.node, resolved.offset)).toBe(5);
  });

  it('resolves an offset past the end to the end of the block', () => {
    const block = mount('<p><span>abc</span></p>');

    const resolved = resolveOffsetWithinBlock(block, 99);

    expect(resolved.node).toBe(block);
    expect(resolved.offset).toBe(block.childNodes.length);
  });

  it('resolves an offset landing on a line break to just after it', () => {
    const block = mount('<p>ab<br>cd</p>');

    const resolved = resolveOffsetWithinBlock(block, 3);

    // Offset 3 is the position immediately after the break, which is the start
    // of the second visual line. Resolving into the <br> itself is not a valid
    // caret position.
    expect(resolved.node).toBe(block);
    expect(resolved.offset).toBe(2);
  });
});

describe('choosing where to divide a paragraph', () => {
  it('moves back to the start of the word containing the offset', () => {
    const block = mount('<p>Hello world again</p>');

    // Offset 14 is inside "again"; the preferred split is the 12 where that
    // word begins. Splitting at 14 leaves "ag" at the end of one paragraph.
    expect(findPreferredSplitOffset(block, 14)).toBe(12);
  });

  it('keeps an offset that is already at a word start', () => {
    const block = mount('<p>Hello world again</p>');

    expect(findPreferredSplitOffset(block, 12)).toBe(12);
  });

  it('treats a non-breaking space as a word separator', () => {
    const block = mount(`<p>Hello${NBSP}world</p>`);

    // Imported documents use non-breaking spaces for fixed-width gaps. A
    // separator check that only knew U+0020 would refuse to break these
    // paragraphs anywhere.
    expect(findPreferredSplitOffset(block, 9)).toBe(6);
  });

  it('gives back the offset when the paragraph is one long word', () => {
    const block = mount('<p>Indemnification</p>');

    expect(findPreferredSplitOffset(block, 7)).toBe(7);
  });

  it('does not split at either edge of the paragraph', () => {
    const block = mount('<p>Hello world</p>');

    // Zero and the full length are not splits, they are the paragraph. Returning
    // one would leave an empty paragraph in the document.
    expect(findPreferredSplitOffset(block, 0)).toBe(0);
    expect(findPreferredSplitOffset(block, 11)).toBe(11);
  });
});

describe('paragraph spacing and blankness', () => {
  it('derives the default gap from the paragraph\'s own type size', () => {
    const paragraph = mount('<p style="font-size:18px;line-height:1.5"></p>');

    // 18 x 1.5 x 0.25 is 6.75, which rounds to 7. A truncating implementation
    // gives 6 and every inserted paragraph drifts a pixel tighter than the ones
    // around it.
    expect(defaultParagraphGap(paragraph)).toBe(7);
  });

  it('falls back to 12px text at 1.15 when the paragraph declares nothing', () => {
    expect(defaultParagraphGap(mount('<p></p>'))).toBe(3);
  });

  it('treats an empty paragraph as awaiting text', () => {
    expect(isParagraphAwaitingNewText(mount('<p></p>'))).toBe(true);
    expect(isParagraphAwaitingNewText(mount(`<p>${ZWS}</p>`))).toBe(true);
    expect(isParagraphAwaitingNewText(mount(`<p>${NBSP} </p>`))).toBe(true);
  });

  it('treats a bare list marker as awaiting text', () => {
    // Pressing Enter in a list creates the marker before the user types. The
    // editor has to know the paragraph is empty so the next keystroke styles
    // itself from the toolbar rather than from the bullet.
    for (const marker of ['•', '‣', '1.', '2)', 'a.', 'iv.']) {
      expect(isParagraphAwaitingNewText(mount(`<p>${marker}</p>`))).toBe(true);
    }
  });

  it('does not treat a numbered clause with text as empty', () => {
    // "1. Definitions" is a real clause. Classifying it as awaiting text lets
    // the editor overwrite it.
    expect(isParagraphAwaitingNewText(mount('<p>1. Definitions</p>'))).toBe(false);
    expect(isParagraphAwaitingNewText(mount('<p>• Retainer</p>'))).toBe(false);
  });
});

describe('caret targets around placeholder chips', () => {
  it('puts a caret target between two ADJACENT chips', () => {
    const paragraph = mount(
      '<p><span data-placeholder-chip="a">A</span><span data-placeholder-chip="b">B</span></p>',
    );

    ensureChipCaretTargets(paragraph);

    // Two chips touching is the case with no text node to click into. Without a
    // target between them there is nowhere to put the caret to type between the
    // fields, and backspace deletes a whole chip instead of moving.
    const [chipA, chipB] = Array.from(paragraph.querySelectorAll('[data-placeholder-chip]'));
    expect(chipA.nextSibling?.nodeType).toBe(Node.TEXT_NODE);
    expect(chipA.nextSibling).toBe(chipB.previousSibling);
    expect(paragraph.childNodes).toHaveLength(5);
  });

  it('puts targets on both sides of a lone chip', () => {
    const paragraph = mount('<p><span data-placeholder-chip="a">A</span></p>');

    ensureChipCaretTargets(paragraph);

    expect(paragraph.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(paragraph.lastChild?.nodeType).toBe(Node.TEXT_NODE);
  });

  it('does not add a second target where text already sits', () => {
    const paragraph = mount('<p>Between <span data-placeholder-chip="a">A</span> and</p>');

    ensureChipCaretTargets(paragraph);

    // Running on every keystroke, an unguarded insert grows the paragraph by two
    // nodes each time and the caret offsets shift under the user.
    expect(paragraph.childNodes).toHaveLength(3);
  });

  it('is unchanged by a second call', () => {
    const paragraph = mount('<p><span data-placeholder-chip="a">A</span></p>');

    ensureChipCaretTargets(paragraph);
    const afterFirst = paragraph.childNodes.length;
    ensureChipCaretTargets(paragraph);

    expect(paragraph.childNodes).toHaveLength(afterFirst);
  });

  it('strips zero-width spaces and drops the nodes left empty', () => {
    const paragraph = mount(`<p>${ZWS}<span>Signed${ZWS}</span>${ZWS}</p>`);

    stripZeroWidthSpaces(paragraph);

    // The padding is invisible on screen but travels with copied text and into
    // exported documents. A node emptied by the strip has to go too, or the
    // paragraph keeps accumulating empty text nodes.
    expect(paragraph.textContent).toBe('Signed');
    expect(paragraph.childNodes).toHaveLength(1);
    expect(paragraph.querySelector('span')!.childNodes).toHaveLength(1);
  });

  it('keeps a text node that still has content after the strip', () => {
    const paragraph = mount(`<p>Sig${ZWS}ned</p>`);

    stripZeroWidthSpaces(paragraph);

    expect(paragraph.childNodes).toHaveLength(1);
    expect(paragraph.textContent).toBe('Signed');
  });
});

describe('editable gap spans imported from a PDF', () => {
  it('stashes the original width and rebuilds the gap', () => {
    const paragraph = mount('<p><span data-pdf-gap="1" style="width:40px"></span></p>');

    preserveEditableGapSpans(paragraph);

    const gap = paragraph.querySelector<HTMLElement>('[data-pdf-gap]')!;
    // A PDF's tab stops arrive as fixed-width spans. They have to stay
    // inline-block at their measured width, or a signature line's dotted rule
    // moves every time the paragraph is re-rendered.
    expect(gap.dataset.pdfGapWidth).toBe('40');
    expect(gap.style.display).toBe('inline-block');
    expect(gap.style.width).toBe('40px');
    expect(gap.textContent).toBe(NBSP);
  });

  it('restores the width from the stash after it is lost', () => {
    const paragraph = mount('<p><span data-pdf-gap="1" style="width:40px"></span></p>');
    preserveEditableGapSpans(paragraph);
    const gap = paragraph.querySelector<HTMLElement>('[data-pdf-gap]')!;
    gap.style.width = '';

    preserveEditableGapSpans(paragraph);

    // Editing inside the paragraph can strip the inline width. The stash is the
    // only remaining record of how wide the gap was in the source document.
    expect(gap.style.width).toBe('40px');
  });

  it('leaves a zero-width gap alone', () => {
    const paragraph = mount('<p><span data-pdf-gap="1"></span></p>');

    preserveEditableGapSpans(paragraph);

    const gap = paragraph.querySelector<HTMLElement>('[data-pdf-gap]')!;
    expect(gap.style.display).toBe('');
    expect(gap.textContent).toBe('');
  });

  it('surrounds the gap with caret targets', () => {
    const paragraph = mount('<p><span data-pdf-gap="1" style="width:40px"></span></p>');

    preserveEditableGapSpans(paragraph);

    expect(paragraph.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(paragraph.lastChild?.nodeType).toBe(Node.TEXT_NODE);
  });
});

describe('page and paragraph geometry', () => {
  it('takes the tighter of the two bottom-margin rules', () => {
    // A 1000px sheet gives 904 from the fixed 96px margin and 920 from the 8%
    // rule; a 1500px sheet reverses which is smaller. Both cases are needed:
    // either formula alone answers one of them correctly.
    expect(getDefaultPageContentBottom(1000, 72)).toBe(904);
    expect(getDefaultPageContentBottom(1500, 72)).toBe(1380);
  });

  it('never returns a column shorter than 240px', () => {
    // A 200px sheet would otherwise end its content above where it starts, and
    // every paragraph would overflow onto a page that overflows in turn.
    expect(getDefaultPageContentBottom(200, 72)).toBe(312);
  });

  it('falls back to a usable column when the page height is unknown', () => {
    expect(getDefaultPageContentBottom(0, 72)).toBe(312);
    expect(getDefaultPageContentBottom(Number.NaN, 0)).toBe(240);
  });

  it('prefers the live style top over stored import metadata', () => {
    const paragraph = mount('<p style="top:180px" data-base-top="100"></p>');

    // data-base-top is where the PDF importer put the line. style.top is where
    // repagination has since moved it, and reading the stale one drags the
    // paragraph back up over its neighbour.
    expect(getParagraphLayoutTop(paragraph)).toBe(180);
  });

  it('falls back to the stored top when the style has none', () => {
    expect(getParagraphLayoutTop(mount('<p data-base-top="100"></p>'))).toBe(100);
    expect(getParagraphLayoutTop(mount('<p></p>'))).toBe(0);
  });

  it('uses a declared column right edge over anything measured', () => {
    const page = mount('<div class="pdf-page" style="width:816px" data-column-right="700"></div>');

    expect(getPageColumnRightEdge(page)).toBe(700);
  });

  it('derives a right edge from the page width, with a minimum margin', () => {
    // 8% of 816 is 65px, under the 72px floor, so the margin is 72 and the edge
    // is 744. On a 1200px page 8% is 96 and the percentage governs.
    expect(getPageColumnRightEdge(mount('<div class="pdf-page" style="width:816px"></div>'))).toBe(744);
    expect(getPageColumnRightEdge(mount('<div class="pdf-page" style="width:1200px"></div>'))).toBe(1104);
  });

  it('lets a paragraph that runs wider than the margin set the edge', () => {
    const page = mount(
      '<div class="pdf-page" style="width:816px">' +
        '<p style="left:100px;width:700px"></p>' +
        '</div>',
    );

    // The ruler has to reach content that is actually there. Clamping to the
    // nominal margin puts the ruler's end to the left of text the user can see.
    expect(getPageColumnRightEdge(page)).toBe(800);
  });

  it('reads a paragraph\'s bounds from left and width', () => {
    const paragraph = mount('<p style="left:72px;width:400px"></p>');

    expect(getParagraphHorizontalBounds(paragraph)).toEqual({
      left: 72,
      width: 400,
      right: 472,
      center: 272,
    });
  });

  it('falls back to margin-left and never reports a negative width', () => {
    const paragraph = mount('<p style="margin-left:50px;width:-10px"></p>');

    expect(getParagraphHorizontalBounds(paragraph)).toEqual({
      left: 50,
      width: 0,
      right: 50,
      center: 50,
    });
  });
});

describe('deciding whether two paragraphs share a ruler column', () => {
  const bounds = (left: number, width: number) => ({
    left,
    width,
    right: left + width,
    center: left + width / 2,
  });

  it('treats a shared left edge as the same column', () => {
    // Dragging the ruler moves every paragraph in the column. A short heading
    // flush with the body's left margin belongs to it even though it is a third
    // of the width.
    expect(sharesRulerColumn(bounds(72, 600), bounds(72, 200))).toBe(true);
  });

  it('allows the edges to differ by up to 36px', () => {
    // Imported paragraphs are never pixel-identical. 36 is the tolerance; 37
    // apart with nothing else in common is a different column.
    expect(sharesRulerColumn(bounds(72, 600), bounds(108, 200))).toBe(true);
    expect(sharesRulerColumn(bounds(72, 600), bounds(109, 200))).toBe(false);
  });

  it('treats a shared right edge as the same column', () => {
    // A right-aligned date block ends where the body ends and starts nowhere
    // near it.
    expect(sharesRulerColumn(bounds(72, 600), bounds(500, 172))).toBe(true);
  });

  it('accepts a heavily overlapping, centred pair whose edges match neither', () => {
    // Neither edge is within 36, but the two occupy nearly the same band and
    // share a centre: a centred title over body text.
    expect(sharesRulerColumn(bounds(72, 600), bounds(150, 444))).toBe(true);
  });

  it('rejects a pair that overlaps without sharing a centre', () => {
    // Fully contained in the selection's span, so the overlap ratio is 1, but
    // its centre is 128px off against a 50px tolerance and neither edge lines
    // up. Overlap alone is not evidence of a shared column: a pull-quote inset
    // to one side overlaps the body completely.
    expect(sharesRulerColumn(bounds(72, 600), bounds(400, 200))).toBe(false);
  });

  it('rejects a zero-width paragraph outright', () => {
    // A blank line has no width. Matching it would drag unrelated paragraphs
    // whenever the user grabbed the ruler on an empty line.
    expect(sharesRulerColumn(bounds(72, 600), bounds(72, 0))).toBe(false);
    expect(sharesRulerColumn(bounds(72, 0), bounds(72, 600))).toBe(false);
  });
});

describe('the median used for page heuristics', () => {
  it('sorts numerically, not as text', () => {
    // [1, 2, 10] against a text sort's [1, 10, 2]. This is the input where the
    // two disagree; any set of single digits agrees and proves nothing.
    expect(getMedian([10, 2, 1])).toBe(2);
  });

  it('averages the middle pair on an even count', () => {
    expect(getMedian([1, 2, 10, 20])).toBe(6);
  });

  it('drops values that are not finite rather than poisoning the result', () => {
    // Gaps and font sizes are parsed from styles, so NaN is what a missing or
    // malformed one produces. One of them would otherwise make every derived
    // threshold NaN and silently disable footer detection.
    expect(getMedian([Number.NaN, 4, 6, 8, Number.POSITIVE_INFINITY])).toBe(6);
  });

  it('returns zero for nothing at all', () => {
    expect(getMedian([])).toBe(0);
    expect(getMedian([Number.NaN])).toBe(0);
  });
});

describe('grouping a page into flow groups', () => {
  const line = (attrs: string, top: number, height: number, fontSize: number, text = 'clause') =>
    `<p ${attrs} style="top:${top}px;left:72px;width:600px;font-size:${fontSize}px"` +
    ` data-base-height="${height}">${text}</p>`;

  it('merges the lines of one paragraph into a single group', () => {
    const page = mount(
      `<div class="pdf-page">` +
        line('data-flow-group="g1"', 100, 20, 12) +
        line('data-flow-group="g1"', 120, 20, 12) +
        line('data-flow-group="g2"', 200, 20, 12) +
        `</div>`,
    );

    const groups = collectPageFlowGroups(page);

    // A PDF import produces one <p> per visual LINE. The footer and page-bottom
    // heuristics reason about paragraphs, so lines have to be recombined first
    // or every one of them looks like a short, supplemental block.
    expect(groups.map((group) => group.id)).toEqual(['g1', 'g2']);
    expect(groups[0]).toMatchObject({ top: 100, bottom: 140, lineCount: 2 });
  });

  it('orders groups by position, not by the order they appear in the DOM', () => {
    const page = mount(
      `<div class="pdf-page">` +
        line('data-flow-group="lower"', 300, 20, 12) +
        line('data-flow-group="upper"', 100, 20, 12) +
        `</div>`,
    );

    // Absolutely positioned lines are frequently out of document order after
    // repagination. The gap arithmetic downstream assumes visual order and
    // produces negative gaps without it.
    expect(collectPageFlowGroups(page).map((group) => group.id)).toEqual(['upper', 'lower']);
  });

  it('averages the font size across the lines of a group', () => {
    const page = mount(
      `<div class="pdf-page">` +
        line('data-flow-group="g1"', 100, 20, 10) +
        line('data-flow-group="g1"', 120, 20, 20) +
        line('data-flow-group="g1"', 140, 20, 30) +
        `</div>`,
    );

    // A running mean, not the last value seen. Footer detection compares a
    // block's size against the body's, so "last line wins" would call a
    // paragraph ending in a small footnote reference a footer.
    expect(collectPageFlowGroups(page)[0].avgFontSize).toBe(20);
  });

  it('keeps paragraphs with no grouping metadata apart', () => {
    const page = mount(
      `<div class="pdf-page">` + line('', 100, 20, 12) + line('', 200, 20, 12) + `</div>`,
    );

    // Falling back to a shared constant would fuse every unlabelled paragraph
    // on the page into one group spanning the whole sheet.
    expect(collectPageFlowGroups(page)).toHaveLength(2);
  });

  it('falls back through the id attributes in order', () => {
    const page = mount(
      `<div class="pdf-page">` +
        line('data-logical-paragraph-id="L1" data-paragraph-id="P1"', 100, 20, 12) +
        line('data-paragraph-id="P2"', 200, 20, 12) +
        `</div>`,
    );

    expect(collectPageFlowGroups(page).map((group) => group.id)).toEqual(['L1', 'P2']);
  });

  it('calls a group blank only when every line in it is blank', () => {
    const page = mount(
      `<div class="pdf-page">` +
        line('data-flow-group="mixed" data-blank-line="true"', 100, 20, 12, ' ') +
        line('data-flow-group="mixed"', 120, 20, 12, 'clause') +
        line('data-flow-group="empty" data-blank-line="true"', 200, 20, 12, ' ') +
        `</div>`,
    );

    const groups = collectPageFlowGroups(page);

    // Blank groups are excluded from the footer and content-bottom heuristics.
    // Marking a paragraph blank because it opens with a spacer line would hide
    // real content from both.
    expect(groups.find((group) => group.id === 'mixed')!.isBlank).toBe(false);
    expect(groups.find((group) => group.id === 'empty')!.isBlank).toBe(true);
  });
});

describe('detecting a footer band', () => {
  /**
   * A page whose body fills the top and whose last block is a small, narrow,
   * well-separated line near the bottom: a page number or a firm address.
   */
  const withFooter = (footer: string) =>
    mount(
      `<div class="pdf-page" style="width:816px" data-base-min-height="1056"` +
        ` data-column-left="72" data-column-right="744">` +
        `<p data-flow-group="b1" style="top:100px;left:72px;width:672px;font-size:12px" data-base-height="20">Body one</p>` +
        `<p data-flow-group="b2" style="top:130px;left:72px;width:672px;font-size:12px" data-base-height="20">Body two</p>` +
        `<p data-flow-group="b3" style="top:160px;left:72px;width:672px;font-size:12px" data-base-height="20">Body three</p>` +
        footer +
        `</div>`,
    );

  it('finds a small, narrow block separated from the body near the page bottom', () => {
    const page = withFooter(
      `<p data-flow-group="f1" style="top:960px;left:72px;width:200px;font-size:8px" data-base-height="12">Page 1 of 3</p>`,
    );

    // Everything below the footer top is reserved, so body text never flows into
    // the band where the page number is printed and overprints it.
    expect(detectFooterBandTop(page)).toBe(960);
  });

  it('does not call full-width body text at the bottom of the page a footer', () => {
    const page = withFooter(
      `<p data-flow-group="f1" style="top:960px;left:72px;width:672px;font-size:12px" data-base-height="20">The parties agree as follows.</p>`,
    );

    // A false positive here reserves a band the body needs, forcing an early
    // page break and leaving a hole at the foot of the page.
    expect(detectFooterBandTop(page)).toBeNull();
  });

  it('does not treat a block near the body as a footer however small it is', () => {
    const page = withFooter(
      `<p data-flow-group="f1" style="top:185px;left:72px;width:200px;font-size:8px" data-base-height="12">See note</p>`,
    );

    // Separation from the body is what makes a footer a footer. A small aside
    // sitting right under a clause is part of the clause.
    expect(detectFooterBandTop(page)).toBeNull();
  });

  it('has no answer for a page with only one block', () => {
    const page = mount(
      `<div class="pdf-page" style="width:816px" data-base-min-height="1056">` +
        `<p data-flow-group="only" style="top:960px;left:72px;width:200px;font-size:8px" data-base-height="12">Page 1</p>` +
        `</div>`,
    );

    // With nothing to compare against there is no body to be supplemental to.
    expect(detectFooterBandTop(page)).toBeNull();
  });
});

describe('inferring where a page\'s content should end', () => {
  /**
   * A short sheet (460px) with a footer at 400 and body blocks above it. The
   * first block's height is the variable: tall enough and the body demonstrably
   * occupies the band the footer heuristic wants to reserve.
   */
  const sheet = (firstHeight: number) =>
    mount(
      `<div class="pdf-page" style="width:816px" data-base-min-height="460"` +
        ` data-column-left="72" data-column-right="744">` +
        `<p data-flow-group="a" style="top:100px;left:72px;width:672px;font-size:12px" data-base-height="${firstHeight}">Long clause</p>` +
        `<p data-flow-group="b" style="top:200px;left:72px;width:672px;font-size:12px" data-base-height="20">Body two</p>` +
        `<p data-flow-group="c" style="top:230px;left:72px;width:672px;font-size:12px" data-base-height="20">Body three</p>` +
        `<p data-flow-group="f" style="top:400px;left:72px;width:200px;font-size:8px" data-base-height="12">Page 1</p>` +
        `</div>`,
    );

  it('reserves the band above a detected footer', () => {
    const page = sheet(20);

    // The footer starts at 400 and the padding derived from the page's own
    // spacing is 60, so the body may run to 340 and no further.
    expect(inferAutoPageContentBottom(page, 72)).toBe(340);
  });

  it('abandons the reservation when body text already occupies the band', () => {
    // Same page, but the first clause is 800px tall and runs to 900, straight
    // through the band the footer heuristic wants to protect. Reserving it
    // anyway creates a no-man's-land: the page breaks early and leaves a large
    // gap while the text it was protecting is still printed there.
    const page = sheet(800);

    expect(inferAutoPageContentBottom(page, 72)).toBe(436);
  });

  it('falls back to the margin rule when there is no footer', () => {
    const page = mount(
      `<div class="pdf-page" style="width:816px" data-base-min-height="1056">` +
        `<p data-flow-group="a" style="top:100px;left:72px;width:672px;font-size:12px" data-base-height="20">Body</p>` +
        `</div>`,
    );

    // 1056 gives 960 from the margin rules, and the single paragraph ends far
    // above that, so the page keeps its full column.
    expect(inferAutoPageContentBottom(page, 72)).toBe(960);
  });

  it('lets content that runs past the margin extend the column', () => {
    const page = mount(
      `<div class="pdf-page" style="width:816px" data-base-min-height="1056"` +
        ` data-column-left="72" data-column-right="744">` +
        `<p data-flow-group="a" style="top:100px;left:72px;width:672px;font-size:12px" data-base-height="20">Body</p>` +
        `<p data-flow-group="b" style="top:900px;left:72px;width:672px;font-size:12px" data-base-height="80">Deep body</p>` +
        `</div>`,
    );

    // Content already sits at 980. Reporting the nominal 960 would declare the
    // author's own layout overflowing and break the page under it.
    expect(inferAutoPageContentBottom(page, 72)).toBe(1004);
  });
});

describe('refreshing a page\'s content bottom during repagination', () => {
  const sheet = (attrs: string) =>
    mount(
      `<div class="pdf-page" style="width:816px" data-base-min-height="460"` +
        ` data-column-left="72" data-column-right="744" ${attrs}>` +
        `<p data-flow-group="a" style="top:100px;left:72px;width:672px;font-size:12px" data-base-height="20">Long clause</p>` +
        `<p data-flow-group="b" style="top:200px;left:72px;width:672px;font-size:12px" data-base-height="20">Body two</p>` +
        `<p data-flow-group="c" style="top:230px;left:72px;width:672px;font-size:12px" data-base-height="20">Body three</p>` +
        `<p data-flow-group="f" style="top:400px;left:72px;width:200px;font-size:8px" data-base-height="12">Page 1</p>` +
        `</div>`,
    );

  it('leaves a manually dragged boundary alone', () => {
    const page = sheet('data-base-content-bottom="300" data-base-content-bottom-source="manual"');

    refreshAutoPageContentBottom(page);

    // The user dragged that line. Recomputing it throws away an explicit
    // decision every time they press a key.
    expect(page.dataset.baseContentBottom).toBe('300');
    expect(page.dataset.baseContentBottomSource).toBe('manual');
  });

  it('stores the inferred bottom when the page has none', () => {
    const page = sheet('');

    refreshAutoPageContentBottom(page);

    expect(page.dataset.baseContentBottom).toBe('340');
    expect(page.dataset.baseContentBottomSource).toBe('auto');
  });

  it('lets the bottom shrink when a footer is detected', () => {
    const page = sheet('data-base-content-bottom="420"');

    refreshAutoPageContentBottom(page);

    expect(page.dataset.baseContentBottom).toBe('340');
  });

  it('refuses to let the bottom ratchet outward past what is stored', () => {
    // The inferred value follows the deepest paragraph plus slack, so storing it
    // raw after every edit walks the writable area toward the page edge. Then
    // Enter at the foot of a full page keeps wedging lines onto it instead of
    // starting the next one.
    const page = sheet('data-base-content-bottom="300"');
    // Removing the footer makes the inferred value 436, well above the stored 300.
    page.querySelector('[data-flow-group="f"]')!.remove();

    refreshAutoPageContentBottom(page);

    expect(page.dataset.baseContentBottom).toBe('364');
  });
});

describe('file type checks', () => {
  const file = (name: string, type = '') => new File(['x'], name, { type });

  it('accepts every extension the picker offers, whatever the case', () => {
    for (const name of ['a.pdf', 'b.DOCX', 'c.Doc', 'd.odt', 'e.rtf', 'f.TXT']) {
      expect(isSupportedTemplateFile(file(name))).toBe(true);
    }
  });

  it('rejects a format the converter cannot read', () => {
    // The upload otherwise fails deep in conversion, after the user has waited.
    expect(isSupportedTemplateFile(file('scan.png'))).toBe(false);
    expect(isSupportedTemplateFile(file('sheet.xlsx'))).toBe(false);
  });

  it('matches on the END of the name, not anywhere in it', () => {
    // A file called "contract.pdf.exe" is not a PDF. Matching a substring would
    // hand it to the PDF import path.
    expect(isSupportedTemplateFile(file('contract.pdf.exe'))).toBe(false);
    expect(isPdfFile(file('contract.pdf.txt'))).toBe(false);
  });

  it('recognises a PDF by media type even when the name does not say so', () => {
    // Browsers hand over files with no useful extension from some sources.
    expect(isPdfFile(file('download', 'application/pdf'))).toBe(true);
  });

  it('does not confuse a .doc with a .docx', () => {
    // They take different conversion paths. The legacy .doc has no placeholder
    // support in the docx editor.
    expect(isDocxFile(file('retainer.doc'))).toBe(false);
    expect(isDocxFile(file('retainer.docx'))).toBe(true);
    expect(isDocxFile(file('retainer.DOCX'))).toBe(true);
  });
});

describe('font mapping and generated ids', () => {
  it('maps a font value to the css stack the document uses', () => {
    expect(getFontCss('Helvetica')).toBe('Arial, Helvetica, sans-serif');
    expect(getFontCss('Courier')).toBe("'Courier New', Courier, monospace");
  });

  it('falls back to a serif stack for an unknown font', () => {
    // An imported document naming a font nobody has must still render as prose,
    // not in the app's UI sans-serif.
    expect(getFontCss('Wingdings')).toBe("'Times New Roman', Times, serif");
  });

  it('generates distinct ids under the given prefix', () => {
    const first = createTemplateDomId('image');
    const second = createTemplateDomId('image');

    // Ids address elements across pages during repagination. A collision points
    // two paragraphs at the same layout record.
    expect(first).toMatch(/^image_[a-z0-9]+$/);
    expect(first).not.toBe(second);
  });
});

it('new image objects carry numeric priority metadata before they are edited', () => {
  const image = createTemplateImageObjectElement(document, { left: 0, top: 0, width: 100, height: 100, intrinsicWidth: 100, intrinsicHeight: 100, src: 'https://files.test/image.png' });
  expect(image.dataset.templateImagePriority).toBe('0');
  expect(image.hasAttribute('data-template-image-layer')).toBe(false);
});
