/**
 * The overlay editor's "Save layout" dialog.
 *
 * What has to break for these to go red:
 *  - the header's close button losing its accessible name, so a screen reader
 *    announces it as an unlabeled button;
 *  - the heading id going back to a fixed string, so a second instance labels
 *    itself with the first one's heading.
 */
import React from "react";
import { render, screen, within } from "@testing-library/react";
import TemplateSaveLayoutModal from "@/components/templatesComp/TemplateSaveLayoutModal";
import { scanAccessibility } from "../../support/accessibility";

const props = {
  open: true,
  onClose: jest.fn(),
  onConfirm: jest.fn(),
  initialName: "Engagement Letter",
  saving: false,
  fieldCount: 3,
  repeaterCount: 0,
};

it("gives the header close button an accessible name", async () => {
  const onClose = jest.fn();
  const { container } = render(<TemplateSaveLayoutModal {...props} onClose={onClose} />);

  const dialog = screen.getByRole("dialog", { name: "Save Layout" });
  within(dialog).getByRole("button", { name: "Close" }).click();

  expect(onClose).toHaveBeenCalledTimes(1);
  expect((await scanAccessibility(container)).violations).toEqual([]);
});

it("labels each open instance with its own heading", () => {
  render(
    <>
      <TemplateSaveLayoutModal {...props} />
      <TemplateSaveLayoutModal {...props} />
    </>
  );

  const dialogs = screen.getAllByRole("dialog", { name: "Save Layout" });
  expect(dialogs).toHaveLength(2);
  const labelIds = dialogs.map((dialog) => dialog.getAttribute("aria-labelledby"));
  expect(new Set(labelIds).size).toBe(2);
  dialogs.forEach((dialog, index) => {
    const heading = within(dialog).getByRole("heading", { name: "Save Layout" });
    expect(heading.id).toBe(labelIds[index]);
  });
});
