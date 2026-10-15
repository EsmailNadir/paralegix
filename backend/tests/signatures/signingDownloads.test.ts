/**
 * Who may be handed a read URL for a signing document, and which bytes it can
 * ever serve.
 *
 * A signing document used to reach the signer as a stream out of the API: the
 * route authorized the caller and then piped the object through this process.
 * Handing the browser a signed URL instead is strictly better for memory and
 * strictly worse for authorization, because the URL outlives the request that
 * minted it. Two things have to be true or that trade is a disclosure:
 *
 *   - the URL is minted only AFTER the same participant, expiry, access-code
 *     and turn checks the streaming route ran, and
 *   - it names one GENERATION of the object.
 *
 * The second is the one that looks like a detail. Without it, a document
 * replaced between authorization and download serves bytes nobody authorized,
 * under a URL that was legitimately issued, and nothing anywhere reports it.
 * The test below replaces the object and requires a refusal: if it ever goes
 * green while the mint returns a URL, that is a signer being served a document
 * the sender swapped in after the fact.
 */
import crypto from 'crypto';

import { objects, putObject, signedUrlCalls } from '../support/inMemoryBucket';
import { minimalPdfBytes } from '../support/minimalPdf';
import { installRichBucket, resetRichBucket } from '../files/richBucket';
import {
  testPool,
  createFirm,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { seedSigningSession, sha256 } from '../support/signing';

installRichBucket();

const {
  mintSigningReadUrl,
  SIGNING_READ_URL_TTL_MS,
} = require('../../src/modules/signatures/signingDownloads');

let firm: Firm;
let owner: Actor;

interface Seeded {
  sessionToken: string;
  sourceObjectPath: string;
  participants: Array<{ participantId: string; publicToken: string; workingObjectPath: string }>;
}

/**
 * A live session with two participants, each with their own working copy.
 *
 * Two participants is the minimum that can show recipient scoping at all: with
 * one, "the URL is scoped to the caller" and "the URL is scoped to the session"
 * are the same statement.
 */
async function seedSession(opts: { accessCodeOn?: number[] } = {}): Promise<Seeded> {
  const suffix = crypto.randomBytes(8).toString('hex');
  const sourceObjectPath = `signing-uploads/${firm.id}/${suffix}/agreement.pdf`;

  putObject(sourceObjectPath, { body: Buffer.from('%PDF-1.7 source'), contentType: 'application/pdf' });
  const sourceGeneration = objects.get(sourceObjectPath)!.generation;

  const { rows: sourceRows } = await testPool.query(
    `insert into signature_sources
       (law_firm_id, object_path, object_generation, size_bytes, status)
     values ($1, $2, $3, $4, 'ready')
     returning id`,
    [firm.id, sourceObjectPath, sourceGeneration, 15],
  );

  const workingObjectPaths = [0, 1].map((index) => {
    const workingObjectPath = `lawfirmids/${firm.id}/signing-work/${suffix}/${index}.pdf`;
    putObject(workingObjectPath, {
      body: Buffer.from(`%PDF-1.7 working ${index}`),
      contentType: 'application/pdf',
    });
    return workingObjectPath;
  });

  const { sessionToken, participants } = await seedSigningSession({
    lawFirmId: firm.id,
    createdBy: owner.uid,
    sourceId: sourceRows[0].id,
    session: { status: 'in_progress', object_path: sourceObjectPath },
    participants: workingObjectPaths.map((workingObjectPath, index) => ({
      roleLabel: null,
      email: `signer${index + 1}@example.test`,
      columns: { working_object_path: workingObjectPath },
      challenge: (opts.accessCodeOn || []).includes(index) ? { secretHash: sha256('482913') } : undefined,
    })),
  });

  return {
    sessionToken,
    sourceObjectPath,
    participants: participants.map((p, index) => ({
      participantId: p.participantId,
      publicToken: p.publicToken,
      workingObjectPath: workingObjectPaths[index],
    })),
  };
}

/** What the mint refused with, or a failure naming what it returned instead. */
async function refusalOf(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    const minted = await promise;
    throw new Error(`Expected a refusal, got ${JSON.stringify(minted)}`);
  } catch (err: any) {
    if (err?.statusCode === undefined) throw err;
    return { status: Number(err.statusCode), code: String(err.code) };
  }
}

beforeEach(async () => {
  resetRichBucket();
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
});

// ---------------------------------------------------------------------------

