import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { Annotation, TextAnnotationData } from '@/types/signature';
import { FONT_FAMILIES, resolveSignatureStyle } from '@/types/signature';
import type { SignatureField, SigningFieldValue } from '@/types/signature';
import { calculateSignatureLayout } from './signatureLayout';
import { fitTextToBox } from '@/lib/utils/textFit';

// --- Font mapping (CSS → pdf-lib StandardFonts) ---

const FONT_MAP: Record<string, Record<string, keyof typeof StandardFonts>> = {
  Helvetica: {
    normal: 'Helvetica',
    bold: 'HelveticaBold',
    italic: 'HelveticaOblique',
    'bold-italic': 'HelveticaBoldOblique',
  },
  'Times-Roman': {
    normal: 'TimesRoman',
    bold: 'TimesRomanBold',
    italic: 'TimesRomanItalic',
    'bold-italic': 'TimesRomanBoldItalic',
  },
  Courier: {
    normal: 'Courier',
    bold: 'CourierBold',
    italic: 'CourierOblique',
    'bold-italic': 'CourierBoldOblique',
  },
};

function getFontKey(family: string, bold: boolean, italic: boolean): keyof typeof StandardFonts {
  const style = bold && italic ? 'bold-italic' : bold ? 'bold' : italic ? 'italic' : 'normal';
  // Map any font to its closest standard PDF font via the FONT_FAMILIES lookup
  const pdfFamily = FONT_FAMILIES.find((f) => f.value === family)?.pdfFont ?? 'Helvetica';
  return FONT_MAP[pdfFamily]?.[style] ?? 'Helvetica';
}

