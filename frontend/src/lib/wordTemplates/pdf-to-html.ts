 
"use client";

// Client-side PDF → HTML conversion using pdfjs in the browser.
// Ported verbatim from PORTAL_paralegix_reference/frontend/src/lib/pdfToHtml.ts;
// the `any`s match the upstream pdfjs API surface, which is dynamic.

const SANS_FALLBACK = "Arial, Helvetica, sans-serif";
const SERIF_FALLBACK = "'Times New Roman', Times, serif";
const MONO_FALLBACK = "'Courier New', Courier, monospace";
const CURSIVE_FALLBACK = "'Brush Script MT', cursive";

// Characters commonly used as list bullets in PDFs. These must be preserved as
// text rather than being filtered out as icon glyphs, so the template editor
// can detect and continue bullet lists on Enter.
const BULLET_CHARS = new Set([
  "\u2022", // •  bullet
  "\u2023", // ‣  triangular bullet
  "\u25E6", // ◦  white bullet
  "\u2043", // ⁃  hyphen bullet
  "\u2219", // ∙  bullet operator
  "\u25AA", // ▪  black small square
  "\u25AB", // ▫  white small square
  "\u25B8", // ▸  black right-pointing small triangle
  "\u25B9", // ▹  white right-pointing small triangle
  "\u25CF", // ●  black circle
  "\u25CB", // ○  white circle
  "\u25A0", // ■  black square
  "\u25A1", // □  white square
  "\u2013", // –  en dash (often used as bullet)
  "\u2014", // em dash
  "\u2012", // ‒  figure dash
]);

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Allowlist link-annotation schemes. A malicious PDF can carry a Link
// annotation with a `javascript:` / `data:text/html` URL (pdfjs surfaces
// these via ann.unsafeUrl); escapeHtml does NOT validate the scheme, so such
// a URL would become a clickable anchor that runs attacker JS in the app
// origin when a firm user opens the template. Permit only http(s)/mailto.
function safeLinkUrl(url: string): string | null {
  const trimmed = url.trim();
  return /^(https?:|mailto:)/i.test(trimmed) ? trimmed : null;
}

function isBoldByName(str: string): boolean {
  return /bold|black|heavy|demi/i.test(str.replace(/^[A-Z]{6}\+/, ""));
}

function isItalicByName(str: string): boolean {
  return /italic|oblique|slanted/i.test(str.replace(/^[A-Z]{6}\+/, ""));
}

function isBlackColor(color: string): boolean {
  const c = color.trim().toLowerCase();
  return (
    c === "#000" || c === "#000000" ||
    c === "rgb(0, 0, 0)" || c === "rgba(0, 0, 0, 1)"
  );
}

function isLikelyIconGlyph(str: string, fontName?: string): boolean {
  const trimmed = str.trim();
  if (trimmed.length === 0 || trimmed.length > 2) return false;

  // Font name hints for icon/symbol fonts
  if (fontName) {
    const fn = normalizePdfFontName(fontName).toLowerCase();
    if (/symbol|icon|dingbat|wingding|webding|zapf|emoji|glyph|pictograph/.test(fn)) {
      return true;
    }
  }

  // Check if all characters fall in icon/symbol Unicode ranges
  for (const ch of trimmed) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0xE000 && code <= 0xF8FF) continue;  // Private Use Area
    if (code >= 0x2600 && code <= 0x26FF) continue;  // Misc Symbols
    if (code >= 0x2700 && code <= 0x27BF) continue;  // Dingbats
    if (code >= 0x25A0 && code <= 0x25FF) continue;  // Geometric Shapes
    if (code >= 0x2300 && code <= 0x23FF) continue;  // Misc Technical
    if (code >= 0x1F000) continue;                    // Supplementary symbols/emoji
    return false;
  }
  return true;
}

export type PdfToHtmlResult = {
  html: string;
  warnings: string[];
  /**
   * Names of the AcroForm fields on the source PDF, if any.
   *
   * This conversion CANNOT carry them: the annotation loop below keeps only
   * Link subtypes, and the ruled lines a form draws around its fields are
   * vector ops that getTextContent() never returns. A fillable PDF therefore
   * arrives as bare labels over an empty page. Reporting the fields lets the
   * caller refuse the import and say why (see import-guards.ts) instead of
   * presenting the wreckage as a successful conversion.
   */
  formFieldNames: string[];
};

export function shouldSkipPdfTextItem(
  str: string,
  fontName?: string,
  hasGraphicsLayer = false
): boolean {
  if (!hasGraphicsLayer) return false;

  const trimmed = str.trim();
  if (!trimmed) return false;

  for (const ch of trimmed) {
    if (BULLET_CHARS.has(ch)) return false;
  }

  return isLikelyIconGlyph(trimmed, fontName);
}

