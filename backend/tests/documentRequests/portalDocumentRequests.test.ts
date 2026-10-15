/**
 * What a portal client is served on the document requests screen, proved
 * against a SECOND client of the same firm whose request is seeded and must
 * never appear.
 *
 * Document requests are the one document surface a client both reads and writes
 * on, and the ownership rule is a single predicate: `listForClient` filters on
 * `documentRequests.clientId`, and `getClientRequestTarget` refuses a request
 * addressed to somebody else. Lose either and the portal answers a perfectly
 * ordinary 200 carrying another client's checklist. Nothing on the screen looks
 * wrong; the wrong person is simply reading what the firm asked of someone else.
 *
 * So no negative here stands on its own. Every "must not see" is paired with
 * the neighbour fetching that same record successfully in the same test, which
 * is what separates a refusal from a fixture that was never created.
 *
 * The cast, rebuilt per test:
 *
 *   `me`         a person client of the firm with one association, so no
 *                `clientRecordId` is ever needed.
 *   `neighbour`  a second person client of the SAME firm.
 *   `otherFirm`  a second firm where `me` is ALSO a client. Its request is the
 *                tenancy control: same portal login, different firm.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  createPersonClient,
  createPortalUser,
  ownerOf,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

interface PortalPerson extends Actor {
  /** The `clients` row this portal user owns in the firm under test. */
  clientId: string;
  email: string;
}

let firm: Firm;
let me: PortalPerson;
let neighbour: PortalPerson;

const portal = (lawFirmId: string, suffix: string) => `/api/client-portal/lawfirm/${lawFirmId}${suffix}`;

/** A portal user plus their own person `clients` row in one firm. */
async function portalPerson(lawFirmId: string, name: string): Promise<PortalPerson> {
  const { uid } = await createPortalUser({ name });
  const email = `${uid}@example.test`;
  const client = await createPersonClient(lawFirmId, { name, userId: uid, email });
  return { uid, clientId: client.id, email, api: as(tokenFor({ uid })) };
}

/** Attach an EXISTING portal user to a second firm as a client of that firm too. */
async function alsoClientOf(lawFirmId: string, person: PortalPerson, name: string): Promise<string> {
  const client = await createPersonClient(lawFirmId, { name, userId: person.uid, email: person.email });
  return client.id;
}

