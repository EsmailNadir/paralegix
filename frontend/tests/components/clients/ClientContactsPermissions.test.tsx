/**
 * What a NARROW role sees on the contacts tab.
 *
 * This is the first spec in the repo to run a component against a real
 * permission set. `tests/setup.ts` forces `hasPermission: () => true` for every
 * other spec, so the product's read-only rule (a narrow role gets a degraded
 * page, never a denial screen) has never been checked by anything.
 *
 * Mutating controls must follow the same clients.manage permission as the API.
 */
jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { screen, waitFor } from '@testing-library/react';

import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import { grantPermissions, grantReadOnly, grantOutsider, resetPermissions } from '../../support/permissions';
import ClientContacts from '@/components/clientComp/ClientContacts';

const LAW_FIRM_ID = 'firm-1';
const CLIENT_ID = 'client-1';

let api: ApiMock;

const ROSTER = {
  contacts: [{
    id: 'link-1',
    personClientId: 'person-1',
    name: 'Roster Person',
    email: 'roster@acme.test',
    isPrimary: true,
    isEmailRecipient: true,
  }],
};

function renderContacts(clientType: 'person' | 'company' = 'company') {
  return renderWithProviders(
    <ClientContacts lawFirmId={LAW_FIRM_ID} clientId={CLIENT_ID} clientType={clientType} />,
  );
}

beforeEach(() => {
  api = installApiMock();
  // Every permission case below is tenant-sensitive. A broad `/contacts`
  // handler would also satisfy a request for another firm or client and make
  // the UI look correctly restricted while reading the wrong roster.
  api.getExact(`/api/lawfirms/${LAW_FIRM_ID}/clients/${CLIENT_ID}/contacts`, ROSTER);
});

afterEach(() => {
  api.restore();
  // Mandatory. The permission object is module-level and shared, so a spec that
  // narrows it and does not restore hands the NEXT spec a viewer who can do
  // nothing, and that failure surfaces somewhere unrelated.
  resetPermissions();
});

describe('a viewer who can read but not manage clients', () => {
  beforeEach(() => grantReadOnly());

  it('still sees the roster', async () => {
    renderContacts();

    // The rule this repo follows: degrade to read-only, never show a denial
    // screen. A narrow role that sees nothing here would read the organization
    // as empty rather than as restricted.
    expect(await screen.findByText('Roster Person')).toBeInTheDocument();
  });

  it('does not get the manage-portal-access control', async () => {
    renderContacts();

    await screen.findByText('Roster Person');
    // Portal access is the one control on this tab actually gated by
    // `clients.manage`. It grants a person a login, so it is correctly hidden.
    expect(screen.queryByText(/Manage portal access/i)).not.toBeInTheDocument();
  });

  it('hides add, edit, and remove controls', async () => {
    renderContacts();

    await screen.findByText('Roster Person');
    expect(screen.queryByRole('button', { name: /Add Client/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove/i })).not.toBeInTheDocument();
  });
});

describe('a caller who is not a member of this firm', () => {
  // An empty permission list is reachable for exactly one person: a non-member.
  // Every real member carries the baseline, so this is an outsider rather than a
  // narrow role.
  beforeEach(() => grantOutsider());

  it('renders the tab rather than crashing or blanking', async () => {
    renderContacts();

    // The floor. Whatever else is hidden, the component must not throw and must
    // not render an empty document: both look like a broken app rather than a
    // restricted one.
    await waitFor(() => expect(api.callsTo('/contacts').length).toBeGreaterThan(0));
    expect(await screen.findByText(/Related Clients/i)).toBeInTheDocument();
  });
});

describe('a viewer holding clients.manage', () => {
  beforeEach(() => grantPermissions(['clients.view', 'clients.manage']));

  it('gets the manage-portal-access control', async () => {
    renderContacts();

    await screen.findByText('Roster Person');
    // The positive half. Without it, a component that hid the control from
    // EVERYONE would pass the negative case above and nobody would notice.
    expect(await screen.findByText(/Manage portal access/i)).toBeInTheDocument();
  });
});
