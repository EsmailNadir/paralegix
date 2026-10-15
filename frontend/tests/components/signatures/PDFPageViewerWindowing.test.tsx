/**
 * How many pages the signing viewer paints, and what it asks PDF.js for.
 *
 * The viewer used to keep a `Set` of every page that had ever come near the
 * viewport and rasterise all of them for as long as the document stayed open.
 * That is not virtualization: it is the same unbounded growth with a delay in
 * front of it, and it is invisible on the two-page engagement letters the flow
 * was built against. Reading a 1,000-page discovery production top to bottom
 * ended with 1,000 live canvases, each costing width x height x 4 bytes whatever
 * the page contained.
 *
 * `react-pdf` is mocked, so what this file may honestly claim is bounded: the
 * NUMBER of canvases the component mounts and the OPTIONS it hands PDF.js. It
 * cannot claim PDF.js then fetches only those byte ranges, because no PDF.js
 * runs under jsdom.
 */
import React from 'react';
import { render, screen, act } from '@testing-library/react';
import {
  createCanvasTracker,
  installIntersectionControl,
  trackedCanvas,
  type IntersectionControl,
} from '../../support/pdfWindowHarness';

const PAGE_COUNT = 1000;
const tracker = createCanvasTracker();

/** Props the mocked `<Document>` was last given, so its source can be read. */
let documentProps: Record<string, unknown> | null = null;

jest.mock('react-pdf', () => ({
  __esModule: true,
  pdfjs: { GlobalWorkerOptions: {} },
  Document: function MockDocument({ file, children, onLoadSuccess }: any) {
    documentProps = { file };
    // Fire once per mount. The real Document reports its page count when parsing
    // finishes; re-firing on every render would restart the viewer forever.
    const fired = React.useRef(false);
    React.useEffect(() => {
      if (fired.current) return;
      fired.current = true;
      onLoadSuccess?.({ numPages: PAGE_COUNT });
    });
    return <div data-testid="document">{children}</div>;
  },
  Page: () => null,
}));

jest.mock('@/components/ui/PdfCanvasPage', () => ({
  __esModule: true,
  default: trackedCanvas(() => tracker, jest.requireActual('react')),
}));

// `tests/setup.ts` stubs this component to `() => null` for the whole suite
// because `react-pdf` is ESM Jest cannot parse. This file is ABOUT the
// component, so it reaches past the registry for the real one while leaving the
// `react-pdf` stub above in place for the component's own import.
const PDFPageViewer = jest.requireActual(
  '@/components/signaturesComp/PDFPageViewer',
).default as typeof import('@/components/signaturesComp/PDFPageViewer').default;

const MAX_CANVASES = 5;

let intersection: IntersectionControl;

beforeEach(() => {
  documentProps = null;
  tracker.reset();
  intersection = installIntersectionControl((page) => `[data-pdf-page="${page}"]`);
});

afterEach(() => {
  intersection.restore();
});

function renderViewer(props: Record<string, unknown> = {}) {
  return render(
    <PDFPageViewer
      file={{ url: 'blob:doc', bytes: new Uint8Array([1, 2, 3, 4]) }}
      mode={'signature' as any}
      onDocumentLoad={() => {}}
      onPageClick={() => {}}
      // jsdom runs no layout, so a container width never arrives on its own.
      initialContainerWidth={800}
      {...props}
    >
      {() => null}
    </PDFPageViewer>,
  );
}

/** Moves the reader to a page, the way a scroll would. */
function scrollToPage(page: number) {
  act(() => {
    intersection.scrollTo({ [page]: 1, [page + 1]: 0.3 });
  });
}

describe('how many canvases a long document holds', () => {
  it('stays at or below the cap while scrolling from page 1 to page 900 and back', async () => {
    renderViewer();
    await screen.findByTestId('document');

    expect(tracker.count()).toBeGreaterThan(0);
    expect(tracker.count()).toBeLessThanOrEqual(MAX_CANVASES);

    // Walking the document, not jumping: every intermediate stop is a chance for
    // a viewer that only ever adds pages to accumulate them.
    for (let page = 1; page <= 900; page += 37) {
      scrollToPage(page);
      expect(tracker.count()).toBeLessThanOrEqual(MAX_CANVASES);
    }
    scrollToPage(900);
    expect(tracker.count()).toBeLessThanOrEqual(MAX_CANVASES);

    for (let page = 900; page >= 1; page -= 37) {
      scrollToPage(page);
      expect(tracker.count()).toBeLessThanOrEqual(MAX_CANVASES);
    }
    scrollToPage(1);
    expect(tracker.count()).toBeLessThanOrEqual(MAX_CANVASES);
    expect(tracker.count()).toBeGreaterThan(0);
  });

  it('removes the canvas of a page that leaves the window rather than hiding it', async () => {
    renderViewer();
    await screen.findByTestId('document');

    expect(screen.getByTestId('canvas-1')).toBeInTheDocument();

    scrollToPage(600);

    // Not `toBeVisible`: a `display: none` canvas still holds its bitmap, which
    // is the entire cost being bounded here.
    expect(screen.queryByTestId('canvas-1')).not.toBeInTheDocument();
    expect(document.querySelector('[data-testid="canvas-1"]')).toBeNull();
    expect(screen.getByTestId('canvas-600')).toBeInTheDocument();
  });

  it('keeps a measured box for every page, so page 1000 is still reachable', async () => {
    renderViewer();
    await screen.findByTestId('document');

    expect(document.querySelectorAll('[data-pdf-page]')).toHaveLength(PAGE_COUNT);
    const last = document.querySelector('[data-pdf-page="1000"]') as HTMLElement;
    // An undrawn page whose box collapsed would pile the whole document into one
    // screenful, making every page count as visible and the scrollbar a lie.
    expect(parseFloat(last.style.height)).toBeGreaterThan(500);
  });
});

