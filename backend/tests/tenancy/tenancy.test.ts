/**
 * Multi-tenancy: can one firm reach another firm's data.
 *
 * This is the worst failure available in a legal practice product, and until the
 * in-process harness existed nothing could ask the question: the old suite had
 * ONE seeded firm and one account, so a leak between firms was invisible by
 * construction. Every route below has therefore never been tested for it.
 *
 * Scoping is the application's job here, not the database's. `AGENTS.md` states
 * it plainly: the backend connects as `postgres` and bypasses row-level security
 * everywhere except the three Realtime surfaces, so every query carries
 * `law_firm_id` by hand. A missed `where` clause is a cross-firm leak with
 * nothing behind it to catch the mistake.
 *
 * TWO DIRECTIONS, AND THEY FAIL DIFFERENTLY
 *
 *   Direction A: firm B's member asks under FIRM A's id.
 *     The membership gate answers first, so this must be a hard 403 or 404.
 *
 *   Direction B: firm B's member asks under their OWN firm id, for firm A's
 *     record id.
 *     No gate fires. The query is simply scoped, so a correct route matches
 *     nothing and answers 200 with an empty body. This is the direction a
 *     forgotten `law_firm_id` clause actually leaks through, and it is why the
 *     assertion is on CONTENT rather than on status.
 */
