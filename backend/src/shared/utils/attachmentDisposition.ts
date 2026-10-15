/**
 * Content-Disposition policy for signed attachment URLs.
 *
 * Browsers will execute script from certain "active content" types (HTML, SVG,
 * XML, ...) when they're served `inline` from our origin, which is an XSS
 * vector. Those types are always forced to `attachment` (download); everything
 * else (pdf, images, office docs, media) stays `inline` so in-app previews keep
 * working. Shared so every signing path (files, messaging, task/note
 * attachments) applies the same rule.
 */

const DANGEROUS_INLINE_MIME_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/xml', // can carry inline scripts / XSLT
  'text/xml',
  'application/xhtml',
]);

const DANGEROUS_INLINE_EXTENSIONS = new Set([
  'html', 'htm', 'xhtml', 'shtml', 'svg', 'svgz', 'xml', 'xsl', 'xslt', 'mhtml', 'mht',
]);

function getExtension(name: unknown): string {
  if (typeof name !== 'string') return '';
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Whether a file (by mimetype + filename) is safe to serve with
 * `Content-Disposition: inline`. Dangerous active-content types download.
 */
export function isInlineSafe(contentType?: string | null, fileName?: string | null): boolean {
  const mime = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (DANGEROUS_INLINE_MIME_TYPES.has(mime)) return false;
  if (DANGEROUS_INLINE_EXTENSIONS.has(getExtension(fileName))) return false;
  return true;
}

/**
 * Builds the `responseDisposition` for a signed read URL. Dangerous types are
 * forced to `attachment`; everything else stays `inline`.
 */
export function dispositionFor(contentType?: string | null, fileName?: string | null): string {
  const kind = isInlineSafe(contentType, fileName) ? 'inline' : 'attachment';
  return fileName ? `${kind}; filename="${fileName}"` : kind;
}
