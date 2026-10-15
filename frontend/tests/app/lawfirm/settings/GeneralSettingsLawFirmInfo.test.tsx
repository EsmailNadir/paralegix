/**
 * Editing the firm's contact details in Settings > General > Law Firm Information.
 *
 * Driven through the real law firm service with only the transport faked, and
 * the real LawFirmContext so the spec owns `refetchLawFirm` and the firm the
 * page reads.
 *
 * What has to break for this to go red: the save dropping a field or sending
 * an empty string where clearing it needs null; the shared firm record not
 * being refreshed after a save, so every other page keeps the old firm; the
 * save's outcome reported anywhere but inside this card; a failed save closing
 * the form or losing what was typed; the form re-seeding from the shared record
 * while it is open; the state picker not offering the states, not preselecting
 * a stored code, or silently dropping a stored value it does not recognise;
 * the ZIP not filling an empty State, or overwriting a state that was stored or
 * picked by hand; the address fields losing their browser autofill hints;
 * Enter in a field not saving; or the open form failing the accessibility scan.
 */
jest.unmock('@/services/lawfirm.service');
jest.unmock('@/services/requestDeduplicator');
jest.unmock('@/contexts/LawFirmContext');

import React, { useState } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GeneralSettingsPage from '@/app/lawfirm/[lawFirmId]/settings/general/page';
import LawFirmService from '@/services/lawfirm.service';
import { LawFirmContext } from '@/contexts/LawFirmContext';
import type { LawFirm } from '@/types';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../../support/apiMock';
import { scanAccessibility } from '../../../support/accessibility';
import { holdResponse } from '../../../support/deferred';

const FIRM_ID = 'test-law-firm-id';
const FIRM_URL = `/api/lawfirms/${FIRM_ID}`;
const STATE_PICKER = /^State/;

let api: ApiMock;

beforeEach(() => {
  api = installApiMock().allowUnhandled();
});

afterEach(() => {
  api.restore();
});

function firm(overrides: Partial<LawFirm> = {}): LawFirm {
  return {
    id: FIRM_ID,
    name: 'Ortiz Law',
    description: 'Family law',
    address: '1 Main St',
    city: 'Austin',
    state: 'Texas',
    zip: '78701',
    phone: '512-555-0100',
    email: 'office@ortiz.law',
    ...overrides,
  };
}

function contextValue(lawFirm: LawFirm, refetchLawFirm: () => Promise<void>) {
  return { lawFirm, refetchLawFirm, subscriptionStatus: null, subscriptionStatusLoaded: true };
}

/** The firm shell: holds the shared firm and re-reads it from the API on refetch, as the layout does. */
function FirmShell({ initial, onRefetch }: { initial: LawFirm; onRefetch: jest.Mock }) {
  const [lawFirm, setLawFirm] = useState(initial);
  const refetchLawFirm = async () => {
    onRefetch();
    const next = await LawFirmService.getLawFirmById(FIRM_ID);
    if (next) setLawFirm(next);
  };
  return (
    <LawFirmContext.Provider value={contextValue(lawFirm, refetchLawFirm)}>
      <GeneralSettingsPage />
    </LawFirmContext.Provider>
  );
}

function renderPage(initial: LawFirm = firm()) {
  const onRefetch = jest.fn();
  const utils = renderWithProviders(<FirmShell initial={initial} onRefetch={onRefetch} />);
  return { ...utils, onRefetch };
}

function card() {
  const heading = screen.getByRole('heading', { name: 'Law Firm Information' });
  const el = heading.closest('.rounded-lg');
  if (!(el instanceof HTMLElement)) throw new Error('Law Firm Information card not found');
  return el;
}

async function openForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await within(card()).findByRole('button', { name: 'Edit Information' }));
  return card();
}

async function pickState(user: ReturnType<typeof userEvent.setup>, option: string) {
  await user.click(within(card()).getByRole('button', { name: STATE_PICKER }));
  await user.click(within(screen.getByRole('listbox')).getByRole('option', { name: option }));
}

function putBodies() {
  return api.callsTo(FIRM_URL).filter((c) => c.method === 'PUT').map((c) => c.body);
}

