/**
 * An incremental SHA-256, because WebCrypto has no incremental digest.
 *
 * `crypto.subtle.digest` takes one contiguous buffer, so hashing a picked file
 * with it means `await file.arrayBuffer()`: the entire document resident in the
 * tab at once. Resumable uploads exist here precisely because a deposition
 * video or a discovery production can be several gigabytes, so that allocation
 * is the failure, not an implementation detail. A hasher fed one slice at a
 * time costs the slice and nothing more.
 *
 * `createSha256Hasher` is deliberately SELF-CONTAINED: every constant it needs
 * is declared inside it, and it closes over nothing at module scope. That is
 * what lets `fileFingerprint` stringify it into a Web Worker script, which is
 * where the hashing actually runs. A reference to anything outside the function
 * body compiles, passes a normal import, and then throws a ReferenceError only
 * inside the worker.
 */

export interface Sha256Hasher {
  /** Absorb the next slice of the message. May be called any number of times. */
  update(bytes: Uint8Array): void;
  /** Finish and return the digest as 64 lowercase hex characters. */
  hex(): string;
}

export function createSha256Hasher(): Sha256Hasher {
  // Declared here rather than at module scope so the function stringifies into
  // a runnable standalone worker script. See the note above.
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  /** The 64-byte block being filled, and how much of it is used. */
  const block = new Uint8Array(64);
  let blockLength = 0;
  /** Total message length in BYTES. The padding appends it as a count of bits. */
  let totalBytes = 0;
  const w = new Uint32Array(64);

  const rotr = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));

  const compress = (chunk: Uint8Array, offset: number) => {
    for (let i = 0; i < 16; i += 1) {
      const at = offset + i * 4;
      w[i] = (chunk[at] << 24) | (chunk[at + 1] << 16) | (chunk[at + 2] << 8) | chunk[at + 3];
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    let a = h[0]; let b = h[1]; let c = h[2]; let d = h[3];
    let e = h[4]; let f = h[5]; let g = h[6]; let hh = h[7];

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + K[i] + w[i]) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;

      hh = g; g = f; f = e;
      e = (d + temp1) | 0;
      d = c; c = b; b = a;
      a = (temp1 + temp2) | 0;
    }

    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  };

  let finished = false;

  return {
    update(bytes: Uint8Array): void {
      if (finished) throw new Error('sha256: update after the digest was taken');
      totalBytes += bytes.length;
      let at = 0;

      // Top up a partially filled block first, so a caller feeding three bytes
      // at a time produces the same digest as one feeding a megabyte.
      if (blockLength > 0) {
        const wanted = Math.min(64 - blockLength, bytes.length);
        block.set(bytes.subarray(0, wanted), blockLength);
        blockLength += wanted;
        at = wanted;
        if (blockLength === 64) {
          compress(block, 0);
          blockLength = 0;
        }
      }

      // Whole blocks straight out of the caller's slice, with no copy.
      while (at + 64 <= bytes.length) {
        compress(bytes, at);
        at += 64;
      }

      if (at < bytes.length) {
        block.set(bytes.subarray(at), 0);
        blockLength = bytes.length - at;
      }
    },

    hex(): string {
      if (!finished) {
        finished = true;

        // Padding: a single 1 bit, zeroes, then the message length in bits as a
        // big-endian 64-bit value. When fewer than 9 bytes are left in the
        // block the length spills into one more block.
        const tail = new Uint8Array(blockLength < 56 ? 64 : 128);
        tail.set(block.subarray(0, blockLength), 0);
        tail[blockLength] = 0x80;

        // Length in BITS, over 64 bits. Files here exceed 2^32 bits (512 MB)
        // routinely, so the high word is not decorative: written as 32 bits the
        // digest silently disagrees with every other SHA-256 implementation
        // above that size.
        const bits = totalBytes * 8;
        const high = Math.floor(bits / 0x100000000);
        const low = bits >>> 0;
        const lengthAt = tail.length - 8;
        tail[lengthAt] = (high >>> 24) & 0xff;
        tail[lengthAt + 1] = (high >>> 16) & 0xff;
        tail[lengthAt + 2] = (high >>> 8) & 0xff;
        tail[lengthAt + 3] = high & 0xff;
        tail[lengthAt + 4] = (low >>> 24) & 0xff;
        tail[lengthAt + 5] = (low >>> 16) & 0xff;
        tail[lengthAt + 6] = (low >>> 8) & 0xff;
        tail[lengthAt + 7] = low & 0xff;

        for (let at = 0; at < tail.length; at += 64) compress(tail, at);
      }

      let out = '';
      for (let i = 0; i < 8; i += 1) {
        out += (h[i] >>> 0).toString(16).padStart(8, '0');
      }
      return out;
    },
  };
}

/** The digest of one contiguous buffer, for a message already in memory. */
export function sha256Hex(bytes: Uint8Array): string {
  const hasher = createSha256Hasher();
  hasher.update(bytes);
  return hasher.hex();
}
