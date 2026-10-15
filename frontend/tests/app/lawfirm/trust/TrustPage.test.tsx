/**
 * The trust accounting workspace: IOLTA balances, client funds, and the
 * transaction ledger behind them.
 *
 * This is money the firm holds on behalf of a client, not the firm's own
 * revenue, so a silent failure here is worse than an ordinary list going
 * blank: a trust account that fails to load must never be indistinguishable
 * from a trust account that genuinely holds nothing. The services stay real
 * and only the transport is faked, so a wrong URL, a swallowed error, or a
 * stale response reaching a switched firm fails the spec instead of a
 * stubbed hook quietly returning whatever the test handed it.
 */
jest.unmock('@/services/trust.service');
jest.unmock('@/services/requestDeduplicator');

const mockRouterPush = jest.fn();
const mockRouterReplace = jest.fn();
const mockRouter = {
  push: mockRouterPush,
  replace: mockRouterReplace,
  back: jest.fn(),
  forward: jest.fn(),
  refresh: jest.fn(),
  prefetch: jest.fn(),
};

const useParamsMock = jest.fn();
const useSearchParamsMock = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useParams: () => useParamsMock(),
  usePathname: () => '/trust',
  useSearchParams: () => useSearchParamsMock(),
}));

// ClientLedgerModal (rendered by the page even when closed) pulls in the PDF
// export path, which ships ESM and pulls in a worker Jest cannot parse. No
// test here opens the ledger PDF; only its module graph needs to load.
jest.mock('@react-pdf/renderer', () => ({
  pdf: jest.fn(),
  Document: ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children),
  Page: ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children),
  Text: ({ children }: { children?: React.ReactNode }) => React.createElement('span', null, children),
  View: ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children),
  StyleSheet: { create: (s: unknown) => s },
  Image: (props: Record<string, unknown>) => React.createElement('img', props),
}));

import React from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import TrustPage from '@/app/lawfirm/[lawFirmId]/trust/page';
import { FirmSettingsProvider } from '@/contexts/FirmSettingsContext';
import { setupApiMock } from '../../../support/apiMock';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { grantBaselineMember, grantOutsider, resetPermissions } from '../../../support/permissions';
import type { TrustAccount, ClientTrustBalance, TrustTransaction, TrustReconciliation } from '@/types/trust';

const FIRM_A = 'firm-a';
const FIRM_B = 'firm-b';
const API = 'http://localhost:5001/api';

const api = setupApiMock();

const accountBase = {
  bankName: 'Chase',
  accountNumberLast4: '1234',
  accountType: 'iolta' as const,
  createdBy: 'test-uid',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
};

function account(overrides: Partial<TrustAccount> = {}): TrustAccount {
  return {
    ...accountBase,
    id: 'acct-1',
    name: 'Main IOLTA',
    status: 'active',
    bookBalance: 500000,
    ...overrides,
  };
}

function balance(overrides: Partial<ClientTrustBalance> = {}): ClientTrustBalance {
  return {
    clientId: 'client-1',
    clientName: 'Acme Co',
    trustAccountId: 'acct-1',
    balanceCents: 300000,
    ...overrides,
  };
}

