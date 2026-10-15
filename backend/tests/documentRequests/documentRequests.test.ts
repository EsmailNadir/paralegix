/**
 * Document requests, characterised at the route layer.
 *
 * 1,494 lines and thirteen routes with no test behind them until now.
 *
 * The organization angle is real here and not incidental: `contactClientId`
 * narrows the DOCUMENT_REQUEST_CREATED fan-out to ONE roster contact instead of
 * every eligible person on a company client, and the schema says it is
 * meaningless for a person client. That is a validation rule worth pinning,
 * because getting it wrong either spams an organization's whole roster or sends
 * a request nobody receives.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  createOrgClient,
  createPortalUser,
  linkPersonToOrg,
  ownerOf,
  memberWith,
  recipientsOf,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const path = (suffix = '') => `/api/lawfirms/${firm.id}/document-requests${suffix}`;

async function createRequest(overrides: Record<string, unknown> = {}) {
  return owner.api.post(path()).send({
    clientId: client.id,
    title: 'Please send your ID',
    items: [{ label: 'Passport' }, { label: 'Proof of address' }],
    ...overrides,
  });
}

function idOf(res: { body: any }) {
  return res.body.request?.id ?? res.body.requestId ?? res.body.id;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Requesting Client' });
  await drainEvents();
});

describe('creating a request', () => {
  it('creates one and returns it on the client route', async () => {
    const created = await createRequest({ title: 'Onboarding documents' });

    expect(created.status).toBe(201);
    // 'open', not 'pending'. The `document_requests_status_check` set is
    // (open, completed, cancelled), and the portal renders its badge off this
    // value, so an invented status would render as an unknown state.
    expect(created.body.request.status).toBe('open');

    // The bare list route REQUIRES a `matterId` query parameter, so it cannot
    // show a client-level request at all. `/clients/:clientId` is the route that
    // answers "every request addressed to this client".
    const list = await owner.api.get(path(`/clients/${client.id}`));
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain('Onboarding documents');
  });

  it('refuses the bare list route without a matter', async () => {
    // Pinned because a test that called it and got 400 would then find its
    // search string absent and pass for the wrong reason.
    const res = await owner.api.get(path());

    expect(res.status).toBe(400);
  });

  it('stores each requested item', async () => {
    const created = await createRequest();
    await drainEvents();

    const { rows } = await testPool.query(
      'select label from document_request_items where request_id = $1 order by label',
      [idOf(created)],
    );
    expect(rows.map((r: any) => r.label)).toEqual(['Passport', 'Proof of address']);
  });

  it('rejects a request with no title', async () => {
    const res = await owner.api.post(path()).send({ clientId: client.id, title: '' });

    expect(res.status).toBe(400);
  });

  it('rejects a request with no client', async () => {
    const res = await owner.api.post(path()).send({ title: 'Orphan request' });

    expect(res.status).toBe(400);
  });

  it('rejects a malformed client id rather than treating it as absent', async () => {
    const res = await owner.api.post(path()).send({ clientId: 'not-a-uuid', title: 'Bad id' });

    expect(res.status).toBe(400);
  });

  it('allows a request with no matter, which is the client-level General case', async () => {
    const res = await createRequest({ matterId: null, title: 'General request' });

    expect(res.status).toBe(201);
  });

  it('refuses linking a file to a general request before resolving a file path', async () => {
    const created = await createRequest({ matterId: null, title: 'General request' });
    const requestId = idOf(created);
    const itemId = created.body.request.items[0].id;

    const res = await owner.api
      .post(path(`/${requestId}/items/${itemId}/link-file`))
      .send({ fileId: '00000000-0000-4000-8000-000000000000' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not tied to a matter/i);

    const { rows } = await testPool.query(
      'select count(*)::int as n from attachments where document_request_item_id = $1',
      [itemId],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('organization requests', () => {
  async function orgWithRoster() {
    const org = await createOrgClient(firm.id, { name: 'Requesting Corp' });
    const portal = await createPortalUser();
    const person = await createPersonClient(firm.id, { userId: portal.uid, name: 'Roster Person' });
    const link = await linkPersonToOrg(firm.id, person.id, org.id, { canViewBilling: false });
    return { org, person, link };
  }

  it('accepts a request addressed to an organization', async () => {
    const { org } = await orgWithRoster();

    const res = await owner.api.post(path()).send({
      clientId: org.id, title: 'Corporate filings', items: [{ label: 'Articles' }],
    });

    // An organization has no `clients.user_id`, so a route that resolves the
    // recipient through that column alone fails here.
    expect(res.status).toBe(201);
  });

  it('accepts a contact narrowing the fan-out to one roster member', async () => {
    const { org, link } = await orgWithRoster();

    // `contactClientId` IS A LINK ID, not a client id, despite the name.
    // `getRosterContactById` matches it against `client_company_links.id`, so
    // passing the person's own client id is rejected with "The selected contact
    // does not have portal access on this client", which reads like a portal
    // problem rather than a wrong identifier. Recorded here because the name is
    // the only documentation a caller has, and it points at the wrong table.
    const res = await owner.api.post(path()).send({
      clientId: org.id,
      title: 'For one person only',
      contactClientId: link.id,
      items: [{ label: 'Signed form' }],
    });

    expect(res.status).toBe(201);
  });

  it('rejects a person client id passed as the contact', async () => {
    const { org, person } = await orgWithRoster();

    const res = await owner.api.post(path()).send({
      clientId: org.id, title: 'Wrong identifier', contactClientId: person.id,
    });

    expect(res.status).toBe(400);
  });

  it('rejects targeting a contact on a PERSON client, which has no roster', async () => {
    const { link } = await orgWithRoster();

    const res = await owner.api.post(path()).send({
      clientId: client.id, title: 'Nothing to narrow', contactClientId: link.id,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/company client has roster contacts/i);
  });

  it('lists requests addressed to a client through the client route', async () => {
    const { org } = await orgWithRoster();
    await owner.api.post(path()).send({ clientId: org.id, title: 'Findable request' });
    await drainEvents();

    const res = await owner.api.get(path(`/clients/${org.id}`));

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('Findable request');
  });
});

describe('reading, updating and deleting', () => {
  it('reads one back by id', async () => {
    const created = await createRequest({ title: 'Readable request' });

    const res = await owner.api.get(path(`/${idOf(created)}`));

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('Readable request');
  });

  it('answers 404 for one that does not exist', async () => {
    const res = await owner.api.get(path('/00000000-0000-0000-0000-000000000000'));

    expect(res.status).toBe(404);
  });

  it('updates the title', async () => {
    const created = await createRequest();

    const res = await owner.api.patch(path(`/${idOf(created)}`)).send({ title: 'Renamed request' });
    expect(res.status).toBe(200);

    const read = await owner.api.get(path(`/${idOf(created)}`));
    expect(JSON.stringify(read.body)).toContain('Renamed request');
  });

  it('deletes one and takes its items with it', async () => {
    const created = await createRequest();
    const requestId = idOf(created);

    const res = await owner.api.delete(path(`/${requestId}`));
    expect([200, 204]).toContain(res.status);
    await drainEvents();

    const { rows } = await testPool.query(
      'select id from document_request_items where request_id = $1', [requestId],
    );
    // Orphaned items would show as a request with no parent in every later read.
    expect(rows).toHaveLength(0);
  });
});

describe('permissions and tenancy', () => {
  it('refuses a member without documents.request to create one', async () => {
    const reader = await memberWith(firm.id, []);

    const res = await reader.api.post(path()).send({ clientId: client.id, title: 'Nope' });

    expect(res.status).toBe(403);
  });

  it('allows a member holding documents.request', async () => {
    const writer = await memberWith(firm.id, ['documents.request']);

    const res = await writer.api.post(path()).send({ clientId: client.id, title: 'Allowed' });

    // Paired with the refusal above, so neither passes against a route that
    // refuses everybody.
    expect(res.status).toBe(201);
  });

  it('does not show one firm another firm requests', async () => {
    await createRequest({ title: 'Confidential Request' });
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    // The client route, not the bare list: the bare one answers 400 without a
    // matter, and an absent search string in an error body proves nothing.
    const res = await otherOwner.api.get(
      `/api/lawfirms/${otherFirm.id}/document-requests/clients/${client.id}`,
    );

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body ?? {})).not.toContain('Confidential Request');
  });

  it('refuses a member of another firm asking under this firm', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api.get(path(`/clients/${client.id}`));

    expect([403, 404]).toContain(res.status);
  });
});

describe('the ethical wall on the client list', () => {
  // `GET /clients/:clientId` has no matter in its path, so the matter check has
  // to happen per row. `GET /:id` already refuses a matter the caller cannot
  // read; the list must not hand out the same rows (titles, items, file names)
  // to a member who is walled off that matter.
  async function seedMatterOnClient(memberUids: string[]) {
    const id = randomUUID();
    await testPool.query(
      `insert into matters (id, law_firm_id, name, matter_reference_id)
       values ($1, $2, 'Walled Matter', $3)`,
      [id, firm.id, `REF-${id.slice(0, 8)}`],
    );
    await testPool.query(
      `insert into matter_clients (matter_id, client_id, law_firm_id) values ($1, $2, $3)`,
      [id, client.id, firm.id],
    );
    for (const uid of memberUids) {
      await testPool.query(
        `insert into matter_members (matter_id, user_id, law_firm_id) values ($1, $2, $3)`,
        [id, uid, firm.id],
      );
    }
    return id;
  }

  async function titlesSeenBy(actor: Actor) {
    const res = await actor.api.get(path(`/clients/${client.id}`));
    expect(res.status).toBe(200);
    return (res.body.requests as Array<{ title: string }>).map((r) => r.title);
  }

  it('hides a matter request from a member who is not on that matter, and keeps general ones', async () => {
    const matterId = await seedMatterOnClient([owner.uid]);
    expect((await createRequest({ matterId, title: 'Walled Matter Request' })).status).toBe(201);
    expect((await createRequest({ title: 'General Request' })).status).toBe(201);
    const walled = await memberWith(firm.id, ['documents.request']);

    const titles = await titlesSeenBy(walled);

    // The general request proves the list answered with real rows, so the
    // absence below is the filter at work and not an empty response.
    expect(titles).toContain('General Request');
    expect(titles).not.toContain('Walled Matter Request');
  });

  it('shows a matter request to a member who is on that matter', async () => {
    const staffed = await memberWith(firm.id, ['documents.request']);
    const matterId = await seedMatterOnClient([owner.uid, staffed.uid]);
    expect((await createRequest({ matterId, title: 'Staffed Matter Request' })).status).toBe(201);

    expect(await titlesSeenBy(staffed)).toContain('Staffed Matter Request');
  });

  it('shows every matter request to the owner, who reads the whole firm', async () => {
    const other = await memberWith(firm.id, ['documents.request']);
    const matterId = await seedMatterOnClient([other.uid]);
    // Created through the service's matter-member check by the staffed member,
    // so the owner is NOT on this matter.
    const created = await other.api.post(path()).send({
      clientId: client.id, matterId, title: 'Unstaffed By Owner', items: [{ label: 'Lease' }],
    });
    expect(created.status).toBe(201);

    expect(await titlesSeenBy(owner)).toContain('Unstaffed By Owner');
  });
});

describe('the client-facing email', () => {
  // A person client has no per-category toggle for document requests
  // (documentRequests.events.ts documents this deliberately: `EMAIL_CATEGORIES
  // .DOCUMENT_REQUESTED` has no entry in the client-settings key map, so
  // `shouldSendClientEmail` always resolves it enabled for them). The one real
  // lever left is the firm's own master email switch
  // (`law_firms.settings.emailNotificationsEnabled`), which this pins in both
  // directions so a firm that turns outbound email off is actually obeyed.
  async function portalClient() {
    const portal = await createPortalUser();
    return createPersonClient(firm.id, {
      name: 'Portal Client',
      userId: portal.uid,
      email: 'portal-client@example.test',
    });
  }

  it('sends the request email by default, with no per-client toggle to turn it off', async () => {
    const emailedClient = await portalClient();

    const res = await createRequest({ clientId: emailedClient.id, title: 'ID Verification' });
    expect(res.status).toBe(201);
    await drainEvents();

    expect(recipientsOf(/requested documents from you/)).toContain('portal-client@example.test');
  });

  it('honours the firm master email switch: off suppresses it, on restores it', async () => {
    const emailedClient = await portalClient();

    const disabled = await owner.api
      .put(`/api/lawfirms/${firm.id}/settings/firm`)
      .send({ settings: { emailNotificationsEnabled: false } });
    expect(disabled.status).toBe(200);

    const suppressed = await createRequest({ clientId: emailedClient.id, title: 'Suppressed request' });
    expect(suppressed.status).toBe(201);
    await drainEvents();
    expect(recipientsOf(/requested documents from you/)).not.toContain('portal-client@example.test');

    const enabled = await owner.api
      .put(`/api/lawfirms/${firm.id}/settings/firm`)
      .send({ settings: { emailNotificationsEnabled: true } });
    expect(enabled.status).toBe(200);

    const restored = await createRequest({ clientId: emailedClient.id, title: 'Restored request' });
    expect(restored.status).toBe(201);
    await drainEvents();
    expect(recipientsOf(/requested documents from you/)).toContain('portal-client@example.test');
  });
});
