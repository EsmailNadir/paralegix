/**
 * The privacy module's subject-rights routes: what a person can get, and what a
 * firm can destroy.
 *
 * `tests/privacy/privacy.test.ts` covers who may reach the two client-scoped
 * routes. This file covers the two self-service routes it does not touch at all,
 * and the CONTENT question on both sides of the module, which no permission
 * check can answer:
 *
 *   AN EXPORT THAT INCLUDES SOMEBODY ELSE is a data breach dressed as a GDPR
 *   compliance feature, delivered to the person least likely to report it. Every
 *   export case below seeds a SECOND person with data of exactly the same shape
 *   and asserts they are absent, having first proved the caller's own data is
 *   present.
 *
 *   AN ERASURE THAT TAKES TOO MUCH is unrecoverable, and an erasure that takes
 *   too little leaves the firm believing a legal obligation was met. So the
 *   erase cases assert BOTH halves: the rows that had to go, and the rows that
 *   had to stay.
 *
 * `auth.deleteUser` is stubbed per case. The harness's Firebase double does not
 * carry it, and the erase paths call it last, so without a stub the request
 * would 500 after the database work had already committed and every assertion
 * below would be reading a half-finished erase.
 */
import { randomUUID } from 'crypto';

import { installInMemoryBucket, objects, putObject } from '../support/inMemoryBucket';
import {
  testPool,
  request,
  drainEvents,
  createFirm,
  createFirmMember,
  createPortalUser,
  createPersonClient,
  createOrgClient,
  linkPersonToOrg,
  createInvoice,
  ownerOf,
  memberWith,
  as,
  tokenFor,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';
import { clientRow, userRow } from '../support/rows';

// Erasure fans out to `CLIENT_DELETED` listeners that sweep a client's stored
// attachments, and the harness's default bucket throws by name on every
// operation. The listeners swallow it, so nothing failed, but each erase printed
// a stack trace that buried the real output. Installed at MODULE scope because
// the storage modules resolve their bucket once, on load.
installInMemoryBucket();

const EXPORT_ME = '/api/privacy/me/export';
const ERASE_ME = '/api/privacy/me';
const ACCEPT_TERMS = '/api/privacy/accept-terms';
const erasePath = (clientId: string, lawFirmId: string) =>
  `/api/lawfirms/${lawFirmId}/clients/${clientId}/erase`;
const exportPath = (clientId: string, lawFirmId: string) =>
  `/api/lawfirms/${lawFirmId}/clients/${clientId}/data-export`;

/**
 * The Firebase double has no `deleteUser`, and `deleteAuthIdentity` rethrows
 * anything that is not `auth/user-not-found`, so an unstubbed erase 500s AFTER
 * committing its database work. Each case installs the stub it wants and the
 * afterEach puts the double back.
 */
const firebase = require('../../src/shared/database/firebase');
const deletedUids: string[] = [];

function stubAuthDelete() {
  firebase.auth.deleteUser = async (uid: string) => { deletedUids.push(uid); };
}

function stubAuthDeleteFailure() {
  firebase.auth.deleteUser = async (uid: string) => {
    deletedUids.push(uid);
    const error = new Error('Firebase unavailable');
    (error as any).code = 'auth/internal-error';
    throw error;
  };
}

beforeEach(() => {
  deletedUids.length = 0;
  delete firebase.auth.deleteUser;
});

afterEach(() => {
  delete firebase.auth.deleteUser;
});

async function countRows(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await testPool.query(sql, params);
  return Number(rows[0].n);
}

/** A note against a client, inserted directly. */
async function addClientNote(lawFirmId: string, clientId: string, content: string) {
  const { rows } = await testPool.query(
    `insert into notes (law_firm_id, client_id, content) values ($1, $2, $3)
     returning id`,
    [lawFirmId, clientId, content],
  );
  return rows[0].id as string;
}

/** A matter with this client attached to it. */
async function addMatterFor(lawFirmId: string, clientId: string, name: string) {
  const { rows } = await testPool.query(
    `insert into matters (law_firm_id, name, matter_reference_id) values ($1, $2, $3)
     returning id`,
    [lawFirmId, name, `REF-${randomUUID().slice(0, 8)}`],
  );
  const matterId = rows[0].id as string;
  await testPool.query(
    'insert into matter_clients (matter_id, client_id, law_firm_id) values ($1, $2, $3)',
    [matterId, clientId, lawFirmId],
  );
  return matterId;
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

describe('the caller own data export', () => {
  let firm: Firm;
  let me: Actor;

  beforeEach(async () => {
    firm = await createFirm({ name: 'Exporting Firm' });
    me = await memberWith(firm.id, []);
    await drainEvents();
  });

  it('returns the caller identity, memberships and stored preferences', async () => {
    await me.api.post('/api/settings/user').send({ preferences: { theme: 'dark' } });

    const res = await me.api.get(EXPORT_ME);

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(me.uid);
    expect(res.body.user.email).toBe(`${me.uid}@example.test`);
    expect(res.body.firmMemberships.map((m: any) => m.lawFirmId)).toEqual([firm.id]);
    expect(res.body.firmMemberships[0].lawFirmName).toBe('Exporting Firm');
    // Preferences are personal data too, and this is the only route that hands
    // them back in a portable form.
    expect(res.body.settings.preferences.theme).toBe('dark');
  });

  it('contains no trace of a colleague in the same firm', async () => {
    const colleague = await createFirmMember(firm.id, {
      isOwner: false, name: 'Marguerite Colleague',
    });
    await as(tokenFor({ uid: colleague.uid })).post('/api/settings/user')
      .send({ preferences: { dateFormat: 'COLLEAGUE-ONLY' } });

    const res = await me.api.get(EXPORT_ME);

    // The caller's own identity being present is what makes the absence below
    // mean something: an export that returned nothing would pass either way.
    expect(res.body.user.id).toBe(me.uid);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('Marguerite Colleague');
    expect(body).not.toContain(colleague.uid);
    expect(body).not.toContain('COLLEAGUE-ONLY');
  });

  it('returns a portal user own client records and not another client record', async () => {
    const { uid } = await createPortalUser({ name: 'Portal Person' });
    const mine = await createPersonClient(firm.id, {
      name: 'My Client Record', userId: uid, email: 'mine@example.test',
    });
    await createPersonClient(firm.id, {
      name: 'Another Client Record', email: 'theirs@example.test',
    });

    const res = await as(tokenFor({ uid })).get(EXPORT_ME);

    expect(res.status).toBe(200);
    expect(res.body.personalClientRecords.map((r: any) => r.id)).toEqual([mine.id]);
    // Two client rows in one firm. A lookup by firm rather than by
    // `clients.user_id` would hand this person the other one.
    expect(JSON.stringify(res.body)).not.toContain('Another Client Record');
  });

  it('reports the companies the caller is on the roster of, and no other roster', async () => {
    const { uid } = await createPortalUser({ name: 'Roster Person' });
    const person = await createPersonClient(firm.id, { name: 'Roster Person', userId: uid });
    const org = await createOrgClient(firm.id, { name: 'Acme Holdings' });
    await linkPersonToOrg(firm.id, person.id, org.id, { canViewBilling: true, isPrimary: true });
    // A second person on the SAME company. Their link must not appear in this
    // person's export just because it points at a company they share.
    const other = await createPersonClient(firm.id, { name: 'Someone Else Entirely' });
    await linkPersonToOrg(firm.id, other.id, org.id, { canViewBilling: false });

    const res = await as(tokenFor({ uid })).get(EXPORT_ME);

    expect(res.body.companyAssociations).toHaveLength(1);
    expect(res.body.companyAssociations[0]).toMatchObject({
      clientId: org.id, companyName: 'Acme Holdings', canViewBilling: true, isPrimary: true,
    });
    expect(JSON.stringify(res.body)).not.toContain('Someone Else Entirely');
  });

  it('answers a caller who has no client records at all', async () => {
    const res = await me.api.get(EXPORT_ME);

    expect(res.status).toBe(200);
    expect(res.body.personalClientRecords).toEqual([]);
    expect(res.body.companyAssociations).toEqual([]);
  });
});

describe('recording consent', () => {
  it('stamps the caller row and nobody else', async () => {
    const firm = await createFirm();
    const me = await memberWith(firm.id, []);
    const colleague = await createFirmMember(firm.id, { isOwner: false });

    const res = await me.api.post(ACCEPT_TERMS).send({ version: '2026-01' });

    expect(res.status).toBe(200);
    expect(res.body.consentVersion).toBe('2026-01');
    const { rows } = await testPool.query(
      'select id, consent_version, terms_accepted_at from users where id = any($1)',
      [[me.uid, colleague.uid]],
    );
    const mine = rows.find((r: any) => r.id === me.uid);
    const theirs = rows.find((r: any) => r.id === colleague.uid);
    expect(mine.consent_version).toBe('2026-01');
    expect(mine.terms_accepted_at).not.toBeNull();
    // Consent is an accountability record. A write that stamped everyone would
    // manufacture agreement from people who never saw the policy.
    expect(theirs.consent_version).toBeNull();
  });
});

describe('erasing the caller own account', () => {
  it('refuses while the caller still owns a firm, and touches nothing', async () => {
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);
    stubAuthDelete();

    const res = await owner.api.delete(ERASE_ME);

    expect(res.status).toBe(403);
    // Deleting an owner would orphan the firm and every matter, invoice and
    // trust ledger under it. The refusal has to happen BEFORE any of the
    // erasure runs, which is what these three assertions together show.
    const row = await userRow(owner.uid);
    expect(row.name).not.toBe('Deleted user');
    expect(row.email).toBe(`${owner.uid}@example.test`);
    expect(await countRows(
      'select count(*)::int as n from members where user_id = $1', [owner.uid],
    )).toBe(1);
    expect(deletedUids).toEqual([]);
  });

  it('erases a non-owner member and leaves their colleagues alone', async () => {
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);
    const me = await memberWith(firm.id, []);
    await me.api.post('/api/settings/user').send({ preferences: { theme: 'dark' } });
    stubAuthDelete();

    const res = await me.api.delete(ERASE_ME);
    await drainEvents();

    expect(res.status).toBe(200);
    const row = await userRow(me.uid);
    // A tombstone, not a deleted row: non-cascading references (a note's
    // `created_by`, a matter's `lead_user_id`) still point here.
    expect(row).not.toBeNull();
    expect(row.name).toBe('Deleted user');
    expect(row.email).not.toBe(`${me.uid}@example.test`);
    expect(await countRows(
      'select count(*)::int as n from members where user_id = $1', [me.uid],
    )).toBe(0);
    expect(await countRows(
      // Migration 0217 folded user_settings onto the user row, so the provider
      // rows are what is left to prove the erasure reached this user's own state.
      'select count(*)::int as n from user_oauth_tokens where user_id = $1', [me.uid],
    )).toBe(0);
    // The Firebase identity has to go too, or the person can still sign in to an
    // account the product believes it has erased.
    expect(deletedUids).toEqual([me.uid]);
    expect((await userRow(owner.uid)).name).not.toBe('Deleted user');
  });

  // The privacy policy promises that deleting an account deletes its product
  // analytics too, so the erasure has to reach PostHog.
  it('deletes the erased member from product analytics', async () => {
    const firm = await createFirm();
    const me = await memberWith(firm.id, []);
    stubAuthDelete();
    const saved = { key: process.env.POSTHOG_PERSONAL_API_KEY, project: process.env.POSTHOG_PROJECT_ID };
    process.env.POSTHOG_PERSONAL_API_KEY = 'phx_test';
    process.env.POSTHOG_PROJECT_ID = '1';
    const realFetch = global.fetch;
    const posthogCalls: Array<{ url: string; body: any }> = [];
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = String(input);
      if (url.includes('/persons/bulk_delete/')) {
        posthogCalls.push({ url, body: JSON.parse(init.body) });
        return new Response(null, { status: 202 });
      }
      return realFetch(input, init);
    });

    try {
      const res = await me.api.delete(ERASE_ME);
      await drainEvents();

      expect(res.status).toBe(200);
      expect(posthogCalls).toHaveLength(1);
      expect(posthogCalls[0].body).toMatchObject({ distinct_ids: [me.uid], delete_events: true });
    } finally {
      fetchSpy.mockRestore();
      process.env.POSTHOG_PERSONAL_API_KEY = saved.key ?? '';
      process.env.POSTHOG_PROJECT_ID = saved.project ?? '';
    }
  });

  it('provider failure accepts erasure for durable recovery and immediately denies application access', async () => {
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);
    const me = await memberWith(firm.id, []);
    stubAuthDeleteFailure();

    const res = await me.api.delete(ERASE_ME);

    // The SQL-side erase has already anonymized the account and removed its
    // memberships before Firebase is called. A provider outage therefore
    // leaves cleanup pending while the account stays closed to ordinary routes.
    expect(res.status).toBe(202);
    expect(res.body.erasureStatus).toBe('pending');
    expect(res.body.erasedAt).toBeUndefined();
    expect((await me.api.get('/api/users/profile')).status).toBe(401);
    const retry = await me.api.delete(ERASE_ME);
    expect(retry.status).toBe(202);
    expect(retry.body.erasureStatus).toBe('pending');
    expect((await userRow(me.uid)).name).toBe('Deleted user');
    expect(await countRows(
      'select count(*)::int as n from members where user_id = $1', [me.uid],
    )).toBe(0);
    expect(deletedUids).toEqual([me.uid, me.uid]);
    expect((await userRow(owner.uid)).name).not.toBe('Deleted user');
    expect(firm.id).toBeDefined();
  });

  it('drops a portal link but leaves the firm own record of the client', async () => {
    const firm = await createFirm();
    await ownerOf(firm.id);
    const { uid } = await createPortalUser({ name: 'Leaving Person' });
    const record = await createPersonClient(firm.id, {
      name: 'Leaving Person', userId: uid, email: 'leaving@example.test',
    });
    stubAuthDelete();

    const res = await as(tokenFor({ uid })).delete(ERASE_ME);
    await drainEvents();

    expect(res.status).toBe(200);
    const client = await clientRow(record.id);
    // The portal association goes, so nobody can sign in as this client again.
    expect(client.user_id).toBeNull();
    // The `clients` row does NOT go. It is the firm's own contact history about
    // who its client was, held under the firm's obligations, not the person's
    // authentication identity. Erasing it here would destroy the firm's file.
    expect(client.name).toBe('Leaving Person');
    expect(client.email).toBe('leaving@example.test');
  });

  it('removes a company roster link without disturbing the rest of the roster', async () => {
    const firm = await createFirm();
    await ownerOf(firm.id);
    const { uid } = await createPortalUser({ name: 'Roster Leaver' });
    const person = await createPersonClient(firm.id, { name: 'Roster Leaver', userId: uid });
    const org = await createOrgClient(firm.id, { name: 'Acme Holdings' });
    await linkPersonToOrg(firm.id, person.id, org.id, { canViewBilling: true });
    const colleague = await createPersonClient(firm.id, { name: 'Stays On Roster' });
    const keptLink = await linkPersonToOrg(firm.id, colleague.id, org.id, { canViewBilling: false });
    stubAuthDelete();

    const res = await as(tokenFor({ uid })).delete(ERASE_ME);
    await drainEvents();

    expect(res.status).toBe(200);
    expect(await countRows(
      'select count(*)::int as n from client_company_links where person_client_id = $1',
      [person.id],
    )).toBe(0);
    // One person leaving a company must not empty the company's roster, and the
    // company itself is not this person's data to erase.
    expect(await countRows(
      'select count(*)::int as n from client_company_links where id = $1', [keptLink.id],
    )).toBe(1);
    expect((await clientRow(org.id)).name).toBe('Acme Holdings');
  });
});

