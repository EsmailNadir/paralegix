/**
 * Layout side of `buildFilledTemplateHtml`: what happens to the PAGE when a
 * repeater expands.
 *
 * `templateFill.test.ts` covers the text substitution (which chip gets which
 * value). Everything below covers the half that moves things: a repeater with
 * three rows is taller than the one-row block the template author drew, so
 * every paragraph, image and text box beneath it has to move down by exactly
 * the right amount, and whatever no longer fits has to cross onto the next
 * page without losing a character.
 *
 * These failures are the dangerous kind because the document still looks like a
 * document. A stride computed one way instead of another gives evenly spaced
 * rows that overlap the paragraph below. A paragraph split at the wrong offset
 * drops or duplicates a clause. A page break in the wrong place buries a
 * signature line. None of it throws, and all of it is printed and sent.
 *
 * The module parses with `DOMParser` and does its own arithmetic from
 * `style.top`, `data-base-height` and `font-size`, so nothing here depends on
 * jsdom performing layout. Every expected number below is derived from those
 * inputs by hand and stated in the test, so a changed formula fails rather than
 * quietly agreeing with itself.
 *
 * Vocabulary used throughout, matching the source:
 *   block height  the vertical extent of the repeater's template paragraphs
 *   stride        how far down each cloned row is pushed (= block height)
 *   extra height  (rows - 1) x stride, what the page grew by
 *   content bottom the last y a paragraph may occupy on the page
 */
import { buildFilledTemplateHtml } from '@/components/templatesComp/templateFill';

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** `style.top` as a number. NaN (missing) fails the assertion rather than defaulting. */
function topOf(el: Element): number {
  return Number.parseFloat((el as HTMLElement).style.top);
}

function textOf(el: Element | null): string {
  return (el?.textContent ?? '').replace(/ /g, ' ');
}

/** Body paragraphs of page `index`, in visual order (top ascending). */
function paragraphsOnPage(doc: Document, index: number): HTMLElement[] {
  const page = doc.querySelectorAll<HTMLElement>('.pdf-page')[index];
  return Array.from(page.querySelectorAll<HTMLElement>(':scope > p')).sort(
    (a, b) => topOf(a) - topOf(b),
  );
}

/**
 * One page with the geometry metadata the filler reads: `data-base-min-height`
 * is the physical page, `data-base-content-bottom` the last usable y.
 */
function page(body: string, opts: { minHeight?: number; contentBottom?: number; contentTop?: number } = {}) {
  const minHeight = opts.minHeight ?? 1056;
  const contentBottom = opts.contentBottom ?? 960;
  const contentTop = opts.contentTop ?? 72;
  return (
    `<div class="pdf-page" style="width:816px;min-height:${minHeight}px"` +
    ` data-base-min-height="${minHeight}"` +
    ` data-base-content-top="${contentTop}"` +
    ` data-base-content-bottom="${contentBottom}">${body}</div>`
  );
}

const amountChip = '<span data-placeholder-chip="rows.amount">Amount</span>';

