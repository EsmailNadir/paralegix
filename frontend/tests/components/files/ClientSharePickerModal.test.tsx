import React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";

import ClientSharePickerModal from "@/components/filesComp/ClientSharePickerModal";

const CLIENTS = [
  { id: "c1", name: "Alice Smith" },
  { id: "c2", name: "Bob Jones" },
];

function renderPicker(onConfirm: jest.Mock) {
  return render(
    React.createElement(ClientSharePickerModal, {
      open: true,
      onClose: jest.fn(),
      clients: CLIENTS,
      initialSelectedIds: CLIENTS.map((c) => c.id),
      itemLabel: "report.pdf",
      onConfirm,
    }),
  );
}

/**
 * The notify choice is the half of this modal's answer that is easiest to drop:
 * a caller can accept `(clientIds)` alone and still typecheck, which is exactly
 * how the firm-wide Files browser ended up emailing clients after the user had
 * unchecked the box. These pin that both halves are reported.
 */
describe("ClientSharePickerModal", () => {
  it("reports the notify choice alongside the recipients", async () => {
    const onConfirm = jest.fn();
    const user = userEvent.setup();
    renderPicker(onConfirm);

    await user.click(screen.getByRole("button", { name: /^Share$/ }));

    expect(onConfirm).toHaveBeenCalledWith(["c1", "c2"], true);
  });

  it("reports notify=false once the box is unchecked", async () => {
    const onConfirm = jest.fn();
    const user = userEvent.setup();
    renderPicker(onConfirm);

    await user.click(screen.getByText(/Notify/).closest("label") as HTMLElement);
    await user.click(screen.getByRole("button", { name: /^Share$/ }));

    expect(onConfirm).toHaveBeenCalledWith(["c1", "c2"], false);
  });

  it("reports only the checked recipients", async () => {
    const onConfirm = jest.fn();
    const user = userEvent.setup();
    renderPicker(onConfirm);

    await user.click(screen.getByText("Bob Jones").closest("label") as HTMLElement);
    await user.click(screen.getByRole("button", { name: /^Share$/ }));

    expect(onConfirm).toHaveBeenCalledWith(["c1"], true);
  });
});
