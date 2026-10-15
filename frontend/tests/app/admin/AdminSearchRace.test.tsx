/**
 * Every paged admin list races its own search requests.
 *
 * Typing "sm", pausing past the debounce so it fires, then typing more to
 * "smith" starts a second search while the first is still in flight. A slower
 * response for "sm" landing after "smith"'s used to silently replace the newer
 * rows, with the search box still showing "smith". Each page carries its own
 * guard against that, so each is run separately.
 */
import React from "react";
import { act, fireEvent, screen } from "@testing-library/react";
import "../../setup";
import { renderWithProviders } from "../../support/renderWithProviders";

const mockPathname = jest.fn(() => "/admin");
// One instance for the whole run, as Next's `useRouter` returns from context.
// A fresh object per call changes the `router` dependency of each page's admin
// check on every render, so the check re-runs and the page drops back to its
// spinner until it resolves again.
const mockRouter = { push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() };
jest.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
  usePathname: () => mockPathname(),
  useSearchParams: () => new URLSearchParams(),
}));

const mockGetProfile = jest.fn();
jest.mock("@/services/users.service", () => ({
  __esModule: true,
  default: { getProfile: (...args: unknown[]) => mockGetProfile(...args) },
}));

const mockGetClientsPaged = jest.fn();
const mockGetLawFirmsPaged = jest.fn();
const mockGetAuditEvents = jest.fn();
const mockGetUsersPaged = jest.fn();
jest.mock("@/services/admin.service", () => ({
  __esModule: true,
  default: {
    getClientsPaged: (...args: unknown[]) => mockGetClientsPaged(...args),
    getLawFirmsPaged: (...args: unknown[]) => mockGetLawFirmsPaged(...args),
    getAuditEvents: (...args: unknown[]) => mockGetAuditEvents(...args),
    getUsersPaged: (...args: unknown[]) => mockGetUsersPaged(...args),
    lookupLawFirms: jest.fn().mockResolvedValue({ items: [], hasMore: false }),
    quotaBytesToMb: (bytes: number) => bytes / (1024 * 1024),
  },
}));

import AdminClientsPage from "@/app/admin/clients/page";
import AdminLawFirmsPage from "@/app/admin/lawfirms/page";
import AdminLoginsPage from "@/app/admin/logins/page";
import AdminUsersPage from "@/app/admin/users/page";
import { SEARCH_DEBOUNCE_MS } from "@/lib/constants/search";

const CLIENT_STATS = {
  total: 0,
  withPortal: 0,
  invitesPending: 0,
  new7d: 0,
  new30d: 0,
  personCount: 0,
  companyCount: 0,
  rosterContactTotal: 0,
  rosterPortalTotal: 0,
  peopleTotal: 0,
};
const LAW_FIRM_STATS = { total: 0, new7d: 0, new30d: 0, byPlan: {}, byBillingStatus: {} };
const USER_STATS = { total: 0, clients: 0, firmMembers: 0, pending: 0, admins: 0, new24h: 0, new7d: 0, new30d: 0 };

function makeClient(id: string, name: string): any {
  return {
    id,
    lawFirmId: "firm-1",
    lawFirmName: "Test Firm",
    clientType: "person",
    userId: null,
    name,
    email: "",
    phone: null,
    organization: null,
    status: "active",
    portalStatus: "none",
    portalEmail: null,
    portalAccountCreatedAt: null,
    rosterPortalCount: 0,
    invitationFailed: false,
    invitedAt: null,
    invitationSentAt: null,
    joinedAt: null,
    createdAt: null,
  };
}

function makeEvent(id: string, actorName: string): any {
  return { id, lawFirmId: null, lawFirmName: null, actorUid: id, actorEmail: null, actorName, action: "auth.login", createdAt: null };
}

