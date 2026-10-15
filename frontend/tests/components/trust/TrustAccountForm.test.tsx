/**
 * The trust account form while its save is in flight, through the real trust
 * transport. A save that is still pending must keep the dialog on screen:
 * otherwise Escape abandons it and a refused save reports into a closed dialog.
 */
jest.unmock('@/services/trust.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import { holdResponse } from '../../support/deferred';
import TrustAccountForm from '@/components/trustComp/TrustAccountForm';
import type { TrustAccount } from '@/types/trust';

const ACCOUNT = {
  id: 'acct-1',
  name: 'Main IOLTA',
  bankName: 'First Bank',
  accountNumberLast4: '1234',
  accountType: 'iolta',
  status: 'active',
} as unknown as TrustAccount;

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => api.restore());

describe('Escape while the account is being saved', () => {
  // Red if: the dialog stays dismissible (or Cancel stays enabled) while the
  // PUT is in flight, so Escape closes the dialog mid-save.
  it('keeps the dialog open and Cancel disabled until the save settles', async () => {
    const put = holdResponse();
    api.put('/accounts/acct-1', put.handler);
    const onClose = jest.fn();
    const onSaved = jest.fn();
    renderWithProviders(
      <TrustAccountForm open lawFirmId="firm-1" account={ACCOUNT} onClose={onClose} onSaved={onSaved} />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await put.untilRequested();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await act(async () => put.release({ account: ACCOUNT }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
  });
});
