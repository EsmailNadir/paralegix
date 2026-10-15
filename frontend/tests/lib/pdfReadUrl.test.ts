/**
 * Reading a signed url's own expiry and version.
 *
 * Both drive decisions that are invisible when they go wrong. Misreading the
 * expiry means either a url that is reminted every few seconds or one that is
 * never reminted and simply stops serving pages partway through a document.
 * Misreading the version means either a warning shown to every reader on a
 * bucket that does not version its objects, or, far worse, a replaced document
 * swapped in under someone reading the one it replaced.
 */
import {
  msUntilReadUrlRefresh,
  readUrlExpiresAt,
  readUrlGeneration,
  readUrlVersionChanged,
  READ_URL_REFRESH_MARGIN_MS,
} from '@/lib/pdfReadUrl';

const V4 =
  'https://storage.googleapis.com/bucket/doc.pdf' +
  '?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Date=20260909T120000Z&X-Goog-Expires=900' +
  '&generation=1700000000000001&X-Goog-Signature=abc';

const ISSUED_AT = Date.UTC(2026, 8, 9, 12, 0, 0);

describe('when a url lapses', () => {
  it('reads a V4 url as its issue time plus its lifetime', () => {
    expect(readUrlExpiresAt(V4)).toBe(ISSUED_AT + 900_000);
  });

  it('reads a V2 url from its absolute Expires', () => {
    const at = Math.floor(ISSUED_AT / 1000) + 600;
    expect(readUrlExpiresAt(`https://x/doc.pdf?Expires=${at}&Signature=abc`)).toBe(at * 1000);
  });

  it('says nothing about a url that carries no expiry', () => {
    // Null has to stay distinguishable from "expires now", or every unsigned url
    // would be reminted the moment it was opened.
    expect(readUrlExpiresAt('https://x/doc.pdf')).toBeNull();
    expect(readUrlExpiresAt('https://x/doc.pdf?a=1')).toBeNull();
    expect(readUrlExpiresAt(null)).toBeNull();
  });
});

describe('when to remint', () => {
  it('waits until the margin before the url lapses', () => {
    const now = ISSUED_AT;
    expect(msUntilReadUrlRefresh(V4, now)).toBe(900_000 - READ_URL_REFRESH_MARGIN_MS);
  });

  it('remints immediately for a url already inside the margin', () => {
    expect(msUntilReadUrlRefresh(V4, ISSUED_AT + 900_000 - 1_000)).toBe(0);
    expect(msUntilReadUrlRefresh(V4, ISSUED_AT + 3_600_000)).toBe(0);
  });

  it('never schedules one for a url with no expiry', () => {
    expect(msUntilReadUrlRefresh('https://x/doc.pdf', ISSUED_AT)).toBeNull();
  });

  it('clamps a delay past what a timer can hold, which would otherwise fire at once', () => {
    const far = Math.floor(ISSUED_AT / 1000) + 60 * 24 * 3600;
    const delay = msUntilReadUrlRefresh(`https://x/doc.pdf?Expires=${far}`, ISSUED_AT)!;
    expect(delay).toBe(2_147_483_647);
  });
});

describe('whether a remint points at different bytes', () => {
  it('is true only when both urls name a generation and they differ', () => {
    const a = 'https://x/doc.pdf?generation=1&sig=a';
    const b = 'https://x/doc.pdf?generation=2&sig=b';
    expect(readUrlVersionChanged(a, b)).toBe(true);
  });

  it('is false for the same object reminted', () => {
    expect(readUrlVersionChanged(
      'https://x/doc.pdf?generation=1&sig=a',
      'https://x/doc.pdf?generation=1&sig=b',
    )).toBe(false);
  });

  it('is false when either url does not name a generation', () => {
    // Unknowable, not unchanged. Guessing "changed" here would put a warning in
    // front of every reader on a bucket that is not generation-bound.
    expect(readUrlVersionChanged('https://x/doc.pdf?sig=a', 'https://x/doc.pdf?generation=2')).toBe(false);
    expect(readUrlVersionChanged('https://x/doc.pdf?generation=1', 'https://x/doc.pdf?sig=b')).toBe(false);
    expect(readUrlGeneration('https://x/doc.pdf')).toBeNull();
  });
});
