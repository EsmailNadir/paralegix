/**
 * B11.2: export completeness and security, for the firm-initiated client data
 * export (`GET /api/lawfirms/:lawFirmId/clients/:clientId/data-export`).
 *
 * `privacy.test.ts` covers WHO may reach this route. `privacySubjectRights.test.ts`
 * covers cross-tenant/unrelated-client isolation and the shape of what comes back.
 * This file covers what neither asks: whether the export can be trusted as a
 * COMPLETE and SAFE compilation of a client's personal data specifically -
 * internal plumbing fields, scale, null-shaped optional data, and what happens
 * when compiling it fails partway through.
 *
 * Named domain inventory for this route, established by reading
 * `privacy.service.ts#exportClientData`:
 *
 *   INCLUDED  client (redacted field set - see the internal-secrets test below),
 *             contacts (directory contacts for a person / roster people for a
 *             company), notes (notes), matterIds.
 *   EXCLUDED  invoices/billing (see `privacy.test.ts` - confirmed open policy
 *             question, not this file's job), files/attachments (see the
 *             characterization test below - same shape of gap as invoices),
 *             internal identifiers on the client row itself (stripe_customer_id,
 *             user_id - fixed here, see below).
 *
 * A full named table-by-table inventory across every domain the app has is a
 * larger structural undertaking than this file attempts; see this slice's
 * report for that recommendation.
 */
import { randomUUID } from 'crypto';

import { gateMethod } from '../support/gate';
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

const clientsRepo = require('../../src/modules/clients/clients.repository');

const exportPath = (clientId: string, lawFirmId: string) =>
  `/api/lawfirms/${lawFirmId}/clients/${clientId}/data-export`;

/** A note against a client, inserted directly. */
async function addClientNote(lawFirmId: string, clientId: string, content: string) {
  const { rows } = await testPool.query(
    `insert into notes (law_firm_id, client_id, content) values ($1, $2, $3)
     returning id`,
    [lawFirmId, clientId, content],
  );
  return rows[0].id as string;
}

/** A directory contact linked to a client. */
async function addContactFor(lawFirmId: string, clientId: string, name: string) {
  const { rows } = await testPool.query(
    'insert into contacts (law_firm_id, name) values ($1, $2) returning id',
    [lawFirmId, name],
  );
  const contactId = rows[0].id as string;
  await testPool.query(
    'insert into contact_clients (law_firm_id, contact_id, client_id) values ($1, $2, $3)',
    [lawFirmId, contactId, clientId],
  );
  return contactId;
}

let firm: Firm;
let owner: Actor;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  await drainEvents();
});

describe('client export field safety', () => {
  it('excludes internal secrets and provider/authentication identifiers from the client record', async () => {
    const { rows: [{ id: portalUid }] } = await testPool.query(
      `insert into users (id, email, name, user_type) values ($1, $2, $3, 'client') returning id`,
      [`portal-${randomUUID().slice(0, 8)}`, `secret-${randomUUID().slice(0, 8)}@example.test`, 'Provider Secret Person'],
    );
    const client = await createPersonClient(firm.id, {
      name: 'Provider Secret Person', userId: portalUid, email: 'secret@example.test',
    });
    await testPool.query(
      `update clients set stripe_customer_id = $2 where id = $1`,
      [client.id, 'cus_SuperSecretStripeId999'],
    );

    const res = await owner.api.get(exportPath(client.id, firm.id));

    expect(res.status).toBe(200);
    // The positive control: the caller's own data is genuinely present, so the
    // absences below mean the fields were withheld, not that the route 404'd.
    expect(res.body.client.name).toBe('Provider Secret Person');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('cus_SuperSecretStripeId999');
    expect(body).not.toContain(portalUid);
    expect(res.body.client).not.toHaveProperty('stripeCustomerId');
    expect(res.body.client).not.toHaveProperty('userId');
  });
});

describe('client export at scale', () => {
  it('returns every note and every contact, with no truncation and no cross-join duplication', async () => {
    const client = await createPersonClient(firm.id, { name: 'Scale Client' });
    const noteCount = 30;
    const contactCount = 12;
    // Sequential on purpose: parallel inserts against the same client row would
    // still be correct, but a for-of keeps this test's own SQL boring and
    // avoids masking a real failure behind a Promise.all rejection.
    for (let i = 0; i < noteCount; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await addClientNote(firm.id, client.id, `Note number ${i}`);
    }
    for (let i = 0; i < contactCount; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await addContactFor(firm.id, client.id, `Contact number ${i}`);
    }

    const res = await owner.api.get(exportPath(client.id, firm.id));

    expect(res.status).toBe(200);
    // A silent LIMIT would fail these lengths; a fan-out join between the two
    // independent collections would inflate them to 30*12=360 instead.
    expect(res.body.notes).toHaveLength(noteCount);
    expect(res.body.contacts).toHaveLength(contactCount);
    const noteContents = res.body.notes.map((n: any) => n.content);
    expect(noteContents).toContain('Note number 0');
    expect(noteContents).toContain('Note number 29');
    const contactNames = res.body.contacts.map((c: any) => c.name);
    expect(contactNames).toContain('Contact number 0');
    expect(contactNames).toContain('Contact number 11');
  });
});

