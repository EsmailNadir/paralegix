/**
 * `useGetStartedProgress`: the shared completion state behind the "get
 * started" checklist (Stripe, team, calendar, logo).
 *
 * The rule worth pinning: the calendar step must be excluded from the
 * denominator entirely when the firm's plan has no calendar sync feature -
 * counting it anyway would either strand a firm at "3 of 4" forever, or mark
 * it "complete" while a real, available step is still unchecked.
 */
let mockCalendarSyncFeature = true;
let mockLogoUrl: string | null = null;

jest.mock("@/contexts/LawFirmContext", () => ({
  __esModule: true,
  useLawFirm: () => ({ lawFirm: { id: "firm-1", logoUrl: mockLogoUrl }, refetchLawFirm: jest.fn() }),
}));

jest.mock("@/contexts/FirmSettingsContext", () => ({
  __esModule: true,
  useFirmSettings: () => ({ features: { calendarSync: mockCalendarSyncFeature } }),
}));

const mockApiFetch = jest.fn();
jest.mock("@/lib/utils/fetchWithTokenRefresh", () => ({
  __esModule: true,
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));
jest.mock("@/lib/utils/auth", () => ({
  __esModule: true,
  getFirebaseToken: jest.fn().mockResolvedValue("token"),
}));

const mockGetLawFirmMembers = jest.fn();
jest.mock("@/services/lawfirm.service", () => ({
  __esModule: true,
  default: { getLawFirmMembers: (...args: unknown[]) => mockGetLawFirmMembers(...args) },
}));

const mockCheckGoogleAuth = jest.fn();
const mockCheckOutlookAuth = jest.fn();
jest.mock("@/services/googleCalendarSync.service", () => ({
  __esModule: true,
  GoogleCalendarSync: { checkGoogleAuth: (...args: unknown[]) => mockCheckGoogleAuth(...args) },
}));
jest.mock("@/services/outlookCalendarSync.service", () => ({
  __esModule: true,
  OutlookCalendarSync: { checkOutlookAuth: (...args: unknown[]) => mockCheckOutlookAuth(...args) },
}));

import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { useGetStartedProgress } from "@/hooks/useGetStartedProgress";
import { makeTestQueryClient } from "../support/renderWithProviders";

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(QueryClientProvider, { client: makeTestQueryClient() }, children);
}

beforeEach(() => {
  mockCalendarSyncFeature = true;
  mockLogoUrl = null;
  mockApiFetch.mockReset().mockResolvedValue({
    ok: true,
    json: async () => ({ connected: true, chargesEnabled: true }),
  });
  mockGetLawFirmMembers.mockReset().mockResolvedValue([{ uid: "a" }, { uid: "b" }]);
  mockCheckGoogleAuth.mockReset().mockResolvedValue({ authenticated: false });
  mockCheckOutlookAuth.mockReset().mockResolvedValue({ authenticated: false });
});

describe("the calendar step's inclusion in the count", () => {
  it("excludes calendar from both doneCount and totalCount when the firm has no calendar-sync feature", async () => {
    mockCalendarSyncFeature = false;
    const { result } = renderHook(() => useGetStartedProgress("firm-1"), { wrapper });

    await waitFor(() => expect(result.current.stripeConnected).toBe(true));
    await waitFor(() => expect(result.current.teamInvited).toBe(true));

    // stripe + team + logo = 3 possible steps, none of them calendar.
    expect(result.current.totalCount).toBe(3);
    expect(result.current.doneCount).toBe(2); // logo still missing
    expect(result.current.complete).toBe(false);
  });

  it("includes calendar in the count once the feature is on, and only counts complete once it connects too", async () => {
    mockCalendarSyncFeature = true;
    mockCheckGoogleAuth.mockResolvedValue({ authenticated: true });
    mockLogoUrl = "https://example.test/logo.png";

    const { result } = renderHook(() => useGetStartedProgress("firm-1"), { wrapper });

    await waitFor(() => expect(result.current.calendarConnected).toBe(true));
    await waitFor(() => expect(result.current.stripeConnected).toBe(true));
    await waitFor(() => expect(result.current.teamInvited).toBe(true));

    expect(result.current.totalCount).toBe(4);
    expect(result.current.doneCount).toBe(4);
    expect(result.current.complete).toBe(true);
  });
});

describe("the team-invited signal", () => {
  it("is false for a firm with only its own owner on the roster", async () => {
    mockGetLawFirmMembers.mockResolvedValue([{ uid: "owner-only" }]);
    const { result } = renderHook(() => useGetStartedProgress("firm-1"), { wrapper });

    await waitFor(() => expect(result.current.teamInvited).toBe(false));
  });
});
