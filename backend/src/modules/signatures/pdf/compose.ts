/**
 * Assembling the signed document without the base ever entering this process.
 *
 * The writer produces a SUFFIX. The finished document is the untouched original
 * followed by that suffix, and joining them here would mean reading the
 * original, which is the entire cost the incremental design removes. Storage
 * composes objects server-side instead, so a 2 GB base costs this process
 * nothing.
 *
 * GCS `compose` takes at most 32 sources per call, so a long list is folded
 * pairwise into a tree rather than appended one at a time. That matters for the
 * degenerate case: composing 1,000 pieces sequentially rewrites the whole
 * accumulated object on every step, which is quadratic in bytes moved.
 *
 * Every input names a GENERATION. A base that changed between the read and the
 * compose would otherwise be silently signed in its new form, with a signature
 * computed over the old one.
 */
import { AppError } from '../../../shared/errors/AppError';
import type { StoredPdf } from './types';

/** GCS composes at most this many sources in one call. */
export const MAX_COMPOSE_SOURCES = 32;

export class PdfComposeError extends AppError {
  constructor(message: string, statusCode = 500, code = 'PDF_COMPOSE_ERROR') {
    super(message, statusCode, code);
  }
}

export interface ComposePart {
  objectPath: string;
  /** Pinned, so a part replaced mid-compose fails rather than being used. */
  generation: string;
}

function bucket() {
  const { admin } = require('../../../shared/database/firebase');
  return admin.storage().bucket(process.env.GCS_BUCKET || 'lawfirms');
}

/** Whether a storage failure means a create-only write lost to an existing object. */
export function isPreconditionFailed(err: any): boolean {
  const code = Number(err?.code) || Number(err?.response?.status);
  return code === 412 || code === 409;
}

/**
 * Compose parts into one object, folding pairwise when there are too many.
 *
 * Intermediates are written under `scratchPrefix` and removed afterwards. They
 * are removed on failure too: a half-composed document left behind is billed
 * storage nobody can identify.
 */
export async function composeParts(options: {
  parts: ComposePart[];
  destination: string;
  scratchPrefix: string;
  contentType?: string;
}): Promise<StoredPdf> {
  const { parts, destination, scratchPrefix, contentType = 'application/pdf' } = options;
  if (parts.length === 0) throw new PdfComposeError('Nothing to compose.');
  if (!scratchPrefix.endsWith('/')) throw new PdfComposeError('A scratch prefix must end with "/".');

  const storage = bucket();
  const intermediates: string[] = [];

  // The generation belongs on the HANDLE, which is what makes a replaced part a
  // failure rather than a silent substitution.
  //
  // This used to read `handle.get?.({ generation }) ?? handle`. `File.get()` is
  // a metadata fetch that answers a PROMISE, so every pinned part reached
  // `combine` as a promise and the storage service refused the body it built:
  // no compose against real storage could succeed. The test double had no
  // `get()`, so the `?? handle` fallback ran there and every test passed.
  const fileFor = (part: ComposePart) => (part.generation
    ? storage.file(part.objectPath, { generation: String(part.generation) })
    : storage.file(part.objectPath));

  const composeOnce = async (sources: ComposePart[], target: string, createOnly: boolean) => {
    if (sources.length > MAX_COMPOSE_SOURCES) {
      throw new PdfComposeError(`Cannot compose ${sources.length} sources in one call.`);
    }
    await storage.combine(
      sources.map(fileFor),
      storage.file(target),
      {
        contentType,
        sourceGenerations: sources.map((s) => s.generation),
        // A create-only destination refuses to overwrite, which is what makes a
        // retried attempt safe: the second one fails rather than clobbering a
        // document the first already produced.
        ...(createOnly ? { preconditionOpts: { ifGenerationMatch: 0 } } : {}),
      },
    );
  };

  try {
    let level = parts;
    let round = 0;

    // Folded pairwise rather than appended one at a time. Sequential appends
    // rewrite the whole accumulated object on every step, which is quadratic in
    // bytes moved and, on a 2 GB base, is the difference between one copy and
    // hundreds.
    while (level.length > MAX_COMPOSE_SOURCES) {
      const next: ComposePart[] = [];
      for (let i = 0; i < level.length; i += MAX_COMPOSE_SOURCES) {
        const group = level.slice(i, i + MAX_COMPOSE_SOURCES);
        if (group.length === 1) { next.push(group[0]); continue; }
        const target = `${scratchPrefix}round-${round}-${next.length}`;
        await composeOnce(group, target, true);
        intermediates.push(target);
        const [meta] = await storage.file(target).getMetadata();
        next.push({ objectPath: target, generation: String(meta.generation) });
      }
      level = next;
      round += 1;
      if (round > 8) throw new PdfComposeError('Composition did not converge.');
    }

    await composeOnce(level, destination, true);
    const [meta] = await storage.file(destination).getMetadata();
    return {
      objectPath: destination,
      generation: String(meta.generation),
      sizeBytes: Number(meta.size || 0),
    };
  } finally {
    // On failure too. A half-composed document left behind is billed storage
    // nobody can identify later.
    await Promise.all(intermediates.map((path) => storage.file(path).delete().catch(() => {})));
  }
}
