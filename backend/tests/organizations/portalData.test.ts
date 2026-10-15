/**
 * What a portal user actually SEES, once they are through the door.
 *
 * `portalAccess.test.ts` covers who may act as which client record. This file
 * covers the next question, which is the one a client experiences: given that
 * they are acting as an organization, what data comes back, and what must not.
 *
 * The failure mode being hunted is not a refusal. It is a list endpoint that
 * scopes by FIRM instead of by the acting client record, which shows one client
 * another client's work while returning a perfectly ordinary 200. Nobody
 * notices, because the screen looks right.
 *
 * So every case here pairs a positive with a negative: the record they are
 * acting as, and a second client of the same firm they must never see.
 */
import {
  testPool,
  drainEvents,
  createPersonClient,
  createOrgClient,
  linkPersonToOrg,
  createPortalUser,
  as,
  tokenFor,
  resetCaches,
} from '../support/setupInProcess';
import { buildOrgWorld, type OrgWorld } from './world';
import { randomUUID } from 'node:crypto';

let world: OrgWorld;
/** A client of the same firm with no connection to the organization. */
let stranger: { id: string };
/** A matter belonging to the organization. */
let orgMatterId: string;
/** A matter belonging to the unrelated client. */
let strangerMatterId: string;

const F = () => `/api/client-portal/lawfirm/${world.firm.id}`;

/** Act as a given client record, which a multi-association caller must do. */
const asOrg = (suffix: string) =>
  `${F()}${suffix}${suffix.includes('?') ? '&' : '?'}clientRecordId=${world.org.id}`;

async function makeMatter(name: string, clientId: string, clientName: string) {
  const res = await world.owner.api.post(`/api/lawfirms/${world.firm.id}/matters`).send({
    name, clients: [{ clientId, name: clientName }],
  });
  return res.body.matterId as string;
}

beforeEach(async () => {
  world = await buildOrgWorld();
  stranger = await createPersonClient(world.firm.id, { name: 'Unrelated Client' });
  orgMatterId = await makeMatter('Organization Matter', world.org.id, world.orgName);
  strangerMatterId = await makeMatter('Unrelated Matter', stranger.id, 'Unrelated Client');
  await drainEvents();
});

describe('matters', () => {
  it('shows the organization its own matters', async () => {
    const res = await world.billing.api.get(asOrg('/matters'));

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('Organization Matter');
  });

  it('does NOT show another client matters', async () => {
    const res = await world.billing.api.get(asOrg('/matters'));

    // The case that matters. A list scoped by firm rather than by the acting
    // client record returns a healthy 200 carrying someone else's work, and no
    // screen shows that it is wrong.
    expect(JSON.stringify(res.body)).not.toContain('Unrelated Matter');
  });

  it('serves an organization matter in detail', async () => {
    const res = await world.billing.api.get(asOrg(`/matters/${orgMatterId}`));

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('Organization Matter');
  });

  it('refuses another client matter by id', async () => {
    const res = await world.billing.api.get(asOrg(`/matters/${strangerMatterId}`));

    // Knowing the id must not be enough. Matter ids travel in urls, emails and
    // documents.
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('Unrelated Matter');
  });

  it('shows a roster member NOTHING under their own record when they have no matters', async () => {
    const res = await world.billing.api.get(
      `${F()}/matters?clientRecordId=${world.billing.clientId}`,
    );

    // Acting as themselves, this person has no matters. Falling back to the
    // organization's here would blur the two identities the selection contract
    // exists to keep apart.
    expect(res.status).toBe(200);
    expect(res.body.matters).toEqual([]);
  });

  it('shows the organization matters to a roster member who CANNOT view billing', async () => {
    const res = await world.noBilling.api.get(asOrg('/matters'));

    // `can_view_billing` gates money, not work. A roster member without it must
    // still see the matters they are involved in, or the flag silently becomes a
    // full lockout.
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('Organization Matter');
  });

  it('refuses a matter id from ANOTHER firm', async () => {
    const otherMatter = await world.otherFirm.owner.api
      .post(`/api/lawfirms/${world.otherFirm.firm.id}/matters`)
      .send({ name: 'Foreign Matter' });
    resetCaches();

    const res = await world.billing.api.get(
      asOrg(`/matters/${otherMatter.body.matterId}`),
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body ?? {})).not.toContain('Foreign Matter');
  });
});