describe('client export content fidelity', () => {
  it('preserves unicode names and note content exactly', async () => {
    const unicodeName = 'Zoë Müller 日本語 🎉';
    const unicodeNote = 'Met at the café — discussed 契約 (contract) terms. 😊';
    const client = await createPersonClient(firm.id, { name: unicodeName, email: 'unicode@example.test' });
    await addClientNote(firm.id, client.id, unicodeNote);
    await addContactFor(firm.id, client.id, 'Renée Côté');

    const res = await owner.api.get(exportPath(client.id, firm.id));

    expect(res.status).toBe(200);
    expect(res.body.client.name).toBe(unicodeName);
    expect(res.body.notes[0].content).toBe(unicodeNote);
    expect(res.body.contacts[0].name).toBe('Renée Côté');
  });
});

describe('client export with missing optional references', () => {
  it('includes null-shaped notes and contacts rather than dropping or erroring on them', async () => {
    const client = await createPersonClient(firm.id, { name: 'Sparse Client' });
    await addClientNote(firm.id, client.id, 'Bare note with no author');
    await addContactFor(firm.id, client.id, 'Phoneless Contact');

    const res = await owner.api.get(exportPath(client.id, firm.id));

    expect(res.status).toBe(200);
    expect(res.body.notes[0].content).toBe('Bare note with no author');
    expect(res.body.notes[0].created_by).toBeNull();
    expect(res.body.contacts[0].name).toBe('Phoneless Contact');
    expect(res.body.contacts[0].email).toBeNull();
    expect(res.body.contacts[0].phone).toBeNull();
    // No matter was ever attached - the export must say so, not omit the key
    // or crash resolving it.
    expect(res.body.matterIds).toEqual([]);
  });
});

describe('client export and files', () => {
  it('CHARACTERIZED, NOT ENDORSED: an uploaded file is absent from the export', async () => {
    const client = await createPersonClient(firm.id, { name: 'Filed Client' });
    await testPool.query(
      `insert into files (law_firm_id, name, mime_type, size_bytes, object_path, client_id, scope)
       values ($1, $2, $3, $4, $5, $6, 'client')`,
      [firm.id, 'passport-scan.pdf', 'application/pdf', 204_800, `clients/${client.id}/passport-scan.pdf`, client.id],
    );

    const res = await owner.api.get(exportPath(client.id, firm.id));

    expect(res.status).toBe(200);
    // Same shape of gap as the invoices omission characterized in
    // privacy.test.ts: a real record exists for this client and this endpoint
    // does not reach the `files` table at all. Whether a subject access
    // request should include stored documents is a policy question, so this
    // pins today's scope rather than asserting a wider one.
    expect(Object.keys(res.body).sort()).toEqual(
      ['client', 'contacts', 'exportedAt', 'matterIds', 'notes'],
    );
    expect(JSON.stringify(res.body)).not.toContain('passport-scan.pdf');
  });
});

describe('client export failure handling', () => {
  it('fails the whole request rather than returning a partial archive when one section errors', async () => {
    const client = await createPersonClient(firm.id, { name: 'Should Not Leak Partial Data' });
    await addClientNote(firm.id, client.id, 'Sensitive note content');
    const gate = gateMethod(clientsRepo, 'listMatterIds');
    gate.failNext(new Error('simulated matterIds failure'));

    try {
      const res = await owner.api.get(exportPath(client.id, firm.id));

      // `Promise.all` in `exportClientData` rejects as soon as any one section
      // fails, before the response object is ever built, so nothing partial is
      // sent - this is the fail-closed contract this route relies on in place
      // of an explicit "missing sections" list.
      expect(res.status).toBeGreaterThanOrEqual(500);
      const body = JSON.stringify(res.body ?? {});
      expect(body).not.toContain('Should Not Leak Partial Data');
      expect(body).not.toContain('Sensitive note content');
    } finally {
      gate.restore();
    }
  });
});