describe('minting a signing read URL', () => {
  it('pins the generation the object has at mint time', async () => {
    const seeded = await seedSession();
    const [signerOne] = seeded.participants;

    const minted = await mintSigningReadUrl({ token: signerOne.publicToken, userId: null });

    const stored = objects.get(signerOne.workingObjectPath)!;
    expect(minted.objectPath).toBe(signerOne.workingObjectPath);
    expect(minted.generation).toBe(stored.generation);
    // The generation has to reach the URL itself. A mint that read the
    // generation, reported it, and then signed an unpinned handle would satisfy
    // every assertion above while serving whatever is at the path later.
    expect(minted.url).toContain(`generation=${stored.generation}`);

    const call = signedUrlCalls.at(-1)!;
    expect(call.path).toBe(signerOne.workingObjectPath);
    expect(call.generation).toBe(stored.generation);
    expect(call.config.action).toBe('read');
    // Short-lived, because the URL is a bearer credential for a legal document
    // and nothing revokes one already handed out.
    expect(Number(call.config.expires) - Date.now()).toBeLessThanOrEqual(SIGNING_READ_URL_TTL_MS + 1000);
  });

  it('refuses when the document changed after the caller was authorized', async () => {
    const seeded = await seedSession();
    const [signerOne] = seeded.participants;

    // The sender replaces the admitted source. The session still points at the
    // same path, and the participant is still exactly as authorized.
    putObject(seeded.sourceObjectPath, {
      body: Buffer.from('%PDF-1.7 SWAPPED'),
      contentType: 'application/pdf',
    });

    // Signer one reads the SOURCE (no working copy of their own), which is the
    // path whose version the session recorded.
    await testPool.query(
      'update signature_participants set working_object_path = null where id = $1',
      [signerOne.participantId],
    );

    const refusal = await refusalOf(
      mintSigningReadUrl({ token: signerOne.publicToken, userId: null }),
    );
    expect(refusal.code).toBe('SOURCE_CHANGED');
    expect(refusal.status).toBe(422);
  });

  it('refuses a caller who is not the participant the link belongs to', async () => {
    const seeded = await seedSession();
    const stranger = await memberWith(firm.id, []);

    // The SESSION token, carried by a firm member who is not a participant and
    // is not the sender facilitating an in-person signer. `resolveSigningContext`
    // resolves the session fine; what must not resolve is a participant.
    const refusal = await refusalOf(
      mintSigningReadUrl({ token: seeded.sessionToken, userId: stranger.uid }),
    );
    expect(refusal.status).toBe(403);

    // And nothing was signed on the way to the refusal. Asserting only the
    // status would pass even if a URL had been minted and then discarded, and a
    // URL that exists is a URL that can leak.
    expect(signedUrlCalls).toEqual([]);
  });

  it('refuses a participant who has not cleared their access code', async () => {
    const seeded = await seedSession({ accessCodeOn: [0] });
    const [signerOne] = seeded.participants;

    const refusal = await refusalOf(
      mintSigningReadUrl({ token: signerOne.publicToken, userId: null }),
    );
    expect(refusal.status).toBe(403);
    expect(signedUrlCalls).toEqual([]);
  });

  it('refuses a participant whose turn has not come', async () => {
    const seeded = await seedSession();
    const [, signerTwo] = seeded.participants;
    await testPool.query(
      `update signature_participants set status = 'waiting' where id = $1`,
      [signerTwo.participantId],
    );

    const refusal = await refusalOf(
      mintSigningReadUrl({ token: signerTwo.publicToken, userId: null }),
    );
    expect(refusal.status).toBe(403);
    expect(signedUrlCalls).toEqual([]);
  });

  it('refuses once the link has expired', async () => {
    const seeded = await seedSession();
    const [signerOne] = seeded.participants;
    await testPool.query(
      'update signature_sessions set expires_at = now() - interval \'1 day\' where token = $1',
      [seeded.sessionToken],
    );

    const refusal = await refusalOf(
      mintSigningReadUrl({ token: signerOne.publicToken, userId: null }),
    );
    expect(refusal.status).toBe(410);
    expect(signedUrlCalls).toEqual([]);
  });

  it('scopes each participant to their own working copy', async () => {
    const seeded = await seedSession();
    const [signerOne, signerTwo] = seeded.participants;

    const one = await mintSigningReadUrl({ token: signerOne.publicToken, userId: null });
    const two = await mintSigningReadUrl({ token: signerTwo.publicToken, userId: null });

    expect(one.objectPath).toBe(signerOne.workingObjectPath);
    expect(two.objectPath).toBe(signerTwo.workingObjectPath);
    expect(one.objectPath).not.toBe(two.objectPath);
  });
});

