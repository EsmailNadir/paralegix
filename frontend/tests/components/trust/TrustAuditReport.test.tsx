/**
 * The Compliance tab: the firm-wide three-way position across every account.
 *
 * The component's whole job is surfacing things that are otherwise invisible on
 * screen, so the assertions are about what a reader is TOLD, not about layout:
 *
 *   - all three figures, side by side, per account (one of them alone proves
 *     nothing, since the book balance compared to itself always agrees);
 *   - a negative client inside an account whose total looks healthy;
 *   - drift between the stored book balance and the ledger it mirrors;
 *   - an account nobody has reconciled.
 *
 * The transport is faked rather than the service, so `trust.service`'s own url
 * building and response parsing run for real.
 */
import React from "react";
import { screen, waitFor } from "@testing-library/react";
import { installApiMock } from "../../support/apiMock";
import { renderWithProviders } from "../../support/renderWithProviders";

jest.unmock("@/services/trust.service");
jest.unmock("@/services/requestDeduplicator");

import TrustAuditReport from "@/components/trustComp/TrustAuditReport";
import type { TrustAuditAccount, TrustAuditReport as ReportData } from "@/types/trust";

const LAW_FIRM_ID = "firm-1";
const PATH = `/lawfirms/${LAW_FIRM_ID}/trust/audit-report`;

let api: ReturnType<typeof installApiMock>;

/** An account where all three figures agree and nothing is flagged. */
function account(overrides: Partial<TrustAuditAccount> = {}): TrustAuditAccount {
  return {
    trustAccountId: "acct-1",
    name: "Primary IOLTA",
    accountType: "iolta",
    bankName: "Test Bank",
    accountNumberLast4: "1111",
    status: "active",
    bookBalanceCents: 100_000,
    ledgerBalanceCents: 100_000,
    clientLedgerTotalCents: 100_000,
    driftCents: 0,
    balanced: true,
    clientBalances: [{ clientId: "c1", clientName: "Acme", balanceCents: 100_000 }],
    negativeClientBalances: [],
    outstandingCount: 0,
    outstandingNetCents: 0,
    lastReconciliationDate: "2026-08-31",
    lastReconciliationIsReconciled: true,
    bookCloseDate: null,
    nextReconciliationDueDate: "2026-09-30",
    reconciliationOverdue: false,
    ...overrides,
  };
}

function report(overrides: Partial<ReportData> = {}): ReportData {
  const accounts = overrides.accounts ?? [account()];
  return {
    generatedAt: "2026-09-04T12:00:00.000Z",
    reconcileCadence: "monthly",
    retentionYears: 5,
    retentionCutoffDate: "2021-09-04",
    accounts,
    totals: {
      bookBalanceCents: accounts.reduce((s, a) => s + a.bookBalanceCents, 0),
      clientLedgerTotalCents: accounts.reduce((s, a) => s + a.clientLedgerTotalCents, 0),
      balanced: accounts.every((a) => a.balanced),
    },
    ...overrides,
  };
}

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  api.restore();
});

const renderReport = () =>
  renderWithProviders(React.createElement(TrustAuditReport, { lawFirmId: LAW_FIRM_ID }));

describe("TrustAuditReport", () => {
  it("shows all three figures for an account, not just the book balance", async () => {
    api.get(PATH, report());

    renderReport();

    // The book balance alone would be a figure compared to itself. The point of
    // the report is that the reader sees the ledger and the client total beside
    // it, so a disagreement between them is visible without opening anything.
    await waitFor(() => expect(screen.getByText("Primary IOLTA")).toBeInTheDocument());
    expect(screen.getByText(/ledger \$1,000\.00/)).toBeInTheDocument();
    expect(screen.getByText(/clients \$1,000\.00/)).toBeInTheDocument();
  });

  it("reports a firm that balances", async () => {
    api.get(PATH, report());

    renderReport();

    await waitFor(() =>
      expect(screen.getByText("Every account balances")).toBeInTheDocument(),
    );
    expect(screen.getByText("Balanced")).toBeInTheDocument();
  });

  it("flags a negative client inside an account whose total looks healthy", async () => {
    api.get(PATH, report({
      accounts: [account({
        balanced: false,
        negativeClientBalances: [{ clientId: "c2", clientName: "Globex", balanceCents: -25_000 }],
        clientBalances: [
          { clientId: "c1", clientName: "Acme", balanceCents: 125_000 },
          { clientId: "c2", clientName: "Globex", balanceCents: -25_000 },
        ],
      })],
    }));

    renderReport();

    // The account still totals $1,000. Without this row a firm reading only the
    // total would see nothing wrong, while an examiner sees one client's money
    // covering another's shortfall.
    await waitFor(() =>
      expect(screen.getByText("1 negative client")).toBeInTheDocument(),
    );
    expect(screen.getByText("Needs review")).toBeInTheDocument();
    expect(screen.getByText("One or more accounts need review")).toBeInTheDocument();
  });

  it("flags drift between the stored book balance and the ledger", async () => {
    api.get(PATH, report({
      accounts: [account({
        ledgerBalanceCents: 99_000,
        driftCents: 1_000,
        balanced: false,
      })],
    }));

    renderReport();

    // Drift means the running total no longer matches the history it is derived
    // from. Nothing else in the app surfaces it until someone reconciles.
    await waitFor(() => expect(screen.getByText("Drift $10.00")).toBeInTheDocument());
  });

  it("flags an account nobody has reconciled", async () => {
    api.get(PATH, report({
      accounts: [account({
        lastReconciliationDate: null,
        lastReconciliationIsReconciled: null,
        nextReconciliationDueDate: null,
        reconciliationOverdue: true,
      })],
    }));

    renderReport();

    // A never-reconciled account is the one a firm most needs chasing, so it
    // must read as overdue rather than as having no due date yet.
    await waitFor(() =>
      expect(screen.getByText("Reconciliation overdue")).toBeInTheDocument(),
    );
    expect(screen.getByText(/Never reconciled/)).toBeInTheDocument();
  });

  it("counts entries that have not cleared the bank", async () => {
    api.get(PATH, report({
      accounts: [account({ outstandingCount: 2, outstandingNetCents: -30_000 })],
    }));

    renderReport();

    await waitFor(() => expect(screen.getByText("2 outstanding")).toBeInTheDocument());
  });

  it("states the retention cutoff the firm configured", async () => {
    api.get(PATH, report({ retentionYears: 7, retentionCutoffDate: "2019-09-04" }));

    renderReport();

    // A count of years is not actionable. The date it resolves to is what a
    // reader can measure a record against.
    await waitFor(() =>
      expect(screen.getByText(/fall outside the firm's 7-year retention period/)).toBeInTheDocument(),
    );
  });

  it("surfaces a failed read instead of rendering an empty, clean-looking firm", async () => {
    api.get(PATH, { status: 500, body: { error: "boom" } });
    api.allowUnhandled();

    renderReport();

    // This is money the firm holds for clients, so a failed request must not be
    // indistinguishable from a firm holding nothing. The banner carries the
    // server's own message ("boom") rather than the local fallback, which only
    // applies when the error has no message of its own.
    await waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument());
    // The empty state is still rendered underneath, so the banner is the ONLY
    // thing separating "the read failed" from "this firm holds nothing".
    expect(screen.queryByText("Every account balances")).not.toBeInTheDocument();
    expect(screen.queryByText(/retention period/)).not.toBeInTheDocument();
  });
});
