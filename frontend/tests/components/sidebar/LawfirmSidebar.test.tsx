import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { DEFAULT_FIRM_FEATURES, type FirmFeatures } from "@/types/preferences";

const mockSidebar = {
  items: [
    { key: "dashboard", visible: true },
    { key: "matters", visible: true },
    { key: "tasks", visible: true },
  ],
};

// Typed against the real FirmFeatures so a test that swaps the whole object has
// to supply a valid feature set, rather than whatever shape the initial literal
// happened to infer.
const mockFirmSettings: { features: FirmFeatures; loading: boolean } = {
  features: { ...DEFAULT_FIRM_FEATURES },
  loading: false,
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

jest.mock("@/contexts/PreferencesContext", () => ({
  usePreferences: () => ({
    sidebar: mockSidebar,
  }),
}));

jest.mock("@/contexts/FirmSettingsContext", () => ({
  useFirmSettings: () => mockFirmSettings,
}));

jest.mock("@/components/ui/ParalegixLogo", () => ({
  __esModule: true,
  default: () => React.createElement("div", { "data-testid": "logo" }, "Paralegix Logo"),
}));

jest.mock("@/components/notificationComp/NotificationBell", () => ({
  __esModule: true,
  default: () => React.createElement("div", { "data-testid": "notification-bell" }),
}));

import LawFirmSidebarNav from "@/components/sidebar/LawfirmSidebar";

describe("LawFirmSidebarNav", () => {
  afterEach(() => {
    mockSidebar.items = [
      { key: "dashboard", visible: true },
      { key: "matters", visible: true },
      { key: "tasks", visible: true },
    ];
    mockFirmSettings.features = {
      ...DEFAULT_FIRM_FEATURES,
      messaging: true,
      calendarSync: true,
      fileSharing: true,
      trustAccounting: true,
    };
    mockFirmSettings.loading = false;
    mockUnreadCount = 0;
  });

  it("hides feature-gated items when their feature is disabled", () => {
    // "templates" and "trust" are feature-gated; "calendar" is not, so it stays visible.
    mockSidebar.items = [
      { key: "dashboard", visible: true },
      { key: "templates", visible: true },
      { key: "trust", visible: true },
    ];
    mockFirmSettings.features = {
      messaging: true,
      calendarSync: false,
      fileSharing: true,
      trustAccounting: false,
      analytics: false,
      templates: false,
      documentSigning: false,
      clientPortal: true,
      flatFees: true,
    };
    mockFirmSettings.loading = true;

    render(React.createElement(LawFirmSidebarNav));

    expect(screen.getAllByText("Dashboard").length).toBeGreaterThan(0);
    expect(screen.queryByText("Templates")).not.toBeInTheDocument();
    expect(screen.queryByText("Trust Accounting")).not.toBeInTheDocument();
  });

  it("links the footer identity block to the firm-independent /account route", () => {
    // Account settings (profile photo, GDPR export, account deletion) are
    // per-user, not per-firm, so the footer must keep linking there even
    // though every nav item above it is scoped to the current firm. The
    // identity row is a menu trigger now, not a direct link, so the /account
    // link only mounts once that menu is open.
    const { container } = render(React.createElement(LawFirmSidebarNav));
    fireEvent.click(container.querySelector('[data-item-menu-trigger]')!);
    // The menu portals to document.body, outside `container`.
    expect(document.querySelectorAll('a[href="/account"]').length).toBeGreaterThan(0);
  });

  it("positions unread messages with the shared accent count pill", () => {
    mockSidebar.items = [{ key: "messages", visible: true }];
    mockUnreadCount = 2;

    render(React.createElement(LawFirmSidebarNav));

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