function normalizePdfFontName(fontFamily?: string): string {
  return (fontFamily ?? "")
    .trim()
    .replace(/^[A-Z]{6}\+/, "")
    .split(",")[0]
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function quoteFontFamily(name: string): string {
  const sanitized = name.replace(/['"]/g, "").trim();
  return sanitized ? `'${sanitized}'` : "";
}

function buildFontStack(preferred: string, fallback: string): string {
  const normalizedPreferred = preferred.toLowerCase();
  if (!normalizedPreferred) return fallback;
  if (fallback.toLowerCase().includes(normalizedPreferred)) return fallback;

  const quoted = quoteFontFamily(preferred);
  return quoted ? `${quoted}, ${fallback}` : fallback;
}

function resolvePdfFontFamily(fontFamily?: string): string {
  const cleaned = normalizePdfFontName(fontFamily);
  const normalized = cleaned.toLowerCase();

  if (!normalized) return SERIF_FALLBACK;

  if (
    normalized.includes("courier") ||
    normalized.includes("mono") ||
    normalized.includes("consolas") ||
    normalized.includes("menlo") ||
    normalized.includes("monaco") ||
    normalized.includes("lucida console") ||
    normalized.includes("typewriter")
  ) {
    return buildFontStack(cleaned, MONO_FALLBACK);
  }

  if (
    normalized.includes("brush script") ||
    normalized.includes("comic sans") ||
    normalized.includes("script") ||
    normalized.includes("cursive") ||
    normalized.includes("hand")
  ) {
    return buildFontStack(cleaned, CURSIVE_FALLBACK);
  }

  if (
    normalized.includes("times") ||
    normalized.includes("serif") ||
    normalized.includes("roman") ||
    normalized.includes("cambria") ||
    normalized.includes("georgia") ||
    normalized.includes("garamond") ||
    normalized.includes("palatino") ||
    normalized.includes("book antiqua") ||
    normalized.includes("didot") ||
    normalized.includes("bodoni") ||
    normalized.includes("baskerville")
  ) {
    return buildFontStack(cleaned, SERIF_FALLBACK);
  }

  if (
    normalized.includes("arial") ||
    normalized.includes("helvetica") ||
    normalized.includes("sans") ||
    normalized.includes("calibri") ||
    normalized.includes("verdana") ||
    normalized.includes("tahoma") ||
    normalized.includes("trebuchet") ||
    normalized.includes("futura") ||
    normalized.includes("optima") ||
    normalized.includes("avenir") ||
    normalized.includes("gill sans") ||
    normalized.includes("segoe") ||
    normalized.includes("frutiger") ||
    normalized.includes("univers")
  ) {
    return buildFontStack(cleaned, SANS_FALLBACK);
  }

  return buildFontStack(cleaned, SERIF_FALLBACK);
}

function renderHorizontalGap(
  gap: number,
  fontSize: number,
  prevText?: string,
  curText?: string
): string {
  if (gap <= 0.5) return "";

  // Use content-aware thresholds: PDF extractors often split a single token
  // into multiple items with positioning gaps that look like word spaces but
  // are really kerning.  Dash-connected tokens (phone numbers, compounds),
  // adjacent digits, and short fragments get a more generous threshold before
  // a space is inserted.
  const prevEnd = prevText?.slice(-1) ?? "";
  const curStart = curText?.[0] ?? "";
  const prevLen = prevText?.length ?? 0;
  const curLen = curText?.length ?? 0;

  let kerningMax: number;
  if (/[-\u2013\u2014]/.test(prevEnd) || /[-\u2013\u2014]/.test(curStart)) {
    // Dash-connected tokens (phone numbers, hyphenated words)
    kerningMax = Math.max(4, fontSize * 0.35);
  } else if (/\d/.test(prevEnd) && /\d/.test(curStart)) {
    // Adjacent digits, likely a split number
    kerningMax = Math.max(3.5, fontSize * 0.3);
  } else if (curLen === 1 && /[,.:;]/.test(curStart)) {
    // Single punctuation mark, almost always attached to previous token
    kerningMax = Math.max(3, fontSize * 0.25);
  } else if (prevLen === 1 || curLen === 1) {
    // Single-character fragment, likely a split word part
    kerningMax = Math.max(2.5, fontSize * 0.2);
  } else {
    kerningMax = Math.max(2, fontSize * 0.15);
  }

  if (gap <= kerningMax) return "";

  // Normal word gaps should stay as a real space so wrapped paragraphs can
  // reflow naturally in the editor. Reserve synthetic gap spans for unusually
  // large gaps that behave more like tabs/columns than word spacing.
  if (gap <= Math.max(6, fontSize * 0.6)) {
    return " ";
  }

  return `<span data-pdf-gap="true" style="display:inline-block;width:${gap.toFixed(1)}px;">\u00A0</span>`;
}

function renderStyledCharacters(
  text: string,
  style: { fontFamily: string; fontSize: number; bold: boolean; italic: boolean },
  colorSpans: ColorSpan[]
): string {
  let colorSpanIndex = 0;
  let html = "";

  for (let i = 0; i < text.length; i++) {
    while (colorSpanIndex < colorSpans.length - 1 && i >= colorSpans[colorSpanIndex].end) {
      colorSpanIndex += 1;
    }

    const color = colorSpans[colorSpanIndex]?.color ?? null;
    let inlineStyle = `font-family:${style.fontFamily};font-size:${style.fontSize.toFixed(1)}px;`;
    if (style.bold) inlineStyle += "font-weight:bold;";
    if (style.italic) inlineStyle += "font-style:italic;";
    if (color) inlineStyle += `color:${color};`;

    html += `<span style="${inlineStyle}">${escapeHtml(text[i])}</span>`;
  }

  return html;
}

type ColorSpan = { start: number; end: number; color: string | null };

// Build bold/italic maps and a per-character color event log for a page.
//
// Color approach: intercept every ctx.fillText call during a canvas render.
// pdfjs renders text character-by-character (setTransform → fillText(char,0,0)),
// so we record one event per character with its exact canvas position and color.
// This lets us do a direct 1:1 character-index → color mapping, no proportional
// approximation needed.
async function buildFontMap(
   
  page: any,
  textFontNames: string[],
  textStyles: Record<string, { fontFamily?: string }>
): Promise<{
  boldMap: Record<string, boolean>;
  italicMap: Record<string, boolean>;
  fontFamilyMap: Record<string, string>;
  // Returns color spans for a text item, splitting at exact color boundaries.
  getItemColorSpans: (pdfX: number, pdfY: number, pdfWidth: number, charCount: number) => ColorSpan[];
}> {
  const boldMap: Record<string, boolean> = {};
  const italicMap: Record<string, boolean> = {};
  const fontFamilyMap: Record<string, string> = {};

  // Scale 1.0 → 1 canvas pixel = 1 PDF unit, giving character-level precision.
   
  const tinyViewport = page.getViewport({ scale: 1.0 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(tinyViewport.width));
  canvas.height = Math.max(1, Math.ceil(tinyViewport.height));
  const ctx = canvas.getContext("2d")!;

  // All fillText events grouped by rounded canvas-y.
  // Each entry: { cx: rounded canvas x, color: non-black fill color or null }.
  const charEventsByCy = new Map<number, Array<{ cx: number; color: string | null }>>();

  const fillStyleProtoDesc = Object.getOwnPropertyDescriptor(
    CanvasRenderingContext2D.prototype, "fillStyle"
  );
  const origFillText = CanvasRenderingContext2D.prototype.fillText;
  const origRestore = CanvasRenderingContext2D.prototype.restore;

  if (fillStyleProtoDesc?.set && fillStyleProtoDesc?.get) {
    const fsGet = fillStyleProtoDesc.get;
    const fsSet = fillStyleProtoDesc.set;
    let _fillStyle: string | CanvasGradient | CanvasPattern = fsGet.call(ctx);

    Object.defineProperty(ctx, "fillStyle", {
      configurable: true,
      get() { return _fillStyle; },
      set(value: string | CanvasGradient | CanvasPattern) {
        _fillStyle = value;
        fsSet.call(ctx, value);
      },
    });

    Object.defineProperty(ctx, "fillText", {
      configurable: true,
      value(text: string, x: number, y: number, maxWidth?: number) {
        // Record EVERY fillText call so we can do exact character-index mapping.
        const t = ctx.getTransform();
        const ecx = Math.round(t.a * x + t.c * y + t.e);
        const ecy = Math.round(t.b * x + t.d * y + t.f);
        const color =
          typeof _fillStyle === "string" && !isBlackColor(_fillStyle.trim())
            ? _fillStyle.trim()
            : null;

        let list = charEventsByCy.get(ecy);
        if (!list) { list = []; charEventsByCy.set(ecy, list); }
        list.push({ cx: ecx, color });

        return maxWidth !== undefined
          ? origFillText.call(ctx, text, x, y, maxWidth)
          : origFillText.call(ctx, text, x, y);
      },
    });

    Object.defineProperty(ctx, "restore", {
      configurable: true,
      value() {
        origRestore.call(ctx);
        _fillStyle = fsGet.call(ctx);
      },
    });
  }

  try {
    await page.render({ canvasContext: ctx, viewport: tinyViewport }).promise;
  } catch {
    // Rendering failure is non-fatal
  }

  // Sort each row's events by cx (pdfjs draws L→R but sort for safety).
  for (const list of charEventsByCy.values()) {
    list.sort((a, b) => a.cx - b.cx);
  }

  // Bold/italic from PostScript font name via commonObjs (populated after render).
  for (const fName of textFontNames) {
     
    const fontObj = (page as any).commonObjs?.get?.(fName);
    const psName: string = fontObj?.name ?? "";
    boldMap[fName] = isBoldByName(psName || fName);
    italicMap[fName] = isItalicByName(psName || fName);
    fontFamilyMap[fName] = resolvePdfFontFamily(
      textStyles[fName]?.fontFamily ?? fontObj?.fallbackName ?? ""
    );
  }

  return {
    boldMap,
    italicMap,
    fontFamilyMap,
    getItemColorSpans(pdfX: number, pdfY: number, pdfWidth: number, charCount: number): ColorSpan[] {
      if (charCount === 0) return [];

       
      const vp = tinyViewport as any;
      const [x0, y0] = vp.convertToViewportPoint(pdfX, pdfY);
      const [x1]     = vp.convertToViewportPoint(pdfX + Math.max(pdfWidth, 0), pdfY);
      const startX = Math.round(Math.min(x0, x1));
      const endX   = Math.round(Math.max(x0, x1));
      const cy = Math.round(y0);

      // Collect events for this item (±1 px y-tolerance for rounding).
      const itemChars: Array<{ cx: number; color: string | null }> = [];
      for (let dy = -1; dy <= 1; dy++) {
        const list = charEventsByCy.get(cy + dy);
        if (list) {
          for (const e of list) {
            if (e.cx >= startX - 1 && e.cx <= endX + 1) itemChars.push(e);
          }
        }
      }
      itemChars.sort((a, b) => a.cx - b.cx);

      if (itemChars.length === 0) return [{ start: 0, end: charCount, color: null }];

      const N = itemChars.length;

      // Build per-character color array.
      // When N === charCount (common for non-ligature text), pdfjs drew exactly
      // one event per character in order → direct 1:1 index mapping is exact.
      // Otherwise fall back to proportional index mapping.
      const colors: Array<string | null> = [];
      for (let i = 0; i < charCount; i++) {
        const eventIdx = N === charCount
          ? i
          : Math.min(Math.floor((i * N) / charCount), N - 1);
        colors.push(itemChars[eventIdx].color);
      }

      // Compress into color spans.
      const spans: ColorSpan[] = [];
      let spanStart = 0;
      let spanColor = colors[0];
      for (let i = 1; i < charCount; i++) {
        if (colors[i] !== spanColor) {
          spans.push({ start: spanStart, end: i, color: spanColor });
          spanStart = i;
          spanColor = colors[i];
        }
      }
      spans.push({ start: spanStart, end: charCount, color: spanColor });
      return spans;
    },
  };
}

type GraphicsCanvasRender = {
  canvas: HTMLCanvasElement;
  hasInk: boolean;
};

type GraphicsObject = {
  left: number;
  top: number;
  width: number;
  height: number;
  dataUrl: string;
};

type GraphicsScanProfile = {
  id: string;
  minAlpha: number;
  whiteCutoff: number;
  maxAverage: number;
  minPixels: number;
  minWidth: number;
  minHeight: number;
  padding: number;
  mergeGapX: number;
  mergeGapY: number;
  blockPadding: number;
};

type GraphicsBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

const GRAPHICS_SCAN_PROFILES: GraphicsScanProfile[] = [
  {
    id: "signature",
    minAlpha: 20,
    whiteCutoff: 236,
    maxAverage: 220,
    minPixels: 12,
    minWidth: 2,
    minHeight: 2,
    padding: 2,
    mergeGapX: 24,
    mergeGapY: 12,
    blockPadding: 6,
  },
  {
    id: "default",
    minAlpha: 32,
    whiteCutoff: 248,
    maxAverage: 244,
    minPixels: 36,
    minWidth: 2,
    minHeight: 2,
    padding: 3,
    mergeGapX: 18,
    mergeGapY: 18,
    blockPadding: 3,
  },
  {
    id: "light",
    minAlpha: 12,
    whiteCutoff: 252,
    maxAverage: 250,
    minPixels: 120,
    minWidth: 10,
    minHeight: 10,
    padding: 4,
    mergeGapX: 28,
    mergeGapY: 24,
    blockPadding: 4,
  },
];

async function renderGraphicsCanvas(
  page: any,
  viewport: any,
  blankRects: { left: number; top: number; width: number; height: number }[] = []
): Promise<GraphicsCanvasRender | null> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const origFillText = ctx.fillText.bind(ctx);
  const origStrokeText = ctx.strokeText.bind(ctx);

  Object.defineProperty(ctx, "fillText", {
    configurable: true,
    value() {
      return undefined;
    },
  });

  Object.defineProperty(ctx, "strokeText", {
    configurable: true,
    value() {
      return undefined;
    },
  });

  try {
    await page.render({ canvasContext: ctx, viewport }).promise;
  } catch {
    return null;
  } finally {
    Object.defineProperty(ctx, "fillText", {
      configurable: true,
      value: origFillText,
    });
    Object.defineProperty(ctx, "strokeText", {
      configurable: true,
      value: origStrokeText,
    });
  }

  // Erase link-underline regions so they don't bleed through as strikethrough.
  if (blankRects.length > 0) {
    ctx.fillStyle = "#ffffff";
    for (const r of blankRects) {
      ctx.fillRect(r.left, r.top, r.width, r.height);
    }
  }

  try {
    const sample = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let hasNonWhiteInk = false;

    for (let i = 0; i < sample.length; i += 256) {
      const r = sample[i];
      const g = sample[i + 1];
      const b = sample[i + 2];
      const a = sample[i + 3];
      if (a !== 0 && !(r === 255 && g === 255 && b === 255)) {
        hasNonWhiteInk = true;
        break;
      }
    }

    if (!hasNonWhiteInk) return null;
  } catch {
    // If the canvas is tainted or unreadable, still return the rendered image.
  }

  return { canvas, hasInk: true };
}

function matchesGraphicsScanProfile(sample: Uint8ClampedArray, index: number, profile: GraphicsScanProfile) {
  const alpha = sample[index + 3];
  if (alpha < profile.minAlpha) return false;

  const r = sample[index];
  const g = sample[index + 1];
  const b = sample[index + 2];
  const avg = (r + g + b) / 3;
  if (avg > profile.maxAverage) return false;

  return !(r > profile.whiteCutoff && g > profile.whiteCutoff && b > profile.whiteCutoff);
}

function shouldMergeGraphicBoxes(
  left: GraphicsBox,
  right: GraphicsBox,
  gapX = 24,
  gapY = 24
) {
  const leftRight = left.left + left.width;
  const rightRight = right.left + right.width;
  const leftBottom = left.top + left.height;
  const rightBottom = right.top + right.height;

  const horizontalGap = Math.max(0, Math.max(left.left - rightRight, right.left - leftRight));
  const verticalGap = Math.max(0, Math.max(left.top - rightBottom, right.top - leftBottom));
  const horizontalOverlap = Math.min(leftRight, rightRight) - Math.max(left.left, right.left);
  const verticalOverlap = Math.min(leftBottom, rightBottom) - Math.max(left.top, right.top);
  const minHorizontalOverlap = Math.max(2, Math.min(left.width, right.width) * 0.2);
  const minVerticalOverlap = Math.max(2, Math.min(left.height, right.height) * 0.2);

  return (
    (horizontalGap <= gapX && verticalOverlap >= minVerticalOverlap) ||
    (verticalGap <= gapY && horizontalOverlap >= minHorizontalOverlap)
  );
}

function mergeGraphicBoxes(boxes: GraphicsBox[], gapX = 24, gapY = 24) {
  if (boxes.length <= 1) return boxes;

  const pending = [...boxes];
  let changed = true;

  while (changed) {
    changed = false;
    outer: for (let i = 0; i < pending.length; i += 1) {
      for (let j = i + 1; j < pending.length; j += 1) {
        if (!shouldMergeGraphicBoxes(pending[i], pending[j], gapX, gapY)) continue;
        const mergedLeft = Math.min(pending[i].left, pending[j].left);
        const mergedTop = Math.min(pending[i].top, pending[j].top);
        const mergedRight = Math.max(pending[i].left + pending[i].width, pending[j].left + pending[j].width);
        const mergedBottom = Math.max(pending[i].top + pending[i].height, pending[j].top + pending[j].height);
        pending.splice(j, 1);
        pending[i] = {
          left: mergedLeft,
          top: mergedTop,
          width: mergedRight - mergedLeft,
          height: mergedBottom - mergedTop,
        };
        changed = true;
        break outer;
      }
    }
  }

  return pending;
}

function buildGraphicsMask(
  sample: Uint8ClampedArray,
  width: number,
  height: number,
  blocked: Uint8Array,
  profile: GraphicsScanProfile
) {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = y * width + x;
      if (blocked[pixelIndex]) continue;
      if (matchesGraphicsScanProfile(sample, pixelIndex * 4, profile)) {
        mask[pixelIndex] = 1;
      }
    }
  }
  return mask;
}

function extractGraphicComponentsFromMask(
  mask: Uint8Array,
  width: number,
  height: number,
  profile: GraphicsScanProfile
) {
  const visited = new Uint8Array(width * height);
  const components: Array<{ left: number; top: number; width: number; height: number; pixels: number }> = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const start = y * width + x;
      if (!mask[start] || visited[start]) continue;

      const queue = [start];
      visited[start] = 1;
      let head = 0;
      let minX = x;
      let minY = y;
      let maxX = x;
      let maxY = y;
      let pixels = 0;

      while (head < queue.length) {
        const current = queue[head++];
        const cx = current % width;
        const cy = Math.floor(current / width);
        pixels += 1;
        if (cx < minX) minX = cx;
        if (cy < minY) minY = cy;
        if (cx > maxX) maxX = cx;
        if (cy > maxY) maxY = cy;

        for (let ny = Math.max(0, cy - 1); ny <= Math.min(height - 1, cy + 1); ny += 1) {
          for (let nx = Math.max(0, cx - 1); nx <= Math.min(width - 1, cx + 1); nx += 1) {
            const next = ny * width + nx;
            if (visited[next] || !mask[next]) continue;
            visited[next] = 1;
            queue.push(next);
          }
        }
      }

      const componentWidth = maxX - minX + 1;
      const componentHeight = maxY - minY + 1;
      if (
        pixels < profile.minPixels ||
        componentWidth < profile.minWidth ||
        componentHeight < profile.minHeight
      ) continue;
      components.push({
        left: minX,
        top: minY,
        width: componentWidth,
        height: componentHeight,
        pixels,
      });
    }
  }

  return mergeGraphicBoxes(components, profile.mergeGapX, profile.mergeGapY);
}