describe('other portal surfaces are scoped the same way', () => {
  it('answers documents for the acting record', async () => {
    const res = await world.billing.api.get(asOrg('/documents'));

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('Unrelated Matter');
  });

  it('answers document requests for the acting record', async () => {
    const request = await world.owner.api
      .post(`/api/lawfirms/${world.firm.id}/document-requests`)
      .send({ clientId: stranger.id, title: 'Send us the unrelated papers' });
    expect(request.status).toBe(201);
    await drainEvents();

    const res = await world.billing.api.get(asOrg('/document-requests'));

    // A document request names what a client must produce. Showing one client
    // another's tells them what the firm is asking someone else for.
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('Send us the unrelated papers');
  });

  it('answers events for the acting record', async () => {
    await testPool.query(
      `insert into events (id, law_firm_id, matter_id, title, type, status, date, client_visible)
       values ($1, $2, $3, 'Organization Hearing', 'hearing', 'upcoming', now() + interval '7 days', true),
              ($4, $2, $5, 'Unrelated Hearing', 'hearing', 'upcoming', now() + interval '7 days', true)`,
      [randomUUID(), world.firm.id, orgMatterId, randomUUID(), strangerMatterId],
    );
    const res = await world.billing.api.get(asOrg('/events'));

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('Organization Hearing');
    expect(JSON.stringify(res.body)).not.toContain('Unrelated Hearing');
  });

  it('keeps organization matter notes firm-internal', async () => {
    await testPool.query(
      `insert into notes (law_firm_id, matter_id, subject, content, content_html, note_type)
       values ($1, $2, 'Internal Org Note', 'Internal org content', 'Internal org content', 'general')`,
      [world.firm.id, orgMatterId],
    );
    const stored = await testPool.query('select subject from notes where matter_id = $1', [orgMatterId]);
    expect(stored.rows.map((row) => row.subject)).toContain('Internal Org Note');

    const res = await world.billing.api.get(asOrg(`/matters/${orgMatterId}/notes`));

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Internal Org Note');
    expect(JSON.stringify(res.body)).not.toContain('Internal org content');
  });

  it('answers notifications for the acting record', async () => {
    const res = await world.billing.api.get(asOrg('/notifications'));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('unreadCount');
  });

  it('answers conversations for the acting record', async () => {
    const created = await world.owner.api.get(
      `/api/lawfirms/${world.firm.id}/messaging/company-conversation/${world.org.id}`,
    );
    expect(created.status).toBe(200);
    const res = await world.billing.api.get(asOrg('/messages/conversations'));

    expect(res.status).toBe(200);
    expect(res.body.conversations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ conversationId: created.body.conversationId }),
      ]),
    );
  });

  it('lets an organization member send into its canonical conversation, but not after removal', async () => {
    const created = await world.owner.api.get(
      `/api/lawfirms/${world.firm.id}/messaging/company-conversation/${world.org.id}`,
    );
    const sent = await world.billing.api.post(asOrg('/messages'))
      .send({ conversationId: created.body.conversationId, content: 'Org portal reply' });

    expect(sent.status).toBe(200);
    await drainEvents();
    const message = await testPool.query(
      `select content from messages where conversation_id = $1 and content = 'Org portal reply'`,
      [created.body.conversationId],
    );
    expect(message.rows).toHaveLength(1);

    const link = await testPool.query(
      `select id from client_company_links where person_client_id = $1 and company_client_id = $2`,
      [world.billing.clientId, world.org.id],
    );
    const removed = await world.owner.api.delete(
      `/api/lawfirms/${world.firm.id}/clients/${world.org.id}/contacts/${link.rows[0].id}`,
    );
    expect(removed.status).toBe(200);
    resetCaches();

    const denied = await world.billing.api.post(asOrg('/messages'))
      .send({ conversationId: created.body.conversationId, content: 'Should be rejected' });
    expect(denied.status).toBeGreaterThanOrEqual(400);
  });
});

