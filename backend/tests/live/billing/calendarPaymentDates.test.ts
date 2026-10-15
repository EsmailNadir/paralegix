/**
 * Calendar payment dates - window behaviour.
 *
 * Hits the REAL running server at localhost:5001 (see tests/setup.js).
 *
 * The firm's own billing history is not guaranteed to contain an invoice with a
 * payment plan or a payment recorded far in the past, so the suite seeds its own
 * matter and three invoices covering all three date sources a calendar entry can
 * come from (the invoice due date, an installment due date, and a recorded
 * payment date) and tears them down afterwards. Without those fixtures the
 * window assertions would pass vacuously on an empty or single-dated dataset.
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');
const { getPrimaryLawFirmId } = require('../helpers');

let token: any;
let lawFirmId: any;
let matterId: any;

// Invoice whose only calendar date is a due date far in the future.
let farDueInvoiceId: any;
// Invoice with a near due date and a payment recorded far in the past.
let paidInvoiceId: any;
// Invoice on a payment plan with one near and one far installment.
let planInvoiceId: any;

const DAYS = {
  nearDue: 5,
  nearInstallment: 7,
  farInstallment: 450,
  farDue: 500,
  oldPayment: -400,
};

const dayString = (offsetDays: any) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

const isoAt = (offsetDays: any) => `${dayString(offsetDays)}T00:00:00.000Z`;

const createInvoice = async ({ name, dueOffset, totalAmount }: any) => {
  const res = await api.post(`/api/lawfirms/${lawFirmId}/billing/invoices`, {
    token,
    body: {
      matterId,
      invoiceName: name,
      invoiceDate: isoAt(0),
      dueDate: isoAt(dueOffset),
      timeEntries: [],
      // The service recomputes the total from the line items and rejects a
      // mismatch, so the invoice carries a single flat fee for its whole value.
      flatFees: [{ description: 'Window fixture fee', amount: totalAmount }],
      expenses: [],
      totalHours: 0,
      totalAmount,
      flatFeesAmount: totalAmount,
    },
  });
  expect(res.status).toBe(201);
  const id = res.body.invoiceId || res.body.invoice?.id;
  expect(id).toBeDefined();
  return id;
};

const fetchWindow = (from: any, to: any) => api.get(
  `/api/lawfirms/${lawFirmId}/billing/invoices/calendar-payment-dates?from=${from}&to=${to}`,
  { token },
);

/** Every calendar day a returned entry would be drawn on. */
const entryDays = (entry: any) => [entry.paidDate, entry.dueDate, entry.nextPaymentDate]
  .filter(Boolean)
  .map((v) => String(v).slice(0, 10));

const daysForInvoice = (body: any, invoiceId: any) => body.paymentDates
  .filter((e: any) => e.invoiceId === invoiceId)
  .flatMap(entryDays)
  .sort();

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  lawFirmId = await getPrimaryLawFirmId(token);

  const matterRes = await api.post(`/api/lawfirms/${lawFirmId}/matters`, {
    token,
    body: {
      name: '__TEST__ Payment Window Matter',
      description: 'Created by calendarPaymentDates test - safe to delete',
    },
  });
  expect(matterRes.status).toBe(201);
  matterId = matterRes.body.matterId;

  farDueInvoiceId = await createInvoice({
    name: '__TEST__ Far Due Invoice',
    dueOffset: DAYS.farDue,
    totalAmount: 1000,
  });

  paidInvoiceId = await createInvoice({
    name: '__TEST__ Old Payment Invoice',
    dueOffset: DAYS.nearDue,
    totalAmount: 1000,
  });
  const payRes = await api.put(
    `/api/lawfirms/${lawFirmId}/billing/invoices/matter/${matterId}/${paidInvoiceId}/payment`,
    {
      token,
      body: {
        paymentAmount: 200,
        paidDate: dayString(DAYS.oldPayment),
        paymentSource: 'external',
      },
    },
  );
  expect(payRes.status).toBe(200);

  planInvoiceId = await createInvoice({
    name: '__TEST__ Installment Invoice',
    dueOffset: DAYS.nearDue,
    totalAmount: 900,
  });
  // 900 remaining at 450 per installment stepping 443 days lands one installment
  // on the near day and the second far outside any calendar window under test.
  const planRes = await api.post(
    `/api/lawfirms/${lawFirmId}/billing/invoices/matter/${matterId}/${planInvoiceId}/payment-plan`,
    {
      token,
      body: {
        installmentAmount: 450,
        frequencyDays: DAYS.farInstallment - DAYS.nearInstallment,
        planStartDate: dayString(DAYS.nearInstallment),
      },
    },
  );
  expect(planRes.status).toBe(200);
});

