/**
 * The client invoice composer's "available from matter billing" counts.
 *
 * The defect this pins: the page fired a `listTimeEntries` AND a `listFlatFees`
 * per linked matter, then reduced both row sets to a single number each. A
 * client with eighty matters opened this page with a hundred and sixty-one
 * requests, and every row they returned was discarded. Both counts are now
 * server-side totals: `countOnly=true` for flat fees, and a one-row page read
 * for its `totalItems` for time entries.
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/lawfirm/firm-a/clients/client-a/generate-invoice',
  useParams: () => ({ lawFirmId: 'firm-a', clientId: 'client-a' }),
  useSearchParams: () => new URLSearchParams(),
}));

import { screen, waitFor } from '@testing-library/react';

import ClientGenerateInvoicePage from '@/app/lawfirm/[lawFirmId]/clients/[clientId]/generate-invoice/page';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { setupApiMock } from '../../../support/apiMock';

const api = setupApiMock();

/** Twelve linked matters: twenty-four requests under the old per-matter fan-out. */
const TWELVE_MATTER_IDS = Array.from({ length: 12 }, (_, i) => `matter-${i}`);

const CLIENT_URL = '/api/lawfirms/firm-a/clients/client-a';
const CLIENT_TIME_ENTRIES = '/api/lawfirms/firm-a/billing/time-entries/client/client-a';
const CLIENT_FLAT_FEES = '/api/lawfirms/firm-a/billing/flat-fees/client/client-a';
const FIRM_TIME_ENTRIES = '/api/lawfirms/firm-a/billing/time-entries/firm';
const FIRM_FLAT_FEES = '/api/lawfirms/firm-a/billing/flat-fees/firm';

/**
 * A person client with twelve matters and nothing billable of its own, which is
 * the state that makes the page render both "available from matter billing"
 * callouts.
 */
function seedClient(matterIds: string[] = TWELVE_MATTER_IDS) {
  api.get(CLIENT_URL, {
    client: {
      id: 'client-a',
      name: 'Acme Holdings',
      clientType: 'individual',
      matterIds,
    },
  });
  api.get(CLIENT_TIME_ENTRIES, { timeEntries: [] });
  api.get(CLIENT_FLAT_FEES, { flatFees: [] });
}

describe('client generate-invoice linked matter counts', () => {
  it('counts linked matter work with a constant number of requests, never one pair per matter', async () => {
    seedClient();
    api.get('/billing/time-entries/firm', { timeEntries: [], totalItems: 9, summary: { totalHours: 0, totalAmount: 0 } });
    api.get('/billing/flat-fees/firm', { flatFees: [], totalItems: 4, truncated: false, summary: { totalAmount: 0 } });

    renderWithProviders(<ClientGenerateInvoicePage />);

    await screen.findByText('9 linked matter entries are available from matter billing.');
    expect(
      screen.getByText('4 linked matter flat fees are available from matter billing.'),
    ).toBeInTheDocument();

    // Five reads for twelve matters, and the same five for eighty. The
    // per-matter loop made it twenty-seven here and a hundred and sixty-three
    // for an eighty-matter client.
    expect(api.calls()).toHaveLength(5);
    expect(api.callsTo('/billing/time-entries/matter/')).toHaveLength(0);
    expect(api.callsTo('/billing/flat-fees/matter/')).toHaveLength(0);
  });

  it('asks the server for the totals instead of fetching rows to count them', async () => {
    seedClient();
    api.get('/billing/time-entries/firm', { timeEntries: [], totalItems: 9, summary: { totalHours: 0, totalAmount: 0 } });
    api.get('/billing/flat-fees/firm', { flatFees: [], totalItems: 4, truncated: false, summary: { totalAmount: 0 } });

    renderWithProviders(<ClientGenerateInvoicePage />);
    await screen.findByText('9 linked matter entries are available from matter billing.');

    const [flatFeeCall] = api.callsTo(FIRM_FLAT_FEES);
    // The cheap shape of the read: totals, not a single row.
    expect(flatFeeCall.query.countOnly).toEqual(['true']);
    expect(flatFeeCall.query.matterIds?.[0]?.split(',')).toEqual(TWELVE_MATTER_IDS);
    expect(flatFeeCall.query.billingStatus).toEqual(['unbilled']);
    // The client's own fees are counted separately by the direct read above, so
    // this one must not widen to them.
    expect(flatFeeCall.query.clientId).toBeUndefined();

    const [timeEntryCall] = api.callsTo(FIRM_TIME_ENTRIES);
    // No count-only mode on this route, so one row and read `totalItems`.
    expect(timeEntryCall.query.limit).toEqual(['1']);
    expect(timeEntryCall.query.clientScope).toEqual(['client-a']);
    // Matter work only. The client's direct entries are the list on screen.
    expect(timeEntryCall.query.context).toEqual(['matter']);
    // Everything not yet on an invoice, which is what `!isBilled` meant when
    // the page counted rows itself.
    expect(timeEntryCall.query.billingStatus).toEqual(['unbilled,queued,covered_by_retainer']);
  });

  it('asks nothing about linked matters when the client has none', async () => {
    seedClient([]);

    renderWithProviders(<ClientGenerateInvoicePage />);

    await waitFor(() => expect(api.callsTo(CLIENT_FLAT_FEES)).toHaveLength(1));
    expect(api.callsTo(FIRM_FLAT_FEES)).toHaveLength(0);
    expect(api.callsTo(FIRM_TIME_ENTRIES)).toHaveLength(0);
    expect(
      screen.getByText(/No unbilled direct client flat fees available/),
    ).toBeInTheDocument();
  });

  it('falls back to no callout when a count read fails, rather than failing the page', async () => {
    seedClient();
    api.get('/billing/time-entries/firm', { status: 500, body: { error: 'boom' } });
    api.get('/billing/flat-fees/firm', { status: 500, body: { error: 'boom' } });

    renderWithProviders(<ClientGenerateInvoicePage />);

    await waitFor(() =>
      expect(screen.getByText(/No unbilled direct client flat fees available/)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/available from matter billing/)).not.toBeInTheDocument();
  });
});