describe('overlays on pages that are not drawn', () => {
  it('renders a field on an offscreen page, with the coordinates it started with', async () => {
    const field = { page: 900, xPercent: 25, yPercent: 40, widthPercent: 20, heightPercent: 5 };
    const seen = new Map<number, { left: number; top: number }>();

    render(
      <PDFPageViewer
        file={{ url: 'blob:doc', bytes: new Uint8Array([1]) }}
        mode={'signature' as any}
        onDocumentLoad={() => {}}
        onPageClick={() => {}}
        initialContainerWidth={800}
      >
        {(page, pageWidth, pageHeight) => {
          if (page !== field.page) return null;
          const box = {
            left: (field.xPercent / 100) * pageWidth,
            top: (field.yPercent / 100) * pageHeight,
          };
          seen.set(page, box);
          return <div data-testid={`field-${page}`} data-left={box.left} data-top={box.top} />;
        }}
      </PDFPageViewer>,
    );
    await screen.findByTestId('document');

    // Page 900 has no canvas at this point, and its field must exist anyway.
    expect(screen.queryByTestId('canvas-900')).not.toBeInTheDocument();
    const before = screen.getByTestId('field-900');
    const beforeLeft = before.getAttribute('data-left');
    const beforeTop = before.getAttribute('data-top');
    expect(Number(beforeLeft)).toBeGreaterThan(0);

    scrollToPage(900);
    expect(screen.getByTestId('canvas-900')).toBeInTheDocument();
    expect(screen.getByTestId('field-900').getAttribute('data-left')).toBe(beforeLeft);
    expect(screen.getByTestId('field-900').getAttribute('data-top')).toBe(beforeTop);

    scrollToPage(1);
    scrollToPage(900);

    // Same page, same percentages, same pixels: a round trip through the window
    // must not re-derive a field's position from whatever is drawn.
    expect(screen.getByTestId('field-900').getAttribute('data-left')).toBe(beforeLeft);
    expect(screen.getByTestId('field-900').getAttribute('data-top')).toBe(beforeTop);
  });
});

describe('zoom with windowing on', () => {
  it('sizes every page box from the zoom, drawn or not', async () => {
    const { rerender } = renderViewer({ zoom: 100 });
    await screen.findByTestId('document');

    const fitWidth = document.querySelector('[data-pdf-page="1"]') as HTMLElement;
    // 800 container less 32 of padding is the fit-width page size.
    expect(fitWidth.style.width).toBe('768px');
    const undrawn = document.querySelector('[data-pdf-page="900"]') as HTMLElement;
    expect(undrawn.style.width).toBe('768px');

    rerender(
      <PDFPageViewer
        file={{ url: 'blob:doc', bytes: new Uint8Array([1, 2, 3, 4]) }}
        mode={'signature' as any}
        onDocumentLoad={() => {}}
        onPageClick={() => {}}
        initialContainerWidth={800}
        zoom={200}
      >
        {() => null}
      </PDFPageViewer>,
    );

    expect((document.querySelector('[data-pdf-page="1"]') as HTMLElement).style.width).toBe('1536px');
    // The undrawn pages have to follow the zoom too, or the scroll length would
    // stop matching the pages it is scrolling past.
    expect((document.querySelector('[data-pdf-page="900"]') as HTMLElement).style.width).toBe('1536px');
    expect(tracker.count()).toBeLessThanOrEqual(MAX_CANVASES);
  });
});

describe('reading the document by url', () => {
  it('disables BOTH prefetch and streaming, and sets a range chunk size', async () => {
    render(
      <PDFPageViewer
        file={{ url: 'https://storage.googleapis.com/signed/big.pdf' }}
        mode={'select' as any}
        onDocumentLoad={() => {}}
        onPageClick={() => {}}
        initialContainerWidth={800}
      >
        {() => null}
      </PDFPageViewer>,
    );
    await screen.findByTestId('document');

    const file = documentProps!.file as Record<string, unknown>;
    expect(file.url).toBe('https://storage.googleapis.com/signed/big.pdf');
    // Either flag alone leaves PDF.js pulling the whole document in the
    // background, which is the fetch this path exists to avoid.
    expect(file.disableAutoFetch).toBe(true);
    expect(file.disableStream).toBe(true);
    expect(file.rangeChunkSize).toBe(1024 * 1024);
  });

  it('hands PDF.js the same options object across a re-render', async () => {
    const { rerender } = render(
      <PDFPageViewer
        file={{ url: 'https://x/big.pdf' }}
        mode={'select' as any}
        onDocumentLoad={() => {}}
        onPageClick={() => {}}
        initialContainerWidth={800}
        zoom={100}
      >
        {() => null}
      </PDFPageViewer>,
    );
    await screen.findByTestId('document');
    const first = documentProps!.file;

    rerender(
      <PDFPageViewer
        file={{ url: 'https://x/big.pdf' }}
        mode={'select' as any}
        onDocumentLoad={() => {}}
        onPageClick={() => {}}
        initialContainerWidth={800}
        zoom={125}
      >
        {() => null}
      </PDFPageViewer>,
    );

    // A fresh object here makes react-pdf tear the document down and load it
    // again, which is worse than never setting the range options at all.
    expect(documentProps!.file).toBe(first);
  });
});
