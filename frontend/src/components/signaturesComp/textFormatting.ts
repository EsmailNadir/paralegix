import { FONT_FAMILIES } from '@/types/signature';

/** Check if the current document selection is inside a text annotation contentEditable */
export function getActiveEditorInfo(): { el: HTMLDivElement; annotationId: string } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.anchorNode) return null;

  const node = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode.parentElement;
  if (!node) return null;

  const editable = node.closest('[contenteditable]') as HTMLDivElement | null;
  if (!editable) return null;

  const wrapper = editable.closest('[data-annotation-id]');
  const annotationId = wrapper?.getAttribute('data-annotation-id');
  if (!annotationId) return null;

  return { el: editable, annotationId };
}

function splitFontStack(css: string): string[] {
  return css
    .replace(/['"]/g, '')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Map CSS font-family (computed or command) to our internal FONT_FAMILIES value */
export function mapCssToFontValue(css: string): string {
  const requested = splitFontStack(css);
  const primary = requested[0] || '';
  const joined = requested.join(' ');

  if (!primary) return 'Helvetica';

  // A face identifies itself by the FIRST entry of its stack. Matching the
  // requested face against a candidate's own primary face has to come before
  // any fallback matching, because stacks name each other: Cambria ships as
  // "Cambria, Georgia, serif" and sits above Georgia in FONT_FAMILIES, so a
  // single pass over every token answered "Georgia, serif" with Cambria. The
  // toolbar then showed the wrong face and saving wrote it into the signature.
  for (const f of FONT_FAMILIES) {
    if (splitFontStack(f.css)[0] === primary) return f.value;
  }

  // Only once no face claims the name as its own does a fallback count. This is
  // what resolves a bare generic like "sans-serif" or a shared fallback like
  // "Geneva", which no stack leads with.
  for (const f of FONT_FAMILIES) {
    if (splitFontStack(f.css).slice(1).some((t) => t === primary)) return f.value;
  }

  for (const f of FONT_FAMILIES) {
    if (primary.includes(f.value.toLowerCase())) return f.value;
  }

  for (const f of FONT_FAMILIES) {
    const tokens = splitFontStack(f.css);
    for (const t of tokens) {
      if (t.length < 4) continue;
      if (primary.includes(t) || t.includes(primary)) return f.value;
    }
  }

  if (joined.includes('times')) return 'Times-Roman';
  if (joined.includes('courier')) return 'Courier';
  return 'Helvetica';
}

/** Re-select the content covered by the given spans */
export function reselectSpans(spans: HTMLSpanElement[]) {
  if (spans.length === 0) return;
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  const first = spans[0];
  const last = spans[spans.length - 1];
  range.setStart(first, 0);
  range.setEnd(last, last.childNodes.length);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Apply font size to the current selection using execCommand + fixup */
export function applyFontSizeToSelection(size: number) {
  // Use fontSize 1 as a marker, then replace <font size="1"> with <span style>
  document.execCommand('fontSize', false, '1');

  const info = getActiveEditorInfo();
  if (!info) return;

  const spans: HTMLSpanElement[] = [];
  info.el.querySelectorAll('font[size="1"]').forEach((font) => {
    const span = document.createElement('span');
    span.style.fontSize = `${size}px`;
    while (font.firstChild) span.appendChild(font.firstChild);
    font.parentNode?.replaceChild(span, font);
    spans.push(span);
  });
  reselectSpans(spans);
}

/** Apply font family to the current selection using execCommand + fixup */
export function applyFontFamilyToSelection(cssFamily: string) {
  document.execCommand('fontName', false, '__paralegix_marker__');

  const info = getActiveEditorInfo();
  if (!info) return;

  const spans: HTMLSpanElement[] = [];
  info.el.querySelectorAll('font[face="__paralegix_marker__"]').forEach((font) => {
    const span = document.createElement('span');
    span.style.fontFamily = cssFamily;
    while (font.firstChild) span.appendChild(font.firstChild);
    font.parentNode?.replaceChild(span, font);
    spans.push(span);
  });
  reselectSpans(spans);
}

/** Apply text color to the current selection using execCommand + fixup */
export function applyColorToSelection(color: string) {
  document.execCommand('foreColor', false, color);

  const info = getActiveEditorInfo();
  if (!info) return;

  // Replace <font color> tags created by execCommand with styled spans
  const spans: HTMLSpanElement[] = [];
  info.el.querySelectorAll('font[color]').forEach((font) => {
    const span = document.createElement('span');
    span.style.color = (font as HTMLElement).getAttribute('color') || color;
    while (font.firstChild) span.appendChild(font.firstChild);
    font.parentNode?.replaceChild(span, font);
    spans.push(span);
  });
  reselectSpans(spans);
}

/** Convert browser foreColor value (rgb or hex) to hex string */
export function foreColorToHex(value: string): string {
  if (value.startsWith('#')) return value;
  const match = value.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (match) {
    const r = parseInt(match[1]).toString(16).padStart(2, '0');
    const g = parseInt(match[2]).toString(16).padStart(2, '0');
    const b = parseInt(match[3]).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
  }
  return '#000000';
}
