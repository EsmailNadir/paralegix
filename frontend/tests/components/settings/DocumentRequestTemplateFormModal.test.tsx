/**
 * DocumentRequestTemplateFormModal: the document request preset form.
 *
 * WHAT BREAKS THIS: rendering the error banner without a close handler, so a
 * refused save leaves an alert the user cannot dismiss, or leaving each
 * requested-item input named only by its placeholder, which a screen reader
 * drops as soon as the field has a value.
 */
import React from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { renderWithProviders } from "../../support/renderWithProviders";
import DocumentRequestTemplateFormModal from "@/components/settingsComp/DocumentRequestTemplateFormModal";

let onCreate: jest.Mock;
let onUpdate: jest.Mock;
let onClose: jest.Mock;

beforeEach(() => {
  onCreate = jest.fn();
  onUpdate = jest.fn();
  onClose = jest.fn();
});

function renderModal() {
  return renderWithProviders(
    <DocumentRequestTemplateFormModal open onClose={onClose} editing={null} onCreate={onCreate} onUpdate={onUpdate} />,
  );
}

it("lets the user dismiss the error from a refused save", async () => {
  onCreate.mockRejectedValue(new Error("A preset with this name already exists"));
  renderModal();
  fireEvent.change(screen.getByLabelText("Preset name *"), { target: { value: "Onboarding" } });
  fireEvent.change(screen.getByLabelText("Default title *"), { target: { value: "Onboarding documents" } });
  fireEvent.click(screen.getByRole("button", { name: "Create preset" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("A preset with this name already exists");
  expect(onClose).not.toHaveBeenCalled();

  // The banner's own close button, not the dialog's.
  fireEvent.click(within(alert).getByRole("button", { name: "Close" }));

  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  // Dismissing the banner is not the same as abandoning the form.
  expect(onClose).not.toHaveBeenCalled();
});

it("names each requested item's inputs by their position, not their placeholder", () => {
  renderModal();
  fireEvent.click(screen.getByRole("button", { name: "Add item" }));

  const second = screen.getByRole("textbox", { name: "Item 2 name" });
  fireEvent.change(second, { target: { value: "Driver's licence" } });

  // Still named once it holds a value, which a placeholder alone is not.
  expect(screen.getByRole("textbox", { name: "Item 2 name" })).toHaveValue("Driver's licence");
  expect(screen.getByRole("textbox", { name: "Item 1 name" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Item 2 description" })).toBeInTheDocument();
});