function markBlockedBox(blocked: Uint8Array, width: number, height: number, box: GraphicsBox, padding: number) {
  const left = Math.max(0, Math.floor(box.left - padding));
  const top = Math.max(0, Math.floor(box.top - padding));
  const right = Math.min(width, Math.ceil(box.left + box.width + padding));
  const bottom = Math.min(height, Math.ceil(box.top + box.height + padding));

  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      blocked[y * width + x] = 1;
    }
  }
}

function getGraphicsBoxArea(box: GraphicsBox) {
  return Math.max(0, box.width) * Math.max(0, box.height);
}

function getGraphicsBoxIntersectionArea(left: GraphicsBox, right: GraphicsBox) {
  const intersectionWidth = Math.max(
    0,
    Math.min(left.left + left.width, right.left + right.width) - Math.max(left.left, right.left),
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(left.top + left.height, right.top + right.height) - Math.max(left.top, right.top),
  );
  return intersectionWidth * intersectionHeight;
}

function shouldMergeSignatureLikeBoxes(left: GraphicsBox, right: GraphicsBox) {
  const leftCenterY = left.top + left.height / 2;
  const rightCenterY = right.top + right.height / 2;
  const verticalCenterDelta = Math.abs(leftCenterY - rightCenterY);
  const horizontalGap = Math.max(
    0,
    Math.max(left.left - (right.left + right.width), right.left - (left.left + left.width)),
  );

  return (
    Math.max(left.height, right.height) <= 32 &&
    verticalCenterDelta <= Math.max(10, Math.min(left.height, right.height)) &&
    horizontalGap <= 28
  );
}