describe('saving the firm information', () => {
  it('sends every field, with null for each optional field that was cleared', async () => {
    const user = userEvent.setup();
    api.putExact(FIRM_URL, (call) => ({ ...firm(), ...(call.body as object) }));
    api.getExact(FIRM_URL, firm());
    renderPage();
    const form = await openForm(user);

    await user.clear(within(form).getByLabelText(/Law Firm Name/));
    await user.type(within(form).getByLabelText(/Law Firm Name/), 'Ortiz & Reyes');
    await user.clear(within(form).getByLabelText('Description'));
    await user.clear(within(form).getByLabelText('Email'));
    await user.clear(within(form).getByLabelText('Phone'));
    await user.clear(within(form).getByLabelText('Street Address'));
    await user.clear(within(form).getByLabelText('City'));
    await user.clear(within(form).getByLabelText('ZIP Code'));
    await pickState(user, 'Select a state');
    await user.click(within(form).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0]).toEqual({
      name: 'Ortiz & Reyes',
      description: null,
      email: null,
      phone: null,
      address: null,
      city: null,
      state: null,
      zip: null,
    });
  });

  it('sends unchanged fields as they are', async () => {
    const user = userEvent.setup();
    api.putExact(FIRM_URL, firm());
    api.getExact(FIRM_URL, firm());
    renderPage();
    const form = await openForm(user);

    await user.click(within(form).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0]).toEqual({
      name: 'Ortiz Law',
      description: 'Family law',
      email: 'office@ortiz.law',
      phone: '512-555-0100',
      address: '1 Main St',
      city: 'Austin',
      state: 'Texas',
      zip: '78701',
    });
  });

  it('refreshes the shared firm and shows the saved details and a confirmation in the card', async () => {
    const user = userEvent.setup();
    const saved = firm({ address: '200 Congress Ave', state: 'California' });
    api.putExact(FIRM_URL, saved);
    api.getExact(FIRM_URL, saved);
    const { onRefetch } = renderPage();
    const form = await openForm(user);

    const address = within(form).getByLabelText('Street Address');
    await user.clear(address);
    await user.type(address, '200 Congress Ave');
    await pickState(user, 'California');
    await user.click(within(form).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(onRefetch).toHaveBeenCalledTimes(1));
    expect(await within(card()).findByRole('status')).toHaveTextContent('Law firm information updated successfully!');
    expect(within(card()).getByText(/200 Congress Ave, Austin, California, 78701/)).toBeInTheDocument();
    expect(within(card()).queryByLabelText('Street Address')).not.toBeInTheDocument();
    expect(within(card()).getByRole('button', { name: 'Edit Information' })).toBeInTheDocument();
  });

  it('trims pasted whitespace, which the API email check would refuse', async () => {
    const user = userEvent.setup();
    api.putExact(FIRM_URL, firm());
    api.getExact(FIRM_URL, firm());
    renderPage();
    const form = await openForm(user);

    const email = within(form).getByLabelText('Email');
    await user.clear(email);
    await user.type(email, '  office@ortiz.law ');
    const name = within(form).getByLabelText(/Law Firm Name/);
    await user.clear(name);
    await user.type(name, ' Ortiz Law ');
    await user.click(within(form).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0]).toMatchObject({ name: 'Ortiz Law', email: 'office@ortiz.law' });
  });

  it('keeps showing the logo after a save, whose response carries no signed logo url', async () => {
    const user = userEvent.setup();
    const logoUrl = 'https://storage.example.test/logo.png?sig=1';
    // The update answers with the stored row, which has no signed url; the
    // refreshed firm arrives later from the shared record.
    api.putExact(FIRM_URL, firm());
    const refetch = holdResponse();
    api.getExact(FIRM_URL, refetch.handler);
    renderPage(firm({ logoUrl }));
    const form = await openForm(user);
    expect(screen.getByAltText('Law firm logo')).toHaveAttribute('src', logoUrl);

    await user.click(within(form).getByRole('button', { name: 'Save Changes' }));
    await refetch.untilRequested();

    expect(screen.getByAltText('Law firm logo')).toHaveAttribute('src', logoUrl);
    refetch.release(firm({ logoUrl }));
  });

  it('shows a refused save inside the card and keeps the form open with what was typed', async () => {
    const user = userEvent.setup();
    api.putExact(FIRM_URL, { status: 400, body: { error: 'Phone must be a valid phone number' } });
    const { onRefetch } = renderPage();
    const form = await openForm(user);

    const phone = within(form).getByLabelText('Phone');
    await user.clear(phone);
    await user.type(phone, 'call the front desk');
    await user.click(within(form).getByRole('button', { name: 'Save Changes' }));

    expect(await within(card()).findByRole('alert')).toHaveTextContent('Phone must be a valid phone number');
    expect(screen.getAllByText('Phone must be a valid phone number')).toHaveLength(1);
    expect(within(card()).getByLabelText('Phone')).toHaveValue('call the front desk');
    expect(within(card()).getByRole('button', { name: 'Save Changes' })).toBeEnabled();
    expect(onRefetch).not.toHaveBeenCalled();
  });
});

