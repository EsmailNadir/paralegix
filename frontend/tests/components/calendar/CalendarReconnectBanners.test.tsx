/**
 * `GoogleCalendarReconnectBanner` and `OutlookCalendarReconnectBanner`: the
 * one thing standing between a silently-broken calendar sync and the firm
 * finding out. Background sync hits a 401, dispatches a global
 * `CustomEvent`, and this is the only surface that ever tells anyone -
 * nothing else in the app shows a "calendar disconnected" state.
 *
 * Both components are byte-for-byte the same shape with a different event
 * name, so one parameterised suite runs the same case list against both
 * rather than duplicating it.
 */
const mockNavigate = jest.fn();

jest.mock("@/contexts/NavigationContext", () => ({
  __esModule: true,
  useNavigation: () => ({ navigate: mockNavigate, isNavigating: false }),
}));

// The default global mock (tests/setup.ts) does not export
// OUTLOOK_CALENDAR_RECONNECT_EVENT at all, so the banner would listen on
// `addEventListener(undefined, ...)` under it. Unmock both sync services to
// get their real exported event-name constants, matching production.
jest.unmock("@/services/googleCalendarSync.service");
jest.unmock("@/services/outlookCalendarSync.service");

const useParamsMock = jest.fn();
jest.mock("next/navigation", () => ({
  __esModule: true,
  useParams: () => useParamsMock(),
}));

import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import GoogleCalendarReconnectBanner from "@/components/GoogleCalendarReconnectBanner";
import OutlookCalendarReconnectBanner from "@/components/OutlookCalendarReconnectBanner";
import { GOOGLE_CALENDAR_RECONNECT_EVENT } from "@/services/googleCalendarSync.service";
import { OUTLOOK_CALENDAR_RECONNECT_EVENT } from "@/services/outlookCalendarSync.service";

const PROVIDERS = [
  { name: "Google", Banner: GoogleCalendarReconnectBanner, eventName: GOOGLE_CALENDAR_RECONNECT_EVENT },
  { name: "Outlook", Banner: OutlookCalendarReconnectBanner, eventName: OUTLOOK_CALENDAR_RECONNECT_EVENT },
];

function dispatchReconnect(eventName: string, message: string | undefined) {
  act(() => {
    window.dispatchEvent(new CustomEvent(eventName, { detail: { message } }));
  });
}

beforeEach(() => {
  mockNavigate.mockReset();
  useParamsMock.mockReturnValue({ lawFirmId: "firm-1" });
});

describe.each(PROVIDERS)("$name calendar reconnect banner", ({ Banner, eventName }) => {
  it("renders nothing until the reconnect event fires", () => {
    render(<Banner />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the message carried by the reconnect event", () => {
    render(<Banner />);

    dispatchReconnect(eventName, "Your calendar connection needs attention.");

    expect(screen.getByRole("alert")).toHaveTextContent("Your calendar connection needs attention.");
  });

  it("dismisses without navigating when Dismiss is clicked", () => {
    render(<Banner />);
    dispatchReconnect(eventName, "Reconnect needed.");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("navigates to firm settings and dismisses when Open Settings is clicked", () => {
    render(<Banner />);
    dispatchReconnect(eventName, "Reconnect needed.");

    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));

    expect(mockNavigate).toHaveBeenCalledWith("/lawfirm/firm-1/settings/general");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("dismisses without navigating when there is no firm in the url", () => {
    useParamsMock.mockReturnValue({});
    render(<Banner />);
    dispatchReconnect(eventName, "Reconnect needed.");

    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("replaces the message on a second reconnect event rather than stacking banners", () => {
    render(<Banner />);
    dispatchReconnect(eventName, "First failure.");
    dispatchReconnect(eventName, "Second failure.");

    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent("Second failure.");
  });

  it("removes its listener on unmount", () => {
    // A "does it still respond after unmount" check is not reliable here:
    // React 18+ does not warn on a state update from an unmounted component,
    // so a missing cleanup would not throw and would not fail that assertion
    // either way. Assert the actual cleanup call instead.
    const removeSpy = jest.spyOn(window, "removeEventListener");
    const { unmount } = render(<Banner />);

    unmount();

    expect(removeSpy).toHaveBeenCalledWith(eventName, expect.any(Function));
    removeSpy.mockRestore();
  });
});
