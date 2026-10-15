/**
 * Content-Disposition policy for signed attachment URLs - pure unit tests.
 *
 * Signed GCS read URLs serve firm documents from an origin the app trusts. A
 * browser will execute script out of an HTML or SVG file served `inline`, so any
 * member who can upload one and get another member to open its preview has
 * stored XSS with the victim's session. Forcing those types to `attachment` is
 * the whole mitigation, and it is one `Set` entry away from being bypassed by a
 * near-miss extension or a mimetype with a charset parameter on it.
 *
 * Every signing path (files, messaging, task and note attachments) shares this
 * decision, so a gap here is a gap everywhere at once.
 *
 *   __TEST_TOKEN__=offline npx jest tests/shared/attachmentDisposition.test.ts
 */

const { isInlineSafe, dispositionFor } = require('../../src/shared/utils/attachmentDisposition');

describe('isInlineSafe', () => {
  test.each([
    ['text/html', 'page.html'],
    ['image/svg+xml', 'logo.svg'],
    ['application/xhtml+xml', 'doc.xhtml'],
    ['application/xml', 'data.xml'],
    ['text/xml', 'data.xml'],
  ])('active content is never inline (%s)', (mime, name) => {
    expect({ mime, safe: isInlineSafe(mime, name) }).toEqual({ mime, safe: false });
  });

  test.each([
    ['application/pdf', 'contract.pdf'],
    ['image/png', 'scan.png'],
    ['image/jpeg', 'photo.jpg'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'brief.docx'],
    ['video/mp4', 'deposition.mp4'],
    ['text/plain', 'notes.txt'],
  ])('ordinary documents stay inline (%s)', (mime, name) => {
    // A false positive breaks in-app preview for real documents, so the rule has
    // to be narrow as well as complete.
    expect({ mime, safe: isInlineSafe(mime, name) }).toEqual({ mime, safe: true });
  });

  test('a dangerous extension is caught even when the mimetype looks harmless', () => {
    // Both halves are client-supplied. Trusting either one alone is the bypass.
    expect(isInlineSafe('application/pdf', 'invoice.html')).toBe(false);
    expect(isInlineSafe('application/octet-stream', 'logo.svg')).toBe(false);
    expect(isInlineSafe('image/png', 'payload.xhtml')).toBe(false);
  });

  test('a dangerous mimetype is caught even when the name looks harmless', () => {
    expect(isInlineSafe('text/html', 'receipt.pdf')).toBe(false);
    expect(isInlineSafe('image/svg+xml', 'photo.png')).toBe(false);
  });

  test('a charset parameter does not smuggle a type past the check', () => {
    // `text/html; charset=utf-8` is what a real upload actually carries.
    expect(isInlineSafe('text/html; charset=utf-8', 'x.pdf')).toBe(false);
    expect(isInlineSafe('TEXT/HTML', 'x.pdf')).toBe(false);
    expect(isInlineSafe('  text/html  ', 'x.pdf')).toBe(false);
  });

  test('extension matching ignores case and reads only the final segment', () => {
    expect(isInlineSafe('application/pdf', 'REPORT.SVG')).toBe(false);
    expect(isInlineSafe('application/pdf', 'archive.svg.pdf')).toBe(true);
    expect(isInlineSafe('application/pdf', 'notes.html.pdf')).toBe(true);
  });

  test('a name that merely contains a dangerous word is not a dangerous type', () => {
    expect(isInlineSafe('application/pdf', 'html.pdf')).toBe(true);
    expect(isInlineSafe('application/pdf', 'svg-guidelines.pdf')).toBe(true);
    expect(isInlineSafe('application/pdf', 'file.htmlx')).toBe(true);
  });

  test('missing type and name default to inline rather than throwing', () => {
    // Callers pass values straight off storage metadata, which can be absent.
    expect(isInlineSafe(null, null)).toBe(true);
    expect(isInlineSafe(undefined, undefined)).toBe(true);
    expect(isInlineSafe('', '')).toBe(true);
  });

  test('a trailing dot is not an extension', () => {
    expect(isInlineSafe('application/pdf', 'weird.')).toBe(true);
    expect(isInlineSafe('application/pdf', 'noextension')).toBe(true);
  });
});

describe('dispositionFor', () => {
  test('forces a download for active content and names the file', () => {
    expect(dispositionFor('text/html', 'evil.html')).toBe('attachment; filename="evil.html"');
    expect(dispositionFor('image/svg+xml', 'logo.svg')).toBe('attachment; filename="logo.svg"');
  });

  test('previews an ordinary document in place', () => {
    expect(dispositionFor('application/pdf', 'contract.pdf')).toBe('inline; filename="contract.pdf"');
  });

  test('omits the filename clause when there is no name', () => {
    expect(dispositionFor('application/pdf', null)).toBe('inline');
    expect(dispositionFor('text/html', null)).toBe('attachment');
  });

  test('the two functions never disagree', () => {
    // dispositionFor is the only caller of the predicate in production, so a
    // divergence would mean the header says one thing and the audit another.
    for (const [mime, name] of [
      ['text/html', 'a.html'],
      ['application/pdf', 'a.pdf'],
      ['image/svg+xml', 'a.pdf'],
      ['application/pdf', 'a.svg'],
    ]) {
      const expected = isInlineSafe(mime, name) ? 'inline' : 'attachment';
      expect({ mime, name, kind: dispositionFor(mime, name).split(';')[0] })
        .toEqual({ mime, name, kind: expected });
    }
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
