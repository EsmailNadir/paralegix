import { extractGraphicsBoxesFromPixels, shouldSkipPdfTextItem } from "@/lib/pdfToHtml";

describe("shouldSkipPdfTextItem", () => {
  it.each([
    ["skips a phone icon glyph when the page background already exists", "☎", "ZapfDingbats", true, true],
    ["skips a mail icon glyph when the page background already exists", "✉", "Wingdings", true, true],
    // Preserved so list content remains editable.
    ["preserves a bullet character", "•", "Helvetica", true, false],
    ["preserves a dash bullet character", "–", "Helvetica", true, false],
    ["keeps an icon glyph if there is no graphics layer to fall back to", "☎", "ZapfDingbats", false, false],
    // Trimmed to nothing, so there is no glyph to classify. Reaching the icon
    // check with an empty string would decide on no evidence.
    ["keeps an empty item", "", "ZapfDingbats", true, false],
    ["keeps a whitespace-only item", "   ", "ZapfDingbats", true, false],
    ["keeps a tab-and-newline item", "\t\n", "ZapfDingbats", true, false],
    // The font name alone is not enough. A document that sets an unusual font on
    // a paragraph must not lose the paragraph.
    ["keeps ordinary text in a ZapfDingbats font", "Agreement", "ZapfDingbats", true, false],
    ["keeps ordinary text in a Wingdings font", "Party A", "Wingdings", true, false],
    ["keeps ordinary text with no font name at all", "Agreement", undefined, true, false],
    // The check scans every character and bails on the first bullet. An item
    // combining a bullet with other content is list text, and dropping it loses
    // the line rather than an icon.
    ["keeps a bullet ANYWHERE in the item, not only alone", "☎•", "ZapfDingbats", true, false],
  ] as Array<[string, string, string | undefined, boolean, boolean]>)(
    "%s",
    (_label, text, font, hasGraphicsLayer, skipped) => {
      expect(shouldSkipPdfTextItem(text, font, hasGraphicsLayer)).toBe(skipped);
    },
  );

  it("defaults to keeping the glyph when hasGraphicsLayer is not passed", () => {
    // The parameter defaults to false, and false means keep. The default has to
    // be the safe one: skipping a glyph with no image layer behind it deletes
    // content from the document outright, with nothing rendered in its place.
    expect(shouldSkipPdfTextItem("☎", "ZapfDingbats")).toBe(false);
  });

  it("keeps every bullet character the list uses", () => {
    // Each of these introduces a list item somewhere in a real document. One
    // missing from the set means that list silently loses its markers.
    for (const bullet of ["•", "–", "—", "▪", "◦", "‣"]) {
      expect(shouldSkipPdfTextItem(bullet, "ZapfDingbats", true)).toBe(false);
    }
  });

  it("classifies a glyph the same with or without surrounding whitespace", () => {
    // NOT a test of the outer `trim()`. `isLikelyIconGlyph` trims internally
    // too, so removing the outer one changes no answer here and this case cannot
    // distinguish the two. An earlier draft claimed it did; verified by removing
    // the outer trim and watching this still pass.
    //
    // What it does pin is the observable contract: whitespace around a glyph
    // never changes the decision.
    expect(shouldSkipPdfTextItem("  ☎  ", "ZapfDingbats", true))
      .toBe(shouldSkipPdfTextItem("☎", "ZapfDingbats", true));
  });
});

