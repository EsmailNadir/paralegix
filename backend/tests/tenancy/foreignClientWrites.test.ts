/**
 * A firm may not write records against another firm's client.
 *
 * This is a CLASS of bug, not one instance. The shape is always the same: a
 * create path asserts that the CALLER belongs to the firm, then takes an entity
 * id straight from the request and writes it, without ever asking whether that
 * entity belongs to the firm too.
 *
 * It does not leak data. The row carries the caller's own `law_firm_id`, so
 * every read stays correctly scoped and neither firm sees the other's records.
 * The damage is quieter:
 *
 *   - The row is invisible to BOTH firms. The owning firm filters by its own
 *     `law_firm_id` and never sees it; the writing firm's list joins back to a
 *     client it does not have. Work recorded this way is simply lost.
 *   - `clients.id` cascades on delete, so the owning firm removing that client
 *     silently deletes the other firm's rows.
 *
 * Found first in the billing context (`clientContextScope.test.ts`), then swept
 * for across every create endpoint that accepts a client or matter id. This file
 * is the permanent guard for the whole class, so a new endpoint that forgets the
 * check is caught here rather than by the next audit.
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
let ownerA: Actor;
let clientA: ClientRecord;
/** The firm that tries to write against it. */
let firmB: Firm;
let ownerB: Actor;

const inB = (suffix: string) => `/api/lawfirms/${firmB.id}${suffix}`;

const rowsReferencing = async (table: string, clientId: string) => {
  const { rows } = await testPool.query(
    `select law_firm_id from ${table} where client_id = $1`, [clientId],
  );
  return rows;
};

beforeEach(async () => {
  firmA = await createFirm({ name: 'Firm A' });
  ownerA = await ownerOf(firmA.id);
  clientA = await createPersonClient(firmA.id, { name: 'A Client' });

  firmB = await createFirm({ name: 'Firm B' });
  ownerB = await ownerOf(firmB.id);
  await drainEvents();
});

