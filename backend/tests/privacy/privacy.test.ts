/**
 * Privacy: client data export and erasure.
 *
 * 607 lines and five routes with no test behind them until now, and the two that
 * matter are irreversible. Erasure destroys a client's personal data on purpose,
 * so the questions worth asking are who may do it, what it leaves behind, and
 * whether it can be pointed at the wrong firm.
 *
 * `clients.erase` is deliberately a separate permission from `clients.manage`:
 * being able to edit a client is not the same as being able to erase one. That
 * split is the whole point of the code existing, so it is pinned here.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  createOrgClient,
  createInvoice,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';
const eventBus = require('../../src/shared/events/eventBus');
const { CLIENT_DELETED } = require('../../src/shared/events/eventTypes');

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const exportPath = (c: string, f = firm?.id) => `/api/lawfirms/${f}/clients/${c}/data-export`;
const erasePath = (c: string, f = firm?.id) => `/api/lawfirms/${f}/clients/${c}/erase`;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, {
    name: 'Exportable Client', email: 'exportable@example.test',
  });
  await drainEvents();
});

describe('client data export', () => {
  it('returns not-found for a client id that does not exist in the firm', async () => {
    const res = await owner.api.get(exportPath('00000000-0000-0000-0000-000000000000'));

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Exportable Client');
  });

  it('returns the client own record, contacts, notes and matter ids, and NOT billing', async () => {
    await createInvoice(firm.id, client.id, { totalCents: 654_300 });
    await drainEvents();

    const res = await owner.api.get(exportPath(client.id));

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('Exportable Client');
    expect(Object.keys(res.body).sort()).toEqual(
      ['client', 'contacts', 'exportedAt', 'matterIds', 'notes'],
    );

    // CHARACTERISED, NOT ENDORSED. Invoices are absent from the export even
    // though the client has one. Whether a subject access request should include
    // billing history is a legal question rather than a code one, so this pins
    // today's scope rather than asserting a wider one. If the answer is that it
    // should, this assertion is what has to change, and it will be obvious.
    expect(JSON.stringify(res.body)).not.toMatch(/654300|6543/);
  });

  it('exports an organization client as well as a person', async () => {
    const org = await createOrgClient(firm.id, { name: 'Exportable Corp' });

    const res = await owner.api.get(exportPath(org.id));

    // An organization carries no `clients.user_id`, so a route resolving the
    // subject through that column alone fails here.
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('Exportable Corp');
  });

  it('refuses a member holding neither clients.manage nor clients.erase', async () => {
    const reader = await memberWith(firm.id, []);

    const res = await reader.api.get(exportPath(client.id));

    // `clients.view` is in the always-on baseline, so reading a client is open.
    // Exporting everything about them is not the same act.
    expect(res.status).toBe(403);
  });

  it('allows a member holding clients.manage', async () => {
    const manager = await memberWith(firm.id, ['clients.manage']);

    const res = await manager.api.get(exportPath(client.id));

    expect(res.status).toBe(200);
  });
});

describe('client erasure', () => {
  it('finishes client deletion listeners before acknowledging erasure', async () => {
    let finished = false;
    const listener = async ({ clientId }: { clientId: string }) => {
      if (clientId !== client.id) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
      finished = true;
    };
    eventBus.on(CLIENT_DELETED, listener);
    try {
      const res = await owner.api.post(erasePath(client.id));
      expect(res.status).toBe(200);
      expect(finished).toBe(true);
    } finally {
      eventBus.off(CLIENT_DELETED, listener);
    }
  });

  it('returns not-found for erasure of a client absent from the firm', async () => {
    const res = await owner.api.post(erasePath('00000000-0000-0000-0000-000000000000'));

    expect(res.status).toBe(404);
  });

  it('requires clients.erase, which clients.manage does not imply', async () => {
    const manager = await memberWith(firm.id, ['clients.manage']);

    const res = await manager.api.post(erasePath(client.id));

    // The split that justifies a separate permission code. Someone who edits
    // clients all day should not be able to destroy one by accident.
    expect(res.status).toBe(403);

    const { rows } = await testPool.query('select id from clients where id = $1', [client.id]);
    expect(rows).toHaveLength(1);
  });

  it('is allowed for a member holding clients.erase', async () => {
    const eraser = await memberWith(firm.id, ['clients.erase']);

    const res = await eraser.api.post(erasePath(client.id));

    expect(res.status).toBe(200);
  });

  it('refuses a member of another firm asking under this firm', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api.post(erasePath(client.id));

    expect(res.status).toBe(403);
    const { rows } = await testPool.query('select name from clients where id = $1', [client.id]);
    expect(rows).toEqual([{ name: 'Exportable Client' }]);
  });
});
