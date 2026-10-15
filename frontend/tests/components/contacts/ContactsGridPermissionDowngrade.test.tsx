/**
 * A role downgrade that lands while an edit form is open.
 *
 * The dangerous shape is not the denial, it is the gap. A member opens the
 * contact form while they hold `contacts.manage`, an admin takes the permission
 * away, and the form is still on screen with the user's typing in it. Two things
 * have to happen: the controls that offer the action have to disappear, and the
 * submit that is already on screen has to be refused by the server without the
 * page showing a saved row or a success state it cannot back up.
 *
 * The real `PermissionsProvider` resolves the permission set here, and the real
 * `contactsService` makes the request. Only the transport is faked, so the
 * refusal is an actual 403 travelling the actual service.
 */
jest.unmock('@/contexts/PermissionsContext');
jest.unmock('@/services/lawfirm.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';

import ContactsGrid from '@/components/contactsComp/ContactsGrid';
import { PermissionsProvider, usePermissions } from '@/contexts/PermissionsContext';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import { makeTestQueryClient } from '../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../support/apiMock';

const FIRM = 'firm-a';
const MEMBER = 'member-a';

let api: ApiMock;
/** Swapped between renders to model an admin changing this member's role. */
let currentPermissions: string[] = [];

/** Exposes the provider's own refresh, which is how the app learns of a change. */
function RefreshProbe() {
  const { refresh } = usePermissions();
  return <button type="button" onClick={() => { void refresh(); }}>reload permissions</button>;
}

function renderGrid() {
  const queryClient = makeTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <PermissionsProvider lawFirmId={FIRM} userId={MEMBER}>
        <RefreshProbe />
        <ContactsGrid lawFirmId={FIRM} />
      </PermissionsProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api = installApiMock();
  __resetDuplicateRequestGuard();
  currentPermissions = ['contacts.manage'];

  api.get(`/lawfirms/${FIRM}/members/me`, () => ({
    member: {
      id: MEMBER,
      userId: MEMBER,
      name: 'Ada Admin',
      isOwner: false,
      permissions: currentPermissions,
    },
  }));
  api.get(`/lawfirms/${FIRM}/contacts/tags`, { tags: [] });
  api.get(`/lawfirms/${FIRM}/contacts`, { contacts: [], totalItems: 0 });
  api.get('/contacts/duplicate-check', { duplicates: [] });
});

afterEach(() => {
  api.restore();
  jest.clearAllMocks();
});

describe('a role downgrade while the contact form is open', () => {
  it('withdraws the create control and refuses the submit already on screen', async () => {
    renderGrid();

    const newContact = await screen.findByRole('button', { name: /new contact/i });
    await userEvent.click(newContact);

    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name *'), 'Opposing Counsel');

    // The admin takes the permission away, and the backend starts refusing.
    currentPermissions = [];
    api.post(`/lawfirms/${FIRM}/contacts`, {
      status: 403,
      body: { error: 'You do not have permission to manage contacts.', code: 'FORBIDDEN' },
    });
    await userEvent.click(screen.getByRole('button', { name: /reload permissions/i }));

    // The control that offers the action is gone.
    await waitFor(() => expect(
      screen.queryByRole('button', { name: /new contact/i }),
    ).not.toBeInTheDocument());

    // The form the member already had open still submits, and is refused.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create Contact' }));

    await waitFor(() => expect(
      within(dialog).getByText(/do not have permission/i),
    ).toBeInTheDocument());

    // No saved row, and the form stayed open holding what was typed, so the
    // member does not lose their work to a refusal.
    expect(screen.queryByText('Opposing Counsel', { selector: 'td *' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue('Opposing Counsel')).toBeInTheDocument();
    expect(api.calls('POST').filter((c) => c.pathname.endsWith('/contacts'))).toHaveLength(1);
  });
});