describe('repeater row geometry', () => {
  /**
   * Two template lines 30px apart, each 30px tall, so the block spans
   * top 100 to bottom 160 and the stride is 60. Row n therefore lands at
   * 100 + 60n and 130 + 60n.
   */
  const twoLineBlock =
    `<p data-repeater="rows" data-base-height="30" style="top:100px">${amountChip}</p>` +
    `<p data-repeater="rows" data-base-height="30" style="top:130px">due</p>`;

  it('places each row a full block height below the previous one', () => {
    const filled = buildFilledTemplateHtml(page(twoLineBlock), {}, {
      rows: [{ amount: 'A' }, { amount: 'B' }, { amount: 'C' }],
    });

    // Stride is the block's own height (160 - 100 = 60), NOT the distance to
    // the next sibling paragraph. Using the sibling distance would include the
    // gap between the repeater and the content after it, spacing the rows out
    // and leaving holes in a payment schedule.
    expect(paragraphsOnPage(parse(filled), 0).map(topOf)).toEqual([
      100, 130, // row 1
      160, 190, // row 2
      220, 250, // row 3
    ]);
  });

  it('keeps each row value with the row that owns it', () => {
    const filled = buildFilledTemplateHtml(page(twoLineBlock), {}, {
      rows: [{ amount: '$300.00' }, { amount: '$100.00' }, { amount: '$200.00' }],
    });

    // The amounts are deliberately out of lexical order. A clone loop that
    // emitted rows in any other sequence, or one whose result happened to be
    // sorted, would be caught here and would not be caught by ascending values.
    const amounts = paragraphsOnPage(parse(filled), 0)
      .filter((p) => textOf(p) !== 'due')
      .map(textOf);
    expect(amounts).toEqual(['$300.00', '$100.00', '$200.00']);
  });

  it('derives the block height from font size x line height when no height is stored', () => {
    // 20px text at line-height 1.5 is a 30px line, so row 2 starts at 130.
    const block = `<p data-repeater="rows" style="top:100px;font-size:20px;line-height:1.5">${amountChip}</p>`;

    const filled = buildFilledTemplateHtml(page(block), {}, {
      rows: [{ amount: 'A' }, { amount: 'B' }],
    });

    expect(paragraphsOnPage(parse(filled), 0).map(topOf)).toEqual([100, 130]);
  });

  it('assumes a 1.2 line height when the paragraph does not declare one', () => {
    // Same 20px text with no line-height: 20 x 1.2 = 24, so row 2 starts at 124.
    // Distinct from the 1.5 case above, so a changed default cannot pass both.
    const block = `<p data-repeater="rows" style="top:100px;font-size:20px">${amountChip}</p>`;

    const filled = buildFilledTemplateHtml(page(block), {}, {
      rows: [{ amount: 'A' }, { amount: 'B' }],
    });

    expect(paragraphsOnPage(parse(filled), 0).map(topOf)).toEqual([100, 124]);
  });

  it('prefers the stored height over the font-size estimate', () => {
    // The paragraph says 20px/1.5 (a 30px estimate) but carries a measured
    // height of 48. The measurement is the real wrapped height and wins;
    // preferring the estimate would overlap wrapped rows onto each other.
    const block =
      `<p data-repeater="rows" data-base-height="48" style="top:100px;font-size:20px;line-height:1.5">${amountChip}</p>`;

    const filled = buildFilledTemplateHtml(page(block), {}, {
      rows: [{ amount: 'A' }, { amount: 'B' }],
    });

    expect(paragraphsOnPage(parse(filled), 0).map(topOf)).toEqual([100, 148]);
  });

  it('strips the grouping metadata from each clone', () => {
    const filled = buildFilledTemplateHtml(page(
      `<p data-repeater="rows" data-flow-group="g1" data-paragraph-id="p1"` +
      ` data-logical-paragraph-id="l1" data-wrap-enabled="true"` +
      ` data-base-height="30" style="top:100px">${amountChip}</p>`,
    ), {}, { rows: [{ amount: 'A' }, { amount: 'B' }] });

    // Rows share the template's ids. Left in place, the editor's normalisation
    // treats the clones as one logical paragraph and merges the schedule back
    // into a single run of text.
    expect(filled).not.toContain('data-flow-group');
    expect(filled).not.toContain('data-paragraph-id');
    expect(filled).not.toContain('data-logical-paragraph-id');
    expect(filled).not.toContain('data-wrap-enabled');
    expect(filled).not.toContain('data-repeater=');
    // The transform did run: two rows exist to have been stripped.
    expect(paragraphsOnPage(parse(filled), 0)).toHaveLength(2);
  });

  it('rewrites data-base-top on a clone alongside style.top', () => {
    const block =
      `<p data-repeater="rows" data-base-top="100" data-base-height="30" style="top:100px">${amountChip}</p>`;

    const filled = buildFilledTemplateHtml(page(block), {}, {
      rows: [{ amount: 'A' }, { amount: 'B' }],
    });

    // Repagination reads data-base-top. A clone whose stored top still says 100
    // is dragged back on top of row 1 the next time the page is laid out.
    const rows = paragraphsOnPage(parse(filled), 0);
    expect(rows.map((p) => p.dataset.baseTop)).toEqual(['100', '130']);
  });
});