function shouldMergeOverlappingGraphicsBoxes(left: GraphicsBox, right: GraphicsBox) {
  const intersectionArea = getGraphicsBoxIntersectionArea(left, right);
  if (intersectionArea <= 0) return false;

  const leftArea = getGraphicsBoxArea(left);
  const rightArea = getGraphicsBoxArea(right);
  const smallerArea = Math.max(1, Math.min(leftArea, rightArea));
  const largerArea = Math.max(1, Math.max(leftArea, rightArea));
  const smallerCoverage = intersectionArea / smallerArea;
  const largerCoverage = intersectionArea / largerArea;

  // Merge only when overlap strongly suggests duplicate detections of the same
  // object (often produced by multiple scan profiles). Small incidental
  // overlaps, such as a signature crossing a watermark, should remain separate.
  return smallerCoverage >= 0.66 || largerCoverage >= 0.42;
}

function normalizeGraphicsBoxes(boxes: GraphicsBox[]) {
  if (boxes.length <= 1) return boxes;

  const pending = [...boxes];
  let changed = true;

  while (changed) {
    changed = false;
    outer: for (let i = 0; i < pending.length; i += 1) {
      for (let j = i + 1; j < pending.length; j += 1) {
        if (
          !shouldMergeOverlappingGraphicsBoxes(pending[i], pending[j]) &&
          !shouldMergeSignatureLikeBoxes(pending[i], pending[j])
        ) {
          continue;
        }

        const mergedLeft = Math.min(pending[i].left, pending[j].left);
        const mergedTop = Math.min(pending[i].top, pending[j].top);
        const mergedRight = Math.max(pending[i].left + pending[i].width, pending[j].left + pending[j].width);
        const mergedBottom = Math.max(pending[i].top + pending[i].height, pending[j].top + pending[j].height);
        pending.splice(j, 1);
        pending[i] = {
          left: mergedLeft,
          top: mergedTop,
          width: mergedRight - mergedLeft,
          height: mergedBottom - mergedTop,
        };
        changed = true;
        break outer;
      }
    }
  }

  const sorted = [...pending].sort((left, right) => getGraphicsBoxArea(right) - getGraphicsBoxArea(left));
  const deduped: GraphicsBox[] = [];

  for (const candidate of sorted) {
    const candidateArea = getGraphicsBoxArea(candidate);
    const isContained = deduped.some((existing) => {
      const intersectionArea = getGraphicsBoxIntersectionArea(existing, candidate);
      if (intersectionArea <= 0) return false;
      return intersectionArea / Math.max(1, candidateArea) >= 0.82;
    });
    if (!isContained) deduped.push(candidate);
  }

  return deduped.sort((left, right) => {
    if (left.top !== right.top) return left.top - right.top;
    return left.left - right.left;
  });
}

