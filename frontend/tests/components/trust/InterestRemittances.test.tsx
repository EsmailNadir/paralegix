/**
 * The IOLTA interest remittance list and its inline editor.
 *
 * Every figure here is reconciled against a bar-foundation statement, so the
 * cases that matter are the ones that do not look wrong on screen: dollars typed
 * into the form must leave the browser as integer cents, an edit must PUT the
 * record it opened rather than create a second one, and a member who can only
 * view trust must see the history without any way to change it.
 *
 * Driven through the real trust service against a fake transport, because the
 * default service stub in `tests/setup.ts` resolves every call to `{}` and would
 * render an empty list whatever the server said.
 */
jest.unmock('@/services/trust.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import InterestRemittances from '@/components/trustComp/InterestRemittances';
import type { TrustAccount, TrustInterestRemittance } from '@/types/trust';
import { formatDateOnly } from '@/lib/utils/dateUtils';
import { setupApiMock, type MockResponse } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import { grantBaselineMember, resetPermissions } from '../../support/permissions';

const LAW_FIRM_ID = 'firm-1';
const LIST_PATH = `/lawfirms/${LAW_FIRM_ID}/trust/interest-remittances`;

const IOLTA = { id: 'acct-iolta', name: 'IOLTA Operating Trust' } as TrustAccount;
const ESCROW = { id: 'acct-escrow', name: 'Real Estate Escrow' } as TrustAccount;

function remittance(over: Partial<TrustInterestRemittance> = {}): TrustInterestRemittance {
  return {
    id: 'rem-1',
    trustAccountId: IOLTA.id,
    trustAccountName: IOLTA.name,
    periodStart: '2026-01-01',
    periodEnd: '2026-03-31',
    interestEarnedCents: 123456,
    amountRemittedCents: 120000,
    remittedTo: 'State Bar Foundation',
    remittanceDate: '2026-04-15',
    referenceNumber: 'WIRE-889',
    notes: 'Q1 interest',
    status: 'remitted',
    ...over,
  };
}

const api = setupApiMock();

function serveList(remittances: TrustInterestRemittance[], extra: Record<string, unknown> = {}) {
  api.get(LIST_PATH, { remittances, totalItems: remittances.length, ...extra });
}

function render(accounts: TrustAccount[] = [IOLTA, ESCROW]) {
  return renderWithProviders(<InterestRemittances lawFirmId={LAW_FIRM_ID} accounts={accounts} />);
}

/** The second line of each row: period, recipient and reference. */
function detailLines(): HTMLElement[] {
  return screen.getAllByText((_, node) => node?.tagName === 'P' && /Ref: /.test(node.textContent ?? ''));
}

function detailLine(): HTMLElement {
  const [line] = detailLines();
  return line;
}

function listReads() {
  return api.calls('GET').filter((c) => c.pathname.endsWith(LIST_PATH));
}

beforeEach(() => {
  grantBaselineMember(['trust.manage']);
});

afterEach(() => {
  resetPermissions();
});

describe('the remittance history', () => {
  it('renders each amount from integer cents as dollars with separators', async () => {
    serveList([remittance()]);
    render();

    // 123456 cents is $1,234.56. A row that divided twice, or not at all, shows
    // $12.35 or $123,456.00 and the firm's interest record is off by 100x.
    expect(await screen.findByText('$1,234.56')).toBeInTheDocument();
    expect(screen.getByText('$1,200.00')).toBeInTheDocument();
  });

  it('shows the account, status, period, recipient and reference on the row', async () => {
    serveList([remittance()]);
    render();

    expect(await screen.findByText(IOLTA.name)).toBeInTheDocument();
    expect(screen.getByText('Remitted', { selector: 'span' })).toBeInTheDocument();
    expect(detailLine()).toHaveTextContent(
      `${formatDateOnly('2026-01-01')} - ${formatDateOnly('2026-03-31')} • To: State Bar Foundation • Ref: WIRE-889`,
    );
  });

  it('names an open-ended period by the side that is set', async () => {
    serveList([
      remittance({ id: 'a', trustAccountName: 'Start only', periodStart: '2026-01-01', periodEnd: null }),
      remittance({ id: 'b', trustAccountName: 'End only', periodStart: null, periodEnd: '2026-03-31' }),
      remittance({ id: 'c', trustAccountName: 'Neither', periodStart: null, periodEnd: null }),
    ]);
    render();

    await screen.findByText('Start only');
    const lines = detailLines().map((line) => line.textContent);
    expect(lines).toEqual([
      `From ${formatDateOnly('2026-01-01')} • To: State Bar Foundation • Ref: WIRE-889`,
      `Through ${formatDateOnly('2026-03-31')} • To: State Bar Foundation • Ref: WIRE-889`,
      'No period set • To: State Bar Foundation • Ref: WIRE-889',
    ]);
  });

  it('labels a row whose account name did not come back rather than leaving it blank', async () => {
    serveList([remittance({ trustAccountName: null, status: 'pending' })]);
    render();

    expect(await screen.findByText('Unknown Account')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });

  it('says there are none when the firm has recorded no remittances', async () => {
    serveList([]);
    render();

    expect(await screen.findByText('No interest remittances recorded.')).toBeInTheDocument();
  });

  it('warns that a capped history is incomplete', async () => {
    serveList([remittance()], { truncated: true, ceiling: 1, totalItems: 400 });
    render();

    // Reconciled against the bar foundation's statement, a capped list read as
    // complete is a reconciliation that quietly does not balance.
    expect(await screen.findByText(/more interest remittances than we could load at once/i)).toBeInTheDocument();
  });

  it('does not warn when the whole history came back', async () => {
    serveList([remittance()], { truncated: false });
    render();

    await screen.findByText(IOLTA.name);
    expect(screen.queryByText(/than we could load at once/i)).not.toBeInTheDocument();
  });
});

describe('a member who can view trust but not manage it', () => {
  beforeEach(() => {
    grantBaselineMember();
  });

  it('sees the history with no way to add, edit or remove a remittance', async () => {
    serveList([remittance()]);
    render();

    // Proven rendered first, so the absences below are about permission and
    // not about a list that has not loaded yet.
    expect(await screen.findByText('$1,234.56')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add remittance/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit remittance' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove remittance' })).not.toBeInTheDocument();
  });
});

