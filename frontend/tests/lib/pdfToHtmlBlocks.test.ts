/**
 * `convertPdfToHtml`, the block-assembly half of the PDF importer. The two
 * exported predicates already have a spec next door in `pdfToHtml.test.ts`;
 * everything the converter itself does was unreached, which is most of the
 * file.
 *
 * This is the code that turns a page of positioned glyphs back into editable
 * prose: it groups text runs into lines, lines into paragraphs, decides where a
 * word space belongs versus mere kerning, resolves each PDF font name to a CSS
 * stack, detects alignment against the page's text column, and lays the result
 * out in absolute pixels. Every one of those decisions is arithmetic on
 * coordinates, and every failure looks like a plausible document: a paragraph
 * that will not re-wrap because its lines never joined, a phone number split
 * across two spans by a space that was really kerning, a heading in the wrong
 * face, a signature block chained into the paragraph above it.
 *
 * pdfjs is mocked rather than driven, so no worker, no binary fixture, and no
 * real rendering is involved. The mock hands back the same shapes pdfjs does:
 * a viewport with `convertToViewportPoint`, text items carrying a text matrix,
 * a `commonObjs` font table, and a `render` that draws through a canvas
 * context. jsdom implements no canvas at all, so a minimal 2D context backed by
 * a real pixel buffer is installed below; that keeps the ink detection, the
 * per-character colour capture and the graphics cropping running for real
 * against pixels the test painted.
 */
import type { PdfToHtmlResult } from "@/lib/pdfToHtml";

/** Assigned per test; read by the hoisted `pdfjs-dist` mock factory. */
let mockPdfDocument: { numPages: number; getPage: (n: number) => Promise<unknown> };

jest.mock("pdfjs-dist", () => ({
  // A truthy workerSrc keeps the converter from trying to resolve the real
  // worker bundle, which is the one thing here that needs a browser.
  GlobalWorkerOptions: { workerSrc: "test://worker" },
  getDocument: () => ({ promise: Promise.resolve(mockPdfDocument) }),
}));

// ---------------------------------------------------------------------------
// Minimal canvas, backed by a real RGBA buffer
// ---------------------------------------------------------------------------

/** Set by a test to make every getImageData call throw, as a tainted canvas does. */
let failGetImageData = false;

