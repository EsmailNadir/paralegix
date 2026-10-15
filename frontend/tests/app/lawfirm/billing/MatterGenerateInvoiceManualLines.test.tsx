/**
 * The matter invoice composer: what it POSTs for a line the user typed in.
 *
 * A time entry added with "Add Time Entry" and a flat fee that was never saved
 * exist only in the browser, under a local id. The create body must carry no
 * `id` for them, so the server stores them as manual lines, while a saved
 * activity keeps its id.
 *
 * What has to break for this to go red: the page sending a composer-local id
 * (`manual-te-...` or `flat-fee-...`) as the line's source id.
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/requestDeduplicator');

jest.mock('@/services/chargeCodes.service', () => ({
  __esModule: true,
  chargeCodesService: { getChargeCodes: jest.fn().mockResolvedValue({ chargeCodes: [] }) },
}));

jest.mock('@/services/matters.service', () => ({
  __esModule: true,
  default: {
    getMatterById: jest.fn().mockResolvedValue({
      id: 'matter-a',
      name: 'Smith v Jones',
      members: [{ userId: 'u1', name: 'Alice Adams', hourlyRate: 200 }],
    }),
    listClients: jest.fn().mockResolvedValue([{ id: 'client-a', name: 'Pat Client', clientType: 'individual' }]),
    listClientContacts: jest.fn().mockResolvedValue([]),
  },
}));

const mockNavigate = jest.fn();
jest.mock('@/contexts/NavigationContext', () => ({
  __esModule: true,
  useNavigation: () => ({ navigate: mockNavigate, isNavigating: false }),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/lawfirm/firm-a/matters/matter-a/generate-invoice',
  useParams: () => ({ lawFirmId: 'firm-a', matterId: 'matter-a' }),
  useSearchParams: () => new URLSearchParams(),
}));

import dayjs from 'dayjs';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import MatterGenerateInvoicePage from '@/app/lawfirm/[lawFirmId]/matters/[matterId]/generate-invoice/page';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../../support/apiMock';

let api: ApiMock;

// The composer's default range is the last 30 days, so the seeded entry sits in it.
const TODAY = dayjs().format('YYYY-MM-DD');
const TIME_ENTRIES_URL = '/api/lawfirms/firm-a/billing/time-entries/matter/matter-a';
const FLAT_FEES_URL = '/api/lawfirms/firm-a/billing/flat-fees/matter/matter-a';
const CREATE_URL = '/api/lawfirms/firm-a/billing/invoices';

beforeEach(() => {
  api = installApiMock();
  api.allowUnhandled();
  mockNavigate.mockReset();
  api.getExact(TIME_ENTRIES_URL, {
    timeEntries: [{ id: 'te-1', userId: 'u1', userName: 'Alice Adams', hours: 1, hourlyRate: 200, date: TODAY, name: 'Research' }],
  });
  api.getExact(FLAT_FEES_URL, { flatFees: [{ id: 'ff-1', description: 'Filing fee', amount: 150, date: TODAY }] });
  api.postExact(CREATE_URL, { status: 201, body: { invoice: { id: 'inv-1' } } });
});

afterEach(() => {
  api.restore();
});

it.each(['firm_default', 'client_default', 'charge_code'])('bills the stored %s rate rather than the member fallback', async (rateSource) => {
  api.getExact(TIME_ENTRIES_URL, { timeEntries: [{
    id: 'rated-time', userId: 'u1', userName: 'Alice Adams', hours: 0.3, hourlyRate: null,
    resolvedRate: 123.45, rateSource, date: TODAY, name: 'Rated research',
  }] });
  api.getExact(FLAT_FEES_URL, { flatFees: [] });
  renderWithProviders(<MatterGenerateInvoicePage />);
  await screen.findByText('Rated research');
  await userEvent.type(screen.getByPlaceholderText('e.g. Client Intake, Monthly Retainer'), 'Rated work');
  fireEvent.click(screen.getByRole('button', { name: 'Generate Invoice' }));
  await waitFor(() => expect(api.callsTo(CREATE_URL)).toHaveLength(1));
  expect((api.callsTo(CREATE_URL)[0].body as { timeEntries: unknown[] }).timeEntries).toEqual([
    expect.objectContaining({ id: 'rated-time', rate: 123.45, hours: 0.3, amount: 37.04 }),
  ]);
});

it('confirms a saved flat fee removal without sending a request on Cancel', async () => {
  api.deleteExact('/api/lawfirms/firm-a/billing/flat-fees/matter/matter-a/ff-1', {});
  renderWithProviders(<MatterGenerateInvoicePage />);
  await screen.findByText('Filing fee');
  await userEvent.click(screen.getByRole('button', { name: 'Remove flat fee' }));
  let dialog = await screen.findByRole('dialog', { name: 'Remove Flat Fee' });
  expect(dialog).toHaveTextContent('Filing fee');
  expect(api.calls('DELETE')).toHaveLength(0);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Remove Flat Fee' })).not.toBeInTheDocument());
  expect(api.calls('DELETE')).toHaveLength(0);
  await userEvent.click(screen.getByRole('button', { name: 'Remove flat fee' }));
  dialog = await screen.findByRole('dialog', { name: 'Remove Flat Fee' });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(api.calls('DELETE')).toHaveLength(1));
  expect(api.calls('DELETE')[0].pathname).toBe('/api/lawfirms/firm-a/billing/flat-fees/matter/matter-a/ff-1');
  expect(api.calls('DELETE')[0].query).toEqual({});
});

it('sends typed time and flat fee lines with no source id and saved ones with their activity id', async () => {
  renderWithProviders(<MatterGenerateInvoicePage />);
  await screen.findByText('Research');

  fireEvent.click(screen.getByRole('button', { name: '+ Add Time Entry' }));
  // A typed entry bills a team member; one with none chosen drops out of the selection.
  fireEvent.click(screen.getByText('Select member'));
  fireEvent.click(await screen.findByRole('option', { name: 'Alice Adams' }));
  await userEvent.type(screen.getByPlaceholderText('Document review, client call, drafting...'), 'Phone call');
  await userEvent.type(screen.getAllByPlaceholderText('0')[0], '1');
  await userEvent.type(screen.getAllByPlaceholderText('0.00')[0], '120');

  fireEvent.click(screen.getByRole('button', { name: '+ Add Flat Fee' }));
  const feeDescription = screen.getByPlaceholderText('Description (e.g. Filing Fee)');
  await userEvent.type(feeDescription, 'Courier surcharge');
  await userEvent.type(feeDescription.parentElement!.querySelector('input[type="number"]')!, '25');

  await userEvent.type(screen.getByPlaceholderText('e.g. Client Intake, Monthly Retainer'), 'March work');
  fireEvent.click(screen.getByRole('button', { name: 'Generate Invoice' }));

  await waitFor(() => expect(api.callsTo(CREATE_URL)).toHaveLength(1));
  const body = api.callsTo(CREATE_URL)[0].body as {
    timeEntries: Array<Record<string, unknown>>;
    flatFees: Array<Record<string, unknown>>;
  };
  expect(body.timeEntries.map((line) => ({ id: line.id, name: line.name, amount: line.amount }))).toEqual([
    { id: 'te-1', name: 'Research', amount: 200 },
    { id: undefined, name: 'Phone call', amount: 120 },
  ]);
  expect('id' in body.timeEntries[1]).toBe(false);
  expect(body.flatFees).toEqual([
    { id: 'ff-1', description: 'Filing fee', amount: 150 },
    { description: 'Courier surcharge', amount: 25 },
  ]);
});
