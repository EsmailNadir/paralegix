/**
 * A rejected save on the deadline set editor. The page used to catch the error
 * and write it to its own banner, which sits under the still-open dialog's
 * backdrop, so the dialog just stopped spinning and the reason was hidden.
 */
import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

const mockList = jest.fn();
const mockUpdate = jest.fn();
jest.mock("@/services/deadlineSets.service", () => ({
  __esModule: true,
  default: {
    list: (...args: unknown[]) => mockList(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    create: jest.fn(),
    remove: jest.fn(),
  },
}));

jest.mock("next/navigation", () => ({
  useParams: () => ({ lawFirmId: "firm-1" }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/lawfirm/firm-1/settings/deadline-sets",
  useSearchParams: () => new URLSearchParams(),
}));

import DeadlineSetsPage from "@/app/lawfirm/[lawFirmId]/settings/deadline-sets/page";

const SET = {
  id: "set-1",
  name: "Civil Complaint Filed",
  description: null,
  adjustForWeekends: false,
  items: [
    { title: "Answer due", type: "filing_deadline", offsetDays: 21, offsetDirection: "after", relativeTo: "trigger", clientVisible: false, notes: null },
  ],
};

beforeEach(() => {
  mockList.mockReset().mockResolvedValue({ deadlineSets: [SET] });
  mockUpdate.mockReset();
});

it("shows a refused save inside the open editor and keeps it open", async () => {
  mockUpdate.mockRejectedValue(new Error("A deadline set with that name already exists."));
  render(<DeadlineSetsPage />);

  fireEvent.click(await screen.findByRole("button", { name: /Edit/ }));
  const dialog = screen.getByRole("dialog");
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  });

  expect(mockUpdate).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("dialog")).toBe(dialog);
  expect(within(dialog).getByText("A deadline set with that name already exists.")).toBeInTheDocument();
});

it("closes the editor and reloads the list once the save succeeds", async () => {
  mockUpdate.mockResolvedValue({});
  render(<DeadlineSetsPage />);

  fireEvent.click(await screen.findByRole("button", { name: /Edit/ }));
  await act(async () => {
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save changes" }));
  });

  expect(mockUpdate).toHaveBeenCalledWith("firm-1", "set-1", expect.objectContaining({ name: "Civil Complaint Filed" }));
  expect(mockList).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("dialog")).toHaveClass("overlay-card-exit");
});
