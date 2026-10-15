import React from "react";
import { screen } from "@testing-library/react";

import TransactionList from "@/components/trustComp/TransactionList";
import { renderWithProviders } from "../../support/renderWithProviders";
import { grantPermissions, resetPermissions } from "../../support/permissions";

describe("TransactionList", () => {
  const defaultProps = {
    transactions: [],
    totalItems: 0,
    accounts: [{ id: "a1", name: "Main IOLTA", status: "active" }] as any,
    loading: false,
    lawFirmId: "test-law-firm-id",
    filters: {},
    onFiltersChange: jest.fn(),
    page: 1,
    onPageChange: jest.fn(),
    rowsPerPage: 25,
    onRowsPerPageChange: jest.fn(),
    listParams: {},
    onRefresh: jest.fn(),
  };

  it("shows empty state when no transactions", () => {
    // TransactionList keeps a MatterLedgerModal mounted, which reads via React
    // Query, so the tree needs a provider even though the modal is closed.
    renderWithProviders(React.createElement(TransactionList, defaultProps));
    expect(screen.getByText(/No transactions yet/)).toBeInTheDocument();
  });
});

/**
 * Permission gating: `POST /trust/:lawFirmId/transactions` and
 * `PATCH /trust/:lawFirmId/transactions/:id/void`
 * (`backend/src/modules/trust/trust.routes.ts`) both require `trust.manage`.
 * A viewer with only `trust.view` must not see "Record Transaction" or a
 * per-row "Void transaction" control - either would only 403.
 */
describe("permission gating", () => {
  afterEach(() => {
    resetPermissions();
  });

  const props = {
    transactions: [
      {
        id: "txn-1",
        type: "deposit",
        amountCents: 5000,
        status: "completed",
        date: "2026-09-01",
        trustAccountId: "a1",
      },
    ] as any,
    totalItems: 1,
    accounts: [{ id: "a1", name: "Main IOLTA", status: "active" }] as any,
    loading: false,
    lawFirmId: "test-law-firm-id",
    filters: {},
    onFiltersChange: jest.fn(),
    page: 1,
    onPageChange: jest.fn(),
    rowsPerPage: 25,
    onRowsPerPageChange: jest.fn(),
    listParams: {},
    onRefresh: jest.fn(),
  };

  it("hides Record Transaction, Request deposit and Void transaction for a viewer with only trust.view", () => {
    grantPermissions(["trust.view"]);
    renderWithProviders(<TransactionList {...props} />);

    expect(screen.queryByRole("button", { name: /Record Transaction/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Request deposit/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Void transaction/ })).not.toBeInTheDocument();
  });

  it("shows Record Transaction, Request deposit and Void transaction for a viewer with trust.manage", () => {
    grantPermissions(["trust.view", "trust.manage"]);
    renderWithProviders(<TransactionList {...props} />);

    expect(screen.getByRole("button", { name: /Record Transaction/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Request deposit/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Void transaction/ })).toBeInTheDocument();
  });
});
