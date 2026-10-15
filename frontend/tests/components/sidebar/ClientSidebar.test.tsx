import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";

// The client with no law firm at all (firm deleted, removed by the firm, or
// self-registered before being invited) is the regression this suite exists to
// catch: every nav item in ClientSidebar is built inside `if (lawFirmId)`
// blocks, so it must still be able to reach account-level settings (profile
// photo, GDPR export, account deletion) via the firm-independent footer link.

let mockProfile: { profile: { name: string | null; photoUrl: string | null } | null } = {
  profile: null,
};

let mockUnreadCount = 0;

jest.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: { uid: "test-uid", displayName: "Test User", email: "test@example.com" },
    loading: false,
  }),
}));

jest.mock("@/hooks/useUnreadCount", () => ({
  useUnreadCount: () => ({ unreadCount: mockUnreadCount }),
}));

jest.mock("@/components/ui/CountPill", () => ({
  __esModule: true,
  default: ({
    count,
    tone,
    max,
    className,
  }: {
    count: number;
    tone?: string;
    max?: number;
    className?: string;
  }) =>
    React.createElement("span", {
      "data-testid": "count-pill",
      className,
      "data-count": count,
      "data-tone": tone,
      "data-max": max,
    }),
}));

jest.mock("@/contexts/ProfileContext", () => ({
  useProfile: () => mockProfile,
}));

jest.mock("@/components/ui/ParalegixLogo", () => ({
  __esModule: true,
  default: () => React.createElement("div", { "data-testid": "logo" }, "Paralegix Logo"),
}));

jest.mock("@/components/notificationComp/ClientNotificationBell", () => ({
  __esModule: true,
  default: () => React.createElement("div", { "data-testid": "client-notification-bell" }),
}));

import ClientSidebar from "@/components/sidebar/ClientSidebar";

describe("ClientSidebar", () => {
  afterEach(() => {
    mockProfile = { profile: null };
    mockUnreadCount = 0;
  });

  it("keeps the /account footer link reachable and hides all firm-scoped nav when the client has no firm", () => {
    const { container } = render(React.createElement(ClientSidebar));

    // The regression: no lawFirmId means no nav item survives the `if
    // (lawFirmId)` gates, but the footer identity link must still be there.
    // The identity row is a menu trigger, not a direct link, so the /account
    // link only mounts once that menu is open.
    fireEvent.click(container.querySelector('[data-item-menu-trigger]')!);
    // The menu portals to document.body, outside `container`.
    expect(document.querySelectorAll('a[href="/account"]').length).toBeGreaterThan(0);

    expect(screen.queryByText("My Matters")).not.toBeInTheDocument();
    expect(screen.queryByText("Billing")).not.toBeInTheDocument();
    expect(screen.queryByText("Settings")).not.toBeInTheDocument();
  });

  it("shows firm-scoped nav plus the /account link when the client has a firm", () => {
    const { container } = render(React.createElement(ClientSidebar, { lawFirmId: "firm-1" }));

    fireEvent.click(container.querySelector('[data-item-menu-trigger]')!);
    // The menu portals to document.body, outside `container`.
    expect(document.querySelectorAll('a[href="/account"]').length).toBeGreaterThan(0);

    expect(screen.getAllByText("My Matters").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Settings").length).toBeGreaterThan(0);
  });

  it("renders the stored profile name in the footer, not the Firebase display name", () => {
    // The Firebase displayName mock above is "Test User"; the stored profile
    // name is what the firm actually sees on this client and can differ from
    // it, so it must win.
    mockProfile = { profile: { name: "Jordan Ruiz", photoUrl: null } };

    render(React.createElement(ClientSidebar));

    expect(screen.getAllByText("Jordan Ruiz").length).toBeGreaterThan(0);
    expect(screen.queryByText("Test User")).not.toBeInTheDocument();
  });

  it("positions unread messages with the shared accent count pill", () => {
    mockUnreadCount = 2;

    render(React.createElement(ClientSidebar));

    const pills = screen.getAllByTestId("count-pill");
    expect(pills.length).toBeGreaterThan(0);
    for (const pill of pills) {
      expect(pill).toHaveAttribute("data-count", "2");
      expect(pill).toHaveAttribute("data-tone", "accent");
      expect(pill).toHaveAttribute("data-max", "99");
      // The 22px pill is taller than the 13px label line. Negative vertical
      // margin keeps it from stretching the row when an unread count shows.
      expect(pill).toHaveClass("-my-1");
    }
  });
});
