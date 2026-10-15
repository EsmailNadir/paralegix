/**
 * Flat fees: a fixed charge agreed up front rather than billed by the hour.
 *
 * The module had no test at all. A flat fee becomes an invoice line item exactly
 * the way a time entry or an expense does, so every rule that protects those has
 * to protect this one too, and none of them were pinned.
 *
 * Four properties carry the weight here.
 *
 *   ONE CONTEXT, NOT TWO. A fee belongs to a matter or a client, never both and
 *   never neither. Two contexts means two possible payers. The schema CHECK
 *   `(matter_id is not null) <> (client_id is not null)` is the last line of
 *   defence, not the first; the route schema is supposed to refuse it before a
 *   row is attempted.
 *
 *   MONEY IS INTEGER CENTS. The route speaks dollars and the column is
 *   `amount_cents bigint`. The conversion happens in the repository, and a float
 *   that survives to the column is a wrong bill. Every money case below reads
 *   the COLUMN, because a response echoing back what was sent passes whether the
 *   conversion happened or not.
 *
 *   FROZEN ONCE BILLED. An issued invoice is a document the client already
 *   holds. Changing the amount behind it makes the firm's records and the
 *   client's invoice disagree with nothing flagging it, so `updateFlatFee`
 *   freezes amount and date and `deleteFlatFee` refuses outright.
 *
 *   The freeze is driven by an invoice LINE ITEM. `flat_fees.billed` used to
 *   look like the flag for this and was not: nothing ever set it, and the
 *   service asks `isSourceBilled`, which joins `invoice_line_items` to
 *   `invoices`. Migration 0228 dropped the column. A fixture that only set
 *   `billed = true` produced a fee the service considered unbilled, so every
 *   freeze assertion passed against a fee that was never frozen. See
 *   `billOntoInvoice`.
 *
 *   TENANT AND CONTEXT SCOPE. `flat_fees.client_id` has no composite foreign key
 *   to `(law_firm_id, id)` (the whole-schema sweep in schema.sql drops every FK
 *   pointing at `clients`), so nothing in the database stops a firm writing a
 *   row that names another firm's client. `assertClientInFirm` is the only
 *   guard, and the matter arm has to be a membership check rather than a firm
 *   permission check or the ethical wall is decorative.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  createInvoice,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const base = () => `/api/lawfirms/${firm.id}/billing/flat-fees`;
const clientPath = () => `${base()}/client/${client.id}`;

/** Create a client-context flat fee. Returns the raw response. */
async function createFee(body: Record<string, unknown> = {}) {
  return owner.api.post(base()).send({
    clientId: client.id,
    description: 'Uncontested dissolution, flat',
    amount: 1500.5,
    date: '2026-05-19',
    ...body,
  });
}

const feeId = (res: any) => res.body?.flatFee?.id;

/**
 * A matter with `uid` on it. Every matter-context write goes through
 * `assertMatterMembership`, which refuses a firm owner who is not on the matter.
 */