function parseFillColor(style: string): [number, number, number] {
  const hex6 = /^#([0-9a-f]{6})$/i.exec(style.trim());
  if (hex6) {
    const n = parseInt(hex6[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const hex3 = /^#([0-9a-f]{3})$/i.exec(style.trim());
  if (hex3) {
    const [r, g, b] = hex3[1].split("");
    return [parseInt(r + r, 16), parseInt(g + g, 16), parseInt(b + b, 16)];
  }
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(style.trim());
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return [0, 0, 0];
}

/**
 * Stand-in for the browser's 2D context. Only the operations the converter
 * actually performs are implemented, but `fillRect` and `getImageData` work on
 * a real buffer so the graphics scanner sees genuine pixels.
 */
class FakeCanvasContext {
  canvas: HTMLCanvasElement;
  data: Uint8ClampedArray;
  private t = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  private _fill: string | CanvasGradient | CanvasPattern = "#000000";

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    // A fresh canvas is transparent black, which is what makes a page with no
    // artwork report no ink.
    this.data = new Uint8ClampedArray(canvas.width * canvas.height * 4);
  }

  get fillStyle() {
    return this._fill;
  }

  set fillStyle(value: string | CanvasGradient | CanvasPattern) {
    this._fill = value;
  }

  getTransform() {
    return { ...this.t };
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number) {
    this.t = { a, b, c, d, e, f };
  }

  fillText(_text: string, _x: number, _y: number, _maxWidth?: number) {}
  strokeText(_text: string, _x: number, _y: number, _maxWidth?: number) {}
  save() {}
  restore() {}
  beginPath() {}
  closePath() {}
  drawImage() {}

  fillRect(x: number, y: number, w: number, h: number) {
    const [r, g, b] = parseFillColor(typeof this._fill === "string" ? this._fill : "#000000");
    const left = Math.max(0, Math.floor(x));
    const top = Math.max(0, Math.floor(y));
    const right = Math.min(this.canvas.width, Math.ceil(x + w));
    const bottom = Math.min(this.canvas.height, Math.ceil(y + h));
    for (let py = top; py < bottom; py += 1) {
      for (let px = left; px < right; px += 1) {
        const i = (py * this.canvas.width + px) * 4;
        this.data[i] = r;
        this.data[i + 1] = g;
        this.data[i + 2] = b;
        this.data[i + 3] = 255;
      }
    }
  }

  clearRect(x: number, y: number, w: number, h: number) {
    const left = Math.max(0, Math.floor(x));
    const top = Math.max(0, Math.floor(y));
    const right = Math.min(this.canvas.width, Math.ceil(x + w));
    const bottom = Math.min(this.canvas.height, Math.ceil(y + h));
    for (let py = top; py < bottom; py += 1) {
      for (let px = left; px < right; px += 1) {
        this.data.fill(0, (py * this.canvas.width + px) * 4, (py * this.canvas.width + px) * 4 + 4);
      }
    }
  }

  getImageData(x: number, y: number, w: number, h: number) {
    if (failGetImageData) throw new Error("canvas is tainted");
    const out = new Uint8ClampedArray(w * h * 4);
    for (let py = 0; py < h; py += 1) {
      for (let px = 0; px < w; px += 1) {
        const src = ((y + py) * this.canvas.width + (x + px)) * 4;
        const dst = (py * w + px) * 4;
        out[dst] = this.data[src];
        out[dst + 1] = this.data[src + 1];
        out[dst + 2] = this.data[src + 2];
        out[dst + 3] = this.data[src + 3];
      }
    }
    return { data: out, width: w, height: h };
  }

  putImageData(image: { data: Uint8ClampedArray; width: number; height: number }, dx: number, dy: number) {
    for (let py = 0; py < image.height; py += 1) {
      for (let px = 0; px < image.width; px += 1) {
        const src = (py * image.width + px) * 4;
        const dst = ((dy + py) * this.canvas.width + (dx + px)) * 4;
        this.data[dst] = image.data[src];
        this.data[dst + 1] = image.data[src + 1];
        this.data[dst + 2] = image.data[src + 2];
        this.data[dst + 3] = image.data[src + 3];
      }
    }
  }
}

const realGetContext = HTMLCanvasElement.prototype.getContext;
const realToDataURL = HTMLCanvasElement.prototype.toDataURL;

function installFakeCanvas() {
  (globalThis as Record<string, unknown>).CanvasRenderingContext2D = FakeCanvasContext;
  const contexts = new WeakMap<HTMLCanvasElement, FakeCanvasContext>();
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    let ctx = contexts.get(this);
    if (!ctx) {
      ctx = new FakeCanvasContext(this);
      contexts.set(this, ctx);
    }
    return ctx as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  // The encoded bytes are never decoded by anything under test, but the size is
  // carried through so a test can tell which canvas an image came from.
  HTMLCanvasElement.prototype.toDataURL = function (this: HTMLCanvasElement) {
    return `data:image/png;base64,w${this.width}h${this.height}`;
  } as typeof HTMLCanvasElement.prototype.toDataURL;
}

function restoreRealCanvas() {
  delete (globalThis as Record<string, unknown>).CanvasRenderingContext2D;
  HTMLCanvasElement.prototype.getContext = realGetContext;
  HTMLCanvasElement.prototype.toDataURL = realToDataURL;
}

// ---------------------------------------------------------------------------
// Fake pdfjs page
// ---------------------------------------------------------------------------

const SCALE = 1.5;

type FakeItem = {
  str: string;
  /** Key into `fonts` / `styles`; the converter uses it to look up weight and family. */
  fontName?: string;
  /** Item advance width in PDF points, before the viewport scale. */
  widthPt: number;
  /** Left edge in PDF points. */
  xPt: number;
  /** Baseline measured downwards from the top of the page, in PDF points. */
  topPt: number;
  /** Glyph size in PDF points; the converter multiplies by the viewport scale. */
  sizePt?: number;
  /** Fill colour used for every glyph of the item. */
  color?: string;
  /**
   * One entry per glyph the renderer draws. Supplying fewer entries than the
   * string has characters is how a ligature behaves.
   */
  glyphColors?: (string | null)[];
};

type FakeRect = {
  leftPt: number;
  topPt: number;
  widthPt: number;
  heightPt: number;
  color?: string;
};

type FakePageSpec = {
  widthPt: number;
  heightPt: number;
  items: FakeItem[];
  /** Per-font-name style records, as `getTextContent().styles` supplies them. */
  styles?: Record<string, { fontFamily?: string }>;
  /** Per-font-name entries for `commonObjs.get`, carrying the PostScript name. */
  fonts?: Record<string, { name?: string; fallbackName?: string }>;
  annotations?: Record<string, unknown>[];
  /** Artwork painted into the graphics canvas, in PDF points. */
  graphics?: FakeRect[];
};

function makeViewport(spec: FakePageSpec, scale: number) {
  return {
    width: spec.widthPt * scale,
    height: spec.heightPt * scale,
    scale,
    convertToViewportPoint(x: number, y: number) {
      return [x * scale, (spec.heightPt - y) * scale];
    },
  };
}

function makePage(spec: FakePageSpec) {
  const toTextItem = (item: FakeItem) => {
    const size = item.sizePt ?? 12;
    return {
      str: item.str,
      fontName: item.fontName ?? "",
      width: item.widthPt,
      height: size,
      // pdf.js builds the text matrix as [size * horizontalScale, 0, 0, size, x, y].
      transform: [size, 0, 0, size, item.xPt, spec.heightPt - item.topPt],
    };
  };

  return {
    getViewport: ({ scale }: { scale: number }) => makeViewport(spec, scale),
    getTextContent: async () => ({
      items: spec.items.map(toTextItem),
      styles: spec.styles ?? {},
    }),
    getAnnotations: async () => spec.annotations ?? [],
    commonObjs: { get: (name: string) => spec.fonts?.[name] },
    render: ({ canvasContext, viewport }: { canvasContext: FakeCanvasContext; viewport: ReturnType<typeof makeViewport> }) => ({
      promise: (async () => {
        // pdfjs draws text one glyph at a time under an identity-ish transform,
        // which is what the converter's colour capture relies on.
        for (const item of spec.items) {
          const [vx, vy] = viewport.convertToViewportPoint(item.xPt, spec.heightPt - item.topPt);
          const glyphs = item.glyphColors ?? [...item.str].map(() => item.color ?? null);
          const advance = glyphs.length > 0 ? (item.widthPt * viewport.scale) / glyphs.length : 0;
          for (let i = 0; i < glyphs.length; i += 1) {
            canvasContext.fillStyle = glyphs[i] ?? "#000000";
            canvasContext.fillText(item.str[i] ?? " ", vx + i * advance, vy);
          }
          canvasContext.fillStyle = "#000000";
        }
        for (const rect of spec.graphics ?? []) {
          canvasContext.fillStyle = rect.color ?? "#111111";
          canvasContext.fillRect(
            rect.leftPt * viewport.scale,
            rect.topPt * viewport.scale,
            rect.widthPt * viewport.scale,
            rect.heightPt * viewport.scale
          );
        }
      })(),
    }),
  };
}

async function convert(...pages: FakePageSpec[]): Promise<PdfToHtmlResult> {
  const built = pages.map(makePage);
  mockPdfDocument = {
    numPages: built.length,
    getPage: async (n: number) => built[n - 1],
  };
  const { convertPdfToHtml } = await import("@/lib/pdfToHtml");
  return convertPdfToHtml({ arrayBuffer: async () => new ArrayBuffer(8) } as unknown as File);
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

/** Text paragraphs of a page, in emitted order, excluding the blank spacers. */
function textParagraphs(doc: Document, pageIndex = 0) {
  const page = doc.querySelectorAll(".pdf-page")[pageIndex];
  return Array.from(page.querySelectorAll("p:not([data-blank-line])"));
}

/** Reads a numeric px value out of an inline style declaration. */
function px(el: Element, property: string): number {
  const match = new RegExp(`${property}:(-?[\\d.]+)px`).exec(el.getAttribute("style") ?? "");
  if (!match) throw new Error(`no ${property} in style: ${el.getAttribute("style")}`);
  return Number(match[1]);
}

/** A page 400pt wide, with one 12pt text run per entry. */
function pageWith(items: FakeItem[], overrides: Partial<FakePageSpec> = {}): FakePageSpec {
  return { widthPt: 400, heightPt: 600, items, ...overrides };
}

beforeAll(installFakeCanvas);
afterAll(restoreRealCanvas);
beforeEach(() => {
  failGetImageData = false;
});

describe("page shell", () => {
  it("emits one .pdf-page per page, indexed from zero", async () => {
    const { html } = await convert(
      pageWith([{ str: "First page", xPt: 40, topPt: 60, widthPt: 80 }]),
      pageWith([{ str: "Second page", xPt: 40, topPt: 60, widthPt: 80 }])
    );

    // Page identity drives every later placement: annotations, images and the
    // editor's own page navigation all key off data-page-index.
    const pages = parse(html).querySelectorAll(".pdf-page");
    expect(pages).toHaveLength(2);
    expect(pages[0].getAttribute("data-page-index")).toBe("0");
    expect(pages[1].getAttribute("data-page-index")).toBe("1");
    expect(pages[0].textContent).toContain("First page");
    expect(pages[1].textContent).toContain("Second page");
  });

  it("sizes the page from the scaled viewport, not from the raw PDF points", async () => {
    const { html } = await convert(pageWith([{ str: "Body", xPt: 40, topPt: 60, widthPt: 40 }]));

    // The converter renders at scale 1.5, so a 400x600pt page is 600x900 CSS
    // pixels. Emitting the point size instead would shrink every page to two
    // thirds while leaving the text laid out for the larger box.
    const page = parse(html).querySelector(".pdf-page")!;
    expect(px(page, "width")).toBe(400 * SCALE);
    expect(px(page, "min-height")).toBe(600 * SCALE);
  });

  it("reports no warnings for a page it could convert fully", async () => {
    const { warnings } = await convert(pageWith([{ str: "Body", xPt: 40, topPt: 60, widthPt: 40 }]));
    expect(warnings).toEqual([]);
  });
});

describe("text runs", () => {
  it("scales the glyph size out of the text matrix by the viewport scale", async () => {
    const { html } = await convert(
      pageWith([{ str: "Heading", xPt: 40, topPt: 60, widthPt: 90, sizePt: 24 }])
    );

    // Font size comes from the y column of the text matrix. Reading the x
    // column instead picks up the PDF's horizontal scaling factor, so a
    // condensed line would come back at the wrong size.
    const span = parse(html).querySelector(".pdf-page p span")!;
    expect(span.getAttribute("style")).toContain(`font-size:${(24 * SCALE).toFixed(1)}px`);
  });

  it("escapes markup characters in the extracted text", async () => {
    const { html } = await convert(
      pageWith([{ str: 'A < B & "C"', xPt: 40, topPt: 60, widthPt: 80 }])
    );

    // Contract text really does contain angle brackets and ampersands. Unescaped,
    // the "<" opens a tag and the rest of the paragraph disappears from the
    // editor.
    expect(html).toContain("A &lt; B &amp; &quot;C&quot;");
    expect(parse(html).querySelector(".pdf-page p")!.textContent).toBe('A < B & "C"');
  });

  it("flattens newlines and tabs inside a run to single spaces", async () => {
    const { html } = await convert(
      pageWith([{ str: "one\ttwo\nthree", xPt: 40, topPt: 60, widthPt: 100 }])
    );

    // Every paragraph is emitted with white-space:nowrap, so a literal tab or
    // newline would collapse to nothing and the words would run together.
    expect(parse(html).querySelector(".pdf-page p")!.textContent).toBe("one two three");
  });

  it("drops runs that are only whitespace but keeps the rest of the line", async () => {
    const { html } = await convert(
      pageWith([
        { str: "Kept", xPt: 40, topPt: 60, widthPt: 30 },
        { str: "   ", xPt: 80, topPt: 60, widthPt: 10 },
        { str: "Also kept", xPt: 100, topPt: 60, widthPt: 60 },
      ])
    );

    // Proven by the two surviving runs: the empty item is discarded, not the
    // whole line. A whitespace-only run carries no glyphs, and emitting it
    // would add an empty span that the gap logic then measures against.
    const spans = parse(html).querySelectorAll(".pdf-page p span:not([data-pdf-gap])");
    expect(Array.from(spans).map((s) => s.textContent)).toEqual(["Kept", "Also kept"]);
  });
});

describe("font resolution", () => {
  const at = (fontName: string): FakeItem => ({
    str: "Sample",
    fontName,
    xPt: 40,
    topPt: 60,
    widthPt: 60,
  });

  async function familyOf(spec: FakePageSpec): Promise<string> {
    const { html } = await convert(spec);
    const style = parse(html).querySelector(".pdf-page p span")!.getAttribute("style")!;
    return /font-family:([^;]+);/.exec(style)![1];
  }

  it.each([
    // Courier is what pleading line numbers and code exhibits are set in. Losing
    // the monospace fallback re-flows a numbered column into ragged text.
    ["maps a monospace face onto the monospace fallback stack", "Courier", "'Courier New', Courier, monospace"],
    ["maps a script face onto the cursive fallback stack", "Brush Script MT", "'Brush Script MT', cursive"],
    ["maps a serif face onto the serif fallback stack", "Times New Roman", "'Times New Roman', Times, serif"],
    ["maps a sans face onto the sans fallback stack", "Helvetica", "Arial, Helvetica, sans-serif"],
    // The font is embedded in the PDF, so naming it first gives the browser a
    // chance to use it. Discarding the name would set every unusual face in
    // Times.
    ["keeps an unrecognised face first and appends the serif fallback", "Aptos Display", "'Aptos Display', 'Times New Roman', Times, serif"],
    // Embedded fonts are named like ABCDEE+Calibri. Left in place, no rule
    // matches and every embedded font falls through to the serif default.
    ["strips the subset prefix a PDF puts on an embedded font name", "ABCDEE+Calibri", "'Calibri', Arial, Helvetica, sans-serif"],
  ])("%s", async (_label, fontFamily, expected) => {
    const family = await familyOf(pageWith([at("g_d0_f1")], { styles: { g_d0_f1: { fontFamily } } }));
    expect(family).toBe(expected);
  });

  it("falls back to the font object's fallbackName when the style record is silent", async () => {
    // Not every text item has a styles entry, and the font object is the only
    // other place the family is recorded.
    const family = await familyOf(
      pageWith([at("g_d0_f1")], { fonts: { g_d0_f1: { name: "Anon", fallbackName: "Georgia" } } })
    );
    expect(family).toBe("'Georgia', 'Times New Roman', Times, serif");
  });

  it("defaults to the serif stack when the font is named nowhere", async () => {
    const family = await familyOf(pageWith([at("")]));
    expect(family).toBe("'Times New Roman', Times, serif");
  });

  it("reads bold and italic from the PostScript name", async () => {
    // Weight and slant are encoded in the font name and nowhere else in the
    // text stream. Missing them flattens every heading and citation in the
    // imported document to regular.
    const { html } = await convert(
      pageWith(
        [
          { ...at("f1"), str: "Bold" },
          { ...at("f2"), str: "Italic", xPt: 200 },
          { ...at("f3"), str: "Plain", xPt: 300 },
        ],
        {
          fonts: {
            f1: { name: "ABCDEE+Calibri-Bold" },
            f2: { name: "ABCDEE+Calibri-Italic" },
            f3: { name: "ABCDEE+Calibri" },
          },
        }
      )
    );

    const styles = Array.from(
      parse(html).querySelectorAll(".pdf-page p span:not([data-pdf-gap])")
    ).map((s) => s.getAttribute("style")!);
    expect(styles[0]).toContain("font-weight:bold;");
    expect(styles[0]).not.toContain("font-style:italic;");
    expect(styles[1]).toContain("font-style:italic;");
    expect(styles[1]).not.toContain("font-weight:bold;");
    expect(styles[2]).not.toContain("font-weight:bold;");
    expect(styles[2]).not.toContain("font-style:italic;");
  });
});

describe("per-character colour", () => {
  it("splits a run at the exact character where the colour changes", async () => {
    const { html } = await convert(
      pageWith([
        {
          str: "REDblack",
          xPt: 40,
          topPt: 60,
          widthPt: 80,
          glyphColors: ["#ff0000", "#ff0000", "#ff0000", null, null, null, null, null],
        },
      ])
    );

    // A single colour for the whole run would repaint the black half red. This
    // is how a redlined clause or a coloured defined term survives the import.
    const spans = Array.from(parse(html).querySelectorAll(".pdf-page p span"));
    expect(spans.map((s) => s.textContent)).toEqual(["RED", "black"]);
    expect(spans[0].getAttribute("style")).toContain("color:#ff0000;");
    expect(spans[1].getAttribute("style")).not.toContain("color:");
  });

  it("emits no colour declaration for an entirely black run", async () => {
    // Proven by the span existing with its font styling intact: black is the
    // page default, and writing it out explicitly would defeat the editor's own
    // theming.
    const { html } = await convert(
      pageWith([{ str: "Ordinary", xPt: 40, topPt: 60, widthPt: 60 }])
    );

    const span = parse(html).querySelector(".pdf-page p span")!;
    expect(span.textContent).toBe("Ordinary");
    expect(span.getAttribute("style")).toContain("font-size:");
    expect(span.getAttribute("style")).not.toContain("color:");
  });

  it("maps colour proportionally when the renderer draws fewer glyphs than characters", async () => {
    // Ligatures and kerned pairs draw one glyph for several characters, so the
    // one-to-one index mapping does not apply. Without the proportional
    // fallback the last characters would read past the end of the glyph list.
    const { html } = await convert(
      pageWith([
        { str: "abcd", xPt: 40, topPt: 60, widthPt: 40, glyphColors: ["#00ff00", null] },
      ])
    );

    const spans = Array.from(parse(html).querySelectorAll(".pdf-page p span"));
    expect(spans.map((s) => s.textContent)).toEqual(["ab", "cd"]);
    expect(spans[0].getAttribute("style")).toContain("color:#00ff00;");
  });
});

describe("horizontal gaps between runs", () => {
  /** Emitted text of the single paragraph produced by two runs `gapPt` apart. */
  async function lineText(first: FakeItem, gapPt: number, second: Omit<FakeItem, "xPt">) {
    const { html } = await convert(
      pageWith([first, { ...second, xPt: first.xPt + first.widthPt + gapPt }])
    );
    return parse(html).querySelector(".pdf-page p")!.textContent!;
  }

  const run = (str: string, xPt: number, widthPt: number): FakeItem => ({
    str,
    xPt,
    topPt: 60,
    widthPt,
  });

  it.each([
    // PDF producers split a single word into several positioned runs. Treating
    // that positioning as a space breaks the word in the editor and in search.
    ["inserts nothing for a kerning-sized gap", run("Agree", 40, 30), 1, "ment", 24, "Agreement"],
    // A synthetic gap span here would stop the paragraph re-wrapping, because
    // the fixed-width element cannot break (the spacer is ruled out below).
    ["inserts a real space for an ordinary word gap", run("Hello", 40, 30), 4, "world", 30, "Hello world"],
    // Phone numbers and hyphenated names arrive split around the dash with
    // generous positioning. A space there turns "555-1234" into two tokens.
    ["keeps a dash-connected pair together across a wider gap", run("555-", 40, 24), 4, "1234", 24, "555-1234"],
    // Split numbers are the usual shape of a currency amount or a docket
    // number. "12 345" reads as two values.
    ["keeps adjacent digits together across a wider gap", run("12", 40, 12), 3.4, "345", 18, "12345"],
    ["keeps trailing punctuation attached to the word before it", run("Company", 40, 45), 2.9, ",", 4, "Company,"],
    // Overprinted runs (bold simulated by drawing twice) produce a zero or
    // negative gap. A space there duplicates the word with a gap in it.
    ["inserts nothing when two runs abut", run("Over", 40, 24), 0, "lap", 18, "Overlap"],
    ["inserts nothing when two runs overlap", run("Over", 40, 24), -2, "lap", 18, "Overlap"],
  ])("%s", async (_label, first, gapPt, str, widthPt, expected) => {
    expect(await lineText(first, gapPt, { str, topPt: 60, widthPt })).toBe(expected);
  });

  it("does not render an ordinary word gap as a fixed-width spacer", async () => {
    const { html } = await convert(
      pageWith([run("Hello", 40, 30), { str: "world", xPt: 74, topPt: 60, widthPt: 30 }])
    );
    expect(html).not.toContain("data-pdf-gap");
  });

  it("renders a column-sized gap as a fixed-width spacer", async () => {
    // Table columns and signature blocks are positioned with large gaps. A
    // single space collapses them and the columns lose their alignment.
    const { html } = await convert(
      pageWith([run("Name", 40, 30), { str: "Signature", xPt: 200, topPt: 60, widthPt: 60 }])
    );

    const spacer = parse(html).querySelector("[data-pdf-gap]")!;
    // 200pt - (40 + 30)pt is 130pt of gap, scaled by 1.5.
    expect(spacer.getAttribute("style")).toContain(`width:${(130 * SCALE).toFixed(1)}px`);
  });
});

describe("line assembly", () => {
  it("joins runs on the same baseline and orders them left to right", async () => {
    const { html } = await convert(
      pageWith([
        { str: "third", xPt: 113, topPt: 60, widthPt: 30 },
        { str: "first", xPt: 40, topPt: 60, widthPt: 30 },
        { str: "second", xPt: 74, topPt: 60, widthPt: 35 },
      ])
    );

    // Text items arrive in the PDF's drawing order, which is not reading order.
    // Emitting them as drawn scrambles the sentence.
    const paragraphs = textParagraphs(parse(html));
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0].textContent).toBe("first second third");
  });

  it("splits runs onto separate lines once they are more than 3px apart", async () => {
    // 2pt of separation is 3px after scaling, which is the tolerance boundary.
    // Too loose and superscripts merge into the baseline; too tight and a line
    // shatters into one paragraph per run.
    const { html } = await convert(
      pageWith([
        { str: "upper", xPt: 40, topPt: 60, widthPt: 30 },
        { str: "lower", xPt: 40, topPt: 63, widthPt: 30 },
      ])
    );

    const paragraphs = textParagraphs(parse(html));
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs.map((p) => p.textContent)).toEqual(["upper", "lower"]);
  });

  it("emits lines in top-to-bottom order regardless of drawing order", async () => {
    const { html } = await convert(
      pageWith([
        { str: "bottom", xPt: 40, topPt: 200, widthPt: 40 },
        { str: "top", xPt: 40, topPt: 60, widthPt: 40 },
        { str: "middle", xPt: 40, topPt: 130, widthPt: 40 },
      ])
    );

    const paragraphs = textParagraphs(parse(html));
    expect(paragraphs.map((p) => p.textContent)).toEqual(["top", "middle", "bottom"]);
    for (let i = 1; i < paragraphs.length; i += 1) {
      expect(px(paragraphs[i], "top")).toBeGreaterThan(px(paragraphs[i - 1], "top"));
    }
  });

  it("places a paragraph a full line height above its baseline", async () => {
    // The PDF gives a baseline; CSS positions from the top of the box. Using
    // the baseline directly drops every line by its own height and the first
    // line of a page lands below its heading.
    const { html } = await convert(
      pageWith([{ str: "Body", xPt: 40, topPt: 100, widthPt: 40, sizePt: 20 }])
    );

    const paragraph = textParagraphs(parse(html))[0];
    expect(px(paragraph, "top")).toBeCloseTo(100 * SCALE - 20 * SCALE, 1);
    expect(px(paragraph, "left")).toBeCloseTo(40 * SCALE, 1);
  });
});

