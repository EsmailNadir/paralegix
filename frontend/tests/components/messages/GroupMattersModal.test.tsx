import React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@testing-library/react";

const matters = [
  { id: "m1", name: "Smith v. Jones", matterNumber: "2026-01", status: "active", clientNames: ["Alice Smith"], clientUserIds: ["u-alice"] },
  { id: "m2", name: "Estate of Doe", matterNumber: "2026-02", status: "active", clientNames: ["Bob Doe"], clientUserIds: ["u-bob"] },
  { id: "m3", name: "Doe Holdings", matterNumber: "2026-03", status: "on_hold", clientNames: ["Smith Family Trust"], clientUserIds: ["u-alice"] },
];

const ALICE = { userId: "u-alice", name: "Alice Smith", email: "alice@example.com" };
const CAROL = { userId: "u-carol", name: "Carol King", email: "carol@example.com" };
const DAN = { userId: "u-dan", name: "Dan Moss", email: "dan@example.com" };

// The modal reads the firm's matters via React Query. Serve them from a stub so
// the picker can resolve matter labels without a QueryClientProvider.
jest.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { items: matters }, isFetching: false }),
  useQueries: ({ combine }: { combine: (results: unknown[]) => unknown }) =>
    combine([{ data: { items: matters }, isFetching: false }]),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

const mockSetGroupMatters = jest.fn().mockResolvedValue({});
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

