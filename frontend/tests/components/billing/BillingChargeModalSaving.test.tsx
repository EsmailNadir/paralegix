jest.unmock('@/services/billing.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import AddExpenseModal from '@/components/billingComp/AddExpenseModal';
import AddFlatFeeModal from '@/components/billingComp/AddFlatFeeModal';
import { installApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';

jest.mock('@/components/ui/EntityPicker', () => ({
  __esModule: true,
  default: function MockEntityPicker(props: any) {
    return <select aria-label={props.label} value={props.value} onChange={event => props.onChange(event.target.value)}>
      <option value="">Select a matter</option><option value="matter-1">Matter One</option>
    </select>;
  },
}));

describe.each([
  { name: 'Expense', Component: AddExpenseModal, path: 'expenses', result: { expense: { id: 'charge-1' } } },
  { name: 'Flat Fee', Component: AddFlatFeeModal, path: 'flat-fees', result: { flatFee: { id: 'charge-1' } } },
])('$name save lifecycle', ({ name, Component, path, result }) => {
  it.each(['Cancel', 'Close', 'Escape', 'backdrop'])('blocks %s while saving and closes once after success', async (dismissal) => {
    const api = installApiMock();
    let finish!: (value: unknown) => void;
    const response = new Promise(resolve => { finish = resolve; });
    api.postExact(`/api/lawfirms/firm-1/billing/${path}`, () => response);
    const onClose = jest.fn();
    const onSuccess = jest.fn();
    try {
      renderWithProviders(<Component open lawFirmId="firm-1" onClose={onClose} onSuccess={onSuccess} />);
      fireEvent.change(screen.getByRole('combobox', { name: 'Matter *' }), { target: { value: 'matter-1' } });
      fireEvent.change(screen.getByLabelText('Description *'), { target: { value: 'Filing charge' } });
      fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '150.75' } });
      fireEvent.click(screen.getByRole('button', { name: `Save ${name}` }));
      await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
      if (dismissal === 'Escape') fireEvent.keyDown(document, { key: 'Escape' });
      else if (dismissal === 'backdrop') {
        const backdrop = document.querySelector('.overlay-backdrop-enter');
        expect(backdrop).toBeInTheDocument();
        fireEvent.click(backdrop!);
      } else fireEvent.click(screen.getByRole('button', { name: dismissal }));
      expect(onClose).not.toHaveBeenCalled();
      await act(async () => { finish(result); await response; });
      await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => { finish(result); await response; });
      api.restore();
    }
  });
});
