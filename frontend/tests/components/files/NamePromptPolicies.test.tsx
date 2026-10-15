import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CreateFolderModal from "@/components/filesComp/CreateFolderModal";
import RenameItemModal from "@/components/filesComp/RenameItemModal";
import TemplateFolderModal from "@/components/templatesComp/TemplateFolderModal";
import type { FileInfo } from "@/services/files.service";

const item = { id: "folder-1", name: "Contracts", isFolder: true } as FileInfo;

/** Red if rejected saves clear names or close dialogs, or the template prompt adopts the file rename policy. */
it.each(["create", "rename", "template"] as const)("keeps %s input after failure and allows a successful retry", async (kind) => {
  const save = jest.fn().mockRejectedValueOnce(new Error("Save refused")).mockResolvedValueOnce(undefined);
  const close = jest.fn();
  render(kind === "create" ? <CreateFolderModal open onClose={close} onCreate={save} />
    : kind === "rename" ? <RenameItemModal open item={item} onClose={close} onRename={save} />
    : <TemplateFolderModal open title="Rename template folder" initialName="Contracts" submitLabel="Save" onSubmit={save} onClose={close} />);
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "  Agreements  " } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(await screen.findByText("Save refused")).toBeInTheDocument();
  expect(save).toHaveBeenCalledTimes(1);
  expect(input).toHaveValue("  Agreements  ");
  expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[1][kind === "rename" ? 1 : 0]).toBe("Agreements");
  await waitFor(() => expect(screen.queryByText("Save refused")).not.toBeInTheDocument());
  expect(close).toHaveBeenCalledTimes(kind === "template" ? 0 : 1);
});

it("skips an unchanged file rename while a template rename still calls its parent", async () => {
  const save = jest.fn().mockResolvedValue(undefined), close = jest.fn();
  const { unmount } = render(<RenameItemModal open item={item} onClose={close} onRename={save} />);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(close).toHaveBeenCalledTimes(1);
  expect(save).not.toHaveBeenCalled();
  unmount();
  render(<TemplateFolderModal open title="Rename template folder" initialName="Contracts" submitLabel="Save" onSubmit={save} onClose={close} />);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  await waitFor(() => expect(save).toHaveBeenCalledWith("Contracts"));
  expect(close).toHaveBeenCalledTimes(1);
});
