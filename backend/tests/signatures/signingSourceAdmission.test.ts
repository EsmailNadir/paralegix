/**
 * The admission boundary every document crosses before a signer sees it.
 *
 * Three routes can put a document in front of a signer, and each used to decide
 * for itself whether the bytes were signable. They disagreed. One checked the
 * leading bytes and the stored length, one trusted a file the firm already
 * owned, and the template route checked neither, so a template built on an
 * encrypted PDF failed at the point a signer had already been invited.
 *
 * Admission is now a ROW. A session or template names a source, a source has a
 * status, and nothing reads bytes for a signer until that status is `ready`.
 * The tests below are about the two halves of that: the refusals, each of which
 * has to name what is wrong with a stable code, and the digest state, which is
 * what lets sealing avoid a second read of the document.
 *
 * What has to break for these to go red: drop any single structural check and
 * the matching refusal test passes an unsignable document; drop the generation
 * comparison and the replaced-source test prepares the wrong bytes; drop the
 * `save()` before `digest()` and the resumed digest stops matching Node's.
 */
import crypto from 'crypto';
import { objects, putObject, nextGeneration } from '../support/inMemoryBucket';
import { minimalPdfBytes, FORM_FIELD_VALUE } from '../support/minimalPdf';
import { createFirm, ownerOf, type Actor, type Firm } from '../support/setupInProcess';
import { installRichBucket, resetRichBucket } from '../files/richBucket';

installRichBucket();

const {
  admitStoredUpload,
  prepareSource,
  requireReadySource,
  savedDigestStateOf,
  pdfDisplayName,
  SourceRefused,
  SOURCE_PROFILE_VERSION,
} = require('../../src/modules/signatures/signingSources');
const repo = require('../../src/modules/signatures/signatures.repository');
const {
  resumeDigest, SourceChangedError,
} = require('../../src/modules/signatures/pdf/resumableDigest');

const CAP = 20 * 1024 * 1024;

let firm: Firm;
let owner: Actor;

/** Put bytes where an upload would have landed, and hand back the path. */
function land(body: Buffer, name = 'agreement.pdf'): string {
  const path = `signing-uploads/${firm.id}/${crypto.randomUUID()}/${name}`;
  putObject(path, { body, contentType: 'application/pdf', custom: { uploadedBy: owner.uid } });
  return path;
}

const admit = (objectPath: string, extra: Record<string, unknown> = {}) => admitStoredUpload({
  lawFirmId: firm.id,
  uploadedBy: owner.uid,
  objectPath,
  maxSizeBytes: CAP,
  ...extra,
});

/** Admit and prepare, which is what a finalize does. */
async function ready(body: Buffer) {
  const objectPath = land(body);
  const admitted = await admit(objectPath);
  const prepared = await prepareSource({
    lawFirmId: firm.id, sourceId: admitted.id, operationId: crypto.randomUUID(),
  });
  return { objectPath, prepared };
}

beforeEach(async () => {
  resetRichBucket();
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
});

