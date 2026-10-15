/**
 * The built-in roles that work with billing still reach the financial reads.
 *
 * Invoice, time-entry, expense, rate and trust reads are not in
 * DEFAULT_PERMISSIONS, so every member's access to them comes from an explicit
 * grant on the role. A built-in role whose definition forgot one of those codes
 * used to be rescued by the baseline and is now locked out, with nothing on
 * screen to say why. This file seeds the REAL built-in roles through
 * `seedBuiltInRoles` (the call a new firm makes), puts a member on each, and
 * reads the six routes through the API.
 *
 * Owner needs no role row (it holds every permission), so it is tested as the
 * firm's owner. A member with no role at all, and one on an empty role, hold the
 * baseline only and are refused on every route, which is what proves the 200s
 * above come from the role and not from the baseline.
 */
import {
  testPool,
  createFirm,
  createFirmMember,
  createPersonClient,
  ownerOf,
  tokenFor,
  as,
  memberWith,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

const { seedBuiltInRoles } = require('../../src/modules/lawfirms/roles/roles.service');

let firm: Firm;
let clientId: string;
let roleIds: Record<string, string>;

/** The six financial reads, as [label, path under /api/lawfirms/:id]. */
function reads(): Array<[string, string]> {
  return [
    ['invoices list', '/billing/invoices/firm'],
    ['time entries', '/billing/time-entries/firm'],
    ['expenses', `/billing/expenses/client/${clientId}`],
    ['rates', '/billing/charge-codes'],
    ['trust accounts', '/trust/accounts'],
    ['plans', '/billing/plans'],
  ];
}

/** A non-owner member placed on a seeded built-in role, or on no role at all. */
async function memberOnRole(roleKey: string | null): Promise<Actor> {
  const { uid } = await createFirmMember(firm.id, { isOwner: false });
  await testPool.query(
    'update members set role_id = $3 where law_firm_id = $1 and user_id = $2',
    [firm.id, uid, roleKey ? roleIds[roleKey] : null],
  );
  return { uid, api: as(tokenFor({ uid })) };
}

async function statuses(actor: Actor): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [label, path] of reads()) {
    out[label] = (await actor.api.get(`/api/lawfirms/${firm.id}${path}`)).status;
  }
  return out;
}

const allOk = Object.fromEntries(
  ['invoices list', 'time entries', 'expenses', 'rates', 'trust accounts', 'plans'].map((l) => [l, 200]),
);
const allRefused = Object.fromEntries(
  ['invoices list', 'time entries', 'expenses', 'rates', 'trust accounts', 'plans'].map((l) => [l, 403]),
);

beforeEach(async () => {
  firm = await createFirm();
  await ownerOf(firm.id);
  roleIds = await seedBuiltInRoles(firm.id);
  clientId = (await createPersonClient(firm.id, { name: 'Ledger Client' })).id;
});

describe('built-in roles that work with billing', () => {
  it('lets the firm owner read all six financial routes', async () => {
    const owner = await ownerOf(firm.id);

    expect(await statuses(owner)).toEqual(allOk);
  });

  it.each(['admin', 'attorney', 'paralegal'])(
    'lets a member on the %s role read all six financial routes',
    async (roleKey) => {
      const member = await memberOnRole(roleKey);

      expect(await statuses(member)).toEqual(allOk);
    },
  );

  it('seeded a role row for every built-in key the cases above name', () => {
    for (const key of ['admin', 'attorney', 'paralegal', 'staff']) {
      expect(roleIds[key]).toBeTruthy();
    }
  });
});

describe('members whose role grants no financial read', () => {
  it('refuses a member with no role on all six routes', async () => {
    const member = await memberOnRole(null);

    expect(await statuses(member)).toEqual(allRefused);
  });

  it('refuses a member on an empty custom role on all six routes', async () => {
    const member = await memberWith(firm.id, []);

    expect(await statuses(member)).toEqual(allRefused);
  });

  it('refuses a member on the staff role, which carries no billing codes', async () => {
    const member = await memberOnRole('staff');

    expect(await statuses(member)).toEqual(allRefused);
  });
});
