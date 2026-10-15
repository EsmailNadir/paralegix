/**
 * Who may add, edit and remove a matter's contacts.
 *
 * Contacts on a matter belong to the matter record, the same as its linked
 * clients, so they share the clients' gate: owners and firm admins may manage
 * them on any matter, everyone else must be on the matter. An admin who could
 * attach a client but got 403 attaching a contact on the same matter is the bug
 * these cases pin; the walled-member case pins that the wall still holds for
 * everybody else.
 */
import {
  createFirm,
  memberWith,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let matterId: string;
let contactId: string;

const MC = (suffix = '') => `/api/lawfirms/${firm.id}/matters/${matterId}/contacts${suffix}`;

const isMatterMember = async (uid: string) =>
  (await testPool.query(
    'select 1 from matter_members where matter_id = $1 and user_id = $2', [matterId, uid],
  )).rowCount === 1;

async function newContact(name: string) {
  const res = await owner.api.post(`/api/lawfirms/${firm.id}/contacts`)
    .send({ name, category: 'opposing_counsel' });
  expect(res.status).toBe(201);
  return res.body.contactId as string;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({ name: 'Walled matter' });
  expect(matter.status).toBe(201);
  matterId = matter.body.matterId;
  contactId = await newContact('Opposing counsel');
});

describe('firm admin who is not on the matter', () => {
  let admin: Actor;
  beforeEach(async () => {
    admin = await memberWith(firm.id, ['matters.view', 'matters.update', 'members.changeRole']);
    expect(await isMatterMember(admin.uid)).toBe(false);
  });

  it('can add, edit and remove a contact', async () => {
    const created = await admin.api.post(MC()).send({ contactId, role: 'opposing_counsel' });
    expect(created.status).toBe(201);
    const linkId = created.body.contact.id as string;

    const updated = await admin.api.put(MC(`/${linkId}`)).send({ role: 'witness' });
    expect(updated.status).toBe(200);
    expect(updated.body.contact.role).toBe('witness');

    const removed = await admin.api.delete(MC(`/${linkId}`));
    expect(removed.status).toBe(200);
    const left = await testPool.query('select 1 from matter_contacts where id = $1', [linkId]);
    expect(left.rowCount).toBe(0);
  });

  it('still gets 404 for a matter id that does not exist', async () => {
    matterId = '00000000-0000-4000-8000-000000000000';
    const res = await admin.api.post(MC()).send({ contactId, role: 'opposing_counsel' });
    expect(res.status).toBe(404);
  });
});

describe('plain member who is not on the matter', () => {
  it('is refused on every write and changes nothing', async () => {
    const seeded = await owner.api.post(MC()).send({ contactId, role: 'opposing_counsel' });
    expect(seeded.status).toBe(201);
    const linkId = seeded.body.contact.id as string;
    const other = await newContact('Second counsel');

    const member = await memberWith(firm.id, ['matters.view', 'matters.update']);

    const created = await member.api.post(MC()).send({ contactId: other, role: 'witness' });
    expect(created.status).toBe(403);
    const updated = await member.api.put(MC(`/${linkId}`)).send({ role: 'witness' });
    expect(updated.status).toBe(403);
    const removed = await member.api.delete(MC(`/${linkId}`));
    expect(removed.status).toBe(403);

    const { rows } = await testPool.query(
      'select contact_id, role from matter_contacts where matter_id = $1', [matterId],
    );
    expect(rows).toEqual([{ contact_id: contactId, role: 'opposing_counsel' }]);
  });
});
