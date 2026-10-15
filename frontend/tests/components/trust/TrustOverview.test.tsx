import React from "react";
import { render, screen } from "@testing-library/react";

import TrustOverview from "@/components/trustComp/TrustOverview";
import type { ClientTrustBalance, TrustAccount } from "@/types/trust";

// Fields every TrustAccount carries but which none of these assertions touch.
const accountBase = {
  accountType: "iolta",
  createdBy: "test-uid",
  createdAt: "2025-01-01",
  updatedAt: "2025-01-01",
} satisfies Partial<TrustAccount>;

const mockAccounts: TrustAccount[] = [
  { ...accountBase, id: "a1", name: "Main IOLTA", bankName: "Chase", accountNumberLast4: "1234", status: "active", bookBalance: 500000 },
  { ...accountBase, id: "a2", name: "Secondary", bankName: "BofA", accountNumberLast4: "5678", status: "active", bookBalance: 200000 },
];

const mockBalances: ClientTrustBalance[] = [
  { clientId: "c1", clientName: "Acme", trustAccountId: "a1", balanceCents: 300000 },
  { clientId: "c1", clientName: "Acme", trustAccountId: "a2", balanceCents: 200000 },
  { clientId: "c2", clientName: "Globex", trustAccountId: "a1", balanceCents: 200000 },
  // A closed-out client holds nothing, so it is not "a client with funds".
  { clientId: "c3", clientName: "Initech", trustAccountId: "a1", balanceCents: 0 },
];

const noop = () => {};

const renderOverview = (props: Partial<React.ComponentProps<typeof TrustOverview>> = {}) =>
  render(
    React.createElement(TrustOverview, {
      accounts: mockAccounts,
      onViewAccounts: noop,
      onViewTransactions: noop,
      onViewReconciliation: noop,
      ...props,
    }),
  );

describe("TrustOverview", () => {

  it("totals the book balance across accounts", () => {
    renderOverview();
    expect(screen.getByText("$7,000.00")).toBeInTheDocument();
  });

  it("counts each client holding funds once, ignoring zero balances", () => {
    renderOverview({ balances: mockBalances });
    // c1 spans two accounts, c2 holds one balance, c3 holds nothing.
    expect(screen.getByText("Holding a trust balance")).toBeInTheDocument();
    expect(screen.getAllByText("2").length).toBeGreaterThanOrEqual(2);
  });

  it("renders last reconciliation as Never when none provided", () => {
    renderOverview();
    expect(screen.getByText("Never")).toBeInTheDocument();
    expect(screen.getByText("Never reconciled")).toBeInTheDocument();
  });
});