describe('content beneath an expanded repeater', () => {
  /** A one-line block at 100..140, expanded to three rows: stride 40, extra 80. */
  const block = `<p data-repeater="rows" data-base-height="40" style="top:100px">${amountChip}</p>`;
  const threeRows = { rows: [{ amount: 'A' }, { amount: 'B' }, { amount: 'C' }] };

  it('pushes down a paragraph that starts exactly at the block bottom', () => {
    const filled = buildFilledTemplateHtml(
      page(`${block}<p data-role="after" style="top:140px">Total due</p>`),
      {},
      threeRows,
    );

    // 140 is the first y the expanded block reaches into. Treating the boundary
    // as exclusive would leave this paragraph underneath the last row.
    const after = parse(filled).querySelector('[data-role="after"]')!;
    expect(topOf(after)).toBe(220);
  });

  it('leaves a paragraph one pixel above the boundary where it is', () => {
    const filled = buildFilledTemplateHtml(
      page(`${block}<p data-role="beside" style="top:139px">Beside</p>`),
      {},
      threeRows,
    );

    // 139 is inside the template block's own span, so it is content the author
    // placed level with the repeater, not below it. Shifting it would drag a
    // side note down the page every time a row is added.
    const beside = parse(filled).querySelector('[data-role="beside"]')!;
    expect(topOf(beside)).toBe(139);
  });

  it('leaves content above the repeater untouched', () => {
    const filled = buildFilledTemplateHtml(
      page(`<p data-role="above" style="top:50px">Schedule of payments</p>${block}`),
      {},
      threeRows,
    );

    const above = parse(filled).querySelector('[data-role="above"]')!;
    expect(topOf(above)).toBe(50);
  });

  it('moves an image object that sits below the repeater', () => {
    const filled = buildFilledTemplateHtml(
      page(`${block}<div data-template-image-object-id="sig" style="top:300px;height:40px"></div>`),
      {},
      threeRows,
    );

    // A signature block is an image object. Left where it was, three rows of
    // payments are printed over the top of it.
    const image = parse(filled).querySelector('[data-template-image-object-id="sig"]')!;
    expect(topOf(image)).toBe(380);
  });

  it('does NOT move a pinned background or a behind-text watermark', () => {
    const filled = buildFilledTemplateHtml(
      page(
        `${block}` +
        `<div data-template-image-object-id="letterhead" data-template-image-pinned="true" style="top:300px"></div>` +
        `<div data-template-image-object-id="mark" data-template-image-behind-text="true" style="top:300px"></div>` +
        `<div data-template-image-object-id="sig" style="top:300px"></div>`,
      ),
      {},
      threeRows,
    );

    // These are page furniture: a letterhead pinned to the sheet and a watermark
    // behind the text. They belong to the page, not the flow, so they stay put
    // while the ordinary object beside them moves.
    const doc = parse(filled);
    expect(topOf(doc.querySelector('[data-template-image-object-id="letterhead"]')!)).toBe(300);
    expect(topOf(doc.querySelector('[data-template-image-object-id="mark"]')!)).toBe(300);
    expect(topOf(doc.querySelector('[data-template-image-object-id="sig"]')!)).toBe(380);
  });

  it('keeps data-base-top in step with the shift', () => {
    const filled = buildFilledTemplateHtml(
      page(`${block}<p data-role="after" data-base-top="140" style="top:140px">Total due</p>`),
      {},
      threeRows,
    );

    const after = parse(filled).querySelector<HTMLElement>('[data-role="after"]')!;
    expect(after.dataset.baseTop).toBe('220');
  });

  it('does not shift anything when the repeater has a single row', () => {
    const filled = buildFilledTemplateHtml(
      page(`${block}<p data-role="after" style="top:140px">Total due</p>`),
      {},
      { rows: [{ amount: 'A' }] },
    );

    // One row is exactly the space the template already reserved, so extra
    // height is zero and the whole shifting pass must be skipped.
    const doc = parse(filled);
    expect(topOf(doc.querySelector('[data-role="after"]')!)).toBe(140);
    expect(textOf(paragraphsOnPage(doc, 0)[0])).toBe('A');
  });
});