describe('the firm list a portal user is shown', () => {
  it('includes the firm they are associated with', async () => {
    const res = await world.billing.api.get('/api/client-portal/my-lawfirms');

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(world.firm.id);
  });

  it('does NOT include a firm they have no association with', async () => {
    const res = await world.billing.api.get('/api/client-portal/my-lawfirms');

    // Firm discovery is the portal's front door. Listing a firm the person has
    // no relationship with offers them a door to rattle.
    expect(JSON.stringify(res.body)).not.toContain(world.otherFirm.firm.id);
  });

  it('gives a portal user of another firm only THEIR firm', async () => {
    const res = await world.otherFirm.portal.api.get('/api/client-portal/my-lawfirms');

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(world.firm.id);
  });

  it('reports an unread count without needing a client selection', async () => {
    const res = await world.billing.api.get('/api/client-portal/unread-count');

    // A cross-firm aggregate, so the selection contract cannot apply. It has to
    // answer for a caller who holds several associations.
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalUnread');
  });
});

describe('portal settings', () => {
  it('serves the acting record settings', async () => {
    const res = await world.billing.api.get(asOrg('/settings'));

    expect(res.status).toBe(200);
    expect(res.body.settings).toHaveProperty('notifications');
  });

  it('saves a change and reads it back', async () => {
    const saved = await world.billing.api.put(asOrg('/settings'))
      .send({ notifications: { emailOnNewInvoice: false } });
    expect(saved.status).toBe(200);

    const res = await world.billing.api.get(asOrg('/settings'));

    // These decide whether a client is emailed about their own invoices. A
    // setting that reported saved and did not persist keeps sending mail the
    // client asked to stop.
    expect(res.body.settings.notifications.emailOnNewInvoice).toBe(false);
  });

  it('refuses a settings shape it does not recognise', async () => {
    const res = await world.billing.api.put(asOrg('/settings'))
      .send({ emailNotifications: false });

    // The schema is strict. Accepting an unknown key would silently discard the
    // change while telling the client it was saved.
    expect(res.status).toBe(400);
  });

  it('does not let one portal user write another firm settings', async () => {
    const res = await world.otherFirm.portal.api
      .put(`/api/client-portal/lawfirm/${world.firm.id}/settings`)
      .send({ notifications: { emailOnNewInvoice: false } });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('a person on TWO organizations', () => {
  let second: { id: string };
  let secondMatterId: string;

  beforeEach(async () => {
    second = await createOrgClient(world.firm.id, { name: 'Second Corporation' });
    await linkPersonToOrg(world.firm.id, world.billing.clientId, second.id, {
      canViewBilling: false,
    });
    secondMatterId = await makeMatter('Second Corp Matter', second.id, 'Second Corporation');
    resetCaches();
    await drainEvents();
  });

  it('sees only the first organization matters while acting as it', async () => {
    const res = await world.billing.api.get(asOrg('/matters'));

    // The whole point of the selection contract. One person, two organizations,
    // and the two must not bleed into each other: a director of two companies
    // sees each company's work only while acting for that company.
    expect(JSON.stringify(res.body)).toContain('Organization Matter');
    expect(JSON.stringify(res.body)).not.toContain('Second Corp Matter');
  });

  it('sees only the second organization matters while acting as it', async () => {
    const res = await world.billing.api.get(
      `${F()}/matters?clientRecordId=${second.id}`,
    );

    expect(JSON.stringify(res.body)).toContain('Second Corp Matter');
    expect(JSON.stringify(res.body)).not.toContain('Organization Matter');
  });

  it('carries the billing flag of the organization being acted as', async () => {
    // Permitted on the first organization, refused on the second, same person.
    const permitted = await world.billing.api.get(asOrg('/billing'));
    const refused = await world.billing.api.get(
      `${F()}/billing?clientRecordId=${second.id}`,
    );

    // The flag lives on the LINK, not on the person. Resolving it per user
    // rather than per link would give this person billing access to both
    // organizations because they hold it on one.
    expect(permitted.status).toBe(200);
    expect(refused.status).toBe(403);
  });

  it('refuses the second organization matter while acting as the first', async () => {
    const res = await world.billing.api.get(asOrg(`/matters/${secondMatterId}`));

    expect(res.status).toBe(403);
  });
});

describe('a portal user with no client record at all', () => {
  it('is refused rather than shown an empty portal', async () => {
    const orphan = await createPortalUser();
    resetCaches();

    const res = await as(tokenFor({ uid: orphan.uid }))
      .get(`${F()}/matters`);

    // Someone who authenticated but was never made a client of this firm. An
    // empty 200 would tell them they are a client with no work, which is a
    // different and misleading claim from "you are not a client here".
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
