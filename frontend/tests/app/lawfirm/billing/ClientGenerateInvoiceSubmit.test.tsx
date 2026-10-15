/**
 * The client invoice composer: what it POSTs, and what it refuses to POST.
 *
 * The service layer is real, so every assertion is on the request that
 * actually leaves the browser: the create body with its line amounts, the
 * pre-payment and payment-plan writes that follow it, and the absence of any
 * write when a validation rule blocks the submit.
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');

const mockNavigate = jest.fn();
jest.mock('@/contexts/NavigationContext', () => ({
  __esModule: true,
  useNavigation: () => ({ navigate: mockNavigate, isNavigating: false }),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/lawfirm/firm-a/clients/client-a/generate-invoice',
  useParams: () => ({ lawFirmId: 'firm-a', clientId: 'client-a' }),
  useSearchParams: () => new URLSearchParams(),
}));

import dayjs from 'dayjs';
import { screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import ClientGenerateInvoicePage from '@/app/lawfirm/[lawFirmId]/clients/[clientId]/generate-invoice/page';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../../support/apiMock';

let api: ApiMock;

const TODAY = dayjs().format('YYYY-MM-DD');
const FORTY_FIVE_DAYS_AGO = dayjs().subtract(45, 'day').format('YYYY-MM-DD');

const CLIENT_URL = '/api/lawfirms/firm-a/clients/client-a';
const TIME_ENTRIES_URL = '/api/lawfirms/firm-a/billing/time-entries/client/client-a';
const FLAT_FEES_URL = '/api/lawfirms/firm-a/billing/flat-fees/client/client-a';
const CREATE_URL = '/api/lawfirms/firm-a/billing/invoices/client/client-a';

/**
 * Three unbilled entries across two people, one entry already billed, one
 * unbilled flat fee and one billed one.
 *
 * Bob's entry is 0.1h at $333.33, which is $33.333: the line amount the page
 * sends has to be rounded to cents, so this is the row that tells a rounded
 * line from an unrounded one.
 */
function timeEntries() {
  return [
    { id: 'te-1', userId: 'u1', userName: 'Alice Adams', hours: 1.5, hourlyRate: 200, date: TODAY, name: 'Research', description: 'Case law review' },
    { id: 'te-2', userId: 'u2', userName: 'Bob Brown', hours: 0.1, hourlyRate: 333.33, date: TODAY, name: 'Call' },
    { id: 'te-old', userId: 'u1', userName: 'Alice Adams', hours: 2, hourlyRate: 200, date: FORTY_FIVE_DAYS_AGO },
    { id: 'te-billed', userId: 'u1', userName: 'Alice Adams', hours: 9, hourlyRate: 100, date: TODAY, isBilled: true },
  ];
}

function flatFees() {
  return [
    { id: 'ff-1', description: 'Filing fee', amount: 150, date: TODAY },
    { id: 'ff-billed', description: 'Old courier', amount: 999, isBilled: true },
  ];
}

function seed({ clientType = 'individual' }: { clientType?: string } = {}) {
  api.getExact(CLIENT_URL, {
    client: { id: 'client-a', name: 'Acme Holdings', clientType, matterIds: [] },
  });
  api.getExact(TIME_ENTRIES_URL, { timeEntries: timeEntries() });
  api.getExact(FLAT_FEES_URL, { flatFees: flatFees() });
}

/** The collapsible section whose header button starts with `title`. */
function section(title: string): HTMLElement {
  const header = screen.getByRole('button', { name: new RegExp(`^${title}`) });
  return header.parentElement!.parentElement!;
}

async function renderLoaded() {
  renderWithProviders(<ClientGenerateInvoicePage />);
  // $300 + $33.333 + $400 + $150: every unbilled row starts selected.
  await waitFor(() => expect(balanceDue()).toBe('$883.33'));
}