describe('the open form', () => {
  it('keeps what was typed when the shared firm record changes underneath it', async () => {
    const user = userEvent.setup();
    const onRefetch = jest.fn(async () => {});
    const { rerender } = renderWithProviders(
      <LawFirmContext.Provider value={contextValue(firm(), onRefetch)}>
        <GeneralSettingsPage />
      </LawFirmContext.Provider>,
    );
    const form = await openForm(user);
    const city = within(form).getByLabelText('City');
    await user.clear(city);
    await user.type(city, 'Dallas');

    rerender(
      <LawFirmContext.Provider value={contextValue(firm({ city: 'Houston', logoUrl: 'https://cdn.example/logo.png' }), onRefetch)}>
        <GeneralSettingsPage />
      </LawFirmContext.Provider>,
    );

    expect(within(card()).getByLabelText('City')).toHaveValue('Dallas');
  });

  it('opens on the latest shared firm, not the one first rendered', async () => {
    const user = userEvent.setup();
    const onRefetch = jest.fn(async () => {});
    const { rerender } = renderWithProviders(
      <LawFirmContext.Provider value={contextValue(firm(), onRefetch)}>
        <GeneralSettingsPage />
      </LawFirmContext.Provider>,
    );
    await within(card()).findByRole('button', { name: 'Edit Information' });
    rerender(
      <LawFirmContext.Provider value={contextValue(firm({ city: 'Houston' }), onRefetch)}>
        <GeneralSettingsPage />
      </LawFirmContext.Provider>,
    );

    const form = await openForm(user);

    expect(within(form).getByLabelText('City')).toHaveValue('Houston');
  });

  it('passes the accessibility scan', async () => {
    const user = userEvent.setup();
    renderPage();
    const form = await openForm(user);

    expect((await scanAccessibility(form)).violations).toEqual([]);
  });
});

