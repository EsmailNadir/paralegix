import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import TemplatePreviewModal from "@/components/templatesComp/TemplatePreviewModal";
import NotePrintPreviewModal from "@/components/notesComp/NotePrintPreviewModal";

/** Red if the viewer extraction permits template scripts, removes print gating, or changes the print target. */
it("keeps HTML template content in a sandbox and closes through its own button", () => {
  const close = jest.fn();
  render(<TemplatePreviewModal open name="Engagement" content={{ kind: "html", url: "blob:template" }} onClose={close} />);
  const frame = screen.getByTitle("Template Preview");
  expect(frame).toHaveAttribute("sandbox", "");
  expect(frame).toHaveAttribute("src", "blob:template");
  expect(screen.getByRole("heading", { name: "Engagement Preview" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
  expect(close).toHaveBeenCalledTimes(1);
});

it("prints the loaded note iframe rather than the app window", () => {
  render(<NotePrintPreviewModal isOpen lawFirmId="firm-1" matterId="matter-1" noteId="note-1" onClose={jest.fn()} />);
  const frame = screen.getByTitle("Note print preview") as HTMLIFrameElement;
  const print = jest.fn();
  Object.defineProperty(frame, "contentWindow", { value: { print }, configurable: true });
  expect(frame).toHaveAttribute("src", "/lawfirm/firm-1/matters/matter-1/notes/note-1/print");
  expect(screen.getByRole("button", { name: "Print" })).toBeDisabled();
  fireEvent.load(frame);
  expect(screen.getByRole("button", { name: "Print" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Print" }));
  expect(print).toHaveBeenCalledTimes(1);
});
