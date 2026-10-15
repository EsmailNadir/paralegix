/**
 * Turning a completed session into its two executed artifacts, from a queue.
 *
 * The old path ran this inside the request that carried the last signature,
 * with five whole-document passes through pdf-lib. Two things were wrong with
 * that at once: the memory, which is what the pipeline fixes, and the fact that
 * the work existed only in one process. Cloud Run stops scheduling CPU once a
 * response is sent, so an instance killed mid-finalize left a session that had
 * every signature and no document, with nothing recording that anything was
 * owed.
 *
 * These tests are about the second half. What has to break for them to go red:
 * publish an artifact reference before both seals verify, rebuild from anything
 * other than the session's own stored record. A worker that lost its lease
 * being refused its checkpoint is `signingJobs.test.ts`.
 */
import crypto from 'crypto';
import { objects, putObject, inMemoryBucket } from '../support/inMemoryBucket';
import { minimalPdf } from '../support/minimalPdf';
import { createFirm, ownerOf, testPool, type Actor, type Firm } from '../support/setupInProcess';

const signal = new AbortController().signal;

const repo = require('../../src/modules/signatures/signatures.repository');
const {
  buildSessionArtifacts, SigningFinalizeError,
} = require('../../src/modules/signatures/signingFinalize');
const { runJobNow } = require('../../src/modules/signatures/signingJobs');
const { createResumableDigest } = require('../../src/modules/signatures/pdf/resumableDigest');
const { openGcsPdfSource } = require('../../src/modules/signatures/pdf/gcsSource');
const { verifySealedArtifact } = require('../../src/modules/signatures/pdf/verifySeal');

let firm: Firm;
let owner: Actor;

beforeAll(() => {
  const { admin } = require('../../src/shared/database/firebase');
  jest.spyOn(admin, 'storage').mockReturnValue({ bucket: () => inMemoryBucket } as never);
});

afterAll(() => { jest.restoreAllMocks(); });

