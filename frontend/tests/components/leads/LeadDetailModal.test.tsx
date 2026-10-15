/**
 * The lead dialog, through the REAL leads transport.
 *
 * Both of its writes (saving the lead, and sending an intake form) run inside
 * the open dialog. While either is in flight the dialog must not be dismissed:
 * Escape would otherwise abandon the request, and a refused one would report
 * its error into a dialog that is no longer on screen.
 */
jest.unmock('@/services/requestDeduplicator');
jest.mock('@/components/clientComp/ClientOrganizationAutocomplete', () => ({
  __esModule: true,
  default: ({ id, value, onChange }: { id?: string; value: string; onChange: (v: string) => void }) => (
    <input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

import React from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LeadDetailModal from '@/components/leadComp/LeadDetailModal';
import type { Lead } from '@/types';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import { holdResponse } from '../../support/deferred';

const LEAD = { id: 'lead-1', name: 'Jane Roe', email: 'jane@example.com' } as Lead;

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  api.get('/lawfirms/firm-1/lead-stages', { stages: [] });
  api.get('/lawfirms/firm-1/intake-forms', {
    templates: [{ id: 'form-1', name: 'New client intake', publicToken: 't', fields: [], isActive: true }],
  });
  api.get('/lawfirms/firm-1/leads/lead-1', { lead: LEAD });
});

afterEach(() => api.restore());

// While the intake form is shown, its own toggle also reads "Cancel"; the
// dialog's footer Cancel is the one beside the save button.
function footerCancel(): HTMLElement {
  const save = screen.getByRole('button', { name: 'Save changes' });
  return within(save.parentElement as HTMLElement).getByRole('button', { name: 'Cancel' });
}

describe('Escape while the save is in flight', () => {
  // Red if: the dialog stays dismissible while the lead is being created, so
  // Escape abandons it and a refused save reports its error into a closed dialog.
  it('does not close the dialog until the lead save settles', async () => {
    const post = holdResponse();
    api.post('/lawfirms/firm-1/leads', post.handler);
    const onClose = jest.fn();
    const user = userEvent.setup();
    renderWithProviders(<LeadDetailModal open onClose={onClose} lawFirmId="firm-1" lead={null} />);

    await user.type(screen.getByLabelText('Name *'), 'Jane Roe');
    await user.click(screen.getByRole('button', { name: 'Add Lead' }));
    await post.untilRequested();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await act(async () => post.release({ message: 'ok', leadId: 'lead-1', lead: LEAD }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  // Red if: the dialog stays dismissible (or its footer Cancel stays live)
  // while the intake form is being sent, so a failed send reports into a
  // closed dialog.
  it('does not close the dialog until the intake form send settles', async () => {
    const send = holdResponse();
    api.post('/lawfirms/firm-1/leads/lead-1/send-intake-form', send.handler);
    const onClose = jest.fn();
    const user = userEvent.setup();
    renderWithProviders(<LeadDetailModal open onClose={onClose} lawFirmId="firm-1" lead={LEAD} />);

    await user.click(await screen.findByRole('button', { name: 'Send intake form' }));
    await user.click(screen.getByRole('button', { name: /^Form/ }));
    await user.click(await screen.findByRole('option', { name: 'New client intake' }));
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await send.untilRequested();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(footerCancel()).toBeDisabled();

    await act(async () => send.release({ message: 'sent' }));
    // A sent intake form leaves the dialog open with its form collapsed again.
    expect(await screen.findByRole('button', { name: 'Send intake form' })).toBeInTheDocument();
    expect(footerCancel()).toBeEnabled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
