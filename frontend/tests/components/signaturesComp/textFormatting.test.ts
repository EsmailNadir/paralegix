/**
 * The rich-text helpers behind the signature editor's formatting toolbar. No
 * coverage before this file.
 *
 * Two jobs live here and both fail quietly. The first is `mapCssToFontValue`,
 * which turns whatever font stack the browser reports for a selection back into
 * one of the twenty `FONT_FAMILIES` values. That value is what gets flattened
 * into the signed PDF, so a wrong answer means the executed document is set in
 * a different face than the one the signer saw on screen, and nothing on screen
 * ever looks broken.
 *
 * The second is the `execCommand` fixup pair. The browser emits legacy `<font>`
 * tags; these functions rewrite them into styled `<span>`s and then restore the
 * selection. Miss a tag and the styling is lost on save, because only inline
 * styles survive the serialiser. Lose the selection and the next toolbar click
 * applies to nothing, which reads to the user as a dead button.
 *
 * `document.execCommand` does not exist in jsdom, so it is stubbed below with
 * the behaviour real browsers have: wrap the current range in a `<font>` tag
 * carrying the command's attribute. That leaves the part under test, the
 * `<font>` to `<span>` fixup, running for real.
 */
import {
  applyColorToSelection,
  applyFontFamilyToSelection,
  applyFontSizeToSelection,
  foreColorToHex,
  getActiveEditorInfo,
  mapCssToFontValue,
  reselectSpans,
} from '@/components/signaturesComp/textFormatting';
import { FONT_FAMILIES } from '@/types/signature';

/** Commands the stubbed `execCommand` was asked to run, oldest first. */
let execCommandCalls: { command: string; value?: string }[] = [];

/**
 * Stands in for the browser's `execCommand`, which jsdom does not implement.
 * Real browsers wrap the live range in a `<font>` element carrying the command
 * as an attribute, and that tag is exactly what the functions under test look
 * for, so the stub reproduces it rather than the whole editing model.
 */
function installExecCommandStub() {
  execCommandCalls = [];
  document.execCommand = ((command: string, _ui?: boolean, value?: string) => {
    execCommandCalls.push({ command, value });
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return false;
    const font = document.createElement('font');
    if (command === 'fontSize') font.setAttribute('size', String(value));
    if (command === 'fontName') font.setAttribute('face', String(value));
    if (command === 'foreColor') font.setAttribute('color', String(value));
    range.surroundContents(font);
    return true;
  }) as typeof document.execCommand;
}

/** Builds `<div data-annotation-id><div contenteditable>{html}</div></div>`. */
function mountEditor(html: string, annotationId = 'ann_1') {
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-annotation-id', annotationId);
  const editable = document.createElement('div');
  editable.setAttribute('contenteditable', 'true');
  editable.innerHTML = html;
  wrapper.appendChild(editable);
  document.body.appendChild(wrapper);
  return editable as HTMLDivElement;
}

/** Selects a character range inside a text node. */
function selectChars(textNode: Node, start: number, end: number) {
  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, end);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  return range;
}

/** Selects a character range inside the first text node of `host`. */
function selectTextIn(host: Element, start: number, end: number) {
  return selectChars(host.firstChild!, start, end);
}

beforeEach(() => {
  document.body.innerHTML = '';
  window.getSelection()?.removeAllRanges();
  installExecCommandStub();
});

