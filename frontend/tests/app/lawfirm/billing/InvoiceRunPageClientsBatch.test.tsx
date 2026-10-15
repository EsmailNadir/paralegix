/**
 * What the invoice-run page asks the API for when it works out payer splits.
 *
 * The defect this pins: the page fired one
 * `GET /lawfirms/:lawFirmId/matters/:matterId/clients` per matter on the run,
 * inside an unbounded `Promise.all`. Opened from billing with no `contexts`
 * filter the run covers every matter in the firm with unbilled work, so a
 * sixty-matter firm opened sixty simultaneous requests, each holding one of the
 * API instance's twelve Postgres pool connections. The batch route answers all
 * of them in one request, capped at a hundred matter ids, so a run larger than
 * that is chunked and the chunks go out one after another rather than at once.
 *
 * Absence assertions are only worth something if the code that used to make the
 * per-matter requests ran at all, so every case here also asserts the share
 * breakdown the page renders from the response.
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/matters.service');
jest.unmock('@/services/requestDeduplicator');

const useParamsMock = jest.fn();
const useSearchParamsMock = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/lawfirm/firm-a/billing/invoice-run',
  useParams: () => useParamsMock(),
  useSearchParams: () => useSearchParamsMock(),
}));

import { screen, waitFor } from '@testing-library/react';

import InvoiceRunPage from '@/app/lawfirm/[lawFirmId]/billing/invoice-run/page';
import { setupApiMock, type RecordedCall } from '../../../support/apiMock';
import { renderWithProviders } from '../../../support/renderWithProviders';
import type { FirmUnbilledSummary } from '@/services/billing.service';
import type { MatterClient } from '@/types';

const FIRM = 'firm-a';
const API = 'http://localhost:5001/api';
const SUMMARIES_PATH = `${API}/lawfirms/${FIRM}/billing/invoices/firm/unbilled-summaries`;
/** The batch route. Every matter on the run is named in its `matterIds`. */
const BATCH_PATH = `/lawfirms/${FIRM}/matters/clients`;

/**
 * The shape the page used to fan out, one per matter. Nothing registers a
 * handler for it, so a request to it is recorded as unhandled and fails the
 * spec at `restore()` even if the count assertion were somehow missed.
 */
const PER_MATTER = new RegExp(`/lawfirms/${FIRM}/matters/[^/]+/clients$`);

const api = setupApiMock();

function matterSummary(id: string, name = `Matter ${id}`): FirmUnbilledSummary {
  return {
    type: 'matter',
    entityId: id,
    name,
    unbilledHours: 2,
    unbilledFlatFees: 0,
    unbilledTimeAmount: 500,
    unbilledAmount: 500,
  };
}

function clientSummary(id: string, name = `Client ${id}`): FirmUnbilledSummary {
  return { ...matterSummary(id, name), type: 'client' };
}

function matterClient(
  matterId: string,
  id: string,
  name: string,
  billingPortionBp: number | null,
): MatterClient {
  return { id, name, billingPortionBp, lawFirmId: FIRM, matterId };
}

/** The matter ids a recorded batch call named, in the order it sent them. */
function requestedIds(call: RecordedCall): string[] {
  return (call.query.matterIds?.[0] ?? '').split(',').filter(Boolean);
}

beforeEach(() => {
  useParamsMock.mockReturnValue({ lawFirmId: FIRM });
  useSearchParamsMock.mockReturnValue(new URLSearchParams());
});