describe("paragraph grouping", () => {
  /** Four stacked full-width lines, 20pt apart, that should read as one paragraph. */
  const wrappedBody: FakeItem[] = [0, 1, 2, 3].map((n) => ({
    str: `wrapped line ${n}`,
    xPt: 40,
    topPt: 100 + n * 20,
    widthPt: 320,
  }));

  /** Three short stacked lines, 20pt apart, the shape of an address block. */
  const addressBlock: FakeItem[] = [
    { str: "Jane Smith", xPt: 40, topPt: 100, widthPt: 50 },
    { str: "1 Main Street", xPt: 40, topPt: 120, widthPt: 55 },
    { str: "Springfield", xPt: 40, topPt: 140, widthPt: 45 },
  ];

  it("chains consecutive full-width lines into one flow group", async () => {
    const { html } = await convert(pageWith(wrappedBody));

    // The flow group is what lets the editor re-wrap a paragraph. Each line in
    // its own group means editing the first line pushes text off the page
    // instead of reflowing into the next.
    const groups = textParagraphs(parse(html)).map((p) => p.getAttribute("data-flow-group"));
    expect(groups).toHaveLength(4);
    expect(new Set(groups).size).toBe(1);
  });

  it("starts a new flow group at a bullet even when spacing says continuation", async () => {
    const { html } = await convert(
      pageWith([
        ...wrappedBody,
        { str: "• first item", xPt: 40, topPt: 180, widthPt: 320 },
        { str: "• second item", xPt: 40, topPt: 200, widthPt: 320 },
      ])
    );

    // Bullets sit at the same left edge and the same line spacing as body text,
    // so every other signal says "continuation". Merging them makes the whole
    // list one paragraph that collapses to a single bullet when edited.
    const paragraphs = textParagraphs(parse(html));
    const bullets = paragraphs.filter((p) => p.textContent!.startsWith("•"));
    expect(bullets).toHaveLength(2);
    expect(bullets[0].getAttribute("data-flow-group"))
      .not.toBe(paragraphs[0].getAttribute("data-flow-group"));
    expect(bullets[1].getAttribute("data-flow-group"))
      .not.toBe(bullets[0].getAttribute("data-flow-group"));
  });

  it("starts a new flow group when the font size changes", async () => {
    // A heading immediately above its paragraph shares the left edge and the
    // spacing. Only the size distinguishes them, and chaining them makes the
    // heading re-wrap as body text.
    const { html } = await convert(
      pageWith([
        { str: "A heading across the page", xPt: 40, topPt: 100, widthPt: 320, sizePt: 24 },
        { str: "Body text across the page", xPt: 40, topPt: 120, widthPt: 320, sizePt: 12 },
      ])
    );

    const paragraphs = textParagraphs(parse(html));
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].getAttribute("data-flow-group"))
      .not.toBe(paragraphs[1].getAttribute("data-flow-group"));
  });

  it("keeps a stack of short lines as separate paragraphs", async () => {
    // An address or signature block is short lines at one left edge with normal
    // line spacing, so alignment and spacing both say "continuation". Only the
    // fact that no line reaches the right margin says otherwise. Chained, the
    // block re-wraps to full width in the editor and the address becomes one
    // run-on line.
    const { html } = await convert(pageWith(addressBlock));

    const paragraphs = textParagraphs(parse(html));
    expect(paragraphs.map((p) => p.textContent))
      .toEqual(["Jane Smith", "1 Main Street", "Springfield"]);
    const groups = paragraphs.map((p) => p.getAttribute("data-flow-group"));
    expect(new Set(groups).size).toBe(3);
  });

  it("namespaces flow groups per page", async () => {
    // Group ids are the editor's handle on a paragraph. Colliding ids across
    // pages make an edit on page two rewrite a paragraph on page one.
    const { html } = await convert(
      pageWith([{ str: "Page one text", xPt: 40, topPt: 100, widthPt: 320 }]),
      pageWith([{ str: "Page two text", xPt: 40, topPt: 100, widthPt: 320 }])
    );

    const doc = parse(html);
    const first = textParagraphs(doc, 0)[0].getAttribute("data-flow-group");
    const second = textParagraphs(doc, 1)[0].getAttribute("data-flow-group");
    expect(first).not.toBe(second);
    expect(first).toContain("_1_");
    expect(second).toContain("_2_");
  });

  it("inserts a clickable blank paragraph across an unusually large vertical gap", async () => {
    const { html } = await convert(
      pageWith([
        ...wrappedBody,
        { str: "Paragraph two, after a blank line", xPt: 40, topPt: 240, widthPt: 320 },
      ])
    );

    // Without a node in the whitespace there is nowhere to put the caret, so a
    // user cannot type between two paragraphs of an imported document.
    const page = parse(html).querySelector(".pdf-page")!;
    const blanks = page.querySelectorAll("p[data-blank-line]");
    expect(blanks).toHaveLength(1);
    const blankTop = px(blanks[0], "top");
    const paragraphs = textParagraphs(parse(html));
    expect(blankTop).toBeGreaterThan(px(paragraphs[3], "top"));
    expect(blankTop).toBeLessThan(px(paragraphs[4], "top"));
  });

  it("adds no blank paragraph between evenly spaced lines of different groups", async () => {
    // Proven by the three paragraphs that are emitted in three separate groups:
    // the group transitions the blank-line rule looks at really do occur here,
    // and it still declines to add a spacer. Firing on every group change would
    // double the height of an address block.
    const { html } = await convert(pageWith(addressBlock));

    const page = parse(html).querySelector(".pdf-page")!;
    const paragraphs = textParagraphs(parse(html));
    expect(paragraphs).toHaveLength(3);
    expect(new Set(paragraphs.map((p) => p.getAttribute("data-flow-group"))).size).toBe(3);
    expect(page.querySelectorAll("p[data-blank-line]")).toHaveLength(0);
  });
});