describe('mapCssToFontValue', () => {
  it('resolves a stack by exact match on its primary face', () => {
    // The everyday path: the browser hands back the whole stack it was given,
    // and the first face is the one the user actually picked.
    expect(mapCssToFontValue('Arial, Helvetica, sans-serif')).toBe('Helvetica');
    expect(mapCssToFontValue("'Times New Roman', Times, serif")).toBe('Times-Roman');
    expect(mapCssToFontValue("'Courier New', Courier, monospace")).toBe('Courier');
    expect(mapCssToFontValue("'Comic Sans MS', cursive")).toBe('Comic Sans MS');
  });

  it('does not confuse "serif" with "sans-serif"', () => {
    // The bug the exact-token comparison exists to prevent. A substring match
    // would find "serif" inside Arial's "sans-serif" token first, and every
    // generic serif selection would be saved and printed as Helvetica.
    expect(mapCssToFontValue('serif')).toBe('Times-Roman');
    expect(mapCssToFontValue('sans-serif')).toBe('Helvetica');
  });

  it('ignores the quotes and the case the browser chose', () => {
    // Computed styles come back quoted and cased inconsistently across
    // browsers. The same selection must resolve to the same face in each.
    expect(mapCssToFontValue('"Trebuchet MS", Helvetica, sans-serif')).toBe('Trebuchet MS');
    expect(mapCssToFontValue('ARIAL, HELVETICA')).toBe('Helvetica');
    expect(mapCssToFontValue("  Verdana ,  Geneva ")).toBe('Verdana');
  });

  it('resolves a face to itself even when an earlier face lists it as a fallback', () => {
    // Georgia is the case that was wrong. Cambria's stack is
    // "Cambria, Georgia, serif" and Cambria sits above Georgia in
    // FONT_FAMILIES, so a scan that compared the requested face against every
    // token of a candidate stack matched Cambria's FALLBACK first. Picking
    // Georgia in the toolbar and then moving the caret showed Cambria
    // selected, and saving then wrote the wrong face into the signature.
    //
    // The shadowing is general, so both directions are pinned: the shadowed
    // face must win for its own stack, and the shadowing face must still win
    // for its own.
    expect(mapCssToFontValue('Georgia, serif')).toBe('Georgia');
    expect(mapCssToFontValue('Cambria, Georgia, serif')).toBe('Cambria');
  });

  it('resolves every shipped stack to its own face', () => {
    // The general form of the Georgia bug. Any face that another face names as
    // a fallback can be shadowed by list order, and the pair that breaks moves
    // whenever FONT_FAMILIES is edited. Asserting the whole table means a new
    // entry whose stack borrows an existing face cannot reintroduce this
    // quietly.
    for (const font of FONT_FAMILIES) {
      expect(mapCssToFontValue(font.css)).toBe(font.value);
    }
  });

  it('falls back to a name contained in the primary face', () => {
    // Browsers and pasted content produce named variants. "Georgia Pro" is not
    // a token of any stack, but it is unambiguously Georgia, and resolving it
    // to the default instead would silently reset the signer's choice.
    expect(mapCssToFontValue('Georgia Pro')).toBe('Georgia');
    expect(mapCssToFontValue('Helvetica Neue')).toBe('Helvetica');
  });

  it('reads the whole stack when the primary face is unrecognised', () => {
    // A missing first font is the common shape of a stack copied in from
    // another editor. The rest of the stack still says what it wanted.
    expect(mapCssToFontValue('SomeMissingFace, Times')).toBe('Times-Roman');
    expect(mapCssToFontValue('SomeMissingFace, Courier')).toBe('Courier');
  });

  it('defaults to Helvetica when nothing in the stack is recognisable', () => {
    // Never returns null or empty: the value is written straight into the
    // annotation and an unknown one would fail PDF generation at signing time.
    expect(mapCssToFontValue('SomeMissingFace, AnotherMissingFace')).toBe('Helvetica');
    expect(mapCssToFontValue('')).toBe('Helvetica');
    expect(mapCssToFontValue('   ')).toBe('Helvetica');
    expect(mapCssToFontValue(',,,')).toBe('Helvetica');
  });

  it('CHARACTERISATION: matches on any four-character-or-longer token overlap', () => {
    // Reported, not changed. The third pass accepts a match in either
    // direction, so a bare "Linotype" resolves to Palatino purely because
    // Palatino's stack contains "Palatino Linotype".
    //
    // Left alone because the alternative is dropping to Helvetica, and for the
    // faces this pass actually catches the fuzzy answer is closer than the
    // default. It is recorded so that tightening the rule is a deliberate
    // decision rather than an accident.
    expect(mapCssToFontValue('Linotype')).toBe('Palatino');
  });
});

