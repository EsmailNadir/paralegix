/**
 * The client and matter trust ledger dialogs render the same ledger table from
 * two different endpoints. These specs pin what each one shows, so the shared
 * table cannot drift one parent away from the other: the title wording, the
 * balance line (from the balance endpoint, not the rows on screen), the empty
 * copy, the void treatment, the multi-account column, and the client-only
 * export controls.
 */
jest.unmock('@/services/trust.service');

import React from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import ClientLedgerModal from '@/components/trustComp/ClientLedgerModal';
import MatterLedgerModal from '@/components/trustComp/MatterLedgerModal';
import { STATUS_VARIANTS } from '@/constants/statusMeta';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../support/apiMock';

// The statement PDF is out of scope here; the renderer ships as ESM Jest cannot load.
jest.mock('@react-pdf/renderer', () => ({ pdf: jest.fn() }));
jest.mock('@/components/trustComp/ClientStatementReport', () => () => null);

jest.mock('@/lib/utils/csv', () => ({
  toCsv: jest.fn(() => 'csv'),
  downloadCsv: jest.fn(),
}));

import { toCsv, downloadCsv } from '@/lib/utils/csv';

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  jest.clearAllMocks();
});

afterEach(() => {
  api.restore();
});

const CLIENT_LEDGER = '/api/lawfirms/firm-a/trust/clients/client-a/ledger?limit=25&offset=0&order=desc';
const CLIENT_BALANCE = '/api/lawfirms/firm-a/trust/clients/client-a/balance';
const MATTER_LEDGER = '/api/lawfirms/firm-a/trust/matters/matter-a/ledger?limit=25&offset=0&order=desc';
const MATTER_BALANCE = '/api/lawfirms/firm-a/trust/matters/matter-a/balance';

const DEPOSIT = {
  id: 'txn-1',
  type: 'deposit',
  status: 'completed',
  amountCents: 150000,
  date: '2026-09-01',
  description: 'Retainer',
  referenceNumber: 'CHK-1',
  trustAccountName: 'Main IOLTA',
  clientBalanceAfter: 150000,
};
const VOIDED_TRANSFER = {
  id: 'txn-2',
  type: 'transfer',
  status: 'void',
  amountCents: 2500,
  date: '2026-09-02',
  description: 'Moved by mistake',
  referenceNumber: null,
  trustAccountName: 'Operating Trust',
  clientBalanceAfter: 147500,
};

function oneAccount(totalBalanceCents: number) {
  return { totalBalanceCents, accountBalances: [{ trustAccountId: 'acc-1', balanceCents: totalBalanceCents }] };
}
function twoAccounts(totalBalanceCents: number) {
  return {
    totalBalanceCents,
    accountBalances: [
      { trustAccountId: 'acc-1', balanceCents: totalBalanceCents - 100 },
      { trustAccountId: 'acc-2', balanceCents: 100 },
    ],
  };
}