describe("alignment detection", () => {
  /** Full-width body lines that establish the page's text column. */
  const column: FakeItem[] = [0, 1, 2].map((n) => ({
    str: `body line ${n} running the full width of the column`,
    xPt: 40,
    topPt: 100 + n * 20,
    widthPt: 320,
  }));

  it("records the detected text column on the page element", async () => {
    const { html } = await convert(pageWith(column));

    // The column bounds are what the editor re-wraps against. Measured from
    // the whole page instead of the body text, every paragraph would stretch
    // into the margins.
    const page = parse(html).querySelector(".pdf-page")!;
    expect(Number(page.getAttribute("data-column-left"))).toBeCloseTo(40 * SCALE, 1);
    expect(Number(page.getAttribute("data-column-right"))).toBeCloseTo(360 * SCALE, 1);
    expect(Number(page.getAttribute("data-column-width"))).toBeCloseTo(320 * SCALE, 1);
  });

  it("centres a short line whose midpoint sits on the column centre", async () => {
    const { html } = await convert(
      pageWith([
        // Midpoint at 200pt, which is the centre of the 40..360 column.
        { str: "CENTRED TITLE", xPt: 160, topPt: 40, widthPt: 80 },
        ...column,
      ])
    );

    // A centred heading has to be anchored to the column and told to centre,
    // not left at its measured x: once wrapping is enabled a left-anchored
    // heading drifts off centre.
    const title = textParagraphs(parse(html))[0];
    expect(title.textContent).toBe("CENTRED TITLE");
    expect(title.getAttribute("style")).toContain("text-align:center;");
    expect(px(title, "left")).toBeCloseTo(40 * SCALE, 1);
    expect(px(title, "width")).toBeCloseTo(320 * SCALE, 1);
  });

  it("right-aligns a line that ends on the column right edge", async () => {
    const { html } = await convert(
      pageWith([
        { str: "31 December 2026", xPt: 260, topPt: 40, widthPt: 100 },
        ...column,
      ])
    );

    const dateLine = textParagraphs(parse(html))[0];
    expect(dateLine.textContent).toBe("31 December 2026");
    expect(dateLine.getAttribute("style")).toContain("text-align:right;");
    expect(px(dateLine, "left")).toBeCloseTo(40 * SCALE, 1);
  });

  it("leaves body text left-aligned and anchored at its own x", async () => {
    const { html } = await convert(pageWith(column));

    // Left is the default and must stay positional. Anchoring left-aligned text
    // to the column would discard every indent in the document.
    const body = textParagraphs(parse(html))[0];
    expect(body.getAttribute("style")).not.toContain("text-align:");
    expect(px(body, "left")).toBeCloseTo(40 * SCALE, 1);
  });

  it("does not align a fragment narrow enough to sit anywhere", async () => {
    // A lone colon in a pleading caption is narrow enough that its midpoint
    // lands near the column centre by accident. Centring it re-anchors it to
    // the column and it visibly jumps out of the caption.
    const { html } = await convert(
      pageWith([
        { str: ":", xPt: 199, topPt: 40, widthPt: 3 },
        ...column,
      ])
    );

    const fragment = textParagraphs(parse(html))[0];
    expect(fragment.textContent).toBe(":");
    expect(fragment.getAttribute("style")).not.toContain("text-align:");
    expect(px(fragment, "left")).toBeCloseTo(199 * SCALE, 1);
  });
});

