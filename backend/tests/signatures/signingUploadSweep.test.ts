/**
 * Ageing out the transient signing-upload prefix.
 *
 * The sweep collects objects older than ten days. Age alone is the wrong
 * question, and getting it wrong is silent: a session may stay open for thirty
 * days, so a document signed on day fifteen had its source deleted five days
 * earlier and cannot be finalized at all. What a user sees is a signing link
 * that stops working, with nothing anywhere saying why.
 *
 * So the tests below are all about the same distinction. Old and unused is
 * collectable. Old and still pointed at by something live is not, and the thing
 * doing the pointing is what has to be honoured.
 */
import crypto from 'crypto';
import { objects, putObject, inMemoryBucket } from '../support/inMemoryBucket';
import { minimalPdfBytes } from '../support/minimalPdf';
import { createFirm, ownerOf, testPool, type Actor, type Firm } from '../support/setupInProcess';

const repo = require('../../src/modules/signatures/signatures.repository');

let firm: Firm;
let owner: Actor;
let cleanupExpiredUploads: () => Promise<void>;

beforeAll(() => {
  const { admin } = require('../../src/shared/database/firebase');
  jest.spyOn(admin, 'storage').mockReturnValue({ bucket: () => inMemoryBucket } as never);
  ({ cleanupExpiredUploads } = require('../../src/modules/signatures/signing.routes'));
});

afterAll(() => { jest.restoreAllMocks(); });

const ELEVEN_DAYS_AGO = new Date(Date.now() - 11 * 24 * 60 * 60 * 1000).toISOString();

/** An object in the transient prefix, old enough for the sweep to want it. */
function oldUpload(name = 'source.pdf'): string {
  const objectPath = `signing-uploads/${firm.id}/${crypto.randomUUID()}/${name}`;
  putObject(objectPath, { body: minimalPdfBytes(), contentType: 'application/pdf' });
  // The sweep ages objects out on when they were WRITTEN, not touched.
  objects.get(objectPath)!.created = ELEVEN_DAYS_AGO;
  return objectPath;
}

/** A session in the given state, pointing at `objectPath`. */
async function session(objectPath: string, status: string) {
  const token = crypto.randomBytes(12).toString('hex');
  await testPool.query(
    `insert into signature_sessions (token, law_firm_id, source_id, status, object_path, expires_at)
     values ($1, $2, (select id from signature_sources where law_firm_id = $2 order by created_at limit 1), $3, $4, now() + interval '30 days')`,
    [token, firm.id, status, objectPath],
  );
  return token;
}

beforeEach(async () => {
  objects.clear();
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
});

describe('what the sweep collects', () => {
  it('deletes an old upload nothing points at', async () => {
    const orphan = oldUpload();

    await cleanupExpiredUploads();

    expect(objects.has(orphan)).toBe(false);
  });

  it('leaves a recent upload alone', async () => {
    const recent = `signing-uploads/${firm.id}/${crypto.randomUUID()}/fresh.pdf`;
    putObject(recent, { body: minimalPdfBytes(), contentType: 'application/pdf' });

    await cleanupExpiredUploads();

    expect(objects.has(recent)).toBe(true);
  });
});

describe('what the sweep must NOT collect', () => {
  it('KEEPS the source of a session that is still open', async () => {
    // The defect this exists for. A session lives thirty days and the sweep
    // collects at ten, so signing on day fifteen finalized against a document
    // that had been deleted five days earlier.
    const objectPath = oldUpload();
    await session(objectPath, 'in_progress');

    await cleanupExpiredUploads();

    expect(objects.has(objectPath)).toBe(true);
  });

  it('KEEPS the source of a session that has not started yet', async () => {
    const objectPath = oldUpload();
    await session(objectPath, 'pending');

    await cleanupExpiredUploads();

    expect(objects.has(objectPath)).toBe(true);
  });

  it('KEEPS an admitted source that has not failed', async () => {
    // A source may be admitted well before anyone sends it. Deleting the bytes
    // leaves a row that says `ready` and a document that is gone.
    const objectPath = oldUpload();
    const source = await repo.createSource(firm.id, { uploadedBy: owner.uid, objectPath });
    await repo.updateSource(firm.id, source.id, { status: 'ready' });

    await cleanupExpiredUploads();

    expect(objects.has(objectPath)).toBe(true);
  });

  it('KEEPS the prepared copy an admitted source points at', async () => {
    // The prepared object is what the signer actually views. It is a different
    // path from the upload, so keeping only the upload keeps the wrong one.
    const upload = oldUpload('upload.pdf');
    const prepared = oldUpload('prepared.pdf');
    const source = await repo.createSource(firm.id, { uploadedBy: owner.uid, objectPath: upload });
    await repo.updateSource(firm.id, source.id, {
      status: 'ready', preparedObjectPath: prepared,
    });

    await cleanupExpiredUploads();

    expect(objects.has(prepared)).toBe(true);
  });

  it('COLLECTS a source whose admission failed', async () => {
    // Nothing can ever use it, and the row records why it was refused, so the
    // bytes are pure cost.
    const objectPath = oldUpload();
    const source = await repo.createSource(firm.id, { uploadedBy: owner.uid, objectPath });
    await repo.updateSource(firm.id, source.id, {
      status: 'failed', failureCode: 'PDF_ENCRYPTED',
    });

    await cleanupExpiredUploads();

    expect(objects.has(objectPath)).toBe(false);
  });

  it('COLLECTS the source of a session that has settled', async () => {
    // A completed session has its artifacts filed elsewhere, so the transient
    // source is finished with.
    const objectPath = oldUpload();
    await session(objectPath, 'completed');

    await cleanupExpiredUploads();

    expect(objects.has(objectPath)).toBe(false);
  });

  it('KEEPS a template source, which has no session at all', async () => {
    // A template is reused indefinitely and nothing about it is transient.
    const objectPath = oldUpload();
    await testPool.query(
      `insert into signature_templates (law_firm_id, name, source_object_path)
       values ($1, 'Retainer', $2)`,
      [firm.id, objectPath],
    );

    await cleanupExpiredUploads();

    expect(objects.has(objectPath)).toBe(true);
  });
});
