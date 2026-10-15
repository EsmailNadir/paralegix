jest.mock('../../src/modules/billing/shared/billingSettings', () => ({
  getFirmBillingSettings: jest.fn(),
}));
jest.mock('../../src/shared/utils/reminderHelpers', () => ({
  forEachFirm: jest.fn(),
}));
jest.mock('../../src/modules/billing/invoices/invoices.repository', () => ({
  findUnpaidByDue: jest.fn(),
}));
jest.mock('../../src/modules/billing/invoices/invoices.service', () => ({
  applyLateFeeCore: jest.fn(),
}));

import { getFirmBillingSettings } from '../../src/modules/billing/shared/billingSettings';
import { forEachFirm } from '../../src/shared/utils/reminderHelpers';
import invoicesRepo = require('../../src/modules/billing/invoices/invoices.repository');
import invoicesService = require('../../src/modules/billing/invoices/invoices.service');
import { applyAutoLateFees } from '../../src/modules/billing/invoices/lateFees.service';

const settings = getFirmBillingSettings as jest.Mock;
const firms = forEachFirm as jest.Mock;
const repo = invoicesRepo as any;
const service = invoicesService as any;

beforeEach(() => {
  jest.clearAllMocks();
  firms.mockImplementation(async (_name, callback, options) => {
    await callback({ id: options.lawFirmId || 'firm-1' });
    return { firmsProcessed: 1, firmsTotal: 1, truncated: false };
  });
  settings.mockResolvedValue({ lateFee: { enabled: false, autoApply: false } });
  repo.findUnpaidByDue.mockResolvedValue([]);
  service.applyLateFeeCore.mockResolvedValue({ applied: true });
});

describe('applyAutoLateFees', () => {
  // Applying, skipping and counting per-invoice errors, and doing nothing while
  // automatic late fees are off, are driven against Postgres in
  // `lateFeeSweepIsolation.test.ts`. This keeps the one branch it cannot reach
  // without a fault: the firm's settings failing to load.
  it('counts settings and invoice lookup failures without aborting other firms', async () => {
    settings.mockRejectedValueOnce(new Error('settings unavailable'));
    await expect(applyAutoLateFees(null)).resolves.toMatchObject({ errors: 1, firmsProcessed: 1 });
  });
});
