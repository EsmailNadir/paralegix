import React from "react";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../../support/renderWithProviders";

const mockUseLeadsTable = jest.fn();

jest.mock("@/hooks/leadHooks/useLeadsTable", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockUseLeadsTable(...args),
}));

jest.mock("@/hooks/leadHooks/useLeadStages", () => ({
  __esModule: true,
  default: () => ({ stages: [{ id: "s1", name: "New", color: "#6366f1" }] }),
}));

jest.mock("@/contexts/PermissionsContext", () => ({
  usePermissions: () => ({ hasPermission: () => true }),
}));

jest.mock("@/components/leadComp/IntakeFormsQuickAccess", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/leadComp/LeadDetailModal", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/leadComp/ConvertLeadModal", () => ({
  __esModule: true,
  default: () => null,
}));

import LeadsGrid from "@/components/leadComp/LeadsGrid";

function renderGrid() {
  return renderWithProviders(<LeadsGrid lawFirmId="firm-a" />);
}

describe("LeadsGrid", () => {
  beforeEach(() => {
    mockUseLeadsTable.mockReturnValue({
      rows: [{ id: "l1", name: "Pat Prospect", stageId: "s1" }],
      total: 1,
      loading: false,
      fetching: false,
      error: null,
      refetch: jest.fn(),
      search: "",
      setSearch: jest.fn(),
      page: 1,
      setPage: jest.fn(),
      rowsPerPage: 25,
      setRowsPerPage: jest.fn(),
    });
  });

  it("shows list placeholders during the first read", () => {
    mockUseLeadsTable.mockReturnValueOnce({
      ...mockUseLeadsTable(), rows: [], total: 0, loading: true, fetching: true,
    });

    renderGrid();

    expect(screen.getByRole("status", { name: "Loading leads" })).toBeInTheDocument();
    expect(screen.queryByText("No leads yet")).not.toBeInTheDocument();
  });

  // The leads page is list-only. The stage board and its List/Board toggle
  // were removed, so a toggle coming back would offer a view that no longer
  // exists.
  it("renders the lead list with no view toggle", () => {
    renderGrid();

    // The list rendered, so the absence below is not a page that never drew.
    expect(screen.getByText("Pat Prospect")).toBeInTheDocument();
    expect(screen.getByText("New")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "View mode" })).toBeNull();
    expect(screen.queryByRole("button", { name: /board/i })).toBeNull();
  });
});
