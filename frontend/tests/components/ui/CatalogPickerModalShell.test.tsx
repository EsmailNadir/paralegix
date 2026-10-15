/**
 * CatalogPickerModal's dialog shell: a named close control, no way out while an
 * adopt is in flight (Cancel is already disabled then), and a stacked variant
 * for the court picker that opens from inside the matter and task forms.
 */
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import CatalogPickerModal from "@/components/ui/CatalogPickerModal";
import { scanAccessibility } from "../../support/accessibility";

interface Item { id: string; label: string }

const ITEMS: Item[] = [{ id: "1", label: "Superior Court" }];

interface Overrides {
  onAdopt?: (ids: string[]) => Promise<void>;
  stacked?: boolean;
}

function renderPicker(overrides: Overrides = {}) {
  const props = {
    open: true,
    onClose: jest.fn(),
    onAdopted: jest.fn(),
    title: "Browse court directory",
    description: "Search the directory",
    searchPlaceholder: "Search...",
    getId: (item: Item) => item.id,
    renderRow: (item: Item) => <span>{item.label}</span>,
    loadingLabel: "Loading...",
    emptyLabel: "No items",
    adoptLabel: (n: number) => `Add ${n}`,
    errorFallback: "Failed to load",
    adoptErrorFallback: "Failed to add",
    onAdopt: jest.fn().mockResolvedValue(undefined),
    mode: "filter" as const,
    loadItems: jest.fn().mockResolvedValue(ITEMS),
    filterItem: () => true,
    ...overrides,
  };
  const view = render(<CatalogPickerModal<Item> {...props} />);
  return { ...view, props };
}

it("names its close control", async () => {
  const { props } = renderPicker();
  await screen.findByText("Superior Court");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

it("passes an accessibility scan", async () => {
  renderPicker();
  await screen.findByText("Superior Court");
  expect((await scanAccessibility(document.body)).violations).toEqual([]);
});

it("refuses the backdrop and the close button while an adopt is in flight", async () => {
  const { props } = renderPicker({ onAdopt: jest.fn(() => new Promise<void>(() => {})) });
  fireEvent.click(await screen.findByText("Superior Court"));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Add 1" }));
  });

  const backdrop = screen.getByRole("dialog").parentElement?.previousElementSibling as HTMLElement;
  fireEvent.click(backdrop);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(props.onClose).not.toHaveBeenCalled();
});

it("opens above another dialog when stacked", async () => {
  renderPicker({ stacked: true });
  await screen.findByText("Superior Court");
  const overlay = screen.getByRole("dialog").parentElement?.parentElement as HTMLElement;
  expect(overlay).toHaveClass("z-[60]");
  expect(overlay.parentElement).toBe(document.body);
});
