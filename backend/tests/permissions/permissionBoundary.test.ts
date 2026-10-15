/**
 * The member baseline grants core collaboration access. Financial reads and
 * privileged writes require explicit role permissions, scoped to the firm.
 */
import {
  createFirm,
  createPersonClient,
  ownerOf,
  memberWith,
  drainEvents,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Permission Client' });
  await drainEvents();
});

describe('the always-on baseline', () => {
  it('is exactly this set of codes', async () => {
    const { loadResolvedMember } = require('../../src/modules/lawfirms/roles/requirePermission');
    const emptyRole = await memberWith(firm.id, []);

    const resolved = await loadResolvedMember(firm.id, emptyRole.uid);

    // Pinned as a sorted list rather than a count. A count would let one code be
    // swapped for another without notice, and every entry here is something
    // every member of every firm may read.
    expect([...resolved.resolvedPermissions].sort()).toEqual([
      'calendar.view',
      'clients.view',
      'contacts.view',
      'dashboard.view',
      'files.view',
      'leads.view',
      'matters.view',
      'members.view',
      'messaging.send',
      'messaging.view',
      'noteTemplates.view',
      'noteTypes.view',
      'practiceAreas.view',
      'settings.viewFirm',
      'signatures.view',
      'tasks.view',
      'templates.view',
    ]);
  });

  it('contains no write code', async () => {
    const { loadResolvedMember } = require('../../src/modules/lawfirms/roles/requirePermission');
    const emptyRole = await memberWith(firm.id, []);

    const resolved = await loadResolvedMember(firm.id, emptyRole.uid);

    // The invariant that matters more than the exact list: nothing that CHANGES
    // data may ever be granted by default. A new `.manage` or `.create` code
    // added to the baseline would hand it to every member of every firm.
    const writeShaped = resolved.resolvedPermissions.filter((code: string) =>
      /\.(create|update|delete|manage|erase|invite|send|assign|approve)$/.test(code));

    // `messaging.send` is the one deliberate exception: sending a message is how
    // a member participates, not a privileged write, and it is listed above.
    expect(writeShaped).toEqual(['messaging.send']);
  });

  it('gives a non-member nothing at all', async () => {
    const { loadResolvedMember } = require('../../src/modules/lawfirms/roles/requirePermission');
    const otherFirm = await createFirm();
    const outsider = await ownerOf(otherFirm.id);

    // Not an empty permission set: no member at all, so the caller returns 403
    // rather than resolving to the baseline.
    expect(await loadResolvedMember(firm.id, outsider.uid)).toBeNull();
  });
});

describe('financial reads require an explicit role grant', () => {
  it.each([
    ['billing.viewInvoices', 'billing/invoices/firm'],
    ['billing.viewTimeEntries', 'billing/time-entries/firm'],
    ['billing.viewRates', 'billing/charge-codes'],
    ['billing.viewPlans', 'billing/plans'],
    ['billing.viewExpenses', 'billing/expenses/client'],
    ['trust.view', 'trust/accounts'],
  ])('%s can be withheld, granted, and never used across firms', async (permission, route) => {
    const path = `/api/lawfirms/${firm.id}/${route}${route.endsWith('/client') ? `/${client.id}` : ''}`;
    const narrow = await memberWith(firm.id, []);
    expect((await narrow.api.get(path)).status).toBe(403);
    const granted = await memberWith(firm.id, [permission]);
    expect((await granted.api.get(path)).status).toBe(200);
    const other = await createFirm();
    const outsider = await ownerOf(other.id);
    expect((await outsider.api.get(path)).status).toBe(403);
  });
});

describe('the boundary in practice: reads are open, writes are not', () => {
  const WRITES: Array<{ name: string; grant: string; call: (api: Actor['api']) => Promise<unknown> }> = [
    {
      name: 'create a client',
      grant: 'clients.manage',
      call: (api) => api.post(`/api/lawfirms/${firm.id}/clients`).send({ name: 'New Client' }),
    },
    {
      name: 'update a client',
      grant: 'clients.manage',
      call: (api) => api.put(`/api/lawfirms/${firm.id}/clients/${client.id}`).send({ name: 'Renamed' }),
    },
    {
      name: 'delete a client',
      grant: 'clients.manage',
      call: (api) => api.delete(`/api/lawfirms/${firm.id}/clients/${client.id}`),
    },
    {
      name: 'create a matter',
      grant: 'matters.create',
      call: (api) => api.post(`/api/lawfirms/${firm.id}/matters`).send({ name: 'New Matter' }),
    },
  ];

  it.each(WRITES)('$name is refused with only the baseline', async ({ call }) => {
    const emptyRole = await memberWith(firm.id, []);

    const res = (await call(emptyRole.api)) as { status: number };

    expect(res.status).toBe(403);
  });

  it.each(WRITES)('$name is allowed once $grant is granted', async ({ grant, call }) => {
    const granted = await memberWith(firm.id, [grant]);

    const res = (await call(granted.api)) as { status: number };

    // The pair matters. The refusal alone would pass against a route that
    // refuses everybody, which is a different bug wearing the same status code.
    expect(res.status).toBeLessThan(400);
  });
});
