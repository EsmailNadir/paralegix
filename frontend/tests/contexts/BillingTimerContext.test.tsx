/**
 * `BillingTimerProvider`: the firm-wide time entry modal it hosts can end in
 * "Save and bill", which sends the person to the invoice composer.
 *
 * The composer needs `billing.manageInvoices`, which `billing.manageTimeEntries`
 * does not imply, so the redirect has to be withheld from a member who only
 * holds the latter. Red if the redirect fires on time-entry rights alone: that
 * member would land on the composer's access-denied state.
 *
 * `TimeEntryModal` is stubbed to a single button that reports a save-and-bill
 * result, since the modal's own form is covered elsewhere and the behaviour
 * under test is what the provider does with that result.
 */
const mockNavigate = jest.fn();

jest.mock('@/contexts/NavigationContext', () => ({
  __esModule: true,
  useNavigation: () => ({ navigate: mockNavigate, isNavigating: false }),
}));

jest.mock('@/hooks/billingHooks/useTimer', () => ({
  __esModule: true,
  default: () => ({
    isActive: false,
    isRunning: false,
    targetLabel: '',
    formattedTime: '00:00:00',
    description: '',
    pause: jest.fn(),
    resume: jest.fn(),
    discard: jest.fn(),
    updateDescription: jest.fn(),
  }),
}));

jest.mock('@/hooks/useUsers', () => ({ __esModule: true, useLawFirmUsers: () => ({ users: [] }) }));
jest.mock('@/hooks/chargeCodeHooks/useChargeCodes', () => ({ __esModule: true, default: () => ({ chargeCodes: [] }) }));

jest.mock('@/components/billingComp/TimeEntryModal', () => ({
  __esModule: true,
  default: ({ onSuccess }: { onSuccess?: (result: unknown) => void }) => (
    <button
      type="button"
      onClick={() =>
        onSuccess?.({
          shouldBillNow: true,
          draftItem: { timeEntryId: 'te-1', matterId: 'matter-1' },
        })
      }
    >
      Stub save and bill
    </button>
  ),
}));

import React from 'react';
import { fireEvent, screen } from '@testing-library/react';
import { BillingTimerProvider } from '@/contexts/BillingTimerContext';
import { renderWithProviders } from '../support/renderWithProviders';
import { grantPermissions, resetPermissions } from '../support/permissions';

function renderProvider() {
  return renderWithProviders(
    <BillingTimerProvider lawFirmId="firm-1">
      <div />
    </BillingTimerProvider>,
  );
}

beforeEach(() => {
  mockNavigate.mockReset();
});

afterEach(() => {
  resetPermissions();
});

describe('save-and-bill redirect', () => {
  it('does not open the composer for a member without billing.manageInvoices', () => {
    grantPermissions(['billing.manageTimeEntries']);
    renderProvider();

    fireEvent.click(screen.getByRole('button', { name: 'Stub save and bill' }));

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('opens the matter composer with the new entry when billing.manageInvoices is held', () => {
    grantPermissions(['billing.manageTimeEntries', 'billing.manageInvoices']);
    renderProvider();

    fireEvent.click(screen.getByRole('button', { name: 'Stub save and bill' }));

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate.mock.calls[0][0]).toContain('/lawfirm/firm-1/matters/matter-1/generate-invoice');
    expect(mockNavigate.mock.calls[0][0]).toContain('draftId=te-1');
  });
});