describe('recording a new remittance', () => {
  it('sends the typed dollar amounts as integer cents', async () => {
    const user = userEvent.setup();
    serveList([]);
    api.post(LIST_PATH, { remittance: remittance() });
    render();

    await user.click(await screen.findByRole('button', { name: /add remittance/i }));
    await user.type(screen.getByLabelText('Interest earned ($)'), '1234.56');
    // 0.29 * 100 is 28.999999999999996 in floating point; the server must get 29.
    await user.type(screen.getByLabelText('Amount remitted ($)'), '0.29');
    await user.type(screen.getByLabelText('Remitted to'), 'State Bar Foundation');
    await user.type(screen.getByLabelText('Reference #'), 'CHK-1001');
    await user.type(screen.getByLabelText('Notes'), 'Q1 interest');
    await user.click(screen.getByRole('button', { name: 'Save Remittance' }));

    await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
    expect(api.calls('POST')[0].body).toEqual({
      trustAccountId: IOLTA.id,
      periodStart: null,
      periodEnd: null,
      interestEarnedCents: 123456,
      amountRemittedCents: 29,
      remittedTo: 'State Bar Foundation',
      remittanceDate: null,
      referenceNumber: 'CHK-1001',
      notes: 'Q1 interest',
      status: 'pending',
    });
  });

  it('sends zero cents, not null or NaN, for an amount left blank', async () => {
    const user = userEvent.setup();
    serveList([]);
    api.post(LIST_PATH, { remittance: remittance() });
    render();

    await user.click(await screen.findByRole('button', { name: /add remittance/i }));
    await user.click(screen.getByRole('button', { name: 'Save Remittance' }));

    await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
    const body = api.calls('POST')[0].body as Record<string, unknown>;
    expect(body.interestEarnedCents).toBe(0);
    expect(body.amountRemittedCents).toBe(0);
  });

  it('files the remittance against the account and status the user picked', async () => {
    const user = userEvent.setup();
    serveList([]);
    api.post(LIST_PATH, { remittance: remittance() });
    render();

    await user.click(await screen.findByRole('button', { name: /add remittance/i }));
    await user.click(screen.getByRole('button', { name: /account/i }));
    await user.click(screen.getByRole('option', { name: ESCROW.name }));
    await user.click(screen.getByRole('button', { name: /status/i }));
    await user.click(screen.getByRole('option', { name: 'Remitted' }));
    await user.click(screen.getByRole('button', { name: 'Save Remittance' }));

    await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
    const body = api.calls('POST')[0].body as Record<string, unknown>;
    expect(body.trustAccountId).toBe(ESCROW.id);
    expect(body.status).toBe('remitted');
  });

  it('closes the form and reloads the history once the server accepts it', async () => {
    const user = userEvent.setup();
    serveList([]);
    api.post(LIST_PATH, { remittance: remittance() });
    render();

    await user.click(await screen.findByRole('button', { name: /add remittance/i }));
    expect(listReads()).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Save Remittance' }));

    await waitFor(() => expect(listReads()).toHaveLength(2));
    expect(screen.queryByRole('button', { name: 'Save Remittance' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add remittance/i })).toBeInTheDocument();
  });

  it('keeps the form open with the server reason when the save is refused', async () => {
    const user = userEvent.setup();
    serveList([]);
    api.post(LIST_PATH, { status: 400, body: { error: 'Amount remitted cannot exceed interest earned' } });
    render();

    await user.click(await screen.findByRole('button', { name: /add remittance/i }));
    await user.type(screen.getByLabelText('Interest earned ($)'), '10');
    await user.type(screen.getByLabelText('Amount remitted ($)'), '20');
    await user.click(screen.getByRole('button', { name: 'Save Remittance' }));

    expect(await screen.findByText('Amount remitted cannot exceed interest earned')).toBeInTheDocument();
    // What the user typed survives, so they can correct it rather than start over.
    expect(screen.getByLabelText('Amount remitted ($)')).toHaveValue(20);
    expect(screen.getByRole('button', { name: 'Save Remittance' })).toBeEnabled();
    expect(listReads()).toHaveLength(1);
  });

  it('blocks a second submit while the first is still saving', async () => {
    const user = userEvent.setup();
    serveList([]);
    let release: (value: MockResponse) => void = () => {};
    api.post(LIST_PATH, () => new Promise<MockResponse>((resolve) => { release = resolve; }));
    render();

    await user.click(await screen.findByRole('button', { name: /add remittance/i }));
    await user.click(screen.getByRole('button', { name: 'Save Remittance' }));

    const saving = await screen.findByRole('button', { name: 'Saving...' });
    expect(saving).toBeDisabled();
    await user.click(saving);
    expect(api.calls('POST')).toHaveLength(1);

    release({ status: 200, body: { remittance: remittance() } });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Saving...' })).not.toBeInTheDocument());
  });

  it('cannot be saved when the firm has no trust account to file it against', async () => {
    const user = userEvent.setup();
    serveList([]);
    render([]);

    await user.click(await screen.findByRole('button', { name: /add remittance/i }));

    expect(screen.getByRole('button', { name: 'Save Remittance' })).toBeDisabled();
    expect(api.calls('POST')).toHaveLength(0);
  });
});