it('confirms a saved client flat fee removal and retains errors for retry', async () => {
  seed();
  api.deleteExact('/api/lawfirms/firm-a/billing/flat-fees/client/client-a/ff-1', { status: 409, body: { error: 'Fee already invoiced' } });
  await renderLoaded();
  await userEvent.click(screen.getByRole('button', { name: /^Flat Fees/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Remove flat fee' }));
  const dialog = await screen.findByRole('dialog', { name: 'Remove Flat Fee' });
  expect(api.calls('DELETE')).toHaveLength(0);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Fee already invoiced');
  expect(api.calls('DELETE')).toHaveLength(1);
  expect(api.calls('DELETE')[0].pathname).toBe('/api/lawfirms/firm-a/billing/flat-fees/client/client-a/ff-1');
  expect(api.calls('DELETE')[0].query).toEqual({});
  expect(screen.getByText('Filing fee')).toBeInTheDocument();
});

function balanceDue(): string | null {
  const label = screen.queryByText('Balance Due');
  return label?.nextElementSibling?.textContent ?? null;
}

async function nameInvoice(name = 'March work') {
  await userEvent.type(screen.getByPlaceholderText('Invoice for Acme Holdings'), name);
}

function clickGenerate() {
  fireEvent.click(screen.getByRole('button', { name: 'Generate Invoice' }));
}

beforeEach(() => {
  api = installApiMock();
  mockNavigate.mockReset();
});

afterEach(() => {
  api.restore();
});

describe('client generate-invoice submit', () => {
  it.each(['firm_default', 'client_default', 'charge_code'])('bills the stored %s rate without a manual override', async (rateSource) => {
    seed();
    api.getExact(TIME_ENTRIES_URL, { timeEntries: [{
      id: 'rated-time', userId: 'u1', userName: 'Alice Adams', hours: 0.3, hourlyRate: null,
      resolvedRate: 123.45, rateSource, date: TODAY, name: 'Rated research',
    }] });
    api.getExact(FLAT_FEES_URL, { flatFees: [] });
    api.postExact(CREATE_URL, { status: 201, body: { invoice: { id: 'rated-invoice' } } });
    renderWithProviders(<ClientGenerateInvoicePage />);
    await screen.findByText('Rated research');
    await nameInvoice('Rated work');
    clickGenerate();
    await waitFor(() => expect(api.callsTo(CREATE_URL)).toHaveLength(1));
    expect((api.callsTo(CREATE_URL)[0].body as { timeEntries: unknown[] }).timeEntries).toEqual([
      expect.objectContaining({ id: 'rated-time', rate: 123.45, hours: 0.3, amount: 37.04 }),
    ]);
  });

  it('posts every unbilled row with cent-rounded line amounts and opens the new invoice', async () => {
    seed();
    api.postExact(CREATE_URL, { status: 201, body: { invoice: { id: 'inv-1' } } });

    await renderLoaded();
    await nameInvoice('  March work  ');
    clickGenerate();

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/lawfirm/firm-a/clients/client-a/invoices/inv-1'));

    const [call] = api.callsTo(CREATE_URL);
    const body = call.body as Record<string, unknown>;
    expect(body).toMatchObject({
      contextClientId: 'client-a',
      invoiceName: 'March work',
      invoiceNumber: null,
      invoiceDate: TODAY,
      dueDate: null,
      billingEmail: null,
      // Seeded from the firm record in the layout context.
      remitTo: { name: 'Test Law Firm LLP', address: '', city: '', state: '', zip: '' },
      flatFees: [{ id: 'ff-1', description: 'Filing fee', amount: 150 }],
      flatFeesAmount: 150,
    });
    // A blank note is left off the wire rather than sent as an empty string.
    expect('notes' in body).toBe(false);
    expect(body.timeEntries).toEqual([
      { id: 'te-1', name: 'Research', description: 'Case law review', rate: 200, hours: 1.5, amount: 300 },
      { id: 'te-2', name: 'Call', rate: 333.33, hours: 0.1, amount: 33.33 },
      { id: 'te-old', name: 'Service', rate: 200, hours: 2, amount: 400 },
    ]);
    expect(body.totalHours).toBeCloseTo(3.6, 9);
    expect(body.totalAmount).toBeCloseTo(883.33, 9);
  });

  it('refuses to submit without an invoice name', async () => {
    seed();

    await renderLoaded();
    clickGenerate();

    expect(await screen.findByText('Invoice name is required')).toBeInTheDocument();
    expect(api.calls('POST')).toHaveLength(0);
  });

  it('refuses payments received that exceed the invoice total', async () => {
    seed();

    await renderLoaded();
    await nameInvoice();
    fireEvent.click(screen.getByRole('button', { name: '+ Add Payment' }));
    await userEvent.type(within(section('Payments Received')).getByPlaceholderText('0.00'), '900');
    clickGenerate();

    expect(await screen.findByText('Payments received cannot exceed the invoice total')).toBeInTheDocument();
    expect(api.calls('POST')).toHaveLength(0);
  });

  it('records a pre-payment against the created invoice and takes it off the balance due', async () => {
    seed();
    api.postExact(CREATE_URL, { status: 201, body: { invoice: { id: 'inv-1' } } });
    api.putExact('/api/lawfirms/firm-a/billing/invoices/client/client-a/inv-1/payment', { invoice: { id: 'inv-1' } });

    await renderLoaded();
    await nameInvoice();
    fireEvent.click(screen.getByRole('button', { name: '+ Add Payment' }));
    const payments = section('Payments Received');
    await userEvent.type(within(payments).getByPlaceholderText('0.00'), '100.50');
    await userEvent.type(within(payments).getByPlaceholderText('e.g. Wire transfer, check #...'), ' Wire ');

    expect(balanceDue()).toBe('$782.83');

    clickGenerate();
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/lawfirm/firm-a/clients/client-a/invoices/inv-1'));

    const [payment] = api.callsTo('/invoices/client/client-a/inv-1/payment');
    expect(payment.body).toEqual({ paymentAmount: 100.5, paidDate: TODAY, paymentNote: 'Wire' });
  });

  it('shows the server refusal and stays on the page when the create fails', async () => {
    seed();
    api.postExact(CREATE_URL, {
      status: 400,
      body: { error: 'Validation failed', details: { fieldErrors: { invoiceNumber: ['Invoice number INV-7 is already used'] } } },
    });

    await renderLoaded();
    await nameInvoice();
    clickGenerate();

    expect(await screen.findByText('Invoice number INV-7 is already used')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('blocks a payment plan with no installment amount before creating anything', async () => {
    seed();

    await renderLoaded();
    await nameInvoice();
    const plan = section('Payment Plan');
    fireEvent.click(within(plan).getByRole('checkbox'));
    clickGenerate();

    expect(await screen.findByText('Enter a valid installment amount')).toBeInTheDocument();
    expect(api.calls('POST')).toHaveLength(0);
  });

  it('attaches the payment plan to the invoice it just created', async () => {
    seed();
    api.postExact(CREATE_URL, { status: 201, body: { invoice: { id: 'inv-1' } } });
    api.postExact('/api/lawfirms/firm-a/billing/invoices/client/client-a/inv-1/payment-plan', { invoice: { id: 'inv-1' } });

    await renderLoaded();
    await nameInvoice();
    const plan = section('Payment Plan');
    fireEvent.click(within(plan).getAllByRole('checkbox')[0]);
    await userEvent.type(within(plan).getByPlaceholderText('0.00'), '200');
    clickGenerate();

    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
    const [planCall] = api.callsTo('/inv-1/payment-plan');
    expect(planCall.body).toEqual({ installmentAmount: 200, frequencyDays: 30, planStartDate: TODAY });
  });
});

describe('client generate-invoice selection', () => {
  it('leaves an unticked team member off the invoice', async () => {
    seed();
    api.postExact(CREATE_URL, { status: 201, body: { invoice: { id: 'inv-1' } } });

    await renderLoaded();
    const bob = screen.getAllByText('Bob Brown').map((el) => el.closest('label')).find(Boolean)!;
    fireEvent.click(within(bob).getByRole('checkbox'));
    // Bob's $33.333 is gone from the total.
    await waitFor(() => expect(balanceDue()).toBe('$850.00'));

    await nameInvoice();
    clickGenerate();
    await waitFor(() => expect(api.callsTo(CREATE_URL)).toHaveLength(1));

    const body = api.callsTo(CREATE_URL)[0].body as { timeEntries: Array<{ id: string }> };
    expect(body.timeEntries.map((e) => e.id)).toEqual(['te-1', 'te-old']);
  });

  it('drops entries older than the default thirty-day range when the range filter is chosen', async () => {
    seed();

    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Date Range' }));

    // The 45-day-old $400 entry falls out.
    await waitFor(() => expect(balanceDue()).toBe('$483.33'));
    expect(screen.getByText('Selected Entries').nextElementSibling).toHaveTextContent('2');
  });

  it('lets a manual selection untick an entry', async () => {
    seed();

    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Manual Selection' }));
    const research = screen.getByText('Research').closest('label')!;
    fireEvent.click(within(research).getByRole('checkbox'));

    await waitFor(() => expect(balanceDue()).toBe('$583.33'));
  });

  it('disables Generate once nothing billable is selected', async () => {
    seed();

    await renderLoaded();
    fireEvent.click(within(section('Flat Fees')).getByRole('checkbox'));
    for (const name of ['Alice Adams', 'Bob Brown']) {
      const label = screen.getAllByText(name).map((el) => el.closest('label')).find(Boolean)!;
      fireEvent.click(within(label).getByRole('checkbox'));
    }

    await waitFor(() => expect(balanceDue()).toBe('$0.00'));
    expect(screen.getByRole('button', { name: 'Generate Invoice' })).toBeDisabled();
  });
});

describe('client generate-invoice flat fees', () => {
  it('saves a new flat fee to the client and reloads the list', async () => {
    seed();
    api.postExact('/api/lawfirms/firm-a/billing/flat-fees', { status: 201, body: { flatFee: { id: 'ff-new' } } });

    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: '+ Add Flat Fee' }));
    const fees = section('Flat Fees');
    await userEvent.type(within(fees).getByPlaceholderText('Description (e.g. Filing Fee)'), '  Courier  ');
    await userEvent.type(within(fees).getByPlaceholderText('0.00'), '42.5');
    fireEvent.click(within(fees).getByRole('button', { name: 'Done' }));

    await waitFor(() => expect(api.callsTo('/billing/flat-fees')).toHaveLength(1));
    expect(api.callsTo('/billing/flat-fees')[0].body).toEqual({
      clientId: 'client-a',
      description: 'Courier',
      amount: 42.5,
      date: TODAY,
    });
    // The page re-reads the client's fees after the save.
    await waitFor(() => expect(api.callsTo(FLAT_FEES_URL)).toHaveLength(2));
  });

  it('bills a fee that was never saved as a manual line, with no source id, beside the saved one', async () => {
    seed();
    api.postExact(CREATE_URL, { status: 201, body: { invoice: { id: 'inv-1' } } });

    await renderLoaded();
    await nameInvoice();
    fireEvent.click(screen.getByRole('button', { name: '+ Add Flat Fee' }));
    const fees = section('Flat Fees');
    await userEvent.type(within(fees).getByPlaceholderText('Description (e.g. Filing Fee)'), 'Courier surcharge');
    await userEvent.type(within(fees).getByPlaceholderText('0.00'), '25');
    await waitFor(() => expect(balanceDue()).toBe('$908.33'));
    clickGenerate();

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/lawfirm/firm-a/clients/client-a/invoices/inv-1'));
    const body = api.callsTo(CREATE_URL)[0].body as { flatFees: Array<Record<string, unknown>> };
    // The saved fee keeps the id of its activity; the typed one carries none, so
    // the server stores it as a manual line instead of rejecting a made-up id.
    expect(body.flatFees).toEqual([
      { id: 'ff-1', description: 'Filing fee', amount: 150 },
      { description: 'Courier surcharge', amount: 25 },
    ]);
    expect(api.callsTo('/billing/flat-fees')).toHaveLength(0);
  });

  it('deletes a saved flat fee on the server and reports a refusal', async () => {
    seed();
    api.deleteExact(`${FLAT_FEES_URL}/ff-1`, { status: 403, body: { error: 'You cannot remove this fee' } });

    await renderLoaded();
    fireEvent.click(within(section('Flat Fees')).getByRole('button', { name: 'Remove flat fee' }));
    expect(api.calls('DELETE')).toHaveLength(0);
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Remove Flat Fee' })).getByRole('button', { name: 'Remove' }));

    expect(await screen.findByText('You cannot remove this fee')).toBeInTheDocument();
    expect(api.callsTo(`${FLAT_FEES_URL}/ff-1`)).toHaveLength(1);
    // A refused delete leaves the form in place with the fee still counted.
    expect(balanceDue()).toBe('$883.33');
  });

  it('discards an unsaved flat fee locally without a request', async () => {
    seed();

    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: '+ Add Flat Fee' }));
    const fees = section('Flat Fees');
    await userEvent.type(within(fees).getByPlaceholderText('0.00'), '10');
    await waitFor(() => expect(balanceDue()).toBe('$893.33'));

    const removes = within(fees).getAllByRole('button', { name: 'Remove flat fee' });
    fireEvent.click(removes[removes.length - 1]);

    await waitFor(() => expect(balanceDue()).toBe('$883.33'));
    expect(api.calls('DELETE')).toHaveLength(0);
  });
});