describe('admitting a document', () => {
  it('records the landed generation and size, not what the caller declared', async () => {
    const body = minimalPdfBytes();
    const objectPath = land(body);
    const stored = objects.get(objectPath)!;

    const source = await admit(objectPath);

    expect(source.objectGeneration).toBe(stored.generation);
    expect(source.sizeBytes).toBe(body.length);
    expect(source.pageCount).toBe(1);
    expect(source.profileVersion).toBe(SOURCE_PROFILE_VERSION);
    expect(source.status).toBe('pending');
  });

  it('keeps the generation a string, so two 64-bit versions cannot compare equal', async () => {
    // A GCS generation is a 64-bit value. Two versions that differ only past
    // 2^53 round to the same JS number, so a document replaced mid-signing
    // would pass the pinning check. The comparison has to stay textual.
    const source = await admit(land(minimalPdfBytes()));
    expect(typeof source.objectGeneration).toBe('string');

    const { prepared } = await ready(minimalPdfBytes());
    const neighbour = String(BigInt(prepared.preparedGeneration) + 1n);
    // Both sides survive `Number()` as the same value, which is the trap.
    expect(Number(neighbour)).toBe(Number(prepared.preparedGeneration) + 1);

    const far = '9007199254740993';
    const alsoFar = '9007199254740992';
    expect(Number(far)).toBe(Number(alsoFar));
    await expect(requireReadySource(firm.id, prepared.id, far)).rejects.toMatchObject({
      refusalCode: 'SOURCE_CHANGED',
    });
  });

  it('is idempotent: a retried finalize reuses the one row for that object', async () => {
    const objectPath = land(minimalPdfBytes());

    const first = await admit(objectPath);
    const second = await admit(objectPath);

    expect(second.id).toBe(first.id);
  });

  // Encrypted: its strings and streams use a key this service does not have, so
  // anything appended to it is unreadable to a viewer that decrypts the rest.
  // That case is the stored-refusal test below.
  it.each([
    ['bytes that are not a PDF', Buffer.from('MZ\x90\x00\x03\x00\x00\x00'), {}, 'PDF_INVALID'],
    // Appending would invalidate the first signature, and the first signer
    // never agreed to that.
    ['a PDF that already carries a signature field', minimalPdfBytes({ acroForm: true, sigFlags: 3 }), {}, 'PDF_EXISTING_SIGNATURE'],
    // An XFA appearance is generated by the viewer from XML this code does not
    // interpret, so a flattened rendering would differ from what the signer read.
    ['an XFA form', minimalPdfBytes({ xfa: true }), {}, 'PDF_UNSUPPORTED_FORM'],
    ['an object larger than the cap', minimalPdfBytes(), { maxSizeBytes: 100 }, 'FILE_TOO_LARGE'],
  ])('refuses %s', async (_label, bytes, options, refusalCode) => {
    await expect(admit(land(bytes), options)).rejects.toMatchObject({ refusalCode });
  });

  it('refuses when the landed length disagrees with the declaration', async () => {
    // The declaration is what the size ceiling was checked against at init, so
    // a different length means that check was made about other bytes.
    await expect(admit(land(minimalPdfBytes()), { declaredSizeBytes: 999_999 }))
      .rejects.toMatchObject({ refusalCode: 'SOURCE_CHANGED' });
  });

  it('WRITES the refusal to the row rather than only throwing it', async () => {
    // A refusal that exists only in a stack trace cannot be answered in support,
    // and the next attempt at the same object would re-inspect it.
    const objectPath = land(minimalPdfBytes({ encrypted: true }));

    const refusal = await admit(objectPath).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(SourceRefused);
    expect(refusal).toMatchObject({ refusalCode: 'PDF_ENCRYPTED' });

    const row = await repo.getSourceByObjectPath(firm.id, objectPath);
    expect(row.status).toBe('failed');
    expect(row.failureCode).toBe('PDF_ENCRYPTED');
    expect(row.failureDetail).toContain('/Encrypt');
  });

  it('keeps parser internals out of the message the user reads', async () => {
    // "unexpected token at offset 918233" tells a paralegal nothing and tells
    // an attacker something.
    const error = await admit(land(Buffer.from('not a pdf at all'))).catch((e: any) => e);

    expect(error.message).toBe('This file is not a PDF we can read. Try opening it and saving it again as a PDF.');
    expect(error.message).not.toContain('offset');
  });
});

describe('preparing a source', () => {
  it('saves a digest state that resumes to the same digest Node computes', async () => {
    // The whole reason the state exists: sealing resumes it instead of reading
    // the document a second time.
    const body = minimalPdfBytes({ pages: 3 });

    const { prepared } = await ready(body);

    const nodeHash = crypto.createHash('sha256').update(body).digest('hex');
    expect(prepared.status).toBe('ready');
    expect(prepared.documentHash).toBe(nodeHash);
    expect(prepared.digestAlgorithm).toBe('sha256');
    expect(prepared.digestStateBytes).toBe(body.length);

    const saved = savedDigestStateOf(prepared);
    const resumed = await resumeDigest(saved, {
      objectPath: prepared.preparedObjectPath,
      generation: prepared.preparedGeneration,
      sizeBytes: body.length,
    });
    // Resumed with nothing appended, the state must already equal the digest of
    // the whole document. A state saved AFTER `digest()` would not.
    expect(resumed.digestHex()).toBe(nodeHash);
  });

  it('records the generation the state covers, so a resume can be refused', async () => {
    const { prepared } = await ready(minimalPdfBytes());
    const saved = savedDigestStateOf(prepared);

    await expect(resumeDigest(saved, {
      objectPath: prepared.preparedObjectPath,
      generation: nextGeneration(),
      sizeBytes: prepared.preparedSizeBytes,
    })).rejects.toThrow(SourceChangedError);
  });

  it('refuses when the object was replaced between admission and preparation', async () => {
    // Preparing the new bytes under a decision made about the old ones is
    // exactly what the generation exists to prevent.
    const objectPath = land(minimalPdfBytes());
    const admitted = await admit(objectPath);
    putObject(objectPath, { body: minimalPdfBytes({ pages: 9 }), custom: { uploadedBy: owner.uid } });

    await expect(prepareSource({
      lawFirmId: firm.id, sourceId: admitted.id, operationId: crypto.randomUUID(),
    })).rejects.toMatchObject({ refusalCode: 'SOURCE_CHANGED' });

    const row = await repo.getSource(firm.id, admitted.id);
    expect(row.status).toBe('failed');
    // No digest state is written for bytes nobody vouched for.
    expect(row.digestState).toBeNull();
  });

  it('leaves nothing half-written when preparation fails', async () => {
    const objectPath = land(minimalPdfBytes());
    const admitted = await admit(objectPath);
    objects.delete(objectPath);

    await expect(prepareSource({
      lawFirmId: firm.id, sourceId: admitted.id, operationId: crypto.randomUUID(),
    })).rejects.toThrow(SourceRefused);

    const row = await repo.getSource(firm.id, admitted.id);
    expect(row.digestState).toBeNull();
    expect(row.preparedHash).toBeNull();
    expect(row.status).toBe('failed');
  });

  it('returns the ready source rather than re-hashing it', async () => {
    const { prepared } = await ready(minimalPdfBytes());

    const again = await prepareSource({
      lawFirmId: firm.id, sourceId: prepared.id, operationId: crypto.randomUUID(),
    });

    expect(again.id).toBe(prepared.id);
    expect(again.status).toBe('ready');
    expect(again.documentHash).toBe(prepared.documentHash);
  });
});

