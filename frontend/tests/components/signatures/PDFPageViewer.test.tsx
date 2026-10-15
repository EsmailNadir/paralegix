import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";

// How many pages the stubbed document reports. A test about the boundary of the
// drawn window sets it higher, because a document shorter than the window has no
// undrawn page to assert about.
let stubPageCount = 3;

function DocumentStub({ children, onLoadSuccess }: any) {
  React.useEffect(() => {
    onLoadSuccess?.({ numPages: stubPageCount });
  }, [onLoadSuccess]);
  return <div data-testid="document">{children}</div>;
}

beforeEach(() => {
  stubPageCount = 3;
});

// react-pdf needs a worker and a real PDF; stub it down to the contract the viewer
// depends on — a Document that reports a page count, and one canvas per page.
jest.mock("react-pdf", () => ({
  __esModule: true,
  pdfjs: { GlobalWorkerOptions: {} },
  Document: (props: any) => <DocumentStub {...props} />,
  Page: () => null,
}));
function CanvasStub({ pageNumber, onLoadSuccess }: any) {
  React.useEffect(() => {
    onLoadSuccess?.({ width: 612, height: 792 });
  }, [onLoadSuccess]);
  return <div data-testid={`canvas-${pageNumber}`} />;
}
jest.mock("@/components/ui/PdfCanvasPage", () => ({
  __esModule: true,
  default: (props: any) => <CanvasStub {...props} />,
}));

// `tests/setup.ts` stubs this component to `() => null` for the whole suite,
// because `react-pdf` is ESM that Jest cannot parse. This is the one test that
// actually needs the real thing, so it reaches past the registry for the component
// while leaving the `react-pdf` stub above in place for the component's own import.
const PDFPageViewer = jest.requireActual(
  "@/components/signaturesComp/PDFPageViewer"
).default as typeof import("@/components/signaturesComp/PDFPageViewer").default;

function renderViewer(
  children: (page: number, w: number, h: number) => React.ReactNode,
  extra: Record<string, unknown> = {}
) {
  return render(
    <PDFPageViewer
      file={{ url: "blob:doc", bytes: new Uint8Array() }}
      mode={"signature" as any}
      onDocumentLoad={() => {}}
      onPageClick={() => {}}
      // ResizeObserver is stubbed in tests/setup, so a container width never
      // arrives on its own; seed it instead.
      initialContainerWidth={800}
      {...extra}
    >
      {children}
    </PDFPageViewer>
  );
}

/** Drives the captured IntersectionObserver callback with ratios per page. */
function reportVisibility(ratios: Record<number, number>) {
  const entries = Object.entries(ratios).map(([page, intersectionRatio]) => ({
    target: document.querySelector(`[data-pdf-page="${page}"]`),
    intersectionRatio,
    isIntersecting: intersectionRatio > 0,
  }));
  (globalThis as any).__lastIntersectionCallback?.(entries);
}

describe("PDFPageViewer", () => {
  it('places the selected annotation tool through the existing page surface by keyboard', async () => {
    const place = jest.fn();
    renderViewer(() => null, { keyboardPlacement: true, onPageClick: place });
    await screen.findByTestId('canvas-1');
    const page = screen.getByRole('group', { name: 'Page 2' });
    page.focus();
    fireEvent.keyDown(page, { key: 'Enter' });
    expect(place).toHaveBeenCalledWith(2, 50, 50);
    expect(page).toHaveFocus();
  });
  it("mounts every page at once rather than one at a time", async () => {
    renderViewer(() => null);
    expect(await screen.findByTestId("canvas-1")).toBeInTheDocument();
    expect(screen.getByTestId("canvas-2")).toBeInTheDocument();
  });

  it("lays out a box for every page in the document", async () => {
    renderViewer(() => null);
    await screen.findByTestId("canvas-1");
    expect(document.querySelectorAll("[data-pdf-page]")).toHaveLength(3);
  });

  it("calls the render prop once per page, with that page's number", async () => {
    const seen: number[] = [];
    renderViewer((page) => {
      seen.push(page);
      return <div data-testid={`overlay-${page}`} />;
    });

    await screen.findByTestId("overlay-3");
    expect([...new Set(seen)].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("gives each page's overlays that page's own on-screen size", async () => {
    const sizes = new Map<number, [number, number]>();
    renderViewer((page, width, height) => {
      sizes.set(page, [width, height]);
      return null;
    });

    await screen.findByTestId("canvas-1");
    // 800 container - 32 padding = 768 at 100% zoom, and 612x792 is a 1.294 ratio.
    const [width, height] = sizes.get(1)!;
    expect(width).toBe(768);
    expect(Math.round(height)).toBe(994);
  });

  it("has no prev/next controls left", async () => {
    renderViewer(() => null);
    await screen.findByTestId("canvas-1");
    expect(screen.queryByRole("button", { name: /previous page/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /next page/i })).not.toBeInTheDocument();
  });

  it("reports the page nearest the top of the viewport as visible", async () => {
    const onVisiblePageChange = jest.fn();
    renderViewer(() => null, { onVisiblePageChange });
    await screen.findByTestId("canvas-1");

    // jsdom reports every rect as 0, so the observer callback is driven directly.
    reportVisibility({ 1: 0.1, 2: 0.9 });

    expect(onVisiblePageChange).toHaveBeenLastCalledWith(2);
  });

  it("keeps reporting the same page when nothing more intersects", async () => {
    const onVisiblePageChange = jest.fn();
    renderViewer(() => null, { onVisiblePageChange });
    await screen.findByTestId("canvas-1");

    reportVisibility({ 1: 0.9, 2: 0.1 });
    reportVisibility({ 2: 0.2 });

    // Page 1 is still the most visible; a later report about page 2 alone must not
    // hand the indicator to it.
    expect(onVisiblePageChange).toHaveBeenLastCalledWith(1);
  });

  it("reserves height for a page it has not rasterised, so the stack does not collapse", async () => {
    stubPageCount = 30;
    renderViewer(() => null);
    await screen.findByTestId("canvas-1");

    // Page 30 is beyond the drawn window, so it has no canvas. Its box must still
    // stand at a full page's height or every page would pile up at the top and all
    // of them would count as visible.
    const last = document.querySelector('[data-pdf-page="30"]') as HTMLElement;
    expect(screen.queryByTestId("canvas-30")).not.toBeInTheDocument();
    expect(parseFloat(last.style.height)).toBeGreaterThan(500);
  });

  it("rasterises a page once it comes near the viewport", async () => {
    stubPageCount = 30;
    renderViewer(() => null);
    await screen.findByTestId("canvas-1");
    expect(screen.queryByTestId("canvas-30")).not.toBeInTheDocument();

    reportVisibility({ 30: 0.5 });

    expect(await screen.findByTestId("canvas-30")).toBeInTheDocument();
  });
});