describe('crossing the page boundary', () => {
  /**
   * A short page (content bottom 500) with a three-row repeater at the top and
   * one paragraph low down. Stride 40, extra height 80, so the paragraph at 400
   * lands at 480 with 20px of page left and 60px of text: it straddles.
   */
  const straddleBody =
    `<p data-repeater="rows" data-base-height="40" style="top:100px">${amountChip}</p>` +
    `<p data-role="body" data-base-height="60" style="top:400px">Later paragraph</p>`;
  const threeRows = { rows: [{ amount: 'A' }, { amount: 'B' }, { amount: 'C' }] };
  const shortPage = { minHeight: 600, contentBottom: 500 };

  it('splits a straddling paragraph and keeps every character', () => {
    const filled = buildFilledTemplateHtml(
      page(straddleBody, shortPage) + page('', shortPage),
      {},
      threeRows,
    );

    // The split is the whole point: the alternative is a paragraph clipped at
    // the page edge, which silently deletes the end of a clause. Head plus tail
    // must reconstruct the original exactly, with nothing dropped or repeated.
    const doc = parse(filled);
    const head = paragraphsOnPage(doc, 0).find((p) => textOf(p).startsWith('Later'))!;
    const tail = paragraphsOnPage(doc, 1)[0];
    expect(textOf(head) + textOf(tail)).toBe('Later paragraph');
  });

  it('splits at a word boundary rather than mid-word', () => {
    const filled = buildFilledTemplateHtml(
      page(straddleBody, shortPage) + page('', shortPage),
      {},
      threeRows,
    );

    // The fitting fraction is 20/60, whose raw character index falls inside
    // "Later". Snapping to the following space is what stops a document reading
    // "Lat" at the foot of page 1 and "er paragraph" at the head of page 2.
    const doc = parse(filled);
    const head = paragraphsOnPage(doc, 0).find((p) => textOf(p).startsWith('Later'))!;
    expect(textOf(head)).toBe('Later ');
  });

  it('reserves the rest of page 1 for the head and marks the tail', () => {
    const filled = buildFilledTemplateHtml(
      page(straddleBody, shortPage) + page('', shortPage),
      {},
      threeRows,
    );

    const doc = parse(filled);
    const head = paragraphsOnPage(doc, 0).find((p) => textOf(p).startsWith('Later'))!;
    // 500 - 480 is the space actually left on the page, and the head is told to
    // occupy it so nothing else is laid into the same band.
    expect(head.dataset.baseHeight).toBe('20');
    // The tail carries the marker that keeps the second repositioning pass off
    // it; without the marker it is pulled back up into the head's reserved band.
    const tail = paragraphsOnPage(doc, 1)[0];
    expect(tail.dataset.splitTail).toBe('1');
  });

  it('moves the overflow onto the existing next page, below its content top', () => {
    const filled = buildFilledTemplateHtml(
      page(straddleBody, shortPage) + page('', shortPage),
      {},
      threeRows,
    );

    const doc = parse(filled);
    expect(doc.querySelectorAll('.pdf-page')).toHaveLength(2);
    // Page 2 declares a content top of 72, and the moved paragraph is seated
    // there rather than keeping page 1's coordinate.
    expect(topOf(paragraphsOnPage(doc, 1)[0])).toBe(72);
  });

  it('pushes the next page\'s own content below what arrived from page 1', () => {
    const filled = buildFilledTemplateHtml(
      page(straddleBody, shortPage) +
        page('<p data-role="page2" style="top:72px">Second page opening</p>', shortPage),
      {},
      threeRows,
    );

    // The tail is 40px tall and starts at 72, so page 2's existing first
    // paragraph moves from 72 to 112. Leaving it at 72 prints the two on top of
    // each other; shifting it by the full 112 would leave a blank band above it.
    const page2 = parse(filled).querySelector('[data-role="page2"]')!;
    expect(topOf(page2)).toBe(112);
  });

  it('creates a page when there is no next one, carrying the page background over', () => {
    const filled = buildFilledTemplateHtml(
      page(
        `<img class="pdf-page-background" src="letterhead.png">` +
        `<div data-template-image-object-id="stamp" data-template-image-pinned="true" style="top:20px"></div>` +
        straddleBody,
        shortPage,
      ),
      {},
      threeRows,
    );

    const doc = parse(filled);
    const pages = doc.querySelectorAll<HTMLElement>('.pdf-page');
    expect(pages).toHaveLength(2);
    // A continuation sheet without the firm's letterhead is obviously wrong to
    // the client and not obviously wrong to whoever generated it.
    expect(pages[1].querySelector('img.pdf-page-background')?.getAttribute('src')).toBe('letterhead.png');
    expect(pages[1].querySelector('[data-template-image-pinned="true"]')).not.toBeNull();
    expect(textOf(paragraphsOnPage(doc, 1)[0])).toBe('paragraph');
  });

  it('leaves a paragraph that still fits on page 1 alone', () => {
    // Same page, but the paragraph starts at 300 so after the 80px shift it
    // ends at 440, comfortably inside the 500 content bottom. One paragraph
    // short of the boundary, and it must not be split or moved.
    const body =
      `<p data-repeater="rows" data-base-height="40" style="top:100px">${amountChip}</p>` +
      `<p data-role="body" data-base-height="60" style="top:300px">Later paragraph</p>`;

    const filled = buildFilledTemplateHtml(page(body, shortPage) + page('', shortPage), {}, threeRows);

    const doc = parse(filled);
    expect(paragraphsOnPage(doc, 1)).toHaveLength(0);
    const body1 = doc.querySelector('[data-role="body"]')!;
    expect(topOf(body1)).toBe(380);
    expect(textOf(body1)).toBe('Later paragraph');
  });

  it('refuses to split a paragraph too short to divide usefully', () => {
    // Four characters, under the five-character floor. Splitting it would put
    // one or two letters alone at the foot of a page.
    const body =
      `<p data-repeater="rows" data-base-height="40" style="top:100px">${amountChip}</p>` +
      `<p data-role="body" data-base-height="60" style="top:400px">Paid</p>`;

    const filled = buildFilledTemplateHtml(page(body, shortPage) + page('', shortPage), {}, threeRows);

    const doc = parse(filled);
    // It moves whole rather than being cut up.
    expect(paragraphsOnPage(doc, 0).map(textOf)).toEqual(['A', 'B', 'C']);
    expect(paragraphsOnPage(doc, 1).map(textOf)).toEqual(['Paid']);
  });
});