describe('flattening a form during preparation', () => {
  it('composes a prepared source that differs from the upload', async () => {
    // A signer who reads an editable field and a seal taken over the
    // un-flattened original are two different documents. So preparation
    // flattens first, and the prepared object is what everything downstream
    // reads.
    const body = minimalPdfBytes({ flattenableForm: true });

    const { objectPath, prepared } = await ready(body);

    expect(prepared.status).toBe('ready');
    expect(prepared.preparedObjectPath).not.toBe(objectPath);
    expect(prepared.preparedSizeBytes).toBeGreaterThan(body.length);
    // The upload keeps its own identity as evidence of what arrived.
    expect(prepared.documentHash).toBe(crypto.createHash('sha256').update(body).digest('hex'));
    expect(prepared.preparedHash).not.toBe(prepared.documentHash);
    expect(objects.get(objectPath)!.body!.equals(body)).toBe(true);
  });

  it('re-runs a preparation whose compose landed but whose row update did not', async () => {
    // The window between composing the prepared object and recording it on the
    // row is one a crash can land in. The row stays `preparing`, so the job is
    // claimable again, and the retry finds its own abandoned object at the
    // create-only destination. Reported as "not a PDF", that would fail a
    // signable document permanently.
    const objectPath = land(minimalPdfBytes({ flattenableForm: true }));
    const admitted = await admit(objectPath);

    // Both writes fail, the `ready` update and the `failed` one in the catch,
    // which is what a process that died between them looks like to the row.
    const crash = jest.spyOn(repo, 'updateSource').mockImplementation(async () => {
      throw new Error('connection reset');
    });
    await expect(prepareSource({
      lawFirmId: firm.id, sourceId: admitted.id, operationId: crypto.randomUUID(),
    })).rejects.toThrow();
    crash.mockRestore();
    expect((await repo.getSource(firm.id, admitted.id)).status).toBe('preparing');
    expect([...objects.keys()].some((path) => path.endsWith(`/prepared/${admitted.id}/source.pdf`))).toBe(true);

    const retried = await prepareSource({
      lawFirmId: firm.id, sourceId: admitted.id, operationId: crypto.randomUUID(),
    });
    expect(retried.status).toBe('ready');
    expect(retried.preparedObjectPath).toMatch(new RegExp(`/prepared/${admitted.id}/source\\.pdf$`));
    const composed = objects.get(retried.preparedObjectPath)!.body!;
    expect(retried.preparedHash).toBe(crypto.createHash('sha256').update(composed).digest('hex'));
  });

  it('saves a state over the PREPARED bytes, not the upload', async () => {
    // Resuming a state that covers the upload while sealing the prepared source
    // digests a byte sequence that was never in any file, and it signs cleanly.
    const { prepared } = await ready(minimalPdfBytes({ flattenableForm: true }));
    const composed = objects.get(prepared.preparedObjectPath)!.body!;

    expect(prepared.digestStateBytes).toBe(composed.length);
    expect(prepared.digestStateGeneration).toBe(prepared.preparedGeneration);
    expect(prepared.preparedHash).toBe(crypto.createHash('sha256').update(composed).digest('hex'));

    const resumed = await resumeDigest(savedDigestStateOf(prepared), {
      objectPath: prepared.preparedObjectPath,
      generation: prepared.preparedGeneration,
      sizeBytes: composed.length,
    });
    expect(resumed.digestHex()).toBe(prepared.preparedHash);
  });

  it('draws the appearance on the page and drops the editable widget', async () => {
    // The two halves of flattening. Placing the appearance without removing the
    // widget leaves the field editable under a picture of itself, and removing
    // the widget without placing the appearance erases the value from the page.
    const body = minimalPdfBytes({ flattenableForm: true });
    const { prepared } = await ready(body);
    const composed = objects.get(prepared.preparedObjectPath)!.body!;
    // Only the appended revision. The base still holds the original bytes,
    // which is the point, so searching the whole file would prove nothing.
    const appended = composed.subarray(body.length).toString('latin1');

    expect(appended).toMatch(/\/\w+ Do/);
    expect(appended).toMatch(/\/Annots \[\s*\]/);
    expect(appended).toMatch(/\/Fields \[\s*\]/);
    // The appearance itself is not rewritten, so the value stays where it was.
    expect(composed.toString('latin1')).toContain(FORM_FIELD_VALUE);
  });

  it('leaves a source without a form byte for byte alone', async () => {
    // An empty appended revision would change the digest for no reason, and the
    // completed PDF has to carry the prepared bytes unchanged.
    const body = minimalPdfBytes();

    const { objectPath, prepared } = await ready(body);

    expect(prepared.preparedObjectPath).toBe(objectPath);
    expect(prepared.preparedSizeBytes).toBe(body.length);
    expect(prepared.preparedHash).toBe(prepared.documentHash);
  });

  it('refuses a form whose value cannot be proved, and says so on the row', async () => {
    // A text field with no appearance. Guessing what it should look like would
    // put a rendering in front of the signer that no viewer agrees with.
    const objectPath = land(minimalPdfBytes({ acroForm: true }));
    const admitted = await admit(objectPath);

    await expect(prepareSource({
      lawFirmId: firm.id, sourceId: admitted.id, operationId: crypto.randomUUID(),
    })).rejects.toMatchObject({ code: 'PDF_UNSUPPORTED_FORM' });

    const row = await repo.getSource(firm.id, admitted.id);
    expect(row.status).toBe('failed');
    expect(row.failureCode).toBe('PDF_UNSUPPORTED_FORM');
    expect(row.digestState).toBeNull();
  });
});

