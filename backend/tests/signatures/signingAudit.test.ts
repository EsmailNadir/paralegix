/**
 * Re-reading a sealed artifact, to catch what nothing else can.
 *
 * Finalizing a large document is cheap because it RESUMES the hash state
 * preparation saved. Verification in the same request resumes the same state.
 * That is the design, and it is also a blind spot: a defect in the resume path
 * produces the same wrong answer twice, and the two agree with each other.
 *
 * The audit is the one reader that recomputes from nothing. So the test that
 * matters here is not "a correct artifact passes": it is that a corrupted one
 * FAILS, and fails as an alert rather than as a retry, because a mismatch means
 * either storage changed under a sealed document or this service computed a
 * digest that does not describe it.
 */
import crypto from 'crypto';
import { objects, putObject, inMemoryBucket } from '../support/inMemoryBucket';
import { minimalPdf } from '../support/minimalPdf';
import { createFirm, ownerOf, testPool, type Actor, type Firm } from '../support/setupInProcess';
import { buildIncrementalUpdate } from '../../src/modules/signatures/pdf/writer';
import { sealSuffix } from '../../src/modules/signatures/pdf/seal';
import { createResumableDigest } from '../../src/modules/signatures/pdf/resumableDigest';
import type { PdfDict, PdfSource, PdfValue } from '../../src/modules/signatures/pdf/types';

const signal = new AbortController().signal;

const dict = (entries: Record<string, PdfValue>): PdfDict =>
  ({ kind: 'dict', entries: new Map(Object.entries(entries)) });
const name = (value: string): PdfValue => ({ kind: 'name', value });
const ref = (n: number): PdfValue => ({ kind: 'ref', value: { objectNumber: n, generationNumber: 0 } });
const array = (values: PdfValue[]): PdfValue => ({ kind: 'array', values });

const repo = require('../../src/modules/signatures/signatures.repository');
const { auditOneArtifact } = require('../../src/modules/signatures/signingAudit');

let firm: Firm;
let owner: Actor;

function sourceOver(bytes: Buffer): PdfSource {
  return {
    ref: { objectPath: 'base.pdf', generation: '1', sizeBytes: bytes.length },
    async read(start, length) { return new Uint8Array(bytes.subarray(start, start + length)); },
    async *stream(start, end) { yield new Uint8Array(bytes.subarray(start, end)); },
    async close() {},
  };
}

