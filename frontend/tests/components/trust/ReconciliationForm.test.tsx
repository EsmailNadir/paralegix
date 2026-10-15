/**
 * `ReconciliationForm`: the three-way IOLTA reconciliation input.
 *
 * The whole point of a trust reconciliation is catching a discrepancy before
 * money goes missing unnoticed, so a wrong number here is the worst kind of
 * silent failure. Rules that produce a wrong "In Balance" verdict:
 *
 *   OUTSTANDING SIGN. `expectedBankCents = book - outstandingNet +
 *   adjustments`. A withdrawal marked outstanding must ADD BACK to the
 *   expected bank figure (the bank hasn't paid it out yet); a deposit marked
 *   outstanding must SUBTRACT (the bank hasn't received it yet). Flipping
 *   either sign silently misstates every reconciliation with an outstanding
 *   item.
 *
 *   BOOK/LEDGER MISMATCH MUST BLOCK "IN BALANCE" even when the bank side
 *   matches exactly - the form's own `isReconciled` requires BOTH.
 *
 *   CSV IMPORT MATCHING IS A MULTISET, NOT A SET. Two uncleared transactions
 *   of the identical amount must each consume their OWN matching bank row;
 *   one bank row can clear only one transaction, not both.
 */
const mockGetSnapshot = jest.fn();
const mockListTransactions = jest.fn();
const mockCreateReconciliation = jest.fn();

jest.mock("@/services/trust.service", () => ({
  __esModule: true,
  default: {
    getReconciliationSnapshot: (...args: unknown[]) => mockGetSnapshot(...args),
    listTransactions: (...args: unknown[]) => mockListTransactions(...args),
    createReconciliation: (...args: unknown[]) => mockCreateReconciliation(...args),
  },
}));

