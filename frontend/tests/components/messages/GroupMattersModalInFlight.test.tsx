import React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@testing-library/react";

const matters = [
  { id: "m1", name: "Smith v. Jones", matterNumber: "2026-01", status: "active", clientNames: ["Alice Smith"], clientUserIds: ["u-alice"] },
  { id: "m2", name: "Estate of Doe", matterNumber: "2026-02", status: "active", clientNames: ["Bob Doe"], clientUserIds: ["u-bob"] },
];

const ALICE = { userId: "u-alice", name: "Alice Smith", email: "alice@example.com" };

// The modal reads the firm's matters via React Query. Serve them from a stub so
// the picker can resolve matter labels without a QueryClientProvider.
jest.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { items: matters }, isFetching: false }),
  useQueries: ({ combine }: { combine: (results: unknown[]) => unknown }) =>
    combine([{ data: { items: matters }, isFetching: false }]),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

const mockSetGroupMatters = jest.fn();
jest.mock("@/services/messages.service", () => ({
  __esModule: true,
  default: {
    setGroupMatters: (...args: any[]) => mockSetGroupMatters(...args),
  },
}));
const mockAddClient = jest.fn().mockResolvedValue({ message: "ok", clientId: "c1" });
// useQuery is stubbed to return the data directly, so getMatters is never
// invoked; a bare mock avoids referencing `matters` before its initialization.
jest.mock("@/services/matters.service", () => ({
  __esModule: true,
  default: {
    getMatters: jest.fn(),
    addClient: (...args: any[]) => mockAddClient(...args),
  },
}));

import GroupMattersModal from "@/components/messagesComp/GroupMattersModal";

const baseProps = {
  open: true,
  onClose: jest.fn(),
  lawFirmId: "law-firm-1",
  conversationId: "conv-1",
  matterIds: ["m1"],
  onChanged: jest.fn(),
};

/**
 * Cancel, Escape and the backdrop all refuse to close the scope picker while a
 * save is in flight. The header's close button is the same request and must be
 * refused too, or the dialog vanishes mid-save and a refused save has nowhere
 * to show its reason.
 */
it("keeps the picker open when its close button is pressed mid-save", async () => {
  mockSetGroupMatters.mockReturnValue(new Promise(() => {}));
  const onClose = jest.fn();
  const user = userEvent.setup();
  render(React.createElement(GroupMattersModal, { ...baseProps, onClose }));

  await user.click(screen.getByRole("button", { name: /link 2026-02: estate of doe/i }));
  await user.click(screen.getByRole("button", { name: /^done$/i }));
  await waitFor(() => expect(mockSetGroupMatters).toHaveBeenCalledTimes(1));

  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).not.toHaveBeenCalled();
});

it("closes from its close button when nothing is saving", async () => {
  const onClose = jest.fn();
  const user = userEvent.setup();
  render(React.createElement(GroupMattersModal, { ...baseProps, onClose }));

  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("opens the add-clients prompt above the picker", async () => {
  const user = userEvent.setup();
  render(React.createElement(GroupMattersModal, { ...baseProps, groupClients: [ALICE] }));

  await user.click(screen.getByRole("button", { name: /link 2026-02: estate of doe/i }));
  await user.click(screen.getByRole("button", { name: /^done$/i }));

  const prompt = await screen.findByRole("dialog", { name: /add these clients to the matter\?/i });
  const overlay = prompt.parentElement?.parentElement as HTMLElement;
  expect(overlay).toHaveClass("z-[60]");
  expect(overlay.parentElement).toBe(document.body);
});
