/**
 * The New Evergreen Retainer Plan dialog awaits its create inside the open
 * dialog. While that create is in flight the dialog must not be dismissed:
 * Escape would otherwise close it, and a refused create would report its error
 * into a dialog that is no longer on screen.
 */
// A stand-in that lets the test pick a matter without driving EntityPicker's
// own typeahead (that component has its own specs).
jest.mock('@/components/ui/EntityPicker', () => ({
  __esModule: true,
  default: (props: { placeholder?: string; onChange: (id: string) => void }) => (
    <button type="button" onClick={() => props.onChange('matter-1')}>
      {props.placeholder}
    </button>
  ),
}));

import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BillingRecurringPlansPanel from '@/components/billingComp/BillingRecurringPlansPanel';
import { renderWithProviders } from '../../support/renderWithProviders';
import { deferred } from '../../support/deferred';

describe('Escape while the create is in flight', () => {
  // Red if: the dialog stays dismissible (or its Cancel stays live) while the
  // plan is being created, so Escape closes it mid-save.
  it('keeps the dialog open until the create settles', async () => {
    const pending = deferred<void>();
    const onCreatePlan = jest.fn(() => pending.promise);
    const user = userEvent.setup();
    renderWithProviders(<BillingRecurringPlansPanel lawFirmId="firm-1" plans={[]} onCreatePlan={onCreatePlan} />);

    await user.click(screen.getAllByRole('button', { name: 'Add Evergreen Retainer Plan' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'New Evergreen Retainer Plan' });
    await user.click(screen.getByRole('button', { name: 'Select a matter...' }));
    await user.type(screen.getByLabelText('Amount *'), '500');
    await user.click(screen.getByRole('button', { name: 'Create Plan' }));
    expect(onCreatePlan).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(dialog).not.toHaveClass('overlay-card-exit');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await act(async () => pending.resolve());
    await waitFor(() => expect(dialog).toHaveClass('overlay-card-exit'));
  });
});
