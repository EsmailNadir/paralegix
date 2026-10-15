/**
 * POST /api/lawfirms/:lawFirmId/clients/:clientId/matters
 *
 * Linking a client to several matters is all or nothing as far as access goes:
 * one matter the caller cannot write refuses the whole request, and nothing is
 * linked or announced for the matters that came before it in the list.
 *
 * What has to break for each case to go red:
 *   - the refusal cases: link matters one at a time as they are checked, so a
 *     later 403 leaves the earlier links behind.
 *   - the event case: emit MATTER_CLIENTS_UPDATED before every check has passed.
 *   - the success cases: stop reporting existing, already linked and missing
 *     matters the way they were reported before.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  createPersonClient,
  drainEvents,
  memberWith,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

const eventBus = require('../../src/shared/events/eventBus');
const { MATTER_CLIENTS_UPDATED } = require('../../src/shared/events/eventTypes');

let firm: Firm;
let clientId: string;
let caller: Actor;

const link = (matterIds: string[]) =>
  caller.api.post(`/api/lawfirms/${firm.id}/clients/${clientId}/matters`).send({ matterIds });

async function seedMatter(name: string, memberUids: string[]): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    'insert into matters (id, law_firm_id, name, matter_reference_id) values ($1, $2, $3, $4)',
    [id, firm.id, name, `REF-${id.slice(0, 8)}`],
  );
  for (const uid of memberUids) {
    await testPool.query(
      'insert into matter_members (law_firm_id, matter_id, user_id) values ($1, $2, $3)',
      [firm.id, id, uid],
    );
  }
  return id;
}

const linkedMatterIds = async () => (await testPool.query(
  'select matter_id from matter_clients where client_id = $1 order by matter_id', [clientId],
)).rows.map((row) => row.matter_id as string).sort();

beforeEach(async () => {
  firm = await createFirm();
  clientId = (await createPersonClient(firm.id, { name: 'Linked Client' })).id;
  caller = await memberWith(firm.id, ['clients.view', 'clients.manage', 'matters.view', 'matters.manageClients']);
  await drainEvents();
});

describe('linking a client to several matters', () => {
  it('refuses the whole list when a later matter is walled, linking none of them', async () => {
    const writable = await seedMatter('Writable', [caller.uid]);
    const walled = await seedMatter('Walled', []);

    const res = await link([writable, walled]);

    expect(res.status).toBe(403);
    expect(await linkedMatterIds()).toEqual([]);
  });

  it('refuses the whole list when the walled matter comes first too', async () => {
    const walled = await seedMatter('Walled', []);
    const writable = await seedMatter('Writable', [caller.uid]);

    const res = await link([walled, writable]);

    expect(res.status).toBe(403);
    expect(await linkedMatterIds()).toEqual([]);
  });

  it('announces nothing for a refused request', async () => {
    const writable = await seedMatter('Writable', [caller.uid]);
    const walled = await seedMatter('Walled', []);
    const seen: any[] = [];
    const listener = (payload: any) => seen.push(payload);
    eventBus.on(MATTER_CLIENTS_UPDATED, listener);
    try {
      expect((await link([writable, walled])).status).toBe(403);
      await drainEvents();
    } finally {
      eventBus.off(MATTER_CLIENTS_UPDATED, listener);
    }

    expect(seen).toEqual([]);
  });

  it('links every matter and announces each once when all are writable', async () => {
    const first = await seedMatter('First', [caller.uid]);
    const second = await seedMatter('Second', [caller.uid]);
    const seen: string[] = [];
    const listener = (payload: any) => seen.push(payload.matterId);
    eventBus.on(MATTER_CLIENTS_UPDATED, listener);
    let res;
    try {
      res = await link([first, second, first]);
      await drainEvents();
    } finally {
      eventBus.off(MATTER_CLIENTS_UPDATED, listener);
    }

    expect(res.status).toBe(200);
    expect([...res.body.added].sort()).toEqual([first, second].sort());
    expect(res.body.failed).toEqual([]);
    expect(await linkedMatterIds()).toEqual([first, second].sort());
    expect(seen.sort()).toEqual([first, second].sort());
  });

  it('links the real matters and reports a missing one as failed', async () => {
    const real = await seedMatter('Real', [caller.uid]);
    const missing = randomUUID();

    const res = await link([real, missing]);

    expect(res.status).toBe(200);
    expect(res.body.added).toEqual([real]);
    expect(res.body.failed).toEqual([{ matterId: missing, error: 'Matter not found' }]);
    expect(await linkedMatterIds()).toEqual([real]);
  });

  it('reports a matter that was already linked as added, not as a failure', async () => {
    const real = await seedMatter('Real', [caller.uid]);
    expect((await link([real])).status).toBe(200);

    const again = await link([real]);

    expect(again.status).toBe(200);
    expect(again.body.added).toEqual([real]);
    expect(again.body.failed).toEqual([]);
    expect(await linkedMatterIds()).toEqual([real]);
  });
});
