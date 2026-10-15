/**
 * A fieldless completion is durable work, like every other finalization.
 *
 * The executed document of a fieldless session is the copy the signer drew on
 * in the browser and uploaded. Sealing it used to run inside the last signer's
 * request, whatever its size, with no job row, no transfer slot and no
 * admission: a 500 MB upload was sealed on the request path, and a copy
 * carrying its own signature field was sealed over it.
 *
 * What has to break for these to go red: seal inline again (the first test gets
 * 200 and finds no job), or skip admission of the uploaded copy (the second
 * test finds a sealed artifact over a document that already had a signature).
 */
process.env.SIGNING_INLINE_FINALIZE_BYTES = '1024';

import {
  testPool,
  request,
  createFirm,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { objects, putObject, installInMemoryBucket } from '../support/inMemoryBucket';
import { minimalPdf, minimalPdfBytes } from '../support/minimalPdf';
import { sessionIdSql } from '../support/factories';
import { seedSigningSession, storeSigningSource, completionBody } from '../support/signing';

installInMemoryBucket();

require('../../src/modules/signatures/signingSources');
require('../../src/modules/signatures/signingFinalize');
const { drainSigningJobs } = require('../../src/modules/signatures/signingJobs');

/** Past the drain's own five-minute headroom, or it stops before the first job. */
const DRAIN_WINDOW_MS = 30 * 60 * 1000;

let firm: Firm;
let owner: Actor;

async function seedFieldlessSession() {
  const objectPath = await storeSigningSource(firm.id, minimalPdf({ pages: 1 }).bytes);
  const { sessionToken, participants: [signer] } = await seedSigningSession({
    lawFirmId: firm.id,
    createdBy: owner.uid,
    session: {
      routing_mode: 'sequential',
      object_path: objectPath,
      current_signer_order: 1,
      document_hash: 'originalhash',
    },
    participants: [{ name: 'Signer One', roleLabel: 'Signer', email: 'signer@example.test' }],
  });
  return { sessionToken, publicToken: signer.publicToken, participantId: signer.participantId };
}

/** Open the upload, land a signed copy there, and complete with it. */
async function completeWith(seeded: { publicToken: string; participantId: string }, body: Buffer) {
  const opened = await request()
    .post(`/api/signing/${seeded.publicToken}/complete-upload-init`)
    .send({ fileName: 'signed.pdf', size: body.length });
  expect(opened.status).toBe(200);
  putObject(opened.body.objectPath, {
    body,
    contentType: 'application/pdf',
    custom: { uploadedBy: `participant:${seeded.participantId}` },
  });
  const page = await request().get(`/api/signing/${seeded.publicToken}`);
  return request()
    .post(`/api/signing/${seeded.publicToken}/complete`)
    .set('Content-Type', 'application/json')
    .send(completionBody({
      sourceRevision: page.body.sourceRevision,
      signedObjectPath: opened.body.objectPath,
    }));
}

const jobsFor = async (sessionToken: string) => (await testPool.query(
  `select kind, status, failure_code from signature_processing_jobs
    where session_id = ${sessionIdSql('$1')}`,
  [sessionToken],
)).rows;

const sessionRow = async (sessionToken: string) => (await testPool.query(
  'select status, signed_object_path, final_object_path from signature_sessions where token = $1',
  [sessionToken],
)).rows[0];

beforeEach(async () => {
  objects.clear();
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
});

describe('completing a fieldless session', () => {
  it('commits a finalize job and leaves a large copy to the drain', async () => {
    const seeded = await seedFieldlessSession();
    // Past the inline threshold this spec sets, so the drain has to finish it.
    const upload = minimalPdf({ pages: 1, fillerBytes: 4096 }).bytes;
    expect(upload.length).toBeGreaterThan(1024);
    const res = await completeWith(seeded, upload);

    expect(res.status).toBe(202);
    expect(res.body.state).toBe('processing');
    expect(await jobsFor(seeded.sessionToken)).toEqual([
      expect.objectContaining({ kind: 'finalize', status: 'queued' }),
    ]);
    expect((await sessionRow(seeded.sessionToken)).signed_object_path).toBeNull();

    await drainSigningJobs({ owner: 'test', deadline: Date.now() + DRAIN_WINDOW_MS });

    const session = await sessionRow(seeded.sessionToken);
    expect(session.status).toBe('completed');
    expect(session.signed_object_path).toMatch(/filed\.pdf$/);
    expect(objects.has(session.signed_object_path)).toBe(true);
  });

  it('refuses to seal an uploaded copy that already carries a signature field', async () => {
    const seeded = await seedFieldlessSession();
    await completeWith(seeded, minimalPdfBytes({ acroForm: true, sigFlags: 3 }));

    await drainSigningJobs({ owner: 'test', deadline: Date.now() + DRAIN_WINDOW_MS });

    const [job] = await jobsFor(seeded.sessionToken);
    expect(job).toMatchObject({ kind: 'finalize', status: 'failed', failure_code: 'PDF_EXISTING_SIGNATURE' });
    const session = await sessionRow(seeded.sessionToken);
    expect(session.status).not.toBe('completed');
    expect(session.signed_object_path).toBeNull();
  });
});
