/**
 * The "Selected text" readout's source: a click or a selection on the rendered
 * page becomes a font sample. The page and the pdf.js document are both faked
 * in geometry only, which is all the hook reads.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { usePdfFontSample } from '@/components/templatesComp/usePdfFontSample';

const PAGE = { left: 0, top: 0, width: 612, height: 792, right: 612, bottom: 792, x: 0, y: 0, toJSON: () => ({}) };

/** One page holding one run of 11pt Calibri Bold, "Hello", near the top. */
function fakePdf() {
  return {
    getPage: async () => ({
      getViewport: () => ({ width: 612, height: 792, convertToViewportPoint: (x: number, y: number) => [x, 792 - y] }),
      getTextContent: async () => ({
        items: [{ str: 'Hello', transform: [11, 0, 0, 11, 72, 700], width: 60, fontName: 'g_f1' }],
        styles: { g_f1: { ascent: 0.9, descent: -0.2, fontFamily: 'sans-serif' } },
      }),
      commonObjs: { has: () => true, get: () => ({ name: 'ABCDEF+Calibri-Bold' }) },
    }),
  } as any;
}

function mountPage() {
  const page = document.createElement('div');
  page.setAttribute('data-pdf-page', '1');
  page.getBoundingClientRect = () => PAGE as DOMRect;
  const annotation = document.createElement('div');
  annotation.setAttribute('data-annotation', 'field');
  annotation.textContent = 'typed into a box';
  page.appendChild(annotation);
  document.body.appendChild(page);
  return { page, annotation };
}

function click(target: Element, clientX: number, clientY: number) {
  target.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0, clientX, clientY }));
}

// The run sits at y = 792 - 700 = 92px from the top of a 792px page, so a
// click at (100, 90) lands on it and (100, 400) lands on blank page.
const ON_TEXT = { x: 100, y: 90 };
const ON_BLANK = { x: 100, y: 400 };

describe('usePdfFontSample', () => {
  let page: HTMLElement;
  let annotation: HTMLElement;

  beforeEach(() => {
    ({ page, annotation } = mountPage());
  });

  afterEach(() => {
    page.remove();
    window.getSelection()?.removeAllRanges();
  });

  it('reads the font of the line under a click', async () => {
    const { result } = renderHook(() => usePdfFontSample(true));
    act(() => result.current.setDocument(fakePdf()));

    act(() => click(page, ON_TEXT.x, ON_TEXT.y));

    await waitFor(() => expect(result.current.sample).not.toBeNull());
    expect(result.current.sample).toEqual({ familyLabel: 'Calibri', family: 'calibri', sizePt: 11, bold: true, italic: false });
    expect(result.current.page).toBe(1);
    expect(result.current.highlights).toHaveLength(1);
  });

  it('clears the readout on a click on blank page', async () => {
    const { result } = renderHook(() => usePdfFontSample(true));
    act(() => result.current.setDocument(fakePdf()));
    act(() => click(page, ON_TEXT.x, ON_TEXT.y));
    await waitFor(() => expect(result.current.sample).not.toBeNull());

    act(() => click(page, ON_BLANK.x, ON_BLANK.y));

    await waitFor(() => expect(result.current.sample).toBeNull());
    expect(result.current.highlights).toEqual([]);
  });

  it('keeps the last readout when sampling is turned off, so it can be matched in Field mode', async () => {
    const { result, rerender } = renderHook(({ enabled }) => usePdfFontSample(enabled), { initialProps: { enabled: true } });
    act(() => result.current.setDocument(fakePdf()));
    act(() => click(page, ON_TEXT.x, ON_TEXT.y));
    await waitFor(() => expect(result.current.sample).not.toBeNull());

    rerender({ enabled: false });

    expect(result.current.sample?.sizePt).toBe(11);
    // And nothing new is read while it is off.
    act(() => click(page, ON_BLANK.x, ON_BLANK.y));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.sample?.sizePt).toBe(11);
  });

  it('ignores a click and a selection inside a placed box', async () => {
    const { result } = renderHook(() => usePdfFontSample(true));
    act(() => result.current.setDocument(fakePdf()));

    act(() => click(annotation, ON_TEXT.x, ON_TEXT.y));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.sample).toBeNull();

    // Selecting the reader's own typed text must not read the PDF text that
    // happens to sit underneath the box.
    act(() => {
      const range = document.createRange();
      range.selectNodeContents(annotation);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(result.current.sample).toBeNull();
  });
});
