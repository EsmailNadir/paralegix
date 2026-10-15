import { act, renderHook } from "@testing-library/react";

import useServerTable from "@/hooks/useServerTable";
import { SEARCH_DEBOUNCE_MS } from "@/lib/constants/search";

describe("useServerTable", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    // Flush the trailing search-debounce timer inside act() so its state update
    // doesn't land outside a render pass and warn.
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  it("starts on page 1 with the supplied default sort", () => {
    const { result } = renderHook(() =>
      useServerTable<string>({ defaultSort: [{ field: "dueDate", sort: "asc" }] })
    );

    expect(result.current.page).toBe(1);
    expect(result.current.sortModel).toEqual([{ field: "dueDate", sort: "asc" }]);
    expect(result.current.queryParams.page).toBe(1);
    expect(result.current.queryParams.sort).toEqual([{ field: "dueDate", sort: "asc" }]);
    expect(result.current.queryParams.search).toBe("");
  });

  it("seeds the filter bag from initialFilters and drops empty values", () => {
    const { result } = renderHook(() =>
      useServerTable<string>({
        defaultSort: [{ field: "name", sort: "asc" }],
        initialFilters: { status: "active", category: "" },
      })
    );

    expect(result.current.filters).toEqual({ status: "active" });
    expect(result.current.queryParams.filters).toEqual({ status: "active" });
  });

  it("debounces search: the raw value is immediate, queryParams.search is delayed", () => {
    const { result } = renderHook(() =>
      useServerTable<string>({ defaultSort: [{ field: "name", sort: "asc" }] })
    );

    act(() => {
      result.current.setSearch("smith");
    });

    // Raw input updates on the keystroke so the controlled field stays snappy.
    expect(result.current.search).toBe("smith");
    // The server-bound term has not caught up yet.
    expect(result.current.queryParams.search).toBe("");

    act(() => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });

    expect(result.current.queryParams.search).toBe("smith");
  });

  it("resets to page 1 when the debounced search term lands", () => {
    const { result } = renderHook(() =>
      useServerTable<string>({ defaultSort: [{ field: "name", sort: "asc" }] })
    );

    act(() => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    act(() => {
      result.current.setPage(4);
    });
    expect(result.current.page).toBe(4);

    act(() => {
      result.current.setSearch("smith");
    });
    act(() => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });

    expect(result.current.page).toBe(1);
  });

  it("resets to page 1 on a filter change", () => {
    const { result } = renderHook(() =>
      useServerTable<string>({ defaultSort: [{ field: "name", sort: "asc" }] })
    );

    act(() => {
      result.current.setPage(3);
    });
    expect(result.current.page).toBe(3);

    act(() => {
      result.current.setFilter("status", "closed");
    });

    expect(result.current.page).toBe(1);
    expect(result.current.queryParams.filters).toEqual({ status: "closed" });
  });

  it("clears a filter when set to an empty value", () => {
    const { result } = renderHook(() =>
      useServerTable<string>({
        defaultSort: [{ field: "name", sort: "asc" }],
        initialFilters: { status: "active" },
      })
    );

    act(() => {
      result.current.setFilter("status", "");
    });

    expect(result.current.filters).toEqual({});
  });

  it("resets to page 1 on a sort change and falls back to the default sort", () => {
    const { result } = renderHook(() =>
      useServerTable<string>({ defaultSort: [{ field: "name", sort: "asc" }] })
    );

    act(() => {
      result.current.setPage(5);
    });

    act(() => {
      result.current.handleRequestSort([{ field: "status", sort: "desc" }]);
    });

    expect(result.current.page).toBe(1);
    expect(result.current.sortModel).toEqual([{ field: "status", sort: "desc" }]);

    act(() => {
      result.current.setPage(2);
    });
    act(() => {
      result.current.handleRequestSort([]);
    });

    expect(result.current.page).toBe(1);
    expect(result.current.sortModel).toEqual([{ field: "name", sort: "asc" }]);
  });

  it("resets to page 1 on a page-size change", () => {
    const { result } = renderHook(() =>
      useServerTable<string>({ defaultSort: [{ field: "name", sort: "asc" }] })
    );

    act(() => {
      result.current.setPage(6);
    });
    act(() => {
      result.current.setRowsPerPage(50);
    });

    expect(result.current.page).toBe(1);
    expect(result.current.rowsPerPage).toBe(50);
    expect(result.current.queryParams.limit).toBe(50);
  });

  it("clearFilters empties the bag and returns to page 1", () => {
    const { result } = renderHook(() =>
      useServerTable<string>({
        defaultSort: [{ field: "name", sort: "asc" }],
        initialFilters: { status: "active", leadUserId: "user-1" },
      })
    );

    act(() => {
      result.current.setPage(2);
    });
    act(() => {
      result.current.clearFilters();
    });

    expect(result.current.filters).toEqual({});
    expect(result.current.page).toBe(1);
  });

  it("keeps queryParams referentially stable across unrelated re-renders", () => {
    const { result, rerender } = renderHook(() =>
      useServerTable<string>({ defaultSort: [{ field: "name", sort: "asc" }] })
    );

    const first = result.current.queryParams;
    rerender();

    expect(result.current.queryParams).toBe(first);
  });
});
