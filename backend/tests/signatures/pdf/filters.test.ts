/**
 * Decoding a stream without holding the event loop.
 *
 * A single FlateDecode stream may inflate to 64 MiB. Inflating that
 * synchronously stalls every request on the instance for as long as zlib runs,
 * on one vCPU shared with 80 concurrent requests. zlib's asynchronous form runs
 * on the threadpool and lets the loop keep serving.
 *
 * What has to break for these to go red: return to `inflateSync` (the first
 * test finds no promise and no tick in between), or drop the output bound (the
 * second test decodes past it).
 */
import zlib from 'zlib';
import { decodeStream, decodeStreamSync, MAX_DECODED_BYTES } from '../../../src/modules/signatures/pdf/filters';
import { Lexer } from '../../../src/modules/signatures/pdf/lexer';
import type { PdfDict } from '../../../src/modules/signatures/pdf/types';

const dict = (source: string) => new Lexer(new Uint8Array(Buffer.from(source, 'latin1'))).readValue() as PdfDict;
const flate = dict('<< /Filter /FlateDecode >>');

describe('decodeStream', () => {
  it('inflates off the event loop', async () => {
    const body = Buffer.alloc(16 * 1024 * 1024, 0x20);
    const encoded = new Uint8Array(zlib.deflateSync(body));
    let ticked = false;
    const tick = setImmediate(() => { ticked = true; });

    const pending = decodeStream(flate, encoded);
    expect(typeof (pending as any)?.then).toBe('function');
    const out = await pending;
    clearImmediate(tick);

    expect(Buffer.from(out).equals(body)).toBe(true);
    expect(ticked).toBe(true);
  });

  it('still refuses output past the decoded bound', async () => {
    const encoded = new Uint8Array(zlib.deflateSync(Buffer.alloc(MAX_DECODED_BYTES + 1, 0x20)));
    await expect(decodeStream(flate, encoded)).rejects.toThrow();
  });

  it('decodes ASCIIHex to exactly the bytes it spells', async () => {
    const hex = dict('<< /Filter /ASCIIHexDecode >>');
    const out = await decodeStream(hex, new Uint8Array(Buffer.from('48 65 6c6C6f 7>', 'latin1')));
    expect(Buffer.from(out).toString('latin1')).toBe('Hellop');
  });

  it('keeps a synchronous form that decodes the same bytes', () => {
    const body = Buffer.from('small image samples');
    expect(Buffer.from(decodeStreamSync(flate, new Uint8Array(zlib.deflateSync(body)))).equals(body)).toBe(true);
  });
});