import {
  createFirm,
  createOrgClient,
  createPersonClient,
  createInvoice,
  createTrustDeposit,
  ownerOf,
  drainEvents,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { withheldAmounts } from '../organizations/assertions';

interface Tenant {
  firm: Firm;
  owner: Actor;
  clientId: string;
  orgId: string;
  invoiceCents: number;
  trustCents: number;
  secretName: string;
}

async function buildTenant(label: string, invoiceCents: number, trustCents: number): Promise<Tenant> {
  const firm = await createFirm({ name: `${label} Firm` });
  const owner = await ownerOf(firm.id);
  const secretName = `${label} Confidential Client`;
  const client = await createPersonClient(firm.id, { name: secretName, email: `${label}@example.test` });
  const org = await createOrgClient(firm.id, { name: `${label} Holdings` });
  await createInvoice(firm.id, client.id, { totalCents: invoiceCents });
  await createTrustDeposit(firm.id, client.id, { amountCents: trustCents });
  return { firm, owner, clientId: client.id, orgId: org.id, invoiceCents, trustCents, secretName };
}

let alpha: Tenant;
let beta: Tenant;

beforeEach(async () => {
  // Distinct amounts so a figure appearing in the wrong response identifies WHICH
  // firm leaked, rather than only that something did.
  alpha = await buildTenant('Alpha', 811_100, 522_200);
  beta = await buildTenant('Beta', 933_300, 644_400);
  await drainEvents();
});

/** Firm-scoped reads, built from the victim firm's id and record ids. */
const FIRM_ROUTES: Array<{ name: string; path: (t: Tenant) => string }> = [
  { name: 'client list', path: (t) => `/api/lawfirms/${t.firm.id}/clients` },
  { name: 'client detail', path: (t) => `/api/lawfirms/${t.firm.id}/clients/${t.clientId}` },
  { name: 'client matters', path: (t) => `/api/lawfirms/${t.firm.id}/clients/${t.clientId}/matters` },
  { name: 'client tasks', path: (t) => `/api/lawfirms/${t.firm.id}/clients/${t.clientId}/tasks` },
  { name: 'client contacts', path: (t) => `/api/lawfirms/${t.firm.id}/clients/${t.clientId}/contacts` },
  { name: 'client events', path: (t) => `/api/lawfirms/${t.firm.id}/clients/${t.clientId}/events` },
  { name: 'company relationships', path: (t) => `/api/lawfirms/${t.firm.id}/clients/${t.clientId}/company-relationships` },
  { name: 'client lookup', path: (t) => `/api/lawfirms/${t.firm.id}/clients/lookup?query=Confidential` },
  { name: 'matters', path: (t) => `/api/lawfirms/${t.firm.id}/matters` },
  { name: 'tasks', path: (t) => `/api/lawfirms/${t.firm.id}/tasks` },
  { name: 'firm invoices', path: (t) => `/api/lawfirms/${t.firm.id}/billing/invoices/firm` },
  { name: 'client invoices', path: (t) => `/api/lawfirms/${t.firm.id}/billing/invoices/client/${t.clientId}` },
  { name: 'client time entries', path: (t) => `/api/lawfirms/${t.firm.id}/billing/time-entries/client/${t.clientId}` },
  { name: 'trust accounts', path: (t) => `/api/lawfirms/${t.firm.id}/trust/accounts` },
  { name: 'trust transactions', path: (t) => `/api/lawfirms/${t.firm.id}/trust/transactions` },
  { name: 'trust client ledger', path: (t) => `/api/lawfirms/${t.firm.id}/trust/clients/${t.clientId}/ledger` },
  { name: 'trust client balance', path: (t) => `/api/lawfirms/${t.firm.id}/trust/clients/${t.clientId}/balance` },
  { name: 'trust balances', path: (t) => `/api/lawfirms/${t.firm.id}/trust/balances` },
  { name: 'charge codes', path: (t) => `/api/lawfirms/${t.firm.id}/billing/charge-codes` },
  { name: 'practice areas', path: (t) => `/api/lawfirms/${t.firm.id}/practice-areas` },
  { name: 'roles', path: (t) => `/api/lawfirms/${t.firm.id}/roles` },
  { name: 'members', path: (t) => `/api/lawfirms/${t.firm.id}/members` },
  { name: 'notifications', path: (t) => `/api/lawfirms/${t.firm.id}/notifications` },
  { name: 'dashboard summary', path: (t) => `/api/lawfirms/${t.firm.id}/dashboard-summary` },
  { name: 'audit events', path: (t) => `/api/lawfirms/${t.firm.id}/audit-events` },
];

describe.each(FIRM_ROUTES)('tenancy: $name', (route) => {
  it('direction A: refuses a member of another firm asking under this firm', async () => {
    // The membership gate runs before any scoping, so this is a hard refusal.
    const res = await beta.owner.api.get(route.path(alpha));

    expect([403, 404]).toContain(res.status);
  });

  it('direction B: discloses nothing when asked under the caller own firm', async () => {
    // Beta's owner, Beta's firm id, but Alpha's record ids. No gate fires here:
    // only the `law_firm_id` clause stands between the caller and the row.
    const path = route.path(alpha).replace(alpha.firm.id, beta.firm.id);
    const res = await beta.owner.api.get(path);

    // Asserted on CONTENT alone, deliberately. An earlier version read
    // `refusedOrEmpty(res) || !body.includes(...)`, and that `||` made the case
    // unfalsifiable: `carriesNoRows` counts a string field as "no rows", so a
    // leaked client OBJECT satisfied the left side and the assertion passed while
    // the data was in the body. Removing the firm clause from the repository base class's
    // findById proved it: this case stayed green while the blunt check below
    // went red.
    expect(JSON.stringify(res.body ?? {})).not.toContain(alpha.secretName);
    expect(withheldAmounts(res, [alpha.invoiceCents, alpha.trustCents])).toBe(true);
  });

  it('never states the other firm client name or figures', async () => {
    // The blunt instrument, and the one that would catch a leak the two shaped
    // assertions above missed: Alpha's client name and both of Alpha's money
    // figures must appear nowhere in a response served to Beta.
    const own = await beta.owner.api.get(route.path(beta));
    expect(own.status).toBe(200);

    const body = JSON.stringify(own.body ?? {});
    expect(body).not.toContain(alpha.secretName);
    expect(withheldAmounts(own, [alpha.invoiceCents, alpha.trustCents])).toBe(true);
  });
});

describe('tenancy: a caller who is a member of neither firm', () => {
  it('is refused every route', async () => {
    const { stranger } = require('../support/setupInProcess');
    const nobody = stranger();

    for (const route of FIRM_ROUTES) {
      // eslint-disable-next-line no-await-in-loop
      const res = await nobody.api.get(route.path(alpha));
      expect([401, 403, 404]).toContain(res.status);
    }
  });
});
