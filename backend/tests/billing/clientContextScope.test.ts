/**
 * The billing client context must belong to the firm paying for it.
 *
 * `authorizeContext` in `src/modules/billing/context.ts` is shared by time
 * entries, expenses, flat fees and invoices. Its CLIENT arm used to check only
 * that the CALLER was a member of the firm, never that the client they named
 * was. Its MATTER arm always checked both.
 *
 * The gap was not a data leak: the row is written with the caller's own
 * `law_firm_id`, so reads stay correctly scoped and no firm sees another firm's
 * records. It was worse in a quieter way. A member of firm B could record
 * billable work naming a client of firm A, and the row landed with firm B's
 * `law_firm_id` and firm A's `client_id`. No list endpoint in EITHER firm would
 * ever return it, so the work was invisible and unbillable, and because
 * `clients.id` cascades on delete, firm A removing that client would silently
 * delete firm B's billing rows.
 *
 * Found by the cross-firm case in `timeEntries.test.ts`, which expected a
 * refusal and got a 201. The fix is one check in the shared helper, so this file
 * covers every module that helper serves. Testing only the module the bug
 * surfaced in would leave three others resting on an untested branch.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  createOrgClient,
  ownerOf,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

/** The firm that OWNS the client. */
let firmA: Firm;
let clientA: ClientRecord;
/** The firm that tries to bill against it. */
let firmB: Firm;
let ownerB: Actor;

const billingB = (suffix: string) => `/api/lawfirms/${firmB.id}/billing${suffix}`;

/** Rows of one kind of work against a client. All three kinds live in `activities`. */
const countIn = async (kind: 'time' | 'expense' | 'flat_fee', clientId: string) => {
  const { rows } = await testPool.query(
    'select count(*)::int as n from activities where kind = $2 and client_id = $1', [clientId, kind],
  );
  return rows[0].n;
};

beforeEach(async () => {
  firmA = await createFirm({ name: 'Firm A' });
  await ownerOf(firmA.id);
  clientA = await createPersonClient(firmA.id, { name: 'A Client' });

  firmB = await createFirm({ name: 'Firm B' });
  ownerB = await ownerOf(firmB.id);
  await drainEvents();
});

describe('a foreign client is refused on every billing surface', () => {
  it('refuses a TIME ENTRY naming another firm client', async () => {
    const res = await ownerB.api.post(billingB('/time-entries')).send({
      clientId: clientA.id,
      userId: ownerB.uid,
      hours: 3,
      date: '2026-03-10',
      hourlyRate: 400,
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await countIn('time', clientA.id)).toBe(0);
  });

  it('refuses an EXPENSE naming another firm client', async () => {
    const res = await ownerB.api.post(billingB('/expenses')).send({
      clientId: clientA.id,
      description: 'Filing fee',
      amount: 125,
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await countIn('expense', clientA.id)).toBe(0);
  });

  it('refuses a FLAT FEE naming another firm client', async () => {
    const res = await ownerB.api.post(billingB('/flat-fees')).send({
      clientId: clientA.id,
      description: 'Fixed-fee consultation',
      amount: 500,
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await countIn('flat_fee', clientA.id)).toBe(0);
  });

  it('answers NOT FOUND rather than FORBIDDEN', async () => {
    const res = await ownerB.api.post(billingB('/time-entries')).send({
      clientId: clientA.id, userId: ownerB.uid, hours: 1, date: '2026-03-10',
    });

    // A 403 would confirm the id names a real client somewhere. Another firm's
    // client has to be indistinguishable from one that never existed.
    expect(res.status).toBe(404);
  });

  it('refuses an id that belongs to no firm at all', async () => {
    const res = await ownerB.api.post(billingB('/time-entries')).send({
      clientId: '00000000-0000-0000-0000-000000000000',
      userId: ownerB.uid,
      hours: 1,
      date: '2026-03-10',
    });

    expect(res.status).toBe(404);
  });

  it('refuses a MALFORMED id without a database error', async () => {
    const res = await ownerB.api.post(billingB('/time-entries')).send({
      clientId: 'not-a-uuid',
      userId: ownerB.uid,
      hours: 1,
      date: '2026-03-10',
    });

    // An unguarded uuid cast reaching Postgres is a 500 with the query shape in
    // the log, and on some deployments in the response.
    expect(res.status).toBe(404);
  });

  it('refuses another firm ORGANIZATION as readily as a person', async () => {
    const orgA = await createOrgClient(firmA.id, { name: 'Acme Corporation' });
    await drainEvents();

    const res = await ownerB.api.post(billingB('/time-entries')).send({
      clientId: orgA.id, userId: ownerB.uid, hours: 2, date: '2026-03-10',
    });

    // Organizations resolve through a different path in several places, which is
    // where organization-specific holes keep appearing.
    expect(res.status).toBe(404);
    expect(await countIn('time', orgA.id)).toBe(0);
  });
});

// The positive half, a firm billing its OWN person and organization clients, is
// pinned in each module's own spec: `timeEntries.test.ts` (including an
// organization), `expenses.test.ts` and `flatFees.test.ts`. Without it a check
// written as "refuse every client" would satisfy every case above.
