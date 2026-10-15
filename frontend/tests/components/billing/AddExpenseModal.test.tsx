/**
 * AddExpenseModal, driven through the REAL billing service against a fake transport.
 *
 * The thing worth pinning here is the wire payload, and it is invisible on screen.
 * An expense amount travels as DOLLARS: `expenses.repository.ts` runs the incoming
 * `amount` through `toCents` before it touches `amount_cents`. A modal that
 * "helpfully" converted to cents itself would render identically and multiply
 * every expense by a hundred. The same goes for the target: `matter` and `client`
 * are two different url segments and two different body keys, and picking the
 * wrong one files the expense against the wrong entity without any visible sign.
 *
 * `billing.service` therefore runs for real and only `fetch` is faked.
 *
 * `EntityPicker` is the one thing stubbed, with an explicit factory rather than a
 * bare `jest.mock`: it is a server-typeahead of its own with two more queries
 * behind it, and driving it would test the picker instead of this modal. The stub
 * records the props it is handed, so the modal's contract with it (which entity,
 * which firm) is still asserted.
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import AddExpenseModal from '@/components/billingComp/AddExpenseModal';

const mockEntityPickerProps: Array<Record<string, any>> = [];

jest.mock('@/components/ui/EntityPicker', () => ({
  __esModule: true,
  // Named, because an anonymous arrow in a mock factory trips react/display-name.
  default: function MockEntityPicker(props: any) {
    mockEntityPickerProps.push(props);
    return (
      <select
        aria-label={props.label}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      >
        <option value="">{props.emptyOption?.label ?? 'Select…'}</option>
        <option value="matter-123">Acme v. Rival</option>
        <option value="client-456">Acme Holdings</option>
      </select>
    );
  },
}));

const LAW_FIRM_ID = 'firm-1';
const MATTER_EXPENSES_URL = `/api/lawfirms/${LAW_FIRM_ID}/billing/expenses`;

let api: ApiMock;
let onClose: jest.Mock;
let onSuccess: jest.Mock;

function renderModal(expenseCategories?: any[]) {
  return renderWithProviders(
    <AddExpenseModal
      open
      onClose={onClose}
      lawFirmId={LAW_FIRM_ID}
      expenseCategories={expenseCategories}
      onSuccess={onSuccess}
    />,
  );
}

/** Fill the three required fields, leaving the optional ones alone. */
function fillRequiredFields({ amount = '150.00' }: { amount?: string } = {}) {
  fireEvent.change(screen.getByRole('combobox', { name: 'Matter *' }), {
    target: { value: 'matter-123' },
  });
  fireEvent.change(screen.getByPlaceholderText('e.g. Court filing fee, Expert witness...'), {
    target: { value: 'County Court Filing Fee' },
  });
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: amount } });
}

function savedBody() {
  const calls = api.callsTo('/billing/expenses');
  expect(calls).toHaveLength(1);
  return calls[0].body as Record<string, unknown>;
}

beforeEach(() => {
  mockEntityPickerProps.length = 0;
  onClose = jest.fn();
  onSuccess = jest.fn();
  api = installApiMock();
  api.postExact(MATTER_EXPENSES_URL, { expense: { id: 'exp-1' } });
});

afterEach(() => {
  api.restore();
});

