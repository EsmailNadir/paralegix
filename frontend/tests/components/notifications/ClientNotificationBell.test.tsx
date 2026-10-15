/**
 * What clicking a portal notification does.
 *
 * Rows written without an actionUrl used to mark themselves read and go
 * nowhere. The row now opens the page its entity lives on.
 */
import React from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useDialog } from "@/hooks/useDialog";

const mockNavigate = jest.fn();
const mockMarkRead = jest.fn();
let mockNotifications: Array<Record<string, unknown>> = [];

jest.mock("@/contexts/NavigationContext", () => ({
  __esModule: true,
  useNavigation: () => ({ navigate: mockNavigate }),
}));

jest.mock("@/hooks/notificationHooks/useClientNotifications", () => ({
  useClientNotifications: () => ({
    notifications: mockNotifications,
    unreadCount: mockNotifications.filter((n) => !n.read).length,
    markRead: mockMarkRead,
    markAllRead: jest.fn(),
    loadMore: jest.fn(),
    loadingMore: false,
    hasMore: false,
  }),
}));

import ClientNotificationBell from "@/components/notificationComp/ClientNotificationBell";

function row(overrides: Record<string, unknown>) {
  return {
    id: "n1",
    type: "document_request",
    title: "Documents requested",
    body: "Wage loss documentation is due in one week.",
    read: false,
    entityType: "matter",
    matterId: "matter-1",
    actionUrl: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function openBellAndClick(title: string) {
  render(<ClientNotificationBell lawFirmId="firm-a" />);
  await act(async () => {
    screen.getByRole("button", { name: "Notifications" }).click();
  });
  await act(async () => {
    screen.getByText(title).click();
  });
}

describe("ClientNotificationBell row click", () => {
  afterEach(() => {
    mockNotifications = [];
    jest.clearAllMocks();
  });

  it("marks the row read and opens its entity's page when the row has no actionUrl", async () => {
    mockNotifications = [row({})];

    await openBellAndClick("Documents requested");

    expect(mockMarkRead).toHaveBeenCalledWith("n1");
    expect(mockNavigate).toHaveBeenCalledWith("/client/lawfirm/firm-a/documents");
  });

  it("opens the path of an absolute actionUrl", async () => {
    mockNotifications = [row({
      title: "Signature requested",
      type: "signing_requested",
      entityType: null,
      actionUrl: "https://staging.paralegix.com/client/lawfirm/firm-a/documents?clientRecordId=r1",
    })];

    await openBellAndClick("Signature requested");

    expect(mockNavigate).toHaveBeenCalledWith("/client/lawfirm/firm-a/documents?clientRecordId=r1");
  });
});

/**
 * The portal's mobile drawer is a `useDialog` dialog, and the compact bell
 * renders inside the same page while it is open. Both listen for Escape on the
 * document, so one press used to close the bell and the drawer together.
 */
describe("Escape with the bell open inside an open dialog", () => {
  function Drawer({ onClose }: { onClose: () => void }) {
    const { dialogRef } = useDialog({ isOpen: true, onClose });
    return (
      <div ref={dialogRef} role="dialog" aria-label="Client navigation">
        <ClientNotificationBell lawFirmId="firm-a" />
      </div>
    );
  }

  afterEach(() => {
    mockNotifications = [];
    jest.clearAllMocks();
  });

  // Red if: the bell's Escape also reaches the dialog's handler, so the
  // drawer closes along with the bell.
  it("closes only the bell, and the next Escape closes the dialog", async () => {
    mockNotifications = [row({})];
    const closeDrawer = jest.fn();
    const user = userEvent.setup();
    render(<Drawer onClose={closeDrawer} />);

    const bell = screen.getByRole("button", { name: "Notifications" });
    await user.click(bell);
    expect(bell).toHaveAttribute("aria-expanded", "true");

    await user.keyboard("{Escape}");
    expect(bell).toHaveAttribute("aria-expanded", "false");
    expect(closeDrawer).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(closeDrawer).toHaveBeenCalledTimes(1);
  });
});