describe("link annotations", () => {
  it("overlays a link rectangle as an anchor in viewport coordinates", async () => {
    const { html } = await convert(
      pageWith([{ str: "our website", xPt: 40, topPt: 100, widthPt: 60 }], {
        annotations: [
          // A PDF rect is [x1, y1, x2, y2] with y measured from the bottom.
          { subtype: "Link", url: "https://example.com/terms", rect: [40, 480, 140, 500] },
        ],
      })
    );

    // The anchor is what makes an imported link clickable. Getting the y flip
    // wrong puts the hit area at the mirror position on the page, so clicking
    // the link does nothing and clicking elsewhere navigates.
    const anchor = parse(html).querySelector(".pdf-page a")!;
    expect(anchor.getAttribute("href")).toBe("https://example.com/terms");
    expect(anchor.getAttribute("rel")).toBe("noopener noreferrer");
    expect(px(anchor, "left")).toBeCloseTo(40 * SCALE, 1);
    expect(px(anchor, "top")).toBeCloseTo(100 * SCALE, 1);
    expect(px(anchor, "width")).toBeCloseTo(100 * SCALE, 1);
    expect(px(anchor, "height")).toBeCloseTo(20 * SCALE, 1);
  });

  it("escapes the url so a crafted link cannot break out of the attribute", async () => {
    const { html } = await convert(
      pageWith([{ str: "click", xPt: 40, topPt: 100, widthPt: 30 }], {
        annotations: [
          {
            subtype: "Link",
            url: 'https://example.com/?a="><img src=x onerror=alert(1)>',
            rect: [40, 480, 140, 500],
          },
        ],
      })
    );

    // The url comes from an uploaded file. Unescaped, the quote closes href and
    // the rest becomes live markup inside the template editor.
    const doc = parse(html);
    expect(doc.querySelectorAll(".pdf-page img")).toHaveLength(0);
    expect(doc.querySelector(".pdf-page a")!.getAttribute("href"))
      .toBe('https://example.com/?a="><img src=x onerror=alert(1)>');
  });

  it("reads the unsafeUrl when the resolved url is missing", async () => {
    const { html } = await convert(
      pageWith([{ str: "click", xPt: 40, topPt: 100, widthPt: 30 }], {
        annotations: [{ subtype: "Link", unsafeUrl: "mailto:clerk@example.com", rect: [40, 480, 140, 500] }],
      })
    );

    // pdfjs only populates `url` for schemes it considers safe, so mailto and
    // tel links arrive as unsafeUrl and would otherwise be dropped.
    expect(parse(html).querySelector(".pdf-page a")!.getAttribute("href"))
      .toBe("mailto:clerk@example.com");
  });

  it("ignores annotations that are not links or that carry no destination", async () => {
    // Proven live by the third annotation, which does produce an anchor: the
    // two that produce none are being filtered, not silently lost with the
    // rest. A widget annotation rendered as an anchor puts an invisible
    // clickable box over the text.
    const { html } = await convert(
      pageWith([{ str: "text", xPt: 40, topPt: 100, widthPt: 30 }], {
        annotations: [
          { subtype: "Widget", url: "https://example.com/widget", rect: [40, 480, 140, 500] },
          { subtype: "Link", rect: [40, 440, 140, 460] },
          { subtype: "Link", url: "https://example.com/real", rect: [40, 400, 140, 420] },
        ],
      })
    );

    const anchors = parse(html).querySelectorAll(".pdf-page a");
    expect(anchors).toHaveLength(1);
    expect(anchors[0].getAttribute("href")).toBe("https://example.com/real");
  });

  it("survives a page whose annotations cannot be read", async () => {
    // getAnnotations throws on malformed files. A page of text is still worth
    // importing without its links.
    const spec = pageWith([{ str: "Body text", xPt: 40, topPt: 100, widthPt: 60 }]);
    const page = makePage(spec) as Record<string, unknown>;
    page.getAnnotations = async () => {
      throw new Error("broken annotation table");
    };
    mockPdfDocument = { numPages: 1, getPage: async () => page };
    const { convertPdfToHtml } = await import("@/lib/pdfToHtml");

    const { html, warnings } = await convertPdfToHtml({
      arrayBuffer: async () => new ArrayBuffer(8),
    } as unknown as File);

    expect(parse(html).querySelector(".pdf-page")!.textContent).toContain("Body text");
    expect(warnings).toEqual([]);
  });
});