describe('the firm compiling one client data', () => {
  let firm: Firm;
  let owner: Actor;
  let client: ClientRecord;

  beforeEach(async () => {
    firm = await createFirm();
    owner = await ownerOf(firm.id);
    client = await createPersonClient(firm.id, {
      name: 'Subject Client', email: 'subject@example.test',
    });
    await drainEvents();
  });

  it('includes this client notes, contacts and matter ids and no other client', async () => {
    await addClientNote(firm.id, client.id, 'Note about the subject');
    await addContactFor(firm.id, client.id, 'Subject Guardian');
    const matterId = await addMatterFor(firm.id, client.id, 'Subject Matter');
    const other = await createPersonClient(firm.id, { name: 'Unrelated Client' });
    await addClientNote(firm.id, other.id, 'Note about somebody else');
    await addContactFor(firm.id, other.id, 'Unrelated Guardian');

    const res = await owner.api.get(exportPath(client.id, firm.id));

    expect(res.status).toBe(200);
    expect(res.body.client.name).toBe('Subject Client');
    expect(res.body.notes.map((n: any) => n.content)).toEqual(['Note about the subject']);
    expect(res.body.contacts.map((c: any) => c.name)).toEqual(['Subject Guardian']);
    expect(res.body.matterIds).toEqual([matterId]);
    // Two clients of one firm. Every collection here is joined by client id, so
    // a query that filtered by firm alone would put the other one in this bundle.
    expect(JSON.stringify(res.body)).not.toContain('somebody else');
    expect(JSON.stringify(res.body)).not.toContain('Unrelated Guardian');
  });

  it('cannot be pointed at another firm client', async () => {
    await addClientNote(firm.id, client.id, 'Confidential note');
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    const theirClient = await createPersonClient(otherFirm.id, { name: 'Their Own Client' });

    const trespass = await otherOwner.api.get(exportPath(client.id, otherFirm.id));
    const own = await otherOwner.api.get(exportPath(theirClient.id, otherFirm.id));

    // The control proves this caller can compile an export at all, so the 404 is
    // the tenant scope rather than a broken route or a missing permission.
    expect(own.status).toBe(200);
    expect(trespass.status).toBe(404);
    expect(JSON.stringify(trespass.body)).not.toContain('Confidential note');
  });
});

