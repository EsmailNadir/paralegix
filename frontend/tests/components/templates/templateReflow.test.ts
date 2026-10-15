/**
 * `reflowFilledTemplate()`: the pass that repaginates a filled template in a
 * real browser, run by Puppeteer before the PDF is rendered and injected into
 * the preview window.
 *
 * It is the last thing to touch a document before a client sees it, and it is
 * the only thing that knows the text's ACTUAL height. Everything upstream
 * estimates: `buildFilledTemplateHtml` guesses a paragraph's height from its
 * character count because it works on a parsed document with no layout. This
 * function measures, then fixes the difference. Three jobs:
 *
 *   1. A paragraph whose replacement text made it taller pushes what is below
 *      it down. Without this, a long client name overlaps the next clause.
 *   2. A paragraph that no longer fits the page is split at a real line
 *      boundary and its remainder moved to the next page, creating pages as
 *      needed. Without this, the text is clipped at the page edge and the
 *      clipped part is gone from the PDF entirely.
 *   3. Head/tail pairs that the upstream character-fraction split produced are
 *      re-merged first, so the split can be redone against measured lines
 *      instead of a character guess.
 *
 * A LAYOUT STUB IS UNAVOIDABLE HERE. jsdom reports `offsetHeight` as 0 for
 * everything, and 0 makes every paragraph fit every page, so the whole module
 * would no-op and every assertion would be vacuous. `installFakeLayout()` below
 * replaces `offsetHeight` with a deterministic text-wrapping model: a fixed
 * character budget per line, `ceil` to whole lines, line height from the
 * paragraph's own font-size and line-height. It is monotonic in text length,
 * which is the only property the module's binary search needs.
 *
 * That means these tests exercise the module's LOGIC against a known layout,
 * not the browser's real line breaking. Every fixture below uses 10px text at
 * line-height 2 in a 600px column, so one line is exactly 20px and exactly 100
 * characters, and every expected number in this file is derived from those two
 * constants by hand.
 */
import { reflowFilledTemplate as sharedReflow } from '@/components/templatesComp/templateReflow';

// Execute the same serialized function that preview injection and Puppeteer receive.
const reflowFilledTemplate = new Function(`return (${sharedReflow.toString()})`)() as typeof sharedReflow;

let restoreLayout: (() => void) | null = null;

/**
 * Replace jsdom's always-zero `offsetHeight` / `offsetWidth` with a wrapping
 * model driven by the element's own inline styles.
 *
 * Paragraphs wrap: height = ceil(chars / charsPerLine) x fontSize x lineHeight,
 * at least one line. Anything else reports its declared `height`, which is how
 * image objects and text boxes are sized in a template anyway.
 */
function installFakeLayout() {
  const descriptors = {
    offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight'),
    offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth'),
  };

  const widthOf = (el: HTMLElement) =>
    Number.parseFloat(el.style.width || el.style.maxWidth || '0') || 600;

  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.tagName !== 'P') return Number.parseFloat(this.style.height || '0') || 0;
      const fontSize = Number.parseFloat(this.style.fontSize || '0') || 16;
      const multiplier = Number.parseFloat(this.style.lineHeight || '0') || 1.2;
      const perLine = Math.max(1, Math.floor(widthOf(this) / (fontSize * 0.6)));
      const chars = (this.textContent ?? '').length;
      return Math.max(1, Math.ceil(chars / perLine)) * fontSize * multiplier;
    },
  });

  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return widthOf(this);
    },
  });

  return () => {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
      else delete (HTMLElement.prototype as any)[key];
    }
  };
}

beforeAll(() => {
  restoreLayout = installFakeLayout();
});

afterAll(() => {
  restoreLayout?.();
  restoreLayout = null;
});

afterEach(() => {
  document.body.innerHTML = '';
});

/** `n` four-letter words separated by single spaces: length 5n - 1. */
function words(n: number, separator = ' '): string {
  return Array.from({ length: n }, () => 'abcd').join(separator);
}

/** `n` five-letter words separated by `separator`, so word boundaries sit at multiples of 6. */
function stride6(n: number, separator = ' '): string {
  return Array.from({ length: n }, () => 'abcde').join(separator);
}