/** One admin list: its page, the fetch it searches with, and the page of rows that fetch answers. */
const PAGES = [
  {
    name: "AdminClientsPage",
    Page: AdminClientsPage,
    pathname: "/admin/clients",
    placeholder: "Name, email, organization, or firm...",
    fetch: mockGetClientsPaged,
    page: (names: string[]) => ({
      clients: names.map((n, i) => makeClient(`c${i}-${n}`, n)), totalItems: names.length, stats: CLIENT_STATS,
    }),
  },
  {
    name: "AdminLawFirmsPage",
    Page: AdminLawFirmsPage,
    pathname: "/admin/lawfirms",
    placeholder: "Name, email, phone, or city...",
    fetch: mockGetLawFirmsPaged,
    page: (names: string[]) => ({
      lawFirms: names.map((n, i) => ({ id: `f${i}-${n}`, name: n })),
      totalItems: names.length,
      totalFirms: names.length,
      stats: LAW_FIRM_STATS,
    }),
  },
  {
    name: "AdminLoginsPage",
    Page: AdminLoginsPage,
    pathname: "/admin/logins",
    placeholder: "Filter by user, firm, IP, location...",
    fetch: mockGetAuditEvents,
    page: (names: string[]) => ({ items: names.map((n, i) => makeEvent(`e${i}-${n}`, n)), totalItems: names.length }),
  },
  {
    name: "AdminUsersPage",
    Page: AdminUsersPage,
    pathname: "/admin/users",
    placeholder: "Name, email, or UID...",
    fetch: mockGetUsersPaged,
    page: (names: string[]) => ({
      users: names.map((n, i) => ({ uid: `u${i}-${n}`, email: `u${i}@example.test`, name: n, userType: "firm_member" })),
      totalItems: names.length,
      stats: USER_STATS,
    }),
  },
];

beforeEach(() => {
  mockGetProfile.mockReset();
  mockGetProfile.mockResolvedValue({ isAdmin: true });
  for (const { fetch } of PAGES) fetch.mockReset();
  // The debounce and both responses run on the fake clock, so their order is
  // fixed by the test rather than by how busy the machine is.
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe.each(PAGES)("$name search race", ({ Page, pathname, placeholder, fetch, page }) => {
  it("keeps the newest search's rows, even when an earlier search's slower response arrives after it", async () => {
    mockPathname.mockReturnValue(pathname);
    let staleResponseDelivered = false;
    fetch.mockImplementation((query: { search?: string }) => {
      if (!query.search) return Promise.resolve(page([]));
      if (query.search === "sm") {
        return new Promise((resolve) => setTimeout(() => {
          staleResponseDelivered = true;
          resolve(page(["Smith Old"]));
        }, 500));
      }
      return new Promise((resolve) => setTimeout(() => resolve(page(["Smith New"])), 10));
    });

    renderWithProviders(React.createElement(Page));
    // Settle the admin check the page shows its spinner behind.
    await act(() => jest.advanceTimersByTimeAsync(0));

    fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value: "sm" } });
    await act(() => jest.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(fetch).toHaveBeenLastCalledWith(expect.objectContaining({ search: "sm" }));

    fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value: "smith" } });
    await act(() => jest.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(fetch).toHaveBeenLastCalledWith(expect.objectContaining({ search: "smith" }));

    await act(() => jest.advanceTimersByTimeAsync(10));
    expect(screen.getByText("Smith New")).toBeInTheDocument();
    expect(staleResponseDelivered).toBe(false);

    // Let the "sm" search's slower, now-stale response land after it.
    await act(() => jest.advanceTimersByTimeAsync(500));
    expect(staleResponseDelivered).toBe(true);

    expect(screen.getByText("Smith New")).toBeInTheDocument();
    expect(screen.queryByText("Smith Old")).not.toBeInTheDocument();
    // One admin check per mount. Re-running it swaps the page for its spinner,
    // so the search box is only on screen some of the time.
    expect(mockGetProfile).toHaveBeenCalledTimes(1);
  });
});
