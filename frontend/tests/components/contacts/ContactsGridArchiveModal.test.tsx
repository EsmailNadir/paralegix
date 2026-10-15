import { expectCompactListSection } from "../../support/listSectionSpacing";
/**
 * Archive confirmation modal on the ContactsGrid.
 *
 * Clicking the archive action button on a contact row prompts the user with
 * a ConfirmModal before performing the archive update, matching the behavior
 * of other confirmation modals across the app.
 */
jest.unmock('@/services/contacts.service');
jest.unmock('@/services/lawfirm.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';

import ContactsGrid from '@/components/contactsComp/ContactsGrid';
import { PermissionsProvider } from '@/contexts/PermissionsContext';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import { makeTestQueryClient } from '../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../support/apiMock';

const FIRM = 'firm-1';
const MEMBER = 'member-1';

let api: ApiMock;

function renderGrid() {
  const queryClient = makeTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <PermissionsProvider lawFirmId={FIRM} userId={MEMBER}>
        <ContactsGrid lawFirmId={FIRM} />
      </PermissionsProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api = installApiMock();
  __resetDuplicateRequestGuard();

  api.get(`/lawfirms/${FIRM}/members`, () => ({
    members: [{
      id: MEMBER,
      userId: MEMBER,
      name: 'Ada Admin',
      isOwner: false,
      permissions: ['contacts.manage'],
    }],
  }));
  api.get(`/lawfirms/${FIRM}/contacts/tags`, { tags: [] });
});

afterEach(() => {
  api.restore();
  jest.clearAllMocks();
});

describe('ContactsGrid archive confirmation modal', () => {
  it('groups the contacts heading and sort controls with 16px spacing', async () => {
    api.get(`/lawfirms/${FIRM}/contacts`, {
      contacts: [{ id: 'contact-1', name: 'Dana Kirby', category: 'adjuster', isArchived: false, tags: [] }],
      totalItems: 1,
    });
    renderGrid();
    expect(await screen.findByText('Dana Kirby')).toBeInTheDocument();
    expectCompactListSection('Contacts (1)', 'Name');
  });

  it('shows a confirmation popup when clicking the archive button on an active contact', async () => {
    const contact = {
      id: 'contact-1',
      name: 'Dana Kirby',
      category: 'adjuster',
      organization: 'Meridian Casualty',
      email: 'dkirby@meridiancas.example.test',
      phone: '+1-800-555-0134',
      matterCount: 5,
      isArchived: false,
      tags: [],
    };

    api.get(`/lawfirms/${FIRM}/contacts`, {
      contacts: [contact],
      totalItems: 1,
    });

    renderGrid();

    // Verify contact row renders
    expect(await screen.findByText('Dana Kirby')).toBeInTheDocument();

    // The archive button is present on the row
    const archiveButton = screen.getByRole('button', { name: 'Archive' });
    expect(archiveButton).toBeInTheDocument();

    // Clicking archive opens the confirmation modal
    await userEvent.click(archiveButton);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Archive Contact' })).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Are you sure you want to archive "Dana Kirby"\?/),
    ).toBeInTheDocument();

    // Modal has Cancel and Archive buttons
    const cancelButton = within(dialog).getByRole('button', { name: 'Cancel' });
    const confirmButton = within(dialog).getByRole('button', { name: 'Archive' });
    expect(cancelButton).toBeInTheDocument();
    expect(confirmButton).toBeInTheDocument();

    // Clicking Cancel closes the modal without updating the contact
    await userEvent.click(cancelButton);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    expect(api.calls('PUT')).toHaveLength(0);
  });

  it('archives the contact when confirmed in the modal', async () => {
    const contact = {
      id: 'contact-1',
      name: 'Dana Kirby',
      category: 'adjuster',
      organization: 'Meridian Casualty',
      matterCount: 5,
      isArchived: false,
      tags: [],
    };

    api.get(`/lawfirms/${FIRM}/contacts`, {
      contacts: [contact],
      totalItems: 1,
    });
    api.put(`/lawfirms/${FIRM}/contacts/contact-1`, {
      message: 'ok',
      contact: { ...contact, isArchived: true },
    });

    renderGrid();

    expect(await screen.findByText('Dana Kirby')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Archive' }));

    const dialog = await screen.findByRole('dialog');
    const confirmButton = within(dialog).getByRole('button', { name: 'Archive' });

    await userEvent.click(confirmButton);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    const putCalls = api.calls('PUT');
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].pathname).toBe(`/api/lawfirms/${FIRM}/contacts/contact-1`);
    expect(putCalls[0].body).toEqual({ isArchived: true });
  });

  it('restores an archived contact directly without opening the archive confirmation modal', async () => {
    const contact = {
      id: 'contact-2',
      name: 'Dr. Naomi Feld',
      category: 'expert',
      matterCount: 0,
      isArchived: true,
      tags: [],
    };

    api.get(`/lawfirms/${FIRM}/contacts`, {
      contacts: [contact],
      totalItems: 1,
    });
    api.put(`/lawfirms/${FIRM}/contacts/contact-2`, {
      message: 'ok',
      contact: { ...contact, isArchived: false },
    });

    renderGrid();

    expect(await screen.findByText('Dr. Naomi Feld')).toBeInTheDocument();

    const restoreButton = screen.getByRole('button', { name: 'Restore' });
    expect(restoreButton).toBeInTheDocument();

    await userEvent.click(restoreButton);

    // No modal should be opened for restore
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    const putCalls = api.calls('PUT');
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].pathname).toBe(`/api/lawfirms/${FIRM}/contacts/contact-2`);
    expect(putCalls[0].body).toEqual({ isArchived: false });
  });
});
