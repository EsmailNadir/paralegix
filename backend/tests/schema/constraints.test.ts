/**
 * Database-level guarantees: check constraints, generated money columns,
 * composite tenant foreign keys, and triggers for immutable ledger entries
 * and plan-column sync.
 *
 * Every case here talks to Postgres directly through `testPool`, deliberately
 * bypassing the application layer. A positive control that only proves the
 * SERVICE never sends a bad value is not proof the constraint itself works --
 * the schema is the last line of defense against a future caller that skips
 * the service (a script, a migration backfill, a different module). Each
 * `it` names the exact bad write it exists to catch; if that write ever stops
 * being rejected, this is the test that goes red.
 *
 * `db/schema.sql` is the source of truth; every constraint/trigger below is
 * cited by its schema.sql line number as of this writing so a future reader
 * can jump straight to the declaration.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  createPersonClient,
  createOrgClient,
  createInvoice,
  createTrustDeposit,
  type Firm,
} from '../support/setupInProcess';

/** Minimal matter row -- only the NOT NULL columns schema.sql actually requires. */
async function createMatter(lawFirmId: string, name = 'Test matter'): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id)
     values ($1, $2, $3, $4)`,
    [id, lawFirmId, name, `REF-${id.slice(0, 8)}`],
  );
  return id;
}

/** Minimal trust_accounts row, letting every check-constrained column default. */
async function createTrustAccount(lawFirmId: string, name = 'Test IOLTA'): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into trust_accounts (id, law_firm_id, name) values ($1, $2, $3)`,
    [id, lawFirmId, name],
  );
  return id;
}

/** A bare `users` row -- just enough to satisfy an FK, not a real member. */
async function createUserRow(): Promise<string> {
  const id = `user-${randomUUID().slice(0, 8)}`;
  await testPool.query(
    `insert into users (id, email) values ($1, $2)`,
    [id, `${id}@example.test`],
  );
  return id;
}

let firm: Firm;

beforeEach(async () => {
  firm = await createFirm();
});