describe('client events', () => {
  it('refuses an event against another firm client', async () => {
    const res = await ownerB.api
      .post(inB(`/clients/${clientA.id}/events`))
      .send({ type: 'meeting', title: 'Cross Firm Event', date: '2026-03-10' });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('writes NO row referencing that client', async () => {
    await ownerB.api
      .post(inB(`/clients/${clientA.id}/events`))
      .send({ type: 'meeting', title: 'Cross Firm Event', date: '2026-03-10' });

    // Asserting the DATA, not only the status. The row is the damage: it is
    // invisible to both firms and dies when firm A deletes its client.
    expect(await rowsReferencing('events', clientA.id)).toHaveLength(0);
  });

  it('answers NOT FOUND rather than FORBIDDEN', async () => {
    const res = await ownerB.api
      .post(inB(`/clients/${clientA.id}/events`))
      .send({ type: 'meeting', title: 'X', date: '2026-03-10' });

    // A 403 confirms the id names a real client somewhere else in the system.
    expect(res.status).toBe(404);
  });

  it('refuses a MALFORMED client id without a database error', async () => {
    const res = await ownerB.api
      .post(inB('/clients/not-a-uuid/events'))
      .send({ type: 'meeting', title: 'X', date: '2026-03-10' });

    // An unguarded uuid cast reaching Postgres is a 500 carrying the query shape.
    expect(res.status).toBe(404);
  });

  it('refuses another firm ORGANIZATION as readily as a person', async () => {
    const orgA = await createOrgClient(firmA.id, { name: 'Acme Corporation' });
    await drainEvents();

    const res = await ownerB.api
      .post(inB(`/clients/${orgA.id}/events`))
      .send({ type: 'meeting', title: 'X', date: '2026-03-10' });

    expect(res.status).toBe(404);
    expect(await rowsReferencing('events', orgA.id)).toHaveLength(0);
  });

  it('still allows an event against the firm OWN client', async () => {
    const ownClient = await createPersonClient(firmB.id, { name: 'B Client' });
    await drainEvents();

    const res = await ownerB.api
      .post(inB(`/clients/${ownClient.id}/events`))
      .send({ type: 'meeting', title: 'Ordinary Event', date: '2026-03-10' });

    // The positive half. A check written as "refuse every client" would satisfy
    // every case above while stopping the firm scheduling anything at all.
    expect(res.status).toBe(201);
  });

  it('still allows an event against the firm own ORGANIZATION', async () => {
    const ownOrg = await createOrgClient(firmB.id, { name: 'B Corporation' });
    await drainEvents();

    const res = await ownerB.api
      .post(inB(`/clients/${ownOrg.id}/events`))
      .send({ type: 'meeting', title: 'Org Event', date: '2026-03-10' });

    // An organization is a client. A fix resolving clients through
    // `clients.user_id`, which an organization can never carry, would refuse
    // here and break every organization's calendar.
    expect(res.status).toBe(201);
  });
});

describe('trust transactions', () => {
  /** A trust account belonging to firm B, to deposit into. */
  async function firmBAccount() {
    const res = await ownerB.api.post(inB('/trust/accounts')).send({
      name: 'B IOLTA', accountType: 'iolta', bankName: 'Bank', accountNumberLast4: '1234',
    });
    expect(res.status).toBe(201);
    return res.body.account.id;
  }

  const deposit = (accountId: string, clientId: string) => ownerB.api
    .post(inB('/trust/transactions'))
    .send({
      trustAccountId: accountId,
      type: 'deposit',
      amountCents: 500_000,
      clientId,
      clientName: 'A Client',
      date: '2026-03-10',
    });

  it('refuses a deposit attributed to another firm client, and writes NO trust row for it', async () => {
    const res = await deposit(await firmBAccount(), clientA.id);

    // The worst instance of this class. Trust is client money held in a
    // fiduciary account, and this records five thousand dollars of it against a
    // client the firm does not have.
    expect(res.status).toBe(404);

    const { rows } = await testPool.query(
      'select id from trust_transactions where client_id = $1', [clientA.id],
    );

    // The row matters more here than anywhere else in this file, for two
    // reasons that compound.
    //
    // `trust_transactions` is append-only: the `trust_txn_immutable` trigger
    // blocks edit and delete of a completed entry, so a wrong row cannot be
    // corrected away. It needs a reversing entry, which is itself a fiduciary
    // record of a movement that never happened.
    //
    // And `trust_transactions.client_id` references `clients(id)` with NO
    // cascade, so it RESTRICTS. Firm A can never delete that client again: the
    // delete fails on a foreign key held by a firm they cannot see, over a row
    // neither firm can remove.
    expect(rows).toHaveLength(0);
  });

  it('refuses a MALFORMED client id without a database error', async () => {
    const accountId = await firmBAccount();

    const res = await ownerB.api.post(inB('/trust/transactions')).send({
      trustAccountId: accountId,
      type: 'deposit',
      amountCents: 100,
      clientId: 'not-a-uuid',
      clientName: 'X',
      date: '2026-03-10',
    });

    expect(res.status).toBe(400);
  });

  it('still allows a deposit for the firm OWN client', async () => {
    const ownClient = await createPersonClient(firmB.id, { name: 'B Client' });
    await drainEvents();

    const res = await deposit(await firmBAccount(), ownClient.id);

    // The positive half. Blocking every deposit would satisfy the cases above
    // and stop the firm banking client funds at all.
    expect(res.status).toBe(201);
  });

  it('still allows a deposit for the firm own ORGANIZATION', async () => {
    const ownOrg = await createOrgClient(firmB.id, { name: 'B Corporation' });
    await drainEvents();

    const res = await deposit(await firmBAccount(), ownOrg.id);

    expect(res.status).toBe(201);
  });
});

describe('endpoints that already refuse, kept as regression cover', () => {
  it('refuses a TASK against another firm matter', async () => {
    const matterA = await ownerA.api.post(`/api/lawfirms/${firmA.id}/matters`).send({
      name: 'A Matter', clients: [{ clientId: clientA.id, name: 'A Client' }],
    });
    expect(matterA.status).toBe(201);
    const matterAId = matterA.body.matterId;
    await drainEvents();

    const res = await ownerB.api.post(inB('/tasks')).send({ title: 'X', matterId: matterAId });

    expect(res.status).toBe(404);
  });

  it('refuses a DOCUMENT REQUEST against another firm client', async () => {
    const res = await ownerB.api.post(inB('/document-requests'))
      .send({ clientId: clientA.id, title: 'Please send these' });

    expect(res.status).toBe(404);
    expect(await rowsReferencing('document_requests', clientA.id)).toHaveLength(0);
  });
});

describe('CHARACTERISATION: a matter CREATES a client from a foreign id', () => {
  it('attaches a NEW client of its own firm, not the foreign one', async () => {
    const res = await ownerB.api.post(inB('/matters')).send({
      name: 'Cross Firm Matter',
      clients: [{ clientId: clientA.id, name: 'A Client' }],
    });

    // Prove the create RAN before asking what it produced. Without this the
    // whole case degrades to "no rows found", which is what a failed create
    // looks like too, and the failure names the wrong thing. This file's own
    // header calls that out as the recurring mistake, and this test made it.
    expect(res.status).toBe(201);
    const { matterId } = res.body;
    expect(matterId).toEqual(expect.any(String));

    const { rows } = await testPool.query(
      `select mc.client_id, c.law_firm_id as client_firm
         from matter_clients mc join clients c on c.id = mc.client_id
        where mc.matter_id = $1`,
      [matterId],
    );

    // Recorded as what ships, and reported rather than changed.
    //
    // This is NOT the bug above. Matter creation doubles as an intake flow, so
    // an unknown client id is treated as "create this client", and it does:
    // a brand new `clients` row in the CALLER'S firm, carrying the supplied
    // name. No cross-tenant row exists, and the link is correctly scoped.
    //
    // The cost is a silent duplicate. A caller who mistypes an id, or pastes one
    // from another firm, gets a second client with the same name and no warning.
    // Refusing an unrecognised id instead would break inline intake, so which
    // way this should go is a product decision. This test goes red when someone
    // makes it.
    expect(rows).toHaveLength(1);
    expect(rows[0].client_id).not.toBe(clientA.id);
    expect(rows[0].client_firm).toBe(firmB.id);
  });
});