/** An absolutely positioned body paragraph in the stub's 10px / 20px-line geometry. */
function para(text: string, top: number, attrs = ''): string {
  return (
    `<p ${attrs} style="position:absolute;top:${top}px;width:600px;font-size:10px;line-height:2">` +
    `${text}</p>`
  );
}

type PageOptions = {
  contentTop?: number;
  contentBottom?: number | null;
  minHeight?: number;
};

function pageHtml(body: string, options: PageOptions = {}): string {
  const contentTop = options.contentTop ?? 72;
  const minHeight = options.minHeight ?? 1056;
  const contentBottom =
    options.contentBottom === undefined ? 900 : options.contentBottom;
  const cbAttr = contentBottom === null ? '' : ` data-base-content-bottom="${contentBottom}"`;
  return (
    `<div class="pdf-page" style="position:relative;width:816px;min-height:${minHeight}px"` +
    ` data-base-content-top="${contentTop}" data-base-min-height="${minHeight}"${cbAttr}>` +
    `${body}</div>`
  );
}

function render(html: string) {
  document.body.innerHTML = html;
}

function pages(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.pdf-page'));
}

/** Paragraphs of page `index` in visual order. */
function parasOn(index: number): HTMLElement[] {
  return Array.from(pages()[index].querySelectorAll<HTMLElement>(':scope > p')).sort(
    (a, b) => Number.parseFloat(a.style.top) - Number.parseFloat(b.style.top),
  );
}

function topOf(el: Element): number {
  return Number.parseFloat((el as HTMLElement).style.top);
}