// ---------------------------------------------------------------------------
// trust_transactions.amount_cents > 0  (schema.sql:1675)
// ---------------------------------------------------------------------------
describe('trust_transactions amount_cents check (schema.sql:1675)', () => {
  it('accepts a positive deposit amount', async () => {
    const accountId = await createTrustAccount(firm.id);
    const client = await createPersonClient(firm.id);
    const result = await testPool.query(
      `insert into trust_transactions
         (id, law_firm_id, trust_account_id, type, amount_cents, client_id, txn_date, status)
       values ($1, $2, $3, 'deposit', 500, $4, current_date, 'completed')
       returning amount_cents`,
      [randomUUID(), firm.id, accountId, client.id],
    );
    expect(result.rows[0].amount_cents).toBe('500');
  });

  it('rejects a zero-amount transaction -- a no-op ledger entry that would still post', async () => {
    const accountId = await createTrustAccount(firm.id);
    await expect(
      testPool.query(
        `insert into trust_transactions
           (id, law_firm_id, trust_account_id, type, amount_cents, txn_date, status)
         values ($1, $2, $3, 'deposit', 0, current_date, 'completed')`,
        [randomUUID(), firm.id, accountId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects a negative amount -- trust money can never post as negative cents', async () => {
    const accountId = await createTrustAccount(firm.id);
    await expect(
      testPool.query(
        `insert into trust_transactions
           (id, law_firm_id, trust_account_id, type, amount_cents, txn_date, status)
         values ($1, $2, $3, 'withdrawal', -100, current_date, 'completed')`,
        [randomUUID(), firm.id, accountId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

// ---------------------------------------------------------------------------
// trust_transactions composite tenant FK on trust_account_id (schema.sql:1716)
// ---------------------------------------------------------------------------
describe('trust_transactions composite tenant FK to trust_accounts (schema.sql:1716)', () => {
  it('accepts a transaction whose firm matches its trust account\'s firm', async () => {
    const accountId = await createTrustAccount(firm.id);
    const result = await testPool.query(
      `insert into trust_transactions
         (id, law_firm_id, trust_account_id, type, amount_cents, txn_date, status)
       values ($1, $2, $3, 'deposit', 100, current_date, 'completed')
       returning id`,
      [randomUUID(), firm.id, accountId],
    );
    expect(result.rowCount).toBe(1);
  });

  it('rejects a transaction naming another firm\'s trust account, even though the id alone exists', async () => {
    const otherFirm = await createFirm();
    const otherFirmAccountId = await createTrustAccount(otherFirm.id);
    // trust_account_id is a real, existing row -- just not one that belongs to
    // `firm`. A single-column FK would happily accept this and let firm A post
    // against firm B's trust account; the composite (law_firm_id, trust_account_id)
    // FK is what stops it.
    await expect(
      testPool.query(
        `insert into trust_transactions
           (id, law_firm_id, trust_account_id, type, amount_cents, txn_date, status)
         values ($1, $2, $3, 'deposit', 100, current_date, 'completed')`,
        [randomUUID(), firm.id, otherFirmAccountId],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

// ---------------------------------------------------------------------------
// trust_txn_immutable trigger (schema.sql:3055-3142)
// ---------------------------------------------------------------------------
describe('trust_txn_immutable trigger (schema.sql:3055-3142)', () => {
  it('allows updating the bank-clearing stamp on a completed entry', async () => {
    const client = await createPersonClient(firm.id);
    const { transactionId } = await createTrustDeposit(firm.id, client.id, { amountCents: 1000 });
    const result = await testPool.query(
      `update trust_transactions set cleared_at = now() where id = $1 returning cleared_at`,
      [transactionId],
    );
    expect(result.rows[0].cleared_at).not.toBeNull();
  });

  it('rejects editing the amount of a completed entry -- corrections must be reversing entries', async () => {
    const client = await createPersonClient(firm.id);
    const { transactionId } = await createTrustDeposit(firm.id, client.id, { amountCents: 1000 });
    await expect(
      testPool.query(`update trust_transactions set amount_cents = 2000 where id = $1`, [transactionId]),
    ).rejects.toThrow(/append-only/i);
  });

  it('rejects deleting a completed entry outright', async () => {
    const client = await createPersonClient(firm.id);
    const { transactionId } = await createTrustDeposit(firm.id, client.id, { amountCents: 1000 });
    await expect(
      testPool.query(`delete from trust_transactions where id = $1`, [transactionId]),
    ).rejects.toThrow(/append-only/i);
  });

  it('rejects resurrecting a voided entry back to completed', async () => {
    const client = await createPersonClient(firm.id);
    const { transactionId } = await createTrustDeposit(firm.id, client.id, { amountCents: 1000 });
    const voided = await testPool.query(
      `update trust_transactions
          set status = 'void', voided_at = now(), void_reason = 'test reversal'
        where id = $1 returning status`,
      [transactionId],
    );
    expect(voided.rows[0].status).toBe('void');

    await expect(
      testPool.query(`update trust_transactions set status = 'completed' where id = $1`, [transactionId]),
    ).rejects.toThrow(/immutable/i);
  });
});

// ---------------------------------------------------------------------------
// invoices.total_cents >= 0 (schema.sql:1187)
// ---------------------------------------------------------------------------
describe('invoices total_cents check (schema.sql:1187)', () => {
  it('accepts a non-negative total', async () => {
    const client = await createPersonClient(firm.id);
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 10000 });
    expect(invoice.totalCents).toBe(10000);
  });

  it('rejects a negative total -- a firm could otherwise bill a client negative money', async () => {
    const client = await createPersonClient(firm.id);
    await expect(
      testPool.query(
        `insert into invoices
           (id, law_firm_id, client_id, client_context_id, context_type, invoice_number, status, total_cents)
         values ($1, $2, $3, $3, 'client', $4, 'draft', -500)`,
        [randomUUID(), firm.id, client.id, `INV-${randomUUID().slice(0, 8)}`],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

// ---------------------------------------------------------------------------
// invoices XOR check: exactly one of matter_id / client_context_id (schema.sql:1259)
// ---------------------------------------------------------------------------
describe('invoices matter/client-context XOR check (schema.sql:1259)', () => {
  it('accepts a matter-scoped invoice (matter_id set, client_context_id null)', async () => {
    const matterId = await createMatter(firm.id);
    const result = await testPool.query(
      `insert into invoices (id, law_firm_id, matter_id, context_type, invoice_number, status, total_cents)
       values ($1, $2, $3, 'matter', $4, 'draft', 100)
       returning id`,
      [randomUUID(), firm.id, matterId, `INV-${randomUUID().slice(0, 8)}`],
    );
    expect(result.rowCount).toBe(1);
  });

  it('accepts a client-scoped invoice (client_context_id set, matter_id null)', async () => {
    const client = await createPersonClient(firm.id);
    const invoice = await createInvoice(firm.id, client.id);
    expect(invoice.id).toBeTruthy();
  });

  it('rejects an invoice naming BOTH a matter and a client context', async () => {
    const matterId = await createMatter(firm.id);
    const client = await createPersonClient(firm.id);
    await expect(
      testPool.query(
        `insert into invoices
           (id, law_firm_id, matter_id, client_context_id, context_type, invoice_number, status, total_cents)
         values ($1, $2, $3, $4, 'matter', $5, 'draft', 100)`,
        [randomUUID(), firm.id, matterId, client.id, `INV-${randomUUID().slice(0, 8)}`],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects an invoice naming NEITHER a matter nor a client context', async () => {
    await expect(
      testPool.query(
        `insert into invoices (id, law_firm_id, context_type, invoice_number, status, total_cents)
         values ($1, $2, 'client', $3, 'draft', 100)`,
        [randomUUID(), firm.id, `INV-${randomUUID().slice(0, 8)}`],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

// ---------------------------------------------------------------------------
// invoices_number_unique_idx: unique per firm, NOT unique globally (schema.sql:1263-1265)
// ---------------------------------------------------------------------------
describe('invoices invoice_number tenant-scoped uniqueness (schema.sql:1263-1265)', () => {
  it('rejects a duplicate invoice_number within the SAME firm', async () => {
    const client = await createPersonClient(firm.id);
    await createInvoice(firm.id, client.id, { invoiceNumber: 'DUP-0001' });
    await expect(
      createInvoice(firm.id, client.id, { invoiceNumber: 'DUP-0001' }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('accepts the SAME invoice_number reused in a DIFFERENT firm -- proves the index is tenant-scoped, not global', async () => {
    const otherFirm = await createFirm();
    const client = await createPersonClient(firm.id);
    const otherClient = await createPersonClient(otherFirm.id);
    await createInvoice(firm.id, client.id, { invoiceNumber: 'SHARED-0001' });
    const second = await createInvoice(otherFirm.id, otherClient.id, { invoiceNumber: 'SHARED-0001' });
    expect(second.id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// invoices.balance_due_cents generated column (schema.sql:1196)
// ---------------------------------------------------------------------------
describe('invoices.balance_due_cents generated column (schema.sql:1196)', () => {
  it('computes total - paid - written_off automatically', async () => {
    const client = await createPersonClient(firm.id);
    const id = randomUUID();
    await testPool.query(
      `insert into invoices
         (id, law_firm_id, client_id, client_context_id, context_type, invoice_number, status,
          total_cents, amount_paid_cents, total_written_off_cents)
       values ($1, $2, $3, $3, 'client', $4, 'outstanding', 1000, 300, 200)`,
      [id, firm.id, client.id, `INV-${randomUUID().slice(0, 8)}`],
    );
    const result = await testPool.query(`select balance_due_cents from invoices where id = $1`, [id]);
    expect(result.rows[0].balance_due_cents).toBe('500');
  });

  it('rejects an explicit write to the generated column -- proves the app cannot desync it from the inputs', async () => {
    const client = await createPersonClient(firm.id);
    await expect(
      testPool.query(
        `insert into invoices
           (id, law_firm_id, client_id, client_context_id, context_type, invoice_number, status,
            total_cents, balance_due_cents)
         values ($1, $2, $3, $3, 'client', $4, 'outstanding', 1000, 999)`,
        [randomUUID(), firm.id, client.id, `INV-${randomUUID().slice(0, 8)}`],
      ),
    ).rejects.toThrow(/non-DEFAULT value into column "balance_due_cents"/i);
  });
});

// ---------------------------------------------------------------------------
// time_entries.amount_cents generated column (schema.sql:1316)
// ---------------------------------------------------------------------------
describe('time_entries.amount_cents generated column (schema.sql:1316)', () => {
  it('computes round(hours * rate_cents), not a truncation', async () => {
    const matterId = await createMatter(firm.id);
    // 0.33 * 333 = 109.89 -- a non-half value, so this pins ROUNDING specifically
    // (round-to-nearest), not merely floor/truncate, which would wrongly give 109.
    const result = await testPool.query(
      `insert into activities (kind, id, law_firm_id, matter_id, activity_date, hours, rate_cents)
       values ('time', $1, $2, $3, current_date, 0.33, 333)
       returning amount_cents`,
      [randomUUID(), firm.id, matterId],
    );
    expect(result.rows[0].amount_cents).toBe('110');
  });

  it('is zero when no explicit rate_cents is recorded (resolved-rate entries are NOT priced here)', async () => {
    const matterId = await createMatter(firm.id);
    const result = await testPool.query(
      `insert into activities (kind, id, law_firm_id, matter_id, activity_date, hours)
       values ('time', $1, $2, $3, current_date, 5)
       returning amount_cents`,
      [randomUUID(), firm.id, matterId],
    );
    expect(result.rows[0].amount_cents).toBe('0');
  });

  it('rejects negative hours', async () => {
    const matterId = await createMatter(firm.id);
    await expect(
      testPool.query(
        `insert into activities (kind, id, law_firm_id, matter_id, activity_date, hours)
         values ('time', $1, $2, $3, current_date, -1)`,
        [randomUUID(), firm.id, matterId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects negative rate_cents', async () => {
    const matterId = await createMatter(firm.id);
    await expect(
      testPool.query(
        `insert into activities (kind, id, law_firm_id, matter_id, activity_date, hours, rate_cents)
         values ('time', $1, $2, $3, current_date, 1, -50)`,
        [randomUUID(), firm.id, matterId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

// ---------------------------------------------------------------------------
// time_entries XOR check: exactly one of matter_id / client_id (schema.sql:1342)
// ---------------------------------------------------------------------------
describe('time_entries matter/client XOR check (schema.sql:1342)', () => {
  it('accepts a matter-billed entry (matter_id set, client_id null)', async () => {
    const matterId = await createMatter(firm.id);
    const result = await testPool.query(
      `insert into activities (kind, id, law_firm_id, matter_id, activity_date, hours)
       values ('time', $1, $2, $3, current_date, 1) returning id`,
      [randomUUID(), firm.id, matterId],
    );
    expect(result.rowCount).toBe(1);
  });

  it('accepts a client-billed entry (client_id set, matter_id null)', async () => {
    const client = await createPersonClient(firm.id);
    const result = await testPool.query(
      `insert into activities (kind, id, law_firm_id, client_id, activity_date, hours)
       values ('time', $1, $2, $3, current_date, 1) returning id`,
      [randomUUID(), firm.id, client.id],
    );
    expect(result.rowCount).toBe(1);
  });

  it('rejects a time entry with NEITHER a matter nor a client -- unattributable billable time', async () => {
    await expect(
      testPool.query(
        `insert into activities (kind, id, law_firm_id, activity_date, hours)
         values ('time', $1, $2, current_date, 1)`,
        [randomUUID(), firm.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects a time entry naming BOTH a matter and a client', async () => {
    const matterId = await createMatter(firm.id);
    const client = await createPersonClient(firm.id);
    await expect(
      testPool.query(
        `insert into activities (kind, id, law_firm_id, matter_id, client_id, activity_date, hours)
         values ('time', $1, $2, $3, $4, current_date, 1)`,
        [randomUUID(), firm.id, matterId, client.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

// ---------------------------------------------------------------------------
// clients.client_type: immutable after insert (schema.sql:298, 308-319)
// and clients_company_no_user_id_check (schema.sql:303)
// ---------------------------------------------------------------------------
describe('clients.client_type immutability and company/user_id exclusivity (schema.sql:298-319)', () => {
  it('allows updating an unrelated column on a client', async () => {
    const client = await createPersonClient(firm.id, { name: 'Original Name' });
    const result = await testPool.query(
      `update clients set name = 'Renamed' where id = $1 returning name`,
      [client.id],
    );
    expect(result.rows[0].name).toBe('Renamed');
  });

  it('rejects changing client_type from person to company on an existing row', async () => {
    const client = await createPersonClient(firm.id);
    await expect(
      testPool.query(`update clients set client_type = 'company' where id = $1`, [client.id]),
    ).rejects.toThrow(/immutable/i);
  });

  it('rejects changing client_type from company to person on an existing row', async () => {
    const org = await createOrgClient(firm.id);
    await expect(
      testPool.query(`update clients set client_type = 'person' where id = $1`, [org.id]),
    ).rejects.toThrow(/immutable/i);
  });

  it('accepts a company client with no user_id (an org never signs in directly)', async () => {
    const org = await createOrgClient(firm.id);
    expect(org.id).toBeTruthy();
  });

  it('rejects a company client carrying a user_id -- a company must never sign in directly', async () => {
    const userId = await createUserRow();
    await expect(
      testPool.query(
        `insert into clients (id, law_firm_id, name, client_type, user_id)
         values ($1, $2, 'Bad Org', 'company', $3)`,
        [randomUUID(), firm.id, userId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

// ---------------------------------------------------------------------------
// law_firms.plan_id / billing_status are authoritative (migration 0200)
// ---------------------------------------------------------------------------
describe('law_firms plan columns are authoritative, not a mirror (migration 0200)', () => {
  // Until 0200 a BEFORE INSERT OR UPDATE trigger, law_firms_sync_plan_columns(),
  // copied plan->>'planId' and plan->>'billingStatus' into the typed columns, so
  // the same two facts lived in two places and a writer could set either one.
  // 0200 deleted the trigger and its function and stripped both keys out of the
  // jsonb; lawfirms.repository now routes them to the columns on every write.
  //
  // These cases pin the DIRECTION of that decision by behaviour rather than by
  // catalog name: restoring the trigger, under any name, to make some other
  // fixture pass turns them red, which is the point.

  it('leaves the columns alone when the jsonb is written directly', async () => {
    // The positive control first: prove the row really is the one being written
    // and that the columns hold a known value going in. Without this the
    // assertion below would pass just as happily against a row that was never
    // touched.
    const before = await testPool.query(
      `update law_firms
          set plan_id = 'starter', billing_status = 'comped'
        where id = $1
        returning plan_id, billing_status`,
      [firm.id],
    );
    expect(before.rows[0]).toEqual({ plan_id: 'starter', billing_status: 'comped' });

    const after = await testPool.query(
      `update law_firms
          set plan = '{"planId":"professional","billingStatus":"active"}'::jsonb
        where id = $1
        returning plan_id, billing_status, plan`,
      [firm.id],
    );
    // The jsonb write landed...
    expect(after.rows[0].plan).toMatchObject({ planId: 'professional', billingStatus: 'active' });
    // ...and moved neither column. A mirror trigger would have made both
    // 'professional' / 'active'.
    expect(after.rows[0].plan_id).toBe('starter');
    expect(after.rows[0].billing_status).toBe('comped');
  });

  it('still constrains billing_status to the column vocabulary', async () => {
    // Dropping the trigger did not drop the CHECK. The legacy spellings the
    // trigger used to translate ('trial', 'unpaid') are NOT column values, and
    // normalizing them is now the repository's job -- see the mergePlan cases in
    // tests/lawfirms/lawfirmsServiceOps.test.ts. A raw write of one must be
    // rejected rather than silently stored.
    await expect(
      testPool.query(
        `update law_firms set billing_status = 'trial' where id = $1`,
        [firm.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

// ---------------------------------------------------------------------------
// conversations composite tenant FK on client_record_id (schema.sql:2561)
// ---------------------------------------------------------------------------
describe('conversations composite tenant FK to clients on client_record_id (schema.sql:2561)', () => {
  // This is the one FK in the file deliberately given NO on-delete action
  // (schema.sql's own comment above the column: "the default RESTRICT blocks
  // deleting a company client with a live canonical conversation"), and
  // clients.service.removeClient relies on that as a backstop -- its own
  // comment says archiving first "severs the archived row's client_record_id
  // itself so the FK no longer blocks the delete", which only means anything
  // if the FK actually exists. Every other FK pointing at clients/users in
  // this file is a deliberate SOFT reference, stripped by the whole-schema
  // sweep at the foot of schema.sql (confrelid in ('users','clients')) so a
  // historical/orphaned id is never rejected on insert. That sweep has no way
  // to tell "soft reference" apart from "this one row is the actual guard",
  // so it must name this single constraint to spare it.
  async function createCanonicalCompanyConversation(lawFirmId: string, clientRecordId: string) {
    await testPool.query(
      `insert into conversations (id, law_firm_id, conversation_type, client_record_id)
       values ($1, $2, 'group', $3)`,
      [randomUUID(), lawFirmId, clientRecordId],
    );
  }

  it('accepts a canonical conversation whose client_record_id names a real client in the same firm', async () => {
    const org = await createOrgClient(firm.id);
    await createCanonicalCompanyConversation(firm.id, org.id);
    const result = await testPool.query(
      `select 1 from conversations where law_firm_id = $1 and client_record_id = $2`,
      [firm.id, org.id],
    );
    expect(result.rowCount).toBe(1);
  });

  it('rejects deleting a company client while its canonical conversation still references it', async () => {
    const org = await createOrgClient(firm.id);
    await createCanonicalCompanyConversation(firm.id, org.id);

    // No app-layer guard runs here on purpose -- this proves the DATABASE
    // itself refuses the delete, not just clients.service.removeClient's own
    // findCanonicalCompanyConversation pre-check. A future caller that
    // reaches `clients` directly (a script, a bulk admin tool, a different
    // module) must hit the same wall.
    await expect(
      testPool.query(`delete from clients where id = $1`, [org.id]),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects a conversation naming another firm\'s client, even though the id alone exists', async () => {
    const otherFirm = await createFirm();
    const otherOrg = await createOrgClient(otherFirm.id);
    // otherOrg.id is a real, existing client row -- just not one that belongs
    // to `firm`. A single-column FK would accept this and let firm A's
    // conversation point at firm B's client; the composite
    // (law_firm_id, client_record_id) FK is what stops it.
    await expect(
      testPool.query(
        `insert into conversations (id, law_firm_id, conversation_type, client_record_id)
         values ($1, $2, 'group', $3)`,
        [randomUUID(), firm.id, otherOrg.id],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

// ---------------------------------------------------------------------------
// legal_holds delete guard (migration 0221)
// ---------------------------------------------------------------------------
describe('legal hold blocks a delete at the database, not only in the service', () => {
  /**
   * The point of the trigger, stated as the failure it prevents.
   *
   * A legal hold used to be four columns on the row plus a check in each delete
   * path. That works for every path that remembers. A fifth path, a script or a
   * backfill does not, and the failure is silent: the evidence a firm believed it
   * was preserving is gone and nothing records that a hold was bypassed.
   *
   * These cases delete DIRECTLY through the pool, bypassing every service, which
   * is exactly the caller the service check cannot cover.
   *
   * WHAT MAKES THEM GO RED: dropping the trigger, or letting a released hold keep
   * blocking (which would strand a record forever, the opposite failure).
   */
  it('refuses to delete a matter under an unreleased hold', async () => {
    const matterId = await createMatter(firm.id, 'Held matter');
    await testPool.query(
      `insert into legal_holds (law_firm_id, matter_id, reason) values ($1, $2, 'Active litigation')`,
      [firm.id, matterId],
    );

    await expect(
      testPool.query('delete from matters where id = $1', [matterId]),
    ).rejects.toThrow(/legal hold/i);

    const { rows } = await testPool.query('select 1 from matters where id = $1', [matterId]);
    expect(rows).toHaveLength(1);
  });

  it('allows the delete once the hold is released', async () => {
    const matterId = await createMatter(firm.id, 'Released matter');
    await testPool.query(
      `insert into legal_holds (law_firm_id, matter_id, reason) values ($1, $2, 'Closed matter')`,
      [firm.id, matterId],
    );
    // Released, not deleted: the row stays as the record of what was held.
    await testPool.query(
      `update legal_holds set released_at = now() where matter_id = $1`, [matterId],
    );

    await testPool.query('delete from matters where id = $1', [matterId]);

    const { rows } = await testPool.query('select 1 from matters where id = $1', [matterId]);
    expect(rows).toHaveLength(0);
  });

  it('holds one matter without blocking another in the same firm', async () => {
    const held = await createMatter(firm.id, 'Held');
    const free = await createMatter(firm.id, 'Free');
    await testPool.query(
      `insert into legal_holds (law_firm_id, matter_id) values ($1, $2)`, [firm.id, held],
    );

    // A guard that refused everything would pass the first case and be useless.
    await testPool.query('delete from matters where id = $1', [free]);
    await expect(
      testPool.query('delete from matters where id = $1', [held]),
    ).rejects.toThrow(/legal hold/i);
  });
});
