import { pageFromPoint, pageFromPointerTarget } from "@/components/signaturesComp/pdfPointerPage";

describe("pageFromPointerTarget", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="stack">
        <div data-pdf-page="1"><span id="in-one">a</span></div>
        <div data-pdf-page="2"><span id="in-two">b</span></div>
      </div>
      <div id="outside">c</div>
    `;
  });

  it("finds the page a nested target sits inside", () => {
    const result = pageFromPointerTarget(document.getElementById("in-two")!);
    expect(result?.pageNumber).toBe(2);
  });

  it("returns the page element itself, so callers can measure it", () => {
    const result = pageFromPointerTarget(document.getElementById("in-one")!);
    expect(result?.element).toBe(document.querySelector('[data-pdf-page="1"]'));
  });

  it("returns null outside the stack, so a stray click places nothing", () => {
    expect(pageFromPointerTarget(document.getElementById("outside")!)).toBeNull();
  });

  it("ignores a target inside an existing annotation", () => {
    // That gesture is a drag of the annotation, not the placement of a new field.
    document.body.innerHTML = `
      <div data-pdf-page="1"><div data-annotation><span id="handle">h</span></div></div>
    `;
    expect(pageFromPointerTarget(document.getElementById("handle")!)).toBeNull();
  });

  it("rejects a malformed page number rather than placing on page NaN", () => {
    document.body.innerHTML = `<div data-pdf-page="nope"><span id="t">t</span></div>`;
    expect(pageFromPointerTarget(document.getElementById("t")!)).toBeNull();
  });
});

describe("pageFromPoint", () => {
  /** Two stacked pages with a 16px gap, as getBoundingClientRect would report them. */
  function buildMeasuredStack() {
    document.body.innerHTML = `
      <div data-pdf-page="1"></div>
      <div data-pdf-page="2"></div>
    `;
    const rects: Record<string, DOMRect> = {
      "1": { left: 100, right: 700, top: 0, bottom: 800, width: 600, height: 800 } as DOMRect,
      "2": { left: 100, right: 700, top: 816, bottom: 1616, width: 600, height: 800 } as DOMRect,
    };
    document.querySelectorAll<HTMLElement>("[data-pdf-page]").forEach((el) => {
      el.getBoundingClientRect = () => rects[el.dataset.pdfPage!];
    });
  }

  beforeEach(buildMeasuredStack);

  it("finds the page whose box contains the point", () => {
    expect(pageFromPoint(400, 900)?.pageNumber).toBe(2);
    expect(pageFromPoint(400, 100)?.pageNumber).toBe(1);
  });

  it("returns null in the gap between pages, so a drop there stays put", () => {
    expect(pageFromPoint(400, 808)).toBeNull();
  });

  it("returns null beside the stack", () => {
    expect(pageFromPoint(50, 900)).toBeNull();
  });
});