describe('client generate-invoice retainer', () => {
  it('refuses a retainer without an amount', async () => {
    seed();

    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Create Evergreen Retainer Plan' }));

    expect(await screen.findByText('Enter a valid retainer amount.')).toBeInTheDocument();
    expect(api.calls('POST')).toHaveLength(0);
  });

  it('creates a client-scoped retainer plan with the default name', async () => {
    seed();
    api.postExact('/api/lawfirms/firm-a/billing/plans', { status: 201, body: { plan: { id: 'plan-1' } } });

    await renderLoaded();
    const retainer = section('Set Up Evergreen Retainer');
    await userEvent.type(within(retainer).getByPlaceholderText('0.00'), '2500');
    fireEvent.click(within(retainer).getByRole('button', { name: 'Create Evergreen Retainer Plan' }));

    expect(await screen.findByText(/Evergreen retainer plan created successfully/)).toBeInTheDocument();
    expect(api.callsTo('/billing/plans')[0].body).toEqual({
      contextType: 'client',
      entityId: 'client-a',
      name: 'Evergreen Retainer',
      amount: 2500,
      intervalUnit: 'month',
      intervalCount: 1,
      startDate: TODAY,
      endCondition: 'manual',
      endDate: null,
    });
  });
});

describe('client generate-invoice loading', () => {
  it('reports a failed client read instead of rendering an empty composer silently', async () => {
    api.getExact(CLIENT_URL, { status: 500, body: { error: 'Database unavailable' } });

    renderWithProviders(<ClientGenerateInvoicePage />);

    expect(await screen.findByText('Database unavailable')).toBeInTheDocument();
    expect(api.callsTo(TIME_ENTRIES_URL)).toHaveLength(0);
  });

  it('lists who at a company client receives billing email', async () => {
    seed({ clientType: 'company' });
    api.getExact(`${CLIENT_URL}/contacts`, {
      contacts: [
        { id: 'link-1', personClientId: 'p-1', name: 'Pat Payer', isEmailRecipient: true },
        { id: 'link-2', personClientId: 'p-2', name: 'Quinn Quiet', isEmailRecipient: false },
        // A related contact is not on the company roster.
        { id: 'rc-1', contactId: 'c-1', name: 'Outside Counsel', isEmailRecipient: true },
      ],
    });

    await renderLoaded();

    expect(await screen.findByText('1 of 2 receive billing emails')).toBeInTheDocument();
    expect(screen.queryByText('Outside Counsel')).not.toBeInTheDocument();
    expect(screen.getByText('Pat Payer')).toBeInTheDocument();
  });

  it('does not read a roster for a person client', async () => {
    seed();

    await renderLoaded();

    expect(screen.queryByRole('button', { name: /^Billing Recipients/ })).not.toBeInTheDocument();
    expect(api.callsTo('/clients/client-a/contacts')).toHaveLength(0);
  });
});