/** A document request addressed to one client, seeded straight into the tables. */
async function seedRequest(
  lawFirmId: string,
  clientId: string,
  overrides: { title?: string; status?: string; dueDate?: string | null; items?: string[] } = {},
): Promise<{ id: string; title: string }> {
  const id = randomUUID();
  const title = overrides.title ?? `Request ${id.slice(0, 8)}`;
  const request = await testPool.query(
    `insert into document_requests (id, law_firm_id, client_id, title, note, status, due_date)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      lawFirmId,
      clientId,
      title,
      'Please upload these before Friday.',
      overrides.status ?? 'open',
      overrides.dueDate ?? null,
    ],
  );
  // A missing fixture would make every leak assertion below pass for the wrong
  // reason.
  expect(request.rowCount).toBe(1);

  const labels = overrides.items ?? ['Passport'];
  for (const [sortOrder, label] of labels.entries()) {
    const item = await testPool.query(
      `insert into document_request_items (id, law_firm_id, request_id, label, sort_order)
       values ($1, $2, $3, $4, $5)`,
      [randomUUID(), lawFirmId, id, label, sortOrder],
    );
    expect(item.rowCount).toBe(1);
  }
  return { id, title };
}

const requestTitles = (body: any): string[] => (body.requests || []).map((r: any) => r.title);

beforeEach(async () => {
  firm = await createFirm();
  // The firm owner exists so the firm is a real, staffed tenant rather than an
  // empty shell; nothing in this file calls as them.
  await ownerOf(firm.id);
  me = await portalPerson(firm.id, 'Dana Client');
  neighbour = await portalPerson(firm.id, 'Rory Neighbour');
});

describe('the portal document requests list', () => {
  it('serves a client their own requests', async () => {
    const mine = await seedRequest(firm.id, me.clientId, { title: 'Your identity documents' });

    const res = await me.api.get(portal(firm.id, '/document-requests'));

    expect(res.status).toBe(200);
    expect(requestTitles(res.body)).toContain(mine.title);
  });

  it('does not serve a client another client requests', async () => {
    await seedRequest(firm.id, me.clientId, { title: 'Dana identity documents' });
    await seedRequest(firm.id, neighbour.clientId, { title: 'Rory divorce papers' });

    const mineRes = await me.api.get(portal(firm.id, '/document-requests'));
    const theirRes = await neighbour.api.get(portal(firm.id, '/document-requests'));

    // The neighbour reads their own request in the same test, so the absence
    // from Dana's list is the ownership filter working, not a missing row.
    expect(requestTitles(theirRes.body)).toContain('Rory divorce papers');
    expect(requestTitles(mineRes.body)).toContain('Dana identity documents');
    expect(requestTitles(mineRes.body)).not.toContain('Rory divorce papers');
  });

  it('does not leak another client checklist items into the body', async () => {
    await seedRequest(firm.id, me.clientId, { title: 'Dana request', items: ['Dana passport'] });
    await seedRequest(firm.id, neighbour.clientId, {
      title: 'Rory request',
      items: ['Rory decree absolute'],
    });

    const res = await me.api.get(portal(firm.id, '/document-requests'));

    // The titles are checked above; the ITEM labels are the part a naive
    // hydrate step could attach from the wrong parent, and they are the part
    // that names what the firm asked somebody for.
    expect(JSON.stringify(res.body)).toContain('Dana passport');
    expect(JSON.stringify(res.body)).not.toContain('Rory decree absolute');
  });

  it('hides a cancelled request from the client', async () => {
    await seedRequest(firm.id, me.clientId, { title: 'Still open request' });
    await seedRequest(firm.id, me.clientId, { title: 'Cancelled request', status: 'cancelled' });

    const res = await me.api.get(portal(firm.id, '/document-requests'));

    // Paired: both rows belong to the same client, so only the status can
    // account for the difference.
    expect(requestTitles(res.body)).toContain('Still open request');
    expect(requestTitles(res.body)).not.toContain('Cancelled request');
  });

  it('returns the due date as a day-only string', async () => {
    await seedRequest(firm.id, me.clientId, { title: 'Due Friday', dueDate: '2026-05-15' });

    const res = await me.api.get(portal(firm.id, '/document-requests'));

    const found = res.body.requests.find((r: any) => r.title === 'Due Friday');
    // `due_date` is a `date` column. Wrapping it in a Date would shift it a day
    // for anyone west of UTC and move the deadline the client is shown.
    expect(found.dueDate).toBe('2026-05-15');
  });
});

describe('tenancy across firms', () => {
  it('does not serve requests from another firm to the same portal login', async () => {
    const otherFirm = await createFirm({ name: 'Neighbouring Firm' });
    await ownerOf(otherFirm.id);
    const myOtherRecord = await alsoClientOf(otherFirm.id, me, 'Dana Client');
    await seedRequest(firm.id, me.clientId, { title: 'Request from firm one' });
    await seedRequest(otherFirm.id, myOtherRecord, { title: 'Request from firm two' });

    const first = await me.api.get(portal(firm.id, '/document-requests'));
    const second = await me.api.get(portal(otherFirm.id, '/document-requests'));

    // Same person, same token, two firms. Each firm's list must carry only its
    // own request even though both belong to this client.
    expect(requestTitles(first.body)).toEqual(['Request from firm one']);
    expect(requestTitles(second.body)).toEqual(['Request from firm two']);
  });

  it('refuses a portal client of no association in the firm', async () => {
    const outsider = await portalPerson(
      (await createFirm({ name: 'Unrelated Firm' })).id,
      'Unrelated Person',
    );
    await seedRequest(firm.id, me.clientId, { title: 'Not for outsiders' });

    const res = await outsider.api.get(portal(firm.id, '/document-requests'));

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('Not for outsiders');
  });

  it('refuses a firm member on the client portal routes', async () => {
    await seedRequest(firm.id, me.clientId, { title: 'Portal only' });
    const member = await ownerOf(firm.id);

    const res = await member.api.get(portal(firm.id, '/document-requests'));

    // The portal router is gated on `user_type = 'client'`. A firm member
    // reaching it would resolve no client record and the failure mode would be
    // an empty list rather than a refusal.
    expect(res.status).toBe(403);
  });
});
