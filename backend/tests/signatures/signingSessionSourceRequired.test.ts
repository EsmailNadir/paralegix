/**
 * A session names the source it was built from, from the moment it exists.
 *
 * The JSON upload path always did. The signature-links path, which is how a
 * firm document or a template becomes a signing session, recorded only an
 * object PATH and left a `signature_sources` row to be claimed later, at
 * finalize, from an object nothing had inspected.
 *
 * That claim existed for sessions created before the admission boundary did.
 * There are none: the product has no users. What it costs while it stands is
 * the whole point of admitting at all. A document that cannot be signed is
 * refused when the LAST signer finishes rather than when the sender sends, so
 * every invitation has already gone out; and the flatten and the hash that
 * sealing needs are redone per session over bytes that never change.
 */
import {
  testPool,
  createFirm,
  createPersonClient,
  ownerOf,
  drainEvents,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { installInMemoryBucket, objects, putObject } from '../support/inMemoryBucket';
import { minimalPdfBytes } from '../support/minimalPdf';

installInMemoryBucket();

let firm: Firm;
let owner: Actor;
let clientId: string;
let sourcePath: string;

const links = (lawFirmId: string) => `/api/lawfirms/${lawFirmId}/signature-links`;

const generate = (actor: Actor, body: Record<string, unknown> = {}) =>
  actor.api.post(`${links(firm.id)}/generate`).send({
    objectPath: sourcePath,
    fileName: 'Engagement Agreement.pdf',
    signers: [{ name: 'Ada Client', email: 'ada@client.test', roleLabel: 'Client' }],
    ...body,
  });

async function sessionRow(token: string) {
  const { rows } = await testPool.query(
    'select source_id, object_path from signature_sessions where token = $1',
    [token],
  );
  return rows[0];
}

async function sourceRow(id: string) {
  const { rows } = await testPool.query(
    'select status, object_path, prepared_object_path from signature_sources where id = $1',
    [id],
  );
  return rows[0];
}

beforeEach(async () => {
  objects.clear();
  firm = await createFirm({ name: 'Denton & Associates' });
  owner = await ownerOf(firm.id);
  clientId = (await createPersonClient(firm.id, { name: 'Ada Client', email: 'ada@client.test' })).id;
  sourcePath = `lawfirmids/${firm.id}/general/Engagement Agreement.pdf`;
  putObject(sourcePath, { body: minimalPdfBytes({ pages: 2 }), contentType: 'application/pdf' });
  await drainEvents();
});

describe('sending a firm document for signature', () => {
  it('records a READY source on the session it creates', async () => {
    const res = await generate(owner);
    expect(res.status).toBe(200);
    const session = await sessionRow(res.body.sessionToken);
    expect(session.source_id).toEqual(expect.any(String));

    const source = await sourceRow(session.source_id);
    // Prepared inline, because the document is under the inline threshold. The
    // signer's first read is of the PREPARED copy, forms flattened, and sealing
    // resumes that copy's saved hash state instead of reading it again.
    expect(source.status).toBe('ready');
    expect(source.prepared_object_path).toEqual(expect.any(String));
  });

  it('names the object the session actually points at', async () => {
    const res = await generate(owner);

    const session = await sessionRow(res.body.sessionToken);
    const source = await sourceRow(session.source_id);
    // A source row describing a different object is worse than none: the
    // readiness check would pass for bytes nobody is signing.
    expect(source.object_path).toBe(session.object_path);
  });

  it('refuses a document the boundary refuses, before anyone is invited', async () => {
    putObject(sourcePath, { body: minimalPdfBytes({ encrypted: true }), contentType: 'application/pdf' });

    const res = await generate(owner);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PDF_ENCRYPTED');
    const { rows } = await testPool.query(
      'select count(*)::int as n from signature_sessions where law_firm_id = $1', [firm.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('admits the FROZEN copy, not the firm document it was taken from', async () => {
    const res = await generate(owner);

    const session = await sessionRow(res.body.sessionToken);
    const source = await sourceRow(session.source_id);
    // The send freezes a copy so the firm cannot alter what is being signed
    // mid-session. Admitting the original would tie the session's source row to
    // an object the firm can still replace.
    expect(source.object_path).not.toBe(sourcePath);
    expect(objects.has(sourcePath)).toBe(true);
  });
});

describe('the column', () => {
  it('cannot hold a session with no source', async () => {
    await expect(testPool.query(
      `insert into signature_sessions (token, law_firm_id, status)
       values ('orphan-token', $1, 'pending')`,
      [firm.id],
    )).rejects.toMatchObject({ code: '23502' });
  });
});
