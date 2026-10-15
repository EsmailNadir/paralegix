/**
 * Three surfaces of the invoice service that change an invoice without changing
 * what it is worth, and one that removes it entirely.
 *
 * DELETING an invoice is the only irreversible money action a firm can take on
 * one. It has to refuse when the trust ledger points at the invoice, because the
 * ledger's FK nulls on delete and the append-only trigger rejects that update on
 * a completed or void entry; without the guard the request dies on a raw trigger
 * error with the ledger half-written.
 *
 * EDITING THE DETAILS rewrites the face of the bill: its name, its number, its
 * dates, the remit-to block. None of it touches money, which is exactly why a
 * bug here is invisible. An edit that silently blanks a field it was not asked
 * about, or that lets two invoices in one firm share a number, produces an
 * invoice that is perfectly consistent with itself and wrong against the books.
 *
 * REMINDER SETTINGS look like preferences, but the pre-due path rewrites the
 * WHOLE payment-plan object to reset the per-installment "already reminded"
 * markers. A rewrite that loses an amount or a date changes what the client is
 * asked to pay, from a request that only meant to change a notification.
 *
 * `invoiceLifecycle.test.ts` covers the ordinary delete of an unencumbered
 * invoice; `invoiceLineItemEdits.test.ts` covers edits that DO move money.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let invoiceId: string;

const B = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;
const onInvoice = (suffix = '') => `${B()}/${invoiceId}${suffix}`;

/** The face of the invoice: everything the details edit can reach, plus the money it must not. */
async function faceOf(id = invoiceId) {
  const { rows } = await testPool.query(
    `select i.invoice_name, i.invoice_number, i.invoice_date, i.due_date, i.remit_to,
            i.total_cents, i.amount_paid_cents, i.balance_due_cents,
            coalesce(r.is_opted_out, false) as reminder_opt_out,
            r.pre_due_days                  as pre_due_reminder_days,
            r.pre_due_sent_at               as pre_due_reminder_sent_at,
            i.plan_pre_reminder_days
       from invoices i
       left join reminders r on r.invoice_id = i.id
      where i.id = $1`,
    [id],
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function invoiceCount(lawFirmId = firm.id) {
  const { rows } = await testPool.query(
    'select count(*)::int c from invoices where law_firm_id = $1',
    [lawFirmId],
  );
  return rows[0].c;
}

/** The payment-plan header columns, which live on the invoice row itself. */
async function planHeader(id = invoiceId) {
  const { rows } = await testPool.query(
    `select payment_plan_enabled, plan_installment_cents, plan_frequency_days,
            plan_start_date, plan_regular_start_date, plan_down_payment_cents
       from invoices where id = $1`,
    [id],
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function installments(id = invoiceId) {
  const { rows } = await testPool.query(
    `select amount_cents, due_date, status, pre_due_reminder_sent_at
       from invoice_expected_payments where invoice_id = $1 order by sort_order`,
    [id],
  );
  return rows;
}

/**
 * A trust ledger entry pointing at the invoice.
 *
 * Seeded straight into the table: `trust_transactions` is append-only by
 * database trigger, so a fixture that tried to reach a given status through the
 * trust service would be posting reversing entries to get there.
 */
async function seedTrustEntryForInvoice(status: 'completed' | 'void' | 'pending') {
  const accountId = randomUUID();
  const txnId = randomUUID();
  await testPool.query(
    `insert into trust_accounts (id, law_firm_id, name, account_type, status, book_balance_cents)
     values ($1, $2, 'Ledger IOLTA', 'iolta', 'active', 500000)`,
    [accountId, firm.id],
  );
  const res = await testPool.query(
    `insert into trust_transactions
       (id, law_firm_id, trust_account_id, type, amount_cents, client_id, invoice_id,
        txn_date, description, status)
     values ($1, $2, $3, 'withdrawal', 20000, $4, $5, current_date, 'Paid from trust', $6)
     returning id`,
    [txnId, firm.id, accountId, client.id, invoiceId, status],
  );
  expect(res.rowCount).toBe(1);
  return txnId;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Delia Client' });

  const created = await owner.api.post(B()).send({
    invoiceName: 'Original Name',
    invoiceNumber: 'ORIG-100',
    invoiceDate: '2026-03-01',
    dueDate: '2026-03-31',
    totalAmount: 1000,
    flatFeesAmount: 1000,
    flatFees: [{ description: 'Fixed fee', amount: 1000 }],
  });
  expect(created.status).toBe(201);
  invoiceId = created.body.invoice.id;
  await drainEvents();
});

describe('deleting an invoice the trust ledger points at', () => {
  it('refuses while a COMPLETED trust entry references it', async () => {
    await seedTrustEntryForInvoice('completed');

    const res = await owner.api.delete(onInvoice());

    expect(res.status).toBe(409);
    // The refusal is only meaningful if the invoice is still there: a 409 from a
    // delete that had already run would read identically.
    expect(await invoiceCount()).toBe(1);
  });

  it('refuses while a VOID trust entry references it', async () => {
    // A void entry still carries invoice_id, and void rows are the most
    // immutable of all, so this is the case a status filter narrowed to
    // 'completed' would wave through into a raw trigger error.
    await seedTrustEntryForInvoice('void');

    const res = await owner.api.delete(onInvoice());

    expect(res.status).toBe(409);
    expect(await invoiceCount()).toBe(1);
  });

  it('refuses to delete an invoice paid through Stripe, and points at the two ways out', async () => {
    // The reversal handlers find the payment by its PaymentIntent id. Delete the
    // row and a later refund or dispute finds nothing: Stripe returns the money
    // while the firm's A/R still counts it as collected.
    await testPool.query(
      `insert into invoice_payments (invoice_id, law_firm_id, amount_cents, payment_date, payment_source, stripe_payment_intent_id, sort_order)
       values ($1, $2, 50000, current_date, 'stripe', 'pi_collected', 0)`,
      [invoiceId, firm.id],
    );

    const res = await owner.api.delete(onInvoice());

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/refund the payment in stripe/i);
    expect(res.body.error).toMatch(/void the invoice/i);
    expect(await invoiceCount()).toBe(1);
  });

  it('still deletes an invoice whose only payment the firm recorded by hand', async () => {
    // Unchanged, and deliberately so: a manual payment is the firm's own
    // bookkeeping, with no second system holding a record of it.
    const paid = await owner.api.put(onInvoice('/payment')).send({ paymentAmount: 1000 });
    expect(paid.status).toBe(200);

    expect((await owner.api.delete(onInvoice())).status).toBe(200);
    expect(await invoiceCount()).toBe(0);
  });

  it('deletes when the only referencing entry is PENDING', async () => {
    await seedTrustEntryForInvoice('pending');

    const res = await owner.api.delete(onInvoice());

    expect(res.status).toBe(200);
    expect(await invoiceCount()).toBe(0);
  });

  it('refuses BEFORE any trust compensation could run, which is why none is attempted', async () => {
    // A trust-funded payment always writes its withdrawal with `invoice_id` set,
    // so the permanent-entry guard sees it and refuses. The delete path therefore
    // has no trust work to compensate for, and the entry is left exactly as it
    // was. The helper that reverses withdrawals stays for the two paths that
    // remove a payment WITHOUT deleting the invoice.
    const txnId = await seedTrustEntryForInvoice('completed');

    const res = await owner.api.delete(onInvoice());

    expect(res.status).toBe(409);
    const { rows } = await testPool.query(
      'select status, void_reason from trust_transactions where id = $1', [txnId],
    );
    expect(rows[0].status).toBe('completed');
    expect(rows[0].void_reason).toBeNull();
  });

  it('leaves a recorded payment intact when it refuses', async () => {
    const paid = await owner.api.put(onInvoice('/payment')).send({ paymentAmount: 400 });
    expect(paid.status).toBe(200);
    await seedTrustEntryForInvoice('completed');

    const res = await owner.api.delete(onInvoice());
    expect(res.status).toBe(409);

    // The guard runs before anything is torn down. A refusal that had already
    // reversed the payments would leave a live invoice with its money gone.
    const { rows } = await testPool.query(
      'select amount_cents from invoice_payments where invoice_id = $1',
      [invoiceId],
    );
    expect(rows.map((r: any) => Number(r.amount_cents))).toEqual([40_000]);
    expect(Number((await faceOf()).amount_paid_cents)).toBe(40_000);
  });

  it('names the trust ledger as the reason, so the firm knows to void instead', async () => {
    await seedTrustEntryForInvoice('completed');

    const res = await owner.api.delete(onInvoice());

    // The behaviour here is the explanation, not the status: a bare 409 leaves a
    // firm with no way to tell this apart from any other conflict.
    expect(String(res.body.error || res.body.message)).toMatch(/trust/i);
  });

  it('does not let one firm delete another firm invoice', async () => {
    const otherFirm = await createFirm({ name: 'Other Firm' });
    const otherOwner = await ownerOf(otherFirm.id);
    const otherClient = await createPersonClient(otherFirm.id, { name: 'Outsider' });

    const res = await otherOwner.api.delete(
      `/api/lawfirms/${otherFirm.id}/billing/invoices/client/${otherClient.id}/${invoiceId}`,
    );

    expect(res.status).toBe(404);
    expect(await invoiceCount()).toBe(1);
  });
});

/**
 * M11: everything an unencumbered delete has to clean up or release, beyond
 * the trust-ledger refusal covered above.
 */
describe('what deleting an invoice releases and cleans up', () => {
  it('removes every payment-plan installment row, leaving none behind', async () => {
    const plan = await owner.api.post(onInvoice('/payment-plan')).send({
      installmentAmount: 250, frequencyDays: 30, planStartDate: '2026-04-01',
    });
    expect(plan.status).toBe(200);
    expect(await installments()).toHaveLength(4);

    const res = await owner.api.delete(onInvoice());
    expect(res.status).toBe(200);

    // Not just "the invoice is gone" - the child rows have to go WITH it, or
    // they sit in the table as installments belonging to no invoice, ready to
    // surface as a phantom "amount due" on any report that reads them without
    // rejoining to a now-nonexistent invoice.
    expect(await installments()).toEqual([]);
  });

  it('removes an attached credit note, not just the invoice it discounted', async () => {
    const credit = await owner.api.post(onInvoice('/credit-note'))
      .send({ amount: 250, type: 'discount', description: 'Goodwill' });
    expect([200, 201]).toContain(credit.status);

    const res = await owner.api.delete(onInvoice());
    expect(res.status).toBe(200);

    const { rows } = await testPool.query(
      "select count(*)::int c from invoice_adjustments where invoice_id = $1 and direction = 'credit'", [invoiceId],
    );
    expect(rows[0].c).toBe(0);
  });

  it('does not block deletion of a MANUALLY paid invoice, and removes its payment record with it', async () => {
    // No trust entry here at all - a plain, directly recorded payment. Unlike
    // the trust-ledger cases above (a permanent, append-only record), this is
    // the only kind of "already paid" the delete route does not refuse: the
    // guard is specifically about the trust ledger's own immutability, not
    // about the invoice's paid state in general.
    const paid = await owner.api.put(onInvoice('/payment')).send({ paymentAmount: 1000 });
    expect(paid.status).toBe(200);
    expect(Number((await faceOf()).amount_paid_cents)).toBe(100_000);

    const res = await owner.api.delete(onInvoice());

    expect(res.status).toBe(200);
    expect(await invoiceCount()).toBe(0);
    const { rows } = await testPool.query(
      'select count(*)::int c from invoice_payments where invoice_id = $1', [invoiceId],
    );
    expect(rows[0].c).toBe(0);
  });

  describe('source rebilling eligibility', () => {
    /** A matter, with `owner` on it so the write path's membership check passes. */
    async function seedMatter(name: string) {
      const id = randomUUID();
      await testPool.query(
        `insert into matters (id, law_firm_id, name, matter_reference_id, status)
         values ($1, $2, $3, $4, 'active')`,
        [id, firm.id, name, `REF-${id.slice(0, 8)}`],
      );
      await testPool.query(
        `insert into matter_members (matter_id, user_id, law_firm_id, role, joined_at)
         values ($1, $2, $3, 'lead', now())`,
        [id, owner.uid, firm.id],
      );
      await testPool.query(
        `insert into matter_clients (matter_id, client_id, law_firm_id) values ($1, $2, $3)`,
        [id, client.id, firm.id],
      );
      return id;
    }

    /** rate_cents is explicit so the amount does not depend on rate resolution. */
    async function seedTimeEntry(matterId: string, hours: number, rateCents: number) {
      const id = randomUUID();
      await testPool.query(
        `insert into activities (kind, id, law_firm_id, matter_id, user_id, activity_date, hours, rate_cents, description, billable)
         values ('time', $1, $2, $3, $4, date '2026-03-10', $5, $6, 'Rebillable work', true)`,
        [id, firm.id, matterId, owner.uid, hours, rateCents],
      );
      return id;
    }

    async function unbilledSummary(matterId: string) {
      const res = await owner.api.get(`/api/lawfirms/${firm.id}/billing/invoices/matter/${matterId}/unbilled-summary`);
      expect(res.status).toBe(200);
      return res.body;
    }

    it('returns a deleted invoice\'s time entry to unbilled, at its full original hours and amount', async () => {
      const matterId = await seedMatter('Rebill Matter');
      // 2h at $154.67 = $309.34 exactly, so the assertion below is not hiding a
      // rounding coincidence.
      const timeEntryId = await seedTimeEntry(matterId, 2, 15_467);

      // Confirm it starts out billable.
      const before = await unbilledSummary(matterId);
      expect(before.unbilledTimeEntries.map((e: any) => e.id)).toContain(timeEntryId);

      const created = await owner.api.post(`/api/lawfirms/${firm.id}/billing/invoices`).send({
        matterId,
        invoiceName: 'Rebill Invoice',
        invoiceDate: '2026-03-15',
        timeEntries: [{ id: timeEntryId, hours: 2, amount: 309.34 }],
        totalAmount: 309.34,
        totalHours: 2,
      });
      expect(created.status).toBe(201);
      const rebillInvoiceId = created.body.invoice.id;

      // Gone from unbilled while the invoice holds it.
      const during = await unbilledSummary(matterId);
      expect(during.unbilledTimeEntries.map((e: any) => e.id)).not.toContain(timeEntryId);

      const del = await owner.api.delete(
        `/api/lawfirms/${firm.id}/billing/invoices/matter/${matterId}/${rebillInvoiceId}`,
      );
      expect(del.status).toBe(200);

      // THE ASSERTION THAT MATTERS: back in the unbilled pool, at the SAME hours
      // and amount it was billed at - not silently dropped (which would let
      // billable time evaporate) and not doubled (which would let it be billed
      // twice for more than the work was ever worth).
      const after = await unbilledSummary(matterId);
      const entry = after.unbilledTimeEntries.find((e: any) => e.id === timeEntryId);
      expect(entry).toBeTruthy();
      expect(entry.hours).toBe(2);
      expect(entry.amount).toBeCloseTo(309.34, 2);
      expect(after.unbilledTimeEntries.filter((e: any) => e.id === timeEntryId)).toHaveLength(1);
    });
  });
});

describe('rewriting the face of an invoice', () => {
  const patchDetails = (body: Record<string, unknown>) =>
    owner.api.patch(onInvoice('/details')).send(body);

  it('renames it', async () => {
    const res = await patchDetails({ invoiceName: 'Renamed' });

    expect(res.status).toBe(200);
    expect((await faceOf()).invoice_name).toBe('Renamed');
  });

  it('moves the due date', async () => {
    const res = await patchDetails({ dueDate: '2026-05-15' });

    expect(res.status).toBe(200);
    expect(String((await faceOf()).due_date)).toContain('2026-05-15');
  });

  it('leaves every field it was not sent exactly as it was', async () => {
    const before = await faceOf();

    // Only the invoice date is sent. Everything else on the face of the bill has
    // to survive untouched: the service applies each field only when its key is
    // present, and a guard that stopped checking presence would silently blank
    // the due date, the name or the number on an edit that never mentioned them.
    // A cleared due date is the worst of the three, because it does not look
    // wrong anywhere: the invoice simply stops being overdue and drops out of
    // every collections list the firm works from.
    const res = await patchDetails({ invoiceDate: '2026-04-01' });
    expect(res.status).toBe(200);

    const after = await faceOf();
    expect(String(after.invoice_date)).toContain('2026-04-01');
    expect(after.invoice_name).toBe(before.invoice_name);
    expect(after.invoice_number).toBe(before.invoice_number);
    expect(String(after.due_date)).toBe(String(before.due_date));
    expect(after.due_date).not.toBeNull();
  });

  describe('once the invoice has been issued', () => {
    beforeEach(async () => {
      await testPool.query('update invoices set billing_snapshot_at = now() where id = $1', [invoiceId]);
    });

    it('freezes the number and the invoice date, which the client holds a copy of', async () => {
      const before = await faceOf();
      expect((await patchDetails({ invoiceNumber: 'INV-CHANGED' })).status).toBe(409);
      expect((await patchDetails({ invoiceDate: '2026-04-01' })).status).toBe(409);
      const after = await faceOf();
      expect(after.invoice_number).toBe(before.invoice_number);
      expect(String(after.invoice_date)).toBe(String(before.invoice_date));
    });

    it('still lets the firm rename it and extend its due date', async () => {
      expect((await patchDetails({ invoiceName: 'Renamed after issue' })).status).toBe(200);
      expect((await patchDetails({ dueDate: '2026-06-30' })).status).toBe(200);
      const after = await faceOf();
      expect(after.invoice_name).toBe('Renamed after issue');
      expect(String(after.due_date)).toContain('2026-06-30');
    });

    /**
     * The details form resends every field on Save, frozen ones included. A
     * frozen value that equals the stored one is not a change, so it must not
     * block the edits the firm IS allowed to make. RED IF the freeze keys on the
     * presence of a field rather than on a different value.
     */
    describe('when the edit form resends the frozen values unchanged', () => {
      const REMIT = { name: 'Firm Trust', address: '1 Main St', city: 'Austin', state: 'TX', zip: '78701' };

      beforeEach(async () => {
        await testPool.query('update invoices set billing_snapshot_at = null where id = $1', [invoiceId]);
        expect((await patchDetails({ remitTo: REMIT })).status).toBe(200);
        await testPool.query('update invoices set billing_snapshot_at = now() where id = $1', [invoiceId]);
      });

      it('saves a new name and due date', async () => {
        const res = await patchDetails({
          invoiceName: 'Renamed after issue',
          invoiceNumber: 'ORIG-100',
          invoiceDate: '2026-03-01',
          dueDate: '2026-06-30',
          remitTo: REMIT,
        });

        expect(res.status).toBe(200);
        const after = await faceOf();
        expect(after.invoice_name).toBe('Renamed after issue');
        expect(String(after.due_date)).toContain('2026-06-30');
        expect(after.invoice_number).toBe('ORIG-100');
      });

      it('compares the invoice date as a day, not as the string sent', async () => {
        const res = await patchDetails({ invoiceDate: '2026-03-01T00:00:00.000Z', invoiceName: 'Renamed' });

        expect(res.status).toBe(200);
        expect((await faceOf()).invoice_name).toBe('Renamed');
      });

      it('treats an empty remit-to field as the absent one stored', async () => {
        await testPool.query('update invoices set billing_snapshot_at = null where id = $1', [invoiceId]);
        expect((await patchDetails({ remitTo: { name: 'Firm Trust', city: 'Austin' } })).status).toBe(200);
        await testPool.query('update invoices set billing_snapshot_at = now() where id = $1', [invoiceId]);

        const res = await patchDetails({
          remitTo: { name: 'Firm Trust', address: '', city: 'Austin' },
          invoiceName: 'Renamed',
        });

        expect(res.status).toBe(200);
        const { rows } = await testPool.query(
          'select remit_to_name, remit_to_city from invoices where id = $1', [invoiceId],
        );
        expect(rows[0]).toEqual({ remit_to_name: 'Firm Trust', remit_to_city: 'Austin' });
      });

      it('still refuses a changed number sent with the rest, and saves none of it', async () => {
        const res = await patchDetails({
          invoiceName: 'Renamed after issue',
          invoiceNumber: 'INV-CHANGED',
          invoiceDate: '2026-03-01',
          dueDate: '2026-06-30',
          remitTo: REMIT,
        });

        expect(res.status).toBe(409);
        const after = await faceOf();
        expect(after.invoice_number).toBe('ORIG-100');
        expect(after.invoice_name).toBe('Original Name');
      });

      it('still refuses a changed remit-to field', async () => {
        const res = await patchDetails({ remitTo: { ...REMIT, city: 'Dallas' }, invoiceName: 'Renamed' });

        expect(res.status).toBe(409);
      });

      it('still refuses a changed invoice date', async () => {
        const res = await patchDetails({ invoiceDate: '2026-03-02', invoiceName: 'Renamed' });

        expect(res.status).toBe(409);
      });
    });
  });

  it('clears the number when sent an empty string', async () => {
    const res = await patchDetails({ invoiceNumber: '' });

    expect(res.status).toBe(200);
    // `invoices.invoice_number` is NOT NULL, so "no number" is the empty string.
    // The firm-wide unique index excludes it, which is what lets several
    // unnumbered invoices coexist.
    expect((await faceOf()).invoice_number).toBe('');
  });

  it('stores a structured remit-to block in its own columns', async () => {
    const res = await patchDetails({
      remitTo: { name: 'Firm Trust', address: '1 Main St', city: 'Austin', state: 'TX', zip: '78701' },
    });

    expect(res.status).toBe(200);
    // An object remit-to is spread across remit_to_name/address/city/state/zip
    // and the free-text `remit_to` is nulled, so a reader cannot find both a
    // structured block and a stale string describing a different address.
    const { rows } = await testPool.query(
      `select remit_to, remit_to_name, remit_to_address, remit_to_city, remit_to_state, remit_to_zip
         from invoices where id = $1`,
      [invoiceId],
    );
    expect(rows[0]).toEqual({
      remit_to: null,
      remit_to_name: 'Firm Trust',
      remit_to_address: '1 Main St',
      remit_to_city: 'Austin',
      remit_to_state: 'TX',
      remit_to_zip: '78701',
    });
  });

  /**
   * D6: remit-to is frozen at issue, in the same group as the bill-to snapshot.
   * Issue is the moment `billing_snapshot_at` is stamped (the snapshot service
   * writes it when the invoice is first sent or paid). RED IF the freeze is
   * dropped (200, and the column changes) or fires before issue (the draft case
   * below goes 409).
   */
  it('refuses a remit-to change once the invoice has been issued, and leaves the stored block alone', async () => {
    const draft = await patchDetails({ remitTo: { name: 'Before Issue', city: 'Austin' } });
    expect(draft.status).toBe(200);

    await testPool.query(
      'update invoices set billing_snapshot_at = now() where id = $1', [invoiceId],
    );

    const res = await patchDetails({ remitTo: { name: 'After Issue', city: 'Dallas' } });
    expect(res.status).toBe(409);
    const { rows } = await testPool.query(
      'select remit_to_name, remit_to_city from invoices where id = $1', [invoiceId],
    );
    expect(rows[0]).toEqual({ remit_to_name: 'Before Issue', remit_to_city: 'Austin' });

    // The other details are not part of the frozen group.
    const name = await patchDetails({ invoiceName: 'Renamed after issue' });
    expect(name.status).toBe(200);
  });

  it('replaces a structured remit-to with a plain string rather than keeping both', async () => {
    await patchDetails({ remitTo: { name: 'Firm Trust', city: 'Austin' } });

    const res = await patchDetails({ remitTo: 'Pay to the order of the firm' });
    expect(res.status).toBe(200);

    const { rows } = await testPool.query(
      'select remit_to, remit_to_name, remit_to_city from invoices where id = $1',
      [invoiceId],
    );
    expect(rows[0]).toEqual({
      remit_to: 'Pay to the order of the firm',
      remit_to_name: null,
      remit_to_city: null,
    });
  });

  it('does NOT overwrite the invoice number when only the name is changed', async () => {
    const res = await patchDetails({ invoiceName: 'Renamed' });
    expect(res.status).toBe(200);

    // The number is what the client pays against and what the firm's books are
    // keyed on. Renaming a bill must not silently re-key it: the renamed invoice
    // still reconciles against its own lines and its own balance, so nothing on
    // any screen shows that the reference the client was given no longer exists.
    // The firm-wide unique index on invoice_number is then carrying a value
    // nobody chose, which the next invoice named the same thing collides with.
    expect((await faceOf()).invoice_number).toBe('ORIG-100');
  });

  it('does not move any money', async () => {
    const paid = await owner.api.put(onInvoice('/payment')).send({ paymentAmount: 250 });
    expect(paid.status).toBe(200);
    const before = await faceOf();

    await patchDetails({ invoiceName: 'Renamed', dueDate: '2026-06-30' });

    const after = await faceOf();
    expect(Number(after.total_cents)).toBe(Number(before.total_cents));
    expect(Number(after.amount_paid_cents)).toBe(25_000);
    expect(Number(after.balance_due_cents)).toBe(75_000);
  });

  it('refuses to take a number another invoice in the firm already holds', async () => {
    const second = await owner.api.post(B()).send({
      invoiceName: 'Second Invoice',
      invoiceNumber: 'TAKEN-200',
      invoiceDate: '2026-03-02',
      totalAmount: 500,
      flatFeesAmount: 500,
      flatFees: [{ description: 'Other fee', amount: 500 }],
    });
    expect(second.status).toBe(201);

    const res = await patchDetails({ invoiceNumber: 'TAKEN-200' });

    // invoice_number is unique per firm by index. The caller has to be told, not
    // handed a 500: a 500 reads as an outage and gets retried forever.
    expect(res.status).toBe(400);
    // And the collision must not have half-applied.
    expect((await faceOf()).invoice_number).toBe('ORIG-100');
  });

  it('answers not found for an invoice this firm does not have', async () => {
    const res = await owner.api
      .patch(`${B()}/${randomUUID()}/details`)
      .send({ invoiceName: 'Ghost' });

    expect(res.status).toBe(404);
  });

  it('answers not found for a malformed invoice id, without a database error', async () => {
    const res = await owner.api.patch(`${B()}/not-a-uuid/details`).send({ invoiceName: 'Ghost' });

    expect(res.status).toBe(404);
  });

  it('does not let one firm rewrite another firm invoice', async () => {
    const otherFirm = await createFirm({ name: 'Other Firm' });
    const otherOwner = await ownerOf(otherFirm.id);
    const otherClient = await createPersonClient(otherFirm.id, { name: 'Outsider' });

    const res = await otherOwner.api
      .patch(`/api/lawfirms/${otherFirm.id}/billing/invoices/client/${otherClient.id}/${invoiceId}/details`)
      .send({ invoiceName: 'Taken Over' });

    expect(res.status).toBe(404);
    expect((await faceOf()).invoice_name).toBe('Original Name');
  });

  it('refuses a member without billing.manageInvoices', async () => {
    const narrow = await memberWith(firm.id, ['billing.viewInvoices']);

    const res = await narrow.api.patch(onInvoice('/details')).send({ invoiceName: 'Sneaky' });

    expect(res.status).toBe(403);
    expect((await faceOf()).invoice_name).toBe('Original Name');
  });
});

describe('reminder settings', () => {
  it('records an opt-out on the invoice', async () => {
    const res = await owner.api.patch(onInvoice('/reminder-optout')).send({ optOut: true });

    expect(res.status).toBe(200);
    expect((await faceOf()).reminder_opt_out).toBe(true);
  });

  it('opts back in', async () => {
    await owner.api.patch(onInvoice('/reminder-optout')).send({ optOut: true });

    const res = await owner.api.patch(onInvoice('/reminder-optout')).send({ optOut: false });

    expect(res.status).toBe(200);
    expect((await faceOf()).reminder_opt_out).toBe(false);
  });

  it('treats an omitted flag as opting OUT', async () => {
    // The route defaults `optOut` to true unless the body explicitly says false,
    // so a bare POST from the "mute this invoice" control mutes it.
    const res = await owner.api.patch(onInvoice('/reminder-optout')).send({});

    expect(res.status).toBe(200);
    expect((await faceOf()).reminder_opt_out).toBe(true);
  });

  it('answers not found for an invoice this firm does not have', async () => {
    const res = await owner.api
      .patch(`${B()}/${randomUUID()}/reminder-optout`)
      .send({ optOut: true });

    expect(res.status).toBe(404);
  });

  it('sets the invoice pre-due window and clears the marker saying one was already sent', async () => {
    const marked = await testPool.query(
      `insert into reminders (law_firm_id, invoice_id, pre_due_sent_at)
       select law_firm_id, id, now() from invoices where id = $1
       on conflict (law_firm_id, invoice_id) where invoice_id is not null
       do update set pre_due_sent_at = now()`,
      [invoiceId],
    );
    expect(marked.rowCount).toBe(1);

    const res = await owner.api.patch(onInvoice('/pre-due-reminder')).send({ invoiceDays: 7 });

    expect(res.status).toBe(200);
    const face = await faceOf();
    expect(face.pre_due_reminder_days).toBe(7);
    // Without the reset the cron treats the invoice as already reminded and the
    // client never hears about the new window, which looks like nothing at all.
    expect(face.pre_due_reminder_sent_at).toBeNull();
  });

  it('clears the invoice pre-due window when sent null', async () => {
    await owner.api.patch(onInvoice('/pre-due-reminder')).send({ invoiceDays: 7 });

    const res = await owner.api.patch(onInvoice('/pre-due-reminder')).send({ invoiceDays: null });

    expect(res.status).toBe(200);
    expect((await faceOf()).pre_due_reminder_days).toBeNull();
  });

  describe('with a payment plan on the invoice', () => {
    beforeEach(async () => {
      const plan = await owner.api.post(onInvoice('/payment-plan')).send({
        installmentAmount: 250, frequencyDays: 30, planStartDate: '2026-04-01',
      });
      expect(plan.status).toBe(200);
      expect((await installments()).map((i: any) => Number(i.amount_cents)))
        .toEqual([25_000, 25_000, 25_000, 25_000]);
      // Pretend the cron has already reminded on the first two installments.
      const marked = await testPool.query(
        `update invoice_expected_payments set pre_due_reminder_sent_at = now()
          where invoice_id = $1 and sort_order < 2`,
        [invoiceId],
      );
      expect(marked.rowCount).toBe(2);
    });

    it('sets the plan pre-due window', async () => {
      const res = await owner.api.patch(onInvoice('/pre-due-reminder')).send({ planDays: 3 });

      expect(res.status).toBe(200);
      expect((await faceOf()).plan_pre_reminder_days).toBe(3);
    });

    it('clears every installment marker so the new window is evaluated again', async () => {
      await owner.api.patch(onInvoice('/pre-due-reminder')).send({ planDays: 3 });

      expect((await installments()).map((i: any) => i.pre_due_reminder_sent_at))
        .toEqual([null, null, null, null]);
    });

    it('leaves the schedule money and dates exactly where they were', async () => {
      const before = await installments();

      await owner.api.patch(onInvoice('/pre-due-reminder')).send({ planDays: 3 });

      // This request rewrites the whole payment-plan object to reach the
      // markers. Losing an amount or a date here changes what the client is
      // asked to pay, from an action that only meant to change a notification,
      // and the invoice balance stays correct throughout so nothing flags it.
      const after = await installments();
      expect(after.map((i: any) => Number(i.amount_cents)))
        .toEqual(before.map((i: any) => Number(i.amount_cents)));
      expect(after.map((i: any) => i.due_date)).toEqual(before.map((i: any) => i.due_date));
      expect(after.map((i: any) => i.status)).toEqual(before.map((i: any) => i.status));
    });

    it('leaves the plan HEADER exactly where it was', async () => {
      const before = await planHeader();
      expect(Number(before.plan_installment_cents)).toBe(25_000);

      await owner.api.patch(onInvoice('/pre-due-reminder')).send({ planDays: 3 });

      // The installments and the header are stored separately, and the header is
      // what any later rebuild of the schedule reads. A rewrite that spread only
      // part of the plan forward leaves the visible instalments correct and the
      // terms behind them gone, so the damage appears on the NEXT event that
      // refits the schedule rather than on this request.
      expect(await planHeader()).toEqual(before);
    });

    it('leaves the schedule alone entirely when only the INVOICE window is set', async () => {
      const before = await installments();

      await owner.api.patch(onInvoice('/pre-due-reminder')).send({ invoiceDays: 5 });

      const after = await installments();
      // The plan branch is gated on planDays being present. If it ran anyway the
      // first two markers would be cleared and the cron would re-remind on
      // installments the client has already been chased about.
      expect(after.map((i: any) => i.pre_due_reminder_sent_at === null))
        .toEqual(before.map((i: any) => i.pre_due_reminder_sent_at === null));
      expect((await faceOf()).pre_due_reminder_days).toBe(5);
    });
  });

  it('ignores plan days on an invoice with no plan, rather than inventing one', async () => {
    const res = await owner.api.patch(onInvoice('/pre-due-reminder')).send({ planDays: 3 });

    expect(res.status).toBe(200);
    expect(await installments()).toEqual([]);
    expect((await faceOf()).plan_pre_reminder_days).toBeNull();
  });
});