describe("extractGraphicsBoxesFromPixels", () => {
  function createCanvasPixels(width: number, height: number) {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = 255;
      pixels[i + 1] = 255;
      pixels[i + 2] = 255;
      pixels[i + 3] = 255;
    }
    return pixels;
  }

  function paintRect(
    pixels: Uint8ClampedArray,
    width: number,
    left: number,
    top: number,
    rectWidth: number,
    rectHeight: number,
    rgb: number
  ) {
    for (let y = top; y < top + rectHeight; y += 1) {
      for (let x = left; x < left + rectWidth; x += 1) {
        const index = (y * width + x) * 4;
        pixels[index] = rgb;
        pixels[index + 1] = rgb;
        pixels[index + 2] = rgb;
        pixels[index + 3] = 255;
      }
    }
  }

  it("separates a dark signature from a nearby light watermark with multi-pass scanning", () => {
    const width = 160;
    const height = 100;
    const pixels = createCanvasPixels(width, height);

    paintRect(pixels, width, 10, 46, 16, 7, 32);
    paintRect(pixels, width, 29, 48, 11, 6, 32);
    paintRect(pixels, width, 48, 12, 78, 56, 247);

    const boxes = extractGraphicsBoxesFromPixels(pixels, width, height);

    expect(boxes).toHaveLength(2);
    expect(boxes.some((box) => box.left <= 10 && box.top >= 40 && box.width < 40)).toBe(true);
    expect(boxes.some((box) => box.left >= 40 && box.top <= 12 && box.width > 70 && box.height > 50)).toBe(true);
    expect(boxes.some((box) => box.left <= 10 && box.top <= 12 && box.width > 110)).toBe(false);
  });

  it("does not merge overlapping signature and watermark boxes from different scan passes", () => {
    const width = 180;
    const height = 120;
    const pixels = createCanvasPixels(width, height);

    paintRect(pixels, width, 24, 18, 120, 68, 247); // light watermark region
    paintRect(pixels, width, 12, 58, 34, 10, 26);   // dark signature crossing watermark edge

    const boxes = extractGraphicsBoxesFromPixels(pixels, width, height);

    expect(boxes).toHaveLength(2);
    expect(boxes.some((box) => box.left <= 12 && box.top >= 52 && box.width <= 44 && box.height <= 20)).toBe(true);
    expect(boxes.some((box) => box.left >= 20 && box.top <= 20 && box.width >= 110 && box.height >= 60)).toBe(true);
  });

  it("merges nearby signature fragments so the tail is not duplicated as a second image", () => {
    const width = 180;
    const height = 90;
    const pixels = createCanvasPixels(width, height);

    paintRect(pixels, width, 20, 40, 22, 10, 24);
    paintRect(pixels, width, 60, 42, 12, 8, 24);

    const boxes = extractGraphicsBoxesFromPixels(pixels, width, height);

    expect(boxes).toHaveLength(1);
    expect(boxes[0].left).toBeLessThanOrEqual(18);
    expect(boxes[0].width).toBeGreaterThanOrEqual(52);
  });

  it("finds nothing on a blank page", () => {
    // A page of pure white must produce no image. Emitting a box here would put
    // an empty picture on every text-only page of a converted document.
    const width = 120;
    const height = 90;
    const pixels = createCanvasPixels(width, height);

    expect(extractGraphicsBoxesFromPixels(pixels, width, height)).toEqual([]);
  });

  it("finds a single dark mark", () => {
    const width = 120;
    const height = 90;
    const pixels = createCanvasPixels(width, height);
    paintRect(pixels, width, 30, 20, 24, 16, 20);

    const boxes = extractGraphicsBoxesFromPixels(pixels, width, height);

    // The positive half of the blank-page case. A detector that found nothing
    // anywhere would satisfy that one and drop every signature and logo.
    expect(boxes.length).toBeGreaterThan(0);
  });

  it("covers the painted mark inside the box it returns", () => {
    const width = 120;
    const height = 90;
    const pixels = createCanvasPixels(width, height);
    paintRect(pixels, width, 30, 20, 24, 16, 20);

    const [box] = extractGraphicsBoxesFromPixels(pixels, width, height);

    // A box that misses part of the ink crops a signature mid-stroke, which is
    // visible on the page and is the kind of thing a client queries.
    expect(box.left).toBeLessThanOrEqual(30);
    expect(box.top).toBeLessThanOrEqual(20);
    expect(box.left + box.width).toBeGreaterThanOrEqual(30 + 24);
    expect(box.top + box.height).toBeGreaterThanOrEqual(20 + 16);
  });

  it("never returns a box outside the page", () => {
    const width = 120;
    const height = 90;
    const pixels = createCanvasPixels(width, height);
    // Hard against every edge, so the padding the extractor adds has nowhere to
    // go. A box with a negative origin, or one running past the page, crops to
    // an empty canvas downstream and the image comes out blank.
    paintRect(pixels, width, 0, 0, 20, 14, 20);
    paintRect(pixels, width, width - 20, height - 14, 20, 14, 20);

    for (const box of extractGraphicsBoxesFromPixels(pixels, width, height)) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.left + box.width).toBeLessThanOrEqual(width);
      expect(box.top + box.height).toBeLessThanOrEqual(height);
    }
  });

  it("never returns a zero-width or zero-height box", () => {
    const width = 120;
    const height = 90;
    const pixels = createCanvasPixels(width, height);
    paintRect(pixels, width, 40, 30, 1, 1, 20);
    paintRect(pixels, width, 60, 30, 30, 20, 20);

    for (const box of extractGraphicsBoxesFromPixels(pixels, width, height)) {
      // A zero dimension makes an image element that renders nothing, and the
      // content it represented is gone from the document with no sign of it.
      //
      // This pins the INVARIANT, not the `Math.max(1, ...)` that enforces it:
      // removing that clamp leaves this green, because reaching a non-positive
      // width needs a box lying entirely off-page and the mask never produces
      // one. Verified by removing it. The guard is defensive; the invariant is
      // still worth holding, since a future change to the padding or the mask
      // could make it reachable.
      expect(box.width).toBeGreaterThan(0);
      expect(box.height).toBeGreaterThan(0);
    }
  });

  it("returns boxes ordered top to bottom, then left to right", () => {
    const width = 200;
    const height = 160;
    const pixels = createCanvasPixels(width, height);
    // Painted deliberately out of reading order.
    paintRect(pixels, width, 120, 110, 30, 20, 20);
    paintRect(pixels, width, 20, 20, 30, 20, 20);
    paintRect(pixels, width, 120, 20, 30, 20, 20);

    const boxes = extractGraphicsBoxesFromPixels(pixels, width, height);

    // Reading order is what places each extracted image back into the document
    // flow. Out of order, a signature block lands above the paragraph it signs.
    for (let i = 1; i < boxes.length; i += 1) {
      const previous = boxes[i - 1];
      const current = boxes[i];
      const inOrder = current.top > previous.top
        || (current.top === previous.top && current.left >= previous.left);
      expect(inOrder).toBe(true);
    }
  });

  it("keeps two well-separated marks apart", () => {
    const width = 240;
    const height = 200;
    const pixels = createCanvasPixels(width, height);
    paintRect(pixels, width, 20, 20, 30, 20, 20);
    paintRect(pixels, width, 170, 150, 30, 20, 20);

    const boxes = extractGraphicsBoxesFromPixels(pixels, width, height);

    // Two signatures at opposite corners of a page are two images. Merging them
    // produces one box spanning the whole page, which swallows the text between
    // them into a picture.
    expect(boxes.length).toBeGreaterThanOrEqual(2);
  });

  it("handles a page smaller than the padding it adds", () => {
    const width = 4;
    const height = 4;
    const pixels = createCanvasPixels(width, height);
    paintRect(pixels, width, 1, 1, 2, 2, 20);

    // A tiny page is where clamping errors surface: the padding is larger than
    // the page, so every bound has to be clamped in both directions at once.
    expect(() => extractGraphicsBoxesFromPixels(pixels, width, height)).not.toThrow();
    for (const box of extractGraphicsBoxesFromPixels(pixels, width, height)) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.left + box.width).toBeLessThanOrEqual(width);
      expect(box.top + box.height).toBeLessThanOrEqual(height);
    }
  });

  it("ignores a very light background wash", () => {
    const width = 120;
    const height = 90;
    const pixels = createCanvasPixels(width, height);
    // A near-white tint across the whole page, the shape a scanner or a page
    // background produces. Treating it as ink boxes the entire page as one
    // image and the document becomes a picture of itself.
    paintRect(pixels, width, 0, 0, width, height, 252);

    const boxes = extractGraphicsBoxesFromPixels(pixels, width, height);
    const pageArea = width * height;
    for (const box of boxes) {
      expect(box.width * box.height).toBeLessThan(pageArea);
    }
  });
});
