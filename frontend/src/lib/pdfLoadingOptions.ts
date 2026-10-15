/**
 * What PDF.js is told when a document is opened by url rather than from bytes.
 *
 * Both flags are required and both fail silently on a small file, which is how
 * the first attempt at large-document preview shipped looking correct:
 *
 *   `disableAutoFetch` alone does nothing on its own. PDF.js keeps streaming the
 *   rest of the document in the background once the first pages show, so a
 *   200 MB preview quietly downloaded 200 MB.
 *
 *   `rangeChunkSize` is how much is pulled per request. A mebibyte is a few
 *   pages at a time rather than the whole file.
 *
 * Frozen because it is shared by every viewer: one of them mutating it would
 * change what the others ask for.
 */
export const PDF_RANGE_OPTIONS = Object.freeze({
  rangeChunkSize: 1024 * 1024,
  disableAutoFetch: true,
  disableStream: true,
});

/**
 * The source object handed to react-pdf's `file` prop for a url.
 *
 * react-pdf forwards every field to PDF.js's `getDocument`; its own type for
 * `file` lists only the common ones, hence the cast.
 *
 * Call this INSIDE a `useMemo` keyed on the url. The object must be
 * referentially stable across renders: a fresh one makes react-pdf tear the
 * document down and load it again, which costs more than never setting the
 * range options at all.
 */
export function pdfUrlSource(url: string): { url: string } {
  return { url, ...PDF_RANGE_OPTIONS } as unknown as { url: string };
}

/**
 * The stable part of a read url: everything before the query.
 *
 * A signed url is refreshed by minting a new signature over the SAME object, so
 * only its query changes. Comparing whole urls would read that refresh as a
 * different document and throw away the measurements and scroll position the
 * reader is sitting on.
 */
export function pdfSourceKey(url: string | undefined | null): string {
  if (!url) return '';
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}
