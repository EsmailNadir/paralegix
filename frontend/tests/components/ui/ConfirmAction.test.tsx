import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ConfirmAction from "@/components/ui/ConfirmAction";
import Modal from "@/components/ui/Modal";

function Action({ onConfirm }: { onConfirm: () => Promise<void> }) {
  return <ConfirmAction title="Remove Item" message="Remove saved item?" onConfirm={onConfirm} stacked>
    {(request) => <button onClick={request}>Remove item</button>}
  </ConfirmAction>;
}

it("Escape closes only the confirmation when an editor is underneath it", async () => {
  const closeEditor = jest.fn();
  const remove = jest.fn().mockResolvedValue(undefined);
  render(<Modal isOpen onClose={closeEditor} title="Editor"><Action onConfirm={remove} /></Modal>);
  fireEvent.click(screen.getByRole("button", { name: "Remove item" }));
  const dialog = await screen.findByRole("dialog", { name: "Remove Item" });
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Remove Item" })).not.toBeInTheDocument());
  expect(closeEditor).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "Editor" })).toBeInTheDocument();
});

it("keeps a failed action open for retry, and cancellation makes no request", async () => {
  const remove = jest.fn().mockRejectedValueOnce(new Error("Record is locked")).mockResolvedValue(undefined);
  render(<Action onConfirm={remove} />);
  fireEvent.click(screen.getByRole("button", { name: "Remove item" }));
  let dialog = await screen.findByRole("dialog", { name: "Remove Item" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Remove Item" })).not.toBeInTheDocument());
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Remove item" }));
  dialog = await screen.findByRole("dialog", { name: "Remove Item" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Record is locked");
  expect(remove).toHaveBeenCalledTimes(1);
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Remove Item" })).not.toBeInTheDocument());
  expect(remove).toHaveBeenCalledTimes(2);
});

it("submits once and prevents dismissal while the request is pending", async () => {
  let finish!: () => void;
  const remove = jest.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  render(<Action onConfirm={remove} />);
  fireEvent.click(screen.getByRole("button", { name: "Remove item" }));
  const dialog = await screen.findByRole("dialog", { name: "Remove Item" });
  const confirm = within(dialog).getByRole("button", { name: "Remove" });
  act(() => { confirm.click(); confirm.click(); });
  fireEvent.keyDown(dialog, { key: "Escape" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(remove).toHaveBeenCalledTimes(1);
  expect(dialog).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
  await act(async () => { finish(); });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Remove Item" })).not.toBeInTheDocument());
});