describe('closing the gap under a paragraph split on an earlier pass', () => {
  /**
   * A page whose HTML already carries a head/tail pair from a previous fill.
   * The head is at 100 with 250 characters of 12px/1.2 text in an 800px page,
   * which the module estimates as 3 lines: floor(800 x 0.82 / 6) = 109 chars a
   * line, ceil(250 / 109) = 3, round(3 x 12 x 1.2) = 43px. So the tail belongs
   * at 143 and everything below it moves up by the same amount.
   */
  const headText = 'x'.repeat(250);

  const splitPage = (tailTop: number, extra = '') =>
    `<div class="pdf-page" style="width:800px">` +
    `<p data-role="head" style="top:100px;font-size:12px;line-height:1.2">${headText}</p>` +
    `<p data-role="tail" data-split-tail="1" style="top:${tailTop}px;font-size:12px">tail text</p>` +
    `${extra}</div>`;

  it('re-seats the tail directly below its head', () => {
    const filled = buildFilledTemplateHtml(splitPage(700), {});

    // The split reserved the remainder of the page for the head so the tail
    // would land on the next page. Once both ended up on the same page that
    // reservation is a hole in the middle of a sentence.
    const tail = parse(filled).querySelector('[data-role="tail"]')!;
    expect(topOf(tail)).toBe(143);
  });

  it('pulls the content below the tail up by the same amount', () => {
    const filled = buildFilledTemplateHtml(
      splitPage(700, '<p data-role="after" style="top:760px">Signed,</p>'),
      {},
    );

    // 760 - 557 = 203. Moving only the tail would close the gap above it and
    // open an identical one below.
    const after = parse(filled).querySelector('[data-role="after"]')!;
    expect(topOf(after)).toBe(203);
  });

  it('leaves the pair alone when the gap is only two pixels', () => {
    const filled = buildFilledTemplateHtml(
      splitPage(145, '<p data-role="after" style="top:200px">Signed,</p>'),
      {},
    );

    // 145 - 143 = 2, which is rounding noise from the height estimate rather
    // than a real hole. Acting on it would jitter the layout on every fill.
    const doc = parse(filled);
    expect(topOf(doc.querySelector('[data-role="tail"]')!)).toBe(145);
    expect(topOf(doc.querySelector('[data-role="after"]')!)).toBe(200);
  });

  it('acts on a three pixel gap', () => {
    const filled = buildFilledTemplateHtml(
      splitPage(146, '<p data-role="after" style="top:200px">Signed,</p>'),
      {},
    );

    // One pixel past the threshold, so the same layout now closes by 3. Paired
    // with the case above this pins the threshold itself rather than the side
    // of it a comfortable value happens to fall on.
    const doc = parse(filled);
    expect(topOf(doc.querySelector('[data-role="tail"]')!)).toBe(143);
    expect(topOf(doc.querySelector('[data-role="after"]')!)).toBe(197);
  });

  it('does not drag a pinned image up with the text', () => {
    const filled = buildFilledTemplateHtml(
      splitPage(
        700,
        `<div data-template-image-object-id="stamp" data-template-image-pinned="true" style="top:760px"></div>` +
        `<div data-template-image-object-id="chart" style="top:760px"></div>`,
      ),
      {},
    );

    const doc = parse(filled);
    expect(topOf(doc.querySelector('[data-template-image-object-id="stamp"]')!)).toBe(760);
    expect(topOf(doc.querySelector('[data-template-image-object-id="chart"]')!)).toBe(203);
  });
});