import React from "react";
import { act, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ReconciliationForm from "@/components/trustComp/ReconciliationForm";
import type { TrustAccount, TrustTransaction, ReconciliationSnapshot } from "@/types/trust";
import { renderWithProviders } from "../../support/renderWithProviders";
import { holdResponse } from "../../support/deferred";

const ACCOUNT: TrustAccount = {
  id: "acct-1",
  name: "Primary IOLTA",
  bankName: "Test Bank",
  accountNumberLast4: "1234",
  accountType: "iolta",
  status: "active",
} as TrustAccount;

function snapshot(overrides: Partial<ReconciliationSnapshot> = {}): ReconciliationSnapshot {
  return {
    bookBalanceCents: 100000,
    clientLedgerTotalCents: 100000,
    clientBreakdown: [],
    lastReconciliationDate: null,
    lastReconciledAt: null,
    accountName: "Primary IOLTA",
    reconcileCadence: "monthly",
    nextReconciliationDueDate: null,
    reconciliationOverdue: true,
    ...overrides,
  };
}

function txn(overrides: Partial<TrustTransaction> = {}): TrustTransaction {
  return {
    id: "txn-1",
    trustAccountId: "acct-1",
    type: "withdrawal",
    amountCents: 5000,
    clientId: "client-1",
    clientName: "Jane Client",
    date: "2026-09-01",
    description: "Check #100",
    referenceNumber: "100",
    ...overrides,
  } as TrustTransaction;
}

async function renderForm(
  snap: ReconciliationSnapshot,
  txns: TrustTransaction[],
) {
  mockGetSnapshot.mockResolvedValue(snap);
  mockListTransactions.mockResolvedValue(txns);
  const result = renderWithProviders(
    <ReconciliationForm
      open
      lawFirmId="firm-1"
      accounts={[ACCOUNT]}
      onClose={jest.fn()}
      onSaved={jest.fn()}
    />,
  );
  // Both fetches (snapshot, uncleared transactions) settle before assertions.
  await waitFor(() => expect(screen.getByText(/Book Balance/)).toBeInTheDocument());
  if (txns.length) {
    await waitFor(() => expect(screen.queryByRole("status", { name: "Loading transactions" })).not.toBeInTheDocument());
  }
  return result;
}

async function enterBankBalance(dollars: string) {
  const input = screen.getByLabelText(/Bank Statement Balance/);
  await userEvent.clear(input);
  await userEvent.type(input, dollars);
}

beforeEach(() => {
  mockGetSnapshot.mockReset();
  mockListTransactions.mockReset();
});

it("shows transaction placeholders while the uncleared list is pending", async () => {
  let releaseTransactions: ((value: unknown) => void) | undefined;
  mockGetSnapshot.mockResolvedValue(snapshot());
  mockListTransactions.mockImplementationOnce(() => new Promise((resolve) => { releaseTransactions = resolve; }));

  renderWithProviders(<ReconciliationForm open lawFirmId="firm-1" accounts={[ACCOUNT]} onClose={jest.fn()} onSaved={jest.fn()} />);
  await waitFor(() => expect(releaseTransactions).toBeDefined());
  expect(screen.getByRole("status", { name: "Loading transactions" })).toBeInTheDocument();
  expect(screen.queryByText("No uncleared transactions on or before this date.")).not.toBeInTheDocument();

  releaseTransactions?.([]);
  expect(await screen.findByText("No uncleared transactions on or before this date.")).toBeInTheDocument();
});

/**
 * jsdom's `File` polyfill does not implement `.text()` (confirmed: `new
 * File([...]).text is not a function` under this project's jest/jsdom
 * versions), which the component relies on to read the uploaded CSV. Patch
 * it onto the instance rather than skip the real upload path.
 */
function csvFile(content: string): File {
  const file = new File([content], "statement.csv", { type: "text/csv" });
  Object.defineProperty(file, "text", { value: async () => content });
  return file;
}

describe("the outstanding-transaction sign", () => {
  it("adds an outstanding WITHDRAWAL back to the expected bank balance", async () => {
    // Book is 1000.00; a 50.00 withdrawal hasn't cleared the bank yet, so the
    // bank is expected to be HIGHER than book by that amount: 1050.00.
    await renderForm(snapshot({ bookBalanceCents: 100000 }), [
      txn({ id: "w1", type: "withdrawal", amountCents: 5000 }),
    ]);

    // Uncheck it: leaving a transaction unchecked marks it outstanding.
    fireEvent.click(screen.getByRole("checkbox"));
    await enterBankBalance("1050.00");

    expect(screen.getByText("✓ In Balance")).toBeInTheDocument();
  });

  it("subtracts an outstanding DEPOSIT from the expected bank balance", async () => {
    // Book is 1000.00; a 30.00 deposit hasn't reached the bank yet, so the
    // bank is expected to be LOWER than book by that amount: 970.00.
    await renderForm(snapshot({ bookBalanceCents: 100000 }), [
      txn({ id: "d1", type: "deposit", amountCents: 3000 }),
    ]);

    fireEvent.click(screen.getByRole("checkbox"));
    await enterBankBalance("970.00");

    expect(screen.getByText("✓ In Balance")).toBeInTheDocument();
  });

  it("shows a discrepancy, not In Balance, when the sign would otherwise be flipped", async () => {
    // If the withdrawal sign were flipped, 950.00 would read as "in balance"
    // instead of 1050.00. Assert the WRONG number is rejected.
    await renderForm(snapshot({ bookBalanceCents: 100000 }), [
      txn({ id: "w1", type: "withdrawal", amountCents: 5000 }),
    ]);

    fireEvent.click(screen.getByRole("checkbox"));
    await enterBankBalance("950.00");

    expect(screen.queryByText("✓ In Balance")).not.toBeInTheDocument();
    expect(screen.getByText(/Discrepancy:/)).toBeInTheDocument();
  });
});

describe("book vs. client ledger", () => {
  it("refuses In Balance when book and ledger disagree, even though the bank side matches exactly", async () => {
    await renderForm(snapshot({ bookBalanceCents: 100000, clientLedgerTotalCents: 90000 }), []);

    await enterBankBalance("1000.00");

    expect(screen.queryByText("✓ In Balance")).not.toBeInTheDocument();
    expect(screen.getByText(/Book and client ledger differ/)).toBeInTheDocument();
  });
});

describe("CSV bank-statement import", () => {
  it("matches each uncleared transaction to its own bank row (a multiset, not a set)", async () => {
    // Two withdrawals of the identical amount; the statement carries only ONE
    // matching row. Exactly one may clear - the other must be left outstanding,
    // never both cleared against the same bank line.
    await renderForm(snapshot(), [
      txn({ id: "w1", type: "withdrawal", amountCents: 5000 }),
      txn({ id: "w2", type: "withdrawal", amountCents: 5000 }),
    ]);

    const csv = "Date,Description,Amount\n2026-09-01,Check,-50.00\n";
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [csvFile(csv)] } });

    await waitFor(() =>
      expect(screen.getByText(/Matched 1 of 2 transactions, 1 marked outstanding/)).toBeInTheDocument(),
    );
    expect(screen.getAllByText("OUTSTANDING")).toHaveLength(1);
  });

  it("parses parenthesised and dollar-formatted amounts as negative/positive money", async () => {
    await renderForm(snapshot(), [txn({ id: "w1", type: "withdrawal", amountCents: 5000 })]);

    // "(50.00)" is accounting notation for a negative fifty dollars; the form
    // matches on absolute value, so this must still clear the withdrawal.
    const csv = "Date,Description,Amount\n2026-09-01,Check,($50.00)\n";
        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [csvFile(csv)] } });

    await waitFor(() =>
      expect(screen.getByText(/Matched 1 of 1 transactions, 0 marked outstanding/)).toBeInTheDocument(),
    );
  });
});

describe("ReconciliationForm while the reconciliation is saving", () => {
  // Red if: the dialog stays dismissible during the save (no
  // `dismissible={!saving}`), or the header X or footer Cancel stays enabled,
  // so the user can close it mid-save and a later failure renders into a
  // closed dialog.
  it("cannot be closed until the save settles", async () => {
    mockGetSnapshot.mockResolvedValue(snapshot());
    mockListTransactions.mockResolvedValue([]);
    const held = holdResponse();
    mockCreateReconciliation.mockImplementation(held.handler);
    const onClose = jest.fn();
    const onSaved = jest.fn();
    renderWithProviders(
      <ReconciliationForm open lawFirmId="firm-1" accounts={[ACCOUNT]} onClose={onClose} onSaved={onSaved} />,
    );
    await waitFor(() => expect(screen.getByText(/Book Balance/)).toBeInTheDocument());
    await enterBankBalance("1000.00");
    await userEvent.click(screen.getByRole("button", { name: "Run Reconciliation" }));
    await held.untilRequested();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    await act(async () => held.release({}));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });
});