describe('gating on a ready source', () => {
  it('hands back a ready source when the generation matches', async () => {
    const { prepared } = await ready(minimalPdfBytes());

    const gated = await requireReadySource(firm.id, prepared.id, prepared.preparedGeneration);

    expect(gated.id).toBe(prepared.id);
  });

  it('refuses a stale generation', async () => {
    const { prepared } = await ready(minimalPdfBytes());

    await expect(requireReadySource(firm.id, prepared.id, nextGeneration()))
      .rejects.toMatchObject({ refusalCode: 'SOURCE_CHANGED' });
  });

  it('refuses a source that is still preparing', async () => {
    const admitted = await admit(land(minimalPdfBytes()));

    await expect(requireReadySource(firm.id, admitted.id))
      .rejects.toMatchObject({ code: 'SOURCE_NOT_READY' });
  });

  it('re-reports the original refusal for a failed source', async () => {
    const objectPath = land(minimalPdfBytes({ encrypted: true }));
    await admit(objectPath).catch(() => {});
    const row = await repo.getSourceByObjectPath(firm.id, objectPath);

    await expect(requireReadySource(firm.id, row.id))
      .rejects.toMatchObject({ refusalCode: 'PDF_ENCRYPTED' });
  });

  it('does not find another firm source', async () => {
    // A source id is a uuid, not a capability. The firm scope is what decides.
    const { prepared } = await ready(minimalPdfBytes());
    const other = await createFirm({ name: 'Vance LLP' });

    await expect(requireReadySource(other.id, prepared.id))
      .rejects.toMatchObject({ refusalCode: 'SOURCE_CHANGED' });
  });

  it('reports no saved state rather than a broken one when the row has none', async () => {
    // A source prepared before the state existed takes the streaming path. That
    // is not an error, and returning a partial state would make it one.
    expect(savedDigestStateOf({ digestState: null })).toBeNull();
    expect(savedDigestStateOf({
      digestState: Buffer.alloc(116), digestStateBytes: 10,
      digestStateGeneration: '1', digestAlgorithm: 'sha512',
    })).toBeNull();
  });
});

describe('the display name', () => {
  it('adds .pdf to a confirmed PDF that arrived without one', async () => {
    expect(pdfDisplayName('scan-0001')).toBe('scan-0001.pdf');
    expect(pdfDisplayName('Retainer.PDF')).toBe('Retainer.PDF');
    expect(pdfDisplayName('')).toBe('document.pdf');
  });
});
