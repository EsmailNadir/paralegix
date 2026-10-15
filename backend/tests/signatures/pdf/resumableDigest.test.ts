/**
 * A SHA-256 that survives being put down.
 *
 * Signing resumes a hash that preparation saved, rather than reading the
 * document again. That removes a full pass over what may be gigabytes, and it
 * introduces one specific danger: a state resumed over the WRONG bytes produces
 * a digest of a byte sequence that was never in any file, and that digest signs
 * without complaint. Nothing downstream can tell.
 *
 * So the tests below are in two groups. The first proves the resumed digest
 * equals what Node computes over the same bytes, because independent
 * verification with OpenSSL depends on the two agreeing. The second proves the
 * checks that refuse a state actually refuse.
 */
import crypto from 'crypto';
import {
  assertDigestParity,
  createResumableDigest,
  resumeDigest,
  DigestStateError,
  SourceChangedError,
  DIGEST_STATE_VERSION,
} from '../../../src/modules/signatures/pdf/resumableDigest';
import type { SavedDigestState } from '../../../src/modules/signatures/pdf/resumableDigest';

const IDENTITY = { objectPath: 'firm/doc.pdf', generation: '1730000000000001', sizeBytes: 100 };

/** 257 bytes of non-repeating filler. Not a round number of SHA-256 blocks. */
function sample(): Buffer {
  const bytes = Buffer.alloc(257);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 37 + 11) & 0xff;
  return bytes;
}

async function stateAfter(head: Buffer): Promise<SavedDigestState> {
  const digest = await createResumableDigest();
  digest.update(head);
  return digest.save({ ...IDENTITY, sizeBytes: head.length });
}

describe('agreeing with Node', () => {
  it('matches the published vector for "abc"', async () => {
    const digest = await createResumableDigest();
    digest.update(Buffer.from('abc'));

    expect(digest.digestHex()).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('matches Node when the hash is saved and resumed mid block', async () => {
    // 100 is deliberate. SHA-256 works in 64-byte blocks, so a split on a block
    // boundary carries no partial block, and a state that dropped its buffered
    // tail would still pass. This split leaves 36 bytes buffered.
    const bytes = sample();
    const state = await stateAfter(bytes.subarray(0, 100));

    const resumed = await resumeDigest(state, { ...IDENTITY, sizeBytes: 100 });
    resumed.update(bytes.subarray(100));

    expect(resumed.digestHex()).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
  });

  it('gives the same answer whether the bytes arrive in one piece or many', async () => {
    const bytes = sample();
    const chunked = await createResumableDigest();
    for (let at = 0; at < bytes.length; at += 7) chunked.update(bytes.subarray(at, at + 7));

    expect(chunked.digestHex()).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
  });

  it('resumes the same state twice to the same digest', async () => {
    // The seal does exactly this: once for the covered bytes and once for the
    // whole artifact. A state consumed by the first read would silently give the
    // second one a different starting point.
    const bytes = sample();
    const state = await stateAfter(bytes.subarray(0, 100));

    const first = await resumeDigest(state, { ...IDENTITY, sizeBytes: 100 });
    first.update(bytes.subarray(100));
    const second = await resumeDigest(state, { ...IDENTITY, sizeBytes: 100 });
    second.update(bytes.subarray(100));

    expect(first.digestHex()).toBe(second.digestHex());
  });

  it('proves the parity check itself passes', async () => {
    await expect(assertDigestParity()).resolves.toBeUndefined();
  });
});

describe('refusing a state', () => {
  it('refuses one saved for another object', async () => {
    const state = await stateAfter(sample().subarray(0, 100));

    await expect(resumeDigest(state, { ...IDENTITY, objectPath: 'firm/other.pdf' }))
      .rejects.toThrow(SourceChangedError);
  });

  it('refuses one saved for another generation of the same object', async () => {
    // The dangerous case. Same path, same length, different bytes: the digest
    // would cover a mixture of two versions and would sign cleanly.
    const state = await stateAfter(sample().subarray(0, 100));

    await expect(resumeDigest(state, { ...IDENTITY, generation: '1730000000000002' }))
      .rejects.toThrow(SourceChangedError);
  });

  it('refuses one that stops short of the source length', async () => {
    const state = await stateAfter(sample().subarray(0, 100));

    await expect(resumeDigest(state, { ...IDENTITY, sizeBytes: 257 }))
      .rejects.toThrow(SourceChangedError);
  });

  it('refuses one stamped by another build of the hashing library', async () => {
    const state = { ...(await stateAfter(sample().subarray(0, 100))), version: 'sha256:hash-wasm@3' };

    await expect(resumeDigest(state, IDENTITY)).rejects.toThrow(DigestStateError);
  });

  it('refuses a state of the wrong size', async () => {
    const state = await stateAfter(sample().subarray(0, 100));

    const truncated = { ...state, state: state.state.subarray(0, 64) };

    await expect(resumeDigest(truncated, IDENTITY)).rejects.toThrow(DigestStateError);
  });

  it('reports SOURCE_CHANGED before it reports an unreadable state', async () => {
    // Order matters. A state that names different bytes says the whole
    // operation is stale, which is not something a rebuild can repair.
    const state = await stateAfter(sample().subarray(0, 100));
    const wrong = { ...state, version: 'sha256:hash-wasm@3', objectPath: 'firm/other.pdf' };

    await expect(resumeDigest(wrong, IDENTITY)).rejects.toThrow(SourceChangedError);
  });

  it('refuses to save a state that has not reached the end of the source', async () => {
    const digest = await createResumableDigest();
    digest.update(Buffer.from('short'));

    expect(() => digest.save(IDENTITY)).toThrow(DigestStateError);
  });

  it('refuses to reuse a finished digest', async () => {
    const digest = await createResumableDigest();
    digest.update(Buffer.from('abc'));
    digest.digestHex();

    expect(() => digest.update(Buffer.from('more'))).toThrow(DigestStateError);
  });

  it('stamps the current version on what it saves', async () => {
    const state = await stateAfter(sample().subarray(0, 100));

    expect(state.version).toBe(DIGEST_STATE_VERSION);
    expect(state.bytes).toBe(100);
  });
});
