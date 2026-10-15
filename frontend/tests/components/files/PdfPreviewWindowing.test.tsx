/**
 * What the file preview keeps in memory while a long document is read, and what
 * survives when its read url is replaced underneath it.
 *
 * `PdfPreview.test.tsx` covers the CONFIGURATION handed to PDF.js and that the
 * first frame is bounded. This file covers the two things that only show up over
 * time: the count while actually scrolling a 1,000-page document end to end, and
 * a signed url that expires mid-read and is reminted. Both were silently fine on
 * the two-page test documents the component was built against.
 *
 * `react-pdf` is mocked, so no claim is made here about which bytes PDF.js then
 * fetches. What is asserted is what this component mounts and unmounts.
 */
import React from 'react';
import { render, screen, act } from '@testing-library/react';
import {
  createCanvasTracker,
  installIntersectionControl,
  installMeasuringResizeObserver,
  trackedCanvas,
  type IntersectionControl,
} from '../../support/pdfWindowHarness';

const PAGE_COUNT = 1000;
const tracker = createCanvasTracker();

let documentProps: Record<string, unknown> | null = null;

jest.mock('react-pdf', () => ({
  __esModule: true,
  pdfjs: { GlobalWorkerOptions: {} },
  Document: function MockDocument({ file, children, onLoadSuccess }: any) {
    documentProps = { file };
    // A real Document reports its page count once, when parsing finishes, and
    // again when it is handed a different file. Modelled with the file identity.
    const reported = React.useRef<unknown>(null);
    React.useEffect(() => {
      if (reported.current === file) return;
      reported.current = file;
      onLoadSuccess?.({ numPages: PAGE_COUNT });
    });
    return <div data-testid="document">{children}</div>;
  },
  Page: () => null,
}));

// A deliberately non-Letter page, so a MEASURED page's box is a different height
// from the guess an unmeasured one falls back to. With Letter-shaped pages the
// two are within a pixel of each other and a lost measurement is undetectable.
jest.mock('@/components/ui/PdfCanvasPage', () => ({
  __esModule: true,
  default: trackedCanvas(() => tracker, jest.requireActual('react'), { width: 600, height: 1200 }),
}));

import PdfPreview, { MAX_RENDERED_CANVASES } from '@/components/filesComp/PdfPreviewDocument';

let intersection: IntersectionControl;
let restoreResize: () => void;

beforeEach(() => {
  documentProps = null;
  tracker.reset();
  restoreResize = installMeasuringResizeObserver(800);
  intersection = installIntersectionControl((page) => `[data-testid="page-slot-${page}"]`);
});

afterEach(() => {
  intersection.restore();
  restoreResize();
});

function scrollToPage(page: number) {
  act(() => {
    intersection.scrollTo({ [page]: 1, [page + 1]: 0.3 });
  });
}

describe('reading a 1,000-page document', () => {
  it('never holds more than the cap in canvases, from page 1 to 900 and back', async () => {
    render(<PdfPreview url="https://x/big.pdf" zoom={100} />);
    await screen.findByTestId('document');

    expect(tracker.count()).toBeGreaterThan(0);
    expect(tracker.count()).toBeLessThanOrEqual(MAX_RENDERED_CANVASES);

    for (let page = 1; page <= 900; page += 41) {
      scrollToPage(page);
      expect(tracker.count()).toBeLessThanOrEqual(MAX_RENDERED_CANVASES);
    }
    for (let page = 900; page >= 1; page -= 41) {
      scrollToPage(page);
      expect(tracker.count()).toBeLessThanOrEqual(MAX_RENDERED_CANVASES);
    }

    scrollToPage(1);
    expect(tracker.count()).toBeGreaterThan(0);
    expect(tracker.count()).toBeLessThanOrEqual(MAX_RENDERED_CANVASES);
  });

  it('takes the canvas out of the DOM when its page leaves the window', async () => {
    render(<PdfPreview url="https://x/big.pdf" zoom={100} />);
    await screen.findByTestId('document');
    expect(screen.getByTestId('canvas-1')).toBeInTheDocument();

    scrollToPage(500);

    // A hidden canvas still holds its bitmap, so `toBeVisible` would not be the
    // assertion this rule needs.
    expect(screen.queryByTestId('canvas-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('canvas-500')).toBeInTheDocument();
    // The slot stays, so page 1 is still somewhere to scroll back to.
    expect(screen.getByTestId('page-slot-1')).toBeInTheDocument();
  });
});

describe('the source handed to PDF.js', () => {
  it('is the same object across a re-render', async () => {
    const { rerender } = render(<PdfPreview url="https://x/big.pdf" zoom={100} />);
    await screen.findByTestId('document');
    const first = documentProps!.file;

    rerender(<PdfPreview url="https://x/big.pdf" zoom={140} />);

    // A fresh object makes react-pdf tear the document down and reload it, which
    // costs more than the range options in it save.
    expect(documentProps!.file).toBe(first);
  });
});

describe('a read url that is reminted mid-view', () => {
  /** The page slots' measured heights, which is where the scroll position lives. */
  function slotHeight(page: number) {
    return (screen.getByTestId(`page-slot-${page}`) as HTMLElement).style.height;
  }

  // 800 of container less 32 of padding, against the 600x1200 pages the canvas
  // stub reports, is the box a MEASURED page keeps once it is no longer drawn.
  const MEASURED_HEIGHT = '1536px';

  it('keeps the measured pages and the drawn window when only the signature changes', async () => {
    const { rerender } = render(
      <PdfPreview url="https://x/o/doc.pdf?X-Goog-Expires=900&sig=first" zoom={100} />,
    );
    await screen.findByTestId('document');

    // Measure page 700 by drawing it, then read it back as a placeholder.
    scrollToPage(700);
    scrollToPage(100);
    expect(slotHeight(700)).toBe(MEASURED_HEIGHT);
    // A page never drawn is still on the guess, which is what makes the
    // assertion above about a measurement rather than about the guess.
    expect(slotHeight(900)).not.toBe(MEASURED_HEIGHT);

    rerender(<PdfPreview url="https://x/o/doc.pdf?X-Goog-Expires=900&sig=second" zoom={100} />);

    // Same object, new signature. Throwing the measurements away here would
    // resize every page the reader has already passed and move the document
    // under them; losing the window would put them back at page 1.
    expect(slotHeight(700)).toBe(MEASURED_HEIGHT);
    expect(screen.getByTestId('canvas-100')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-1')).not.toBeInTheDocument();
  });

  it('starts over when the url points at a different object', async () => {
    const { rerender } = render(<PdfPreview url="https://x/o/doc.pdf?sig=first" zoom={100} />);
    await screen.findByTestId('document');
    scrollToPage(700);
    scrollToPage(100);
    expect(slotHeight(700)).toBe(MEASURED_HEIGHT);

    rerender(<PdfPreview url="https://x/o/other.pdf?sig=first" zoom={100} />);

    // A different document is measured from scratch and opens at its first page.
    // Carrying the previous one's page sizes over would lay this one out wrong.
    expect(screen.getByTestId('canvas-1')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-100')).not.toBeInTheDocument();
    expect(slotHeight(700)).not.toBe(MEASURED_HEIGHT);
  });
});
