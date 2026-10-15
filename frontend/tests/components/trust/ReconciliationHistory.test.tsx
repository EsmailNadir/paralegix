/**
 * `ReconciliationHistory`: the trust reconciliation list and entry point for
 * running a new 3-way reconciliation.
 *
 * PERMISSION GATING. The backend's `POST /trust/:lawFirmId/reconciliations`
 * route requires `trust.reconcile` (`backend/src/modules/trust/trust.routes.ts`),
 * a permission distinct from `trust.manage` and not part of the baseline a
 * `trust.view`-gated page guarantees. A member who can see the trust page
 * (`trust.view`) but lacks `trust.reconcile` must not be shown "New
 * Reconciliation" - clicking it would only 403.
 */
const mockListReconciliationsPaged = jest.fn();

jest.mock("@/services/trust.service", () => ({
  __esModule: true,
  default: {
    listReconciliationsPaged: (...args: unknown[]) => mockListReconciliationsPaged(...args),
  },
}));

// `ReconciliationHistory` imports `@react-pdf/renderer` (for its PDF download
// button) via `ReconciliationReport`, which ships ESM that Jest cannot parse.
// No test here opens the PDF; only its module graph needs to load.
import React from "react";
jest.mock("@react-pdf/renderer", () => ({
  pdf: jest.fn(),
  Document: ({ children }: { children?: React.ReactNode }) => React.createElement("div", null, children),
  Page: ({ children }: { children?: React.ReactNode }) => React.createElement("div", null, children),
  Text: ({ children }: { children?: React.ReactNode }) => React.createElement("span", null, children),
  View: ({ children }: { children?: React.ReactNode }) => React.createElement("div", null, children),
  StyleSheet: { create: (s: unknown) => s },
  Image: (props: Record<string, unknown>) => React.createElement("img", props),
}));

import { screen, waitFor } from "@testing-library/react";
import ReconciliationHistory from "@/components/trustComp/ReconciliationHistory";
import type { TrustAccount } from "@/types/trust";
import { renderWithProviders } from "../../support/renderWithProviders";
import { grantPermissions, resetPermissions } from "../../support/permissions";

const ACCOUNT: TrustAccount = {
  id: "acct-1",
  name: "Primary IOLTA",
  bankName: "Test Bank",
  accountNumberLast4: "1234",
  accountType: "iolta",
  status: "active",
} as TrustAccount;

beforeEach(() => {
  mockListReconciliationsPaged.mockReset();
  mockListReconciliationsPaged.mockResolvedValue({ reconciliations: [], totalItems: 0 });
});

afterEach(() => {
  resetPermissions();
});

describe("permission gating", () => {
  it("hides New Reconciliation for a viewer with trust.view but not trust.reconcile", async () => {
    grantPermissions(["trust.view", "trust.manage"]);
    renderWithProviders(<ReconciliationHistory lawFirmId="firm-1" accounts={[ACCOUNT]} />);

    await waitFor(() => expect(screen.getByText(/No reconciliations yet/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /New Reconciliation/ })).not.toBeInTheDocument();
  });

  it("shows New Reconciliation for a viewer with trust.reconcile", async () => {
    grantPermissions(["trust.view", "trust.manage", "trust.reconcile"]);
    renderWithProviders(<ReconciliationHistory lawFirmId="firm-1" accounts={[ACCOUNT]} />);

    await waitFor(() => expect(screen.getByText(/No reconciliations yet/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /New Reconciliation/ })).toBeInTheDocument();
  });
});
