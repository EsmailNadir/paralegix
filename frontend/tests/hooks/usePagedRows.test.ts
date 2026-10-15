/**
 * `usePagedRows`: pages an already-loaded list without touching its totals.
 *
 * Its own doc comment names two failure modes: a filter that shrinks the set
 * leaving the view stuck on a page with no rows, and a `resetKey` change
 * silently landing the user on the wrong page of the NEW result set instead
 * of restarting at page 1.
 */
import { act, renderHook } from "@testing-library/react";
import usePagedRows from "@/hooks/usePagedRows";

function rows(n: number) {
  return Array.from({ length: n }, (_, i) => i + 1);
}

describe("clamping the current page", () => {
  it("lands on the last page still holding rows when the set shrinks below the current page", () => {
    const { result, rerender } = renderHook(
      ({ data }) => usePagedRows(data, 10),
      { initialProps: { data: rows(35) } },
    );
    act(() => result.current.setPage(4));
    expect(result.current.page).toBe(4);
    expect(result.current.pagedRows).toEqual([31, 32, 33, 34, 35]);

    rerender({ data: rows(12) });
    expect(result.current.totalPages).toBe(2);
    expect(result.current.page).toBe(2);
    expect(result.current.pagedRows).toEqual([11, 12]);
  });

  it("never reports fewer than 1 total page for an empty set", () => {
    const { result } = renderHook(() => usePagedRows([], 10));
    expect(result.current.totalPages).toBe(1);
    expect(result.current.page).toBe(1);
    expect(result.current.pagedRows).toEqual([]);
  });
});

describe("resetKey", () => {
  it("restarts at page 1 when the scoping key changes, even mid-page", () => {
    const { result, rerender } = renderHook(
      ({ data, key }) => usePagedRows(data, 10, key),
      { initialProps: { data: rows(30), key: "search-a" } },
    );
    act(() => result.current.setPage(3));
    expect(result.current.page).toBe(3);

    rerender({ data: rows(50), key: "search-b" });
    expect(result.current.page).toBe(1);
    expect(result.current.pagedRows).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("keeps the current page when the data changes but the key does not", () => {
    const { result, rerender } = renderHook(
      ({ data, key }) => usePagedRows(data, 10, key),
      { initialProps: { data: rows(30), key: "search-a" } },
    );
    act(() => result.current.setPage(2));

    rerender({ data: rows(30), key: "search-a" });
    expect(result.current.page).toBe(2);
  });
});
