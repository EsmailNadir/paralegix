import React from "react";
import { render, screen } from "@testing-library/react";

jest.mock("@/components/ui/PdfCanvasPage", () => ({
  __esModule: true,
  default: ({ pageNumber }: { pageNumber: number }) => (
    <div data-testid={`canvas-${pageNumber}`} />
  ),
}));

import PdfScrollPage from "@/components/signaturesComp/PdfScrollPage";

describe("PdfScrollPage", () => {
  it("tags itself with its page number so a pointer can be traced back to it", () => {
    render(
      <PdfScrollPage
        pageNumber={3}
        renderWidth={800}
        displayWidth={800}
        displayHeight={1000}
        interactive
        onLoadSuccess={() => {}}
      >
        {() => <div data-testid="overlay" />}
      </PdfScrollPage>
    );

    const page = screen.getByTestId("canvas-3").closest("[data-pdf-page]");
    expect(page).toHaveAttribute("data-pdf-page", "3");
    expect(screen.getByTestId("overlay")).toBeInTheDocument();
  });

  it("does not render overlays before its height is known", () => {
    render(
      <PdfScrollPage
        pageNumber={1}
        renderWidth={800}
        displayWidth={800}
        displayHeight={0}
        interactive
        onLoadSuccess={() => {}}
      >
        {() => <div data-testid="overlay" />}
      </PdfScrollPage>
    );

    // Overlays are positioned from the page height; at 0 they would all stack at
    // the top-left and then jump once the real height arrived.
    expect(screen.queryByTestId("overlay")).not.toBeInTheDocument();
  });

  it("passes the page its on-screen size, which is what overlays position from", () => {
    const sizes: Array<[number, number]> = [];
    render(
      <PdfScrollPage
        pageNumber={2}
        renderWidth={1600}
        displayWidth={800}
        displayHeight={1035}
        interactive
        onLoadSuccess={() => {}}
      >
        {(width, height) => {
          sizes.push([width, height]);
          return null;
        }}
      </PdfScrollPage>
    );

    // The display size, not the raster size: the two differ while a zoom settles.
    expect(sizes[0]).toEqual([800, 1035]);
  });

  it("shows the drag rectangle only when it belongs to this page", () => {
    const { rerender } = render(
      <PdfScrollPage
        pageNumber={1}
        renderWidth={800}
        displayWidth={800}
        displayHeight={1000}
        interactive
        onLoadSuccess={() => {}}
        dragRect={{ x: 10, y: 20, w: 100, h: 50 }}
      >
        {() => null}
      </PdfScrollPage>
    );
    expect(document.querySelector('[data-drag-rect]')).toBeInTheDocument();

    rerender(
      <PdfScrollPage
        pageNumber={1}
        renderWidth={800}
        displayWidth={800}
        displayHeight={1000}
        interactive
        onLoadSuccess={() => {}}
        dragRect={null}
      >
        {() => null}
      </PdfScrollPage>
    );
    expect(document.querySelector('[data-drag-rect]')).not.toBeInTheDocument();
  });

  it("leaves a page that has never been near the viewport unrasterised", () => {
    render(
      <PdfScrollPage
        pageNumber={30}
        renderWidth={800}
        displayWidth={800}
        displayHeight={1000}
        interactive
        onLoadSuccess={() => {}}
        offscreen
      >
        {() => <div data-testid="overlay" />}
      </PdfScrollPage>
    );

    // The box still occupies its full height so the scrollbar is honest and the
    // page does not jump when it does render.
    expect(screen.queryByTestId("canvas-30")).not.toBeInTheDocument();
    const box = document.querySelector('[data-pdf-page="30"]') as HTMLElement;
    expect(box.style.height).toBe("1000px");
  });
});