describe("graphics layer", () => {
  /** A small page keeps the pixel scan cheap while still exercising it. */
  const smallPage = (items: FakeItem[], graphics: FakeRect[]): FakePageSpec => ({
    widthPt: 200,
    heightPt: 150,
    items,
    graphics,
  });

  it("emits an editable image object for painted artwork", async () => {
    const { html } = await convert(
      smallPage(
        [{ str: "Signed", xPt: 20, topPt: 20, widthPt: 40 }],
        [{ leftPt: 20, topPt: 60, widthPt: 40, heightPt: 20 }]
      )
    );

    // Artwork imported as one flat page background cannot be moved or deleted.
    // Extracting it as its own object is what makes a scanned signature
    // editable.
    const object = parse(html).querySelector("[data-template-image-object-id]")!;
    expect(object.getAttribute("data-template-image-object-id")).toBe("pdf_graphic_0_0");
    expect(px(object, "left")).toBeGreaterThanOrEqual(20 * SCALE - 4);
    expect(px(object, "left")).toBeLessThanOrEqual(20 * SCALE);
    expect(px(object, "width")).toBeGreaterThanOrEqual(40 * SCALE);
    expect(object.querySelector("img")!.getAttribute("data-template-file-name"))
      .toBe("pdf-graphic-1-1.png");
  });

  it("emits a separator rule rather than an image for a page-wide hairline", async () => {
    const { html } = await convert(
      smallPage(
        [{ str: "Above", xPt: 20, topPt: 20, widthPt: 40 }],
        [{ leftPt: 10, topPt: 80, widthPt: 180, heightPt: 1 }]
      )
    );

    // A horizontal rule imported as a bitmap cannot be restyled and prints
    // fuzzy. Recognising it as a rule keeps it a real separator.
    const doc = parse(html);
    const rule = doc.querySelector("[data-template-separator-rule-id]")!;
    expect(rule.getAttribute("data-template-separator-rule-id")).toBe("pdf_rule_0_0");
    expect(px(rule, "width")).toBeGreaterThanOrEqual(180 * SCALE);
    expect(doc.querySelectorAll("[data-template-image-object-id]")).toHaveLength(0);
  });

  it("places a page-filling graphic behind the text and a small one in front", async () => {
    const { html } = await convert(
      smallPage(
        [{ str: "Body", xPt: 20, topPt: 20, widthPt: 30 }],
        [
          { leftPt: 10, topPt: 60, widthPt: 180, heightPt: 80 },
          { leftPt: 20, topPt: 20, widthPt: 16, heightPt: 8 },
        ]
      )
    );

    // A watermark drawn over the text hides it. The z-order decision is what
    // keeps an imported letterhead or watermark readable underneath.
    const objects = Array.from(parse(html).querySelectorAll("[data-template-image-object-id]"));
    const flags = objects.map((o) => o.getAttribute("data-template-image-behind-text"));
    expect(objects).toHaveLength(2);
    expect(flags).toContain("true");
    expect(flags).toContain("false");
    const behind = objects.find((o) => o.getAttribute("data-template-image-behind-text") === "true")!;
    expect(px(behind, "width")).toBeGreaterThan(px(behind, "height"));
    expect(px(behind, "width")).toBeGreaterThanOrEqual(180 * SCALE);
  });

  it("leaves a text-only page free of graphics elements", async () => {
    // Proven live by the paragraph that is emitted: the page converted, and it
    // still has no artwork. An empty transparent image on every text page
    // covers the text and blocks the caret.
    const { html } = await convert(smallPage([{ str: "Only text", xPt: 20, topPt: 20, widthPt: 40 }], []));

    const doc = parse(html);
    expect(textParagraphs(doc)[0].textContent).toBe("Only text");
    expect(doc.querySelectorAll("[data-template-image-object-id]")).toHaveLength(0);
    expect(doc.querySelectorAll("img")).toHaveLength(0);
  });

  it("keeps the artwork as a flat background and warns when pixels cannot be read", async () => {
    failGetImageData = true;

    const { html, warnings } = await convert(
      smallPage(
        [{ str: "Signed", xPt: 20, topPt: 20, widthPt: 40 }],
        [{ leftPt: 20, topPt: 60, widthPt: 40, heightPt: 20 }]
      )
    );

    // Losing pixel access must not lose the artwork. Falling back to a single
    // background image keeps the page looking right, and the warning is what
    // tells the user why the logo is not draggable.
    const doc = parse(html);
    expect(doc.querySelector("img.pdf-page-background")).not.toBeNull();
    expect(doc.querySelectorAll("[data-template-image-object-id]")).toHaveLength(0);
    expect(warnings).toEqual([
      "Page 1: Graphics could not be extracted as editable objects and were imported as a single background layer.",
    ]);
    expect(textParagraphs(doc)[0].textContent).toBe("Signed");
  });

  it("drops an icon glyph once there is artwork to carry it", async () => {
    // A dingbat glyph is a picture drawn as text. With the graphics layer
    // present it is already in the extracted image, so keeping it too renders
    // the icon twice.
    const { html } = await convert(
      smallPage(
        [
          { str: "✆", fontName: "f1", xPt: 20, topPt: 30, widthPt: 8 },
          { str: "Contact us", xPt: 40, topPt: 30, widthPt: 50 },
        ],
        [{ leftPt: 20, topPt: 60, widthPt: 40, heightPt: 20 }]
      )
    );

    const doc = parse(html);
    expect(doc.querySelector(".pdf-page")!.textContent).toContain("Contact us");
    expect(doc.querySelector(".pdf-page")!.textContent).not.toContain("✆");
  });
});