function role(name: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-role="${name}"]`);
  if (!el) throw new Error(`no element with data-role="${name}"`);
  return el;
}

describe('growth detection', () => {
  it('pushes later paragraphs down by a paragraph that outgrew its stored height', () => {
    // 249 characters is 3 lines (60px) but the stored height says 20px, which is
    // what a one-line placeholder measured before it was filled. The 40px
    // difference is exactly what a longer replacement value costs.
    render(
      pageHtml(
        para(words(50), 100, 'data-role="grown" data-base-height="20"') +
        para('short', 200, 'data-role="below"'),
      ),
    );

    reflowFilledTemplate();

    // Without the shift the grown paragraph's second and third lines are printed
    // over the paragraph below it.
    expect(topOf(role('below'))).toBe(240);
  });

  it('sums the growth of every paragraph above, not just the nearest', () => {
    render(
      pageHtml(
        para(words(50), 100, 'data-role="first" data-base-height="20"') +   // +40
        para(words(30), 200, 'data-role="second" data-base-height="20"') +  // 149 chars = 2 lines, +20
        para('short', 300, 'data-role="third"'),
      ),
    );

    reflowFilledTemplate();

    // The second paragraph moves by the first's growth only; the third moves by
    // both. Applying only the nearest growth leaves the page progressively more
    // overlapped the further down you read.
    expect(topOf(role('second'))).toBe(240);
    expect(topOf(role('third'))).toBe(360);
  });

  it('measures growth from the ORIGINAL position, not the shifted one', () => {
    render(
      pageHtml(
        para(words(50), 100, 'data-role="first" data-base-height="20"') +
        para(words(30), 130, 'data-role="second" data-base-height="20"') +
        para('short', 400, 'data-role="third"'),
      ),
    );

    reflowFilledTemplate();

    // The second paragraph starts at 130, above the first's post-shift position
    // of 140. If growths were compared against shifted tops the second would
    // stop counting as "below the first" and would not move at all.
    expect(topOf(role('second'))).toBe(170);
    expect(topOf(role('third'))).toBe(460);
  });

  it('ignores a two pixel difference but acts on three', () => {
    // The stub gives both paragraphs a measured 20px. Stored 18 is a 2px
    // difference and stored 17 is 3px, which straddles the tolerance the module
    // uses to absorb sub-pixel measurement noise.
    render(
      pageHtml(
        para('short', 100, 'data-role="noise" data-base-height="18"') +
        para('short', 200, 'data-role="afterNoise"'),
      ),
    );
    reflowFilledTemplate();
    expect(topOf(role('afterNoise'))).toBe(200);

    render(
      pageHtml(
        para('short', 100, 'data-role="real" data-base-height="17"') +
        para('short', 200, 'data-role="afterReal"'),
      ),
    );
    reflowFilledTemplate();
    expect(topOf(role('afterReal'))).toBe(203);
  });

  it('records the new height so the same growth is not counted twice', () => {
    render(pageHtml(para(words(50), 100, 'data-role="grown" data-base-height="20"')));

    reflowFilledTemplate();

    // The paragraph may be re-examined on a later page after cascading. Leaving
    // the stale 20 there would shift the page a second time by the same 40px.
    expect(role('grown').dataset.baseHeight).toBe('60');
  });

  it('leaves a paragraph with no stored height alone', () => {
    render(
      pageHtml(
        para(words(50), 100, 'data-role="unmeasured"') +
        para('short', 200, 'data-role="below"'),
      ),
    );

    reflowFilledTemplate();

    // Height 0 means "never measured", not "measured as nothing". Treating the
    // absence as a stored value would report the paragraph's whole height as
    // growth and shove the rest of the page down by it.
    expect(topOf(role('below'))).toBe(200);
  });

  it('shifts a loose image object but not a pinned one or a watermark', () => {
    render(
      pageHtml(
        para(words(50), 100, 'data-base-height="20"') +
        `<div data-role="chart" data-template-image-object-id="c1" style="position:absolute;top:300px;height:50px"></div>` +
        `<div data-role="crest" data-template-image-object-id="c2" data-template-image-pinned="true" style="position:absolute;top:300px;height:50px"></div>` +
        `<div data-role="mark" data-template-image-object-id="c3" data-template-image-behind-text="true" style="position:absolute;top:300px;height:50px"></div>`,
      ),
    );

    reflowFilledTemplate();

    // A chart illustrating a clause travels with the clause. A pinned crest and
    // a watermark belong to the sheet and must hold their position, or every
    // filled document has its letterhead sliding down the page.
    expect(topOf(role('chart'))).toBe(340);
    expect(topOf(role('crest'))).toBe(300);
    expect(topOf(role('mark'))).toBe(300);
  });

  it('updates data-base-top alongside style.top', () => {
    render(
      pageHtml(
        para(words(50), 100, 'data-base-height="20"') +
        para('short', 200, 'data-role="below" data-base-top="200"'),
      ),
    );

    reflowFilledTemplate();

    // Repagination in the editor reads data-base-top. A stale value snaps the
    // paragraph back over the grown one the next time the page is laid out.
    expect(role('below').dataset.baseTop).toBe('240');
  });
});

describe('splitting a paragraph at the page boundary', () => {
  const text = stride6(40); // 239 characters, 3 lines, word boundaries every 6

  it('keeps exactly the text that fits and carries the rest to the next page', () => {
    // Top 280 with a content bottom of 300 leaves one 20px line, which is 100
    // characters. The nearest word boundary at or before 100 is 96.
    render(pageHtml(para(text, 280, 'data-role="straddle"'), { contentBottom: 300 }));

    reflowFilledTemplate();

    expect(parasOn(0).map((p) => p.textContent)).toEqual([text.slice(0, 96)]);
    expect(parasOn(1).map((p) => p.textContent)).toEqual([text.slice(96)]);
  });

  it('loses and duplicates nothing across the split', () => {
    render(pageHtml(para(text, 280), { contentBottom: 300 }));

    reflowFilledTemplate();

    // The property that matters to a client: the clause reads continuously
    // across the page break. Character loss here is invisible in review because
    // both halves are grammatical on their own.
    expect(parasOn(0)[0].textContent! + parasOn(1)[0].textContent!).toBe(text);
  });

  it('snaps back to a word boundary rather than cutting at the fitting character', () => {
    render(pageHtml(para(text, 280), { contentBottom: 300 }));

    reflowFilledTemplate();

    // 100 characters fit, but character 100 is inside a word. Cutting there
    // prints "abc" at the foot of one page and "de" at the head of the next.
    expect(parasOn(0)[0].textContent).toHaveLength(96);
    expect(parasOn(0)[0].textContent!.endsWith(' ')).toBe(true);
  });

  it('treats a non-breaking space as a word boundary', () => {
    // Documents imported from PDF are full of non-breaking spaces: they are how
    // a fixed-width run of whitespace survives the import. A splitter that only
    // recognised U+0020 would cut every such paragraph mid-word.
    const nbspText = stride6(40, ' ');
    render(pageHtml(para(nbspText, 280), { contentBottom: 300 }));

    reflowFilledTemplate();

    expect(parasOn(0)[0].textContent).toHaveLength(96);
  });

  it('clears the stored height on both halves', () => {
    render(pageHtml(para(text, 280, 'data-base-height="60"'), { contentBottom: 300 }));

    reflowFilledTemplate();

    // Both halves inherit the whole paragraph's 60px. Left in place, the next
    // pass measures each half as SHORTER than stored, or the page after it sees
    // phantom growth, and content jumps around between renders.
    expect(parasOn(0)[0].dataset.baseHeight).toBeUndefined();
    expect(parasOn(1)[0].dataset.baseHeight).toBeUndefined();
  });

  it('moves the whole paragraph when not even one line fits', () => {
    // Top 299 with a content bottom of 300 leaves 1px. There is no head worth
    // keeping, so the paragraph must travel intact rather than be cut to a
    // fragment.
    render(pageHtml(para(text, 299, 'data-role="whole"'), { contentBottom: 300 }));

    reflowFilledTemplate();

    expect(parasOn(0)).toHaveLength(0);
    expect(parasOn(1).map((p) => p.textContent)).toEqual([text]);
  });

  it('moves a paragraph that starts past the boundary without splitting it', () => {
    render(pageHtml(para(text, 320, 'data-role="past"'), { contentBottom: 300 }));

    reflowFilledTemplate();

    expect(parasOn(1).map((p) => p.textContent)).toEqual([text]);
  });

  it('preserves the order of several paragraphs pushed to the next page', () => {
    // Deliberately not in alphabetical or length order: a reversed or
    // arbitrarily ordered result would still pass a test whose fixtures sorted
    // themselves.
    render(
      pageHtml(
        para('zulu clause', 320) + para('alpha clause', 340) + para('mike clause', 360),
        { contentBottom: 300 },
      ),
    );

    reflowFilledTemplate();

    // Reordering clauses changes what the agreement says.
    expect(parasOn(1).map((p) => p.textContent)).toEqual([
      'zulu clause',
      'alpha clause',
      'mike clause',
    ]);
  });

  it('stacks the moved paragraphs from the new page\'s content top', () => {
    render(
      pageHtml(para('zulu clause', 320) + para('alpha clause', 340), { contentBottom: 300 }),
    );

    reflowFilledTemplate();

    // First lands on the content top, the second one line below it plus the
    // 4px default gap. Keeping page 1's coordinates would start the new page
    // three hundred pixels down.
    expect(parasOn(1).map(topOf)).toEqual([72, 96]);
  });

  it('honours a stored gap before a moved paragraph', () => {
    render(
      pageHtml(
        para('zulu clause', 320) + para('alpha clause', 340, 'data-base-gap-before="30"'),
        { contentBottom: 300 },
      ),
    );

    reflowFilledTemplate();

    // 72 + 20 + 30. The gap is the paragraph spacing the author set; collapsing
    // every gap to the 4px default runs separate clauses together.
    expect(parasOn(1).map(topOf)).toEqual([72, 122]);
  });
});

describe('creating and reusing the next page', () => {
  it('creates a continuation page carrying the background and pinned furniture', () => {
    render(
      pageHtml(
        `<img class="pdf-page-background" src="letterhead.png">` +
        `<div data-template-image-pinned="true" data-template-image-object-id="crest" style="position:absolute;top:20px;height:10px"></div>` +
        para('zulu clause', 320),
        { contentBottom: 300 },
      ),
    );

    reflowFilledTemplate();

    const created = pages()[1];
    expect(pages()).toHaveLength(2);
    // A continuation sheet with no letterhead is the visible half of this bug;
    // the invisible half is that the sheet also loses the page geometry, so the
    // next overflow has nowhere to go.
    expect(created.querySelector('img.pdf-page-background')?.getAttribute('src')).toBe('letterhead.png');
    expect(created.querySelector('[data-template-image-pinned="true"]')).not.toBeNull();
    expect(created.dataset.baseContentTop).toBe('72');
    expect(created.dataset.baseMinHeight).toBe('1056');
    expect(created.className).toBe('pdf-page');
  });

  it('uses the existing next page instead of inserting one', () => {
    render(
      pageHtml(para('zulu clause', 320), { contentBottom: 300 }) +
        pageHtml(para('page two opening', 72, 'data-role="opening"'), { contentBottom: 300 }),
    );

    reflowFilledTemplate();

    expect(pages()).toHaveLength(2);
    expect(parasOn(1).map((p) => p.textContent)).toEqual(['zulu clause', 'page two opening']);
  });

  it('pushes the next page\'s own content below what arrived', () => {
    render(
      pageHtml(para('zulu clause', 320), { contentBottom: 300 }) +
        pageHtml(para('page two opening', 72, 'data-role="opening"'), { contentBottom: 300 }),
    );

    reflowFilledTemplate();

    // The arrival occupies 72..92, then the existing paragraph's own 4px default
    // gap. Leaving it at 72 prints the two paragraphs on top of each other.
    expect(topOf(role('opening'))).toBe(96);
  });

  it('pulls the next page\'s content UP when it started far down', () => {
    render(
      pageHtml(para('zulu clause', 320), { contentBottom: 300 }) +
        pageHtml(para('page two opening', 400, 'data-role="opening"'), { contentBottom: 300 }),
    );

    reflowFilledTemplate();

    // The delta is signed. A one-directional "push down" would leave a 300px
    // hole between the arrival and the content that follows it.
    expect(topOf(role('opening'))).toBe(96);
  });

  it('moves the next page\'s loose images by the same delta, leaving pinned ones', () => {
    render(
      pageHtml(para('zulu clause', 320), { contentBottom: 300 }) +
        pageHtml(
          para('page two opening', 72) +
          `<div data-role="chart" data-template-image-object-id="c1" style="position:absolute;top:200px;height:10px"></div>` +
          `<div data-role="crest" data-template-image-object-id="c2" data-template-image-pinned="true" style="position:absolute;top:200px;height:10px"></div>`,
          { contentBottom: 300 },
        ),
    );

    reflowFilledTemplate();

    expect(topOf(role('chart'))).toBe(224);
    expect(topOf(role('crest'))).toBe(200);
  });

  it('cascades a second time when the continuation page also overflows', () => {
    // Three paragraphs arrive on a page that only has room for two, so the
    // reflow has to spill again rather than stacking them past the boundary.
    render(
      pageHtml(
        para('alpha clause', 320) + para('bravo clause', 340) + para('charlie clause', 360),
        { contentBottom: 300 },
      ),
    );

    reflowFilledTemplate();

    expect(pages().length).toBeGreaterThanOrEqual(2);
    const laid = pages().flatMap((_, i) => parasOn(i).map((p) => p.textContent));
    expect(laid).toEqual(['alpha clause', 'bravo clause', 'charlie clause']);
    for (const [index, page] of pages().entries()) {
      for (const p of parasOn(index)) {
        expect(topOf(p) + p.offsetHeight).toBeLessThanOrEqual(
          Number.parseFloat(page.dataset.baseContentBottom || '0'),
        );
      }
    }
  });
});

describe('deriving a content bottom the page does not declare', () => {
  it('takes the tighter of the two margin rules on a tall page', () => {
    // No declared content bottom. A 1500px page gives 1404 from the fixed 96px
    // margin and 1380 from the 8% rule; the tighter one governs. The paragraph
    // at 1385 crosses 1380 but not 1404, so it moves only under the correct rule.
    render(
      pageHtml(para('zulu clause', 1385, 'data-role="low"'), {
        contentBottom: null,
        minHeight: 1500,
      }),
    );

    reflowFilledTemplate();

    expect(pages()).toHaveLength(2);
    expect(parasOn(1).map((p) => p.textContent)).toEqual(['zulu clause']);
  });

  it('takes the tighter rule on a short page too, where the other rule is tighter', () => {
    // A 1000px page reverses which formula is smaller: 904 from the fixed margin
    // against 920 from the percentage. The paragraph at 910 sits between them,
    // so this and the case above cannot both pass on a single-formula
    // implementation.
    render(
      pageHtml(para('zulu clause', 910, 'data-role="low"'), {
        contentBottom: null,
        minHeight: 1000,
      }),
    );

    reflowFilledTemplate();

    expect(pages()).toHaveLength(2);
    expect(parasOn(1).map((p) => p.textContent)).toEqual(['zulu clause']);
  });

  it('never derives a column shorter than 240px', () => {
    // A 200px page would give a content bottom of 104, above its own content
    // top of 72, leaving room for no text at all. Every paragraph would overflow
    // to a new page that overflows in turn.
    render(
      pageHtml(para('zulu clause', 280, 'data-role="low"'), {
        contentBottom: null,
        minHeight: 200,
      }),
    );

    reflowFilledTemplate();

    expect(pages()).toHaveLength(1);
    expect(topOf(role('low'))).toBe(280);
  });

  it('prefers a declared content bottom over both rules', () => {
    render(
      pageHtml(para('zulu clause', 500, 'data-role="low"'), {
        contentBottom: 400,
        minHeight: 1500,
      }),
    );

    reflowFilledTemplate();

    // The declared value is where the author dragged the boundary or where the
    // footer band was detected. Recomputing it from the sheet ignores both.
    expect(parasOn(1).map((p) => p.textContent)).toEqual(['zulu clause']);
  });
});

describe('re-merging a split made upstream', () => {
  /**
   * A head/tail pair sharing a paragraph id, as `buildFilledTemplateHtml`
   * leaves them: the head is the last paragraph of page 1 with room to spare
   * below it, and the tail opens page 2.
   */
  const splitPair = (headTop: number, extra = '') =>
    pageHtml(para('first half', headTop, 'data-role="head" data-paragraph-id="p7"'), {
      contentBottom: 800,
    }) +
    pageHtml(
      para('second half', 72, 'data-role="tail" data-paragraph-id="p7"') + extra,
      { contentBottom: 800 },
    );

  it('joins the halves with a space between them', () => {
    render(splitPair(100));

    reflowFilledTemplate();

    // The two halves were one sentence. Concatenating without the separator
    // welds the last word of page 1 onto the first word of page 2.
    expect(parasOn(0).map((p) => p.textContent)).toEqual(['first half second half']);
    expect(parasOn(1)).toHaveLength(0);
  });

  it('pulls the rest of the next page up into the space the tail left', () => {
    render(splitPair(100, para('third clause', 150, 'data-role="following"')));

    reflowFilledTemplate();

    // The tail was 20px tall, so everything below it rises by 20. Leaving them
    // where they were opens a blank band at the top of every continuation page.
    expect(topOf(role('following'))).toBe(130);
  });

  it('adds a stored gap to the amount pulled up', () => {
    render(
      splitPair(
        100,
        para('third clause', 200, 'data-role="following"'),
      ).replace('data-role="tail" data-paragraph-id="p7"', 'data-role="tail" data-paragraph-id="p7" data-base-gap-before="15"'),
    );

    reflowFilledTemplate();

    // The tail's own leading gap disappears with it, so 20 + 15 comes back.
    expect(topOf(role('following'))).toBe(165);
  });

  it('never lifts the following content above the page content top', () => {
    render(splitPair(100, para('third clause', 80, 'data-role="following"')));

    reflowFilledTemplate();

    // 80 - 20 is 60, which is above the 72px top margin. Content in the margin
    // is content under the letterhead.
    expect(topOf(role('following'))).toBe(72);
  });

  it('does not merge when there is no room left on the page', () => {
    // The head bottom is 790 against a content bottom of 800: 10px, under one
    // line. There is nothing to pull back, and merging would immediately
    // re-split, churning the document for no gain.
    render(splitPair(770));

    reflowFilledTemplate();

    expect(parasOn(0).map((p) => p.textContent)).toEqual(['first half']);
    expect(parasOn(1).map((p) => p.textContent)).toEqual(['second half']);
  });

  it('does not merge two paragraphs that merely happen to be adjacent', () => {
    render(
      pageHtml(para('first half', 100, 'data-paragraph-id="p7"'), { contentBottom: 800 }) +
        pageHtml(para('unrelated clause', 72, 'data-paragraph-id="p9"'), { contentBottom: 800 }),
    );

    reflowFilledTemplate();

    // The shared id is the only evidence the two were ever one paragraph.
    // Merging on position alone would glue unrelated clauses together across
    // every page break in the document.
    expect(parasOn(0).map((p) => p.textContent)).toEqual(['first half']);
    expect(parasOn(1).map((p) => p.textContent)).toEqual(['unrelated clause']);
  });

  it('does not merge when the last paragraph carries no id at all', () => {
    render(
      pageHtml(para('first half', 100), { contentBottom: 800 }) +
        pageHtml(para('second half', 72), { contentBottom: 800 }),
    );

    reflowFilledTemplate();

    // Two ids that are both empty are not a match. Comparing them as equal
    // merges the first paragraph of every page onto the last of the previous
    // one, throughout an imported document that carries no ids.
    expect(parasOn(0).map((p) => p.textContent)).toEqual(['first half']);
    expect(parasOn(1).map((p) => p.textContent)).toEqual(['second half']);
  });

  it('matches on the logical paragraph id as well', () => {
    render(
      pageHtml(para('first half', 100, 'data-logical-paragraph-id="L4"'), { contentBottom: 800 }) +
        pageHtml(para('second half', 72, 'data-logical-paragraph-id="L4"'), { contentBottom: 800 }),
    );

    reflowFilledTemplate();

    expect(parasOn(0).map((p) => p.textContent)).toEqual(['first half second half']);
  });

  it('re-splits the merged paragraph where a line actually ends', () => {
    // Merging is only step one. The point of undoing the upstream split is that
    // the rejoined paragraph is then divided where a measured line ends, which
    // is a different place. Five words end page 1 and thirty-five open page 2,
    // so the join reconstitutes exactly `long`. From top 100 with a content
    // bottom of 150 there are two and a half lines of room, so 200 characters
    // fit and the nearest word boundary at or before 200 is 198, not the 29
    // the character-fraction estimate had picked.
    const long = stride6(40);
    render(
      pageHtml(para(stride6(5), 100, 'data-paragraph-id="p7"'), { contentBottom: 150 }) +
        pageHtml(para(stride6(35), 72, 'data-paragraph-id="p7"'), { contentBottom: 150 }),
    );

    reflowFilledTemplate();

    expect(parasOn(0).map((p) => p.textContent)).toEqual([long.slice(0, 198)]);
    expect(parasOn(1).map((p) => p.textContent)).toEqual([long.slice(198)]);
  });
});

describe('documents with nothing to reflow', () => {
  it('returns without touching a document that has no pages', () => {
    render('<p style="top:100px">Loose paragraph</p>');

    expect(() => reflowFilledTemplate()).not.toThrow();
    expect(document.querySelector('p')!.style.top).toBe('100px');
  });

  it('leaves an empty page alone', () => {
    render(pageHtml(''));

    reflowFilledTemplate();

    expect(pages()).toHaveLength(1);
  });

  it('leaves a page that fits exactly at the boundary alone', () => {
    // Bottom lands on 300 against a content bottom of 300. One pixel lower and
    // it would be split; here it must not be touched, and it must not be moved
    // to a page of its own either.
    render(pageHtml(para('short', 280, 'data-role="exact"'), { contentBottom: 300 }));

    reflowFilledTemplate();

    expect(pages()).toHaveLength(1);
    expect(topOf(role('exact'))).toBe(280);
  });

  it('splits a paragraph that ends one pixel past the boundary', () => {
    render(pageHtml(para('short', 281, 'data-role="over"'), { contentBottom: 300 }));

    reflowFilledTemplate();

    // Companion to the case above: 301 against 300. The paragraph is one line,
    // so there is no head worth keeping and it moves whole.
    expect(pages()).toHaveLength(2);
    expect(parasOn(1).map((p) => p.textContent)).toEqual(['short']);
  });
});
