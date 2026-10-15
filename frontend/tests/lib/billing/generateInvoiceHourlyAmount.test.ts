/**
 * generateInvoiceFromUnbilled prices an hourly line like the stored time entry amount (round half up).
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import billingService from '@/services/billing.service';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

let api: ApiMock;
beforeEach(() => { api = installApiMock(); __resetDuplicateRequestGuard(); });
afterEach(() => api.restore());

it('sends 0.3 h at $123.45 as 37.04 (3704 cents), the same as the stored entry', async () => {
  const ctx = { type: 'matter' as const, entityId: 'matter-9', lawFirmId: 'firm-1' };
  api.get('/invoices/matter/matter-9/unbilled-summary', () => ({
    unbilledTimeEntries: [{ id: 'te-1', userId: 'u1', userName: 'A', hours: 0.3, date: '2026-03-01', name: 'N', description: 'D' }],
    unbilledFlatFees: [], totalUnbilledHours: 0.3, totalUnbilledFlatFees: 0,
  }));
  api.post('/invoices', { invoice: { id: 'inv-new' } });
  await billingService.generateInvoiceFromUnbilled(ctx, {
    invoiceName: 'M', invoiceDate: '2026-03-31', selectedTimeEntryIds: ['te-1'], selectedFlatFeeIds: [],
    timeEntryRates: { 'te-1': 123.45 },
  });
  const line = ((api.calls('POST')[0].body as any).timeEntries as Array<{ amount: number }>)[0];
  expect(line.amount).toBe(37.04);
});