/** A 2x2 RGBA PNG, so a signature field has something real to draw. */
function tinyPng(): Buffer {
  const zlib = require('zlib');
  const crc32 = (buf: Buffer) => {
    let c = ~0;
    for (const byte of buf) {
      c ^= byte;
      for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c;
  };
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), body])) >>> 0, 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.from([
    0, 255, 0, 0, 255, 0, 255, 0, 128,
    0, 0, 0, 255, 255, 255, 255, 255, 0,
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const SIGNATURE_VALUE = `data:image/png;base64,${tinyPng().toString('base64')}`;

/** An admitted, prepared source with its saved hash state. */
async function preparedSource(bytes: Buffer) {
  const objectPath = `signing-uploads/${firm.id}/${crypto.randomUUID()}/prepared.pdf`;
  putObject(objectPath, { body: bytes, contentType: 'application/pdf' });
  const stored = objects.get(objectPath)!;
  const ref = { objectPath, generation: stored.generation, sizeBytes: bytes.length };

  const digest = await createResumableDigest();
  digest.update(bytes);
  const state = digest.save(ref);
  const hash = digest.digestHex();

  const source = await repo.createSource(firm.id, { uploadedBy: owner.uid, objectPath });
  return repo.updateSource(firm.id, source.id, {
    objectGeneration: ref.generation,
    sizeBytes: bytes.length,
    status: 'ready',
    documentHash: hash,
    preparedObjectPath: objectPath,
    preparedGeneration: ref.generation,
    preparedSizeBytes: bytes.length,
    preparedHash: hash,
    digestAlgorithm: 'sha256',
    digestLibraryVersion: 'sha256:hash-wasm@4',
    digestState: Buffer.from(state.state).toString('base64'),
    digestStateBytes: bytes.length,
    digestStateGeneration: ref.generation,
  });
}

/** A completed two-field session over that source. */
async function completedSession(options: {
  source?: any; fields?: any[]; base?: ReturnType<typeof minimalPdf>;
} = {}) {
  const base = options.base ?? minimalPdf({ pages: 2 });
  // Always a source. There used to be an `unsourced` option here, for sessions
  // recorded before the admission boundary existed; finalization streamed the
  // raw upload for those. Both the sessions and the fallback are gone.
  const source = options.source ?? await preparedSource(base.bytes);
  const token = crypto.randomBytes(12).toString('hex');
  const participantId = crypto.randomBytes(8).toString('hex');

  const fields = options.fields ?? [
    {
      id: 'field-sig',
      signerId: participantId,
      page: 1,
      xPercent: 10, yPercent: 70, widthPercent: 30, heightPercent: 6,
      fieldType: 'signature',
    },
    {
      id: 'field-name',
      signerId: participantId,
      page: 1,
      xPercent: 10, yPercent: 80, widthPercent: 30, heightPercent: 4,
      fieldType: 'text',
    },
  ];

  await repo.createSession({
    token,
    sessionRecord: {
      lawFirmId: firm.id,
      createdBy: owner.uid,
      sourceId: source.id,
      objectPath: source.preparedObjectPath,
      fileName: 'Retainer.pdf',
      status: 'in_progress',
      documentHash: source.documentHash,
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    },
    participantsWithTokens: [{
      participantId,
      publicToken: crypto.randomBytes(12).toString('hex'),
      name: 'Jane Roe',
      email: 'jane@example.test',
      roleLabel: 'Client',
      order: 1,
      status: 'completed',
      signerName: 'Jane Roe',
      signerIp: '198.51.100.7',
      completedAt: new Date().toISOString(),
      fieldValues: [
        { fieldId: 'field-sig', value: SIGNATURE_VALUE },
        { fieldId: 'field-name', value: 'Jane Roe' },
      ],
    }],
    fields,
  });

  if (source) await repo.updateSession(token, { sourceId: source.id });
  return { token, base, source, participantId };
}

const sessionRow = async (token: string) => {
  const { rows } = await testPool.query(
    `select status, final_object_path, signed_object_path,
            signed_document_hash, delivery_document_hash
       from signature_sessions where token = $1`,
    [token],
  );
  return rows[0];
};

beforeEach(async () => {
  objects.clear();
  await testPool.query('delete from signature_processing_jobs');
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
});

describe('producing the artifacts', () => {
  it('seals both copies and records them on the session', async () => {
    const { token } = await completedSession();

    const result = await buildSessionArtifacts({ lawFirmId: firm.id, token, signal });

    expect(result.failures).toEqual([]);
    const row = await sessionRow(token);
    expect(row.final_object_path).toBe(result.delivery.ref.objectPath);
    expect(row.signed_object_path).toBe(result.filed.ref.objectPath);
    expect(row.signed_document_hash).toBe(result.filed.digestHex);
    expect(row.delivery_document_hash).toBe(result.delivery.digestHex);
    // The two are different documents, so the two hashes have to differ.
    expect(row.signed_document_hash).not.toBe(row.delivery_document_hash);
  });

  it('produces artifacts whose seals verify when read back from storage', async () => {
    // Not the pipeline's own report: a fresh read, through the verifier a
    // recipient would use.
    const { token } = await completedSession();

    const result = await buildSessionArtifacts({ lawFirmId: firm.id, token, signal });

    for (const artifact of [result.delivery, result.filed]) {
      const stored = objects.get(artifact.ref.objectPath)!;
      const source = openGcsPdfSource({
        objectPath: artifact.ref.objectPath,
        generation: stored.generation,
        sizeBytes: stored.body!.length,
      });
      try {
        const check = await verifySealedArtifact(source, signal);
        expect({ path: artifact.ref.objectPath, valid: check.sealValid, covers: check.coversWholeFile })
          .toEqual({ path: artifact.ref.objectPath, valid: true, covers: true });
      } finally {
        await source.close();
      }
    }
  });

  it('draws every signer value the session stored', async () => {
    const { token, base } = await completedSession();

    const result = await buildSessionArtifacts({ lawFirmId: firm.id, token, signal });

    const stamped = objects.get(result.stamped.objectPath)!.body!
      .subarray(base.bytes.length).toString('latin1');
    expect(stamped).toContain('(Jane Roe)');
    expect(stamped).toContain('/Subtype /Image');
  });

  it('rebuilds from the STORED values, not from anything a request carried', async () => {
    // Which is what makes finalization repeatable: a worker that died partway
    // leaves nothing to reconcile, because the second attempt draws the same
    // marks from the same rows.
    //
    // The STAMPED source is compared, not the sealed artifacts: those carry a
    // signing time, so two runs differ by design and byte equality there would
    // be asserting the clock stood still.
    const { token } = await completedSession();

    const first = await buildSessionArtifacts({ lawFirmId: firm.id, token, signal });
    const firstStamped = Buffer.from(objects.get(first.stamped.objectPath)!.body!);
    // A retry cannot overwrite its own output: the compose is create-only. Clear
    // the artifacts the way a re-run against fresh paths would.
    for (const key of [...objects.keys()]) {
      if (key.includes('/signatures/')) objects.delete(key);
    }
    const second = await buildSessionArtifacts({ lawFirmId: firm.id, token, signal });

    expect(objects.get(second.stamped.objectPath)!.body!.equals(firstStamped)).toBe(true);
    expect(second.delivery.digestHex).not.toBe(first.delivery.digestHex);
  });

  it('never reads the source document, because it resumes the saved hash state', async () => {
    // The whole reason a 3 GB document can be finalized on a 512 MiB instance.
    const base = minimalPdf({ pages: 2, fillerBytes: 512 * 1024 });
    const { token } = await completedSession({ base });

    const result = await buildSessionArtifacts({ lawFirmId: firm.id, token, signal });

    // Both artifacts contain the source IN FULL, and it was never read to get
    // there: storage joined the objects, and the digest resumed a saved state.
    const filed = objects.get(result.filed.ref.objectPath)!.body!;
    expect(filed.length).toBeGreaterThan(base.bytes.length);
    expect(filed.subarray(0, base.bytes.length).equals(base.bytes)).toBe(true);
  });
});

describe('refusing to finish', () => {
  it('refuses a session that is not complete', async () => {
    // Sealing now would produce a tamper-evident copy of a document a signer
    // has not agreed to.
    const { token } = await completedSession();
    await testPool.query(
      `update signature_participants set status = 'active'
        where session_id = (select id from signature_sessions where token = $1)`,
      [token],
    );

    await expect(buildSessionArtifacts({ lawFirmId: firm.id, token, signal }))
      .rejects.toMatchObject({ code: 'SIGNING_SESSION_NOT_COMPLETE' });
  });

  it('refuses a session with no field values, rather than sealing a blank form', async () => {
    const { token } = await completedSession();
    await testPool.query(
      `update signature_participants set field_values = '[]'::jsonb
        where session_id = (select id from signature_sessions where token = $1)`,
      [token],
    );

    await expect(buildSessionArtifacts({ lawFirmId: firm.id, token, signal }))
      .rejects.toMatchObject({ code: 'SIGNING_NO_FIELD_VALUES' });
  });

  it('PUBLISHES NOTHING when a field cannot be placed', async () => {
    // The consent stands. What failed is the layout, and a completed session
    // pointing at a document missing one of the marks is the outcome nothing
    // downstream can detect.
    const { token } = await completedSession({
      fields: [{
        id: 'field-sig',
        signerId: 'anyone',
        page: 9,
        xPercent: 10, yPercent: 70, widthPercent: 30, heightPercent: 6,
        fieldType: 'signature',
      }],
    });

    await expect(buildSessionArtifacts({ lawFirmId: firm.id, token, signal }))
      .rejects.toMatchObject({ code: 'SIGNING_FIELDS_UNPLACEABLE' });

    const row = await sessionRow(token);
    expect(row.signed_object_path).toBeNull();
    expect(row.delivery_document_hash).toBeNull();
  });

  it('refuses a session belonging to another firm', async () => {
    const { token } = await completedSession();
    const other = await createFirm({ name: 'Vance LLP' });

    await expect(buildSessionArtifacts({ lawFirmId: other.id, token, signal }))
      .rejects.toThrow(SigningFinalizeError);
  });
});

describe('as a durable job', () => {
  it('finalizes through the queue and settles', async () => {
    const { token } = await completedSession();
    const { rows } = await testPool.query(
      'select id from signature_sessions where token = $1', [token],
    );
    const job = await repo.enqueueProcessingJob(firm.id, {
      sourceId: await firstSourceId(),
      sessionId: rows[0].id,
      kind: 'finalize',
    });

    const outcome = await runJobNow(firm.id, job.id, 'worker-a');

    expect(outcome).toBe('succeeded');
    expect((await sessionRow(token)).signed_object_path).not.toBeNull();
    expect((await repo.getProcessingJob(firm.id, job.id)).phase).toBe('sealed');
  });

});

/** The one source this firm has, for a job row that has to name one. */
async function firstSourceId(): Promise<string> {
  const { rows } = await testPool.query(
    'select id from signature_sources where law_firm_id = $1 limit 1', [firm.id],
  );
  return rows[0].id;
}
