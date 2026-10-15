// pdf-lib's standard fonts (Helvetica, etc.) use WinAnsi (CP1252) encoding and
// throw on any glyph outside it. User-entered strings drawn on the certificate
// (signer names, file titles, consent text, device/user-agent strings) can carry
// characters WinAnsi cannot encode (Cyrillic, CJK, emoji, extended Latin), which
// would crash certificate generation. Map common smart punctuation to ASCII and
// replace any remaining non-encodable character with '?', so drawing and width
// measurement never throw.
const SMART_PUNCTUATION = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"',
  '–': '-', '—': '-', '―': '-', '−': '-',
  '…': '...', ' ': ' ', '•': '-', '‹': '<', '›': '>',
};

export function sanitizeForStandardFont(value: any) {
  const text = value === null || value === undefined ? '' : String(value);
  let out = '';
  for (const ch of text) {
    const smart = (SMART_PUNCTUATION as Record<string, string | undefined>)[ch];
    if (smart !== undefined) {
      out += smart;
      continue;
    }
    // A string iterated by code point always yields a non-empty char here.
    const code = ch.codePointAt(0) as number;
    // Printable ASCII and the Latin-1 supplement (0xA0-0xFF) are WinAnsi-encodable
    // (this preserves common accented Latin names such as e-acute, n-tilde).
    if ((code >= 0x20 && code <= 0x7E) || (code >= 0xA0 && code <= 0xFF)) {
      out += ch;
      continue;
    }
    if (ch === '\t') {
      out += ' ';
      continue;
    }
    out += '?';
  }
  return out;
}

/**
 * Format an ISO timestamp string to a human-readable date.
 * e.g. "March 28, 2026, 2:15:00 PM UTC"
 */
export function formatTimestamp(isoString: any) {
  if (!isoString) return 'N/A';
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return 'N/A';
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZone: 'UTC',
    timeZoneName: 'short',
  });
}

/**
 * Cap a user agent string for display so an unusually long header does not
 * dominate the certificate. The full value remains on the audit record.
 */

/**
 * Word-wrap text to fit within maxWidth at the given font/size.
 * Returns an array of lines.
 */
export function wrapText(text: any, font: any, fontSize: any, maxWidth: any) {
  // Sanitize first so neither width measurement nor drawing hits a glyph the
  // standard font cannot encode.
  const words = sanitizeForStandardFont(text).split(/\s+/);
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const testWidth = font.widthOfTextAtSize(testLine, fontSize);
    if (testWidth > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}
