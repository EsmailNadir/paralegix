/**
 * A SHA-256 that can be put down and picked up again.
 *
 * Signing a document digests every byte of it. Doing that at finalize time
 * means reading the whole document a second time, after preparation already
 * read it once, and for a 2 GB file that is the single largest cost in the
 * operation. It is also pure waste: preparation already hashed exactly those
 * bytes, and the bytes cannot have changed, because the object they live in is
 * immutable and pinned to a generation.
 *
 * So preparation SAVES the hash state after the last byte of the source, and
 * finalize LOADS it and feeds only the appended suffix. Node's `crypto.Hash`
 * cannot do this: there is no way to export its internal state. `hash-wasm` can,
 * and produces the same digest as Node for the same bytes, which
 * `assertDigestParity` proves rather than assumes.
 *
 * Two things make a saved state dangerous, and both are checked before it is
 * used. A state describes ONE byte sequence: resuming it over a different
 * document produces a digest of bytes that were never together in any file, and
 * that digest signs successfully. And a state written by a different build of
 * the hashing library may have a different internal layout, so loading it
 * either fails or, worse, succeeds with the wrong words. A state that does not
 * pass both checks is not repaired and not trusted. The full re-read runs
 * instead.
 *
 * One property worth knowing: a saved state carries the current partial block,
 * so up to 63 bytes of the document sit inside it in the clear. The state is
 * stored beside the document it describes, under the same access control, so
 * this reveals nothing new. It is a reason not to move a state anywhere the
 * document itself may not go.
 */
import { createHash } from 'crypto';
import { AppError } from '../../../shared/errors/AppError';

/**
 * Bumped by hand when the hashing library's state layout may have changed.
 *
 * A state stamped with a different value is discarded, not loaded. Loading a
 * state whose layout moved is the failure this exists to prevent, and it is
 * silent: the words land in the wrong fields and the digest is wrong without
 * any error.
 */
export const DIGEST_STATE_VERSION = 'sha256:hash-wasm@4';

/** Exactly what `hash-wasm` writes for SHA-256, checked before a load. */
const SHA256_STATE_BYTES = 116;

export class DigestStateError extends AppError {
  constructor(message: string) {
    super(message, 500, 'DIGEST_STATE_UNUSABLE');
  }
}

/**
 * The source is not the one the saved state describes.
 *
 * This is deliberately not recoverable by re-hashing. If the object under the
 * path changed, then whatever preparation stamped, positioned and measured was
 * done against different bytes, so the whole operation is stale, not just the
 * digest.
 */
export class SourceChangedError extends AppError {
  constructor(message: string) {
    super(message, 409, 'SOURCE_CHANGED');
  }
}

/** A saved position in a hash, plus everything needed to distrust it. */
export interface SavedDigestState {
  version: string;
  /** Opaque to everything outside this file. */
  state: Uint8Array;
  /** How many bytes the state has absorbed. */
  bytes: number;
  objectPath: string;
  /** A string, because a GCS generation does not survive a JS number. */
  generation: string;
}

/** What the source must be for a saved state to apply to it. */
export interface DigestSourceIdentity {
  objectPath: string;
  generation: string;
  sizeBytes: number;
}

export interface ResumableDigest {
  /** Absorb bytes, in order. */
  update(bytes: Uint8Array): void;
  /** How many bytes this digest has absorbed. */
  absorbed(): number;
  /** Save the position. Does not end the digest. */
  save(identity: DigestSourceIdentity): SavedDigestState;
  /** Finish. The instance is not usable afterwards. */
  digestHex(): string;
}

// hash-wasm ships as ESM-and-CJS and the CommonJS build is what this tree
// requires. The dynamic shape is loaded once and reused: the wasm module behind
// it is compiled per process, and re-requiring would not recompile it but would
// still cost a resolution on every signature.
const hashWasm = require('hash-wasm');