describe('the state picker', () => {
  it('lists the states with an option to leave it empty', async () => {
    const user = userEvent.setup();
    renderPage();
    const form = await openForm(user);

    await user.click(within(form).getByRole('button', { name: STATE_PICKER }));
    const listbox = within(screen.getByRole('listbox'));

    expect(listbox.getByRole('option', { name: 'Select a state' })).toBeInTheDocument();
    expect(listbox.getByRole('option', { name: 'Alabama' })).toBeInTheDocument();
    expect(listbox.getByRole('option', { name: 'District of Columbia' })).toBeInTheDocument();
    expect(listbox.getByRole('option', { name: 'Wyoming' })).toBeInTheDocument();
    expect(listbox.getAllByRole('option')).toHaveLength(52);
  });

  it('preselects the full name for a stored two-letter code', async () => {
    const user = userEvent.setup();
    renderPage(firm({ state: 'TX' }));
    const form = await openForm(user);

    expect(within(form).getByRole('button', { name: STATE_PICKER })).toHaveTextContent('Texas');
  });

  it('keeps a stored value it does not recognise, so saving does not erase it', async () => {
    const user = userEvent.setup();
    api.putExact(FIRM_URL, firm({ state: 'Ontario' }));
    api.getExact(FIRM_URL, firm({ state: 'Ontario' }));
    renderPage(firm({ state: 'Ontario' }));
    const form = await openForm(user);

    expect(within(form).getByRole('button', { name: STATE_PICKER })).toHaveTextContent('Ontario');
    await user.click(within(form).getByRole('button', { name: STATE_PICKER }));
    expect(within(screen.getByRole('listbox')).getByRole('option', { name: 'Ontario' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(within(form).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0]).toMatchObject({ state: 'Ontario' });
  });
});

describe('filling the state from the ZIP code', () => {
  const HINT = 'Filled in from the ZIP code.';

  async function typeZip(user: ReturnType<typeof userEvent.setup>, zip: string) {
    const field = within(card()).getByLabelText('ZIP Code');
    await user.clear(field);
    await user.type(field, zip);
  }

  it('fills an empty state from a complete ZIP and says so under the picker', async () => {
    const user = userEvent.setup();
    renderPage(firm({ state: undefined, zip: undefined }));
    const form = await openForm(user);

    await typeZip(user, '0210');
    expect(within(form).getByRole('button', { name: STATE_PICKER })).not.toHaveTextContent('Massachusetts');
    expect(within(form).queryByText(HINT)).not.toBeInTheDocument();

    await user.type(within(form).getByLabelText('ZIP Code'), '8');

    const picker = within(form).getByRole('button', { name: STATE_PICKER });
    expect(picker).toHaveTextContent('Massachusetts');
    expect(picker).toHaveAccessibleDescription(HINT);
  });

  it('fills from a ZIP+4 and saves the filled state', async () => {
    const user = userEvent.setup();
    api.putExact(FIRM_URL, firm());
    api.getExact(FIRM_URL, firm());
    renderPage(firm({ state: undefined, zip: undefined }));
    const form = await openForm(user);

    await typeZip(user, '78701-1234');
    await user.click(within(form).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0]).toMatchObject({ state: 'Texas', zip: '78701-1234' });
  });

  it('follows a changed ZIP while the state is still the one it filled', async () => {
    const user = userEvent.setup();
    renderPage(firm({ state: undefined, zip: undefined }));
    const form = await openForm(user);

    await typeZip(user, '02108');
    await typeZip(user, '78701');

    expect(within(form).getByRole('button', { name: STATE_PICKER })).toHaveTextContent('Texas');
    expect(within(form).getByText(HINT)).toBeInTheDocument();
  });

  it('leaves a stored state alone', async () => {
    const user = userEvent.setup();
    renderPage(firm({ state: 'Texas' }));
    const form = await openForm(user);

    await typeZip(user, '02108');

    expect(within(form).getByRole('button', { name: STATE_PICKER })).toHaveTextContent('Texas');
    expect(within(form).queryByText(HINT)).not.toBeInTheDocument();
  });

  it('never overwrites a state picked by hand', async () => {
    const user = userEvent.setup();
    renderPage(firm({ state: undefined, zip: undefined }));
    const form = await openForm(user);

    await typeZip(user, '02108');
    await pickState(user, 'California');
    expect(within(form).queryByText(HINT)).not.toBeInTheDocument();
    await typeZip(user, '78701');

    expect(within(form).getByRole('button', { name: STATE_PICKER })).toHaveTextContent('California');
    expect(within(form).queryByText(HINT)).not.toBeInTheDocument();
  });

  it('leaves the state empty for a ZIP it cannot place', async () => {
    const user = userEvent.setup();
    renderPage(firm({ state: undefined, zip: undefined }));
    const form = await openForm(user);

    await typeZip(user, '00601');

    expect(within(form).getByRole('button', { name: STATE_PICKER })).toHaveTextContent('Select a state');
    expect(within(form).queryByText(HINT)).not.toBeInTheDocument();
  });
});

describe('browser autofill and keyboard', () => {
  it('marks each field with its autofill purpose', async () => {
    const user = userEvent.setup();
    renderPage();
    const form = await openForm(user);

    expect(within(form).getByLabelText(/Law Firm Name/)).toHaveAttribute('autocomplete', 'organization');
    expect(within(form).getByLabelText('Email')).toHaveAttribute('autocomplete', 'email');
    expect(within(form).getByLabelText('Phone')).toHaveAttribute('autocomplete', 'tel');
    expect(within(form).getByLabelText('Street Address')).toHaveAttribute('autocomplete', 'address-line1');
    expect(within(form).getByLabelText('City')).toHaveAttribute('autocomplete', 'address-level2');
    expect(within(form).getByLabelText('ZIP Code')).toHaveAttribute('autocomplete', 'postal-code');
    expect(within(form).getByLabelText(/Law Firm Name/).closest('form')).not.toBeNull();
  });

  it('saves when Enter is pressed in a field', async () => {
    const user = userEvent.setup();
    api.putExact(FIRM_URL, firm({ city: 'Dallas' }));
    api.getExact(FIRM_URL, firm({ city: 'Dallas' }));
    renderPage();
    const form = await openForm(user);

    const city = within(form).getByLabelText('City');
    await user.clear(city);
    await user.type(city, 'Dallas{Enter}');

    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0]).toMatchObject({ city: 'Dallas' });
  });

  it('does not save on Enter while the firm name is empty', async () => {
    const user = userEvent.setup();
    renderPage();
    const form = await openForm(user);

    await user.clear(within(form).getByLabelText(/Law Firm Name/));
    await user.type(within(form).getByLabelText('City'), '{Enter}');

    expect(putBodies()).toHaveLength(0);
    expect(within(card()).getByLabelText('City')).toBeInTheDocument();
  });
});