describe('foreColorToHex', () => {
  it('passes a hex value through untouched', () => {
    // Chrome reports the value it was given; Safari normalises to rgb(). Both
    // have to come back as the same hex, because the hex is what is stored.
    expect(foreColorToHex('#ff0000')).toBe('#ff0000');
    expect(foreColorToHex('#F00')).toBe('#F00');
  });

  it('converts rgb() to hex', () => {
    expect(foreColorToHex('rgb(255, 0, 0)')).toBe('#ff0000');
    expect(foreColorToHex('rgb(18, 52, 86)')).toBe('#123456');
  });

  it('zero-pads each channel to two digits', () => {
    // Without the padding, rgb(1, 2, 3) becomes "#123", which is the shorthand
    // for #112233: a near-black colour would be stored as mid grey-blue.
    expect(foreColorToHex('rgb(1, 2, 3)')).toBe('#010203');
    expect(foreColorToHex('rgb(0, 0, 0)')).toBe('#000000');
  });

  it('tolerates rgb() written without spaces', () => {
    expect(foreColorToHex('rgb(255,128,0)')).toBe('#ff8000');
  });

  it('returns black for a form it cannot read', () => {
    // Named colours and rgba() reach this from pasted content. Black is a
    // legible default; returning the raw string would put "red" into a field
    // the colour picker parses as hex and render the swatch empty.
    expect(foreColorToHex('red')).toBe('#000000');
    expect(foreColorToHex('rgba(255, 0, 0, 0.5)')).toBe('#000000');
    expect(foreColorToHex('')).toBe('#000000');
  });
});

describe('getActiveEditorInfo', () => {
  it('finds the editor and annotation id from a caret inside a text node', () => {
    const editable = mountEditor('Hello world');
    selectTextIn(editable, 0, 5);

    // The anchor node of a text selection is the text node itself, so the
    // lookup has to climb to the parent element before calling closest().
    const info = getActiveEditorInfo();
    expect(info).not.toBeNull();
    expect(info!.el).toBe(editable);
    expect(info!.annotationId).toBe('ann_1');
  });

  it('finds the editor when the anchor node is an element', () => {
    // A selection spanning whole child elements anchors on an element rather
    // than a text node. Both shapes have to resolve to the same editor.
    const editable = mountEditor('<b>bold</b><i>italic</i>');
    const range = document.createRange();
    range.setStart(editable, 0);
    range.setEnd(editable, 2);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    const info = getActiveEditorInfo();
    expect(info).not.toBeNull();
    expect(info!.el).toBe(editable);
  });

  it('returns null when nothing is selected', () => {
    mountEditor('Hello world');
    window.getSelection()!.removeAllRanges();

    // Toolbar buttons are clickable with no caret in the document. Reading
    // rangeCount 0 as a selection would throw inside getRangeAt.
    expect(getActiveEditorInfo()).toBeNull();
  });

  it('returns null when the selection is outside any contenteditable', () => {
    // Proven live: the same selection API returns a range here, so the null is
    // the contenteditable check firing and not an empty selection.
    const plain = document.createElement('div');
    plain.textContent = 'not editable';
    document.body.appendChild(plain);
    selectTextIn(plain, 0, 3);
    expect(window.getSelection()!.rangeCount).toBe(1);

    expect(getActiveEditorInfo()).toBeNull();
  });

  it('returns null for a contenteditable with no annotation wrapper', () => {
    // Other contenteditable surfaces share the page. Returning an editor with
    // no annotation id would apply signature formatting to an unrelated field.
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    editable.textContent = 'some other editor';
    document.body.appendChild(editable);
    selectTextIn(editable, 0, 4);
    expect(window.getSelection()!.rangeCount).toBe(1);

    expect(getActiveEditorInfo()).toBeNull();
  });

  it('reports the id of the nearest annotation wrapper when they nest', () => {
    // Nested annotations are how a grouped field renders. Picking the outer id
    // writes the formatting onto the wrong annotation record.
    const outer = document.createElement('div');
    outer.setAttribute('data-annotation-id', 'outer');
    const inner = document.createElement('div');
    inner.setAttribute('data-annotation-id', 'inner');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    editable.textContent = 'nested';
    inner.appendChild(editable);
    outer.appendChild(inner);
    document.body.appendChild(outer);
    selectTextIn(editable, 0, 3);

    expect(getActiveEditorInfo()!.annotationId).toBe('inner');
  });
});

