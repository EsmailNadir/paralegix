/**
 * `ClientBillingTimeEntriesSection`: the client-side time-entry panel.
 *
 * Rules that produce a wrong number or a wrong disclosure if they slip:
 *
 *   READ-ONLY HAS TWO INDEPENDENT REASONS. A billed entry is read-only
 *   because it is already invoiced. A company-sourced entry (one pulled in
 *   from an organization this client is linked to) is read-only for a
 *   DIFFERENT reason: edit/delete are scoped server-side to THIS panel's own
 *   client id, not the entry's actual owner, so a mutation attempt on it
 *   would 404. Losing either branch offers an action that silently fails or
 *   corrupts billing state.
 *
 *   BULK DELETE MUST SKIP READ-ONLY ROWS, NOT JUST DISABLE THEIR OWN BUTTON.
 *   Selection is server-row-agnostic: a caller ticking every row and hitting
 *   "Delete (N)" must not delete a billed or company-sourced entry just
 *   because it happened to be selected. That runs over the real transport in
 *   `ClientBillingTimeEntriesBulkDelete.contract.test.tsx`.
 *
 *   TOTALS COME FROM THE SERVER SUMMARY, never a sum of the visible page.
 *
 *   THE INLINE TIMER IS GATED ON THIS CLIENT'S OWN SCOPE: a direct timer on
 *   this client, OR a timer on one of this client's OWN matters - never an
 *   unrelated matter's running timer.
 */
const mockUseFirmTimeEntriesTable = jest.fn();
const mockUseBillingTimer = jest.fn();

jest.mock("@/hooks/billingHooks/useFirmTimeEntriesTable", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockUseFirmTimeEntriesTable(...args),
}));

jest.mock("@/contexts/BillingTimerContext", () => ({
  __esModule: true,
  useBillingTimer: () => mockUseBillingTimer(),
}));

jest.mock("@/hooks/chargeCodeHooks/useChargeCodes", () =>
  require("../../support/fixtures/billingContext").noChargeCodesModule());

// The globally-mocked `users.service` resolves `{}` (not an array), which is
// fine for the first synchronous render (useLawFirmUsers falls back to `[]`
// before its query settles) but crashes `TimeEntryModal`'s `users.forEach`
// once that promise resolves - exactly what a test that `await`s anything
// after mount observes. Sidestep the real hook instead of relying on never
// awaiting.
// The arguments are recorded so a spec can see whether the roster was asked for.
const mockUseLawFirmUsers = jest.fn<{ users: never[]; loading: boolean; error: null; refresh: jest.Mock }, unknown[]>(
  () => ({ users: [], loading: false, error: null, refresh: jest.fn() }),
);
jest.mock("@/hooks/useUsers", () => ({
  __esModule: true,
  useLawFirmUsers: (...args: unknown[]) => mockUseLawFirmUsers(...args),
}));

// Same shape of problem for the member-filter dropdown's data source.
jest.mock("@/hooks/useFirmMembers", () => ({
  __esModule: true,
  useFirmMembers: () => [],
}));

import React from "react";
import { screen } from "@testing-library/react";
import ClientBillingTimeEntriesSection from "@/components/clientComp/ClientBillingTimeEntriesSection";
import type { Client, Matter } from "@/types";
import { renderWithProviders } from "../../support/renderWithProviders";
import { billingTimerState, firmTimeEntriesTableState } from "../../support/fixtures/billingContext";

const CLIENT: Client = { id: "client-1", name: "Jane Client", email: "jane@example.test" } as Client;
const CLIENT_MATTERS: Matter[] = [{ id: "matter-1", name: "Estate of Rivera" } as Matter];

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    contextType: "client",
    entityId: "client-1",
    matterId: "",
    userName: "Jane Attorney",
    hours: 2,
    hourlyRate: 200,
    amount: 40000,
    billable: true,
    billingStatus: "unbilled",
    date: "2026-09-01",
    ...overrides,
  };
}