describe('ClientLedgerModal', () => {
  function renderClient(name?: string) {
    return renderWithProviders(
      <ClientLedgerModal open lawFirmId="firm-a" clientId="client-a" clientName={name} onClose={jest.fn()} />,
    );
  }

  it('titles the dialog "<name>: Ledger" and states the balance endpoint total, not a sum of the rows', async () => {
    api.getExact(CLIENT_LEDGER, { transactions: [DEPOSIT], totalItems: 1 });
    // Deliberately different from the one row's amount.
    api.getExact(CLIENT_BALANCE, { clientId: 'client-a', ...oneAccount(987654) });

    renderClient('Acme Corp');

    expect(await screen.findByRole('heading', { name: 'Acme Corp: Ledger' })).toBeInTheDocument();
    expect(await screen.findByText('Current balance: $9,876.54')).toBeInTheDocument();
  });

  it('falls back to "Client Ledger" when no name is given', async () => {
    api.getExact(CLIENT_LEDGER, { transactions: [], totalItems: 0 });
    api.getExact(CLIENT_BALANCE, { clientId: 'client-a', ...oneAccount(0) });

    renderClient();

    expect(await screen.findByRole('heading', { name: 'Client Ledger' })).toBeInTheDocument();
  });

  it('says there are no transactions for this client and offers no export when the ledger is empty', async () => {
    api.getExact(CLIENT_LEDGER, { transactions: [], totalItems: 0 });
    api.getExact(CLIENT_BALANCE, { clientId: 'client-a', ...oneAccount(0) });

    renderClient('Acme Corp');

    expect(await screen.findByText('No transactions for this client.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /CSV/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download statement/ })).not.toBeInTheDocument();
  });

  it('renders a row per transaction with its typed chip, signed amount and stored balance', async () => {
    api.getExact(CLIENT_LEDGER, { transactions: [DEPOSIT, VOIDED_TRANSFER], totalItems: 2 });
    api.getExact(CLIENT_BALANCE, { clientId: 'client-a', ...oneAccount(150000) });

    renderClient('Acme Corp');

    const depositRow = (await screen.findByText('Retainer')).closest('tr')!;
    const deposit = within(depositRow);
    expect(deposit.getByText('Deposit').className).toContain(STATUS_VARIANTS.success.tint);
    expect(deposit.getByText('+$1,500.00').className).toContain('text-emerald-600');
    expect(deposit.getByText('$1,500.00')).toBeInTheDocument();
    expect(deposit.getByText('CHK-1')).toBeInTheDocument();
    expect(depositRow.className).not.toContain('opacity-40');

    // A void keeps its type but loses its colour, gains a Void chip, strikes the
    // amount, and has no balance of its own.
    const voidRow = screen.getByText('Moved by mistake').closest('tr')!;
    const voided = within(voidRow);
    expect(voidRow.className).toContain('opacity-40');
    expect(voided.getByText('Transfer').className).toContain(STATUS_VARIANTS.neutral.tint);
    expect(voided.getByText('Void').className).toContain(STATUS_VARIANTS.danger.tint);
    expect(voided.getByText('-$25.00').className).toContain('line-through');
    const cells = voidRow.querySelectorAll('td');
    expect(cells[cells.length - 1].textContent).toBe('-');

    // One funded account: no Account column.
    expect(screen.queryByRole('columnheader', { name: 'Account' })).not.toBeInTheDocument();
  });

  it('adds the Account column once more than one account holds funds', async () => {
    api.getExact(CLIENT_LEDGER, { transactions: [DEPOSIT], totalItems: 1 });
    api.getExact(CLIENT_BALANCE, { clientId: 'client-a', ...twoAccounts(150000) });

    renderClient('Acme Corp');

    expect(await screen.findByRole('columnheader', { name: 'Account' })).toBeInTheDocument();
    expect(screen.getByText('Main IOLTA')).toBeInTheDocument();
  });

  it('exports the whole ledger oldest first to a CSV named after the client', async () => {
    api.getExact(CLIENT_LEDGER, { transactions: [DEPOSIT], totalItems: 1 });
    api.getExact(CLIENT_BALANCE, { clientId: 'client-a', ...oneAccount(150000) });
    api.getExact('/api/lawfirms/firm-a/trust/clients/client-a/ledger?limit=200&offset=0&order=asc', {
      transactions: [DEPOSIT],
      totalItems: 1,
    });

    renderClient('Acme Corp');

    fireEvent.click(await screen.findByRole('button', { name: /CSV/ }));

    await waitFor(() => expect(downloadCsv).toHaveBeenCalledWith('trust-ledger-Acme-Corp.csv', 'csv'));
    expect((toCsv as jest.Mock).mock.calls[0][0]).toEqual([
      expect.objectContaining({ type: 'Deposit', amount: '1500.00', balance: '1500.00', account: 'Main IOLTA' }),
    ]);
    expect(screen.getByRole('button', { name: /Download statement/ })).toBeInTheDocument();
  });
});

describe('MatterLedgerModal', () => {
  function renderMatter(name?: string) {
    return renderWithProviders(
      <MatterLedgerModal open lawFirmId="firm-a" matterId="matter-a" matterName={name} onClose={jest.fn()} />,
    );
  }

  it('titles the dialog "<name>: Trust Ledger" with the balance endpoint total', async () => {
    api.getExact(MATTER_LEDGER, { transactions: [DEPOSIT], totalItems: 1 });
    api.getExact(MATTER_BALANCE, { matterId: 'matter-a', ...oneAccount(4200) });

    renderMatter('Smith v. Jones');

    expect(await screen.findByRole('heading', { name: 'Smith v. Jones: Trust Ledger' })).toBeInTheDocument();
    expect(await screen.findByText('Current balance: $42.00')).toBeInTheDocument();
  });

  it('falls back to "Matter Trust Ledger" when no name is given', async () => {
    api.getExact(MATTER_LEDGER, { transactions: [], totalItems: 0 });
    api.getExact(MATTER_BALANCE, { matterId: 'matter-a', ...oneAccount(0) });

    renderMatter();

    expect(await screen.findByRole('heading', { name: 'Matter Trust Ledger' })).toBeInTheDocument();
  });

  it('says there are no transactions for this matter', async () => {
    api.getExact(MATTER_LEDGER, { transactions: [], totalItems: 0 });
    api.getExact(MATTER_BALANCE, { matterId: 'matter-a', ...oneAccount(0) });

    renderMatter('Smith v. Jones');

    expect(await screen.findByText('No transactions for this matter.')).toBeInTheDocument();
  });

  it('renders the same rows as the client ledger but offers no export', async () => {
    api.getExact(MATTER_LEDGER, { transactions: [DEPOSIT, VOIDED_TRANSFER], totalItems: 2 });
    api.getExact(MATTER_BALANCE, { matterId: 'matter-a', ...twoAccounts(150000) });

    renderMatter('Smith v. Jones');

    const depositRow = (await screen.findByText('Retainer')).closest('tr')!;
    expect(within(depositRow).getByText('Deposit').className).toContain(STATUS_VARIANTS.success.tint);
    expect(within(depositRow).getByText('+$1,500.00')).toBeInTheDocument();
    const voidRow = screen.getByText('Moved by mistake').closest('tr')!;
    expect(voidRow.className).toContain('opacity-40');
    expect(within(voidRow).getByText('Void')).toBeInTheDocument();
    expect(await screen.findByRole('columnheader', { name: 'Account' })).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: /CSV/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download statement/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });
});
