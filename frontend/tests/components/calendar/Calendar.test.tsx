import React from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../../support/renderWithProviders";
import { mockPermissionsValue } from "../../setup";

let mockCalendarSyncLocked = false;

jest.mock("@/services/billing.service", () => ({
  __esModule: true,
  default: {
    getCalendarPaymentDates: jest.fn().mockResolvedValue([]),
  },
}));

// Calendar loads its windowed data through useCalendarWindowData, which fans out to
// the per-dataset hooks below; return concrete arrays so the grid renders without a
// live backend. useCalendarWindowData and usePaymentDates are intentionally left real
// so the billing-permission test still exercises the path that decides whether
// billingService.getCalendarPaymentDates is called at all.
jest.mock("@/hooks/calendarHooks/useMatterEvents", () => ({
  __esModule: true,
  default: () => ({ matterEvents: [], loading: false, fetching: false, error: null, refresh: jest.fn() }),
}));
jest.mock("@/hooks/calendarHooks/useStandaloneClientEvents", () => ({
  __esModule: true,
  default: () => ({ clientEvents: [], loading: false, fetching: false, error: null, refresh: jest.fn() }),
}));
jest.mock("@/hooks/calendarHooks/useExternalCalendarEvents", () => ({
  __esModule: true,
  default: jest.fn(() => ({ externalEvents: [], loading: false, fetching: false, error: null, refresh: jest.fn() })),
}));
jest.mock("@/hooks/calendarHooks/useCalendarWindowTasks", () => ({
  __esModule: true,
  default: () => ({ tasks: [], loading: false, fetching: false, error: null, refresh: jest.fn() }),
}));
jest.mock("@/hooks/calendarHooks/useNextUpTask", () => ({
  __esModule: true,
  default: () => ({ nextUpTask: null, loading: false }),
}));
jest.mock("@/hooks/calendarHooks/useUserSyncSettings", () => ({
  __esModule: true,
  default: jest.fn(() => ({ syncFlags: null })),
}));
jest.mock("@/contexts/FirmSettingsContext", () => ({
  useFirmSettings: () => ({ features: { calendarSync: true }, isLocked: () => mockCalendarSyncLocked }),
}));
jest.mock("@/services/googleCalendarSync.service", () => ({
  GoogleCalendarSync: {
    checkGoogleAuth: jest.fn().mockResolvedValue({ authenticated: false }),
    enableSilentSync: jest.fn().mockResolvedValue({ success: true }),
    disableSilentSync: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock("@/services/matterEvents.service", () => ({
  __esModule: true,
  default: {
    listAllEvents: jest.fn().mockResolvedValue({ events: [] }),
  },
}));
jest.mock("@/services/tasks.service", () => ({
  __esModule: true,
  default: {
    listLawFirmTasksPaged: jest.fn().mockResolvedValue({ tasks: [], totalTasks: 0 }),
    getTaskStatusCounts: jest.fn().mockResolvedValue({ counts: {}, total: 0 }),
  },
}));
jest.mock("@/services/clients.service", () => ({
  __esModule: true,
  default: {
    listAllClientEvents: jest.fn().mockResolvedValue({ events: [] }),
    listClients: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock("@/services/calendarEvents.service", () => ({
  __esModule: true,
  default: {
    listExternalEvents: jest.fn().mockResolvedValue({ events: [] }),
  },
}));
jest.mock("@/services/settings.service", () => ({
  __esModule: true,
  default: {
    getUserSettings: jest.fn().mockResolvedValue({ preferences: {} }),
    updateUserSettings: jest.fn().mockResolvedValue({}),
  },
}));
jest.mock("@/services/auth.service", () => ({
  __esModule: true,
  default: {
    checkMicrosoftTokenStatus: jest.fn().mockResolvedValue({}),
  },
}));
jest.mock("@/services/outlookCalendarSync.service", () => ({
  OutlookCalendarSync: {
    enableSilentSync: jest.fn().mockResolvedValue({ success: true }),
    disableSilentSync: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock("@/services/users.service", () => ({
  __esModule: true,
  default: {
    getUsersByLawFirm: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock("@/hooks/useAuth", () => ({
  __esModule: true,
  useAuth: () => ({
    user: { uid: "test-uid" },
  }),
}));

jest.mock("@/hooks/useUsers", () => ({
  __esModule: true,
  useLawFirmUsers: () => ({ users: [], loading: false }),
}));

import Calendar from "@/components/calendarComp/Calendar";
import billingService from "@/services/billing.service";
import useUserSyncSettings from "@/hooks/calendarHooks/useUserSyncSettings";
import settingsService from "@/services/settings.service";
import { GoogleCalendarSync } from "@/services/googleCalendarSync.service";
import useExternalCalendarEvents from "@/hooks/calendarHooks/useExternalCalendarEvents";

describe("Calendar", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    Object.defineProperty(process.env, "NODE_ENV", { value: originalNodeEnv, configurable: true });
    window.sessionStorage.clear();
    mockCalendarSyncLocked = false;
    mockPermissionsValue.loading = false;
    mockPermissionsValue.hasPermission = () => true;
    jest.clearAllMocks();
    (useUserSyncSettings as jest.Mock).mockReturnValue({ syncFlags: null });
    (useExternalCalendarEvents as jest.Mock).mockReturnValue({
      externalEvents: [], loading: false, fetching: false, error: null, refresh: jest.fn(),
    });
  });

  it("skips billing payment fetches when the user cannot view invoices", async () => {
    const getCalendarPaymentDates = billingService.getCalendarPaymentDates as jest.Mock;
    mockPermissionsValue.hasPermission = (permission: string) => permission !== "billing.viewInvoices";

    renderWithProviders(React.createElement(Calendar, null));

    await waitFor(() => expect(screen.getByText("Today")).toBeInTheDocument());
    expect(getCalendarPaymentDates).not.toHaveBeenCalled();
  });

  it("shows a synced Google event when visibility has never been configured", async () => {
    const day = new Date();
    day.setHours(16, 45, 0, 0);
    (useUserSyncSettings as jest.Mock).mockReturnValue({
      syncFlags: { loggedInWithGoogle: true, allowGoogleToParalegixSync: true },
    });
    (useExternalCalendarEvents as jest.Mock).mockReturnValue({
      externalEvents: [{
        id: "google-test-1", title: "Google sync test event", provider: "google",
        source: "external", start: day.toISOString(),
      }],
      loading: false, fetching: false, error: null, refresh: jest.fn(),
    });

    renderWithProviders(<Calendar />);

    expect((await screen.findAllByText("Google sync test event")).length).toBeGreaterThan(0);
  });

  // Goes red if Google events stop following the import direction: shown
  // while "Send Events to Google" is the only direction, or hidden by a
  // leftover display preference while import is on.
  it("shows Google events only while import from Google is on, whatever the old display setting", async () => {
    const day = new Date();
    day.setHours(10, 0, 0, 0);
    const externalEvents = [{
      id: "google-vis-2", title: "Imported Google event", provider: "google",
      source: "external", start: day.toISOString(),
    }];
    (useExternalCalendarEvents as jest.Mock).mockReturnValue({
      externalEvents, loading: false, fetching: false, error: null, refresh: jest.fn(),
    });

    (useUserSyncSettings as jest.Mock).mockReturnValue({
      syncFlags: { loggedInWithGoogle: true, allowParalegixToGoogleSync: true },
    });
    const sendOnly = renderWithProviders(<Calendar />);
    expect(await screen.findByText("Connected Calendars")).toBeInTheDocument();
    expect(screen.queryByText("Imported Google event")).not.toBeInTheDocument();
    sendOnly.unmount();

    (useUserSyncSettings as jest.Mock).mockReturnValue({
      syncFlags: { loggedInWithGoogle: true, allowGoogleToParalegixSync: true, showGoogleCalendarEvents: false },
    });
    renderWithProviders(<Calendar />);
    expect((await screen.findAllByText("Imported Google event")).length).toBeGreaterThan(0);
  });

  // Goes red if Outlook events stop following their own import direction, or
  // if one provider's direction starts deciding the other's events.
  it("shows Outlook events only while import from Outlook is on, leaving Google events alone", async () => {
    const day = new Date();
    day.setHours(10, 0, 0, 0);
    (useUserSyncSettings as jest.Mock).mockReturnValue({
      syncFlags: {
        loggedInWithGoogle: true, loggedInWithMicrosoft: true,
        allowGoogleToParalegixSync: true, allowParalegixToOutlookSync: true,
      },
    });
    (useExternalCalendarEvents as jest.Mock).mockReturnValue({
      externalEvents: [
        { id: "outlook-vis-1", title: "Outlook client call", provider: "outlook", source: "external", start: day.toISOString() },
        { id: "google-vis-1", title: "Google deposition prep", provider: "google", source: "external", start: day.toISOString() },
      ],
      loading: false, fetching: false, error: null, refresh: jest.fn(),
    });

    renderWithProviders(<Calendar />);
    expect((await screen.findAllByText("Google deposition prep")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Outlook client call")).not.toBeInTheDocument();
  });

  it("offers the sync directions in calendar settings with no separate display switch", async () => {
    (useUserSyncSettings as jest.Mock).mockReturnValue({
      syncFlags: { loggedInWithGoogle: true, loggedInWithMicrosoft: true },
    });
    (settingsService.updateUserSettings as jest.Mock).mockResolvedValue({});

    renderWithProviders(<Calendar />);
    await waitFor(() => expect(screen.getByText("Connected Calendars")).toBeInTheDocument());
    expect(screen.queryByText("Show on calendar")).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "Calendar settings" }));
    const dialog = screen.getByRole("dialog", { name: "Calendar settings" });
    expect(within(dialog).queryByText("Development connection preview")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("switch")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "More calendar settings" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Outlook Calendar Sync/ })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: /Google Calendar Sync/ }));
    fireEvent.click(screen.getByRole("option", { name: "Two-Way Sync" }));
    await waitFor(() => expect(settingsService.updateUserSettings).toHaveBeenCalledWith(
      { allowParalegixToGoogleSync: true, allowGoogleToParalegixSync: true }, "test-law-firm-id",
    ));
    await waitFor(() => expect(GoogleCalendarSync.enableSilentSync).toHaveBeenCalledWith("test-law-firm-id"));
    expect(within(dialog).getByRole("button", { name: /Google Calendar Sync Two-Way Sync/ })).toBeInTheDocument();
  });

  it("never marks Google connected from a live check-auth, and writes no connection flag", async () => {
    // The API derives the connection from the stored grant and refuses a
    // client-written flag, so a probe answering "authenticated" changes nothing here.
    (GoogleCalendarSync.checkGoogleAuth as jest.Mock).mockResolvedValue({ authenticated: true, state: "connected" });
    (useUserSyncSettings as jest.Mock).mockReturnValue({ syncFlags: { loggedInWithGoogle: false } });

    renderWithProviders(<Calendar />);
    fireEvent.click(await screen.findByRole("button", { name: "Calendar settings" }));
    const dialog = screen.getByRole("dialog", { name: "Calendar settings" });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(within(dialog).getByRole("button", { name: /Google Calendar Sync/ })).toBeDisabled();
    expect(settingsService.updateUserSettings).not.toHaveBeenCalled();
  });

  it("disables sync direction changes when the firm locks calendar sync", async () => {
    mockCalendarSyncLocked = true;
    mockPermissionsValue.hasPermission = () => false;
    (useUserSyncSettings as jest.Mock).mockReturnValue({ syncFlags: { loggedInWithGoogle: true } });

    renderWithProviders(<Calendar />);
    await waitFor(() => expect(screen.getByText("Connected Calendars")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Calendar settings" }));
    const dialog = screen.getByRole("dialog", { name: "Calendar settings" });
    expect(within(dialog).getByRole("button", { name: /Google Calendar Sync/ })).toBeDisabled();
    expect(within(dialog).getByText("Calendar sync is managed by your firm administrator.")).toBeInTheDocument();
    expect(settingsService.updateUserSettings).not.toHaveBeenCalled();
  });

  it("previews disconnected providers in development without saving or starting sync", async () => {
    Object.defineProperty(process.env, "NODE_ENV", { value: "development", configurable: true });
    (useUserSyncSettings as jest.Mock).mockReturnValue({ syncFlags: {} });

    const rendered = renderWithProviders(<Calendar />);
    fireEvent.click(await screen.findByRole("button", { name: "Calendar settings" }));
    const dialog = screen.getByRole("dialog", { name: "Calendar settings" });
    fireEvent.click(within(dialog).getByRole("switch", { name: "Simulate Google connection" }));
    fireEvent.click(within(dialog).getByRole("switch", { name: "Simulate Outlook connection" }));

    expect(screen.getAllByText("Simulated")).toHaveLength(2);
    fireEvent.click(within(dialog).getByRole("button", { name: /Google Calendar Sync/ }));
    fireEvent.click(screen.getByRole("option", { name: "Two-Way Sync" }));
    expect(within(dialog).getByRole("button", { name: /Google Calendar Sync Two-Way Sync/ })).toBeInTheDocument();
    expect(settingsService.updateUserSettings).not.toHaveBeenCalled();
    expect(GoogleCalendarSync.enableSilentSync).not.toHaveBeenCalled();

    rendered.unmount();
    renderWithProviders(<Calendar />);
    expect(await screen.findAllByText("Simulated")).toHaveLength(2);
    expect(settingsService.updateUserSettings).not.toHaveBeenCalled();
  });

  it("ignores a saved connection preview in production", async () => {
    Object.defineProperty(process.env, "NODE_ENV", { value: "production", configurable: true });
    window.sessionStorage.setItem("paralegix-calendar-preview-test-law-firm-id", JSON.stringify({
      loggedInWithGoogle: true,
      loggedInWithMicrosoft: true,
      allowGoogleToParalegixSync: true,
      allowOutlookToParalegixSync: true,
    }));
    (useUserSyncSettings as jest.Mock).mockReturnValue({ syncFlags: {} });

    renderWithProviders(<Calendar />);
    fireEvent.click(await screen.findByRole("button", { name: "Calendar settings" }));
    const dialog = screen.getByRole("dialog", { name: "Calendar settings" });
    expect(within(dialog).queryByText("Development connection preview")).not.toBeInTheDocument();
    expect(screen.queryByText("Simulated")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Google Calendar Sync/ })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: /Outlook Calendar Sync/ })).toBeDisabled();
    expect(settingsService.updateUserSettings).not.toHaveBeenCalled();
  });
});

// Where the day grid opens. One minute is one pixel of the grid, and "now" is
// shown with an hour above it, so 9:00 AM scrolls to (9 - 1) * 60 = 480.
describe("Calendar day grid scroll position", () => {
  const NOW = new Date(2026, 9, 5, 9, 0, 0);

  beforeEach(() => {
    // Only the clock is faked: timers, animation frames and microtasks stay
    // real so the calendar's queries and its scroll frame run as they would.
    jest.useFakeTimers({
      now: NOW,
      doNotFake: [
        "hrtime", "nextTick", "performance", "queueMicrotask", "requestAnimationFrame", "cancelAnimationFrame",
        "requestIdleCallback", "cancelIdleCallback", "setImmediate", "clearImmediate", "setInterval",
        "clearInterval", "setTimeout", "clearTimeout",
      ],
    });
    window.localStorage.setItem("paralegix-calendar-view", "day");
    (useUserSyncSettings as jest.Mock).mockReturnValue({
      syncFlags: { loggedInWithGoogle: true, allowGoogleToParalegixSync: true },
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    window.localStorage.clear();
    (useUserSyncSettings as jest.Mock).mockReturnValue({ syncFlags: null });
    (useExternalCalendarEvents as jest.Mock).mockReturnValue({
      externalEvents: [], loading: false, fetching: false, error: null, refresh: jest.fn(),
    });
  });

  function lateEventOn(day: number) {
    (useExternalCalendarEvents as jest.Mock).mockReturnValue({
      externalEvents: [{
        id: `late-${day}`, title: "Late call", provider: "google", source: "external",
        start: new Date(2026, 9, day, 23, 0, 0).toISOString(), end: new Date(2026, 9, day, 23, 30, 0).toISOString(),
      }],
      loading: false, fetching: false, error: null, refresh: jest.fn(),
    });
  }

  const timeGrid = (container: HTMLElement) =>
    container.querySelector<HTMLElement>(".overflow-y-scroll.styled-scrollbar")!;

  it("opens on the current time when today is shown, even with nothing scheduled near it", async () => {
    lateEventOn(5);
    const { container } = renderWithProviders(<Calendar />);
    expect((await screen.findAllByText("Late call")).length).toBeGreaterThan(0);
    await waitFor(() => expect(timeGrid(container).scrollTop).toBe(480));
  });

  it("opens on the earliest item, less an hour, when today is not shown", async () => {
    lateEventOn(6);
    const { container } = renderWithProviders(<Calendar />);
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    expect((await screen.findAllByText("Late call")).length).toBeGreaterThan(0);
    await waitFor(() => expect(timeGrid(container).scrollTop).toBe(23 * 60 - 60));
  });
});
