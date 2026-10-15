/**
 * What `PdfPreview` asks PDF.js to do, and that every page stays addressable.
 * How many canvases it keeps while scrolling is `PdfPreviewWindowing.test.tsx`.
 *
 * `react-pdf` is mocked here so the props it receives can be inspected. That
 * limits honestly what this file may claim: it asserts the CONFIGURATION this
 * component sends and the page slots it lays out. It does not and cannot
 * prove that PDF.js then fetches only those ranges, because no PDF.js runs
 * under jsdom. That claim needs the integration harness in the plan's Task 16.
 *
 * Both rules here were wrong in the first attempt at large-document preview,
 * and both fail silently on a small file:
 *
 *   `disableAutoFetch` alone does nothing. PDF.js requires `disableStream`
 *   alongside it, or it still pulls the whole document in the background. A
 *   200 MB preview quietly downloaded 200 MB while looking correct.
 *
 *   Every page mounted a canvas. A 1,000-page document built 1,000 of them, so
 *   browser memory grew with page count no matter how the bytes arrived.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';

// `tests/setup.ts` stubs this component globally, because most specs only need
// it not to pull in react-pdf. This file is ABOUT the component, so it takes
// the real one and mocks react-pdf underneath instead.

/** Props the mocked `<Document>` was given, so the loading options can be read. */
let documentProps: Record<string, unknown> | null = null;

jest.mock('react-pdf', () => ({
  __esModule: true,
  pdfjs: { GlobalWorkerOptions: {} },
  Document: function MockDocument({ file, children, onLoadSuccess }: any) {
    documentProps = { file };
    // Fire ONCE. The real component passes an inline arrow for onLoadSuccess and
    // that handler resets state, so keying an effect on the handler identity
    // re-fires it every render and spins forever. A ref guard models what
    // react-pdf actually does: report the page count when parsing finishes.
    const fired = React.useRef(false);
    React.useEffect(() => {
      if (fired.current) return;
      fired.current = true;
      onLoadSuccess?.({ numPages: 1000 });
    });
    return <div data-testid="document">{children}</div>;
  },
  Page: () => null,
}));

jest.mock('@/components/ui/PdfCanvasPage', () => ({
  __esModule: true,
  // Named and capitalised so the hooks lint rule recognises it as a component.
  default: function MockPdfCanvasPage({ pageNumber }: { pageNumber: number }) {
    return <div data-testid={`canvas-${pageNumber}`} />;
  },
}));

import PdfPreview from '@/components/filesComp/PdfPreviewDocument';

/**
 * A ResizeObserver that actually reports a width.
 *
 * The component draws nothing until its container has been measured, which is
 * correct: page width comes from the container. jsdom performs no layout and
 * the shared harness stub never fires, so without this every assertion here
 * would pass or fail for the wrong reason, against a component that rendered
 * no pages at all.
 */
class MeasuringResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(target: Element) {
    this.cb(
      [{ target, contentRect: { width: 800, height: 1000 } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}

let originalResizeObserver: unknown;

beforeEach(() => {
  documentProps = null;
  originalResizeObserver = (globalThis as any).ResizeObserver;
  (globalThis as any).ResizeObserver = MeasuringResizeObserver;
});

afterEach(() => {
  (globalThis as any).ResizeObserver = originalResizeObserver;
});

describe('loading a document by url', () => {
  it('disables BOTH prefetch and streaming, and sets a range chunk size', () => {
    render(<PdfPreview url="https://storage.googleapis.com/signed/big.pdf" zoom={100} />);

    const file = documentProps!.file as Record<string, unknown>;
    expect(file.url).toBe('https://storage.googleapis.com/signed/big.pdf');
    // Either flag alone leaves PDF.js fetching the whole document.
    expect(file.disableAutoFetch).toBe(true);
    expect(file.disableStream).toBe(true);
    expect(file.rangeChunkSize).toBe(1024 * 1024);
  });

  it('passes bytes straight through when given bytes', () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

    render(<PdfPreview bytes={bytes} zoom={100} />);

    const file = documentProps!.file as Record<string, unknown>;
    expect(file.data).toBeInstanceOf(Uint8Array);
    expect(file.url).toBeUndefined();
    // Range options are meaningless for bytes already in memory and must not
    // be sent, or PDF.js warns and ignores the source it was handed.
    expect(file.disableStream).toBeUndefined();
  });
});

describe('how many pages are drawn', () => {
  it('keeps every page addressable even though most are not drawn', async () => {
    render(<PdfPreview url="https://x/big.pdf" zoom={100} />);
    await screen.findByTestId('document');

    // A page outside the window still occupies space, so scrolling and page
    // numbers behave. Remembering only the drawn pages would collapse the
    // scrollbar and make page 900 unreachable.
    expect(screen.getByTestId('page-slot-1')).toBeInTheDocument();
    expect(screen.getByTestId('page-slot-1000')).toBeInTheDocument();
  });
});
