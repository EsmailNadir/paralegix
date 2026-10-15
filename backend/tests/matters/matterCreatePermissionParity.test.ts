/**
 * `matters.create` creates the matter row; it does not grant the two separate
 * capabilities that mutate its access and billing junctions. The individual
 * routes enforce those capabilities, so creation must not be a side door to
 * the same final state.
 */
import {
  createFirm,
  createPersonClient,
  memberWith,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let creator: Actor;
let clientId: string;

const M = () => `/api/lawfirms/${firm.id}/matters`;

async function matterCount() {
  const { rows } = await testPool.query(
    'select count(*)::int as count from matters where law_firm_id = $1',
    [firm.id],
  );
  return rows[0].count as number;
}

beforeEach(async () => {
  firm = await createFirm();
  creator = await memberWith(firm.id, ['matters.create']);
  clientId = (await createPersonClient(firm.id, { name: 'Riley Client' })).id;
});

describe('createMatter permission parity for member and client links', () => {
  it('does not let matters.create alone attach a client while creating a matter', async () => {
    const res = await creator.api.post(M()).send({
      name: 'Client-linked matter',
      clients: [{ clientId, name: 'Riley Client' }],
    });

    // POST /:matterId/clients requires matters.manageClients for this same
    // billing relationship. The matter row must not be created as a partial
    // success when that additional permission is absent.
    expect(res.status).toBe(403);
    expect(await matterCount()).toBe(0);
  });

  it('does not let matters.create alone seat another firm member as a matter lead', async () => {
    const colleague = await memberWith(firm.id, ['matters.view']);

    const res = await creator.api.post(M()).send({
      name: 'Matter with another lead',
      leadUserIds: [colleague.uid],
      clients: [],
    });

    // A lead receives a matter_members row, the same row that gates access to
    // the matter. POST /:matterId/members requires matters.manageMembers.
    expect(res.status).toBe(403);
    expect(await matterCount()).toBe(0);
  });

  it('still lets a matters.create-only member create a bare matter for themselves', async () => {
    const res = await creator.api.post(M()).send({ name: 'Unassigned matter', clients: [] });

    expect(res.status).toBe(201);
    expect(await matterCount()).toBe(1);
  });

  it('allows client and lead links when the caller holds their matching permissions', async () => {
    const manager = await memberWith(firm.id, [
      'matters.create',
      'matters.manageClients',
      'matters.manageMembers',
    ]);
    const colleague = await memberWith(firm.id, ['matters.view']);

    const res = await manager.api.post(M()).send({
      name: 'Fully authorized matter',
      leadUserIds: [colleague.uid],
      clients: [{ clientId, name: 'Riley Client' }],
    });

    expect(res.status).toBe(201);
    const { rows: links } = await testPool.query(
      'select client_id from matter_clients where matter_id = $1',
      [res.body.matterId],
    );
    const { rows: members } = await testPool.query(
      'select user_id from matter_members where matter_id = $1 order by user_id',
      [res.body.matterId],
    );
    expect(links.map((row: any) => row.client_id)).toEqual([clientId]);
    expect(members.map((row: any) => row.user_id)).toEqual([colleague.uid, manager.uid].sort());
  });
});
