/**
 * `usePruneStaleFilters`: drops a persisted filter value that no longer
 * matches any available option (a deleted matter, a member who left, a
 * renamed practice area).
 *
 * The hook's own doc comment names the failure mode directly: the list looks
 * empty with no on-screen cause. The riskiest rule is the inverse of pruning -
 * NOT pruning while the option list is still just the placeholder, so a valid
 * filter is never wiped mid-load.
 */
import { renderHook } from "@testing-library/react";
import { usePruneStaleFilters, type PrunableFilter } from "@/hooks/usePruneStaleFilters";

const PLACEHOLDER_ONLY = [{ value: "" }];
const LOADED_OPTIONS = [{ value: "" }, { value: "matter-1" }, { value: "matter-2" }];

beforeEach(() => {
  window.localStorage.clear();
});

function filter(overrides: Partial<PrunableFilter> = {}): PrunableFilter {
  return {
    key: "matterId",
    value: "matter-1",
    options: LOADED_OPTIONS,
    ...overrides,
  };
}

describe("leaving valid filters alone", () => {
  it("does not prune a value that matches a real option", () => {
    const clearKeys = jest.fn();

    renderHook(() => usePruneStaleFilters([filter({ value: "matter-1" })], clearKeys));

    expect(clearKeys).not.toHaveBeenCalled();
  });

  it("does not prune a filter with no value at all", () => {
    const clearKeys = jest.fn();

    renderHook(() => usePruneStaleFilters([filter({ value: "" })], clearKeys));

    expect(clearKeys).not.toHaveBeenCalled();
  });

  it("does not prune while the option list is still just the placeholder", () => {
    // The value points at nothing in `options`, but the list hasn't finished
    // loading yet (only the "All ..." placeholder is there). Pruning here
    // would wipe a legitimate filter before its options ever arrived.
    const clearKeys = jest.fn();

    renderHook(() =>
      usePruneStaleFilters([filter({ value: "matter-deleted", options: PLACEHOLDER_ONLY })], clearKeys),
    );

    expect(clearKeys).not.toHaveBeenCalled();
  });
});

describe("pruning an orphaned value", () => {
  it("clears the key once its options have loaded and no longer contain the value", () => {
    const clearKeys = jest.fn();

    renderHook(() =>
      usePruneStaleFilters([filter({ key: "matterId", value: "matter-deleted", options: LOADED_OPTIONS })], clearKeys),
    );

    expect(clearKeys).toHaveBeenCalledWith(["matterId"]);
  });

  it("removes the persisted value from localStorage", () => {
    window.localStorage.setItem("matters-filter", "matter-deleted");

    renderHook(() =>
      usePruneStaleFilters(
        [filter({ key: "matterId", value: "matter-deleted", storageKey: "matters-filter" })],
        jest.fn(),
      ),
    );

    expect(window.localStorage.getItem("matters-filter")).toBeNull();
  });

  it("still calls clearKeys even when localStorage.removeItem throws (private browsing)", () => {
    const clearKeys = jest.fn();
    const removeSpy = jest
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(() => {
        throw new Error("storage disabled");
      });

    renderHook(() =>
      usePruneStaleFilters(
        [filter({ key: "matterId", value: "matter-deleted", storageKey: "matters-filter" })],
        clearKeys,
      ),
    );

    expect(clearKeys).toHaveBeenCalledWith(["matterId"]);
    removeSpy.mockRestore();
  });

  it("batches every orphaned key into a single clearKeys call", () => {
    const clearKeys = jest.fn();

    renderHook(() =>
      usePruneStaleFilters(
        [
          filter({ key: "matterId", value: "matter-deleted" }),
          filter({ key: "userId", value: "user-gone", options: [{ value: "" }, { value: "user-1" }] }),
        ],
        clearKeys,
      ),
    );

    expect(clearKeys).toHaveBeenCalledTimes(1);
    expect(clearKeys.mock.calls[0][0].sort()).toEqual(["matterId", "userId"]);
  });
});

describe("not re-firing on an unchanged orphan set", () => {
  it("does not call clearKeys again on a re-render with the same stale key", () => {
    const clearKeys = jest.fn();
    const { rerender } = renderHook(
      ({ value }) => usePruneStaleFilters([filter({ value })], clearKeys),
      { initialProps: { value: "matter-deleted" } },
    );
    expect(clearKeys).toHaveBeenCalledTimes(1);

    rerender({ value: "matter-deleted" });

    expect(clearKeys).toHaveBeenCalledTimes(1);
  });
});
