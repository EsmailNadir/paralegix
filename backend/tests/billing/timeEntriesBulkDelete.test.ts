/**
 * Deleting a selection of time entries in ONE request.
 *
 * WHY THE ROUTE EXISTS. The three time-entry panels used to send one DELETE per
 * selected row. The firm list's "select all matching" ceiling is 1,000 entries,
 * so a single click could open a thousand round trips against an API instance
 * that holds twelve Postgres connections for every user on it.
 *
 * WHAT THE ROUTE MUST NOT BECOME. A bulk delete is the shape most likely to
 * shed a per-row rule while it is being made fast: the entry that is on an
 * invoice, and the entry on a matter the caller was never staffed on, are both
 * refused one at a time today and must still be refused in a batch. The batch
 * is NOT all-or-nothing either way: the rows the caller may delete are deleted
 * and the rest come back in `errors`.
 *
 * WHAT BREAKS EACH TEST:
 *  - drop the firm-membership assert and the cross-firm case deletes another
 *    firm's work;
 *  - drop the invoice check and the billed entry goes, leaving an issued
 *    invoice citing a row that no longer exists (the database trigger would
 *    then abort the whole statement, so the whole batch would fail instead);
 *  - drop the matter-membership check and the ethical wall stops holding for a
 *    caller who guessed an id;
 *  - resolve either of those per entry instead of per batch and the connection
 *    count grows with the selection, which is the burst the route exists to
 *    remove;
 *  - raise or remove the id cap and a caller can hand the service a list the UI
 *    could never have produced.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  createInvoice,
  ownerOf,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

// Loaded after the harness, which points DATABASE_URL at this worker's test
// database: `db.ts` reads the URL when it is first imported.
const { pool } = require('../../src/shared/database/db');

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const bulkUrl = (lawFirmId: string) =>
  `/api/lawfirms/${lawFirmId}/billing/time-entries/bulk-delete`;

/** A matter, with the given users staffed on it. */
async function seedMatter(lawFirmId: string, memberUids: string[] = []) {
  const id = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id, status)
     values ($1, $2, 'Bulk matter', $3, 'active')`,
    [id, lawFirmId, `REF-${id.slice(0, 8)}`],
  );
  for (const uid of memberUids) {
    // eslint-disable-next-line no-await-in-loop
    await testPool.query(
      `insert into matter_members (law_firm_id, matter_id, user_id) values ($1, $2, $3)`,
      [lawFirmId, id, uid],
    );
  }
  return id;
}

/** One unbilled time entry against a matter or a client. */
async function seedEntry(
  lawFirmId: string,
  where: { matterId?: string; clientId?: string },
  userId: string,
) {
  const id = randomUUID();
  await testPool.query(
    `insert into activities (kind, id, law_firm_id, matter_id, client_id, user_id,
                             activity_date, hours, name)
     values ('time', $1, $2, $3, $4, $5, current_date, 1.5, 'Bulk entry')`,
    [id, lawFirmId, where.matterId ?? null, where.clientId ?? null, userId],
  );
  return id;
}

/**
 * Put the entry onto an invoice as a LINE ITEM, which is what freezes it.
 *
 * The same fixture `timeEntries.test.ts` uses, and for the same reason: the
 * service asks `invoice_line_items`, so a fixture that set some flag on the
 * entry itself would produce a row the service considers unbilled and every
 * freeze assertion here would pass against an entry that was never frozen.
 */
async function billOntoInvoice(entryId: string, clientId: string) {
  const invoice = await createInvoice(firm.id, clientId, { totalCents: 37_500 });
  await testPool.query(
    `insert into invoice_line_items
       (invoice_id, law_firm_id, kind, source_id, quantity, rate_cents, amount_cents)
     values ($1, $2, 'time_entry', $3, 1.5, 25000, 37500)`,
    [invoice.id, firm.id, entryId],
  );
  return invoice;
}

const surviving = async (ids: string[]) => {
  const { rows } = await testPool.query(
    `select id from activities where kind = 'time' and id = any($1)`,
    [ids],
  );
  return new Set(rows.map((r: any) => r.id));
};

/**
 * Open idle connections up front. A cold pool spends longer dialing a new
 * connection than a local query takes, so a later query reuses a client an
 * earlier one already released and the real overlap never shows.
 */
async function warmPool(size: number) {
  const clients = await Promise.all(Array.from({ length: size }, () => pool.connect()));
  clients.forEach((c: any) => c.release());
}

/** Every pool checkout the request makes, which is one per query it runs. */
async function connectionsDuring(work: () => Promise<unknown>) {
  let acquired = 0;
  const onAcquire = () => { acquired += 1; };
  pool.on('acquire', onAcquire);
  try {
    const result = await work();
    return { result, acquired };
  } finally {
    pool.off('acquire', onAcquire);
  }
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Bulk Client' });
  await drainEvents();
});

describe('another firm cannot reach these entries', () => {
  it('deletes nothing when another firm owner sends this firm ids under their own firm', async () => {
    const matterId = await seedMatter(firm.id, [owner.uid]);
    const ids = [
      await seedEntry(firm.id, { matterId }, owner.uid),
      await seedEntry(firm.id, { clientId: client.id }, owner.uid),
    ];
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .post(bulkUrl(otherFirm.id))
      .send({ timeEntryIds: ids });

    // A well-formed request against a firm they really do own. The ids simply
    // are not theirs, so nothing matches and nothing goes.
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(0);
    expect(res.body.failed.sort()).toEqual([...ids].sort());
    expect(await surviving(ids)).toEqual(new Set(ids));
  });

  it('refuses another firm owner who sends this firm ids under THIS firm', async () => {
    const matterId = await seedMatter(firm.id, [owner.uid]);
    const ids = [await seedEntry(firm.id, { matterId }, owner.uid)];
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .post(bulkUrl(firm.id))
      .send({ timeEntryIds: ids });

    expect(res.status).toBe(403);
    expect(await surviving(ids)).toEqual(new Set(ids));
  });
});

describe('per-entry outcomes', () => {
  it('deletes what the caller may delete and reports the billed and the unreachable', async () => {
    const ownMatter = await seedMatter(firm.id, [owner.uid]);
    const foreignMatter = await seedMatter(firm.id, []);

    const deletable = await seedEntry(firm.id, { matterId: ownMatter }, owner.uid);
    const alsoDeletable = await seedEntry(firm.id, { clientId: client.id }, owner.uid);
    const billed = await seedEntry(firm.id, { clientId: client.id }, owner.uid);
    await billOntoInvoice(billed, client.id);
    const unreachable = await seedEntry(firm.id, { matterId: foreignMatter }, owner.uid);
    const missing = randomUUID();

    const res = await owner.api.post(bulkUrl(firm.id)).send({
      timeEntryIds: [deletable, alsoDeletable, billed, unreachable, missing],
    });

    expect(res.status).toBe(200);
    expect(res.body.requested).toBe(5);
    expect(res.body.deleted).toBe(2);
    expect(res.body.failed.sort()).toEqual([billed, unreachable, missing].sort());
    // The reason has to name WHY, not just that it failed: "on an invoice" is a
    // rule the user can act on, "no access" is not the same conversation.
    expect(res.body.errors[billed]).toMatch(/invoice/i);
    expect(res.body.errors[unreachable]).toMatch(/matter/i);
    expect(res.body.errors[missing]).toMatch(/not found/i);

    // The rows really are gone, and the refused ones really are still there.
    expect(await surviving([deletable, alsoDeletable, billed, unreachable]))
      .toEqual(new Set([billed, unreachable]));
  });

  it('leaves the invoice line item pointing at a row that still exists', async () => {
    const billed = await seedEntry(firm.id, { clientId: client.id }, owner.uid);
    const invoice = await billOntoInvoice(billed, client.id);

    await owner.api.post(bulkUrl(firm.id)).send({ timeEntryIds: [billed] });

    const { rows } = await testPool.query(
      `select li.source_id, a.id as entry_id
         from invoice_line_items li
         left join activities a on a.id::text = li.source_id
        where li.invoice_id = $1`,
      [invoice.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].entry_id).toBe(billed);
  });
});

describe('cost does not grow with the selection', () => {
  it('uses the same number of pool connections for 24 ids as for 2', async () => {
    const matterId = await seedMatter(firm.id, [owner.uid]);
    const small: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      small.push(await seedEntry(firm.id, { matterId }, owner.uid));
    }
    const large: string[] = [];
    for (let i = 0; i < 24; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      large.push(await seedEntry(firm.id, { matterId }, owner.uid));
    }
    await drainEvents();
    await warmPool(8);
    // A throwaway run first. The FIRST request of a spec also fills the token,
    // membership and permission caches, and counting that cold request against
    // a warm one would compare cache state rather than the id count.
    await owner.api.post(bulkUrl(firm.id)).send({ timeEntryIds: [randomUUID()] });
    await drainEvents();

    const smallRun = await connectionsDuring(() => owner.api
      .post(bulkUrl(firm.id)).send({ timeEntryIds: small }));
    await drainEvents();
    const largeRun = await connectionsDuring(() => owner.api
      .post(bulkUrl(firm.id)).send({ timeEntryIds: large }));
    await drainEvents();

    expect((smallRun.result as any).body.deleted).toBe(2);
    expect((largeRun.result as any).body.deleted).toBe(24);
    // The measurement is real only if the listener is on the pool the app uses.
    expect(smallRun.acquired).toBeGreaterThan(0);
    // Twelve times the ids, the same number of round trips. One query per id
    // would read 2 against 24.
    expect(largeRun.acquired).toBe(smallRun.acquired);
  });
});

describe('the id list is bounded', () => {
  it('refuses a list over the cap and deletes nothing', async () => {
    const matterId = await seedMatter(firm.id, [owner.uid]);
    const real = await seedEntry(firm.id, { matterId }, owner.uid);
    const filler = Array.from({ length: 1000 }, () => randomUUID());

    const res = await owner.api
      .post(bulkUrl(firm.id))
      .send({ timeEntryIds: [real, ...filler] });

    // Refused whole rather than quietly truncated: a caller handed a silent
    // subset would report a delete that never happened for the tail.
    expect(res.status).toBe(400);
    expect(await surviving([real])).toEqual(new Set([real]));
  });

  it('accepts a list at the cap', async () => {
    const matterId = await seedMatter(firm.id, [owner.uid]);
    const real = await seedEntry(firm.id, { matterId }, owner.uid);
    const filler = Array.from({ length: 999 }, () => randomUUID());

    const res = await owner.api
      .post(bulkUrl(firm.id))
      .send({ timeEntryIds: [real, ...filler] });

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);
    expect(await surviving([real]).then((s) => s.size)).toBe(0);
  });

  it('refuses an empty list', async () => {
    const res = await owner.api.post(bulkUrl(firm.id)).send({ timeEntryIds: [] });

    expect(res.status).toBe(400);
  });
});

describe('permissions', () => {
  it('refuses a member without billing.manageTimeEntries', async () => {
    const { createFirmMember, as, tokenFor } = require('../support/setupInProcess');
    const matterId = await seedMatter(firm.id, [owner.uid]);
    const id = await seedEntry(firm.id, { matterId }, owner.uid);
    const narrow = await createFirmMember(firm.id, { isOwner: false, permissions: [] });
    const narrowApi = as(tokenFor({ uid: narrow.uid }));

    const res = await narrowApi.post(bulkUrl(firm.id)).send({ timeEntryIds: [id] });

    expect(res.status).toBe(403);
    expect(await surviving([id])).toEqual(new Set([id]));
  });
});