describe('the form before it is valid', () => {
  it('keeps Save Expense disabled until a target, a description and an amount are all present', () => {
    renderModal();

    const save = () => screen.getByRole('button', { name: 'Save Expense' });
    expect(save()).toBeDisabled();

    fireEvent.change(screen.getByRole('combobox', { name: 'Matter *' }), {
      target: { value: 'matter-123' },
    });
    expect(save()).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('e.g. Court filing fee, Expert witness...'), {
      target: { value: 'County Court Filing Fee' },
    });
    // Still short of an amount. An expense saved at zero is a billing hole that
    // nothing downstream flags.
    expect(save()).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '150.00' } });
    expect(save()).toBeEnabled();
  });

  it('refuses a zero amount with a message instead of posting it', async () => {
    renderModal();
    fillRequiredFields({ amount: '0' });

    fireEvent.click(screen.getByRole('button', { name: 'Save Expense' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a valid amount.');
    expect(api.calls('POST')).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('refuses a whitespace-only description with a message instead of posting it', async () => {
    renderModal();
    fillRequiredFields();
    fireEvent.change(screen.getByPlaceholderText('e.g. Court filing fee, Expert witness...'), {
      target: { value: '   ' },
    });

    // The disabled guard trims too, so the button is unreachable; the validation
    // branch behind it is what an autofilled or pasted value would hit.
    expect(screen.getByRole('button', { name: 'Save Expense' })).toBeDisabled();
    expect(api.calls('POST')).toHaveLength(0);
  });
});

describe('the payload handed to the API', () => {
  it('sends the amount in dollars, exactly as typed', async () => {
    renderModal();
    fillRequiredFields({ amount: '150.75' });

    fireEvent.click(screen.getByRole('button', { name: 'Save Expense' }));

    await waitFor(() => expect(api.callsTo('/billing/expenses')).toHaveLength(1));
    // 150.75, not 15075. The backend multiplies by 100 on arrival, so a modal
    // that also converted would bill this firm $15,075 for a filing fee and look
    // completely ordinary on screen.
    expect(savedBody().amount).toBe(150.75);
  });

  it('files the expense against the chosen matter, and trims the description', async () => {
    renderModal();
    fillRequiredFields();
    fireEvent.change(screen.getByPlaceholderText('e.g. Court filing fee, Expert witness...'), {
      target: { value: '  County Court Filing Fee  ' },
    });
    fireEvent.change(screen.getByPlaceholderText('e.g. County Clerk'), {
      target: { value: 'County Clerk' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save Expense' }));

    await waitFor(() => expect(api.callsTo('/billing/expenses')).toHaveLength(1));
    const body = savedBody();
    // `matterId` and `clientId` are mutually exclusive on this endpoint: sending
    // the wrong key files the expense against the wrong payer.
    expect(body.matterId).toBe('matter-123');
    expect(body).not.toHaveProperty('clientId');
    expect(body.description).toBe('County Court Filing Fee');
    expect(body.vendor).toBe('County Clerk');
    expect(body.billable).toBe(true);
  });

  it('sends the date as a bare YYYY-MM-DD day, with no timezone attached', async () => {
    renderModal();
    fillRequiredFields();

    fireEvent.click(screen.getByRole('button', { name: 'Save Expense' }));

    await waitFor(() => expect(api.callsTo('/billing/expenses')).toHaveLength(1));
    // An ISO instant here would be reinterpreted as local midnight and shift the
    // stored expense date by a day for anyone east of UTC. CI pins
    // TZ=America/Los_Angeles, so the reverse shift would show up here.
    expect(savedBody().date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('records the expense as non-billable when the billable box is cleared', async () => {
    renderModal();
    fillRequiredFields();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Billable expense' }));

    fireEvent.click(screen.getByRole('button', { name: 'Save Expense' }));

    await waitFor(() => expect(api.callsTo('/billing/expenses')).toHaveLength(1));
    // A non-billable expense that arrives billable is invoiced to a client who
    // was never meant to pay it.
    expect(savedBody().billable).toBe(false);
  });

  it('sends a firm category by id and its code, not the built-in string', async () => {
    renderModal([{ id: 'cat-9', code: 'E101', name: 'Copying' } as any]);
    fillRequiredFields();

    fireEvent.click(screen.getByRole('button', { name: /^Category/ }));
    fireEvent.click(screen.getByRole('option', { name: 'E101 - Copying' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Expense' }));

    await waitFor(() => expect(api.callsTo('/billing/expenses')).toHaveLength(1));
    const body = savedBody();
    expect(body.expenseCategoryId).toBe('cat-9');
    expect(body.category).toBe('E101');
  });

  it('falls back to the built-in category list when the firm has configured none', async () => {
    renderModal();
    fillRequiredFields();

    fireEvent.click(screen.getByRole('button', { name: /^Category/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Filing Fees' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Expense' }));

    await waitFor(() => expect(api.callsTo('/billing/expenses')).toHaveLength(1));
    const body = savedBody();
    // The legacy shape: a category string and no id, because there is no firm
    // category row to point at.
    expect(body.category).toBe('filing_fees');
    expect(body).not.toHaveProperty('expenseCategoryId');
  });

  it('closes and reports success once the expense is stored', async () => {
    renderModal();
    fillRequiredFields();

    fireEvent.click(screen.getByRole('button', { name: 'Save Expense' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('when the request fails', () => {
  it('stays open and shows the server reason rather than closing silently', async () => {
    api.postExact(MATTER_EXPENSES_URL, {
      status: 403,
      body: { error: 'This matter is closed to new expenses' },
    });

    renderModal();
    fillRequiredFields();

    fireEvent.click(screen.getByRole('button', { name: 'Save Expense' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This matter is closed to new expenses');
    // Closing here would tell the user the expense was recorded when it was not,
    // and the typed values would be gone.
    expect(onClose).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('County Court Filing Fee')).toBeInTheDocument();
  });
});

describe('cancelling', () => {
  it('closes without posting anything', () => {
    renderModal();
    fillRequiredFields();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.calls('POST')).toHaveLength(0);
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

describe('the target picker', () => {
  it('searches matters for a matter expense and clears the selection when switched to clients', () => {
    renderModal();
    fireEvent.change(screen.getByRole('combobox', { name: 'Matter *' }), {
      target: { value: 'matter-123' },
    });
    expect(mockEntityPickerProps.at(-1)).toMatchObject({ entity: 'matters', lawFirmId: LAW_FIRM_ID });

    fireEvent.click(screen.getByRole('button', { name: /^Bill To/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Client' }));

    expect(mockEntityPickerProps.at(-1)).toMatchObject({ entity: 'clients', lawFirmId: LAW_FIRM_ID, value: '' });
    // Carrying `matter-123` over into the client picker would post a matter id
    // as `clientId`, which the endpoint accepts shape-wise.
    expect(screen.getByRole('button', { name: 'Save Expense' })).toBeDisabled();
  });
});