describe('chip replacement markup', () => {
  it('carries the chip font onto the replacement text', () => {
    const html = `<p><span data-placeholder-chip="clientName" style="font-family:Georgia, serif;font-size:14px">Client</span></p>`;

    const filled = buildFilledTemplateHtml(html, { clientName: 'Acme Corporation' });

    // The chip is deleted and a plain span put in its place. If the span does
    // not inherit the chip's font, the filled value renders in a different
    // typeface from the sentence around it, on every filled document.
    const span = parse(filled).querySelector<HTMLElement>('p span')!;
    expect(span.textContent).toBe('Acme Corporation');
    expect(span.style.fontFamily).toBe('Georgia, serif');
    expect(span.style.fontSize).toBe('14px');
  });

  it('carries a real weight, colour and slant', () => {
    const html =
      `<p><span data-placeholder-chip="clientName"` +
      ` style="font-weight:700;font-style:italic;color:rgb(15, 23, 42)">Client</span></p>`;

    const filled = buildFilledTemplateHtml(html, { clientName: 'Acme Corporation' });

    const span = parse(filled).querySelector<HTMLElement>('p span')!;
    expect(span.style.fontWeight).toBe('700');
    expect(span.style.fontStyle).toBe('italic');
    expect(span.style.color).toBe('rgb(15, 23, 42)');
  });

  it('does not copy an "inherit" weight, slant or colour onto the span', () => {
    const html =
      `<p style="font-weight:700"><span data-placeholder-chip="clientName"` +
      ` style="font-weight:inherit;font-style:inherit;color:inherit">Client</span></p>`;

    const filled = buildFilledTemplateHtml(html, { clientName: 'Acme Corporation' });

    // Copying the literal keyword is not harmless: the chip inherits from the
    // paragraph, but the replacement span is written with an explicit value, so
    // stamping "inherit" as a declaration is at best redundant and at worst
    // resolves against a different parent after the node moves pages.
    const span = parse(filled).querySelector<HTMLElement>('p span')!;
    expect(span.textContent).toBe('Acme Corporation');
    expect(span.getAttribute('style') ?? '').not.toContain('inherit');
  });

  it('strips the chip\'s editor scaffolding instead of printing it', () => {
    const html =
      `<p><span data-placeholder-chip="clientName">` +
      `<span data-chip-remove="1">x</span><span>Client name</span></span></p>`;

    const filled = buildFilledTemplateHtml(html, { clientName: 'Acme Corporation' });

    // The delete affordance and the field label belong to the editor. Printed
    // into a client document they read as stray characters in the sentence.
    const text = textOf(parse(filled).body);
    expect(text).toBe('Acme Corporation');
    expect(filled).not.toContain('data-chip-remove');
  });

  it('removes the repeater label banner', () => {
    const html = page(
      `<p data-repeater-label="rows">Payments</p>` +
      `<p data-repeater="rows" data-base-height="30" style="top:100px">${amountChip}</p>`,
    );

    const filled = buildFilledTemplateHtml(html, {}, { rows: [{ amount: '$100.00' }] });

    // The banner names the repeater for the template author. It is not part of
    // the agreement.
    expect(textOf(parse(filled).body)).not.toContain('Payments');
    expect(textOf(parse(filled).body)).toContain('$100.00');
  });

  it('strips zero-width spaces from the value and from the template text', () => {
    const html = `<p>Between​ <span data-placeholder-chip="clientName">Client</span>​ and the Firm.</p>`;

    const filled = buildFilledTemplateHtml(html, { clientName: 'Acme​ Corporation' });

    // The editor pads chips with zero-width spaces so the caret can sit beside
    // them. They are invisible on screen and survive a copy out of the PDF, so
    // a name pasted from a filled document silently carries them into search
    // and into other systems.
    expect(filled).not.toContain('​');
    expect(textOf(parse(filled).body)).toBe('Between Acme Corporation and the Firm.');
  });

  it('preserves emphasis markup around a filled value', () => {
    const html = `<p><strong>Client: <span data-placeholder-chip="clientName">Client</span></strong></p>`;

    const filled = buildFilledTemplateHtml(html, { clientName: 'Acme Corporation' });

    // Only the chip is replaced. Losing the <strong> would quietly restyle
    // defined terms across the agreement.
    const strong = parse(filled).querySelector('strong');
    expect(strong).not.toBeNull();
    expect(textOf(strong)).toBe('Client: Acme Corporation');
  });

  it('preserves markup inside a cloned repeater row', () => {
    const html = page(
      `<p data-repeater="rows" data-base-height="30" style="top:100px">` +
      `<em>Instalment</em> <span data-placeholder-chip="rows.amount">Amount</span></p>`,
    );

    const filled = buildFilledTemplateHtml(html, {}, {
      rows: [{ amount: '$100.00' }, { amount: '$200.00' }],
    });

    const doc = parse(filled);
    expect(doc.querySelectorAll('em')).toHaveLength(2);
    expect(paragraphsOnPage(doc, 0).map(textOf)).toEqual(['Instalment $100.00', 'Instalment $200.00']);
  });
});

