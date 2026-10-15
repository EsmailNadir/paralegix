import React from "react";
import { render, screen } from "@testing-library/react";

import SigningSessionList from "@/components/signaturesComp/SigningSessionList";

describe("SigningSessionList", () => {
  it("places the filtered document count at the far right with the loading indicator before it", () => {
    render(
      <SigningSessionList
        lawFirmId="law-firm-1"
        sessions={[]}
        totalItems={1}
        summary={{ counts: { in_progress: 1 }, total: 1, notCompleted: 1 }}
        isLoading={false}
        isFetching
        search=""
        onSearchChange={jest.fn()}
        statusFilter="not_completed"
        onStatusFilterChange={jest.fn()}
        page={1}
        rowsPerPage={10}
        onPageChange={jest.fn()}
        onRowsPerPageChange={jest.fn()}
        onDownloadCertificate={jest.fn()}
        onCancelSession={jest.fn()}
        onSignNow={jest.fn()}
        downloadingCert={null}
        cancellingSession={null}
      />,
    );

    const busyIndicator = screen.getByRole("status");
    const documentCount = screen.getByText("1 of 1 document");
    const statusFilters = screen.getByRole("group", { name: "Filter by signing status" });
    const controlRow = statusFilters.parentElement?.parentElement;

    expect(controlRow?.children[0]).toContainElement(statusFilters);
    expect(controlRow?.children[1]).toBe(busyIndicator);
    expect(controlRow?.children[2]).toBe(documentCount);
  });
});
