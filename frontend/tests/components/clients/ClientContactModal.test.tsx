/**
 * Organization roster relationship editing.
 *
 * The list tests prove that the badges render. These cases drive the actual
 * relationship form and assert the link-owned flags sent to the service, so a
 * reordered checkbox or a payload that edits the person instead of the link
 * cannot quietly pass.
 */
import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../support/renderWithProviders';
import { deferred } from '../../support/deferred';

const mockUpdateClientContact = jest.fn();

jest.mock('@/services/clients.service', () => ({
  __esModule: true,
  default: {
    updateClientContact: (...args: unknown[]) => mockUpdateClientContact(...args),
  },
}));

import ClientContactModal from '@/components/clientComp/ClientContactModal';

const LINK = {
  id: 'link-1',
  personClientId: 'person-1',
  name: 'Bea Billing',
  email: 'bea@acme.test',
  phone: null,
  relationship: 'Controller',
  isPrimary: false,
  isEmailRecipient: true,
  canViewBilling: false,
};

function renderEditor() {
  return renderWithProviders(
    <ClientContactModal
      open
      onClose={jest.fn()}
      onSaved={jest.fn()}
      lawFirmId="firm-1"
      clientId="org-1"
      clientType="company"
      editing={LINK}
      otherEmailRecipientCount={1}
    />,
  );
}

function checkboxFor(label: string): HTMLElement {
  const checkbox = screen.getByText(label).closest('label')?.querySelector('input');
  if (!checkbox) throw new Error(`No checkbox for ${label}`);
  return checkbox;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateClientContact.mockResolvedValue({});
});

describe('ClientContactModal organization relationship editor', () => {
  it('sends relationship flags as a link update without identity fields', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(checkboxFor('Primary contact'));
    await user.click(checkboxFor('Can view billing'));
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(mockUpdateClientContact).toHaveBeenCalled());
    expect(mockUpdateClientContact).toHaveBeenCalledWith('firm-1', 'org-1', 'link-1', {
      relationship: 'Controller',
      isPrimary: true,
      isEmailRecipient: true,
      canViewBilling: true,
    });
  });

  it('can revoke billing visibility while retaining email delivery', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(checkboxFor('Can view billing'));
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(mockUpdateClientContact).toHaveBeenCalled());
    const payload = mockUpdateClientContact.mock.calls[0][3];
    expect(payload.canViewBilling).toBe(true);
    expect(payload.isEmailRecipient).toBe(true);
    expect(payload.name).toBeUndefined();
    expect(payload.email).toBeUndefined();
  });
});

describe('Escape while the save is in flight', () => {
  // Red if: the dialog stays dismissible (or its Cancel stays live) during the
  // save, so Escape abandons it and a refused save reports its error into a
  // closed dialog.
  it('does not close the dialog until the save settles', async () => {
    const pending = deferred<unknown>();
    mockUpdateClientContact.mockReturnValueOnce(pending.promise);
    const onClose = jest.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <ClientContactModal
        open
        onClose={onClose}
        onSaved={jest.fn()}
        lawFirmId="firm-1"
        clientId="org-1"
        clientType="company"
        editing={LINK}
        otherEmailRecipientCount={1}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(mockUpdateClientContact).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await act(async () => pending.resolve({}));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
