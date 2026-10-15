/**
 * Opening a notification must not wait on the mark-read request.
 *
 * Both firm surfaces used to `await markRead(...)` before navigating, so every
 * click on an unread row paused for a full round trip to the backend before the
 * route changed. The read state is already applied optimistically, so the
 * request has nothing the navigation needs.
 */
import React from "react";
import { act, render, screen } from "@testing-library/react";
import type { Notification } from "@/services/notifications.service";

const mockNavigate = jest.fn();
const mockMarkRead = jest.fn();
let mockRows: Notification[] = [];

jest.mock("@/contexts/NavigationContext", () => ({
  __esModule: true,
  useNavigation: () => ({ navigate: mockNavigate }),
}));

jest.mock("@/hooks/notificationHooks/useNotifications", () => ({
  __esModule: true,
  useNotifications: () => ({
    notifications: mockRows,
    total: mockRows.length,
    loading: false,
    error: null,
    refetch: jest.fn(),
  }),
  useUnreadCount: () => ({ unreadCount: 0, loading: false, refetch: jest.fn() }),
  useNotificationActions: () => ({
    markRead: mockMarkRead,
    markUnread: jest.fn(),
    markAllRead: jest.fn(),
    remove: jest.fn(),
  }),
}));

jest.mock("@/hooks/notificationHooks/useNotificationsRealtime", () => ({
  __esModule: true,
  useNotificationsRealtime: () => undefined,
}));

jest.mock("@/services/notifications.service", () => ({
  __esModule: true,
  default: {
    list: jest.fn(() =>
      Promise.resolve({
        notifications: mockRows,
        total: mockRows.length,
        nextBefore: null,
        nextBeforeId: null,
      }),
    ),
  },
}));

import NotificationDropdown from "@/components/notificationComp/NotificationDropdown";
import NotificationsView from "@/components/notificationComp/NotificationsView";

function unreadTaskRow(): Notification {
  return {
    id: "n1",
    type: "task_assigned",
    title: "Task assigned",
    body: "Draft the discovery responses.",
    read: false,
    entityType: "task",
    entityId: "task-1",
    matterId: null,
    lawFirmId: "firm-a",
    actionUrl: null,
    createdAt: new Date().toISOString(),
    createdBy: null,
  };
}

const TASK_HREF = "/lawfirm/firm-a/tasks/task-1";

/** A request that never settles, standing in for one still in flight. */
function pendingRequest() {
  return new Promise<void>(() => {});
}

async function clickRow(title: string) {
  await act(async () => {
    screen.getByText(title).click();
  });
}

describe("opening a notification navigates before the request settles", () => {
  beforeEach(() => {
    mockRows = [unreadTaskRow()];
  });

  afterEach(() => {
    mockRows = [];
    jest.clearAllMocks();
  });

  it("navigates from the bell dropdown while mark-read is still in flight", async () => {
    mockMarkRead.mockImplementation(pendingRequest);

    render(<NotificationDropdown lawFirmId="firm-a" onClose={jest.fn()} />);
    await clickRow("Task assigned");

    expect(mockMarkRead).toHaveBeenCalledWith("n1");
    expect(mockNavigate).toHaveBeenCalledWith(TASK_HREF);
  });

  it("navigates from the notifications page while mark-read is still in flight", async () => {
    mockMarkRead.mockImplementation(pendingRequest);

    await act(async () => {
      render(<NotificationsView lawFirmId="firm-a" />);
    });
    await clickRow("Task assigned");

    expect(mockMarkRead).toHaveBeenCalledWith("n1");
    expect(mockNavigate).toHaveBeenCalledWith(TASK_HREF);
  });

  it("still navigates from the bell dropdown when mark-read fails", async () => {
    mockMarkRead.mockRejectedValue(new Error("network down"));

    render(<NotificationDropdown lawFirmId="firm-a" onClose={jest.fn()} />);
    await clickRow("Task assigned");

    expect(mockNavigate).toHaveBeenCalledWith(TASK_HREF);
  });

  it("still navigates from the notifications page when mark-read fails", async () => {
    mockMarkRead.mockRejectedValue(new Error("network down"));

    await act(async () => {
      render(<NotificationsView lawFirmId="firm-a" />);
    });
    await clickRow("Task assigned");

    expect(mockNavigate).toHaveBeenCalledWith(TASK_HREF);
  });
});