describe("GroupMattersModal", () => {
  beforeEach(() => {
    mockSetGroupMatters.mockClear();
    mockAddClient.mockClear();
    baseProps.onChanged.mockClear();
    baseProps.onClose.mockClear();
  });

  it("lists every matter with its clients and the selected count", () => {
    render(React.createElement(GroupMattersModal, { ...baseProps }));

    expect(screen.getByText(/1 matter selected/i)).toBeInTheDocument();
    expect(screen.getByText("2026-01: Smith v. Jones")).toBeInTheDocument();
    expect(screen.getByText("2026-02: Estate of Doe")).toBeInTheDocument();
    expect(screen.getByText("Alice Smith")).toBeInTheDocument();
  });

  it("filters by client name while keeping selected matters visible", async () => {
    const user = userEvent.setup();
    render(React.createElement(GroupMattersModal, { ...baseProps }));

    await user.type(screen.getByPlaceholderText(/search by matter/i), "Bob");

    expect(screen.getByText("2026-02: Estate of Doe")).toBeInTheDocument();
    expect(screen.getByText("2026-01: Smith v. Jones")).toBeInTheDocument();
  });

  it("does not save on row click; stages the change until Done", async () => {
    const user = userEvent.setup();
    render(React.createElement(GroupMattersModal, { ...baseProps }));

    await user.click(screen.getByRole("button", { name: /unlink 2026-01: smith v\. jones/i }));
    // Toggling a row alone must not persist anything.
    expect(mockSetGroupMatters).not.toHaveBeenCalled();
    // The staged count reflects the local change.
    expect(screen.getByText(/no matters selected/i)).toBeInTheDocument();
  });

  it("persists the staged selection and fires onChanged when Done is clicked", async () => {
    const user = userEvent.setup();
    render(React.createElement(GroupMattersModal, { ...baseProps }));

    await user.click(screen.getByRole("button", { name: /link 2026-02: estate of doe/i }));
    await user.click(screen.getByRole("button", { name: /^done$/i }));

    await waitFor(() => {
      expect(mockSetGroupMatters).toHaveBeenCalledWith("law-firm-1", "conv-1", ["m1", "m2"]);
      expect(baseProps.onChanged).toHaveBeenCalled();
      expect(baseProps.onClose).toHaveBeenCalled();
    });
  });

  it("closes without saving when nothing changed", async () => {
    const user = userEvent.setup();
    render(React.createElement(GroupMattersModal, { ...baseProps }));

    await user.click(screen.getByRole("button", { name: /^done$/i }));

    expect(mockSetGroupMatters).not.toHaveBeenCalled();
    expect(baseProps.onClose).toHaveBeenCalled();
  });

  it("flags matters missing a conversation client", () => {
    // The group's only client is Alice, so Bob's matter is missing her and warned;
    // Alice's matter is not.
    render(
      React.createElement(GroupMattersModal, { ...baseProps, groupClients: [ALICE] })
    );

    const warnings = screen.getAllByText(/missing client/i);
    expect(warnings).toHaveLength(1);
  });

  it("shows no warnings when the conversation has no clients", () => {
    render(
      React.createElement(GroupMattersModal, { ...baseProps, groupClients: [] })
    );

    expect(screen.queryByText(/missing client/i)).not.toBeInTheDocument();
  });

  it("prompts to add missing clients when linking a matter without them, and adds on confirm", async () => {
    const user = userEvent.setup();
    render(
      React.createElement(GroupMattersModal, { ...baseProps, matterIds: [], groupClients: [ALICE] })
    );

    // Link Bob's matter, which doesn't include Alice.
    await user.click(screen.getByRole("button", { name: /link 2026-02: estate of doe/i }));
    await user.click(screen.getByRole("button", { name: /^done$/i }));

    // The confirmation appears instead of saving immediately.
    expect(screen.getByText(/add these clients to the matter\?/i)).toBeInTheDocument();
    expect(mockSetGroupMatters).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /add to matter/i }));

    await waitFor(() => {
      expect(mockAddClient).toHaveBeenCalledWith(
        expect.objectContaining({ lawFirmId: "law-firm-1", matterId: "m2", client: expect.objectContaining({ userId: "u-alice" }) })
      );
      expect(mockSetGroupMatters).toHaveBeenCalledWith("law-firm-1", "conv-1", ["m2"]);
    });
  });

  it("links without adding clients when 'Link only' is chosen", async () => {
    const user = userEvent.setup();
    render(
      React.createElement(GroupMattersModal, { ...baseProps, matterIds: [], groupClients: [ALICE] })
    );

    await user.click(screen.getByRole("button", { name: /link 2026-02: estate of doe/i }));
    await user.click(screen.getByRole("button", { name: /^done$/i }));
    await user.click(screen.getByRole("button", { name: /don't add/i }));

    await waitFor(() => {
      expect(mockSetGroupMatters).toHaveBeenCalledWith("law-firm-1", "conv-1", ["m2"]);
    });
    expect(mockAddClient).not.toHaveBeenCalled();
  });

  // Saving closes the modal and used to drop the busy flag in the same update,
  // so the fading Done button came back enabled.
  it("keeps the Done button busy while it animates closed after saving", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = React.useState(true);
      return React.createElement(GroupMattersModal, { ...baseProps, open, onClose: () => setOpen(false) });
    }
    render(React.createElement(Harness));

    await user.click(screen.getByRole("button", { name: /link 2026-02: estate of doe/i }));
    await user.click(screen.getByRole("button", { name: /^done$/i }));

    await waitFor(() => expect(screen.getByRole("dialog")).toHaveClass("overlay-card-exit"));
    expect(screen.getByRole("button", { name: /^done$/i })).toBeDisabled();
  });

  it("shows a matter's status by its label, not the stored enum", () => {
    render(React.createElement(GroupMattersModal, { ...baseProps }));

    const row = screen.getByRole("button", { name: /link 2026-03: doe holdings/i });
    expect(row).toHaveTextContent("Paused");
    expect(row).not.toHaveTextContent(/on_hold/i);
  });

  it("retries only the clients that were not added when an add fails part way", async () => {
    const user = userEvent.setup();
    // Carol lands, Dan is refused once and then accepted on the retry.
    mockAddClient
      .mockResolvedValueOnce({ message: "ok", clientId: "c-carol" })
      .mockRejectedValueOnce(new Error("Dan could not be added"));
    render(
      React.createElement(GroupMattersModal, { ...baseProps, matterIds: [], groupClients: [CAROL, DAN] })
    );

    await user.click(screen.getByRole("button", { name: /link 2026-03: doe holdings/i }));
    await user.click(screen.getByRole("button", { name: /^done$/i }));
    await user.click(screen.getByRole("button", { name: /add to matter/i }));
    expect(await screen.findByText("Dan could not be added")).toBeInTheDocument();
    expect(mockAddClient).toHaveBeenCalledTimes(2);
    expect(mockSetGroupMatters).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /^done$/i }));
    await user.click(screen.getByRole("button", { name: /add to matter/i }));

    await waitFor(() => expect(mockSetGroupMatters).toHaveBeenCalledWith("law-firm-1", "conv-1", ["m3"]));
    // Carol is already on the matter after the first attempt; adding her again
    // re-runs the find-or-create and re-announces the roster change.
    const added = mockAddClient.mock.calls.map(([params]) => `${params.matterId}:${params.client.userId}`);
    expect(added).toEqual(["m3:u-carol", "m3:u-dan", "m3:u-dan"]);
  });
});