function renderPanel(
  tableOverrides: Record<string, unknown> = {},
  timerOverrides: Record<string, unknown> = {},
  companyNames: Map<string, string> = new Map(),
) {
  mockUseFirmTimeEntriesTable.mockReturnValue(firmTimeEntriesTableState(tableOverrides));
  mockUseBillingTimer.mockReturnValue(billingTimerState(timerOverrides));
  return renderWithProviders(
    <ClientBillingTimeEntriesSection
      lawFirmId="firm-1"
      client={CLIENT}
      clientMatters={CLIENT_MATTERS}
      companyNames={companyNames}
    />,
  );
}

beforeEach(() => {
  mockUseFirmTimeEntriesTable.mockReset();
  mockUseBillingTimer.mockReset();
});

describe("read-only entries", () => {
  it('requests the same uninvoiced statuses as matter time tracking', () => {
    renderPanel();
    expect(mockUseFirmTimeEntriesTable).toHaveBeenCalledWith('firm-1', expect.objectContaining({
      defaultBillingStatus: 'unbilled,queued,covered_by_retainer',
    }));
  });

  it.each(['queued', 'covered_by_retainer'])('leaves %s time editable because it is not invoiced', (billingStatus) => {
    renderPanel({ rows: [entry({ billingStatus })] });
    expect(screen.getByRole('button', { name: 'Edit' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete' })).not.toBeDisabled();
  });

  it("disables Edit and Delete and offers no Bill for a billed entry", () => {
    renderPanel({ rows: [entry({ id: "billed-1", billingStatus: "billed" })] });

    expect(screen.queryByRole("button", { name: "Bill" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Invoiced time cannot be edited" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Invoiced time cannot be deleted" })).toBeDisabled();
  });

  it("disables Edit and Delete for an UNBILLED entry sourced from a linked company", () => {
    // entityId matches a key in companyNames: this entry belongs to a company
    // roster contact, not to this panel's own client, even though the panel
    // is showing it (it flows in because the client is linked to that company).
    renderPanel(
      { rows: [entry({ id: "co-1", entityId: "company-client-9", billingStatus: "unbilled" })] },
      {},
      new Map([["company-client-9", "Acme Holdings"]]),
    );

    expect(screen.queryByRole("button", { name: "Bill" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Invoiced time cannot be edited" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Invoiced time cannot be deleted" })).toBeDisabled();
    expect(screen.getByText("Acme Holdings")).toBeInTheDocument();
  });

  it("leaves a plain unbilled, non-company entry fully actionable", () => {
    renderPanel({ rows: [entry({ id: "open-1" })] });

    expect(screen.getByRole("button", { name: "Bill" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete" })).not.toBeDisabled();
  });
});

describe("the header totals", () => {
  it("shows the server-computed summary, not a sum of the visible page", () => {
    renderPanel({
      rows: [entry({ id: "t1", hours: 1 })],
      summary: { totalHours: 9.5, totalAmount: 123456 },
    });

    expect(screen.getByText("9h 30m")).toBeInTheDocument();
    expect(screen.queryByText("1h 0m")).not.toBeInTheDocument();
  });
});

describe("the inline timer scope", () => {
  it("shows for a timer running directly on this client", () => {
    renderPanel({}, { isActive: true, isRunning: true, clientId: "client-1", targetLabel: "Jane Client" });

    expect(screen.getByText("Jane Client")).toBeInTheDocument();
  });

  it("shows for a timer running on one of this client's own matters", () => {
    renderPanel({}, { isActive: true, isRunning: true, matterId: "matter-1", targetLabel: "Estate of Rivera" });

    expect(screen.getByText("Estate of Rivera")).toBeInTheDocument();
  });

  it("does not surface a timer running on an unrelated matter", () => {
    renderPanel(
      {},
      { isActive: true, isRunning: true, matterId: "someone-elses-matter", targetLabel: "A Different Matter" },
    );

    expect(screen.queryByText("A Different Matter")).not.toBeInTheDocument();
  });
});

// The firm roster feeds only the time-entry modal, so listing a client's time
// must not load it.
describe("the time-entry modal's roster", () => {
  it("is not asked for while the modal is closed", () => {
    mockUseLawFirmUsers.mockClear();
    renderPanel();

    expect(mockUseLawFirmUsers).toHaveBeenCalled();
    expect(mockUseLawFirmUsers.mock.calls.every((call) => call[1] === false)).toBe(true);
  });
});
