/**
 * The trust account list's book-close (period lock) dialog, through the real
 * trust service against a fake transport.
 *
 * Red if the dialog can be dismissed while the lock is saving: a later failure
 * would then render into a closed dialog, and the firm would believe the
 * period was locked when it was not.
 */
jest.unmock('@/services/trust.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import TrustAccountList from '@/components/trustComp/TrustAccountList';
import type { TrustAccount } from '@/types/trust';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { holdResponse } from '../../support/deferred';

const ACCOUNT = {
  id: 'acct-1',
  name: 'Primary IOLTA',
  bankName: 'Test Bank',
  accountNumberLast4: '1234',
  accountType: 'iolta',
  status: 'active',
  bookCloseDate: '2026-06-30',
} as TrustAccount;

let api: ApiMock;
beforeEach(() => {
  api = installApiMock();
});
afterEach(() => api.restore());

describe('setting a book-close date', () => {
  // Red if: the dialog stays dismissible during the save (no
  // `dismissible={!saving}`), or the header X or Cancel stays enabled, so the
  // dialog closes mid-save. The list owns the open flag, so a close shows as
  // the dialog unmounting once its 100ms exit animation finishes.
  it('keeps the dialog open until the save settles', async () => {
    const patch = holdResponse();
    api.patch('/accounts/acct-1/book-close', patch.handler);
    const onRefresh = jest.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <TrustAccountList accounts={[ACCOUNT]} lawFirmId="firm-1" onRefresh={onRefresh} />,
    );

    await user.click(screen.getByRole('button', { name: 'Trust account actions' }));
    await user.click(await screen.findByRole('button', { name: /Set book-close date/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Set Book-Close Date' });
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await patch.untilRequested();

    fireEvent.keyDown(document, { key: 'Escape' });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    expect(screen.getByRole('dialog', { name: 'Set Book-Close Date' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await act(async () => patch.release({ account: { ...ACCOUNT } }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Set Book-Close Date' })).not.toBeInTheDocument(),
    );
  });
});
