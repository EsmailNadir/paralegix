import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import CreditNoteModal from "@/components/billingComp/CreditNoteModal";

/**
 * Red if either invoice surface can be dismissed while a credit note is saving:
 * Escape or Cancel would abandon the dialog and a late failure would land in a
 * dialog that is already gone.
 */
it.each(["client", "detail"] as const)("blocks %s dismissal while a credit note is saving", (presentation) => {
  const close = jest.fn(), save = jest.fn();
  render(<CreditNoteModal open presentation={presentation} titleId="credit-title" saving invoiceName="March services"
    remaining="$400.00" onClose={close} onSave={save}
    type="discount" onTypeChange={jest.fn()} amount="50" onAmountChange={jest.fn()}
    description="Courtesy discount" onDescriptionChange={jest.fn()} />);
  expect(screen.getByRole("dialog", { name: "Add Credit Note" })).toBeInTheDocument();
  expect(screen.getByLabelText("Amount *")).toHaveValue(50);
  expect(screen.getByRole("button", { name: "Adding..." })).toBeDisabled();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  expect(close).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});

/**
 * Red if a refused credit note is not reported inside the dialog. Both invoice
 * surfaces keep their page banner under the dialog's backdrop, so the reason
 * has to be drawn here while the form stays open for a retry.
 */
it.each(["client", "detail"] as const)("shows a refused %s credit note inside the dialog", (presentation) => {
  render(<CreditNoteModal open presentation={presentation} titleId="credit-title" saving={false} invoiceName="March services"
    remaining="$400.00" onClose={jest.fn()} onSave={jest.fn()} error="Credit exceeds the balance"
    type="discount" onTypeChange={jest.fn()} amount="50" onAmountChange={jest.fn()}
    description="" onDescriptionChange={jest.fn()} />);
  const dialog = screen.getByRole("dialog", { name: "Add Credit Note" });
  expect(within(dialog).getByRole("alert")).toHaveTextContent("Credit exceeds the balance");
});
