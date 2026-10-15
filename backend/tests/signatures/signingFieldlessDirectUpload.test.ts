/**
 * A fieldless session finishes from an object in storage, not a request body.
 *
 * Most sessions carry placed fields, and the server rebuilds their executed
 * document from the stored original plus the values each signer submitted. A
 * FIELDLESS one has no such record: the marks were drawn freehand in the
 * browser, so the executed document IS the bytes the browser produced and only
 * the browser has them.
 *
 * That is why this path exists. What it should not be is a multipart body. The
 * browser holds the document either way, but posting it made the API hold it
 * too: it was the last place in the signatures module where a whole document
 * was resident in the process, and the last `multer.memoryStorage()` there.
 *
 * The browser now puts those bytes in the session's own working prefix and the
 * completion NAMES them. That makes the path caller input reaching an object
 * that becomes an executed legal document, so most of what follows is about
 * refusing a path that is not this session's own upload.
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
  objects, putObject, objectReads, installInMemoryBucket,
} from '../support/inMemoryBucket';
import { minimalPdf, minimalPdfBytes } from '../support/minimalPdf';
import { sessionKeysSql } from '../support/factories';
import { seedSigningSession, storeSigningSource, completionBody } from '../support/signing';

const crypto = require('crypto');

installInMemoryBucket();

let firm: Firm;
let owner: Actor;

/** A session with NO fields, which is what makes it fieldless. */
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

  return {
    sessionToken, publicToken: signer.publicToken, participantId: signer.participantId, objectPath,
  };
}

/**
 * What the session and the signer look like now.
 *
 * A refusal here is only a refusal if the TURN is still available. The route
 * used to commit consent, promote the next signer and consume the token before
 * it looked at the upload at all, so a rejected upload answered 400 and left
 * the signer marked `completed` with nothing executed. The status alone cannot
 * tell those two apart.
 */
async function turnState(publicToken: string) {
  const { rows } = await testPool.query(
    `select p.status as participant_status,
            s.status as session_status,
            t.consumed_at
       from signature_participant_tokens t
       join signature_participants p on p.id = t.participant_id
       join signature_sessions s     on s.id = t.session_id
      where t.token = $1`,
    [publicToken],
  );
  return rows[0];
}

/** The revision the signing page read, which a completion has to echo back. */
async function sourceRevision(publicToken: string) {
  const res = await request().get(`/api/signing/${publicToken}`);
  expect(res.status).toBe(200);
  return res.body.sourceRevision;
}

const openUpload = (publicToken: string, body: Record<string, unknown> = {}) =>
  request()
    .post(`/api/signing/${publicToken}/complete-upload-init`)
    .send({ fileName: 'signed.pdf', size: 4096, ...body });

const complete = async (publicToken: string, body: Record<string, unknown>) =>
  request()
    .post(`/api/signing/${publicToken}/complete`)
    .set('Content-Type', 'application/json')
    .send(completionBody({ sourceRevision: await sourceRevision(publicToken), ...body }));

beforeEach(async () => {
  objects.clear();
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
});

describe('opening the upload', () => {
  it('opens a session inside this session own working prefix', async () => {
    const seeded = await seedFieldlessSession();

    const res = await openUpload(seeded.publicToken);

    expect(res.status).toBe(200);
    expect(res.body.uploadUrl).toEqual(expect.any(String));
    expect(res.body.objectPath).toMatch(
      new RegExp(`^lawfirmids/${firm.id}/signing-work/${seeded.sessionToken}/completion/[^/]+\\.pdf$`),
    );
  });

  it('REFUSES a session that has fields', async () => {
    const seeded = await seedFieldlessSession();
    await testPool.query(
      `insert into signature_fields
         (id, session_id, law_firm_id, signer_id, page, x_percent, y_percent,
          width_percent, height_percent, field_type, label, required, sort_order)
       values ($1, ${sessionKeysSql('$2')}, $3, 1, 20, 20, 20, 6, 'signature', 'Sign', true, 0)`,
      [`fld-${crypto.randomBytes(6).toString('hex')}`, seeded.sessionToken, seeded.participantId],
    );

    const res = await openUpload(seeded.publicToken);

    // A session with fields is rebuilt from the values its signers submitted.
    // Accepting bytes for one would let a signer replace the document the
    // server would otherwise produce from what they actually agreed to.
    expect(res.status).toBe(400);
  });

  it('opens NOTHING for someone with no participant credential', async () => {
    await seedFieldlessSession();

    const res = await openUpload('not-a-real-token');

    expect(res.status).toBe(404);
    expect(objects.size).toBe(1);
  });
});

