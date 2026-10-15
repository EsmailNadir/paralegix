/**
 * Who may edit a person client's related contact.
 *
 * The link's own fields (relationship, primary) are the client's, so
 * `clients.manage` is enough to change them. The contact's identity (name,
 * email, phone, title, notes) is the shared directory record and also needs
 * `contacts.manage`. The edit form relies on this split: it sends only the
 * identity fields that changed, so ticking Primary works for a role that holds
 * `clients.manage` alone.
 */
import {
  testPool,
  createFirm,
  createPersonClient,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let clientId: string;
let linkId: string;

const linkPath = () => `/api/lawfirms/${firm.id}/clients/${clientId}/contacts/${linkId}`;

async function linkRow() {
  const { rows } = await testPool.query(
    `select cc.is_primary, cc.relationship, c.name
       from contact_clients cc join contacts c on c.id = cc.contact_id
      where cc.id = $1`,
    [linkId],
  );
  return rows[0];
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  clientId = (await createPersonClient(firm.id, { name: 'Pat Person' })).id;
  const created = await owner.api.post(`/api/lawfirms/${firm.id}/clients/${clientId}/contacts`)
    .send({ name: 'Gina Guardian', email: 'gina@example.test', relationship: 'Guardian' });
  expect(created.status).toBe(201);
  linkId = created.body.linkId ?? created.body.id;
  expect(linkId).toBeTruthy();
});

describe('a role with clients.manage but not contacts.manage', () => {
  it('can mark the contact primary when only the link fields are sent', async () => {
    const clerk = await memberWith(firm.id, ['clients.view', 'clients.manage']);

    const res = await clerk.api.put(linkPath()).send({ relationship: 'Guardian', isPrimary: true });

    expect(res.status).toBe(200);
    expect(await linkRow()).toMatchObject({ is_primary: true, name: 'Gina Guardian' });
  });

  it('cannot change the contact\'s identity', async () => {
    const clerk = await memberWith(firm.id, ['clients.view', 'clients.manage']);

    const res = await clerk.api.put(linkPath()).send({ name: 'Renamed Guardian', isPrimary: true });

    expect(res.status).toBe(403);
    expect(await linkRow()).toMatchObject({ is_primary: false, name: 'Gina Guardian' });
  });
});
