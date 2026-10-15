/**
 * The verification route over a real sealed artifact.
 *
 * Verifying needs two digests: the whole file, which proves the artifact is the
 * one the session recorded, and the ByteRange, which is what the seal signed.
 * They cover the same bytes except the seal's own gap, so ONE read serves both.
 * Two reads of a 500 MB artifact are two full passes on a single vCPU, per
 * click, for any firm member who can view the session.
 *
 * What has to break for these to go red: read the artifact twice (the first
 * test sums what was read and finds nearly double), or run the work outside the
 * transfer slot (the second test holds every slot and gets an answer anyway).
 *
 * The same slots decide what the LAST SIGNER sees when every one is taken.
 * Finalizing a session is the one part of signing that takes a slot, and a busy
 * instance is normal, not exceptional. The finalize job is committed with the
 * signer's consent, so a worker that cannot start now is not work that is lost:
 * the signer should be told `processing` and the page should poll, exactly as
 * for a document too large to finalize inside the request. The slot queue gives
 * up after its deadline by THROWING, and an uncaught throw there answers the
 * signer 500 for a signature that is committed and a document that is owed.
 */
process.env.TRANSFER_SLOT_TIMEOUT_MS = '80';

import {
  testPool,
  request,
  createFirm,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { objects, objectReads, installInMemoryBucket } from '../support/inMemoryBucket';
import { minimalPdf } from '../support/minimalPdf';
import { sessionIdSql } from '../support/factories';
import {
  seedSigningSession, storeSigningSource, completionBody, holdEverySlot, SIGNATURE_DATA_URL,
} from '../support/signing';

installInMemoryBucket();

const FILLER_BYTES = 2 * 1024 * 1024;

let firm: Firm;
let owner: Actor;

/**
 * A one-signer field session. The default document is large enough to measure
 * a pass; `fillerBytes: 0` gives a small one.
 */
async function seedSession(fillerBytes = FILLER_BYTES) {
  const objectPath = await storeSigningSource(firm.id, minimalPdf({ pages: 1, fillerBytes }).bytes);
  const { sessionToken, participants: [signer] } = await seedSigningSession({
    lawFirmId: firm.id,
    createdBy: owner.uid,
    session: {
      routing_mode: 'sequential',
      object_path: objectPath,
      current_signer_order: 1,
      document_hash: 'originalhash',
    },
    participants: [{
      name: 'Signer One',
      roleLabel: 'Signer',
      email: 'signer@example.test',
      fields: [{ fieldType: 'signature', label: 'Sign', yPercent: 20 }],
    }],
  });
  return { sessionToken, publicToken: signer.publicToken, fieldId: signer.fieldIds[0] };
}

/** What a signer posts for the one signature field. */
const signatureBody = (seeded: { fieldId: string }, sourceRevision: string) => completionBody({
  sourceRevision,
  fieldValues: [{ fieldId: seeded.fieldId, value: SIGNATURE_DATA_URL }],
});

/** Sign through the real route, which finalizes inline at this size. */
async function completeAndSeal() {
  const seeded = await seedSession();
  const page = await request().get(`/api/signing/${seeded.publicToken}`);
  expect(page.status).toBe(200);
  const done = await request()
    .post(`/api/signing/${seeded.publicToken}/complete`)
    .send(signatureBody(seeded, page.body.sourceRevision));
  expect(done.status).toBe(200);
  const { rows } = await testPool.query(
    'select status, final_object_path, signed_object_path from signature_sessions where token = $1',
    [seeded.sessionToken],
  );
  expect(rows[0].status).toBe('completed');
  return {
    sessionToken: seeded.sessionToken,
    // The delivered copy, which is what `final_object_path` names.
    artifactPath: rows[0].final_object_path as string,
    filedPath: rows[0].signed_object_path as string,
  };
}

beforeEach(async () => {
  objects.clear();
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
});

describe('GET /api/signing/:token/verification', () => {
  it('reads the artifact once and still reports a valid, matching seal', async () => {
    const { sessionToken, artifactPath } = await completeAndSeal();
    const size = objects.get(artifactPath)!.bytes;
    objectReads.length = 0;

    const res = await owner.api.get(`/api/signing/${sessionToken}/verification`);
    expect(res.status).toBe(200);
    // Proved first, so a route that stopped verifying cannot pass on reading less.
    expect(res.body).toMatchObject({ identityMatch: true, sealed: true, sealValid: true, coversWholeFile: true });

    const read = objectReads
      .filter((r) => r.path === artifactPath)
      .reduce((sum, r) => sum + (r.end - r.start + 1), 0);
    expect(size).toBeGreaterThan(FILLER_BYTES);
    // One pass, plus the bounded windows the index and the seal gap need.
    expect(read).toBeLessThan(size + 256 * 1024);
  });

  it('waits for a transfer slot and answers busy when none frees up', async () => {
    const { sessionToken } = await completeAndSeal();
    const slots = holdEverySlot();
    await slots.ready;
    try {
      const res = await owner.api.get(`/api/signing/${sessionToken}/verification`);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('SIGNING_BUSY');
      // "Try again in a minute", said in the header a client or proxy acts on.
      expect(res.headers['retry-after']).toBe('60');
    } finally {
      await slots.release();
    }
  });
});

describe('GET /api/signing/:token/signed-document', () => {
  it('hands the firm the FILED copy by default, the one with the certificate page', async () => {
    const { sessionToken, artifactPath, filedPath } = await completeAndSeal();
    expect(filedPath).not.toBe(artifactPath);

    const filed = await owner.api.get(`/api/signing/${sessionToken}/signed-document?format=json`);
    expect(filed.status).toBe(200);
    expect(decodeURIComponent(filed.body.url)).toContain(filedPath);
  });
});

describe('after publication', () => {
  it('leaves no stamped intermediate or scratch suffix behind', async () => {
    // Both artifacts are composed from a stamped copy of the whole document.
    // Once they are sealed, verified and published nothing reads it again,
    // and left in place it is a second full-size copy nobody is charged for.
    const { sessionToken } = await completeAndSeal();
    const root = `lawfirmids/${firm.id}/signatures/${sessionToken}/`;
    const left = [...objects.keys()].filter((p) => p.startsWith(root));
    expect(left.some((p) => p.endsWith('/filed.pdf'))).toBe(true);
    expect(left.filter((p) => p.endsWith('/stamped.pdf') || p.includes('/scratch/'))).toEqual([]);
  });
});

describe('completing while every slot is busy', () => {
  it('tells the signer the document is PROCESSING and leaves the finalize job queued', async () => {
    const seeded = await seedSession(0);
    const page = await request().get(`/api/signing/${seeded.publicToken}`);
    expect(page.status).toBe(200);
    const slots = holdEverySlot();
    await slots.ready;

    try {
      const res = await request()
        .post(`/api/signing/${seeded.publicToken}/complete`)
        .send(signatureBody(seeded, page.body.sourceRevision));

      // 202 and `processing`, the same answer a document too large to finalize
      // inside the request gets. A 500 here tells someone whose signature is
      // already committed that it failed, and the obvious next move is to sign
      // again for a document that is already being produced.
      expect(res.status).toBe(202);
      expect(res.body.state).toBe('processing');
      // The consent is committed and the work is owed. If the busy answer also
      // dropped the job, the session would sit signed with no document and
      // nothing recording that anything was due.
      const { rows } = await testPool.query(
        `select status, kind from signature_processing_jobs
          where law_firm_id = $1 and session_id = ${sessionIdSql('$2')}`,
        [firm.id, seeded.sessionToken],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'finalize', status: 'queued' });
    } finally {
      await slots.release();
    }
  });
});