describe('completing from the uploaded object', () => {
  it('finishes the session from bytes it never received', async () => {
    const seeded = await seedFieldlessSession();
    const opened = await openUpload(seeded.publicToken);
    putObject(opened.body.objectPath, {
      body: minimalPdfBytes({ pages: 1 }),
      contentType: 'application/pdf',
      custom: { uploadedBy: `participant:${seeded.participantId}` },
    });

    const res = await complete(seeded.publicToken, { signedObjectPath: opened.body.objectPath });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('completed');
  });

  it('refuses an object belonging to another session', async () => {
    const mine = await seedFieldlessSession();
    const theirs = await seedFieldlessSession();
    const opened = await openUpload(theirs.publicToken);
    putObject(opened.body.objectPath, {
      body: minimalPdfBytes({ pages: 1 }),
      contentType: 'application/pdf',
      custom: { uploadedBy: `participant:${theirs.participantId}` },
    });

    const res = await complete(mine.publicToken, { signedObjectPath: opened.body.objectPath });

    // Same firm, same shape of path, wrong session. Unchecked, one signer
    // executes another session's document under their own signature.
    expect(res.status).toBe(400);
  });

  it('refuses an object outside the working prefix entirely', async () => {
    const seeded = await seedFieldlessSession();
    const foreign = `lawfirmids/${firm.id}/general/someone-elses-contract.pdf`;
    putObject(foreign, { body: minimalPdfBytes({ pages: 1 }), contentType: 'application/pdf' });

    const res = await complete(seeded.publicToken, { signedObjectPath: foreign });

    expect(res.status).toBe(400);
    // Refused, not consumed: a rejected path must not delete what it named.
    expect(objects.has(foreign)).toBe(true);
    const { rows } = await testPool.query(
      'select status from signature_participants where id = $1', [seeded.participantId],
    );
    expect(rows[0].status).toBe('active');
  });

  it('lets the completed signer download with the consumed public token', async () => {
    const seeded = await seedFieldlessSession();
    const opened = await openUpload(seeded.publicToken);
    putObject(opened.body.objectPath, {
      body: minimalPdfBytes({ pages: 1 }),
      contentType: 'application/pdf',
      custom: { uploadedBy: `participant:${seeded.participantId}` },
    });
    expect((await complete(seeded.publicToken, { signedObjectPath: opened.body.objectPath })).status).toBe(200);

    const downloaded = await request().get(`/api/signing/${seeded.publicToken}/file?disposition=attachment`);

    expect(downloaded.status).toBe(200);
    expect(downloaded.body.url).toEqual(expect.any(String));
  });

  it('refuses a name that climbs out of the prefix', async () => {
    const seeded = await seedFieldlessSession();
    const nested = `lawfirmids/${firm.id}/signing-work/${seeded.sessionToken}/completion/nested/deep.pdf`;
    putObject(nested, { body: minimalPdfBytes({ pages: 1 }), contentType: 'application/pdf' });

    const res = await complete(seeded.publicToken, { signedObjectPath: nested });

    expect(res.status).toBe(400);
  });

  it('refuses an upload somebody else left at the path', async () => {
    const seeded = await seedFieldlessSession();
    const opened = await openUpload(seeded.publicToken);
    putObject(opened.body.objectPath, {
      body: minimalPdfBytes({ pages: 1 }),
      contentType: 'application/pdf',
      custom: { uploadedBy: 'participant:somebody-else' },
    });

    const res = await complete(seeded.publicToken, { signedObjectPath: opened.body.objectPath });

    expect(res.status).toBe(403);
    // The refusal has to leave the turn TAKEABLE. Answering 403 after the
    // transaction had recorded consent, promoted the next signer and spent the
    // token would end this signer's turn with nothing executed and no way back.
    const after = await turnState(seeded.publicToken);
    expect(after.participant_status).toBe('active');
    expect(after.consumed_at).toBeNull();
  });

  it('refuses something that is not a PDF', async () => {
    const seeded = await seedFieldlessSession();
    const opened = await openUpload(seeded.publicToken);
    putObject(opened.body.objectPath, {
      body: Buffer.from('MZ'),
      contentType: 'application/x-msdownload',
      custom: { uploadedBy: `participant:${seeded.participantId}` },
    });

    const res = await complete(seeded.publicToken, { signedObjectPath: opened.body.objectPath });

    expect(res.status).toBe(415);
    const after = await turnState(seeded.publicToken);
    expect(after.participant_status).toBe('active');
    expect(after.consumed_at).toBeNull();
  });

  it('leaves the turn takeable when the upload is not the same document', async () => {
    const seeded = await seedFieldlessSession();
    const opened = await openUpload(seeded.publicToken);
    putObject(opened.body.objectPath, {
      body: minimalPdfBytes({ pages: 3 }),
      contentType: 'application/pdf',
      custom: { uploadedBy: `participant:${seeded.participantId}` },
    });

    const res = await complete(seeded.publicToken, { signedObjectPath: opened.body.objectPath });

    // A different page count is a different document. The signer can correct
    // the upload and submit again, which is only true because nothing was
    // committed on their behalf first.
    expect(res.status).toBe(400);
    const after = await turnState(seeded.publicToken);
    expect(after.participant_status).toBe('active');
    expect(after.session_status).toBe('pending');
    expect(after.consumed_at).toBeNull();
  });
});