describe('GET /api/signing/:token/certificate', () => {
  it('returns a generation-pinned signed URL when format=json is requested', async () => {
    const seeded = await seedSession();
    await testPool.query(
      `update signature_sessions set status = 'completed' where token = $1`,
      [seeded.sessionToken],
    );
    const certPath = `lawfirmids/${firm.id}/signatures/${seeded.sessionToken}/certificate-of-completion.pdf`;
    putObject(certPath, {
      body: Buffer.from('%PDF-1.7 certificate content'),
      contentType: 'application/pdf',
    });

    const res = await owner.api.get(`/api/signing/${seeded.sessionToken}/certificate?format=json`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('url');
    expect(res.body).toHaveProperty('fileName');
    expect(res.body.fileName).toMatch(/Certificate of Completion/);
    expect(decodeURIComponent(res.body.url)).toContain(certPath);
  });

  it('redirects 302 to the signed URL when redirect=true is requested', async () => {
    const seeded = await seedSession();
    await testPool.query(
      `update signature_sessions set status = 'completed' where token = $1`,
      [seeded.sessionToken],
    );
    const certPath = `lawfirmids/${firm.id}/signatures/${seeded.sessionToken}/certificate-of-completion.pdf`;
    putObject(certPath, {
      body: Buffer.from('%PDF-1.7 certificate content'),
      contentType: 'application/pdf',
    });

    const res = await owner.api.get(`/api/signing/${seeded.sessionToken}/certificate?redirect=true`);
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.location)).toContain(certPath);
  });
});

describe('GET /api/signing/:token/verification', () => {
  it('verifies a completed session artifact through ByteRange/CMS verifier and returns distinct results', async () => {
    const seeded = await seedSession();
    const certPath = `lawfirmids/${firm.id}/signatures/${seeded.sessionToken}/signed-document.pdf`;
    const docBytes = Buffer.from('%PDF-1.7 test document content');
    const docHash = sha256(docBytes);
    putObject(certPath, {
      body: docBytes,
      contentType: 'application/pdf',
    });
    await testPool.query(
      `update signature_sessions set status = 'completed', signed_document_hash = $2, final_object_path = $3 where token = $1`,
      [seeded.sessionToken, docHash, certPath],
    );

    const res = await owner.api.get(`/api/signing/${seeded.sessionToken}/verification`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      token: seeded.sessionToken,
      copy: 'filed',
      identityMatch: true,
      sealed: false,
      sealValid: false,
    });
  });

  it('reports identityMatch false when stored artifact does not match recorded hash', async () => {
    const seeded = await seedSession();
    const certPath = `lawfirmids/${firm.id}/signatures/${seeded.sessionToken}/signed-document.pdf`;
    const docBytes = Buffer.from('%PDF-1.7 test document content');
    putObject(certPath, {
      body: docBytes,
      contentType: 'application/pdf',
    });
    await testPool.query(
      `update signature_sessions set status = 'completed', signed_document_hash = 'different-hash', final_object_path = $2 where token = $1`,
      [seeded.sessionToken, certPath],
    );

    const res = await owner.api.get(`/api/signing/${seeded.sessionToken}/verification`);
    expect(res.status).toBe(200);
    expect(res.body.identityMatch).toBe(false);
  });
});

/**
 * The preview read, which is the firm-side counterpart of the signer's read.
 *
 * `/preview` used to authorize the caller and then pipe the object through this
 * process. That is the same trade the signer's read already made, so it is made
 * the same way: authorize, then hand out a url the browser reads by range.
 *
 * The authorization is what these cases are about. A signing upload belongs to
 * whoever put it there, and nothing else about the caller grants it.
 */
