/**
 * The firm's contact details (Settings > General > Law Firm Information), saved
 * through PUT /api/lawfirms/:lawFirmId. Card fee rules read the state saved
 * here, and invoices print the address.
 *
 * Red if a field the form sends is dropped, if the saved firm is not what the
 * route answers with, or if a field cannot be cleared.
 */
import { createFirm, memberWith, ownerOf, testPool, type Firm, type Actor } from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
const url = () => `/api/lawfirms/${firm.id}`;

beforeEach(async () => {
  firm = await createFirm({ name: 'Info LLP' });
  owner = await ownerOf(firm.id);
});

async function stored() {
  const { rows } = await testPool.query(
    'select name, description, address, city, state, zip, phone, email from law_firms where id = $1', [firm.id]);
  return rows[0];
}

it('saves every contact field the form sends and answers with the saved firm', async () => {
  const res = await owner.api.put(url()).send({
    name: 'Info LLP', address: '1 Main St', city: 'Austin', state: 'Texas', zip: '78701',
    phone: '512-555-0100', email: 'office@info.example.test', description: 'Litigation',
  });

  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ name: 'Info LLP', address: '1 Main St', city: 'Austin', state: 'Texas', zip: '78701' });
  expect(await stored()).toEqual({
    name: 'Info LLP', description: 'Litigation', address: '1 Main St', city: 'Austin', state: 'Texas',
    zip: '78701', phone: '512-555-0100', email: 'office@info.example.test',
  });
  const read = await owner.api.get(url());
  expect(read.body.state ?? read.body.lawFirm?.state).toBe('Texas');
});

it('clears an optional field sent as null', async () => {
  await owner.api.put(url()).send({ name: 'Info LLP', city: 'Austin', state: 'Texas', email: 'office@info.example.test' }).expect(200);

  const res = await owner.api.put(url()).send({ name: 'Info LLP', city: null, state: null, email: null });

  expect(res.status).toBe(200);
  const row = await stored();
  expect(row.city).toBeNull();
  expect(row.state).toBeNull();
  expect(row.email).toBeNull();
});

it('still refuses to clear the firm name', async () => {
  const res = await owner.api.put(url()).send({ name: null });
  expect(res.status).toBe(400);
  expect((await stored()).name).toBe('Info LLP');
});

it('refuses a member without firm.update', async () => {
  const member = await memberWith(firm.id, ['members.view']);
  expect((await member.api.put(url()).send({ state: 'Texas' })).status).toBe(403);
  expect((await stored()).state).toBeNull();
});
