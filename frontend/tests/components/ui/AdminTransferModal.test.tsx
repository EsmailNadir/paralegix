/**
 * AdminTransferModal: the last owner picks a successor before leaving the firm.
 *
 * WHAT BREAKS THIS: closing the dialog the moment Transfer is pressed. The
 * transfer is the request that hands the firm to someone else, so the user must
 * see it is in flight, must not be able to dismiss it half way, and must be told
 * in this dialog, beside the choice they made, if it was refused.
 */
import React from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { renderWithProviders } from "../../support/renderWithProviders";
import AdminTransferModal from "@/components/ui/AdminTransferModal";

const MEMBERS = [
  { userId: "u-ann", name: "Ann Lee" },
  { userId: "u-ben", name: "Ben Ortiz" },
];

let onClose: jest.Mock;

beforeEach(() => {
  onClose = jest.fn();
});

function renderModal(onConfirm: (id: string) => Promise<void>) {
  return renderWithProviders(
    <AdminTransferModal isOpen onClose={onClose} onConfirm={onConfirm} eligibleMembers={MEMBERS} />,
  );
}

function chooseBen() {
  fireEvent.click(screen.getByRole("button", { name: /^New Admin/ }));
  fireEvent.click(screen.getByRole("option", { name: "Ben Ortiz" }));
}

it("stays open and busy, and cannot be dismissed, while the transfer is in flight", async () => {
  let finish: () => void = () => {};
  const onConfirm = jest.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  renderModal(onConfirm);
  chooseBen();

  fireEvent.click(screen.getByRole("button", { name: "Transfer & Leave" }));

  expect(onConfirm).toHaveBeenCalledWith("u-ben");
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByRole("button", { name: /Transfer & Leave/ })).toBeDisabled();
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();

  finish();
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
});

it("shows a refused transfer inside the dialog and lets the user try again", async () => {
  const onConfirm = jest.fn()
    .mockRejectedValueOnce(new Error("Ben Ortiz is no longer a member of this firm"))
    .mockResolvedValueOnce(undefined);
  renderModal(onConfirm);
  chooseBen();

  fireEvent.click(screen.getByRole("button", { name: "Transfer & Leave" }));

  const dialog = screen.getByRole("dialog");
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Ben Ortiz is no longer a member of this firm");
  expect(onClose).not.toHaveBeenCalled();
  expect(within(dialog).getByRole("button", { name: "Transfer & Leave" })).toBeEnabled();

  fireEvent.click(within(dialog).getByRole("button", { name: "Transfer & Leave" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(onConfirm).toHaveBeenCalledTimes(2);
});