afterAll(async () => {
  for (const id of [farDueInvoiceId, paidInvoiceId, planInvoiceId]) {
    if (id) {
      await api.delete(`/api/lawfirms/${lawFirmId}/billing/invoices/matter/${matterId}/${id}`, { token });
    }
  }
  if (matterId) {
    await api.delete(`/api/lawfirms/${lawFirmId}/matters/${matterId}`, { token });
  }
});

describe('GET /api/lawfirms/:lawFirmId/billing/invoices/calendar-payment-dates', () => {
  test('the fixtures produce every date source a calendar entry can come from', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/billing/invoices/calendar-payment-dates`,
      { token },
    );
    expect(res.status).toBe(200);

    // Guards the rest of the suite from passing vacuously.
    expect(daysForInvoice(res.body, farDueInvoiceId)).toEqual([dayString(DAYS.farDue)]);
    expect(daysForInvoice(res.body, paidInvoiceId))
      .toEqual([dayString(DAYS.oldPayment), dayString(DAYS.nearDue)].sort());
    expect(daysForInvoice(res.body, planInvoiceId))
      .toEqual([dayString(DAYS.nearInstallment), dayString(DAYS.farInstallment)].sort());
  });

  test('every returned entry falls inside the requested window', async () => {
    const from = dayString(-30);
    const to = dayString(30);
    const res = await fetchWindow(from, to);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.paymentDates)).toBe(true);

    for (const entry of res.body.paymentDates) {
      const days = entryDays(entry);
      expect(days.length).toBeGreaterThan(0);
      expect(days.some((d) => d >= from && d <= to)).toBe(true);
    }
  });

  test('keeps the near dates and drops the far ones', async () => {
    const res = await fetchWindow(dayString(0), dayString(30));
    expect(res.status).toBe(200);

    // The near invoice due date and the near installment are inside the window.
    expect(daysForInvoice(res.body, paidInvoiceId)).toEqual([dayString(DAYS.nearDue)]);
    expect(daysForInvoice(res.body, planInvoiceId)).toEqual([dayString(DAYS.nearInstallment)]);
    // The far due date is outside it, so that invoice contributes nothing.
    expect(daysForInvoice(res.body, farDueInvoiceId)).toEqual([]);
  });

  test('finds an entry whose only date is a payment far in the past', async () => {
    const res = await fetchWindow(dayString(DAYS.oldPayment - 5), dayString(DAYS.oldPayment + 5));
    expect(res.status).toBe(200);
    expect(daysForInvoice(res.body, paidInvoiceId)).toEqual([dayString(DAYS.oldPayment)]);
    expect(daysForInvoice(res.body, planInvoiceId)).toEqual([]);
    expect(daysForInvoice(res.body, farDueInvoiceId)).toEqual([]);
  });

  test('finds an entry whose only date is a far-future installment', async () => {
    const res = await fetchWindow(dayString(DAYS.farInstallment - 5), dayString(DAYS.farInstallment + 5));
    expect(res.status).toBe(200);
    expect(daysForInvoice(res.body, planInvoiceId)).toEqual([dayString(DAYS.farInstallment)]);
    expect(daysForInvoice(res.body, paidInvoiceId)).toEqual([]);
  });

  test('a window that matches nothing returns nothing rather than everything', async () => {
    const res = await fetchWindow(dayString(-9000), dayString(-8990));
    expect(res.status).toBe(200);
    expect(res.body.paymentDates).toEqual([]);
  });

  test('a narrow window returns no more entries than a wide one', async () => {
    const narrow = await fetchWindow(dayString(0), dayString(1));
    const wide = await fetchWindow(dayString(-3650), dayString(3650));
    expect(narrow.status).toBe(200);
    expect(wide.status).toBe(200);
    expect(narrow.body.paymentDates.length).toBeLessThanOrEqual(wide.body.paymentDates.length);
  });

  test('a wide window matches the unwindowed answer', async () => {
    const wide = await fetchWindow(dayString(-3650), dayString(3650));
    const unwindowed = await api.get(
      `/api/lawfirms/${lawFirmId}/billing/invoices/calendar-payment-dates`,
      { token },
    );
    expect(wide.status).toBe(200);
    expect(unwindowed.status).toBe(200);
    const wideIds = wide.body.paymentDates.map((p: any) => p.id).sort();
    // The unwindowed answer can include undated entries the window drops, so it is
    // a superset rather than an exact match.
    const unwindowedIds = new Set(unwindowed.body.paymentDates.map((p: any) => p.id));
    for (const id of wideIds) expect(unwindowedIds.has(id)).toBe(true);
    // All three fixtures are dated inside the wide window, so they must survive it.
    for (const id of [farDueInvoiceId, paidInvoiceId, planInvoiceId]) {
      expect(wide.body.paymentDates.some((p: any) => p.invoiceId === id)).toBe(true);
    }
  });

  test('rejects a malformed window', async () => {
    const res = await fetchWindow('yesterday', dayString(30));
    expect(res.status).toBe(400);
  });
});
// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