function transaction(overrides: Partial<TrustTransaction> = {}): TrustTransaction {
  return {
    id: 'txn-1',
    trustAccountId: 'acct-1',
    trustAccountName: 'Main IOLTA',
    type: 'deposit',
    amountCents: 100000,
    clientId: 'client-1',
    clientName: 'Acme Co',
    date: '2025-06-01',
    description: 'Retainer deposit',
    referenceNumber: 'REF-1',
    status: 'completed',
    clientBalanceAfter: 300000,
    accountBalanceAfter: 500000,
    createdBy: 'test-uid',
    createdAt: '2025-06-01T00:00:00.000Z',
    updatedAt: '2025-06-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Every route the page fetches on mount, regardless of which tab is active. */
function seedTrustWorkspace(opts: {
  firmId?: string;
  accounts?: TrustAccount[];
  balances?: ClientTrustBalance[];
  transactions?: TrustTransaction[];
  reconciliation?: TrustReconciliation | null;
} = {}) {
  const firmId = opts.firmId ?? FIRM_A;
  const accounts = opts.accounts ?? [account()];
  const balances = opts.balances ?? [balance()];
  const transactions = opts.transactions ?? [transaction()];
  const base = `${API}/lawfirms/${firmId}/trust`;

  api.getExact(`${base}/accounts`, { accounts });
  api.getExact(`${base}/balances`, { balances });
  api.getExact(`${base}/minimum-balances`, { minimumBalances: [] });
  api.getExact(`${base}/transactions?limit=10&offset=0`, {
    transactions,
    totalItems: transactions.length,
  });

  const firstActive = accounts.find((a) => a.status === 'active');
  if (firstActive) {
    api.getExact(`${base}/reconciliations/latest?trustAccountId=${firstActive.id}`, {
      reconciliation: opts.reconciliation ?? null,
    });
  }
}

function renderTrustPage(options: { trustAccounting?: boolean; firmId?: string } = {}) {
  const { trustAccounting = true, firmId = FIRM_A } = options;
  return renderWithProviders(
    <FirmSettingsProvider lawFirmId={firmId} initialSettings={{ features: { trustAccounting } as never }}>
      <TrustPage />
    </FirmSettingsProvider>,
  );
}

beforeEach(() => {
  useParamsMock.mockReturnValue({ lawFirmId: FIRM_A });
  useSearchParamsMock.mockReturnValue(new URLSearchParams());
});

afterEach(() => {
  resetPermissions();
  jest.clearAllMocks();
});

describe('loaded content', () => {
  it('shows the real totals across accounts, balances, and the latest reconciliation', async () => {
    seedTrustWorkspace({
      accounts: [account({ id: 'acct-1', name: 'Main IOLTA', bookBalance: 500000 })],
      balances: [balance({ clientId: 'c1', clientName: 'Acme Co', balanceCents: 300000 })],
      reconciliation: {
        id: 'rec-1',
        trustAccountId: 'acct-1',
        reconciliationDate: '2025-06-01',
        bankStatementBalanceCents: 500000,
        bookBalanceCents: 500000,
        clientLedgerTotalCents: 500000,
        isReconciled: true,
        discrepancyCents: 0,
        adjustments: [],
        outstandingTransactionIds: [],
        notes: '',
        reconciledBy: 'test-uid',
        reconciledAt: '2025-06-01T00:00:00.000Z',
        createdAt: '2025-06-01T00:00:00.000Z',
        updatedAt: '2025-06-01T00:00:00.000Z',
      },
    });

    renderTrustPage();

    expect(await screen.findByText('Trust Accounting')).toBeInTheDocument();
    // Total trust held, summed across accounts. Scoped to the KPI tile: the
    // account card below shows the same figure for a single-account firm, and
    // the two settle their own loading state independently (the tile also
    // waits on balances and the latest reconciliation), so asserting on the
    // bare text is a race between "found the tile" and "found the card".
    await waitFor(() => {
      const tile = screen.getByText('Total trust held').closest('button')!;
      expect(within(tile).getByText('$5,000.00')).toBeInTheDocument();
    });
    // One client actually holding funds.
    await waitFor(() => expect(screen.getByRole('button', { name: 'View transactions for Main IOLTA' })).toBeInTheDocument());
    expect(screen.getByText('Acme Co')).toBeInTheDocument();
  });
});

describe('a meaningful empty state', () => {
  it('reads as genuinely empty, not broken, when the firm has no trust data yet', async () => {
    seedTrustWorkspace({ accounts: [], balances: [], transactions: [] });

    renderTrustPage();

    await waitFor(() => expect(screen.getByText('No trust accounts yet')).toBeInTheDocument());
    expect(screen.getByText('No client trust balances')).toBeInTheDocument();
    // The reconciliation tile: nothing to reconcile without an account.
    expect(screen.getByText('Never reconciled')).toBeInTheDocument();
  });
});

describe('an API failure, with retry', () => {
  it('tells the user their trust data failed to load rather than showing zero balances', async () => {
    // Seed the whole workspace first, THEN override accounts: a later route
    // registration wins, so registering the failure before the seed would
    // have it clobbered by the seed's own (succeeding) accounts route.
    seedTrustWorkspace(); // balances/minimums/transactions still answer normally
    api.getExact(`${API}/lawfirms/${FIRM_A}/trust/accounts`, { status: 500, body: { error: 'boom' } });

    renderTrustPage();

    // Before the fix this silently rendered "$0.00 across 0 accounts" with no
    // sign anything had gone wrong - indistinguishable from a firm that
    // genuinely holds nothing in trust.
    expect(await screen.findByRole('alert')).toHaveTextContent(/boom/i);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('recovers the real data once the retry succeeds', async () => {
    seedTrustWorkspace();
    let attempt = 0;
    api.getExact(`${API}/lawfirms/${FIRM_A}/trust/accounts`, () => {
      attempt += 1;
      if (attempt === 1) return { status: 500, body: { error: 'boom' } };
      return { accounts: [account({ bookBalance: 500000 })] };
    });

    renderTrustPage();

    const retry = await screen.findByRole('button', { name: 'Try again' });
    await userEvent.click(retry);

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    await waitFor(() => {
      const tile = screen.getByText('Total trust held').closest('button')!;
      expect(within(tile).getByText('$5,000.00')).toBeInTheDocument();
    });
    expect(attempt).toBe(2);
  });
});

describe('narrow access', () => {
  it('turns an outsider away before any trust content renders', async () => {
    grantOutsider();
    seedTrustWorkspace();

    renderTrustPage();

    expect(await screen.findByText('You do not have access to this area')).toBeInTheDocument();
    expect(screen.queryByText('Trust Accounting')).not.toBeInTheDocument();
  });

  // Characterisation, not a bug fix: RequirePermission/RequireFeature only
  // gate what RENDERS. TrustPage's data hooks run unconditionally at the top
  // of the component on every render, so a viewer who is refused the page
  // still causes every one of its requests to go out. The backend's own
  // authorization is what actually protects this data; the frontend gate is
  // cosmetic. Surprising enough to pin explicitly rather than leave implicit.
  it('still fires every trust request for a viewer the page refuses to show anything to', async () => {
    grantOutsider();
    seedTrustWorkspace();

    renderTrustPage();

    await screen.findByText('You do not have access to this area');
    expect(api.callsTo('/trust/accounts')).toHaveLength(1);
    expect(api.callsTo('/trust/balances')).toHaveLength(1);
  });

  it('shows the upgrade screen, not the workspace, when the firm plan lacks trust accounting', async () => {
    grantBaselineMember(['trust.view']); // Explicit read access passes the permission gate.
    seedTrustWorkspace();

    renderTrustPage({ trustAccounting: false });

    expect(await screen.findByText('Trust Accounting is not available on your current plan')).toBeInTheDocument();
    expect(screen.queryByText('Total trust held')).not.toBeInTheDocument();
  });
});

describe('a successful action: opening one account\'s transactions', () => {
  it('filters the ledger to that account and shows its activity', async () => {
    seedTrustWorkspace({
      accounts: [account({ id: 'acct-1', name: 'Main IOLTA' })],
      transactions: [transaction({ id: 'txn-1', description: 'Retainer deposit' })],
    });
    api.getExact(`${API}/lawfirms/${FIRM_A}/trust/transactions?limit=10&offset=0&trustAccountId=acct-1`, {
      transactions: [transaction({ id: 'txn-2', description: 'Filtered deposit' })],
      totalItems: 1,
    });

    renderTrustPage();

    const openAccount = await screen.findByRole('button', { name: 'View transactions for Main IOLTA' });
    await userEvent.click(openAccount);

    // Landed on Transactions, scoped to this account's own filtered request.
    expect(await screen.findByText('Filtered deposit')).toBeInTheDocument();
    expect(screen.queryByText('Retainer deposit')).not.toBeInTheDocument();
  });
});

describe('a refused action: the filtered ledger request fails', () => {
  it('reports the failure and offers a retry rather than showing an empty ledger', async () => {
    seedTrustWorkspace({ accounts: [account({ id: 'acct-1', name: 'Main IOLTA' })] });
    api.getExact(
      `${API}/lawfirms/${FIRM_A}/trust/transactions?limit=10&offset=0&trustAccountId=acct-1`,
      { status: 500, body: { error: 'ledger unreachable' } },
    );

    renderTrustPage();

    const openAccount = await screen.findByRole('button', { name: 'View transactions for Main IOLTA' });
    await userEvent.click(openAccount);

    expect(await screen.findByRole('alert')).toHaveTextContent(/ledger unreachable/i);
  });
});

describe('a law firm switch while a request is pending', () => {
  it('never lets a slow response for the old firm land as the new firm\'s balance', async () => {
    api.getExact(`${API}/lawfirms/${FIRM_A}/trust/accounts`, {
      delayMs: 200,
      body: { accounts: [account({ id: 'acct-a', name: 'Firm A account', bookBalance: 9000000 })] },
    });
    seedTrustWorkspace({ firmId: FIRM_A });
    seedTrustWorkspace({
      firmId: FIRM_B,
      accounts: [account({ id: 'acct-b', name: 'Firm B account', bookBalance: 100000 })],
    });

    const { rerender } = renderTrustPage({ firmId: FIRM_A });

    // Firm A's slow request is still in flight when the viewer switches firms.
    useParamsMock.mockReturnValue({ lawFirmId: FIRM_B });
    rerender(
      <FirmSettingsProvider lawFirmId={FIRM_B} initialSettings={{ features: { trustAccounting: true } as never }}>
        <TrustPage />
      </FirmSettingsProvider>,
    );

    // Firm B's own (fast) data is what settles on screen. Scoped to the KPI
    // tile itself: the same figure also appears on the account card below it,
    // and the two are unrelated for this assertion's purpose.
    await waitFor(() => {
      const tile = screen.getByText('Total trust held').closest('button')!;
      expect(within(tile).getByText('$1,000.00')).toBeInTheDocument();
    });

    // ...and even once firm A's slow response finally arrives, it never
    // overwrites the figure now attributed to firm B.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const tile = screen.getByText('Total trust held').closest('button')!;
    expect(within(tile).getByText('$1,000.00')).toBeInTheDocument();
    expect(screen.queryByText('$90,000.00')).not.toBeInTheDocument();
  });
});
