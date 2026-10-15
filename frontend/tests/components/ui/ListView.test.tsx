import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";

import ListView from "@/components/ui/ListView";

type Row = { id: string; name: string };

const rows = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `id-${i + 1}`, name: `Row ${i + 1}` }));

const baseProps = {
  getRowId: (row: Row) => row.id,
  renderRow: (row: Row) => ({ title: row.name }),
  showSelection: true,
};

/** The select-all control, which carries its label as its accessible name. */
const selectAllControl = () => screen.getByRole("checkbox", { name: /select all|selected/i });

describe("ListView select-all", () => {
  it("selects every row in a client-paged list, not just the visible page", () => {
    const onSelectionChange = jest.fn();
    render(
      <ListView<Row>
        {...baseProps}
        rows={rows(25)}
        paginationMode="client"
        defaultPageSize={10}
        onSelectionChange={onSelectionChange}
      />
    );

    // Only a page of rows is rendered...
    expect(screen.getByText("Row 10")).toBeInTheDocument();
    expect(screen.queryByText("Row 11")).not.toBeInTheDocument();

    fireEvent.click(selectAllControl());

    // ...but the selection covers all 25.
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(onSelectionChange.mock.calls[0][0]).toHaveLength(25);
    expect(onSelectionChange.mock.calls[0][0]).toContain("id-25");
  });

  it("names the whole set in the default label", () => {
    render(<ListView<Row> {...baseProps} rows={rows(25)} paginationMode="client" defaultPageSize={10} />);
    expect(screen.getByText("Select all 25")).toBeInTheDocument();
  });

  it("clears an existing selection, falling back to an empty selection model", () => {
    const onSelectionChange = jest.fn();
    render(
      <ListView<Row>
        {...baseProps}
        rows={rows(25)}
        paginationMode="client"
        defaultPageSize={10}
        selectionModel={["id-3"]}
        onSelectionChange={onSelectionChange}
      />
    );

    fireEvent.click(selectAllControl());
    expect(onSelectionChange).toHaveBeenCalledWith([]);
  });

  it("delegates to onSelectAll in a server-paged list instead of selecting the page", () => {
    const onSelectAll = jest.fn();
    const onSelectionChange = jest.fn();
    render(
      <ListView<Row>
        {...baseProps}
        rows={rows(10)}
        paginationMode="server"
        page={0}
        pageSize={10}
        rowCount={200}
        showSelectAll
        onSelectAll={onSelectAll}
        onSelectionChange={onSelectionChange}
      />
    );

    fireEvent.click(selectAllControl());
    expect(onSelectAll).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it("clears rather than re-selecting when a server-paged selection already exists", () => {
    const onSelectAll = jest.fn();
    const onClearSelection = jest.fn();
    render(
      <ListView<Row>
        {...baseProps}
        rows={rows(10)}
        paginationMode="server"
        page={0}
        pageSize={10}
        rowCount={200}
        showSelectAll
        selectionModel={["id-1"]}
        onSelectAll={onSelectAll}
        onClearSelection={onClearSelection}
      />
    );

    fireEvent.click(selectAllControl());
    expect(onClearSelection).toHaveBeenCalledTimes(1);
    expect(onSelectAll).not.toHaveBeenCalled();
  });

  it("ignores clicks while the ids are still being fetched", () => {
    const onSelectAll = jest.fn();
    render(
      <ListView<Row>
        {...baseProps}
        rows={rows(10)}
        paginationMode="server"
        page={0}
        pageSize={10}
        rowCount={200}
        showSelectAll
        onSelectAll={onSelectAll}
        selectAllPending
      />
    );

    expect(screen.getByText("Selecting…")).toBeInTheDocument();
    fireEvent.click(selectAllControl());
    expect(onSelectAll).not.toHaveBeenCalled();
  });
});

/**
 * A list with no control strip reserves a row for its background-fetch
 * indicator, so the rows do not jump when it appears. That is right for a list
 * that owns the only indicator, and wrong for the two events tabs: they run
 * three lists off one status filter and show a single indicator beside it, so
 * each list reserved a row for a duplicate and the reservations read as a gap
 * above the first card.
 */
describe("ListView background-fetch indicator", () => {
  const indicators = () => screen.queryAllByText("Updating results…");

  it("reserves a row for its own indicator by default", () => {
    render(
      <ListView<Row>
        getRowId={baseProps.getRowId}
        renderRow={baseProps.renderRow}
        rows={rows(3)}
        fetching={false}
      />
    );

    expect(indicators()).toHaveLength(1);
  });

  it("reserves nothing when the surface says it draws its own", () => {
    render(
      <ListView<Row>
        getRowId={baseProps.getRowId}
        renderRow={baseProps.renderRow}
        rows={rows(3)}
        fetching={false}
        showFetchIndicator={false}
      />
    );

    expect(indicators()).toHaveLength(0);
  });

  it("still marks the rows busy when the caller draws its own indicator", () => {
    const { container } = render(
      <ListView<Row>
        getRowId={baseProps.getRowId}
        renderRow={baseProps.renderRow}
        rows={rows(3)}
        fetching
        showFetchIndicator={false}
      />
    );

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it("reserves nothing when there is no fetch state to report", () => {
    render(
      <ListView<Row>
        getRowId={baseProps.getRowId}
        renderRow={baseProps.renderRow}
        rows={rows(3)}
      />
    );

    expect(indicators()).toHaveLength(0);
  });
});

describe("ListView server pagination", () => {
  const serverList = (props: { page: number; fetching?: boolean; onPageChange: jest.Mock }) => (
    <ListView<Row>
      getRowId={baseProps.getRowId}
      renderRow={baseProps.renderRow}
      rows={rows(10)}
      paginationMode="server"
      pageSize={10}
      rowCount={30}
      {...props}
    />
  );

  it("reports the zero-based next and previous page to the caller", () => {
    const onPageChange = jest.fn();
    render(serverList({ page: 1, onPageChange }));

    expect(screen.getByText("11–20 of 30")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onPageChange).toHaveBeenLastCalledWith(2);
  });

  it("reports the previous page as a zero-based index", () => {
    const onPageChange = jest.fn();
    render(serverList({ page: 1, onPageChange }));

    fireEvent.click(screen.getByRole("button", { name: "Prev" }));
    expect(onPageChange).toHaveBeenLastCalledWith(0);
  });

  it("ignores a page click while the current page is still fetching", () => {
    const onPageChange = jest.fn();
    render(serverList({ page: 0, fetching: true, onPageChange }));

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onPageChange).not.toHaveBeenCalled();
  });
});

it("suppresses the empty state after a load failure while preserving existing rows", () => {
  const { rerender } = render(<ListView<Row> {...baseProps} rows={rows(1)} loadFailed emptyTitle="No matches" />);
  expect(screen.getByText("Row 1")).toBeInTheDocument();
  rerender(<ListView<Row> {...baseProps} rows={[]} loadFailed emptyTitle="No matches" />);
  expect(screen.queryByText("No matches")).not.toBeInTheDocument();
  rerender(<ListView<Row> {...baseProps} rows={[]} emptyTitle="No matches" />);
  expect(screen.getByText("No matches")).toBeInTheDocument();
});
