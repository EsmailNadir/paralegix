import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import CatalogPickerModal from "@/components/ui/CatalogPickerModal";

interface Item {
  id: string;
  label: string;
}

const baseProps = {
  open: true,
  onClose: jest.fn(),
  onAdopted: jest.fn(),
  title: "Pick items",
  description: "Choose items to adopt",
  searchPlaceholder: "Search...",
  getId: (item: Item) => item.id,
  renderRow: (item: Item) => <span>{item.label}</span>,
  loadingLabel: "Loading...",
  emptyLabel: "No items",
  adoptLabel: (n: number) => `Adopt ${n}`,
  errorFallback: "Failed to search",
  adoptErrorFallback: "Failed to adopt",
  onAdopt: jest.fn().mockResolvedValue(undefined),
  mode: "search" as const,
  debounceMs: 300,
};

describe("CatalogPickerModal search race", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // `clearTimeout` on the search debounce only cancels a pending, not-yet-fired
  // timer; once a query's search is actually in flight, typing more can't stop
  // it. A slower response for "sm" landing after "smith"'s used to silently
  // replace the newer results, with the input still showing "smith".
  it("keeps the newest query's results, even when an earlier query's slower response arrives after it", async () => {
    const search = jest.fn((q: string): Promise<{ items: Item[] }> => {
      if (q === "sm") {
        return new Promise((resolve) =>
          setTimeout(() => resolve({ items: [{ id: "1", label: "Smith Old" }] }), 1000)
        );
      }
      if (q === "smith") {
        return new Promise((resolve) =>
          setTimeout(() => resolve({ items: [{ id: "2", label: "Smith New" }] }), 50)
        );
      }
      return Promise.resolve({ items: [] });
    });

    render(<CatalogPickerModal<Item> {...baseProps} search={search} />);

    // Initial empty-query load (debounce is 0 for an empty query).
    await act(async () => {
      jest.advanceTimersByTime(0);
    });
    await act(async () => {});

    const input = screen.getByPlaceholderText("Search...");
    fireEvent.change(input, { target: { value: "sm" } });
    // Let the "sm" debounce elapse, so its search is genuinely in flight
    // (not just a pending, cancellable timer) before the edit below.
    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    fireEvent.change(input, { target: { value: "smith" } });
    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    // Let both responses land: "smith" (50ms) first, "sm" (1000ms) after.
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    await act(async () => {});

    expect(search).toHaveBeenCalledWith("sm");
    expect(search).toHaveBeenCalledWith("smith");
    expect(screen.getByText("Smith New")).toBeInTheDocument();
    expect(screen.queryByText("Smith Old")).not.toBeInTheDocument();
  });
});