describe('invoice-run payer splits', () => {
  it('reads every matter\'s clients in ONE batch request, never one request per matter', async () => {
    const summaries = Array.from({ length: 12 }, (_, i) => matterSummary(`matter-${i}`));
    api.getExact(SUMMARIES_PATH, { summaries });
    api.get(BATCH_PATH, {
      clientsByMatterId: Object.fromEntries(
        summaries.map((summary) => [summary.entityId, [matterClient(summary.entityId, 'c-1', 'Sole Payer', null)]]),
      ),
    });

    renderWithProviders(<InvoiceRunPage />);

    await waitFor(() => expect(screen.getByText('Matter matter-11')).toBeInTheDocument());

    // The whole point. A per-matter map would make this twelve, and every one of
    // those requests would also be unhandled against this mock.
    const batchCalls = api.callsTo('/matters/clients');
    expect(batchCalls).toHaveLength(1);
    expect(requestedIds(batchCalls[0])).toEqual(summaries.map((summary) => summary.entityId));
    expect(api.calls().filter((call) => PER_MATTER.test(call.pathname))).toHaveLength(0);
  });

  it('splits a matter whose shares total 100%, and leaves one that does not alone', async () => {
    api.getExact(SUMMARIES_PATH, {
      summaries: [
        matterSummary('matter-split', 'Split Matter'),
        matterSummary('matter-uneven', 'Uneven Matter'),
        matterSummary('matter-single', 'Single Payer Matter'),
        matterSummary('matter-empty', 'No Clients Matter'),
        clientSummary('client-direct', 'Direct Client'),
      ],
    });
    api.get(BATCH_PATH, {
      clientsByMatterId: {
        'matter-split': [
          matterClient('matter-split', 'c-1', 'Acme Co', 6500),
          matterClient('matter-split', 'c-2', 'Beta LLC', 3500),
        ],
        // 60% + 30%: a half-configured split. The server would bill this as one
        // invoice, so the page must not promise two.
        'matter-uneven': [
          matterClient('matter-uneven', 'c-3', 'Gamma Inc', 6000),
          matterClient('matter-uneven', 'c-4', 'Delta Ltd', 3000),
        ],
        'matter-single': [matterClient('matter-single', 'c-5', 'Only Payer', 10000)],
        'matter-empty': [],
      },
    });

    renderWithProviders(<InvoiceRunPage />);

    await waitFor(() => expect(screen.getByText('Split Matter')).toBeInTheDocument());

    expect(screen.getByText('Split into 2 invoices:')).toBeInTheDocument();
    expect(screen.getByText('Acme Co · 65%')).toBeInTheDocument();
    expect(screen.getByText('Beta LLC · 35%')).toBeInTheDocument();
    // One split matter only: the uneven, single-client, empty and client-context
    // targets all stay unsplit.
    expect(screen.getAllByText(/Split into/)).toHaveLength(1);
    expect(screen.queryByText('Gamma Inc · 60%')).not.toBeInTheDocument();
    expect(screen.queryByText('Only Payer · 100%')).not.toBeInTheDocument();

    // Five targets, four of them matters, one invoice each plus the split's
    // second payer.
    expect(screen.getByText('5 of 5 selected')).toBeInTheDocument();
    expect(screen.getByText('Create 6 drafts')).toBeInTheDocument();

    // A client-context target is not a matter, so it is never asked about.
    expect(requestedIds(api.callsTo('/matters/clients')[0])).toEqual([
      'matter-split', 'matter-uneven', 'matter-single', 'matter-empty',
    ]);
  });

  it('bills a matter the caller cannot read without a split, rather than breaking the run', async () => {
    api.getExact(SUMMARIES_PATH, {
      summaries: [matterSummary('matter-hidden', 'Hidden Matter'), matterSummary('matter-split', 'Split Matter')],
    });
    // `matter-hidden` is absent from the map, which is how the batch route says
    // the caller may not read it. The per-matter route answered 403 instead.
    api.get(BATCH_PATH, {
      clientsByMatterId: {
        'matter-split': [
          matterClient('matter-split', 'c-1', 'Acme Co', 5000),
          matterClient('matter-split', 'c-2', 'Beta LLC', 5000),
        ],
      },
    });

    renderWithProviders(<InvoiceRunPage />);

    await waitFor(() => expect(screen.getByText('Hidden Matter')).toBeInTheDocument());

    expect(screen.getByText('Acme Co · 50%')).toBeInTheDocument();
    expect(screen.getAllByText(/Split into/)).toHaveLength(1);
    // Two targets, three drafts: the split one plus the unreadable one, billed
    // whole.
    expect(screen.getByText('2 of 2 selected')).toBeInTheDocument();
    expect(screen.getByText('Create 3 drafts')).toBeInTheDocument();
  });

  it('chunks a run past the route\'s hundred-id cap, and sends the chunks one after another', async () => {
    const summaries = Array.from({ length: 101 }, (_, i) => matterSummary(`matter-${String(i).padStart(3, '0')}`));
    api.getExact(SUMMARIES_PATH, { summaries });

    // Over a hundred ids the route answers 400, so the cap is the contract, not
    // a preference. Firing the chunks together would restore exactly the pool
    // pressure the batch exists to remove, so in-flight must never exceed one.
    let inFlight = 0;
    let peakInFlight = 0;
    api.get(BATCH_PATH, async (call) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return {
        clientsByMatterId: Object.fromEntries(
          requestedIds(call).map((id) => [id, [matterClient(id, `c-${id}`, `Payer ${id}`, null)]]),
        ),
      };
    });

    renderWithProviders(<InvoiceRunPage />);

    await waitFor(() => expect(screen.getByText('Matter matter-100')).toBeInTheDocument());

    const batchCalls = api.callsTo('/matters/clients');
    expect(batchCalls).toHaveLength(2);
    expect(requestedIds(batchCalls[0])).toHaveLength(100);
    expect(requestedIds(batchCalls[1])).toEqual(['matter-100']);
    expect(peakInFlight).toBe(1);
  });
});
