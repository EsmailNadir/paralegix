/**
 * Where the notification panel opens relative to its bell.
 *
 * The bell renders in two slots: the desktop sidebar footer, at the left of the
 * screen, and the mobile top bar, at the right. The panel only ever grew
 * rightward from the bell's left edge, which fits the sidebar and runs off the
 * screen from the top bar. The clamp that caught it then parked the panel
 * against the left margin, floating under the hamburger with its right edge
 * nowhere near the bell that opened it.
 */
import React from "react";
import { act, render, screen } from "@testing-library/react";

jest.mock("@/hooks/notificationHooks/useNotifications", () => ({
  useUnreadCount: () => ({ unreadCount: 0 }),
  useNotifications: () => ({ notifications: [], loading: false }),
  useNotificationActions: () => ({
    markRead: jest.fn(),
    markUnread: jest.fn(),
    markAllRead: jest.fn(),
    remove: jest.fn(),
  }),
}));

jest.mock("@/hooks/notificationHooks/useNotificationsRealtime", () => ({
  useNotificationsRealtime: () => undefined,
}));

import NotificationBell from "@/components/notificationComp/NotificationBell";

const MARGIN = 8;

/**
 * Open the bell with the trigger at a known place on a known viewport, and
 * report where the panel landed. jsdom measures nothing, so the button's rect is
 * supplied rather than rendered.
 */
async function openAt(rect: { left: number; right: number }, viewportWidth: number) {
  window.innerWidth = viewportWidth;
  window.innerHeight = 800;

  render(<NotificationBell lawFirmId="firm-a" />);
  const button = screen.getByRole("button", { name: "Notifications" });
  jest.spyOn(button, "getBoundingClientRect").mockReturnValue({
    left: rect.left,
    right: rect.right,
    top: 20,
    bottom: 52,
    width: rect.right - rect.left,
    height: 32,
    x: rect.left,
    y: 20,
    toJSON: () => ({}),
  } as DOMRect);

  await act(async () => {
    button.click();
  });

  const panel = document.querySelector('[style*="position: fixed"]') as HTMLElement;
  // The width the panel actually renders at, not a recomputation of it: the
  // placement math once assumed 384px while phones rendered 320px, and a test
  // that recomputed the width shared the same wrong assumption.
  const left = parseFloat(panel.style.left);
  const width = parseFloat(panel.style.width);
  return { left, width, right: left + width };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("notification panel placement", () => {
  it("hangs under the bell's right edge when the bell is at the right", async () => {
    // The mobile top bar: the bell sits at the right margin, with room to its
    // left for the panel. It used to be clamped to the viewport's right edge
    // instead, which left it beside the bell rather than under it.
    const placed = await openAt({ left: 540, right: 580 }, 600);

    expect(placed.right).toBe(580);
    expect(placed.left).toBeGreaterThanOrEqual(MARGIN);
  });

  it("grows rightward from the bell in the desktop sidebar", async () => {
    // The sidebar footer: the bell is at the left, with the whole window to its
    // right, so the panel keeps its original placement.
    const placed = await openAt({ left: 24, right: 64 }, 1440);

    expect(placed.left).toBe(24);
  });

  it("hangs under the bell on a phone-width screen", async () => {
    // Below the sm breakpoint the panel is 320px. Placing it as if it were
    // 374px (the sm width clamped to the screen) decided it could not fit under
    // the bell and pinned it to the left margin, under the hamburger.
    const placed = await openAt({ left: 318, right: 358 }, 390);

    expect(placed.width).toBe(320);
    expect(placed.right).toBe(358);
    expect(placed.left).toBe(38);
  });

  it("keeps the panel on screen when neither edge of the bell fits it", async () => {
    // A screen narrow enough that the panel is wider than the room to either
    // side of the bell. Neither edge can be honoured, so staying on screen wins.
    const viewport = 300;
    const placed = await openAt({ left: 250, right: 290 }, viewport);

    expect(placed.left).toBeGreaterThanOrEqual(MARGIN);
    expect(placed.right).toBeLessThanOrEqual(viewport - MARGIN);
  });
});
