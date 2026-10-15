/**
 * The matter invoice composer does not read the firm user roster.
 *
 * It used to call `useLawFirmUsers` and throw the result away, spending a
 * request on every visit. What has to break for this to go red: the page
 * requesting the firm users again.
 */
jest.unmock('@/services/users.service');
jest.unmock('@/services/requestDeduplicator');

// A named export the global service mock does not provide.
jest.mock('@/services/chargeCodes.service', () => ({
  __esModule: true,
  chargeCodesService: { getChargeCodes: jest.fn().mockResolvedValue({ chargeCodes: [] }) },
}));

// No matter record: the page settles on its not-found state without rendering
// the composer, which is all this spec needs.
jest.mock('@/services/matters.service', () => ({
  __esModule: true,
  default: new Proxy({}, {
    get: (_target, prop) => (prop === 'listClients'
      ? jest.fn().mockResolvedValue([])
      : jest.fn().mockResolvedValue(null)),
  }),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/lawfirm/firm-a/matters/matter-a/generate-invoice',
  useParams: () => ({ lawFirmId: 'firm-a', matterId: 'matter-a' }),
  useSearchParams: () => new URLSearchParams(),
}));

import MatterGenerateInvoicePage from '@/app/lawfirm/[lawFirmId]/matters/[matterId]/generate-invoice/page';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { setupApiMock } from '../../../support/apiMock';

const api = setupApiMock();

beforeEach(() => {
  // Every other read on the page is not the subject.
  api.allowUnhandled();
});

it('opens without requesting the firm user roster', async () => {
  const { unmount } = renderWithProviders(<MatterGenerateInvoicePage />);
  await new Promise((resolve) => setTimeout(resolve, 100));
  unmount();

  expect(api.callsTo('/users/lawfirm/firm-a/users')).toHaveLength(0);
});