// Red if: closing the form keeps the last bank balance and notes, so the next
// reconciliation opens pre-filled with figures from a different statement.
it("starts blank again when reopened after closing", async () => {
  mockGetSnapshot.mockResolvedValue(snapshot());
  mockListTransactions.mockResolvedValue([]);
  const props = { lawFirmId: "firm-1", accounts: [ACCOUNT], onClose: jest.fn(), onSaved: jest.fn() };
  const view = renderWithProviders(<ReconciliationForm open {...props} />);
  await waitFor(() => expect(screen.getByText(/Book Balance/)).toBeInTheDocument());
  await enterBankBalance("1000.00");
  await userEvent.type(screen.getByPlaceholderText("Reconciliation notes..."), "September statement");

  view.rerender(<ReconciliationForm open={false} {...props} />);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
  view.rerender(<ReconciliationForm open {...props} />);

  expect((screen.getByLabelText(/Bank Statement Balance/) as HTMLInputElement).value).toBe("");
  expect((screen.getByPlaceholderText("Reconciliation notes...") as HTMLInputElement).value).toBe("");
});

// The bank statement balance and each adjustment are signed: an overdrawn
// statement and a bank fee are both negative, and zero is a real balance. Red
// if a sign is lost, or if the loose parseFloat reading comes back ("1e3" as
// 1000, a third decimal rounded away), so a reconciliation is saved against a
// figure nobody typed.
describe("signed money in the reconciliation", () => {
  beforeEach(() => {
    mockCreateReconciliation.mockReset();
    mockCreateReconciliation.mockResolvedValue({});
  });

  function setBankBalance(value: string) {
    fireEvent.change(screen.getByLabelText(/Bank Statement Balance/), { target: { value } });
  }

  function submit() {
    fireEvent.click(screen.getByRole("button", { name: "Run Reconciliation" }));
  }

  async function addAdjustment(description: string, amount: string) {
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    const descriptions = screen.getAllByPlaceholderText("Description");
    const amounts = screen.getAllByPlaceholderText("$0.00");
    fireEvent.change(descriptions[descriptions.length - 1], { target: { value: description } });
    fireEvent.change(amounts[amounts.length - 1], { target: { value: amount } });
  }

  it("refuses a bank balance with a third decimal instead of rounding it", async () => {
    await renderForm(snapshot(), []);
    setBankBalance("1.005");
    submit();

    expect(await screen.findByText("Bank statement balance: Amounts can have at most two decimal places.")).toBeInTheDocument();
    expect(mockCreateReconciliation).not.toHaveBeenCalled();
  });

  it("refuses an exponent rather than reading 1e3 as a thousand dollars, and shows no verdict for it", async () => {
    // Book is 1000.00, so reading "1e3" as 1000 would declare the account in balance.
    await renderForm(snapshot({ bookBalanceCents: 100000, clientLedgerTotalCents: 100000 }), []);
    setBankBalance("1e3");

    expect(screen.queryByText("✓ In Balance")).not.toBeInTheDocument();
    submit();
    expect(
      await screen.findByText("Bank statement balance: Enter the amount as a plain number, for example -1000.50."),
    ).toBeInTheDocument();
    expect(mockCreateReconciliation).not.toHaveBeenCalled();
  });

  it("saves a negative bank balance and a negative adjustment with their signs", async () => {
    await renderForm(snapshot(), []);
    setBankBalance("-250.50");
    await addAdjustment("Bank fee", "-12.34");
    submit();

    await waitFor(() => expect(mockCreateReconciliation).toHaveBeenCalledTimes(1));
    const payload = mockCreateReconciliation.mock.calls[0][1];
    expect(payload.bankStatementBalanceCents).toBe(-25050);
    expect(payload.adjustments).toEqual([{ description: "Bank fee", amountCents: -1234, category: "other" }]);
  });

  it("saves a zero bank balance", async () => {
    await renderForm(snapshot(), []);
    setBankBalance("0");
    submit();

    await waitFor(() => expect(mockCreateReconciliation).toHaveBeenCalledTimes(1));
    expect(mockCreateReconciliation.mock.calls[0][1].bankStatementBalanceCents).toBe(0);
  });

  it("refuses an adjustment with a third decimal and names which one", async () => {
    await renderForm(snapshot(), []);
    setBankBalance("1000.00");
    await addAdjustment("Bank fee", "-12.345");
    submit();

    expect(await screen.findByText("Adjustment 1: Amounts can have at most two decimal places.")).toBeInTheDocument();
    expect(mockCreateReconciliation).not.toHaveBeenCalled();
  });
});
