/**
 * `PlaceholderModal` while it animates closed.
 *
 * The template editors clear the repeater context (`repeaterPrefix`,
 * `newRepeater`) in the same handler that closes the picker. The dialog stays
 * on screen for its exit animation, so these read it while it carries the exit
 * class: the preview must keep its repeater prefix and the "Repeater name" input
 * must not vanish.
 */
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PlaceholderModal from "@/components/templatesComp/PlaceholderModal";

/** Mirrors the editors' picker state: closing clears the repeater context with it. */
function Harness({ repeaterPrefix, newRepeater }: { repeaterPrefix?: string; newRepeater?: boolean }) {
  const [picker, setPicker] = React.useState<{ repeaterPrefix?: string; newRepeater?: boolean } | null>({
    repeaterPrefix,
    newRepeater,
  });
  return (
    <PlaceholderModal
      open={!!picker}
      onClose={() => setPicker(null)}
      onInsert={() => {}}
      repeaterPrefix={picker?.repeaterPrefix ?? null}
      newRepeater={picker?.newRepeater ?? false}
    />
  );
}

describe("PlaceholderModal closing", () => {
  it("keeps an existing repeater's prefix in the preview while it animates out after Insert", async () => {
    render(<Harness repeaterPrefix="line_items" />);

    fireEvent.change(screen.getByPlaceholderText("e.g. client_name, date_signed"), {
      target: { value: "amount" },
    });
    expect(screen.getByText("{line_items.amount}")).toBeInTheDocument();

    const dialog = screen.getByRole("dialog", { name: "Insert Placeholder" });
    fireEvent.click(screen.getByRole("button", { name: "Insert Field" }));

    await waitFor(() => expect(dialog).toHaveClass("overlay-card-exit"));
    expect(screen.getByText("{line_items.amount}")).toBeInTheDocument();
  });

  it("keeps the Repeater name input and the prefixed preview while a new repeater's picker animates out", async () => {
    render(<Harness newRepeater />);

    fireEvent.change(screen.getByPlaceholderText("e.g. line_items"), { target: { value: "payments" } });
    fireEvent.change(screen.getByPlaceholderText("e.g. client_name, date_signed"), {
      target: { value: "date" },
    });
    expect(screen.getByText("{payments.date}")).toBeInTheDocument();

    const dialog = screen.getByRole("dialog", { name: "Insert Placeholder" });
    fireEvent.click(screen.getByRole("button", { name: "Insert Field" }));

    await waitFor(() => expect(dialog).toHaveClass("overlay-card-exit"));
    expect(screen.getByPlaceholderText("e.g. line_items")).toHaveValue("payments");
    expect(screen.getByText("{payments.date}")).toBeInTheDocument();
  });
});

describe("PlaceholderModal name limits", () => {
  it("holds the Field ID and Repeater name to the 120 characters the server accepts", () => {
    render(<Harness newRepeater />);

    expect(screen.getByPlaceholderText("e.g. client_name, date_signed")).toHaveAttribute("maxLength", "120");
    expect(screen.getByPlaceholderText("e.g. line_items")).toHaveAttribute("maxLength", "120");
  });
});
