import React from "react";
import { render } from "@testing-library/react";

let mockAuthValue: { user: { uid: string } | null; loading: boolean } = { user: null, loading: true };

jest.mock("@/hooks/useAuth", () => ({
  __esModule: true,
  useAuth: () => mockAuthValue,
}));

const mockIdentifyUser = jest.fn();
const mockResetAnalytics = jest.fn();

jest.mock("@/lib/analytics/analytics", () => ({
  __esModule: true,
  identifyUser: (...args: unknown[]) => mockIdentifyUser(...args),
  resetAnalytics: () => mockResetAnalytics(),
}));

import AnalyticsSession from "@/components/AnalyticsSession";

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthValue = { user: null, loading: true };
});

describe("AnalyticsSession", () => {
  it("waits for auth to resolve before identifying", () => {
    render(<AnalyticsSession />);
    expect(mockIdentifyUser).not.toHaveBeenCalled();
  });

  it("identifies the signed-in user once auth resolves", () => {
    const { rerender } = render(<AnalyticsSession />);
    mockAuthValue = { user: { uid: "uid-1" }, loading: false };
    rerender(<AnalyticsSession />);

    expect(mockIdentifyUser).toHaveBeenCalledWith("uid-1");
    expect(mockResetAnalytics).not.toHaveBeenCalled();
  });

  it("resets on sign out so the next person on the browser starts fresh", () => {
    mockAuthValue = { user: { uid: "uid-1" }, loading: false };
    const { rerender } = render(<AnalyticsSession />);
    expect(mockIdentifyUser).toHaveBeenCalledWith("uid-1");

    mockAuthValue = { user: null, loading: false };
    rerender(<AnalyticsSession />);

    expect(mockResetAnalytics).toHaveBeenCalledTimes(1);
  });

  it("resets before identifying a different user on the same browser", () => {
    mockAuthValue = { user: { uid: "uid-1" }, loading: false };
    const { rerender } = render(<AnalyticsSession />);

    mockAuthValue = { user: { uid: "uid-2" }, loading: false };
    rerender(<AnalyticsSession />);

    expect(mockResetAnalytics).toHaveBeenCalledTimes(1);
    expect(mockIdentifyUser).toHaveBeenLastCalledWith("uid-2");
    expect(mockResetAnalytics.mock.invocationCallOrder[0]).toBeLessThan(
      mockIdentifyUser.mock.invocationCallOrder[1],
    );
  });

  it("does not identify again when the same user re-renders", () => {
    mockAuthValue = { user: { uid: "uid-1" }, loading: false };
    const { rerender } = render(<AnalyticsSession />);
    mockAuthValue = { user: { uid: "uid-1" }, loading: false };
    rerender(<AnalyticsSession />);

    expect(mockIdentifyUser).toHaveBeenCalledTimes(1);
  });
});