export function extractGraphicsBoxesFromPixels(
  sample: Uint8ClampedArray,
  width: number,
  height: number
): GraphicsBox[] {
  const blocked = new Uint8Array(width * height);
  const accepted: GraphicsBox[] = [];

  for (const profile of GRAPHICS_SCAN_PROFILES) {
    const mask = buildGraphicsMask(sample, width, height, blocked, profile);
    const components = extractGraphicComponentsFromMask(mask, width, height, profile);
    for (const box of components) {
      const padding = profile.padding;
      const paddedBox = {
        left: Math.max(0, box.left - padding),
        top: Math.max(0, box.top - padding),
        width: Math.max(1, Math.min(width, box.left + box.width + padding) - Math.max(0, box.left - padding)),
        height: Math.max(1, Math.min(height, box.top + box.height + padding) - Math.max(0, box.top - padding)),
      };
      accepted.push(paddedBox);
      markBlockedBox(blocked, width, height, paddedBox, profile.blockPadding);
    }
  }

  return normalizeGraphicsBoxes(accepted);
}

function extractGraphicsObjects(render: GraphicsCanvasRender | null): GraphicsObject[] {
  if (!render?.hasInk) return [];

  const { canvas } = render;
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const sample = imageData.data;
  const width = canvas.width;
  const height = canvas.height;

  const boxes = extractGraphicsBoxesFromPixels(sample, width, height);
  return boxes.map((box) => {
    const left = Math.max(0, Math.floor(box.left));
    const top = Math.max(0, Math.floor(box.top));
    const right = Math.min(width, Math.ceil(box.left + box.width));
    const bottom = Math.min(height, Math.ceil(box.top + box.height));
    const cropWidth = Math.max(1, right - left);
    const cropHeight = Math.max(1, bottom - top);

    const cropCanvas = document.createElement("canvas");
    cropCanvas.width = cropWidth;
    cropCanvas.height = cropHeight;
    const cropCtx = cropCanvas.getContext("2d");
    if (!cropCtx) {
      return {
        left,
        top,
        width: cropWidth,
        height: cropHeight,
        dataUrl: canvas.toDataURL("image/png"),
      };
    }

    cropCtx.putImageData(ctx.getImageData(left, top, cropWidth, cropHeight), 0, 0);

    return {
      left,
      top,
      width: cropWidth,
      height: cropHeight,
      dataUrl: cropCanvas.toDataURL("image/png"),
    };
  });
}

function renderGraphicsObjectHtml(
  object: GraphicsObject,
  pageIndex: number,
  objectIndex: number,
  options?: { behindText?: boolean }
) {
  const behindText = Boolean(options?.behindText);
  return `<div data-template-image-object-id="pdf_graphic_${pageIndex}_${objectIndex}" data-template-image-behind-text="${behindText ? "true" : "false"}" data-template-image-crop-x="0" data-template-image-crop-y="0" data-template-image-crop-width="${object.width.toFixed(1)}" data-template-image-crop-height="${object.height.toFixed(1)}" style="position:absolute;left:${object.left.toFixed(1)}px;top:${object.top.toFixed(1)}px;width:${object.width.toFixed(1)}px;height:${object.height.toFixed(1)}px;z-index:0;overflow:visible;min-width:24px;min-height:24px;"><div data-template-image-viewport="true" style="position:relative;width:100%;height:100%;overflow:hidden;pointer-events:none;border-radius:2px;background:transparent;"><img data-template-object-image="true" alt="" src="${object.dataUrl}" data-template-file-name="pdf-graphic-${pageIndex + 1}-${objectIndex + 1}.png" data-template-source="pdf-import" data-template-intrinsic-width="${object.width.toFixed(1)}" data-template-intrinsic-height="${object.height.toFixed(1)}" style="position:absolute;left:0;top:0;width:100%;height:100%;max-width:none;user-select:none;-webkit-user-drag:none;pointer-events:none;" /></div></div>`;
}

function isLikelyHorizontalRuleObject(object: GraphicsObject, pageWidth: number, pageHeight: number) {
  const areaRatio = (object.width * object.height) / Math.max(1, pageWidth * pageHeight);
  return (
    object.width >= pageWidth * 0.52 &&
    object.height <= 10 &&
    areaRatio <= 0.03
  );
}

function renderHorizontalRuleHtml(object: GraphicsObject, pageIndex: number, objectIndex: number) {
  const lineHeight = Math.min(2, Math.max(1, Math.round(object.height * 0.35)));
  const topOffset = Math.max(0, (object.height - lineHeight) / 2);
  return `<div data-template-separator-rule-id="pdf_rule_${pageIndex}_${objectIndex}" style="position:absolute;left:${object.left.toFixed(1)}px;top:${(object.top + topOffset).toFixed(1)}px;width:${object.width.toFixed(1)}px;height:${lineHeight.toFixed(1)}px;background:#111;opacity:0.85;z-index:0;pointer-events:none;"></div>`;
}

function renderFallbackBackgroundHtml(render: GraphicsCanvasRender) {
  try {
    const dataUrl = render.canvas.toDataURL("image/png");
    return `<img class="pdf-page-background" src="${dataUrl}" alt="" style="position:absolute;left:0;top:0;width:100%;height:100%;z-index:0;pointer-events:none;user-select:none;" data-template-source="pdf-import-fallback" />`;
  } catch {
    return "";
  }
}

function loadImageElementFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to decode graphics object image."));
    image.src = dataUrl;
  });
}

async function removeForegroundOverlapFromBackgroundGraphics(
  objects: GraphicsObject[],
  backgroundFlags: boolean[]
): Promise<GraphicsObject[]> {
  if (objects.length <= 1) return objects;

  const output = [...objects];
  for (let bgIndex = 0; bgIndex < output.length; bgIndex += 1) {
    if (!backgroundFlags[bgIndex]) continue;
    const background = output[bgIndex];

    const overlaps = output
      .map((object, index) => ({ object, index }))
      .filter(({ index }) => index !== bgIndex && !backgroundFlags[index])
      .map(({ object }) => {
        const left = Math.max(background.left, object.left);
        const top = Math.max(background.top, object.top);
        const right = Math.min(background.left + background.width, object.left + object.width);
        const bottom = Math.min(background.top + background.height, object.top + object.height);
        return {
          left,
          top,
          width: Math.max(0, right - left),
          height: Math.max(0, bottom - top),
        };
      })
      .filter((box) => box.width >= 1 && box.height >= 1);

    if (overlaps.length === 0) continue;

    try {
      const image = await loadImageElementFromDataUrl(background.dataUrl);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(background.width));
      canvas.height = Math.max(1, Math.round(background.height));
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

      for (const overlap of overlaps) {
        // Slightly expand clearing bounds so anti-aliased edge pixels from the
        // foreground object do not linger in the background layer.
        const pad = 1;
        const localLeft = Math.max(0, Math.floor(overlap.left - background.left - pad));
        const localTop = Math.max(0, Math.floor(overlap.top - background.top - pad));
        const localRight = Math.min(canvas.width, Math.ceil(overlap.left - background.left + overlap.width + pad));
        const localBottom = Math.min(canvas.height, Math.ceil(overlap.top - background.top + overlap.height + pad));
        ctx.clearRect(localLeft, localTop, Math.max(0, localRight - localLeft), Math.max(0, localBottom - localTop));
      }

      output[bgIndex] = {
        ...background,
        dataUrl: canvas.toDataURL("image/png"),
      };
    } catch {
      // Keep original object if overlap redaction fails for any reason.
    }
  }

  return output;
}