/** Map a CSS font-family string to our internal font value */
function cssToFontFamily(css: string): string {
  const lower = css.toLowerCase().replace(/['"]/g, '');
  for (const f of FONT_FAMILIES) {
    const names = f.css.toLowerCase().replace(/['"]/g, '').split(',').map((s) => s.trim());
    if (names.some((name) => lower.includes(name))) {
      return f.value;
    }
  }
  if (lower.includes('courier') || lower.includes('monospace')) return 'Courier';
  if (lower.includes('times') || lower.includes('serif')) return 'Times-Roman';
  return 'Helvetica';
}

/** Parse a CSS color string (hex, rgb, named) to pdf-lib rgb() */
function parseColorToRgb(color: string) {
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    return rgb(r, g, b);
  }
  const match = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (match) {
    return rgb(parseInt(match[1]) / 255, parseInt(match[2]) / 255, parseInt(match[3]) / 255);
  }
  return rgb(0, 0, 0);
}

// --- HTML → styled text runs parser ---

interface StyledRun {
  text: string;
  bold: boolean;
  italic: boolean;
  fontSize: number;
  fontFamily: string;
  color: string;
}

interface StyleContext {
  bold: boolean;
  italic: boolean;
  fontSize: number;
  fontFamily: string;
  color: string;
}

/**
 * Parse HTML content from contentEditable into lines of styled text runs.
 * Each line is an array of runs; each run has its own formatting.
 */
function parseHtmlToLines(
  html: string,
  defaults: StyleContext
): StyledRun[][] {
  if (!html || !html.trim()) return [];

  // Check if html contains any tags. If not, treat as plain text
  if (!/<[^>]+>/.test(html)) {
    const plainLines = html.split('\n');
    return plainLines.map((line) =>
      line ? [{ text: line, ...defaults }] : []
    );
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<body>${html}</body>`, 'text/html');
  const root = doc.body;

  const lines: StyledRun[][] = [];
  let currentLine: StyledRun[] = [];
  let atLineStart = true;

  function pushLine() {
    lines.push(currentLine);
    currentLine = [];
    atLineStart = true;
  }

  function walk(node: Node, ctx: StyleContext) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      if (!text) return;

      // Handle \n in text nodes (backward compat with plain-text annotations)
      const parts = text.split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (parts[i]) {
          currentLine.push({ text: parts[i], ...ctx });
          atLineStart = false;
        }
        if (i < parts.length - 1) {
          pushLine();
        }
      }
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();

    // <br> → line break
    if (tag === 'br') {
      pushLine();
      return;
    }

    const isBlock = tag === 'div' || tag === 'p';
    if (isBlock && !atLineStart) pushLine();

    // Build new context from this element's styling
    const newCtx: StyleContext = { ...ctx };

    if (tag === 'b' || tag === 'strong') newCtx.bold = true;
    if (tag === 'i' || tag === 'em') newCtx.italic = true;

    // Inline styles
    const style = el.style;
    if (style?.fontSize) {
      const px = parseFloat(style.fontSize);
      if (!isNaN(px)) newCtx.fontSize = px;
    }
    if (style?.fontFamily) {
      newCtx.fontFamily = cssToFontFamily(style.fontFamily);
    }
    if (style?.fontWeight === 'bold' || Number(style?.fontWeight) >= 700) {
      newCtx.bold = true;
    }
    if (style?.fontStyle === 'italic') {
      newCtx.italic = true;
    }
    if (style?.color) {
      newCtx.color = style.color;
    }

    // Legacy <font> tags from execCommand
    if (tag === 'font') {
      const face = el.getAttribute('face');
      if (face) newCtx.fontFamily = cssToFontFamily(face);
      const colorAttr = el.getAttribute('color');
      if (colorAttr) newCtx.color = colorAttr;
      const sizeAttr = el.getAttribute('size');
      if (sizeAttr) {
        const sizeMap: Record<string, number> = {
          '1': 10, '2': 13, '3': 16, '4': 18, '5': 24, '6': 32, '7': 48,
        };
        newCtx.fontSize = sizeMap[sizeAttr] || newCtx.fontSize;
      }
    }

    // Walk children
    for (const child of Array.from(el.childNodes)) {
      walk(child, newCtx);
    }

    if (isBlock && !atLineStart) pushLine();
  }

  for (const child of Array.from(root.childNodes)) {
    walk(child, defaults);
  }

  // Push remaining content
  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines;
}

// --- PDF stamping ---

export async function stampAnnotationsOntoPdf(
  pdfBytes: Uint8Array,
  annotations: Annotation[]
): Promise<Uint8Array> {
  // ignoreEncryption lets us stamp PDFs that carry permission-only encryption
  // (no user password). pdf-lib otherwise refuses to load them.
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = pdfDoc.getPages();

  // Parse all text annotations and collect required font keys
  const parsedTexts = new Map<string, StyledRun[][]>();
  const requiredFontKeys = new Set<keyof typeof StandardFonts>();

  for (const ann of annotations) {
    if (ann.type === 'text') {
      const lines = parseHtmlToLines(ann.text, {
        fontSize: ann.fontSize,
        fontFamily: ann.fontFamily,
        bold: ann.isBold,
        italic: ann.isItalic,
        color: ann.color || '#000000',
      });
      parsedTexts.set(ann.id, lines);

      for (const line of lines) {
        for (const run of line) {
          requiredFontKeys.add(getFontKey(run.fontFamily, run.bold, run.italic));
        }
      }

      // Ensure default font is embedded (for empty lines)
      requiredFontKeys.add(getFontKey(ann.fontFamily, ann.isBold, ann.isItalic));
    }
  }

  // Pre-embed all needed fonts
  const embeddedFonts: Record<string, Awaited<ReturnType<typeof pdfDoc.embedFont>>> = {};
  for (const key of requiredFontKeys) {
    embeddedFonts[key] = await pdfDoc.embedFont(StandardFonts[key]);
  }
  const helveticaFont = embeddedFonts.Helvetica ?? await pdfDoc.embedFont(StandardFonts.Helvetica);

  for (const annotation of annotations) {
    const pageIndex = annotation.page - 1;
    if (pageIndex < 0 || pageIndex >= pages.length) continue;

    const page = pages[pageIndex];
    const { width: pageWidth, height: pageHeight } = page.getSize();

    const pdfX = (annotation.xPercent / 100) * pageWidth;
    // PDF Y is bottom-up, screen Y is top-down
    const pdfYTop = pageHeight - (annotation.yPercent / 100) * pageHeight;

    if (annotation.type === 'text') {
      const textAnn = annotation as TextAnnotationData;
      const lines = parsedTexts.get(textAnn.id) || [];
      if (lines.length === 0) continue;

      let currentY = pdfYTop;

      for (const runs of lines) {
        if (runs.length === 0) {
          // Empty line, advance by default font size
          currentY -= textAnn.fontSize * 1.2;
          continue;
        }

        // Use the max font size on this line for line height
        const maxFontSize = Math.max(...runs.map((r) => r.fontSize));
        currentY -= maxFontSize; // Move down to baseline

        let currentX = pdfX;

        for (const run of runs) {
          const fontKey = getFontKey(run.fontFamily, run.bold, run.italic);
          const font = embeddedFonts[fontKey];

          try {
            page.drawText(run.text, {
              x: currentX,
              y: currentY,
              size: run.fontSize,
              font,
              color: parseColorToRgb(run.color),
            });
          } catch {
            // Skip runs with unsupported characters (WinAnsi encoding limit)
          }

          currentX += font.widthOfTextAtSize(run.text, run.fontSize);
        }

        currentY -= maxFontSize * 0.2; // Line gap (1.2 line height total)
      }
    } else if (annotation.type === 'signature') {
      const sigBase64 = annotation.dataUrl.split(',')[1];
      if (!sigBase64) continue;

      const sigBytes = Uint8Array.from(atob(sigBase64), (c) => c.charCodeAt(0));
      const sigImage = await pdfDoc.embedPng(sigBytes);

      const boxWidth = (annotation.widthPercent / 100) * pageWidth;
      const boxHeight = (annotation.heightPercent / 100) * pageHeight;
      const signatureStyle = resolveSignatureStyle(annotation.style);

      if (signatureStyle === 'x-line') {
        const xInset = Math.min(boxWidth * 0.14, boxHeight * 0.85);
        const xFontSize = Math.max(10, Math.min(boxHeight * 0.6, xInset * 0.9));
        const lineStartX = pdfX + xInset + Math.max(boxWidth * 0.03, 4);
        const lineEndX = pdfX + boxWidth;
        const lineY = pdfYTop - boxHeight * 0.74;

        page.drawText('X', {
          x: pdfX,
          y: lineY - xFontSize * 0.15,
          size: xFontSize,
          font: helveticaFont,
          color: rgb(0, 0, 0),
        });

        page.drawLine({
          start: { x: lineStartX, y: lineY },
          end: { x: lineEndX, y: lineY },
          thickness: 1,
          color: rgb(0, 0, 0),
        });

        const imgAspect = sigImage.width / sigImage.height;
        const imgBoxWidth = Math.max(lineEndX - lineStartX - 2, 1);
        const imgBoxHeight = Math.max(boxHeight * 0.72, 1);
        const boxAspect = imgBoxWidth / imgBoxHeight;

        let sigWidth: number;
        let sigHeight: number;
        if (imgAspect > boxAspect) {
          sigWidth = imgBoxWidth;
          sigHeight = imgBoxWidth / imgAspect;
        } else {
          sigHeight = imgBoxHeight;
          sigWidth = imgBoxHeight * imgAspect;
        }

        const sigX = lineStartX + (imgBoxWidth - sigWidth) / 2;
        const sigBottom = Math.max(pdfYTop - boxHeight, lineY - sigHeight * 0.18);

        page.drawImage(sigImage, {
          x: sigX,
          y: sigBottom,
          width: sigWidth,
          height: sigHeight,
        });
        continue;
      }

      // Fit signature inside the box without stretching (preserve aspect ratio)
      const imgAspect = sigImage.width / sigImage.height;
      const boxAspect = boxWidth / boxHeight;
      let sigWidth: number, sigHeight: number;
      if (imgAspect > boxAspect) {
        sigWidth = boxWidth;
        sigHeight = boxWidth / imgAspect;
      } else {
        sigHeight = boxHeight;
        sigWidth = boxHeight * imgAspect;
      }

      // Center within the box
      const offsetX = (boxWidth - sigWidth) / 2;
      const offsetY = (boxHeight - sigHeight) / 2;

      page.drawImage(sigImage, {
        x: pdfX + offsetX,
        y: pdfYTop - sigHeight - offsetY,
        width: sigWidth,
        height: sigHeight,
      });
    }
  }

  return await pdfDoc.save();
}

function getFieldBox(field: SignatureField, pageWidth: number, pageHeight: number) {
  const x = (field.xPercent / 100) * pageWidth;
  const width = (field.widthPercent / 100) * pageWidth;
  const height = (field.heightPercent / 100) * pageHeight;
  const top = pageHeight - (field.yPercent / 100) * pageHeight;

  return {
    x,
    y: top - height,
    top,
    width,
    height,
  };
}

function drawCheckboxMark(page: any, box: ReturnType<typeof getFieldBox>) {
  // Draw checkmark within a square area centered in the field for consistent proportions
  const side = Math.min(box.width, box.height);
  const ox = box.x + (box.width - side) / 2;
  const oy = box.y + (box.height - side) / 2;

  // Short left leg (down-right), long right leg (up-right), proper ✓ shape
  const startX = ox + side * 0.15;
  const startY = oy + side * 0.55;
  const midX = ox + side * 0.38;
  const midY = oy + side * 0.20;
  const endX = ox + side * 0.85;
  const endY = oy + side * 0.82;
  const thickness = Math.max(1.5, Math.min(3, side * 0.08));

  page.drawLine({
    start: { x: startX, y: startY },
    end: { x: midX, y: midY },
    thickness,
    color: rgb(0, 0, 0),
  });
  page.drawLine({
    start: { x: midX, y: midY },
    end: { x: endX, y: endY },
    thickness,
    color: rgb(0, 0, 0),
  });
}

export async function stampSignatureFieldsOntoPdf(
  pdfBytes: Uint8Array,
  fields: SignatureField[],
  fieldValues: SigningFieldValue[]
): Promise<Uint8Array> {
  // ignoreEncryption lets us stamp PDFs that carry permission-only encryption
  // (no user password). pdf-lib otherwise refuses to load them.
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = pdfDoc.getPages();
  const textFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const valueMap = new Map(fieldValues.map((entry) => [entry.fieldId, entry.value]));

  for (const field of fields) {
    const value = valueMap.get(field.id);
    if (value === undefined || value === null || value === '') continue;

    const page = pages[(field.page || 1) - 1];
    if (!page) continue;

    const { width: pageWidth, height: pageHeight } = page.getSize();
    const box = getFieldBox(field, pageWidth, pageHeight);
    const fieldType = field.fieldType || 'signature';

    if (fieldType === 'checkbox') {
      if (value === true || value === 'true') {
        drawCheckboxMark(page, box);
      }
      continue;
    }

    if (fieldType === 'signature' || fieldType === 'initials') {
      if (typeof value !== 'string' || !value.includes(',')) continue;
      const sigBase64 = value.split(',')[1];
      if (!sigBase64) continue;

      const sigBytes = Uint8Array.from(atob(sigBase64), (c) => c.charCodeAt(0));
      const sigImage = await pdfDoc.embedPng(sigBytes);
      const signatureStyle = resolveSignatureStyle(field.style);
      const layout = calculateSignatureLayout({
        boxWidth: box.width,
        boxHeight: box.height,
        imageAspectRatio: sigImage.width / sigImage.height,
        style: signatureStyle,
      });

      if (layout.xMark) {
        page.drawText('X', {
          x: box.x + layout.xMark.x,
          y: box.top - layout.xMark.y - layout.xMark.fontSize,
          size: layout.xMark.fontSize,
          font: boldFont,
          color: rgb(0, 0, 0),
        });
      }

      if (layout.line) {
        page.drawLine({
          start: { x: box.x + layout.line.x, y: box.top - layout.line.y },
          end: { x: box.x + layout.line.x + layout.line.width, y: box.top - layout.line.y },
          thickness: layout.line.thickness,
          color: rgb(0, 0, 0),
        });
      }

      page.drawImage(sigImage, {
        x: box.x + layout.imageRect.x,
        y: box.top - layout.imageRect.y - layout.imageRect.height,
        width: layout.imageRect.width,
        height: layout.imageRect.height,
      });
      continue;
    }

    let text = typeof value === 'string' ? value.trim() : String(value).trim();
    if (fieldType === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(text)) {
      const parsed = new Date(`${text}T00:00:00`);
      if (!Number.isNaN(parsed.getTime())) {
        text = parsed.toLocaleDateString('en-US');
      }
    }
    if (!text) continue;

    const maxFontSize = Math.max(10, Math.min(box.height * 0.55, fieldType === 'text' ? 18 : 16));
    // Wraps onto multiple lines and shrinks first, then truncates with an
    // ellipsis at the smallest readable size, so even a long value can never
    // draw past the field's box (widthOfTextAtSize has no clipping of its own).
    const { lines, fontSize, lineHeight } = fitTextToBox(
      text,
      box.width,
      box.height,
      maxFontSize,
      (line, size) => textFont.widthOfTextAtSize(line, size),
    );
    const blockHeight = lines.length * lineHeight;
    let y = box.y + Math.max(2, (box.height - blockHeight) / 2) + blockHeight - fontSize;

    for (const line of lines) {
      const lineWidth = textFont.widthOfTextAtSize(line, fontSize);
      const x = box.x + Math.max(4, Math.min(box.width * 0.1, (box.width - lineWidth) / 2));

      try {
        page.drawText(line, {
          x,
          y,
          size: fontSize,
          font: textFont,
          color: rgb(0, 0, 0),
        });
      } catch {
        // Skip unsupported glyphs in WinAnsi fonts.
      }
      y -= lineHeight;
    }
  }

  return await pdfDoc.save();
}

export function downloadPdf(pdfBytes: Uint8Array, fileName: string) {
  const blob = new Blob([pdfBytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName.replace(/\.pdf$/i, '') + '_signed.pdf';
  link.click();
  URL.revokeObjectURL(url);
}
