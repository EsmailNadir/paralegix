import { testPool, truncateAll, closeTestPool } from './db';
import { createFirm, createFirmMember } from './factories';
import {
  seedSigningSession,
  completionBody,
  sha256,
  makePdf,
  TINY_PNG,
  SIGNATURE_DATA_URL,
  storeSigningSource,
  seedSigningParticipant,
} from './signing';
import { objects } from './inMemoryBucket';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestPool();
});

describe('seedSigningSession', () => {
  it('writes the session, each participant and each public token under the firm', async () => {
    const firm = await createFirm();
    const owner = await createFirmMember(firm.id);

    const seeded = await seedSigningSession({
      lawFirmId: firm.id,
      createdBy: owner.uid,
      session: { status: 'in_progress', current_signer_order: 2 },
      participants: [
        { name: 'Ada First', status: 'completed', consumed: true },
        { name: 'Ben Second', status: 'active', email: null, roleLabel: null },
      ],
    });

    const { rows: sessions } = await testPool.query(
      `select law_firm_id, created_by, status, current_signer_order, file_name, source_id
         from signature_sessions where token = $1`,
      [seeded.sessionToken],
    );
    expect(sessions).toEqual([{
      law_firm_id: firm.id,
      created_by: owner.uid,
      status: 'in_progress',
      current_signer_order: 2,
      file_name: 'Engagement Agreement.pdf',
      source_id: expect.any(String),
    }]);

    const { rows: participants } = await testPool.query(
      `select p.id, p.name, p.email, p.signing_order, p.status, p.role_label,
              t.token, t.consumed_at is not null as consumed
         from signature_participants p
         join signature_participant_tokens t on t.participant_id = p.id
        where p.law_firm_id = $1 order by p.signing_order`,
      [firm.id],
    );
    expect(participants).toEqual([
      {
        id: seeded.participants[0].participantId, name: 'Ada First', email: 'adafirst@example.test',
        signing_order: 1, status: 'completed', role_label: 'Signer 1',
        token: seeded.participants[0].publicToken, consumed: true,
      },
      {
        id: seeded.participants[1].participantId, name: 'Ben Second', email: null,
        signing_order: 2, status: 'active', role_label: null,
        token: seeded.participants[1].publicToken, consumed: false,
      },
    ]);
  });

  it('writes an access-code challenge and fields only for the participant that names them', async () => {
    const firm = await createFirm();
    const owner = await createFirmMember(firm.id);

    const seeded = await seedSigningSession({
      lawFirmId: firm.id,
      createdBy: owner.uid,
      participants: [
        {
          name: 'Ada First',
          challenge: { secretHash: sha256('482913'), attempts: 3 },
          fields: [{ fieldType: 'text', label: 'Full name' }, { fieldType: 'signature' }],
        },
        { name: 'Ben Second' },
      ],
    });
    const [ada, ben] = seeded.participants;

    const { rows: challenges } = await testPool.query(
      `select participant_id, kind, secret_hash, attempts, verified_at
         from signature_challenges where law_firm_id = $1`,
      [firm.id],
    );
    expect(challenges).toEqual([{
      participant_id: ada.participantId, kind: 'access_code', secret_hash: sha256('482913'),
      attempts: 3, verified_at: null,
    }]);

    const { rows: fields } = await testPool.query(
      `select id, signer_id, field_type, label, required, sort_order
         from signature_fields where law_firm_id = $1 order by sort_order`,
      [firm.id],
    );
    expect(fields).toEqual([
      { id: ada.fieldIds[0], signer_id: ada.participantId, field_type: 'text', label: 'Full name', required: true, sort_order: 0 },
      { id: ada.fieldIds[1], signer_id: ada.participantId, field_type: 'signature', label: 'Field 2', required: true, sort_order: 1 },
    ]);
    expect(ben.fieldIds).toEqual([]);
  });

  it('skips the public token row when a participant is seeded without one', async () => {
    const firm = await createFirm();
    const owner = await createFirmMember(firm.id);

    const seeded = await seedSigningSession({
      lawFirmId: firm.id,
      createdBy: owner.uid,
      participants: [{ name: 'Ada First', token: false }],
    });

    const { rows } = await testPool.query(
      'select count(*)::int as n from signature_participant_tokens where law_firm_id = $1',
      [firm.id],
    );
    expect(rows[0].n).toBe(0);
    expect(seeded.participants[0].publicToken).toBe('');
  });
});

describe('seedSigningParticipant', () => {
  it('adds a participant and its token to a session that already exists', async () => {
    const firm = await createFirm();
    const owner = await createFirmMember(firm.id);
    const { sessionToken } = await seedSigningSession({ lawFirmId: firm.id, createdBy: owner.uid });

    const added = await seedSigningParticipant(
      { sessionToken },
      { name: 'Cy Third', order: 3, status: 'waiting' },
    );

    const { rows } = await testPool.query(
      `select p.name, p.signing_order, p.status, t.token
         from signature_participants p
         join signature_participant_tokens t on t.participant_id = p.id
        where p.id = $1`,
      [added.participantId],
    );
    expect(rows).toEqual([{ name: 'Cy Third', signing_order: 3, status: 'waiting', token: added.publicToken }]);
    expect(added.publicToken).toMatch(/^pub-[0-9a-f]{16}$/);
  });
});

describe('storeSigningSource', () => {
  it('stores the bytes and points the firm source at that exact generation', async () => {
    const firm = await createFirm();
    const pdf = await makePdf(1);

    const objectPath = await storeSigningSource(firm.id, pdf);

    const stored = objects.get(objectPath)!;
    expect(stored.body).toEqual(pdf);
    expect(objectPath).toMatch(new RegExp(`^signing-uploads/${firm.id}/[0-9a-f]{16}/agreement\\.pdf$`));
    const { rows } = await testPool.query(
      `select prepared_object_path, prepared_generation, prepared_size_bytes
         from signature_sources where law_firm_id = $1`,
      [firm.id],
    );
    expect(rows).toEqual([{
      prepared_object_path: objectPath,
      prepared_generation: stored.generation,
      prepared_size_bytes: String(pdf.length),
    }]);
  });
});

describe('the small signing fixtures', () => {
  it('builds a completion body a signer would post', () => {
    const body = completionBody({ sourceRevision: 'rev-1', consentName: 'Ada First' });

    expect(body).toEqual({
      consentAgreed: true,
      consentName: 'Ada First',
      consentTimestamp: expect.any(String),
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      sourceRevision: 'rev-1',
    });
  });

  it('hashes strings and buffers to the same hex digest', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256(Buffer.from('abc'))).toBe(sha256('abc'));
  });

  it('makes a PDF with the page count asked for', async () => {
    const { PDFDocument } = require('pdf-lib');
    const doc = await PDFDocument.load(await makePdf(3));

    expect(doc.getPageCount()).toBe(3);
  });

  it('carries a real PNG as the signature value', () => {
    expect(TINY_PNG.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(SIGNATURE_DATA_URL).toBe(`data:image/png;base64,${TINY_PNG.toString('base64')}`);
  });
});