describe('GET /api/signing/preview-url', () => {
  const uploadPath = () => `signing-uploads/${firm.id}/${crypto.randomBytes(6).toString('hex')}/retainer.pdf`;

  it('answers a generation-pinned url for the caller own upload', async () => {
    const objectPath = uploadPath();
    putObject(objectPath, {
      body: minimalPdfBytes({ pages: 1 }),
      contentType: 'application/pdf',
      custom: { uploadedBy: owner.uid },
    });

    const res = await owner.api.get(`/api/signing/preview-url?objectPath=${encodeURIComponent(objectPath)}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.url).toEqual(expect.stringContaining('http'));
    // Pinned, for the same reason the signer's read is: an object replaced after
    // the url was minted must not be servable by it.
    expect(res.body.generation).toBe(objects.get(objectPath)!.generation);
    expect(res.body.sizeBytes).toBe(objects.get(objectPath)!.bytes);
  });

  it('signs NOTHING for an upload somebody else left there', async () => {
    const objectPath = uploadPath();
    putObject(objectPath, {
      body: minimalPdfBytes({ pages: 1 }),
      contentType: 'application/pdf',
      custom: { uploadedBy: 'another-firm-member' },
    });
    const before = signedUrlCalls.length;

    const res = await owner.api.get(`/api/signing/preview-url?objectPath=${encodeURIComponent(objectPath)}`);

    expect(res.status).toBe(403);
    expect(res.body.url).toBeUndefined();
    // Refused BEFORE anything was signed. A url minted and then withheld is
    // still a url, and the object it names outlives this response.
    expect(signedUrlCalls.length).toBe(before);
  });

  it('names the file from the upload stamp rather than from the object path', async () => {
    // The storage path is opaque. Its last segment is a sanitised copy of the
    // name at best, and a uuid everywhere else in the app, so the name the user
    // chose is read from the stamp the upload wrote.
    const objectPath = uploadPath();
    putObject(objectPath, {
      body: minimalPdfBytes({ pages: 1 }),
      contentType: 'application/pdf',
      custom: { uploadedBy: owner.uid, originalFileName: 'Retainer Agreement.pdf' },
    });

    const res = await owner.api.get(
      `/api/signing/preview-url?objectPath=${encodeURIComponent(objectPath)}&lawFirmId=${firm.id}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.fileName).toBe('Retainer Agreement.pdf');
  });

  it('names a firm document from its row', async () => {
    // A firm document has a `files` row, and the row is what carries its name.
    const objectPath = `lawfirmids/${firm.id}/objects/${crypto.randomUUID()}`;
    putObject(objectPath, { body: minimalPdfBytes({ pages: 1 }), contentType: 'application/pdf' });
    await testPool.query(
      `insert into files (law_firm_id, kind, name, scope, object_path, finalized_at)
       values ($1, 'file', 'Firm Handbook.pdf', 'firm', $2, now())`,
      [firm.id, objectPath],
    );

    const res = await owner.api.get(
      `/api/signing/preview-url?objectPath=${encodeURIComponent(objectPath)}&lawFirmId=${firm.id}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.fileName).toBe('Firm Handbook.pdf');
  });

  describe('when the object carries no uploader stamp', () => {
    /** An unstamped upload plus the source row that records who admitted it. */
    async function unstampedUpload(uploadedBy: string): Promise<string> {
      const objectPath = uploadPath();
      putObject(objectPath, { body: minimalPdfBytes({ pages: 1 }), contentType: 'application/pdf' });
      await testPool.query(
        `insert into signature_sources (law_firm_id, uploaded_by, object_path, status)
         values ($1, $2, $3, 'ready')`,
        [firm.id, uploadedBy, objectPath],
      );
      return objectPath;
    }

    it('still admits the person the source row records as the uploader', async () => {
      const objectPath = await unstampedUpload(owner.uid);

      const res = await owner.api.get(
        `/api/signing/preview-url?objectPath=${encodeURIComponent(objectPath)}&lawFirmId=${firm.id}`,
      );

      expect(res.status).toBe(200);
      expect(res.body.url).toEqual(expect.stringContaining('http'));
    });

    it('still refuses a colleague who did not upload it', async () => {
      // The row names the uploader, and membership of the firm is not the same
      // claim. A signatures.view holder reading this would be reading a document
      // that has not been sent to anyone yet.
      const colleague = await memberWith(firm.id, ['signatures.view', 'signatures.send']);
      const objectPath = await unstampedUpload(owner.uid);
      const before = signedUrlCalls.length;

      const res = await colleague.api.get(
        `/api/signing/preview-url?objectPath=${encodeURIComponent(objectPath)}&lawFirmId=${firm.id}`,
      );

      expect(res.status).toBe(403);
      expect(signedUrlCalls.length).toBe(before);
    });

    it('refuses a request that names no firm rather than reading one out of the path', async () => {
      // The firm id used to come from the path's second segment. A path is
      // opaque, so the firm the row is looked up under is the one the request
      // states; a request that states none cannot be answered.
      const objectPath = await unstampedUpload(owner.uid);
      const before = signedUrlCalls.length;

      const res = await owner.api.get(
        `/api/signing/preview-url?objectPath=${encodeURIComponent(objectPath)}`,
      );

      expect(res.status).toBe(403);
      expect(signedUrlCalls.length).toBe(before);
    });
  });

  it('signs NOTHING for a system path', async () => {
    const objectPath = `lawfirmids/${firm.id}/signatures/sess-abc/signed-document.pdf`;
    putObject(objectPath, { body: minimalPdfBytes({ pages: 1 }), contentType: 'application/pdf' });

    const res = await owner.api.get(
      `/api/signing/preview-url?objectPath=${encodeURIComponent(objectPath)}&lawFirmId=${firm.id}`,
    );

    // An executed document and a half-signed working copy have their own routes,
    // which authorize through the session that owns them.
    expect(res.status).toBe(404);
    expect(res.body.url).toBeUndefined();
  });
});
