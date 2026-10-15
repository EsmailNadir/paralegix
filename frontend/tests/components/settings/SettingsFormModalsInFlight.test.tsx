/**
 * The settings form dialogs (lead stage, matter stage, custom field) disable
 * Cancel while a save is in flight. A backdrop click is the same request as
 * Cancel, so it must be refused too: otherwise the dialog vanishes mid-save and
 * a rejected save has nowhere left to show its error.
 */
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import LeadStageFormModal from "@/components/settingsComp/LeadStageFormModal";
import MatterStageFormModal from "@/components/settingsComp/MatterStageFormModal";
import MatterFieldFormModal from "@/components/settingsComp/MatterFieldFormModal";

/** The overlay's backdrop: the sibling before the centring wrapper. */
function backdrop(): HTMLElement {
  const wrapper = screen.getByRole("dialog").parentElement as HTMLElement;
  return wrapper.previousElementSibling as HTMLElement;
}

function never(): Promise<unknown> {
  return new Promise(() => {});
}

describe("settings form dialogs while a save is in flight", () => {
  it("keeps the lead stage dialog open on a backdrop click mid-save", async () => {
    const onClose = jest.fn();
    render(
      <LeadStageFormModal
        open
        onClose={onClose}
        editing={null}
        practiceAreas={[]}
        onCreate={never}
        onUpdate={never}
      />,
    );
    fireEvent.change(screen.getByLabelText("Name *"), { target: { value: "Qualifying" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create stage" }));
    });

    fireEvent.click(backdrop());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the matter stage dialog open on a backdrop click mid-save", async () => {
    const onClose = jest.fn();
    render(
      <MatterStageFormModal
        open
        onClose={onClose}
        editing={null}
        pipelineId="pipe-1"
        onCreate={never}
        onUpdate={never}
      />,
    );
    fireEvent.change(screen.getByLabelText("Name *"), { target: { value: "Discovery" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create stage" }));
    });

    fireEvent.click(backdrop());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the custom field dialog open on a backdrop click mid-save", async () => {
    const onClose = jest.fn();
    render(
      <MatterFieldFormModal
        open
        onClose={onClose}
        editing={null}
        practiceAreas={[]}
        onCreate={never}
        onUpdate={never}
      />,
    );
    fireEvent.change(screen.getByLabelText("Label *"), { target: { value: "Opposing counsel" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create field" }));
    });

    fireEvent.click(backdrop());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("still closes the lead stage dialog on a backdrop click when idle", () => {
    const onClose = jest.fn();
    render(
      <LeadStageFormModal
        open
        onClose={onClose}
        editing={null}
        practiceAreas={[]}
        onCreate={never}
        onUpdate={never}
      />,
    );
    fireEvent.click(backdrop());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders a stacked matter stage dialog above a top-level dialog", () => {
    render(
      <MatterStageFormModal
        open
        stacked
        onClose={jest.fn()}
        editing={null}
        pipelineId="pipe-1"
        onCreate={never}
        onUpdate={never}
      />,
    );
    const overlay = screen.getByRole("dialog").parentElement?.parentElement as HTMLElement;
    expect(overlay).toHaveClass("z-[60]");
    expect(overlay.parentElement).toBe(document.body);
  });
});