describe('what the completion reads', () => {
  it('never pulls the uploaded document into the process', async () => {
    const seeded = await seedFieldlessSession();
    const opened = await openUpload(seeded.publicToken);
    putObject(opened.body.objectPath, {
      body: minimalPdfBytes({ pages: 1 }),
      contentType: 'application/pdf',
      custom: { uploadedBy: `participant:${seeded.participantId}` },
    });
    objectReads.length = 0;

    const res = await complete(seeded.publicToken, { signedObjectPath: opened.body.objectPath });
    expect(res.status).toBe(200);

    // Moving the upload to storage bought nothing if the route then downloads
    // it to seal it. The page-count check and both seals work through bounded
    // windows, and storage joins the parts, so this costs the same on a 500 MB
    // scan. `kind`, not width: a bounded window is wider than this fixture, so
    // a correct streamed read covers the whole of it. A DOWNLOAD answers a
    // Buffer and is resident all at once, which is what reintroducing
    // `download()` on the upload would produce.
    const uploadReads = objectReads.filter((read) => read.path === opened.body.objectPath);
    expect(uploadReads.length).toBeGreaterThan(0);

    // The only buffering read the upload is allowed is the leading-byte sniff
    // that decides it is a PDF at all: eight bytes, from the start. Everything
    // after it, the page-count comparison and both seals, is streamed or
    // composed. A download of any real span here is the whole document in the
    // process, which is what this path was rebuilt to stop.
    const bufferedUploadReads = uploadReads.filter((read) => read.kind === 'download');
    for (const read of bufferedUploadReads) {
      expect(read.start).toBe(0);
      expect(read.end - read.start + 1).toBeLessThanOrEqual(1024);
    }

    // The one deliberate buffering read left in this path is the emailed copy,
    // which has to be in the process to be attached to a message at all. Its
    // own cap bounds it (`SIGNING_ATTACHMENT_MAX_BYTES`), and a document past
    // that cap is delivered as a link instead. Anything ELSE downloaded is the
    // regression this assertion is here to name.
    const otherBuffered = objectReads
      .filter((read) => read.kind === 'download')
      .filter((read) => read.path !== opened.body.objectPath)
      .map((read) => read.path);
    expect(otherBuffered.every((path) => path.endsWith('/delivery.pdf'))).toBe(true);
  });
});
