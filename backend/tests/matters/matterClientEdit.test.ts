/**
 * PUT /api/lawfirms/:lawFirmId/matters/:matterId/clients/:clientId
 *
 * Editing a client from a matter writes the SHARED client record, so it is a
 * client edit and answers to the client rules: `clients.manage`, the client
 * update field schema, and a CLIENT_UPDATED event. `matters.manageClients`
 * alone (the built-in Paralegal shape) only covers linking and unlinking.
 *
 * What has to break for each case to go red:
 *   - the permission case: drop the `clients.manage` requirement on the route.
 *   - the blank-name / email / length cases: go back to the matter-local schema
 *     instead of the client update schema.
 *   - the event case: stop delegating to the clients service.
 */
import {
  testPool,
  createFirm,
  createPersonClient,
  drainEvents,
  memberWith,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

const eventBus = require('../../src/shared/events/eventBus');
const { CLIENT_UPDATED } = require('../../src/shared/events/eventTypes');

let firm: Firm;
let owner: Actor;
let matterId: string;
let clientId: string;

const url = (cid = clientId) => `/api/lawfirms/${firm.id}/matters/${matterId}/clients/${cid}`;

const storedClient = async (id = clientId) => {
  const { rows } = await testPool.query(
    'select name, email, phone from clients where id = $1', [id],
  );
  return rows[0];
};

/** A member of the matter holding exactly these permissions. */
async function matterMemberWith(permissions: string[]): Promise<Actor> {
  const actor = await memberWith(firm.id, permissions);
  await testPool.query(
    'insert into matter_members (law_firm_id, matter_id, user_id) values ($1, $2, $3)',
    [firm.id, matterId, actor.uid],
  );
  return actor;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  const client = await createPersonClient(firm.id, { name: 'Before Name', email: 'before@example.test' });
  clientId = client.id;
  const res = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
    name: 'Edit client matter',
    clients: [{ clientId, name: 'Before Name' }],
  });
  expect(res.status).toBe(201);
  matterId = (res.body.matterId ?? res.body.matter?.id) as string;
  await drainEvents();
});

describe('editing a client from a matter', () => {
  it('refuses a member who may manage matter clients but not edit clients, changing nothing', async () => {
    const paralegal = await matterMemberWith(['matters.view', 'matters.manageClients']);

    const res = await paralegal.api.put(url()).send({ client: { name: 'Hijacked' } });

    expect(res.status).toBe(403);
    expect((await storedClient()).name).toBe('Before Name');
  });

  it('lets a member holding both permissions edit the client', async () => {
    const editor = await matterMemberWith(['matters.view', 'matters.manageClients', 'clients.manage']);

    const res = await editor.api.put(url()).send({ client: { name: 'After Name', phone: '555-0100' } });

    expect(res.status).toBe(200);
    expect(await storedClient()).toMatchObject({ name: 'After Name', phone: '555-0100' });
  });

  it.each([
    ['a blank name', { name: '   ' }],
    ['an empty name', { name: '' }],
    ['a malformed email', { email: 'not-an-email' }],
    ['a phone longer than the client form allows', { phone: 'x'.repeat(101) }],
  ])('refuses %s and keeps the stored client', async (_label, client) => {
    const res = await owner.api.put(url()).send({ client });

    expect(res.status).toBe(400);
    expect(await storedClient()).toMatchObject({ name: 'Before Name', email: 'before@example.test', phone: null });
  });

  it('clears an optional field sent as null and trims the name it stores', async () => {
    await testPool.query('update clients set phone = $2 where id = $1', [clientId, '555-0000']);

    const res = await owner.api.put(url()).send({ client: { name: '  Trimmed  ', phone: null } });

    expect(res.status).toBe(200);
    expect(await storedClient()).toMatchObject({ name: 'Trimmed', phone: null });
  });

  it('emits CLIENT_UPDATED so listeners see the change like any client edit', async () => {
    const seen: any[] = [];
    const listener = (payload: any) => seen.push(payload);
    eventBus.on(CLIENT_UPDATED, listener);
    try {
      const res = await owner.api.put(url()).send({ client: { name: 'Announced' } });
      expect(res.status).toBe(200);
      await drainEvents();
    } finally {
      eventBus.off(CLIENT_UPDATED, listener);
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ lawFirmId: firm.id, clientId, updates: { name: 'Announced' } });
  });

  it('still answers 404 for a client that is not on this matter', async () => {
    const other = await createPersonClient(firm.id, { name: 'Not linked' });

    const res = await owner.api.put(url(other.id)).send({ client: { name: 'Nope' } });

    expect(res.status).toBe(404);
    expect((await storedClient(other.id)).name).toBe('Not linked');
  });
});