describe('reselectSpans', () => {
  it('selects from the first span to the end of the last', () => {
    const editable = mountEditor('');
    const first = document.createElement('span');
    first.textContent = 'one';
    const middle = document.createElement('span');
    middle.textContent = 'two';
    const last = document.createElement('span');
    last.textContent = 'three';
    editable.append(first, middle, last);

    reselectSpans([first, middle, last]);

    // Without this the caret collapses after every toolbar click, so applying
    // bold then italic to the same words needs the user to reselect between
    // them.
    const sel = window.getSelection()!;
    expect(sel.rangeCount).toBe(1);
    expect(sel.getRangeAt(0).toString()).toBe('onetwothree');
  });

  it('covers the whole content of a single span', () => {
    const editable = mountEditor('');
    const only = document.createElement('span');
    only.textContent = 'solo';
    editable.appendChild(only);

    reselectSpans([only]);

    expect(window.getSelection()!.getRangeAt(0).toString()).toBe('solo');
  });

  it('leaves an existing selection alone when given no spans', () => {
    // Proven live: a real selection is established first and asserted, so the
    // check below is that reselectSpans returned early rather than that no
    // selection ever existed. Clearing here would drop the user's caret every
    // time a command matched no tags.
    const editable = mountEditor('Hello world');
    selectTextIn(editable, 0, 5);
    expect(window.getSelection()!.getRangeAt(0).toString()).toBe('Hello');

    reselectSpans([]);

    expect(window.getSelection()!.getRangeAt(0).toString()).toBe('Hello');
  });
});

describe('applyFontSizeToSelection', () => {
  it('rewrites the marker font tag as a span carrying the pixel size', () => {
    const editable = mountEditor('Hello world');
    selectTextIn(editable, 0, 5);

    applyFontSizeToSelection(18);

    // execCommand cannot set an arbitrary pixel size, only the seven legacy
    // buckets, so size="1" is used purely as a marker to find and rewrite. A
    // leftover <font size="1"> renders as roughly 10px, not 18px.
    expect(execCommandCalls).toEqual([{ command: 'fontSize', value: '1' }]);
    expect(editable.querySelectorAll('font').length).toBe(0);
    const span = editable.querySelector('span')!;
    expect(span.style.fontSize).toBe('18px');
    expect(span.textContent).toBe('Hello');
  });

  it('keeps the child nodes of the tag it replaces', () => {
    // The selection can contain markup. Rebuilding the span from textContent
    // would flatten a bolded word inside the run back to plain text.
    const editable = mountEditor('Hello <b>bold</b> world');
    const range = document.createRange();
    range.selectNode(editable.querySelector('b')!);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    applyFontSizeToSelection(24);

    const span = editable.querySelector('span')!;
    expect(span.querySelector('b')!.textContent).toBe('bold');
  });

  it('re-selects the text it just restyled', () => {
    const editable = mountEditor('Hello world');
    selectTextIn(editable, 0, 5);

    applyFontSizeToSelection(18);

    // Sizing then colouring the same words is one gesture to the user. If the
    // selection is not restored the second click does nothing.
    expect(window.getSelection()!.getRangeAt(0).toString()).toBe('Hello');
  });

  it('leaves the document alone when the selection is not in an editor', () => {
    // Proven live: execCommand is asserted to have run and to have left its
    // font tag behind, so the untouched span count below is the early return
    // firing rather than the command never happening. Rewriting tags outside
    // the signature editor would restyle unrelated parts of the page.
    const plain = document.createElement('div');
    plain.textContent = 'not editable';
    document.body.appendChild(plain);
    selectTextIn(plain, 0, 3);

    applyFontSizeToSelection(18);

    expect(execCommandCalls).toEqual([{ command: 'fontSize', value: '1' }]);
    expect(plain.querySelectorAll('font[size="1"]').length).toBe(1);
    expect(plain.querySelectorAll('span').length).toBe(0);
  });
});

