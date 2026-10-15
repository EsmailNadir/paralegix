const {
  getBillingCalendarItems,
  buildPaymentDateEntries,
  findBillingSyncItemKey,
  getBillingProviderEventId,
  getBillingOutlookChangeKey,
  listBillingProviderSyncKeys,
  getNextPendingExpectedPayment,
} = require('../../src/modules/billing/shared/billingCalendar');

describe('billingCalendar helper', () => {
  test('returns one invoice due-date item when there is no payment plan', () => {
    const invoice = {
      id: 'inv-1',
      contextType: 'client',
      clientId: 'client-1',
      invoiceName: 'Consultation Invoice',
      totalAmount: 500,
      amountPaid: 100,
      totalWrittenOff: 50,
      dueDate: '2026-04-25T00:00:00.000Z',
      isPaid: false,
    };

    expect(getBillingCalendarItems(invoice)).toEqual([
      {
        key: 'dueDate',
        billingItemType: 'invoice_due_date',
        installmentId: null,
        scheduledDate: '2026-04-25',
        scheduledAmount: 350,
      },
    ]);
  });

  test('returns unpaid payment-plan installments and skips the invoice due date', () => {
    const invoice = {
      id: 'inv-2',
      contextType: 'matter',
      matterId: 'matter-1',
      totalAmount: 600,
      amountPaid: 0,
      dueDate: '2026-05-01T00:00:00.000Z',
      isPaid: false,
      paymentPlan: {
        enabled: true,
        expectedPayments: [
          { id: 'inst_a', dueDate: '2026-05-05', amount: 200, status: 'pending' },
          { id: 'inst_b', dueDate: '2026-06-05', amount: 200, status: 'paid' },
          { id: 'inst_c', dueDate: '2026-07-05', amount: 200, status: 'overdue' },
        ],
      },
    };

    expect(getBillingCalendarItems(invoice)).toEqual([
      {
        key: 'installment_inst_a',
        billingItemType: 'installment',
        installmentId: 'inst_a',
        installmentIndex: 0,
        scheduledDate: '2026-05-05',
        scheduledAmount: 200,
      },
      {
        key: 'installment_inst_c',
        billingItemType: 'installment',
        installmentId: 'inst_c',
        installmentIndex: 2,
        scheduledDate: '2026-07-05',
        scheduledAmount: 200,
      },
    ]);
  });

  test('returns no billing items for fully settled invoices', () => {
    const invoice = {
      id: 'inv-3',
      totalAmount: 400,
      amountPaid: 400,
      dueDate: '2026-04-25T00:00:00.000Z',
      isPaid: true,
      paymentPlan: {
        enabled: true,
        expectedPayments: [
          { id: 'inst_a', dueDate: '2026-05-05', amount: 200, status: 'pending' },
        ],
      },
    };

    expect(getBillingCalendarItems(invoice)).toEqual([]);
  });

  test('builds calendar payment entries per billing item', () => {
    const invoice = {
      id: 'inv-4',
      contextType: 'matter',
      matterId: 'matter-9',
      clientId: 'client-9',
      invoiceName: 'Litigation Invoice',
      totalAmount: 800,
      amountPaid: 100,
      isPaid: false,
      paymentPlan: {
        enabled: true,
        expectedPayments: [
          { id: 'inst_a', dueDate: '2026-05-10', amount: 300, status: 'pending' },
        ],
      },
    };

    expect(buildPaymentDateEntries(invoice, { matterName: 'Smith v. Jones' })).toEqual([
      expect.objectContaining({
        id: 'inv-4:installment_inst_a',
        invoiceId: 'inv-4',
        billingItemType: 'installment',
        installmentId: 'inst_a',
        matterId: 'matter-9',
        matterName: 'Smith v. Jones',
        scheduledAmount: 300,
        dueDate: null,
        nextPaymentDate: '2026-05-10',
      }),
    ]);
  });

  test('finds a stored billing sync item key for the current user', () => {
    const invoice = {
      calendarSync: {
        google: {
          user_1: {
            dueDate: { eventId: 'google_event_1' },
            installment_inst_a: { eventId: 'google_event_2' },
          },
        },
      },
    };

    expect(findBillingSyncItemKey(invoice, 'google', 'user_1', 'google_event_2')).toBe('installment_inst_a');
  });

  test('getBillingProviderEventId reads the per-user google map', () => {
    const invoice = {
      calendarSync: {
        google: {
          u1: { installment_x: { eventId: 'evt_mine' } },
          u2: { installment_x: { eventId: 'evt_theirs' } },
        },
      },
    };
    expect(getBillingProviderEventId(invoice, 'google', 'u1', 'installment_x')).toBe('evt_mine');

    // Keyed on the user, not just the item: two members can each hold their own
    // event for the same installment in their own calendar, and reading the
    // wrong one makes an update or delete land in somebody else's calendar.
    expect(getBillingProviderEventId(invoice, 'google', 'u2', 'installment_x')).toBe('evt_theirs');
    expect(getBillingProviderEventId(invoice, 'google', 'u3', 'installment_x')).toBeNull();
  });

  test('listBillingProviderSyncKeys returns only the calling user keys', () => {
    const invoice = {
      calendarSync: {
        google: {
          user_1: { installment_a: { eventId: 'e1' }, dueDate: { eventId: 'e2' } },
          user_2: { installment_b: { eventId: 'e3' } },
        },
      },
    };
    // Another member's bucket is seeded so the exclusion is proved rather than
    // assumed: this list drives the sweep that deletes events, and returning a
    // colleague's key would delete an event out of their calendar.
    expect(listBillingProviderSyncKeys(invoice, 'google', 'user_1').sort()).toEqual(
      ['dueDate', 'installment_a'].sort(),
    );
  });

  test('getBillingOutlookChangeKey reads the per-user outlook map', () => {
    const invoice = {
      calendarSync: {
        outlook: {
          u1: { dueDate: { eventId: 'e1', changeKey: 'ck1' } },
          u2: { dueDate: { eventId: 'e2', changeKey: 'ck2' } },
        },
      },
    };
    expect(getBillingOutlookChangeKey(invoice, 'u1', 'dueDate')).toBe('ck1');

    // Outlook rejects an update carrying another event's changeKey, so reading
    // one user's key for another user's event fails the write outright.
    expect(getBillingOutlookChangeKey(invoice, 'u2', 'dueDate')).toBe('ck2');
    expect(getBillingOutlookChangeKey(invoice, 'u3', 'dueDate')).toBeNull();
  });

  test('returns the earliest pending installment as the next payment', () => {
    expect(getNextPendingExpectedPayment([
      { id: 'a', dueDate: '2026-06-10', status: 'pending' },
      { id: 'b', dueDate: '2026-05-10', status: 'overdue' },
      { id: 'c', dueDate: '2026-04-10', status: 'paid' },
    ])).toEqual({ id: 'b', dueDate: '2026-05-10', status: 'overdue' });
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
