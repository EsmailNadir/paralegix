/**
 * The trust transaction form, tested OFFLINE against a fake transport.
 *
 * WHY A COMPONENT SPEC SITS ALONGSIDE THE SERVICE ONE. Two rules about trust
 * money cannot be pinned in `trust.service.ts`, because the service does not
 * implement them: it serialises whatever payload it is handed. The dollars the
 * user types are converted to integer cents HERE, and a malformed or negative
 * amount is refused HERE, before any request is built. So this is where those
 * two rules are asserted.
 *
 * THE AMOUNT IS GUARDED TWICE, AND BOTH LAYERS ARE TESTED. The number input
 * carries `min`/`step`/`required`, so a browser refuses a negative, zero or
 * sub-cent value without ever running the handler. The handler then re-checks
 * the parsed cents, which is the layer that still holds when a value arrives by
 * some route the attributes do not police. The refusal cases below submit the
 * form directly, because going through the button would only ever exercise the
 * attributes and would pass with the handler's guard deleted.
 *
 * The transport is faked rather than the service, so the whole service layer
 * still executes and an unmatched request throws instead of passing quietly.
 * That is what makes "no request was built" a real assertion: with the guard
 * removed the submit reaches the network, and the spec fails on a POST it never
 * registered.
 *
 * EVERY CASE SELECTS A CLIENT FIRST. The handler checks the amount before the
 * client, so a spec that skipped the selection would still see the amount error
 * and would pass even if the client had never been attached.
 */
jest.unmock('@/services/trust.service');
jest.unmock('@/services/clients.service');
jest.unmock('@/services/matters.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import { holdResponse } from '../../support/deferred';
import TransactionForm from '@/components/trustComp/TransactionForm';
import type { TrustAccount } from '@/types/trust';

const LAW_FIRM_ID = 'firm-1';

const ACCOUNTS = [
  { id: 'acct-1', name: 'Main IOLTA', status: 'active' },
] as unknown as TrustAccount[];

let api: ApiMock;
let onSaved: jest.Mock;

beforeEach(() => {
  api = installApiMock();
  onSaved = jest.fn();
  api.get('/clients/lookup', {
    items: [{ id: 'client-7', label: 'Acme Holdings' }],
    hasMore: false,
  });
});

afterEach(() => {
  api.restore();
});

/** Render the open form and pick the client, which is what enables submitting. */
async function openFormWithClient() {
  renderWithProviders(
    <TransactionForm
      open
      lawFirmId={LAW_FIRM_ID}
      accounts={ACCOUNTS}
      onClose={jest.fn()}
      onSaved={onSaved}
    />,
  );

  await userEvent.click(screen.getByText('Select client'));
  await userEvent.click(await screen.findByText('Acme Holdings'));
  await waitFor(() => expect(screen.queryByText('Select client')).not.toBeInTheDocument());
}

function amountInput(): HTMLInputElement {
  return screen.getByPlaceholderText('0.00') as HTMLInputElement;
}

function submitButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Record Transaction' });
}

/**
 * Submit past the input's own constraint validation, so the handler's guard is
 * the thing under test rather than the `min`/`step` attributes.
 */
function submitDirectly() {
  fireEvent.submit(submitButton().closest('form') as HTMLFormElement);
}

/** POSTs only, so the client lookup GET is not mistaken for a write. */
function transactionPosts() {
  return api.calls('POST').filter((call) => call.pathname.endsWith('/transactions'));
}