function wrap(instance: any, absorbedAlready: number): ResumableDigest {
  let absorbed = absorbedAlready;
  let finished = false;
  return {
    update(bytes: Uint8Array) {
      if (finished) throw new DigestStateError('This digest is already finished.');
      instance.update(bytes);
      absorbed += bytes.length;
    },
    absorbed() {
      return absorbed;
    },
    save(identity: DigestSourceIdentity): SavedDigestState {
      if (finished) throw new DigestStateError('This digest is already finished.');
      if (absorbed !== identity.sizeBytes) {
        // A state saved partway through an object would resume from the middle
        // of it, and nothing downstream could tell.
        throw new DigestStateError(
          `The digest has absorbed ${absorbed} bytes but the source is ${identity.sizeBytes}.`,
        );
      }
      return {
        version: DIGEST_STATE_VERSION,
        state: Uint8Array.from(instance.save()),
        bytes: absorbed,
        objectPath: identity.objectPath,
        generation: identity.generation,
      };
    },
    digestHex(): string {
      if (finished) throw new DigestStateError('This digest is already finished.');
      finished = true;
      return instance.digest('hex');
    },
  };
}

/** A fresh SHA-256 that can be saved. */
export async function createResumableDigest(): Promise<ResumableDigest> {
  const instance = await hashWasm.createSHA256();
  instance.init();
  return wrap(instance, 0);
}

/**
 * Resume a saved state, or refuse.
 *
 * The identity check runs before the load, because a state that loads cleanly
 * and describes another document is the dangerous case, not the one that throws.
 */
export async function resumeDigest(
  saved: SavedDigestState,
  identity: DigestSourceIdentity,
): Promise<ResumableDigest> {
  if (saved.objectPath !== identity.objectPath || saved.generation !== identity.generation) {
    throw new SourceChangedError(
      `The saved digest covers ${saved.objectPath}#${saved.generation}, not ${identity.objectPath}#${identity.generation}.`,
    );
  }
  if (saved.bytes !== identity.sizeBytes) {
    throw new SourceChangedError(
      `The saved digest covers ${saved.bytes} bytes but the source is ${identity.sizeBytes}.`,
    );
  }
  if (saved.version !== DIGEST_STATE_VERSION) {
    throw new DigestStateError(`The saved digest was written by ${saved.version}, not ${DIGEST_STATE_VERSION}.`);
  }
  if (saved.state.length !== SHA256_STATE_BYTES) {
    throw new DigestStateError(`A SHA-256 state is ${SHA256_STATE_BYTES} bytes, not ${saved.state.length}.`);
  }
  const instance = await hashWasm.createSHA256();
  try {
    instance.load(saved.state);
  } catch (err: any) {
    throw new DigestStateError(`The saved digest state would not load: ${err?.message || err}.`);
  }
  return wrap(instance, saved.bytes);
}

/**
 * Prove the two SHA-256 implementations in this process agree, then keep the
 * answer.
 *
 * Independent verification of a signature is done with OpenSSL, over bytes
 * Node hashed. Every one of those checks rests on `hash-wasm` and Node
 * computing the same function. That is true, and it is worth failing loudly at
 * startup rather than discovering it from a signature nobody can verify.
 *
 * The split is at 100 bytes on purpose. SHA-256 works in 64-byte blocks, so a
 * save at a block boundary would carry no partial block and would pass even if
 * the buffered tail were dropped. 100 leaves 36 bytes buffered.
 */
let parityChecked: Promise<void> | null = null;

export function assertDigestParity(): Promise<void> {
  if (!parityChecked) parityChecked = runParityCheck();
  return parityChecked;
}

async function runParityCheck(): Promise<void> {
  const known = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  const abc = await createResumableDigest();
  abc.update(Buffer.from('abc', 'latin1'));
  const got = abc.digestHex();
  if (got !== known) {
    throw new DigestStateError(`SHA-256 of "abc" came back as ${got}, not the published vector.`);
  }

  const sample = Buffer.alloc(257);
  for (let i = 0; i < sample.length; i += 1) sample[i] = (i * 37 + 11) & 0xff;
  const head = sample.subarray(0, 100);
  const tail = sample.subarray(100);

  const first = await createResumableDigest();
  first.update(head);
  const state = first.save({ objectPath: 'parity', generation: '1', sizeBytes: head.length });
  const second = await resumeDigest(state, { objectPath: 'parity', generation: '1', sizeBytes: head.length });
  second.update(tail);
  const resumed = second.digestHex();

  const node = createHash('sha256').update(sample).digest('hex');
  if (resumed !== node) {
    throw new DigestStateError(`A resumed SHA-256 gave ${resumed} where Node gave ${node}.`);
  }
}