describe('editing an existing remittance', () => {
  it('opens with the stored cents shown as dollars', async () => {
    const user = userEvent.setup();
    serveList([remittance()]);
    render();

    await user.click(await screen.findByRole('button', { name: 'Edit remittance' }));

    expect(screen.getByLabelText('Interest earned ($)')).toHaveValue(1234.56);
    expect(screen.getByLabelText('Amount remitted ($)')).toHaveValue(1200);
    expect(screen.getByLabelText('Remitted to')).toHaveValue('State Bar Foundation');
    expect(screen.getByLabelText('Reference #')).toHaveValue('WIRE-889');
    expect(screen.getByLabelText('Notes')).toHaveValue('Q1 interest');
  });

  it('PUTs the changed amount to the record it opened, keeping the fields it did not touch', async () => {
    const user = userEvent.setup();
    serveList([remittance()]);
    api.put(`${LIST_PATH}/rem-1`, { remittance: remittance() });
    render();

    await user.click(await screen.findByRole('button', { name: 'Edit remittance' }));
    const amount = screen.getByLabelText('Amount remitted ($)');
    await user.clear(amount);
    await user.type(amount, '1234.56');
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(api.calls('PUT')).toHaveLength(1));
    expect(api.calls('POST')).toHaveLength(0);
    expect(api.calls('PUT')[0].body).toEqual({
      trustAccountId: IOLTA.id,
      periodStart: '2026-01-01',
      periodEnd: '2026-03-31',
      interestEarnedCents: 123456,
      amountRemittedCents: 123456,
      remittedTo: 'State Bar Foundation',
      remittanceDate: '2026-04-15',
      referenceNumber: 'WIRE-889',
      notes: 'Q1 interest',
      status: 'remitted',
    });
  });

  it('starts a new remittance blank after an edit, so it creates rather than overwrites', async () => {
    const user = userEvent.setup();
    serveList([remittance()]);
    api.post(LIST_PATH, { remittance: remittance({ id: 'rem-2' }) });
    render();

    await user.click(await screen.findByRole('button', { name: 'Edit remittance' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: /add remittance/i }));

    expect(screen.getByLabelText('Interest earned ($)')).toHaveValue(null);
    expect(screen.getByLabelText('Remitted to')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Save Remittance' }));

    await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
    expect(api.calls('PUT')).toHaveLength(0);
    expect((api.calls('POST')[0].body as Record<string, unknown>).status).toBe('pending');
  });
});

describe('removing a remittance', () => {
  it('asks first, naming the account, then DELETEs that record and reloads', async () => {
    const user = userEvent.setup();
    serveList([remittance()]);
    api.delete(`${LIST_PATH}/rem-1`, { status: 204 });
    render();

    await user.click(await screen.findByRole('button', { name: 'Remove remittance' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(`Remove the interest remittance for ${IOLTA.name}?`);
    expect(api.calls('DELETE')).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(api.calls('DELETE')).toHaveLength(1));
    expect(api.calls('DELETE')[0].pathname).toBe(`/api${LIST_PATH}/rem-1`);
    await waitFor(() => expect(listReads()).toHaveLength(2));
  });

  it('sends nothing when the confirmation is cancelled', async () => {
    const user = userEvent.setup();
    serveList([remittance()]);
    render();

    await user.click(await screen.findByRole('button', { name: 'Remove remittance' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.calls('DELETE')).toHaveLength(0);
  });
});
