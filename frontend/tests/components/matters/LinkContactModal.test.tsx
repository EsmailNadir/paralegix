/**
 * Putting a contact on a matter, through the real matters service against a
 * fake transport.
 *
 * Red if the dialog can be dismissed while the link is saving: a later failure
 * would then render into a closed dialog and the firm would never see it.
 */
jest.unmock('@/services/matters.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import LinkContactModal from '@/components/matterComp/LinkContactModal';
import type { MatterContact } from '@/types';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { holdResponse } from '../../support/deferred';

const LINK = {
  id: 'link-1',
  contactId: 'contact-1',
  name: 'Jane Judge',
  role: 'judge',
  notes: null,
} as unknown as MatterContact;

let api: ApiMock;
beforeEach(() => {
  api = installApiMock();
});
afterEach(() => api.restore());

describe('Escape while the link is saving', () => {
  // Red if: the dialog stays dismissible during the save (no
  // `dismissible={!submitting}`) or Cancel stays enabled, so Escape abandons
  // the dialog mid-save.
  it('does not close the dialog until the save settles', async () => {
    const put = holdResponse();
    api.put('/matters/matter-1/contacts/link-1', put.handler);
    const onClose = jest.fn();
    const onSaved = jest.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <LinkContactModal
        open
        onClose={onClose}
        onSaved={onSaved}
        lawFirmId="firm-1"
        matterId="matter-1"
        editing={LINK}
        canCreateContact={false}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'Save Changes' }));
    await put.untilRequested();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await act(async () => put.release({ contact: LINK }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});
