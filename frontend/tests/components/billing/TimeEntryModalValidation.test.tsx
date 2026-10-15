/**
 * TimeEntryModal: what stops a bad entry from being saved, and what decides
 * whether a timer's task or event link survives the target the user picks.
 *
 * Runs the real billing, matters and clients services against a fake
 * transport. `EntityPicker` is a plain-select stub (see TimeEntryModalSave for
 * why) that hands the modal the same `onChange` + `onSelectItem` pair.
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
import { fireEvent, screen, waitFor } from '@testing-library/react';
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

const MATTER = {
  id: 'm-1',
  label: 'Smith v. Jones',
  name: 'Smith v. Jones',
  members: [{ userId: 'user-1', name: 'Alice Smith' }],
};
// A matter the default member is NOT on.
const OTHER_MATTER = {
  id: 'm-2',
  label: 'Doe Estate',
  name: 'Doe Estate',
  members: [{ userId: 'user-7', name: 'Carol Partner' }],
};
const CLIENT = { id: 'cl-9', label: 'Acme Holdings', name: 'Acme Holdings' };

let api: ApiMock;
let onClose: jest.Mock;
let onSuccess: jest.Mock;

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
      users={[ALICE] as any}
      chargeCodes={[]}
      defaultUserId="user-1"
      firmDefaultRate={100}
      onSuccess={onSuccess}
      {...(props as any)}
    />,
  );
}

const hoursInput = () => screen.getAllByRole('spinbutton')[0];
const minutesInput = () => screen.getAllByRole('spinbutton')[1];
const saveButton = () => screen.getByRole('button', { name: 'Save Time Entry' });

async function switchToClientTarget() {
  await userEvent.click(screen.getByRole('button', { name: /^Matter/ }));
  await userEvent.click(await screen.findByRole('option', { name: 'Client' }));
}

function postedBody(): Record<string, unknown> {
  const calls = api.calls('POST').filter((c) => c.pathname.endsWith('/billing/time-entries'));
  expect(calls).toHaveLength(1);
  return calls[0].body as Record<string, unknown>;
}

beforeEach(() => {
  mockPickerProps.length = 0;
  for (const key of Object.keys(mockPickerItems)) delete mockPickerItems[key];
  mockPickerItems['m-1'] = MATTER;
  mockPickerItems['m-2'] = OTHER_MATTER;
  onClose = jest.fn();
  onSuccess = jest.fn();
  api = installApiMock();
  api.get('/matters/lookup', lookupHandler([MATTER, OTHER_MATTER]));
  api.get('/clients/lookup', lookupHandler([CLIENT]));
  api.get('/matters/m-1/clients', { clients: [] });
  api.get('/matters/m-2/clients', { clients: [] });
  api.get('/clients/cl-9/billing-rates', { billingRates: {} });
  api.post('/billing/time-entries', { timeEntry: { id: 'te-1', date: '2026-03-14' } });
});

afterEach(() => {
  api.restore();
});

describe('blocking a save', () => {
  it('cannot save before a matter or client is chosen', async () => {
    renderModal();

    expect(saveButton()).toBeDisabled();
    await userEvent.click(saveButton());
    expect(api.calls('POST')).toHaveLength(0);
  });

  it('cannot save a zero duration', async () => {
    renderModal({ defaultTarget: 'client:cl-9' });
    await waitFor(() => expect(saveButton()).not.toBeDisabled());

    fireEvent.change(hoursInput(), { target: { value: '0' } });

    expect(saveButton()).toBeDisabled();
    expect(screen.getByText('0m')).toBeInTheDocument();
    await userEvent.click(saveButton());
    expect(api.calls('POST')).toHaveLength(0);
  });

  // Red if sharing note validation introduces its 24-hour client-side cap here.
  it('continues to submit durations above 24 hours for server validation', async () => {
    renderModal({ defaultTarget: 'client:cl-9' });
    await waitFor(() => expect(saveButton()).toBeEnabled());
    fireEvent.change(hoursInput(), { target: { value: '25' } });
    expect(hoursInput()).toHaveValue(25);
    expect(saveButton()).toBeEnabled();
    await userEvent.click(saveButton());
    await waitFor(() => expect(postedBody()).toMatchObject({ clientId: 'cl-9', hours: 25 }));
  });

  it('cannot save a blank duration', async () => {
    renderModal({ defaultTarget: 'client:cl-9' });
    await waitFor(() => expect(saveButton()).not.toBeDisabled());

    fireEvent.change(hoursInput(), { target: { value: '' } });
    fireEvent.change(minutesInput(), { target: { value: '' } });

    expect(saveButton()).toBeDisabled();
  });

  it('cannot save a duration that nets out negative', async () => {
    renderModal({ defaultTarget: 'client:cl-9' });
    await waitFor(() => expect(saveButton()).not.toBeDisabled());

    fireEvent.change(hoursInput(), { target: { value: '1' } });
    fireEvent.change(minutesInput(), { target: { value: '-90' } });

    expect(saveButton()).toBeDisabled();
  });

  it('drops a default member who is not on the picked matter, so the entry cannot save under them', async () => {
    renderModal();

    fireEvent.change(screen.getByRole('combobox', { name: 'matters picker' }), {
      target: { value: 'm-2' },
    });

    // The member field unlocks only once the picked matter has been applied, so
    // the disabled save below is about the dropped member, not a missing target.
    // (The amount preview still prices from the firm default rate without a
    // member, so it is no signal here.)
    const memberField = screen.getByRole('button', { name: /^Team Member/ });
    await waitFor(() => expect(memberField).not.toBeDisabled());
    expect(memberField).toHaveTextContent('Select a member');
    expect(saveButton()).toBeDisabled();
  });

  it('keeps the default member on a matter they belong to', async () => {
    renderModal();

    fireEvent.change(screen.getByRole('combobox', { name: 'matters picker' }), {
      target: { value: 'm-1' },
    });
    await waitFor(() => expect(saveButton()).not.toBeDisabled());
    await userEvent.click(saveButton());

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(postedBody()).toMatchObject({ matterId: 'm-1', userId: 'user-1' });
  });
});

describe('a timer prefill', () => {
  it('splits a fractional timer duration into minutes and sends it back as the same decimal hours', async () => {
    renderModal({ prefill: { hours: 0.75, clientId: 'cl-9', date: '2026-01-02' } });

    await waitFor(() => expect(minutesInput()).toHaveValue(45));
    expect(hoursInput()).toHaveValue(null);
    await waitFor(() => expect(saveButton()).not.toBeDisabled());
    await userEvent.click(saveButton());

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(postedBody()).toMatchObject({ clientId: 'cl-9', hours: 0.75, date: '2026-01-02' });
  });

  it('uses a timer rate as a custom rate rather than the ladder rate', async () => {
    renderModal({ prefill: { clientId: 'cl-9', hourlyRate: 222.5 } });

    await waitFor(() => expect(saveButton()).not.toBeDisabled());
    expect(screen.getByText('Custom rate')).toBeInTheDocument();
    await userEvent.click(saveButton());

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(postedBody().hourlyRate).toBe(222.5);
  });

  it('keeps a timer rate when no firm or member rate resolves at all', async () => {
    renderModal({ firmDefaultRate: null, prefill: { clientId: 'cl-9', hourlyRate: 222.5 } });

    await waitFor(() => expect(saveButton()).not.toBeDisabled());
    expect(screen.getByText('Custom rate')).toBeInTheDocument();
    await userEvent.click(saveButton());

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(postedBody().hourlyRate).toBe(222.5);
  });
});

describe('the link to the task or event the time came from', () => {
  it('keeps an unscoped task link whatever target is picked, and says to pick one', async () => {
    renderModal({
      prefill: { sourceTaskId: 'task-1', sourceTaskTitle: 'Review lease' },
    });

    expect(await screen.findByText('Review lease')).toBeInTheDocument();
    expect(screen.getByText('Linked to task')).toBeInTheDocument();
    expect(screen.getByText(/This task isn't linked to a matter or client/)).toBeInTheDocument();

    // The picker stub only offers items registered here, and a <select> cannot
    // take a value it has no option for, so the client is registered first.
    mockPickerItems['cl-9'] = CLIENT;
    await switchToClientTarget();
    fireEvent.change(screen.getByRole('combobox', { name: 'clients picker' }), {
      target: { value: 'cl-9' },
    });
    await waitFor(() => expect(saveButton()).not.toBeDisabled());
    await userEvent.click(saveButton());

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(postedBody()).toMatchObject({ clientId: 'cl-9', sourceTaskId: 'task-1', sourceEventId: null });
  });

  it("drops an event link when the entry moves off the event's own matter", async () => {
    mockPickerItems['cl-9'] = CLIENT;
    renderModal({
      prefill: {
        matterId: 'm-1',
        sourceEventId: 'ev-1',
        sourceEventTitle: 'Deposition',
        sourceMatterId: 'm-1',
      },
    });
    expect(await screen.findByText('Linked to event')).toBeInTheDocument();

    await switchToClientTarget();
    fireEvent.change(screen.getByRole('combobox', { name: 'clients picker' }), {
      target: { value: 'cl-9' },
    });

    await waitFor(() => expect(screen.queryByText('Deposition')).not.toBeInTheDocument());
    await waitFor(() => expect(saveButton()).not.toBeDisabled());
    await userEvent.click(saveButton());

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(postedBody()).toMatchObject({ clientId: 'cl-9', sourceEventId: null, sourceTaskId: null });
  });

  it("keeps an event link while the entry stays on the event's matter", async () => {
    renderModal({
      prefill: {
        matterId: 'm-1',
        sourceEventId: 'ev-1',
        sourceEventTitle: 'Deposition',
        sourceMatterId: 'm-1',
      },
    });
    await waitFor(() => expect(saveButton()).not.toBeDisabled());
    await userEvent.click(saveButton());

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(postedBody()).toMatchObject({ matterId: 'm-1', sourceEventId: 'ev-1', sourceTaskId: null });
  });

  it("drops a matter-scoped task link when a different matter is picked", async () => {
    renderModal({
      prefill: {
        matterId: 'm-1',
        sourceTaskId: 'task-2',
        sourceTaskTitle: 'Draft brief',
        sourceMatterId: 'm-1',
      },
    });
    expect(await screen.findByText('Draft brief')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'matters picker' }), {
      target: { value: 'm-2' },
    });

    await waitFor(() => expect(screen.queryByText('Draft brief')).not.toBeInTheDocument());
  });

  it("keeps a client-scoped task link only for one of that task's clients", async () => {
    mockPickerItems['cl-9'] = CLIENT;
    renderModal({
      prefill: {
        clientId: 'cl-9',
        sourceTaskId: 'task-3',
        sourceTaskTitle: 'Client call',
        sourceClientIds: ['cl-9'],
      },
    });
    expect(await screen.findByText('Client call')).toBeInTheDocument();
    // Re-picking the task's own client keeps it.
    fireEvent.change(screen.getByRole('combobox', { name: 'clients picker' }), {
      target: { value: 'cl-9' },
    });
    expect(screen.getByText('Client call')).toBeInTheDocument();

    // Any matter is outside a client-scoped task.
    await userEvent.click(screen.getByRole('button', { name: /^Client/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Matter' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'matters picker' }), {
      target: { value: 'm-1' },
    });
    await waitFor(() => expect(screen.queryByText('Client call')).not.toBeInTheDocument());
  });
});

describe('scoped to one client', () => {
  it("offers only that client's matters, including matters of the organizations they belong to", async () => {
    api.get('/clients/cl-9/company-relationships', {
      relationships: [{ id: 'rel-1', companyClientId: 'org-4', clientId: 'cl-9' }],
    });
    renderModal({ scopeClientId: 'cl-9' });

    await waitFor(() => {
      const latest = mockPickerProps[mockPickerProps.length - 1];
      expect(latest.entity).toBe('matters');
      expect(latest.clientId).toBe('cl-9,org-4');
    });
  });

  it('re-selects the scoped client when switching to the client side, and locks the picker to them', async () => {
    api.get('/clients/cl-9/company-relationships', { relationships: [] });
    renderModal({ scopeClientId: 'cl-9' });
    await waitFor(() => expect(api.callsTo('/clients/cl-9/company-relationships')).toHaveLength(1));

    await switchToClientTarget();

    const picker = screen.getByRole('combobox', { name: 'clients picker' });
    expect(picker).toHaveValue('');
    const latest = mockPickerProps[mockPickerProps.length - 1];
    expect(latest.value).toBe('cl-9');
    expect(latest.ids).toEqual(['cl-9']);
    expect(latest.disabled).toBe(true);
    await waitFor(() => expect(saveButton()).not.toBeDisabled());
  });
});
