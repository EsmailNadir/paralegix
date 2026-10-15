/**
 * TimeEntryModal's save path, driven through the REAL billing, matters and
 * clients services against a fake transport.
 *
 * What is pinned here is the wire payload, which never shows on screen: the
 * `hours` a duration of hours plus minutes turns into, the `hourlyRate` the rate
 * ladder settles on (dollars, as `timeEntries.validation.ts` expects, never
 * cents), which of `matterId` / `clientId` the entry is filed under, and which
 * matter clients it bills toward. A wrong value in any of them files or prices
 * the time wrongly with nothing on screen looking different.
 *
 * `EntityPicker` is stubbed with a plain select: it is a server typeahead with
 * its own queries, and driving it would test the picker rather than this modal.
 * The stub hands the modal the same `onChange` + `onSelectItem` pair the real
 * picker does, and records its props so the scoping the modal asks for is
 * still asserted.
 */
// Each spec re-resolves the same target within the duplicate-GET guard's
// window, which is expected here rather than a double fetch in one render.
process.env.NEXT_PUBLIC_DUP_FETCH_WARN = 'off';

jest.unmock('@/services/billing.service');
jest.unmock('@/services/matters.service');
jest.unmock('@/services/clients.service');
jest.unmock('@/services/chargeCodes.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { installApiMock, type ApiMock, type RecordedCall } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import TimeEntryModal from '@/components/billingComp/TimeEntryModal';

type PickerItem = { id: string; label: string; [key: string]: unknown };

const mockPickerProps: Array<Record<string, any>> = [];
const mockPickerItems: Record<string, PickerItem> = {};

jest.mock('@/components/ui/EntityPicker', () => ({
  __esModule: true,
  default: function MockEntityPicker(props: any) {
    mockPickerProps.push(props);
    const label = props.label || `${props.entity} picker`;
    return (
      <select
        aria-label={label}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => {
          const id = event.target.value;
          props.onChange(id);
          if (id && props.onSelectItem) props.onSelectItem(mockPickerItems[id]);
        }}
      >
        <option value="">{props.emptyOption?.label ?? 'Select'}</option>
        {Object.values(mockPickerItems).map((item) => (
          <option key={item.id} value={item.id}>{item.label}</option>
        ))}
      </select>
    );
  },
}));

const FIRM = 'firm-1';
const ALICE = { uid: 'user-1', name: 'Alice Smith', email: 'alice@example.test' };
const BOB = { uid: 'user-2', name: 'Bob Jones', email: 'bob@example.test' };

const MATTER = {
  id: 'm-1',
  label: 'Smith v. Jones',
  name: 'Smith v. Jones',
  members: [{ userId: 'user-1', name: 'Alice Smith', hourlyRate: 300 }],
};
const CLIENT = { id: 'cl-9', label: 'Acme Holdings', name: 'Acme Holdings', email: 'ap@acme.test' };
const MATTER_CLIENT = { id: 'mc-1', name: 'Jane Client', email: 'jane@example.test' };

let api: ApiMock;
let onClose: jest.Mock;
let onSuccess: jest.Mock;

/** Answer the full-record lookups the modal makes to label a selected target. */
function lookupHandler(pool: PickerItem[]) {
  return (call: RecordedCall) => {
    const ids = (call.query.ids?.[0] || '').split(',').filter(Boolean);
    return { items: pool.filter((item) => ids.includes(item.id)), hasMore: false };
  };
}

function renderModal(props: Record<string, unknown> = {}) {
  return renderWithProviders(
    <TimeEntryModal
      open
      onClose={onClose}
      lawFirmId={FIRM}
      users={[ALICE, BOB] as any}
      chargeCodes={[]}
      defaultUserId="user-1"
      onSuccess={onSuccess}
      {...(props as any)}
    />,
  );
}