export async function convertPdfToHtml(file: File): Promise<PdfToHtmlResult> {
  const pdfjs = await import("pdfjs-dist");

  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url
    ).toString();
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  const pdf = await (pdfjs as any).getDocument({ data: bytes }).promise;

  // Resolves to null when the PDF carries no /AcroForm at all, the common case.
  const fieldObjects = (await pdf.getFieldObjects().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const formFieldNames = fieldObjects ? Object.keys(fieldObjects) : [];

  const pageHtmlParts: string[] = [];
  const warnings: string[] = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
     
    const viewport = (page as any).getViewport({ scale: 1.5 });
     
    const textContent = await (page as any).getTextContent() as any;

    // Collect all unique font names used on this page
    const textFontNames = new Set<string>();
    for (const raw of textContent.items) {
      const fn: string = (raw as any).fontName ?? "";
      if (fn) textFontNames.add(fn);
    }

    const { boldMap, italicMap, fontFamilyMap, getItemColorSpans } = await buildFontMap(
      page,
      [...textFontNames],
      textContent.styles ?? {}
    );
    // Fetch link annotations early so we can blank their underlines from the
    // graphics layer and later wrap matched text in <a> tags.
    type LinkAnnotation = { url: string; left: number; top: number; width: number; height: number };
    const linkAnnotations: LinkAnnotation[] = [];
    try {
      const annotations: any[] = await (page as any).getAnnotations();
      for (const ann of annotations) {
        if (ann.subtype !== "Link") continue;
        const rawUrl: string | undefined = ann.url ?? ann.unsafeUrl;
        if (!rawUrl) continue;
        const url = safeLinkUrl(rawUrl);
        if (!url) continue; // drop javascript:/data:/other non-allowlisted schemes
        const [lx, ty] = (viewport as any).convertToViewportPoint(ann.rect[0], ann.rect[3]);
        const [rx, by] = (viewport as any).convertToViewportPoint(ann.rect[2], ann.rect[1]);
        linkAnnotations.push({
          url,
          left: Math.min(lx, rx),
          top: Math.min(ty, by),
          width: Math.abs(rx - lx),
          height: Math.abs(by - ty),
        });
      }
    } catch { /* non-fatal */ }

    const graphicsRender = await renderGraphicsCanvas(page, viewport, linkAnnotations.map((a) => ({
      left: a.left, top: a.top, width: a.width, height: a.height,
    })));
    let graphicsObjects: GraphicsObject[] = [];
    let graphicsFallbackHtml = "";
    if (graphicsRender?.hasInk) {
      try {
        graphicsObjects = extractGraphicsObjects(graphicsRender);
      } catch {
        graphicsFallbackHtml = renderFallbackBackgroundHtml(graphicsRender);
        warnings.push(`Page ${pageNum}: Graphics could not be extracted as editable objects and were imported as a single background layer.`);
      }
    }

    type LineItem = {
      x: number; scaledWidth: number; text: string;
      fontSize: number; bold: boolean; italic: boolean;
      fontFamily: string;
      colorSpans: ColorSpan[];
    };
    type Line = { y: number; items: LineItem[] };
    const lines: Line[] = [];

    for (const raw of textContent.items) {

      const item = raw as any;

      const tx = item.transform;
      const fontName: string = item.fontName ?? "";

      if (shouldSkipPdfTextItem(item.str as string, fontName, graphicsObjects.length > 0)) {
        continue;
      }

      const [cssX, cssY] = (viewport as any).convertToViewportPoint(tx[4], tx[5]);
      const scaledWidth = item.width * viewport.scale;

      if (!item.str?.trim()) continue;

      const fontSize = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]) * viewport.scale || 12;

      const bold = boldMap[fontName] ?? false;
      const italic = italicMap[fontName] ?? false;
      const fontFamily = fontFamilyMap[fontName] ?? resolvePdfFontFamily();
      const colorSpans = getItemColorSpans(tx[4], tx[5], item.width ?? 0, item.str.length);

      const line = lines.find((l) => Math.abs(l.y - cssY) < 3);
      const entry: LineItem = {
        x: cssX,
        scaledWidth,
        text: (item.str as string).replace(/[\n\r\t]/g, " "),
        fontSize,
        bold,
        italic,
        fontFamily,
        colorSpans,
      };
      if (line) line.items.push(entry);
      else lines.push({ y: cssY, items: [entry] });
    }

    lines.sort((a, b) => a.y - b.y);
    lines.forEach((l) => l.items.sort((a, b) => a.x - b.x));

    const pageIndex = pageNum - 1;
    const pageW = viewport.width;
    const pageH = viewport.height;
    const lineMetrics = lines.map((line) => {
      const avgFontSize = line.items.reduce((s, i) => s + i.fontSize, 0) / line.items.length;
      const left = line.items[0].x;
      const right = Math.max(...line.items.map((item) => item.x + item.scaledWidth));
      return {
        line,
        avgFontSize,
        left,
        right,
        top: Math.max(0, line.y - avgFontSize),
      };
    });

    // Compute text column bounds from lines wider than 25% of page (body text, not narrow headers).
    // These are used for alignment detection and as the "looks wrapped" threshold.
    const wideLines = lineMetrics.filter(m => (m.right - m.left) > pageW * 0.25);
    const colLeft = wideLines.length > 1 ? Math.min(...wideLines.map(m => m.left)) : 0;
    const colRight = wideLines.length > 1 ? Math.max(...wideLines.map(m => m.right)) : pageW;
    const colWidth = Math.max(colRight - colLeft, pageW * 0.4);
    const colCenter = colLeft + colWidth / 2;

    const paragraphGroupIds = new Map<Line, string>();
    const paragraphRightBounds = new Map<string, number>();
    let paragraphIndex = 0;

    // Compute the document's typical line spacing adaptively so paragraph
    // detection works for single-, 1.5x-, and double-spaced documents.
    const allTopGaps = lineMetrics
      .slice(1)
      .map((m, i) => m.top - lineMetrics[i].top)
      .filter((g) => g > 2 && g < 200);
    const typicalLineGap = (() => {
      if (allTopGaps.length === 0) return 0;
      const sorted = [...allTopGaps].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    })();

    // Use the actual column right edge as the "looks wrapped" threshold for paragraph
    // grouping. Falls back to 70% of page width if column bounds aren't reliable.
    const wrappedThreshold = colRight > 0 && colRight < pageW ? colRight * 0.90 : pageW * 0.70;

    for (let i = 0; i < lineMetrics.length; i++) {
      const current = lineMetrics[i];
      const prev = lineMetrics[i - 1];
      const topGap = prev ? current.top - prev.top : Number.POSITIVE_INFINITY;
      const similarLeft = Boolean(prev && Math.abs(current.left - prev.left) <= Math.max(32, prev.avgFontSize * 2));
      const similarFont = Boolean(prev && Math.abs(current.avgFontSize - prev.avgFontSize) <= 2);
      const closeVerticalSpacing = typicalLineGap > 0
        ? Boolean(prev && topGap <= typicalLineGap * 1.35)
        : Boolean(prev && topGap <= Math.max(26, prev.avgFontSize * 2.5));
      const prevLineLooksWrapped = Boolean(
        prev && (
          prev.right >= wrappedThreshold ||
          prev.right - current.left >= Math.max(120, prev.avgFontSize * 8)
        )
      );
      // When the previous LINE is short (e.g. just "are" dangling at the end of
      // a wrapped paragraph), the line-level check fails. Fall back to the
      // group's overall right bound, if any earlier line in that group
      // extended far right, the short line is still a continuation.
      const prevGroupId = prev ? paragraphGroupIds.get(prev.line) : undefined;
      const prevGroupRight = prevGroupId !== undefined
        ? (paragraphRightBounds.get(prevGroupId) ?? 0)
        : 0;
      const groupLooksWrapped = Boolean(
        prevGroupRight >= wrappedThreshold ||
        prevGroupRight - current.left >= Math.max(120, (prev?.avgFontSize ?? 12) * 8)
      );
      // Lines starting with a bullet character always begin a new paragraph group,
      // even when vertical spacing and alignment would otherwise make them look like
      // a continuation. This prevents bullet list items from being merged into the
      // preceding paragraph when the user clicks to edit.
      const firstItemText = current.line.items[0]?.text ?? "";
      const startsWithBullet = /^[\u2022\u2023\u25E6\u2043\u2219\u25AA\u25AB\u25B8\u25B9\u25CF\u25CB\u25A0\u25A1\u2713\u2714\u2717\u2718\u2012\u2013\u2014]/.test(firstItemText.trimStart());
      const isContinuation = Boolean(
        prev &&
        !startsWithBullet &&
        similarLeft &&
        similarFont &&
        closeVerticalSpacing &&
        (prevLineLooksWrapped || groupLooksWrapped)
      );

      const groupId = isContinuation
        ? paragraphGroupIds.get(prev!.line) ?? `group_${pageNum}_${paragraphIndex}`
        : `group_${pageNum}_${paragraphIndex++}`;

      paragraphGroupIds.set(current.line, groupId);
      paragraphRightBounds.set(groupId, Math.max(paragraphRightBounds.get(groupId) ?? 0, current.right));
    }

    // Compute leftmost left edge per flow group (for alignment detection).
    const groupLeftBounds = new Map<string, number>();
    for (const metric of lineMetrics) {
      const gid = paragraphGroupIds.get(metric.line);
      if (!gid) continue;
      const existing = groupLeftBounds.get(gid);
      groupLeftBounds.set(gid, existing !== undefined ? Math.min(existing, metric.left) : metric.left);
    }

    // Detect text alignment per flow group based on bounding box vs column bounds.
    function detectAlignment(groupLeft: number, groupRight: number): "left" | "center" | "right" {
      const groupWidth = groupRight - groupLeft;
      if (groupWidth <= 0 || colWidth <= 50) return "left";
      const groupMid = groupLeft + groupWidth / 2;
      const tolerance = Math.max(12, colWidth * 0.04);
      // Centered: midpoint near column center, narrower than full column
      if (Math.abs(groupMid - colCenter) < tolerance && groupWidth < colWidth * 0.88) return "center";
      // Right-aligned: right edge near column right, starts in right 65% of column
      if (Math.abs(groupRight - colRight) < tolerance && groupLeft > colLeft + colWidth * 0.35) return "right";
      return "left";
    }

    const groupAlignments = new Map<string, "left" | "center" | "right">();
    for (const [gid, gRight] of paragraphRightBounds) {
      const gLeft = groupLeftBounds.get(gid) ?? 0;
      groupAlignments.set(gid, detectAlignment(gLeft, gRight));
    }

    const graphicsBackgroundFlags = graphicsObjects.map((object) => {
      const objectArea = Math.max(1, object.width * object.height);
      const objectAreaRatio = objectArea / Math.max(1, pageW * pageH);
      const isLargeGraphic = (
        objectAreaRatio >= 0.14 ||
        object.width >= pageW * 0.5 ||
        object.height >= pageH * 0.36
      );

      let overlappingLines = 0;
      for (const metric of lineMetrics) {
        const lineLeft = metric.left;
        const lineRight = metric.right;
        const lineTop = metric.top;
        const lineHeight = metric.avgFontSize * 1.2;
        const lineBottom = lineTop + lineHeight;
        const horizontalOverlap = Math.max(0, Math.min(object.left + object.width, lineRight) - Math.max(object.left, lineLeft));
        const verticalOverlap = Math.max(0, Math.min(object.top + object.height, lineBottom) - Math.max(object.top, lineTop));
        if (horizontalOverlap >= Math.max(20, (lineRight - lineLeft) * 0.18) && verticalOverlap >= Math.max(2, lineHeight * 0.18)) {
          overlappingLines += 1;
          if (overlappingLines >= 4) break;
        }
      }

      return (
        objectAreaRatio >= 0.28 ||
        (isLargeGraphic && overlappingLines >= 2) ||
        overlappingLines >= 4
      );
    });
    graphicsObjects = await removeForegroundOverlapFromBackgroundGraphics(
      graphicsObjects,
      graphicsBackgroundFlags
    );

    let pageHtml = `<div class="pdf-page" data-page-index="${pageIndex}" data-column-left="${colLeft.toFixed(1)}" data-column-right="${colRight.toFixed(1)}" data-column-width="${colWidth.toFixed(1)}" style="position:relative;width:${pageW.toFixed(0)}px;min-height:${viewport.height.toFixed(0)}px;margin:0 auto 24px;background:#fff;color:#000;box-shadow:0 2px 12px rgba(0,0,0,0.12);padding:0;overflow:hidden;">`;
    if (graphicsFallbackHtml) {
      pageHtml += graphicsFallbackHtml;
    } else {
      for (let objectIndex = 0; objectIndex < graphicsObjects.length; objectIndex += 1) {
        const object = graphicsObjects[objectIndex];
        if (isLikelyHorizontalRuleObject(object, pageW, pageH)) {
          pageHtml += renderHorizontalRuleHtml(object, pageIndex, objectIndex);
          continue;
        }
        pageHtml += renderGraphicsObjectHtml(object, pageIndex, objectIndex, {
          behindText: graphicsBackgroundFlags[objectIndex]
        });
      }
    }

    // Detect significant vertical gaps between paragraph groups and insert a blank
    // <p> so users can click in that whitespace and position their cursor there.
    //
    // Key insight: measure top-to-top distance between consecutive lines of
    // different groups, then compare against typicalLineGap. A ratio > 1.4 means
    // the groups are further apart than 1.4× a normal line step, indicating either
    // "After paragraph" spacing, a blank line, or a large section break.
    // Measuring bottom-to-top (lineTop - prevLineBottom) underestimates the gap
    // because prevLineBottom already absorbs part of the line-height, making the
    // remaining distance appear too small to cross the threshold.
    let blankLineIdx = 0;
    let prevGroupIdForBlanks: string | null = null;
    let prevLineTopForGap = 0;
    let prevAvgFontSizeForGap = 0;
    const blankLeft = colLeft > 0 ? colLeft : 0;
    const blankWidth = colWidth > 0 ? colWidth : pageW;

    for (const metric of lineMetrics) {
      const { line, avgFontSize, left: lineX, top: lineTop } = metric;
      const groupId = paragraphGroupIds.get(line) ?? `group_fallback_${pageNum}`;
      const groupRight = paragraphRightBounds.get(groupId) ?? metric.right;
      const alignment = groupAlignments.get(groupId) ?? "left";

      // When transitioning to a new group, compare the top-to-top line gap against
      // the document's typical line step. A ratio > 1.4 means there is more space
      // than a normal line break, paragraph spacing or a blank line.
      if (prevGroupIdForBlanks !== null && prevGroupIdForBlanks !== groupId && typicalLineGap > 0) {
        const topToTopGap = lineTop - prevLineTopForGap;
        if (topToTopGap > typicalLineGap * 1.4) {
          const blankGroupId = `blank_${pageNum}_${blankLineIdx++}`;
          // Position the blank paragraph just below the visual bottom of the previous line.
          const blankTop = prevLineTopForGap + prevAvgFontSizeForGap * 1.2;
          pageHtml += `<p data-flow-group="${blankGroupId}" data-blank-line="true" style="position:absolute;top:${blankTop.toFixed(1)}px;left:${blankLeft.toFixed(1)}px;width:${blankWidth.toFixed(1)}px;margin:0;font-size:${prevAvgFontSizeForGap.toFixed(1)}px;line-height:1.2;white-space:nowrap;color:#000;z-index:1;"> </p>`;
        }
      }
      prevGroupIdForBlanks = groupId;
      prevLineTopForGap = lineTop;
      prevAvgFontSizeForGap = avgFontSize;

      // For centered/right groups: anchor at colLeft with full column width so
      // text-align:center/right is visually accurate after wrapping is enabled.
      let pLeft: number;
      let pWidth: number;
      let textAlignStyle = "";
      if ((alignment === "center" || alignment === "right") && colWidth > 0) {
        pLeft = colLeft;
        pWidth = colWidth;
        textAlignStyle = `text-align:${alignment};`;
      } else {
        pLeft = lineX;
        pWidth = Math.max(40, groupRight - lineX + 6);
      }

      let lineHtml = "";
      for (let i = 0; i < line.items.length; i++) {
        const cur = line.items[i];
        const prev = line.items[i - 1];

        let prefix = "";
        if (prev) {
          const gap = cur.x - (prev.x + prev.scaledWidth);
          prefix = renderHorizontalGap(gap, cur.fontSize, prev.text, cur.text);
        }

        const itemHtml = renderStyledCharacters(cur.text, {
          fontFamily: cur.fontFamily || SERIF_FALLBACK,
          fontSize: cur.fontSize,
          bold: cur.bold,
          italic: cur.italic,
        }, cur.colorSpans);

        lineHtml += prefix + itemHtml;
      }

      pageHtml += `<p data-flow-group="${groupId}" style="position:absolute;top:${lineTop.toFixed(1)}px;left:${pLeft.toFixed(1)}px;width:${pWidth.toFixed(1)}px;margin:0;font-size:${avgFontSize.toFixed(1)}px;line-height:1.2;white-space:nowrap;${textAlignStyle}color:#000;z-index:1;">${lineHtml}</p>`;
    }

    // Overlay link annotations as absolutely-positioned <a> elements.
    // Uses the pre-fetched linkAnnotations (underlines already blanked from
    // the graphics layer above).
    for (const ann of linkAnnotations) {
      pageHtml += `<a href="${escapeHtml(ann.url)}" target="_blank" rel="noopener noreferrer" style="position:absolute;left:${ann.left.toFixed(1)}px;top:${ann.top.toFixed(1)}px;width:${ann.width.toFixed(1)}px;height:${ann.height.toFixed(1)}px;z-index:1;text-decoration:none;cursor:pointer;" title="${escapeHtml(ann.url)}"></a>`;
    }

    pageHtml += "</div>";
    pageHtmlParts.push(pageHtml);
  }

  return {
    html: `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
  body { background: #f0f0f0; font-family: ${SERIF_FALLBACK}; margin: 0; padding: 24px; }
  .pdf-page { box-sizing: border-box; }
  .pdf-page-background { display: block; }
  p { margin: 0; padding: 0; }
</style>
</head>
<body>
${pageHtmlParts.join("\n")}
</body>
</html>`,
    warnings,
    formFieldNames,
  };
}
