import React from "react";
import { render, screen, waitFor } from "@testing-library/react";

const mockList = jest.fn();
jest.mock("@/services/deadlineSets.service", () => ({
  __esModule: true,
  default: { list: (...args: unknown[]) => mockList(...args) },
}));

import ApplyDeadlineSetModal from "@/components/matterComp/ApplyDeadlineSetModal";

it("waits for deadline sets before showing the empty state", async () => {
  let release: ((value: unknown) => void) | undefined;
  mockList.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));

  render(<ApplyDeadlineSetModal
    open
    lawFirmId="firm-1"
    matterId="matter-1"
    onClose={jest.fn()}
    onApplied={jest.fn()}
  />);

  expect(screen.getByRole("status", { name: "Loading deadline sets" })).toBeInTheDocument();
  expect(screen.queryByText("No deadline sets yet")).not.toBeInTheDocument();
  await waitFor(() => expect(release).toBeDefined());
  release?.({ deadlineSets: [] });
  expect(await screen.findByText("No deadline sets yet")).toBeInTheDocument();
});