async function seedMatter(uid: string | null): Promise<string> {
  const id = randomUUID();
  const matter = await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id, status)
     values ($1, $2, 'Flat Fee Matter', $3, 'active') returning id`,
    [id, firm.id, `REF-${id.slice(0, 8)}`],
  );
  expect(matter.rowCount).toBe(1);
  if (uid) {
    const member = await testPool.query(
      `insert into matter_members (law_firm_id, matter_id, user_id, role, joined_at)
       values ($1, $2, $3, 'lead', now())`,
      [firm.id, id, uid],
    );
    expect(member.rowCount).toBe(1);
  }
  return id;
}

/**
 * Put the fee onto an invoice as a LINE ITEM, which is what actually freezes it.
 * See the file header for why setting `billed` would not.
 */
async function billOntoInvoice(id: string, amountCents = 150_050) {
  const invoice = await createInvoice(firm.id, client.id, { totalCents: amountCents });
  const res = await testPool.query(
    `insert into invoice_line_items
       (invoice_id, law_firm_id, kind, source_id, quantity, rate_cents, amount_cents)
     values ($1, $2, 'flat_fee', $3, 1, $4, $4)`,
    [invoice.id, firm.id, id, amountCents],
  );
  expect(res.rowCount).toBe(1);
  return invoice;
}

/** The stored row, which is the only place the cents conversion is observable. */
const rowFor = async (id: string) => {
  const { rows } = await testPool.query(
    `select amount_cents, activity_date as fee_date, description, matter_id, client_id, created_by
       from activities where kind = 'flat_fee' and id = $1`,
    [id],
  );
  return rows[0];
};

const feeCount = async (where: string, param: string) => {
  const { rows } = await testPool.query(
    `select count(*)::int as n from activities where kind = 'flat_fee' and ${where} = $1`,
    [param],
  );
  return rows[0].n;
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Flat Fee Client' });
  await drainEvents();
});

describe('a flat fee belongs to exactly one billing context', () => {
  it('accepts a fee against a client', async () => {
    const res = await createFee();

    expect(res.status).toBe(201);
    expect(await rowFor(feeId(res))).toMatchObject({
      client_id: client.id,
      matter_id: null,
    });
  });

  it('accepts a fee against a matter', async () => {
    const matterId = await seedMatter(owner.uid);

    const res = await createFee({ clientId: undefined, matterId });

    expect(res.status).toBe(201);
    expect(await rowFor(feeId(res))).toMatchObject({
      matter_id: matterId,
      client_id: null,
    });
  });

  it('refuses a fee against BOTH a matter and a client', async () => {
    const matterId = await seedMatter(owner.uid);

    const res = await createFee({ matterId });

    // Two contexts means two possible payers. The fee would land on whichever
    // invoice was raised first and the other party would never be charged for
    // work that was agreed at a fixed price.
    expect(res.status).toBe(400);
    // The status alone would pass against a route that answered 400 and wrote
    // the row anyway.
    expect(await feeCount('law_firm_id', firm.id)).toBe(0);
  });

  it('refuses a fee against NEITHER', async () => {
    const res = await createFee({ clientId: undefined });

    expect(res.status).toBe(400);
    expect(await feeCount('law_firm_id', firm.id)).toBe(0);
  });

  it('records who entered the fee', async () => {
    const res = await createFee();

    // `created_by` is the only attribution a flat fee carries: unlike a time
    // entry there is no `user_id` naming whose work it was. Without it a
    // disputed charge cannot be traced back to anyone.
    expect((await rowFor(feeId(res))).created_by).toBe(owner.uid);
  });
});

describe('money is stored as integer cents', () => {
  it('converts a dollar amount to cents in the column', async () => {
    const res = await createFee({ amount: 1500.5 });

    expect(res.status).toBe(201);
    // The COLUMN, not the response. A response that echoes the request passes
    // whether the conversion happened or not.
    expect((await rowFor(feeId(res))).amount_cents).toBe('150050');
  });

  it('refuses a sub-cent amount rather than rounding it', async () => {
    // The caller's 12.345 is not a whole number of cents, so it is refused
    // instead of being silently stored as an amount nobody entered.
    const res = await createFee({ amount: 12.345 });

    expect(res.status).toBe(400);
    expect(await feeCount('law_firm_id', firm.id)).toBe(0);
  });

  it('converts to cents on update too, not only on create', async () => {
    const id = feeId(await createFee({ amount: 1500.5 }));

    const res = await owner.api.put(`${clientPath()}/${id}`).send({ amount: 2000.25 });

    expect(res.status).toBe(200);
    // The create path and the update path convert independently. A fix applied
    // to one and not the other stores dollars in a cents column, which is a bill
    // 100x too small.
    expect((await rowFor(id)).amount_cents).toBe('200025');
  });

  it('refuses a zero amount', async () => {
    const res = await createFee({ amount: 0 });

    // A flat fee of nothing is a data-entry slip that reaches the client's
    // invoice as a line worth nothing.
    expect(res.status).toBe(400);
    expect(await feeCount('law_firm_id', firm.id)).toBe(0);
  });

  it('refuses a negative amount', async () => {
    const res = await createFee({ amount: -50 });

    // A negative flat fee is a credit by another name, and it would reduce the
    // invoice total without any of the checks a credit goes through. The column
    // also carries `check (amount_cents >= 0)`, so a widened schema turns this
    // into a 500 rather than a silent write; either way this case goes red.
    expect(res.status).toBe(400);
    expect(await feeCount('law_firm_id', firm.id)).toBe(0);
  });

  it('refuses an amount sent as a string', async () => {
    const res = await createFee({ amount: '1500.50' });

    // `parseFloat` in the service would happily accept this. The Zod schema is
    // what stops it, and a widened schema must turn this case red.
    expect(res.status).toBe(400);
    expect(await feeCount('law_firm_id', firm.id)).toBe(0);
  });

  it('accepts an amount right at the documented maximum', async () => {
    const res = await createFee({ amount: 1_000_000_000 });

    expect(res.status).toBe(201);
    expect((await rowFor(feeId(res))).amount_cents).toBe('100000000000');
  });

  it('rejects an amount one dollar past the documented maximum', async () => {
    const res = await createFee({ amount: 1_000_000_001 });

    // Rejecting max+1 on this field also rejects anything larger, such as 1e17,
    // whose cents overflow a bigint and used to answer 500 from the insert.
    expect(res.status).toBe(400);
    expect(await feeCount('law_firm_id', firm.id)).toBe(0);
  });

  it('rejects the same huge finite value on UPDATE, not just create', async () => {
    const id = feeId(await createFee({ amount: 1500.5 }));

    const res = await owner.api.put(`${clientPath()}/${id}`).send({ amount: 1e17 });

    expect(res.status).toBe(400);
    // Unchanged from the control amount, not corrupted and not silently accepted.
    expect((await rowFor(id)).amount_cents).toBe('150050');
  });

  it('returns dollars, not cents, to the caller', async () => {
    const id = feeId(await createFee({ amount: 1500.5 }));

    const res = await owner.api.get(clientPath());

    // The column is cents and the API is dollars. A missed conversion here shows
    // the firm a fee 100x too large on every billing screen.
    expect(res.status).toBe(200);
    expect(res.body.flatFees.find((f: any) => f.id === id).amount).toBe(1500.5);
  });
});

describe('the fee date is a calendar day', () => {
  it('stores the day it was given, not the day before', async () => {
    const res = await createFee({ date: '2026-05-19' });

    // `fee_date` is a day-only `date` column. Wrapping the input in
    // `new Date('2026-05-19')` produces UTC midnight, which is 18 May everywhere
    // west of UTC, and every fee silently moves back a day.
    expect((await rowFor(feeId(res))).fee_date).toBe('2026-05-19');
  });

  it('hands the day back as a plain YYYY-MM-DD string', async () => {
    const res = await createFee({ date: '2026-05-19' });

    // node-pg returns oid 1082 as a raw string and the repository must leave it
    // alone. Re-wrapping it in a Date and calling toISOString sends the client
    // an instant with a timezone, which is the shift this column exists to
    // avoid.
    expect(res.body.flatFee.date).toBe('2026-05-19');
  });

  it('accepts a fee with no date', async () => {
    const res = await createFee({ date: null });

    expect(res.status).toBe(201);
    expect((await rowFor(feeId(res))).fee_date).toBeNull();
  });
});

describe('a flat fee is frozen once it is billed', () => {
  it('refuses to change the amount of a billed fee', async () => {
    const id = feeId(await createFee());
    await billOntoInvoice(id);

    const res = await owner.api.put(`${clientPath()}/${id}`).send({ amount: 9999 });

    expect(res.status).toBe(403);
    // The row, not the status. A route that answered 403 after writing would
    // already have diverged the firm's records from the client's invoice.
    expect((await rowFor(id)).amount_cents).toBe('150050');
  });

  it('refuses to change the date of a billed fee', async () => {
    const id = feeId(await createFee());
    await billOntoInvoice(id);

    const res = await owner.api.put(`${clientPath()}/${id}`).send({ date: '2026-01-01' });

    expect(res.status).toBe(403);
    expect((await rowFor(id)).fee_date).toBe('2026-05-19');
  });

  it('still allows the description of a billed fee to be corrected', async () => {
    const id = feeId(await createFee());
    await billOntoInvoice(id);

    const res = await owner.api.put(`${clientPath()}/${id}`)
      .send({ description: 'Uncontested dissolution, flat (corrected)' });

    // The description does not change what was charged, so freezing it would
    // block a legitimate correction for no gain. This case is why the freeze
    // names two fields rather than refusing every edit.
    expect(res.status).toBe(200);
    expect((await rowFor(id)).description).toBe('Uncontested dissolution, flat (corrected)');
  });

  it('refuses to delete a billed fee', async () => {
    const id = feeId(await createFee());
    await billOntoInvoice(id);

    const res = await owner.api.delete(`${clientPath()}/${id}`);

    expect(res.status).toBe(403);
    expect(await rowFor(id)).toBeDefined();
  });

  it('lets an UNBILLED fee be edited and deleted', async () => {
    const id = feeId(await createFee());

    const edit = await owner.api.put(`${clientPath()}/${id}`).send({ amount: 2000 });
    expect(edit.status).toBe(200);
    expect((await rowFor(id)).amount_cents).toBe('200000');

    const removed = await owner.api.delete(`${clientPath()}/${id}`);
    expect(removed.status).toBe(200);
    expect(await rowFor(id)).toBeUndefined();
  });

});

describe('listing reports what is on an invoice', () => {
  it('marks a billed fee as billed and an unbilled one as not', async () => {
    const billed = feeId(await createFee({ description: 'Billed fee' }));
    const open = feeId(await createFee({ description: 'Open fee' }));
    await billOntoInvoice(billed);

    const res = await owner.api.get(clientPath());

    expect(res.status).toBe(200);
    const byId = new Map(res.body.flatFees.map((f: any) => [f.id, f.isBilled]));
    // Both halves. Asserting only that the billed one is flagged would pass
    // against a list that flagged everything.
    expect(byId.get(billed)).toBe(true);
    expect(byId.get(open)).toBe(false);
  });

  it('drops billed fees when unbilledOnly is asked for, and keeps the rest', async () => {
    const billed = feeId(await createFee({ description: 'Billed fee' }));
    const open = feeId(await createFee({ description: 'Open fee' }));
    await billOntoInvoice(billed);

    const res = await owner.api.get(`${clientPath()}?unbilledOnly=true`);

    expect(res.status).toBe(200);
    const ids = res.body.flatFees.map((f: any) => f.id);
    // Both halves again: a filter that returned nothing would satisfy the
    // exclusion on its own, and the invoice composer would show no work to bill.
    expect(ids).toContain(open);
    expect(ids).not.toContain(billed);
  });

  it('lists a matter context separately from a client context', async () => {
    const matterId = await seedMatter(owner.uid);
    await createFee({ description: 'Client fee' });
    await createFee({ clientId: undefined, matterId, description: 'Matter fee' });

    const clientList = await owner.api.get(clientPath());
    const matterList = await owner.api.get(`${base()}/matter/${matterId}`);

    // A context that leaked the other's rows would double-bill: the same fee
    // would be available to a matter invoice and a client invoice.
    expect(clientList.body.flatFees.map((f: any) => f.description)).toEqual(['Client fee']);
    expect(matterList.body.flatFees.map((f: any) => f.description)).toEqual(['Matter fee']);
  });
});

describe('tenant and context isolation', () => {
  it("does not list another firm's fees", async () => {
    const other = await createFirm({ name: 'Other Firm' });
    const otherOwner = await ownerOf(other.id);
    const otherClient = await createPersonClient(other.id, { name: 'Other Client' });
    const theirs = await otherOwner.api.post(`/api/lawfirms/${other.id}/billing/flat-fees`)
      .send({ clientId: otherClient.id, description: 'Their fee', amount: 100 });
    expect(theirs.status).toBe(201);
    await createFee({ description: 'Our fee' });

    const res = await owner.api.get(clientPath());

    // Both halves: the presence proves the read ran at all, and the seeded
    // foreign fee proves there was something to leak.
    const descriptions = res.body.flatFees.map((f: any) => f.description);
    expect(descriptions).toContain('Our fee');
    expect(descriptions).not.toContain('Their fee');
  });

  it("refuses a fee naming a client of another firm, and writes nothing", async () => {
    const other = await createFirm({ name: 'Other Firm' });
    const foreign = await createPersonClient(other.id, { name: 'Foreign Client' });

    const res = await createFee({ clientId: foreign.id });

    // Nothing in the database stops this: the whole-schema sweep drops the
    // foreign key from `flat_fees.client_id` to `clients`. Written through, the
    // row carries this firm's law_firm_id and the other firm's client_id, so no
    // list endpoint in either firm ever shows it. The fee is unbillable and
    // invisible, and deleting that client cascades it away entirely.
    expect(res.status).toBe(404);
    expect(await feeCount('client_id', foreign.id)).toBe(0);
  });

  it("refuses a fee naming a matter of another firm, and writes nothing", async () => {
    const other = await createFirm({ name: 'Other Firm' });
    const foreignMatterId = randomUUID();
    await testPool.query(
      `insert into matters (id, law_firm_id, name, matter_reference_id, status)
       values ($1, $2, 'Foreign Matter', $3, 'active')`,
      [foreignMatterId, other.id, `REF-${foreignMatterId.slice(0, 8)}`],
    );

    const res = await createFee({ clientId: undefined, matterId: foreignMatterId });

    expect(res.status).toBe(404);
    expect(await feeCount('matter_id', foreignMatterId)).toBe(0);
  });

  it("refuses to read a client context belonging to another firm", async () => {
    const other = await createFirm({ name: 'Other Firm' });
    const otherOwner = await ownerOf(other.id);
    const otherClient = await createPersonClient(other.id, { name: 'Other Client' });
    const theirs = await otherOwner.api.post(`/api/lawfirms/${other.id}/billing/flat-fees`)
      .send({ clientId: otherClient.id, description: 'Their fee', amount: 100 });
    expect(theirs.status).toBe(201);

    const res = await owner.api.get(`${base()}/client/${otherClient.id}`);

    // Seeded first on purpose: against a firm with no fees this answers the same
    // way whether the read was scoped or simply found nothing.
    expect(res.status).toBe(404);
    expect(await feeCount('client_id', otherClient.id)).toBe(1);
  });

  it('refuses to edit a fee through the wrong context', async () => {
    const id = feeId(await createFee());
    const otherClient = await createPersonClient(firm.id, { name: 'Second Client' });

    const res = await owner.api.put(`${base()}/client/${otherClient.id}/${id}`)
      .send({ amount: 9999 });

    // The lookup is scoped by context, so addressing the fee through a client
    // that does not own it must not find it. Without that scope one client's
    // charges could be edited from another client's billing page.
    expect(res.status).toBe(404);
    expect((await rowFor(id)).amount_cents).toBe('150050');
  });

  it('refuses to delete a fee through the wrong context', async () => {
    const id = feeId(await createFee());
    const otherClient = await createPersonClient(firm.id, { name: 'Second Client' });

    const res = await owner.api.delete(`${base()}/client/${otherClient.id}/${id}`);

    expect(res.status).toBe(404);
    // The delete SQL is scoped only by `law_firm_id` and `id`; the context scope
    // lives entirely in the `findById` guard above it. If that guard is dropped
    // the row disappears while the caller was addressing someone else's client.
    expect(await rowFor(id)).toBeDefined();
  });

  it('refuses a matter-context write from a firm member who is not on the matter', async () => {
    const outsider = await memberWith(firm.id, [
      'billing.manageInvoices', 'billing.viewInvoices',
    ]);
    const matterId = await seedMatter(owner.uid);

    const res = await outsider.api.post(base())
      .send({ matterId, description: 'Fee', amount: 100 });

    // The firm permission is not enough on a matter context: matter membership
    // is a second, narrower gate, and it is what keeps a member off matters they
    // were never staffed on.
    expect(res.status).toBe(403);
    expect(await feeCount('matter_id', matterId)).toBe(0);
  });

  it('lets a firm owner READ a matter they are not staffed on', async () => {
    const matterId = await seedMatter(null);
    await testPool.query(
      `insert into activities (kind, law_firm_id, matter_id, description, charge_cents, activity_date)
       values ('flat_fee', $1, $2, 'Owner-visible fee', 50000, '2026-05-19')`,
      [firm.id, matterId],
    );

    const res = await owner.api.get(`${base()}/matter/${matterId}`);

    // Reads use `assertMatterReadAccess`, which is deliberately wider than the
    // write gate: an owner sees firm-wide billing. Pinning it means narrowing
    // the read to strict membership has to be a decision someone makes, not a
    // side effect of tightening the write path.
    expect(res.status).toBe(200);
    expect(res.body.flatFees.map((f: any) => f.description)).toContain('Owner-visible fee');
  });

  it('refuses a matter-context READ from a member who is not on the matter', async () => {
    const matterId = await seedMatter(null);
    await testPool.query(
      `insert into activities (kind, law_firm_id, matter_id, description, charge_cents, activity_date)
       values ('flat_fee', $1, $2, 'Walled-off fee', 50000, '2026-05-19')`,
      [firm.id, matterId],
    );
    const outsider = await memberWith(firm.id, ['billing.viewInvoices']);

    const res = await outsider.api.get(`${base()}/matter/${matterId}`);

    // The ethical wall. Seeded first so the refusal is distinguishable from an
    // empty matter, and the row is checked to still exist so the 403 is not
    // hiding a failed fixture.
    expect(res.status).toBe(403);
    expect(await feeCount('matter_id', matterId)).toBe(1);
  });
});

describe('permissions', () => {
  it('refuses a member whose role grants nothing the flat fee list', async () => {
    await createFee({ description: 'Baseline visible fee' });
    const plain = await memberWith(firm.id, ['matters.view']);

    const res = await plain.api.get(clientPath());

    // `billing.viewInvoices` is not in DEFAULT_PERMISSIONS, so a role that never
    // names it cannot read the list.
    //
    // Seeded first on purpose: a firm with no fees answers an empty list
    // whether the charges were withheld or never existed, so the body is checked.
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('Baseline visible fee');
  });

  it('does NOT give that baseline member the right to write', async () => {
    const plain = await memberWith(firm.id, ['matters.view']);

    const res = await plain.api.post(base())
      .send({ clientId: client.id, description: 'Fee', amount: 100 });

    // `billing.manageInvoices` is not in the baseline, and this is the pair that
    // makes the read case above safe: read-only degradation, not an open door.
    expect(res.status).toBe(403);
    expect(await feeCount('law_firm_id', firm.id)).toBe(0);
  });

  it('refuses a signed-in caller who is not a member of the firm at all', async () => {
    const outsider = await memberWith((await createFirm({ name: 'Elsewhere' })).id, [
      'billing.viewInvoices', 'billing.manageInvoices',
    ]);
    await createFee({ description: 'Not yours' });

    const res = await outsider.api.get(clientPath());

    expect(res.status).toBe(403);
    expect(await feeCount('law_firm_id', firm.id)).toBe(1);
  });
});

describe('the flatFees plan gate', () => {
  it('serves a firm on the cheapest plan, because every tier includes flat fees', async () => {
    // The router mounts behind `requireFeature('flatFees')`, but `flatFees` is
    // true on starter, basic, professional and enterprise alike
    // (planDefinitions.ts). Pinned so that moving flat fees behind a paid tier
    // is a deliberate change with a red test in front of it, rather than a
    // one-word edit that silently 403s every free firm.
    const starterFirm = await createFirm({ name: 'Starter Firm', planId: 'starter' });
    const starterOwner = await ownerOf(starterFirm.id);
    const starterClient = await createPersonClient(starterFirm.id, { name: 'Starter Client' });

    const res = await starterOwner.api.post(`/api/lawfirms/${starterFirm.id}/billing/flat-fees`)
      .send({ clientId: starterClient.id, description: 'Fee', amount: 100 });

    expect(res.status).toBe(201);
  });

  it('refuses a firm that has turned the feature off in its own settings', async () => {
    // The firm-level opt-out is the half of `isFeatureEnabled` that is not
    // decided by the price list, and it is the only way a flat-fee request is
    // refused by the plan gate today. Without a case here the whole
    // `requireFeature` mount on this router is untested.
    await testPool.query(
      `update law_firms set settings = '{"features": {"flatFees": false}}'::jsonb where id = $1`,
      [firm.id],
    );

    const res = await createFee();

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(res.body.error).toMatch(/not included in your current plan/i);
    expect(res.body.error).toMatch(/flat fee/i);
    expect(await feeCount('law_firm_id', firm.id)).toBe(0);
  });

  it('still refuses the read side when the feature is off', async () => {
    await createFee({ description: 'Pre-existing fee' });
    await testPool.query(
      `update law_firms set settings = '{"features": {"flatFees": false}}'::jsonb where id = $1`,
      [firm.id],
    );

    const res = await owner.api.get(clientPath());

    // The gate is mounted on the router, not on the write routes, so turning the
    // feature off has to close the list too. Seeded before the switch so the
    // refusal is not an empty firm.
    expect(res.status).toBe(403);
    expect(await feeCount('law_firm_id', firm.id)).toBe(1);
  });
});

describe('input bounds and malformed ids', () => {
  it('refuses an empty description', async () => {
    const res = await createFee({ description: '' });

    // A flat fee with no description reaches the client's invoice as a bare
    // amount with nothing saying what it bought.
    expect(res.status).toBe(400);
    expect(await feeCount('law_firm_id', firm.id)).toBe(0);
  });

  it('refuses a fee with no description field at all', async () => {
    const res = await createFee({ description: undefined });

    expect(res.status).toBe(400);
    expect(await feeCount('law_firm_id', firm.id)).toBe(0);
  });

  it('refuses a fee with no amount', async () => {
    const res = await createFee({ amount: undefined });

    expect(res.status).toBe(400);
    expect(await feeCount('law_firm_id', firm.id)).toBe(0);
  });

  it('answers 404 for a flat fee id that is not a uuid', async () => {
    const res = await owner.api.put(`${clientPath()}/not-a-uuid`).send({ amount: 5 });

    // The repository refuses a non-uuid before it reaches Postgres. Without that
    // guard the query raises 22P02 and the route answers 500, which reads as a
    // server fault rather than a bad id.
    expect(res.status).toBe(404);
  });

  it('answers 404 for a client context id that is not a uuid', async () => {
    const res = await owner.api.get(`${base()}/client/not-a-uuid`);

    // `clients.id` is a uuid column, so an unguarded read is a cast error and a
    // 500 carrying the query shape.
    expect(res.status).toBe(404);
  });

  it('answers 404 for a matter context id that is not a uuid', async () => {
    const res = await owner.api.get(`${base()}/matter/not-a-uuid`);

    expect(res.status).toBe(404);
  });

  it('answers 404 for a flat fee that does not exist', async () => {
    const res = await owner.api.delete(`${clientPath()}/${randomUUID()}`);

    expect(res.status).toBe(404);
  });

  it('answers 404 when updating a flat fee that does not exist', async () => {
    const res = await owner.api.put(`${clientPath()}/${randomUUID()}`).send({ amount: 5 });

    expect(res.status).toBe(404);
  });
});

describe('the response carries its billing context, like expenses and time entries do', () => {
  it('derives contextType, entityId and clientContextId for a CLIENT fee', async () => {
    const res = await createFee();

    // `formatFlatFee` read contextType and clientContextId while the
    // repository's toEntity set neither, so both were permanently null here
    // while the two sibling modules answered correctly. Red if toEntity stops
    // deriving them.
    expect(res.body.flatFee).toMatchObject({
      contextType: 'client',
      entityId: client.id,
      clientContextId: client.id,
      matterId: null,
    });
  });

  it('derives them for a MATTER fee too', async () => {
    const matterId = await seedMatter(owner.uid);

    const res = await createFee({ clientId: undefined, matterId });

    // Both contexts, because a single-context test passes against a hardcoded
    // literal.
    expect(res.body.flatFee).toMatchObject({
      contextType: 'matter',
      entityId: matterId,
      matterId,
      clientContextId: null,
    });
  });
});
