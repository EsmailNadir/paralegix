/**
 * A non-final signer's turn and the working copy the next signer sees.
 *
 * The working copy is the prepared source plus an appended stamp revision.
 * Its hash goes into the audit record. The source's saved digest state already
 * covers every byte before the suffix, so the hash costs the suffix; streaming
 * the whole stamped copy instead is a full read of a document that may be
 * 500 MB, inside the signer's request, once per signer.
 *
 * What has to break for this to go red: hash the working copy by streaming it
 * (the whole-read assertion fails), or resume the state over the wrong bytes
 * (the recorded hash stops matching the stored object).
 */
import {
  testPool,
  request,
  createFirm,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import {
  objects, objectReads, putObject, installInMemoryBucket,
} from '../support/inMemoryBucket';
import { minimalPdf } from '../support/minimalPdf';
import { pointFirmSourceAt, sessionIdSql } from '../support/factories';
import {
  seedSigningSession, completionBody, sha256, SIGNATURE_DATA_URL,
} from '../support/signing';

installInMemoryBucket();

const {
  createResumableDigest, DIGEST_STATE_VERSION,
} = require('../../src/modules/signatures/pdf/resumableDigest');

let firm: Firm;
let owner: Actor;

/** Write the saved state preparation would have written for this object. */
async function seedSavedDigest(sourceId: string, objectPath: string) {
  const stored = objects.get(objectPath)!;
  const body = stored.body!;
  const digest = await createResumableDigest();
  digest.update(new Uint8Array(body));
  const saved = digest.save({ objectPath, generation: stored.generation, sizeBytes: body.length });
  await testPool.query(
    `update signature_sources
        set digest_algorithm = 'sha256', digest_library_version = $2,
            digest_state = $3, digest_state_bytes = $4, digest_state_generation = $5
      where id = $1`,
    [sourceId, DIGEST_STATE_VERSION, Buffer.from(saved.state).toString('base64'), saved.bytes, stored.generation],
  );
}

/** Two sequential signers, one signature field each, on a sizeable document. */
async function seedTwoSignerSession() {
  const objectPath = `signing-uploads/${firm.id}/two-signer/agreement.pdf`;
  putObject(objectPath, {
    body: minimalPdf({ pages: 1, fillerBytes: 1024 * 1024 }).bytes,
    contentType: 'application/pdf',
  });
  const sourceId = await pointFirmSourceAt(
    firm.id, objectPath, objects.get(objectPath)!.generation, objects.get(objectPath)!.bytes,
  );
  await seedSavedDigest(sourceId, objectPath);

  const { sessionToken, participants } = await seedSigningSession({
    lawFirmId: firm.id,
    createdBy: owner.uid,
    sourceId,
    session: {
      routing_mode: 'sequential',
      object_path: objectPath,
      current_signer_order: 1,
      document_hash: 'originalhash',
    },
    participants: ['Ada First', 'Bo Second'].map((name, index) => ({
      name,
      email: `signer${index}@example.test`,
      status: index === 0 ? 'active' : 'waiting',
      fields: [{ fieldType: 'signature' as const, label: 'Sign', xPercent: 20 + index * 20, yPercent: 20 }],
    })),
  });
  const signers = participants.map((p) => ({
    participantId: p.participantId, publicToken: p.publicToken, fieldId: p.fieldIds[0],
  }));
  return { sessionToken, signers };
}

beforeEach(async () => {
  objects.clear();
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
});

describe('a non-final signer turn', () => {
  it('records the working copy hash without reading the working copy', async () => {
    const { sessionToken, signers } = await seedTwoSignerSession();
    const [first] = signers;
    const page = await request().get(`/api/signing/${first.publicToken}`);
    expect(page.status).toBe(200);
    objectReads.length = 0;

    const res = await request()
      .post(`/api/signing/${first.publicToken}/complete`)
      .send(completionBody({
        consentName: 'Ada First',
        sourceRevision: page.body.sourceRevision,
        fieldValues: [{ fieldId: first.fieldId, value: SIGNATURE_DATA_URL }],
      }));
    expect(res.status).toBe(200);

    const { rows: session } = await testPool.query(
      'select working_object_path from signature_sessions where token = $1', [sessionToken],
    );
    const workingPath = session[0].working_object_path as string;
    expect(workingPath).toMatch(/signing-work\//);

    // Proved first: the hash exists and it is the hash of what is stored.
    const { rows: audit } = await testPool.query(
      `select metadata from signature_audit_events
        where session_id = ${sessionIdSql('$1')} and event_type = 'session.completed'`,
      [sessionToken],
    );
    expect(audit).toHaveLength(1);
    const stored = objects.get(workingPath)!.body!;
    expect(audit[0].metadata.signedDocumentHash)
      .toBe(sha256(stored));

    const wholeReads = objectReads.filter((r) => r.path === workingPath && r.whole);
    expect(wholeReads).toEqual([]);
  });
});
