/**
 * `shared/documentConversion/contract.ts` - pure unit tests.
 *
 * Every route that converts a document (templates fill/preview, the overlay
 * upload, signatures) funnels its errors through `conversionError()` before
 * they reach a caller. It exists specifically to keep a third-party adapter's
 * raw failure text out of the HTTP response (AGENTS.md: "the handler never
 * exposes 5xx messages or third-party SDK ... messages to clients"), and to
 * turn "the converter binary/worker is unavailable" into a distinct,
 * retriable 503 rather than folding it into the same 422 a genuinely corrupt
 * document gets. Neither of those two behaviours had a test anywhere in the
 * repo before this file, even though `templateOverlayUpload.test.ts` and the
 * signing conversion paths depend on `conversionError` doing this correctly
 * every time a LibreOffice/worker call fails.
 *
 *   __TEST_TOKEN__=offline npx jest tests/shared/documentConversion.test.ts
 */
const { getOutputFormat, conversionError, FORMAT_MAP } = require('../../src/shared/documentConversion/contract');

describe('getOutputFormat', () => {
  it('passes through every format the converters actually support', () => {
    for (const format of Object.keys(FORMAT_MAP)) {
      expect(getOutputFormat(format)).toBe(format);
    }
  });

  it('refuses an unsupported format with a clean 400 naming the supported list', () => {
    expect.assertions(3);
    try {
      getOutputFormat('exe');
    } catch (err: any) {
      expect(err.statusCode).toBe(400);
      expect(err.message).toMatch(/Unsupported output format/);
      // Names what IS accepted, so the caller does not have to guess from a
      // generic refusal.
      expect(err.message).toMatch(/pdf, docx, doc, odt, rtf, txt/);
    }
  });
});

describe('conversionError', () => {
  it('leaves an already-typed error (one the app itself threw) alone', () => {
    const original: any = new Error('Unsupported output format: "exe"');
    original.statusCode = 400;

    const wrapped = conversionError(original);

    expect(wrapped).toBe(original);
    expect(wrapped.statusCode).toBe(400);
  });

  it('maps a missing-soffice-binary failure to a distinct, retriable 503', () => {
    // The exact substring localConverter.ts's LibreOffice adapter throws when
    // the binary is not on PATH at all - the "this instance cannot convert
    // anything right now" case, not "this document is bad".
    const raw = new Error('Error: Could not find soffice binary');

    const wrapped = conversionError(raw);

    expect(wrapped.statusCode).toBe(503);
    expect(wrapped.code).toBe('CONVERSION_UNAVAILABLE');
    expect(wrapped.message).toMatch(/temporarily unavailable/i);
    // The raw adapter string never reaches the surfaced message.
    expect(wrapped.message).not.toMatch(/soffice/i);
  });

  it('maps every other adapter failure to a 422 without leaking the provider text', () => {
    const raw = new Error('libreoffice-convert: spawn ENOENT /usr/bin/soffice --headless --convert-to pdf');

    const wrapped = conversionError(raw);

    expect(wrapped.statusCode).toBe(422);
    expect(wrapped.code).toBe('CONVERSION_FAILED');
    expect(wrapped.message).toMatch(/corrupt|password-protected|unsupported/i);
    expect(wrapped.message).not.toMatch(/ENOENT/);
    expect(wrapped.message).not.toMatch(/spawn|soffice/i);
  });

  it('handles an adapter throwing something that is not even an Error', () => {
    // A rejected promise can carry anything; a converter or a network layer
    // rejecting with a plain string or undefined must not crash the mapper
    // itself while it is trying to produce a clean error for the caller.
    expect(() => conversionError(undefined)).not.toThrow();
    expect(() => conversionError('a plain string failure')).not.toThrow();
    const wrapped = conversionError('a plain string failure');
    expect(wrapped.statusCode).toBe(422);
  });
});