describe('the firm erasing one client', () => {
  let firm: Firm;
  let owner: Actor;
  let client: ClientRecord;

  beforeEach(async () => {
    firm = await createFirm();
    owner = await ownerOf(firm.id);
    client = await createPersonClient(firm.id, {
      name: 'Erasable Client', email: 'erasable@example.test',
    });
    await drainEvents();
  });

  it('removes only the erased client document and credits only its storage', async () => {
    objects.clear();
    const filesRepo = require('../../src/modules/files/files.repository');
    const root = await filesRepo.ensureScopeRoot(firm.id, { scope: 'client', clientId: client.id });
    const document = await filesRepo.createFile(firm.id, {
      parentId: root, name: 'identity.pdf', mimeType: 'application/pdf',
    });
    putObject(document.objectPath, { bytes: 400 });
    await filesRepo.finalize(firm.id, document.id, { sizeBytes: 400, mimeType: 'application/pdf' });
    const keeper = await createPersonClient(firm.id, { name: 'Kept Client' });
    const keeperRoot = await filesRepo.ensureScopeRoot(firm.id, { scope: 'client', clientId: keeper.id });
    const keeperDocument = await filesRepo.createFile(firm.id, {
      parentId: keeperRoot, name: 'keep.pdf', mimeType: 'application/pdf',
    });
    putObject(keeperDocument.objectPath, { bytes: 150 });
    await filesRepo.finalize(firm.id, keeperDocument.id, { sizeBytes: 150, mimeType: 'application/pdf' });
    await testPool.query('update law_firms set storage_used_bytes = 550 where id = $1', [firm.id]);
    const before = await testPool.query('select storage_used_bytes from law_firms where id = $1', [firm.id]);
    expect(objects.has(document.objectPath)).toBe(true);
    stubAuthDelete();

    const res = await owner.api.post(erasePath(client.id, firm.id));

    expect(res.status).toBe(200);
    expect(objects.has(document.objectPath)).toBe(false);
    expect(objects.has(keeperDocument.objectPath)).toBe(true);
    expect(await countRows('select count(*)::int as n from files where id = $1', [keeperDocument.id])).toBe(1);
    const after = await testPool.query('select storage_used_bytes from law_firms where id = $1', [firm.id]);
    expect(Number(after.rows[0].storage_used_bytes)).toBe(Number(before.rows[0].storage_used_bytes) - 400);
  });

  it('takes the client, its notes and its matter links, and leaves the matter', async () => {
    const noteId = await addClientNote(firm.id, client.id, 'Personal detail');
    const matterId = await addMatterFor(firm.id, client.id, 'Ongoing Matter');
    const keeper = await createPersonClient(firm.id, { name: 'Untouched Client' });
    const keeperNote = await addClientNote(firm.id, keeper.id, 'Somebody else detail');
    stubAuthDelete();

    const res = await owner.api.post(erasePath(client.id, firm.id));
    await drainEvents();

    expect(res.status).toBe(200);
    expect(await clientRow(client.id)).toBeNull();
    expect(await countRows(
      'select count(*)::int as n from notes where id = $1', [noteId],
    )).toBe(0);
    expect(await countRows(
      'select count(*)::int as n from matter_clients where client_id = $1', [client.id],
    )).toBe(0);
    // The matter is the FIRM's work product and may carry other clients, time
    // entries and a court deadline. A cascade that took it with the client would
    // destroy a live case file to satisfy one erasure request.
    expect(await countRows(
      'select count(*)::int as n from matters where id = $1', [matterId],
    )).toBe(1);
    expect(await countRows(
      'select count(*)::int as n from notes where id = $1', [keeperNote],
    )).toBe(1);
    expect((await clientRow(keeper.id)).name).toBe('Untouched Client');
  });

  it('takes the contact link and leaves the directory contact', async () => {
    const contactId = await addContactFor(firm.id, client.id, 'Shared Guardian');
    stubAuthDelete();

    const res = await owner.api.post(erasePath(client.id, firm.id));
    await drainEvents();

    expect(res.status).toBe(200);
    expect(await countRows(
      'select count(*)::int as n from contact_clients where client_id = $1', [client.id],
    )).toBe(0);
    // The directory contact is firm-wide and may be opposing counsel on three
    // other matters. Only the relationship to this client was this client's data.
    expect(await countRows(
      'select count(*)::int as n from contacts where id = $1', [contactId],
    )).toBe(1);
  });

  it('takes a company roster link and leaves the people on it', async () => {
    const org = await createOrgClient(firm.id, { name: 'Erasable Corp' });
    const person = await createPersonClient(firm.id, { name: 'Roster Member', email: 'rm@example.test' });
    await linkPersonToOrg(firm.id, person.id, org.id, { canViewBilling: true });
    stubAuthDelete();

    const res = await owner.api.post(erasePath(org.id, firm.id));
    await drainEvents();

    expect(res.status).toBe(200);
    expect(await clientRow(org.id)).toBeNull();
    expect(await countRows(
      'select count(*)::int as n from client_company_links where company_client_id = $1', [org.id],
    )).toBe(0);
    // A company's people are standalone client rows with their own matters and
    // their own billing. Erasing the company must not erase them.
    expect((await clientRow(person.id)).name).toBe('Roster Member');
  });

  it('refuses while the client has billing records, and destroys nothing', async () => {
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 412_600 });
    const noteId = await addClientNote(firm.id, client.id, 'Still here');
    stubAuthDelete();

    const res = await owner.api.post(erasePath(client.id, firm.id));
    await drainEvents();

    // Erasure cascades invoices and their payment history. A firm's accounting
    // records are not the subject's to delete, so this has to fail cleanly
    // rather than half-run.
    expect(res.status).toBe(409);
    expect((await clientRow(client.id)).name).toBe('Erasable Client');
    expect(await countRows(
      'select count(*)::int as n from invoices where id = $1', [invoice.id],
    )).toBe(1);
    expect(await countRows(
      'select count(*)::int as n from notes where id = $1', [noteId],
    )).toBe(1);
    expect(deletedUids).toEqual([]);
  });

  it('refuses while the client is under legal hold', async () => {
    await testPool.query(`insert into legal_holds (law_firm_id, client_id, reason)
       select law_firm_id, id, 'fixture hold' from clients where id = $1`, [client.id]);
    stubAuthDelete();

    const res = await owner.api.post(erasePath(client.id, firm.id));
    await drainEvents();

    // A litigation hold outranks an erasure request. The guard runs before the
    // cascade, so nothing is partially removed.
    expect(res.status).toBe(403);
    expect((await clientRow(client.id)).name).toBe('Erasable Client');
  });

  it('leaves the portal account of a person who is still a client elsewhere', async () => {
    const { uid } = await createPortalUser({ name: 'Two Firm Client' });
    await testPool.query('update clients set user_id = $2 where id = $1', [client.id, uid]);
    const otherFirm = await createFirm();
    await createPersonClient(otherFirm.id, { name: 'Two Firm Client', userId: uid });
    stubAuthDelete();

    const res = await owner.api.post(erasePath(client.id, firm.id));
    await drainEvents();

    expect(res.status).toBe(200);
    expect(await clientRow(client.id)).toBeNull();
    // This firm's relationship ended; the person's account did not. Erasing the
    // identity here would silently break their portal login at the other firm.
    expect((await userRow(uid)).name).toBe('Two Firm Client');
    expect(deletedUids).toEqual([]);
  });

  it('erases the portal account of a person with no association left anywhere', async () => {
    const { uid } = await createPortalUser({ name: 'Only Here Client' });
    await testPool.query('update clients set user_id = $2 where id = $1', [client.id, uid]);
    stubAuthDelete();

    const res = await owner.api.post(erasePath(client.id, firm.id));
    await drainEvents();

    expect(res.status).toBe(200);
    // The control for the case above. Without it, "the account survives" would
    // pass against code that never erases an identity at all.
    expect((await userRow(uid)).name).toBe('Deleted user');
    expect(deletedUids).toEqual([uid]);
  });

  it('cannot be pointed at another firm client', async () => {
    const noteId = await addClientNote(firm.id, client.id, 'Survives the trespass');
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    const theirClient = await createPersonClient(otherFirm.id, { name: 'Their Own Client' });
    stubAuthDelete();

    const trespass = await otherOwner.api.post(erasePath(client.id, otherFirm.id));
    const own = await otherOwner.api.post(erasePath(theirClient.id, otherFirm.id));
    await drainEvents();

    // The control erase proves this caller can destroy a client in their own
    // firm, which is what makes the survival below the tenant scope.
    expect(own.status).toBe(200);
    expect(await clientRow(theirClient.id)).toBeNull();
    expect(trespass.status).toBe(404);
    expect((await clientRow(client.id)).name).toBe('Erasable Client');
    expect(await countRows(
      'select count(*)::int as n from notes where id = $1', [noteId],
    )).toBe(1);
  });
});

it('housekeeping completes a pending provider erasure and does not retry completed identities', async () => {
  const firm = await createFirm();
  const owner = await ownerOf(firm.id);
  const me = await memberWith(firm.id, []);
  stubAuthDeleteFailure();
  const first = await me.api.delete(ERASE_ME);
  expect(first.status).toBe(202);
  stubAuthDelete();
  const prior = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'privacy-recovery-secret';
  try {
    const recovered = await request().post('/api/cron/housekeeping')
      .set('Authorization', 'Bearer privacy-recovery-secret');
    expect(recovered.status).toBe(200);
    expect(recovered.body.housekeeping.accountErasures.completed).toBe(1);
    const repeat = await request().post('/api/cron/housekeeping')
      .set('Authorization', 'Bearer privacy-recovery-secret');
    expect(repeat.status).toBe(200);
    expect(repeat.body.housekeeping.accountErasures.completed).toBe(0);
    expect(deletedUids).toEqual([me.uid, me.uid]);
    expect((await userRow(owner.uid)).deleted_at).toBeNull();
  } finally {
    if (prior === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prior;
  }
});