describe('applyFontFamilyToSelection', () => {
  it('rewrites the marker font tag as a span carrying the css stack', () => {
    const editable = mountEditor('Hello world');
    selectTextIn(editable, 0, 5);

    applyFontFamilyToSelection('Georgia, serif');

    // The marker face is a sentinel that no real font shares, so only the tags
    // this call produced are rewritten. Matching on the requested family
    // instead would also rewrite text the user styled earlier.
    expect(execCommandCalls).toEqual([
      { command: 'fontName', value: '__paralegix_marker__' },
    ]);
    expect(editable.querySelectorAll('font').length).toBe(0);
    const span = editable.querySelector('span')!;
    expect(span.style.fontFamily).toBe('Georgia, serif');
    expect(span.textContent).toBe('Hello');
  });

  it('leaves font tags that are not the marker in place', () => {
    // A tag left by an earlier command, or pasted in, must survive. Rewriting
    // every <font> would repaint the whole annotation with the new family.
    const editable = mountEditor('<font face="Verdana">earlier</font>plain');
    selectChars(editable.lastChild!, 0, 5);

    applyFontFamilyToSelection('Tahoma, Geneva, sans-serif');

    const survivor = editable.querySelector('font[face="Verdana"]')!;
    expect(survivor.textContent).toBe('earlier');
    expect(editable.querySelector('span')!.style.fontFamily).toBe('Tahoma, Geneva, sans-serif');
  });

  it('produces a family value that maps back to a known face', () => {
    // Closes the loop with mapCssToFontValue: whatever is written into the
    // span has to be readable back when the toolbar reports the current font,
    // otherwise the dropdown resets to Arial the moment the caret moves.
    const editable = mountEditor('Hello world');
    selectTextIn(editable, 0, 5);

    applyFontFamilyToSelection("'Courier New', Courier, monospace");

    const applied = editable.querySelector('span')!.style.fontFamily;
    expect(mapCssToFontValue(applied)).toBe('Courier');
  });
});

describe('applyColorToSelection', () => {
  it('rewrites the font colour tag as a span with a colour style', () => {
    const editable = mountEditor('Hello world');
    selectTextIn(editable, 0, 5);

    applyColorToSelection('#ff0000');

    expect(execCommandCalls).toEqual([{ command: 'foreColor', value: '#ff0000' }]);
    expect(editable.querySelectorAll('font').length).toBe(0);
    // Only inline styles survive serialisation, so a surviving <font color>
    // means the colour is lost on save even though it looked right on screen.
    const span = editable.querySelector('span')!;
    expect(span.style.color).toBe('rgb(255, 0, 0)');
    expect(span.textContent).toBe('Hello');
  });

  it('keeps each existing tag on its own colour rather than the new one', () => {
    // Every font[color] in the editor is rewritten, not just the one this call
    // produced. Reading the tag's own attribute is what stops colouring one
    // word from repainting a word the user coloured earlier.
    const editable = mountEditor('<font color="#0000ff">blue</font>plain');
    selectChars(editable.lastChild!, 0, 5);

    applyColorToSelection('#ff0000');

    const spans = Array.from(editable.querySelectorAll('span'));
    expect(spans.map((s) => s.textContent)).toEqual(['blue', 'plain']);
    expect(spans[0].style.color).toBe('rgb(0, 0, 255)');
    expect(spans[1].style.color).toBe('rgb(255, 0, 0)');
  });

  it('falls back to the requested colour when the tag carries no value', () => {
    // Browsers occasionally emit a bare colour attribute. Passing the empty
    // string through would produce style="color:" and the run would render in
    // the inherited colour with no sign that anything was applied.
    const editable = mountEditor('<font color="">valueless</font>plain');
    selectChars(editable.lastChild!, 0, 5);

    applyColorToSelection('#008000');

    const spans = Array.from(editable.querySelectorAll('span'));
    expect(spans.map((s) => s.textContent)).toEqual(['valueless', 'plain']);
    expect(spans[0].style.color).toBe('rgb(0, 128, 0)');
  });
});