function hoursInput() {
  return screen.getAllByRole('spinbutton')[0];
}
function minutesInput() {
  return screen.getAllByRole('spinbutton')[1];
}
function rateInput() {
  return screen.getAllByRole('spinbutton')[2];
}
function saveButton() {
  return screen.getByRole('button', { name: 'Save Time Entry' });
}

function postedBody(): Record<string, unknown> {
  const calls = api.calls('POST').filter((c) => c.pathname.endsWith('/billing/time-entries'));
  expect(calls).toHaveLength(1);
  return calls[0].body as Record<string, unknown>;
}

beforeEach(() => {
  mockPickerProps.length = 0;
  for (const key of Object.keys(mockPickerItems)) delete mockPickerItems[key];
  onClose = jest.fn();
  onSuccess = jest.fn();
  api = installApiMock();
  api.get('/matters/lookup', lookupHandler([MATTER]));
  api.get('/clients/lookup', lookupHandler([CLIENT]));
  api.get('/matters/m-1/clients', { clients: [MATTER_CLIENT] });
  api.get('/clients/mc-1/billing-rates', { billingRates: {} });
  api.get('/clients/cl-9/billing-rates', { billingRates: {} });
});

afterEach(() => {
  api.restore();
});

describe('creating an entry on a matter', () => {
  it('sends the duration as decimal hours, the matter member rate in dollars, and the only matter client', async () => {
    api.post('/billing/time-entries', {
      timeEntry: { id: 'te-1', date: '2026-03-14', hours: 1.5 },
    });
    renderModal({
      defaultTarget: 'matter:m-1',
      prefill: { date: '2026-03-14', name: '  Draft motion  ', description: 'Research' },
    });

    // The matter member's own rate wins over every lower tier.
    await waitFor(() => expect(rateInput()).toHaveValue(300));
    fireEvent.change(minutesInput(), { target: { value: '30' } });
    await screen.findByText('This matter has one billing client, so it will be used automatically.');
    await userEvent.click(saveButton());

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(postedBody()).toEqual({
      matterId: 'm-1',
      userId: 'user-1',
      hours: 1.5,
      date: '2026-03-14',
      matterClientId: 'mc-1',
      matterClientIds: ['mc-1'],
      name: 'Draft motion',
      description: 'Research',
      hourlyRate: 300,
      chargeCodeId: null,
      sourceTaskId: null,
      sourceEventId: null,
      utbmsTaskCode: null,
      utbmsActivityCode: null,
      billable: true,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSuccess.mock.calls[0][0]).toEqual({
      createdEntry: { id: 'te-1', date: '2026-03-14', hours: 1.5 },
      shouldBillNow: false,
      draftItem: undefined,
    });
  });

  it('previews hours times rate rounded to the cent', async () => {
    renderModal({ defaultTarget: 'matter:m-1' });
    await waitFor(() => expect(rateInput()).toHaveValue(300));

    // 1h20m is stored as 1.33h (`activities.hours` is numeric(6,2)), and the
    // generated amount is 1.33 x $250 = $332.50, not the $333.33 of the
    // unrounded duration.
    fireEvent.change(rateInput(), { target: { value: '250' } });
    fireEvent.change(minutesInput(), { target: { value: '20' } });

    expect(await screen.findByText('$332.50')).toBeInTheDocument();
    expect(screen.getByText('Using your custom rate.')).toBeInTheDocument();
  });

  it('names the ladder tier behind an untouched rate under the preview', async () => {
    renderModal({ defaultTarget: 'matter:m-1' });
    await waitFor(() => expect(rateInput()).toHaveValue(300));

    expect(await screen.findByText('$300.00', { selector: 'p.text-2xl' })).toBeInTheDocument();
    expect(screen.getByText('Matter member rate', { selector: 'p.text-xs.mt-1' })).toBeInTheDocument();
  });

  it('bills toward only the matter clients left checked when the matter has several', async () => {
    api.get('/matters/m-1/clients', {
      clients: [MATTER_CLIENT, { id: 'mc-2', name: 'John Client', email: 'john@example.test' }],
    });
    api.post('/billing/time-entries', { timeEntry: { id: 'te-2', date: '2026-03-14' } });
    renderModal({ defaultTarget: 'matter:m-1' });

    await screen.findByText('2 preferred clients selected. Billing this now will open split billing.');
    await userEvent.click(screen.getByRole('checkbox', { name: /John Client/ }));
    expect(
      screen.getByText('One preferred client selected. This can prefill single-client billing later.'),
    ).toBeInTheDocument();
    await userEvent.click(saveButton());

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    const body = postedBody();
    expect(body.matterClientIds).toEqual(['mc-1']);
    expect(body.matterClientId).toBe('mc-1');
  });

  it('sends no single matter client when two stay checked', async () => {
    api.get('/matters/m-1/clients', {
      clients: [MATTER_CLIENT, { id: 'mc-2', name: 'John Client', email: 'john@example.test' }],
    });
    api.get('/clients/mc-2/billing-rates', { billingRates: {} });
    api.post('/billing/time-entries', { timeEntry: { id: 'te-3', date: '2026-03-14' } });
    renderModal({ defaultTarget: 'matter:m-1' });

    await screen.findByText('2 preferred clients selected. Billing this now will open split billing.');
    await userEvent.click(saveButton());

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    const body = postedBody();
    expect(body.matterClientIds).toEqual(['mc-1', 'mc-2']);
    expect(body.matterClientId).toBeNull();
  });
});

describe('creating an entry on a client directly', () => {
  it('files it under clientId and carries no matter-client fields', async () => {
    api.post('/billing/time-entries', { timeEntry: { id: 'te-4', date: '2026-03-14' } });
    renderModal({
      defaultTarget: 'client:cl-9',
      firmDefaultRate: 175,
      prefill: { date: '2026-03-14' },
    });

    await waitFor(() => expect(rateInput()).toHaveValue(175));
    await userEvent.click(saveButton());

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    const body = postedBody();
    expect(body.clientId).toBe('cl-9');
    expect(body).not.toHaveProperty('matterId');
    expect(body.matterClientId).toBeNull();
    expect(body.matterClientIds).toBeNull();
    expect(body.hourlyRate).toBe(175);
  });

  it("prices the entry from the client's own member rate fetched for that client", async () => {
    api.get('/clients/cl-9/billing-rates', {
      billingRates: { defaultRate: 90, memberRates: { 'user-1': 410 } },
    });
    api.post('/billing/time-entries', { timeEntry: { id: 'te-5', date: '2026-03-14' } });
    renderModal({ defaultTarget: 'client:cl-9', firmDefaultRate: 175 });

    await waitFor(() => expect(rateInput()).toHaveValue(410));
    await userEvent.click(saveButton());

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(postedBody().hourlyRate).toBe(410);
  });
});

describe('the rate field', () => {
  it('sends a null rate, and warns, when the rate typed is negative', async () => {
    api.post('/billing/time-entries', { timeEntry: { id: 'te-6', date: '2026-03-14' } });
    renderModal({ defaultTarget: 'client:cl-9' });
    await waitFor(() => expect(api.callsTo('/clients/cl-9/billing-rates')).toHaveLength(1));

    fireEvent.change(rateInput(), { target: { value: '-40' } });

    expect(
      await screen.findByText(/No billing rate found for this member/),
    ).toBeInTheDocument();
    expect(screen.getByText('No rate')).toBeInTheDocument();
    await userEvent.click(saveButton());

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(postedBody().hourlyRate).toBeNull();
  });

  it('keeps a deliberate $0 rate as zero rather than treating it as missing', async () => {
    api.post('/billing/time-entries', { timeEntry: { id: 'te-7', date: '2026-03-14' } });
    renderModal({ defaultTarget: 'client:cl-9', firmDefaultRate: 200 });
    await waitFor(() => expect(rateInput()).toHaveValue(200));

    fireEvent.change(rateInput(), { target: { value: '0' } });
    expect(screen.queryByText(/No billing rate found for this member/)).not.toBeInTheDocument();
    await userEvent.click(saveButton());

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(postedBody().hourlyRate).toBe(0);
  });

  it("keeps an edited entry's stored rate instead of re-pricing it from the ladder", async () => {
    api.put('/billing/time-entries/client/cl-9/te-8', { timeEntry: { id: 'te-8', date: '2026-03-14' } });
    renderModal({
      firmDefaultRate: 200,
      entry: {
        id: 'te-8',
        clientId: 'cl-9',
        userId: 'user-1',
        hours: 1,
        hourlyRate: 333,
        date: '2026-03-14',
        name: 'Call',
        billable: true,
      },
    });
    await waitFor(() => expect(saveButton()).not.toBeDisabled());
    expect(rateInput()).toHaveValue(333);
    await userEvent.click(saveButton());

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    const puts = api.calls('PUT').filter((c) => c.pathname.endsWith('/te-8'));
    expect(puts).toHaveLength(1);
    expect((puts[0].body as Record<string, unknown>).hourlyRate).toBe(333);
  });
});

describe('a refused save', () => {
  it("shows the server's reason and keeps the modal open", async () => {
    api.post('/billing/time-entries', {
      status: 400,
      body: { error: 'hours cannot exceed 24 for a single entry' },
    });
    renderModal({ defaultTarget: 'client:cl-9', firmDefaultRate: 100 });
    await waitFor(() => expect(rateInput()).toHaveValue(100));

    await userEvent.click(saveButton());

    expect(
      await screen.findByText('hours cannot exceed 24 for a single entry'),
    ).toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(saveButton()).not.toBeDisabled();
  });
});

describe('billable and bill-now', () => {
  it('unchecking Billable disarms Bill this now and sends billable false', async () => {
    api.post('/billing/time-entries', { timeEntry: { id: 'te-8', date: '2026-03-14' } });
    renderModal({ defaultTarget: 'client:cl-9', firmDefaultRate: 100 });
    await waitFor(() => expect(rateInput()).toHaveValue(100));

    const billNow = screen.getByRole('checkbox', { name: 'Bill this now' });
    await userEvent.click(billNow);
    expect(billNow).toBeChecked();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Billable' }));

    expect(billNow).not.toBeChecked();
    expect(billNow).toBeDisabled();
    await userEvent.click(saveButton());

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(postedBody().billable).toBe(false);
    expect(onSuccess.mock.calls[0][0].shouldBillNow).toBe(false);
    expect(onSuccess.mock.calls[0][0].draftItem).toBeUndefined();
  });

  it('hands back a draft invoice line billed to the matter client record, priced at the preview amount', async () => {
    api.post('/billing/time-entries', {
      timeEntry: { id: 'te-9', date: '2026-03-14', hours: 2 },
    });
    renderModal({ defaultTarget: 'matter:m-1', prefill: { name: 'Hearing prep' } });
    await waitFor(() => expect(rateInput()).toHaveValue(300));
    await screen.findByText('This matter has one billing client, so it will be used automatically.');

    fireEvent.change(hoursInput(), { target: { value: '2' } });
    fireEvent.change(minutesInput(), { target: { value: '15' } });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Bill this now' }));
    await userEvent.click(saveButton());

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    const result = onSuccess.mock.calls[0][0];
    expect(result.shouldBillNow).toBe(true);
    expect(result.draftItem).toEqual({
      id: 'te-9',
      itemType: 'time_entry',
      contextType: 'matter',
      entityId: 'm-1',
      matterId: 'm-1',
      matterName: 'Smith v. Jones',
      matterClientId: 'mc-1',
      matterClientIds: ['mc-1'],
      clientId: 'mc-1',
      clientName: 'Jane Client',
      description: 'Hearing prep',
      amount: 675,
      hours: 2.25,
      date: '2026-03-14',
      timeEntryId: 'te-9',
    });
  });

  // 1h20m is 1.3333...h, which an entry stores as 1.33h and the preview prices
  // at 1.33 x $300 = $399. The draft line has to carry the same 1.33h, or the
  // invoice shows an hours figure that does not multiply out to its amount.
  it('carries the hours a draft line is priced on, rounded to the hundredth an entry stores', async () => {
    api.post('/billing/time-entries', {
      timeEntry: { id: 'te-12', date: '2026-03-14', hours: 1.33 },
    });
    renderModal({ defaultTarget: 'matter:m-1' });
    await waitFor(() => expect(rateInput()).toHaveValue(300));
    await screen.findByText('This matter has one billing client, so it will be used automatically.');

    fireEvent.change(hoursInput(), { target: { value: '1' } });
    fireEvent.change(minutesInput(), { target: { value: '20' } });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Bill this now' }));
    await userEvent.click(saveButton());

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    const { draftItem } = onSuccess.mock.calls[0][0];
    expect(draftItem.amount).toBe(399);
    expect(draftItem.hours).toBe(1.33);
  });

  it('names a client-filed draft line after the client and bills it to that client id', async () => {
    api.post('/billing/time-entries', { timeEntry: { id: 'te-10', date: '2026-03-14' } });
    mockPickerItems['cl-9'] = CLIENT;
    renderModal({ firmDefaultRate: 100 });

    await userEvent.click(screen.getByRole('button', { name: /^Matter/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Client' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'clients picker' }), {
      target: { value: 'cl-9' },
    });
    await waitFor(() => expect(rateInput()).toHaveValue(100));

    await userEvent.click(screen.getByRole('checkbox', { name: 'Bill this now' }));
    await userEvent.click(saveButton());

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    const { draftItem } = onSuccess.mock.calls[0][0];
    expect(draftItem.clientId).toBe('cl-9');
    expect(draftItem.clientName).toBe('Acme Holdings');
    expect(draftItem.matterId).toBeNull();
    expect(draftItem.matterClientIds).toBeNull();
    expect(draftItem.description).toBe('Time entry');
    expect(draftItem.amount).toBe(100);
  });
});

describe('while a save is in flight', () => {
  it('cannot be cancelled or escaped, so a late failure is not left in a closed dialog', async () => {
    api.post('/billing/time-entries', { delayMs: 5000, body: { timeEntry: { id: 'te-11' } } });
    api.allowUnhandled();
    renderModal({ defaultTarget: 'client:cl-9', firmDefaultRate: 100 });
    await waitFor(() => expect(rateInput()).toHaveValue(100));

    await userEvent.click(saveButton());
    await waitFor(() => expect(api.calls('POST')).toHaveLength(1));

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('editing an entry', () => {
  const entry = {
    id: 'te-8',
    clientId: 'cl-9',
    userId: 'user-1',
    hours: 1,
    hourlyRate: 120,
    date: '2026-03-14',
    name: 'Call',
    billable: true,
  };

  // The update API takes neither a member nor a new matter/client (only the
  // separate client-to-matter move), so a change made in either picker would be
  // dropped on save while the dialog reported success.
  it('pins the member and the billing target it was recorded under', async () => {
    renderModal({ entry });
    await waitFor(() => expect(saveButton()).not.toBeDisabled());

    expect(screen.getByRole('button', { name: /Team Member/ })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'clients picker' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Client/ })).toBeDisabled();
  });

  function putBody(): Record<string, unknown> {
    const calls = api.calls('PUT').filter((c) => c.pathname.endsWith('/billing/time-entries/client/cl-9/te-8'));
    expect(calls).toHaveLength(1);
    return calls[0].body as Record<string, unknown>;
  }

  // The form shows whole minutes, so a stored duration that is not a whole
  // minute (0.04h is 2.4 minutes) would round-trip to a different value
  // (0.03h) and silently re-price the entry. Leaving `hours` off the update
  // keeps the stored value, since the API only rewrites the fields it is sent.
  it.each([0.04, 0.24, 0.01])(
    'leaves a stored %sh duration alone when only the description changes',
    async (storedHours) => {
      api.put('/billing/time-entries/client/cl-9/te-8', {
        timeEntry: { ...entry, hours: storedHours, description: 'Follow-up' },
      });
      renderModal({ entry: { ...entry, hours: storedHours } });
      await waitFor(() => expect(rateInput()).toHaveValue(120));

      fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Follow-up' } });
      await userEvent.click(saveButton());

      await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
      const body = putBody();
      expect(body.description).toBe('Follow-up');
      expect(body).not.toHaveProperty('hours');
    },
  );

  it('leaves the stored duration alone when the minutes are edited back to what was shown', async () => {
    api.put('/billing/time-entries/client/cl-9/te-8', { timeEntry: { ...entry, hours: 0.04 } });
    renderModal({ entry: { ...entry, hours: 0.04 } });
    await waitFor(() => expect(minutesInput()).toHaveValue(2));

    fireEvent.change(minutesInput(), { target: { value: '5' } });
    fireEvent.change(minutesInput(), { target: { value: '2' } });
    await userEvent.click(saveButton());

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(putBody()).not.toHaveProperty('hours');
  });

  it('sends the new duration when the user changes it', async () => {
    api.put('/billing/time-entries/client/cl-9/te-8', { timeEntry: { ...entry, hours: 0.5 } });
    renderModal({ entry: { ...entry, hours: 0.04 } });
    await waitFor(() => expect(minutesInput()).toHaveValue(2));

    fireEvent.change(minutesInput(), { target: { value: '30' } });
    await userEvent.click(saveButton());

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(putBody().hours).toBe(0.5);
  });

  it('still lets a new entry choose its member and target', async () => {
    renderModal({ defaultTarget: 'client:cl-9' });
    await waitFor(() => expect(saveButton()).not.toBeDisabled());

    expect(screen.getByRole('button', { name: /Team Member/ })).not.toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'clients picker' })).not.toBeDisabled();
  });
});

describe('quick-creating a charge code', () => {
  it('opens above the time entry dialog, creates the code and keeps the entry open', async () => {
    api.post('/billing/charge-codes', { message: 'ok', chargeCodeId: 'cc-new' });
    renderModal({ defaultTarget: 'client:cl-9', firmDefaultRate: 100 });

    await userEvent.click(screen.getByRole('button', { name: 'Quick-create a charge code' }));
    const quick = await screen.findByRole('dialog', { name: 'New Charge Code' });
    expect(quick.closest('.fixed')).toHaveClass('z-[60]');

    fireEvent.change(within(quick).getByLabelText(/Code/), { target: { value: 'consult' } });
    fireEvent.change(within(quick).getByLabelText(/Name/), { target: { value: 'Consultation' } });
    fireEvent.change(within(quick).getByLabelText(/Default Rate/), { target: { value: '275' } });
    await userEvent.click(within(quick).getByRole('button', { name: 'Create & Select' }));

    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'New Charge Code' })).toHaveClass('overlay-card-exit'),
    );
    const posts = api.calls('POST').filter((c) => c.pathname.endsWith('/billing/charge-codes'));
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ code: 'CONSULT', name: 'Consultation', defaultRate: 275 });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Log Billable Hours' })).toBeInTheDocument();
  });

  it('closes on Escape without closing the time entry dialog under it', async () => {
    renderModal({ defaultTarget: 'client:cl-9', firmDefaultRate: 100 });

    await userEvent.click(screen.getByRole('button', { name: 'Quick-create a charge code' }));
    await screen.findByRole('dialog', { name: 'New Charge Code' });
    await userEvent.keyboard('{Escape}');

    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'New Charge Code' })).toHaveClass('overlay-card-exit'),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