describe('the amount field refuses what is not money', () => {
  it('declares the constraints that stop a bad value at the browser', async () => {
    await openFormWithClient();

    // The first of the two guards, and the only one a user normally meets: a
    // negative or sub-cent amount cannot even be submitted. Losing `min` would
    // hand a negative deposit straight to the handler, and losing `step` would
    // let a third decimal place through to be rounded away silently.
    const input = amountInput();
    expect(input).toBeRequired();
    expect(input).toHaveAttribute('min', '0.01');
    expect(input).toHaveAttribute('step', '0.01');
  });

  it('refuses a negative amount before building any request', async () => {
    await openFormWithClient();

    fireEvent.change(amountInput(), { target: { value: '-500' } });
    submitDirectly();

    // A negative deposit is a withdrawal wearing the wrong label. Without this
    // the browser would claim to be recording it, and the refusal would come
    // from the backend after the fact.
    expect(await screen.findByText('Enter an amount greater than zero.')).toBeInTheDocument();
    expect(transactionPosts()).toHaveLength(0);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('refuses zero', async () => {
    await openFormWithClient();

    fireEvent.change(amountInput(), { target: { value: '0' } });
    submitDirectly();

    // A zero-cent entry adds a row to a client ledger that moves nothing, which
    // then has to be explained at the next reconciliation.
    expect(await screen.findByText('Enter an amount greater than zero.')).toBeInTheDocument();
    expect(transactionPosts()).toHaveLength(0);
  });

  it('refuses an amount that rounds to less than one cent', async () => {
    await openFormWithClient();

    fireEvent.change(amountInput(), { target: { value: '0.004' } });
    submitDirectly();

    // The boundary a "greater than zero dollars" check misses: four tenths of a
    // cent is positive in dollars and zero in the unit that gets stored, so it
    // would be recorded as a movement of nothing.
    expect(await screen.findByText('Amounts can have at most two decimal places.')).toBeInTheDocument();
    expect(transactionPosts()).toHaveLength(0);
  });

  it('refuses a value the number field could not parse', async () => {
    await openFormWithClient();

    await userEvent.type(amountInput(), 'abc');
    // A number input holds no value for unparseable text, which is what reaches
    // the handler.
    expect(amountInput().value).toBe('');
    submitDirectly();

    // `parseFloat('')` is NaN and `Math.round(NaN * 100)` is NaN, which
    // serialises to `null`. Without the isNaN check the server would be asked to
    // record a transaction carrying no amount at all.
    expect(await screen.findByText('Enter an amount greater than zero.')).toBeInTheDocument();
    expect(transactionPosts()).toHaveLength(0);
  });
});

describe('a valid amount leaves the browser in cents', () => {
  it('converts the dollars typed into an integer number of cents', async () => {
    api.post('/transactions', { transaction: { id: 'txn-1' } });
    await openFormWithClient();

    await userEvent.type(amountInput(), '1234.56');
    await userEvent.click(submitButton());

    await waitFor(() => expect(transactionPosts()).toHaveLength(1));

    // $1,234.56 is 123456 cents. Sending the dollars figure understates the
    // deposit by a factor of a hundred, and the endpoint accepts either.
    const body = transactionPosts()[0].body as Record<string, unknown>;
    expect(body.amountCents).toBe(123456);
    expect(Number.isInteger(body.amountCents)).toBe(true);
  });

  it('refuses a third decimal place rather than rounding it away', async () => {
    api.post('/transactions', { transaction: { id: 'txn-1' } });
    await openFormWithClient();

    fireEvent.change(amountInput(), { target: { value: '10.006' } });
    submitDirectly();

    // $10.006 cannot be stored as typed. Recording it as 1001 cents would pick
    // the amount for the person, so it is refused and they decide. The `step`
    // attribute keeps a third decimal out of the field in normal use, which is
    // why this one is submitted directly.
    expect(await screen.findByText('Amounts can have at most two decimal places.')).toBeInTheDocument();
    expect(transactionPosts()).toHaveLength(0);
  });

  it('refuses an exponent instead of reading 1e3 as a thousand dollars', async () => {
    api.post('/transactions', { transaction: { id: 'txn-1' } });
    await openFormWithClient();

    // A number input accepts exponent notation, so this reaches the handler.
    fireEvent.change(amountInput(), { target: { value: '1e3' } });
    expect(amountInput().value).toBe('1e3');
    submitDirectly();

    expect(await screen.findByText('Enter the amount as a plain number, for example 1000.50.')).toBeInTheDocument();
    expect(transactionPosts()).toHaveLength(0);
  });

  it('refuses an amount above what the server accepts', async () => {
    api.post('/transactions', { transaction: { id: 'txn-1' } });
    await openFormWithClient();

    fireEvent.change(amountInput(), { target: { value: '1000000000.01' } });
    submitDirectly();

    expect(await screen.findByText('Enter an amount of $1,000,000,000 or less.')).toBeInTheDocument();
    expect(transactionPosts()).toHaveLength(0);
  });

  it('sends a two-decimal amount as exact cents where float multiplication drifts', async () => {
    api.post('/transactions', { transaction: { id: 'txn-1' } });
    await openFormWithClient();

    // 1.15 * 100 is 114.99999999999999 in floating point, so a truncating
    // conversion would record 114 cents.
    await userEvent.type(amountInput(), '1.15');
    await userEvent.click(submitButton());

    await waitFor(() => expect(transactionPosts()).toHaveLength(1));
    expect((transactionPosts()[0].body as Record<string, unknown>).amountCents).toBe(115);
  });

  it('attributes the movement to the client that was picked', async () => {
    api.post('/transactions', { transaction: { id: 'txn-1' } });
    await openFormWithClient();

    await userEvent.type(amountInput(), '250');
    await userEvent.click(submitButton());

    await waitFor(() => expect(transactionPosts()).toHaveLength(1));

    // Both the id and the display name travel: the id keys the ledger, the name
    // is what the transaction row shows. A movement attributed to the wrong
    // client still reconciles at the account level, so nothing looks wrong.
    const body = transactionPosts()[0].body as Record<string, unknown>;
    expect(body.clientId).toBe('client-7');
    expect(body.clientName).toBe('Acme Holdings');
    expect(body.trustAccountId).toBe('acct-1');
  });

  it('omits the matter when none was chosen', async () => {
    api.post('/transactions', { transaction: { id: 'txn-1' } });
    await openFormWithClient();

    await userEvent.type(amountInput(), '250');
    await userEvent.click(submitButton());

    await waitFor(() => expect(transactionPosts()).toHaveLength(1));

    // Trust money can sit against a client with no matter. An empty string here
    // would attribute it to a matter that does not exist, and the matter ledger
    // it belongs on would never show it.
    const body = transactionPosts()[0].body as Record<string, unknown>;
    expect('matterId' in body).toBe(false);
    expect('matterName' in body).toBe(false);
  });

  it('sends the direction the user chose', async () => {
    api.post('/transactions', { transaction: { id: 'txn-1' } });
    await openFormWithClient();

    // The trigger's accessible name is now its field label followed by its
    // current value, which is what a screen reader has to hear to know both
    // what the control is and what it says. The anchored /^Deposit/ this used
    // to match asserted the value alone.
    await userEvent.click(screen.getByRole('button', { name: /Deposit/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Withdrawal' }));
    await userEvent.type(amountInput(), '250');
    await userEvent.click(submitButton());

    await waitFor(() => expect(transactionPosts()).toHaveLength(1));

    // Deposits and withdrawals share one endpoint, so `type` is the only thing
    // that decides which way the money moves, and the confirmation reads the
    // same either way.
    expect((transactionPosts()[0].body as Record<string, unknown>).type).toBe('withdrawal');
  });

  it('surfaces a server refusal instead of reporting success', async () => {
    api.post('/transactions', {
      status: 400,
      body: { error: 'Transaction date falls on or before the book-close date' },
    });
    await openFormWithClient();

    await userEvent.type(amountInput(), '250');
    await userEvent.click(submitButton());

    // The period lock is the backend's. Treating the failure as a success closes
    // the form and tells the user money moved when none did.
    expect(await screen.findByText(/book-close date/i)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('Escape while the transaction is being recorded', () => {
  // Red if: the dialog stays dismissible (or Cancel stays enabled) while the
  // POST is in flight, so Escape abandons a save whose refusal then reports
  // into a closed dialog.
  it('keeps the dialog open and Cancel disabled until the save settles', async () => {
    const post = holdResponse();
    api.post('/transactions', post.handler);
    const onClose = jest.fn();
    renderWithProviders(
      <TransactionForm open lawFirmId={LAW_FIRM_ID} accounts={ACCOUNTS} onClose={onClose} onSaved={onSaved} />,
    );
    await userEvent.click(screen.getByText('Select client'));
    await userEvent.click(await screen.findByText('Acme Holdings'));
    await userEvent.type(amountInput(), '250');
    await userEvent.click(submitButton());

    await post.untilRequested();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await act(async () => post.release({ transaction: { id: 'txn-1' } }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('reopening after a recorded transaction', () => {
  // Red if: closing the form keeps the last amount, client and reference, so
  // the next open shows a ready-to-submit copy and one click records the same
  // trust movement twice.
  it('starts blank again with no amount, client or reference carried over', async () => {
    api.post('/transactions', { transaction: { id: 'txn-1' } });
    const props = { lawFirmId: LAW_FIRM_ID, accounts: ACCOUNTS, onClose: jest.fn(), onSaved };
    const view = renderWithProviders(<TransactionForm open {...props} />);
    await userEvent.click(screen.getByText('Select client'));
    await userEvent.click(await screen.findByText('Acme Holdings'));
    await userEvent.type(amountInput(), '250');
    await userEvent.type(screen.getByPlaceholderText("Check #, wire ref"), 'CHK-42');
    await userEvent.click(submitButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));

    view.rerender(<TransactionForm open={false} {...props} />);
    await new Promise((resolve) => setTimeout(resolve, 250));
    view.rerender(<TransactionForm open {...props} />);

    expect(amountInput().value).toBe('');
    expect(screen.getByText('Select client')).toBeInTheDocument();
    expect((screen.getByPlaceholderText("Check #, wire ref") as HTMLInputElement).value).toBe('');
  });
});