describe('degenerate input', () => {
  it('returns a document for empty html without touching a page', () => {
    const filled = buildFilledTemplateHtml('', {}, {});

    expect(parse(filled).querySelectorAll('.pdf-page')).toHaveLength(0);
  });

  it('drops a repeater block whose rows array is empty', () => {
    const html = page(`<p data-repeater="rows" data-base-height="30" style="top:100px">${amountChip}</p>`);

    const filled = buildFilledTemplateHtml(html, {}, { rows: [] });

    // Nothing shifts and nothing is printed, but the template row must not
    // survive as a payment line reading "{rows.amount}".
    expect(paragraphsOnPage(parse(filled), 0)).toHaveLength(0);
  });

  it('processes a repeater once even when it spans several paragraphs', () => {
    const html = page(
      `<p data-repeater="rows" data-base-height="20" style="top:100px">${amountChip}</p>` +
      `<p data-repeater="rows" data-base-height="20" style="top:120px">payable on demand</p>`,
    );

    const filled = buildFilledTemplateHtml(html, {}, { rows: [{ amount: '$100.00' }] });

    // The loop visits every element carrying the attribute, and each visit
    // clones the WHOLE block. Without the processed-name guard a two-line
    // repeater emits each row twice.
    expect(paragraphsOnPage(parse(filled), 0).map(textOf)).toEqual(['$100.00', 'payable on demand']);
  });
});
