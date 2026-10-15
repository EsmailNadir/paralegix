/**
 * A PERSON client's own contact roster: `contact_clients` rows joined onto the
 * firm-wide `contacts` directory.
 *
 * The same four routes serve two different things. For an ORGANIZATION client
 * they dispatch to `client_company_links`, the real client-to-client
 * relationship, and the organization suites cover that arm heavily. For a
 * person client they dispatch here, and nothing covered it: the roster's shape,
 * its primary-contact rule and its tenancy were all unpinned.
 *
 * That gap is why `contact_clients` kept a portal identity (`user_id`) and four
 * portal lifecycle columns for two designs after the design that wanted them
 * was replaced. Nothing wrote them, nothing read them for a decision, and no
 * test would have noticed either way. Migration 0261 dropped them, and the
 * shape assertion below is what keeps them from coming back unnoticed.
 */
import {
  as,
  createFirm,
  createPersonClient,
  memberWith,
  ownerOf,
  stranger,
  testPool,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let clientId: string;

const path = (suffix = '') => `/api/lawfirms/${firm.id}/clients/${clientId}/contacts${suffix}`;

const addContact = (body: any) => owner.api.post(path()).send(body);

beforeEach(async () => {
  firm = await createFirm({ name: 'Ferreira Law' });
  owner = await ownerOf(firm.id);
  ({ id: clientId } = await createPersonClient(firm.id, { name: 'Ada Whitlock' }));
});

describe("a person client's contact roster", () => {
  it('returns the contact joined onto its directory record, and nothing else', async () => {
    const created = await addContact({
      name: 'Desmond Whitlock',
      email: 'desmond@example.test',
      phone: '555-0101',
      title: 'Spouse',
      relationship: 'Spouse',
      isPrimary: true,
      isEmailRecipient: true,
      canViewBilling: true,
    });
    expect(created.status).toBe(201);

    const listed = await owner.api.get(path());
    expect(listed.status).toBe(200);
    expect(listed.body.contacts).toHaveLength(1);

    // A whitelist, not a snapshot of whatever the row happens to hold. The
    // roster link once carried `userId`, `portalInvitePending`,
    // `portalInvitedAt` and `portalJoinedAt`; all four were always null and all
    // four went with migration 0261.
    expect(Object.keys(listed.body.contacts[0]).sort()).toEqual([
      'canViewBilling', 'contactId', 'createdAt', 'createdBy', 'email', 'id',
      'isEmailRecipient', 'isPrimary', 'name', 'notes', 'organization', 'phone',
      'relationship', 'title', 'updatedAt',
    ]);
    expect(listed.body.contacts[0]).toMatchObject({
      name: 'Desmond Whitlock',
      relationship: 'Spouse',
      isPrimary: true,
      isEmailRecipient: true,
      canViewBilling: true,
    });
  });

  it('moves the primary flag rather than allowing two', async () => {
    await addContact({ name: 'First Contact', email: 'first@example.test', isPrimary: true });
    await addContact({ name: 'Second Contact', email: 'second@example.test', isPrimary: true });

    const listed = await owner.api.get(path());
    const primary = listed.body.contacts.filter((c: any) => c.isPrimary);
    // A partial unique index enforces this, so a second primary is refused by
    // Postgres rather than by the service; the point is that the WRITE clears
    // the old one first instead of erroring.
    expect(primary.map((c: any) => c.name)).toEqual(['Second Contact']);
  });

  it('refuses the same contact twice on one client', async () => {
    const first = await addContact({ name: 'Desmond Whitlock', email: 'desmond@example.test' });
    const contactId = first.body.contactId;

    const again = await owner.api.post(path()).send({ contactId });

    expect(again.status).toBe(409);
  });

  it('edits the relationship and its flags', async () => {
    const created = await addContact({
      name: 'Desmond Whitlock', email: 'desmond@example.test',
      relationship: 'Spouse', isEmailRecipient: true, canViewBilling: true,
    });

    const updated = await owner.api.put(path(`/${created.body.linkId}`))
      .send({ relationship: 'Former spouse', isEmailRecipient: false, canViewBilling: false });
    expect(updated.status).toBe(200);

    const listed = await owner.api.get(path());
    expect(listed.body.contacts[0]).toMatchObject({
      relationship: 'Former spouse', isEmailRecipient: false, canViewBilling: false,
    });
  });

  it('removes the link and leaves the directory contact standing', async () => {
    const created = await addContact({ name: 'Desmond Whitlock', email: 'desmond@example.test' });

    const removed = await owner.api.delete(path(`/${created.body.linkId}`));
    expect(removed.status).toBe(200);

    expect((await owner.api.get(path())).body.contacts).toEqual([]);
    // The person stays in the firm's directory: the roster link is the thing
    // that was removed, not the contact record.
    const { rows } = await testPool.query(
      'select name from contacts where id = $1', [created.body.contactId],
    );
    expect(rows.map((r: any) => r.name)).toEqual(['Desmond Whitlock']);
  });

  it('answers NOT FOUND for a link id that names nothing, malformed or not', async () => {
    for (const linkId of ['not-a-uuid', '11111111-1111-1111-1111-111111111111']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await owner.api.put(path(`/${linkId}`)).send({ relationship: 'x' });
      expect(res.status).toBe(404);
    }
  });

  it('is closed to another firm and to a member without clients.manage', async () => {
    const created = await addContact({ name: 'Desmond Whitlock', email: 'desmond@example.test' });

    expect((await stranger().api.get(path())).status).toBe(403);

    const viewer = await memberWith(firm.id, ['clients.view']);
    expect((await as(tokenFor({ uid: viewer.uid })).get(path())).status).toBe(200);
    const write = await as(tokenFor({ uid: viewer.uid }))
      .put(path(`/${created.body.linkId}`)).send({ relationship: 'x' });
    expect(write.status).toBe(403);
  });
});