function makeIdentity() {
  const forge = require('node-forge');
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const attrs = [{ name: 'commonName', value: 'Paralegix Test Signer' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certificatePem: forge.pki.certificateToPem(cert),
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

let identity: ReturnType<typeof makeIdentity>;

beforeAll(() => {
  identity = makeIdentity();
  const { admin } = require('../../src/shared/database/firebase');
  jest.spyOn(admin, 'storage').mockReturnValue({ bucket: () => inMemoryBucket } as never);
});

afterAll(() => { jest.restoreAllMocks(); });

/** A sealed artifact, exactly as the pipeline would produce one. */
async function sealedArtifact(): Promise<Buffer> {
  const base = minimalPdf();
  const source = sourceOver(base.bytes);
  const update = buildIncrementalUpdate({
    baseSize: base.bytes.length,
    previousXrefOffset: base.xrefAt,
    trailer: dict({ Size: 5, Root: ref(1) }),
    objects: [
      {
        ref: { objectNumber: 5, generationNumber: 0 },
        signaturePlaceholder: { contentsCapacity: 4096 },
        value: dict({ Type: name('Sig'), Filter: name('Adobe.PPKLite'), SubFilter: name('adbe.pkcs7.detached') }),
      },
      {
        ref: { objectNumber: 6, generationNumber: 0 },
        value: dict({
          Type: name('Annot'), Subtype: name('Widget'), FT: name('Sig'),
          Rect: array([0, 0, 0, 0]), V: ref(5), P: ref(3),
        }),
      },
      { ref: { objectNumber: 7, generationNumber: 0 }, value: dict({ Fields: array([ref(6)]), SigFlags: 3 }) },
      { ref: { objectNumber: 1, generationNumber: 0 }, value: dict({ Type: name('Catalog'), Pages: ref(2), AcroForm: ref(7) }) },
    ],
  });
  const digest = await createResumableDigest();
  digest.update(base.bytes);
  const sealed = await sealSuffix({
    source, update, identity, savedDigest: digest.save(source.ref), signal,
  });
  return Buffer.concat([base.bytes, Buffer.from(sealed.suffix)]);
}

/** A completed session pointing at a stored artifact. */
async function completedSession(artifact: Buffer, over: { hash?: string } = {}) {
  const objectPath = `lawfirmids/${firm.id}/signatures/${crypto.randomUUID()}/filed.pdf`;
  putObject(objectPath, { body: artifact, contentType: 'application/pdf' });
  const token = crypto.randomBytes(12).toString('hex');
  const { rows } = await testPool.query(
    `insert into signature_sessions
       (token, law_firm_id, source_id, status, completed_at, signed_object_path, signed_document_hash)
     values ($1, $2, (select id from signature_sources where law_firm_id = $2 order by created_at limit 1), 'completed', now(), $3, $4)
     returning id`,
    [
      token, firm.id, objectPath,
      over.hash ?? crypto.createHash('sha256').update(artifact).digest('hex'),
    ],
  );
  return { id: rows[0].id, token, objectPath };
}

const auditRow = async (id: string) => {
  const { rows } = await testPool.query(
    'select audited_at, audit_result, audit_detail from signature_sessions where id = $1', [id],
  );
  return rows[0];
};

beforeEach(async () => {
  objects.clear();
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
});

describe('auditing a sampled artifact', () => {
  it('passes an artifact whose stored bytes and seal both hold', async () => {
    const session = await completedSession(await sealedArtifact());

    const outcome = await auditOneArtifact();

    expect(outcome.sessionId).toBe(session.id);
    expect(outcome.result).toBe('ok');
    expect((await auditRow(session.id)).audit_result).toBe('ok');
  });

  it('REPORTS A MISMATCH when one stored byte changed', async () => {
    // The case the whole thing exists for. Nothing else in the system would
    // notice: every other reader resumes a state computed from the bytes as
    // they were, so it keeps agreeing with itself.
    const artifact = await sealedArtifact();
    const session = await completedSession(artifact);
    const stored = objects.get(session.objectPath)!;
    stored.body![80] ^= 0x01;

    const outcome = await auditOneArtifact();

    expect(outcome.result).toBe('mismatch');
    expect((await auditRow(session.id)).audit_detail).toContain('Stored bytes hash to');
  });

  it('REPORTS A MISMATCH when the recorded hash is not the artifact', async () => {
    // The other direction: the bytes are fine and the row is wrong. Both mean
    // the session cannot say what it produced.
    const session = await completedSession(await sealedArtifact(), { hash: 'f'.repeat(64) });

    const outcome = await auditOneArtifact();

    expect(outcome.result).toBe('mismatch');
  });

  it('reports an artifact that is not in storage as unreadable, not as a mismatch', async () => {
    // A missing object is an operations problem. Calling it a mismatch would
    // put a tampering alert in front of someone for a deleted file.
    const session = await completedSession(await sealedArtifact());
    objects.delete(session.objectPath);

    const outcome = await auditOneArtifact();

    expect(outcome.result).toBe('unreadable');
  });

  it('reports a mismatch when the seal itself does not verify', async () => {
    // An artifact whose bytes match the record and whose signature does not.
    // The stored hash cannot catch this: it never looked at the signature.
    const artifact = await sealedArtifact();
    // Alter a covered byte and re-record the hash, so identity passes.
    artifact[80] ^= 0x01;
    const session = await completedSession(artifact);

    const outcome = await auditOneArtifact();

    expect(outcome.result).toBe('mismatch');
    expect((await auditRow(session.id)).audit_detail).toMatch(/seal did not verify/);
  });
});

describe('choosing what to audit', () => {
  it('takes the least recently audited session, and stamps it as taken', async () => {
    // The stamp goes on in the same statement that picks the row. Without it
    // two draining instances audit the same artifact and leave the rest
    // unchecked for ever.
    const first = await completedSession(await sealedArtifact());
    const second = await completedSession(await sealedArtifact());

    const one = await auditOneArtifact();
    const two = await auditOneArtifact();
    const three = await auditOneArtifact();

    expect([one.sessionId, two.sessionId].sort()).toEqual([first.id, second.id].sort());
    // Both were just audited, so neither is due again yet.
    expect(three.sessionId).toBeNull();
    expect((await auditRow(first.id)).audited_at).not.toBeNull();
  });

  it('does not re-audit an artifact that was audited recently', async () => {
    // Fixity is checked on ingest and then on an interval. Re-reading the same
    // signed PDF from storage every drain costs a download and a full hash every
    // minute and finds nothing the interval check would not.
    const recent = await completedSession(await sealedArtifact());
    await testPool.query(
      `update signature_sessions set audited_at = now() - interval '1 day' where id = $1`, [recent.id],
    );

    expect((await auditOneArtifact()).sessionId).toBeNull();
  });

  it('re-audits an artifact whose last audit is older than the interval', async () => {
    const stale = await completedSession(await sealedArtifact());
    await testPool.query(
      `update signature_sessions set audited_at = now() - interval '31 days' where id = $1`, [stale.id],
    );

    const outcome = await auditOneArtifact();

    expect(outcome.sessionId).toBe(stale.id);
    expect(outcome.result).toBe('ok');
  });

  it('audits a never-audited artifact before one that is due for a re-audit', async () => {
    const stale = await completedSession(await sealedArtifact());
    await testPool.query(
      `update signature_sessions set audited_at = now() - interval '90 days' where id = $1`, [stale.id],
    );
    const fresh = await completedSession(await sealedArtifact());

    expect((await auditOneArtifact()).sessionId).toBe(fresh.id);
    expect((await auditOneArtifact()).sessionId).toBe(stale.id);
  });

  it('reports nothing to audit rather than failing when no session qualifies', async () => {
    // The drain calls this every run. Throwing on an empty queue would make an
    // ordinary state look like a fault.
    const outcome = await auditOneArtifact();

    expect(outcome.sessionId).toBeNull();
    expect(outcome.result).toBeUndefined();
  });

  it('ignores a session that never completed', async () => {
    const token = crypto.randomBytes(12).toString('hex');
    await testPool.query(
      `insert into signature_sessions (token, law_firm_id, source_id, status) values ($1, $2, (select id from signature_sources where law_firm_id = $2 order by created_at limit 1), 'in_progress')`,
      [token, firm.id],
    );

    expect((await auditOneArtifact()).sessionId).toBeNull();
  });
});
