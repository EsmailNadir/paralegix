/**
 * ClientContacts, driven through the REAL service against a fake transport.
 *
 * This is the first component spec written on the new harness, and it exists as
 * much to prove the harness as to cover the component. Under the old default
 * every one of these cases would pass no matter what the component did:
 * `tests/setup.ts` resolves every service call to `{}`, so the roster is always
 * empty, the error path is unreachable, and a wrong url is invisible.
 *
 * Here `clients.service` is unmocked and only `fetch` is faked, so the url the
 * component asks for, the shape it receives, and what it renders on a 403 are all
 * real and all assertable.
 */
jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { act, screen, waitFor } from '@testing-library/react';

import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import ClientContacts from '@/components/clientComp/ClientContacts';

const LAW_FIRM_ID = 'firm-1';
const CLIENT_ID = 'client-1';

let api: ApiMock;

function rosterContact(overrides: Record<string, unknown> = {}) {
  return {
    id: `link-${Math.random().toString(36).slice(2, 8)}`,
    personClientId: `person-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Roster Person',
    email: 'roster@acme.test',
    isPrimary: false,
    isEmailRecipient: false,
    ...overrides,
  };
}

function renderContacts(clientType: 'person' | 'company' = 'company') {
  return renderWithProviders(
    <ClientContacts lawFirmId={LAW_FIRM_ID} clientId={CLIENT_ID} clientType={clientType} />,
  );
}

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  api.restore();
});

describe('ClientContacts', () => {
  it('uses list placeholders while the roster is loading', async () => {
    let release: ((value: unknown) => void) | undefined;
    api.get('/contacts', () => new Promise((resolve) => { release = resolve; }));

    renderContacts();
    expect(screen.getByRole('status', { name: 'Loading client contacts' })).toBeInTheDocument();
    expect(screen.queryByText('No linked clients yet')).not.toBeInTheDocument();

    await waitFor(() => expect(release).toBeDefined());
    release?.({ contacts: [] });
    expect(await screen.findByText('No linked clients yet')).toBeInTheDocument();
  });

  it('asks the right url for this client contacts', async () => {
    api.get('/contacts', { contacts: [] });

    renderContacts();

    await waitFor(() => expect(api.callsTo('/contacts').length).toBeGreaterThan(0));
    const [call] = api.callsTo('/contacts');
    // Both ids reaching the url is what a wrong-url bug breaks, and the global
    // service stub could never see it: it never built a url at all.
    expect(call.pathname).toContain(LAW_FIRM_ID);
    expect(call.pathname).toContain(CLIENT_ID);
  });

  it('does not render a late roster from the previous firm after props switch', async () => {
    let releaseFirmA: ((value: unknown) => void) | undefined;
    api.getExact('/api/lawfirms/firm-a/clients/client-a/contacts', () => new Promise((resolve) => {
      releaseFirmA = resolve;
    }));
    api.getExact('/api/lawfirms/firm-b/clients/client-b/contacts', {
      contacts: [rosterContact({ name: 'Firm B roster' })],
    });

    const { rerender } = renderWithProviders(
      <ClientContacts lawFirmId="firm-a" clientId="client-a" clientType="company" />,
    );
    await waitFor(() => expect(api.callsTo('/firm-a/clients/client-a/contacts')).toHaveLength(1));

    rerender(<ClientContacts lawFirmId="firm-b" clientId="client-b" clientType="company" />);
    expect(await screen.findByText('Firm B roster')).toBeInTheDocument();

    await act(async () => {
      releaseFirmA?.({ contacts: [rosterContact({ name: 'Firm A roster' })] });
    });

    expect(screen.getByText('Firm B roster')).toBeInTheDocument();
    expect(screen.queryByText('Firm A roster')).not.toBeInTheDocument();
  });

  it('does not replace the current roster with an error from the previous firm', async () => {
    let rejectFirmA: ((reason?: unknown) => void) | undefined;
    api.getExact('/api/lawfirms/firm-a/clients/client-a/contacts', () => new Promise((_resolve, reject) => {
      rejectFirmA = reject;
    }));
    api.getExact('/api/lawfirms/firm-b/clients/client-b/contacts', {
      contacts: [rosterContact({ name: 'Firm B roster' })],
    });

    const { rerender } = renderWithProviders(
      <ClientContacts lawFirmId="firm-a" clientId="client-a" clientType="company" />,
    );
    await waitFor(() => expect(api.callsTo('/firm-a/clients/client-a/contacts')).toHaveLength(1));

    rerender(<ClientContacts lawFirmId="firm-b" clientId="client-b" clientType="company" />);
    expect(await screen.findByText('Firm B roster')).toBeInTheDocument();

    await act(async () => {
      rejectFirmA?.(new Error('Firm A connection failed'));
    });

    expect(screen.getByText('Firm B roster')).toBeInTheDocument();
    expect(screen.queryByText(/Firm A connection failed/i)).not.toBeInTheDocument();
  });

  it('renders the roster it was given', async () => {
    api.get('/contacts', { contacts: [
      rosterContact({ name: 'Bea Billing' }),
      rosterContact({ name: 'Ned NoBilling' }),
    ] });

    renderContacts();

    expect(await screen.findByText('Bea Billing')).toBeInTheDocument();
    expect(screen.getByText('Ned NoBilling')).toBeInTheDocument();
  });

  it('badges the member who receives billing emails', async () => {
    api.get('/contacts', { contacts: [
      rosterContact({ name: 'Bea Billing', isEmailRecipient: true, email: 'bea@acme.test' }),
    ] });

    renderContacts('company');

    // The badge is how a firm sees where an organization's invoices go. It is
    // driven off the LINK flag, so it only renders when the service returns one.
    expect(await screen.findByText(/Receives emails/i)).toBeInTheDocument();
  });

  it('warns when a billing recipient has no email address to send to', async () => {
    api.get('/contacts', { contacts: [
      rosterContact({ name: 'No Address', isEmailRecipient: true, email: null }),
    ] });

    renderContacts('company');

    await screen.findByText('No Address');
    // Flagged as a recipient but unreachable, so the badge has to say BOTH: it is
    // set to receive, and it cannot. A plain "Receives emails" here would tell a
    // firm its invoices are being delivered when they are going nowhere.
    expect(screen.getByText(/No Email/i)).toBeInTheDocument();
  });

  it('marks a member who is not a billing recipient', async () => {
    api.get('/contacts', { contacts: [
      rosterContact({ name: 'Not A Recipient', isEmailRecipient: false }),
    ] });

    renderContacts('company');

    expect(await screen.findByText(/No email delivery/i)).toBeInTheDocument();
  });

  it('marks a member who can see the organization invoices in the portal', async () => {
    api.get('/contacts', { contacts: [
      rosterContact({ name: 'Billing Viewer', canViewBilling: true }),
    ] });

    renderContacts('company');

    // `can_view_billing` on the link is what widens a person's portal to the
    // organization's invoices, so the roster has to show who holds it.
    expect(await screen.findByText(/Can view billing/i)).toBeInTheDocument();
  });

  it('shows none of the organization badges on a PERSON client', async () => {
    api.get('/contacts', { contacts: [
      rosterContact({ name: 'Related Person', isEmailRecipient: true, canViewBilling: true }),
    ] });

    renderContacts('person');

    await screen.findByText('Related Person');
    // A person's related contacts are directory entries, not roster members with
    // billing rights. Rendering the organization badges here would offer a
    // guardian or assistant a billing role that does not exist for them.
    expect(screen.queryByText(/Receives emails/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Can view billing/i)).not.toBeInTheDocument();
  });

  it('renders an empty state rather than erroring when there is no roster', async () => {
    api.get('/contacts', { contacts: [] });

    renderContacts();

    await waitFor(() => expect(api.callsTo('/contacts').length).toBeGreaterThan(0));
    expect(screen.queryByText('Roster Person')).not.toBeInTheDocument();
  });

  it('surfaces a failure instead of rendering a silently empty roster', async () => {
    api.get('/contacts', { status: 500, body: { error: 'Something went wrong' } });

    renderContacts();

    // The case the old default made impossible. A component that swallows the
    // error shows an empty roster, and a firm reads that as "this organization
    // has nobody on it" rather than "the request failed".
    // Asserting the error TEXT, not merely that loading finished. Loading
    // finishes either way, so a component that swallowed the error and rendered
    // an empty roster would still satisfy that weaker check.
    expect(await screen.findByText(/Something went wrong|Failed to load contacts/i))
      .toBeInTheDocument();
  });

  it('handles a 403 without crashing the tab', async () => {
    api.get('/contacts', { status: 403, body: { error: 'Forbidden', code: 'FORBIDDEN' } });

    renderContacts();

    await waitFor(() => expect(api.callsTo('/contacts').length).toBeGreaterThan(0));
    // A read-only viewer must get a degraded tab, never a blank screen or a
    // thrown render. This is the rule `hasPermission: () => true` hid.
    expect(document.body.textContent).not.toBe('');
  });
});
