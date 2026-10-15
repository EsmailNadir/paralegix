import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/utils/apiErrors";

const mockExportMyData = jest.fn();
const mockEraseMyAccount = jest.fn();
const mockDownloadJson = jest.fn();
const mockSignOutUser = jest.fn();
const mockPush = jest.fn();

// setup.ts does not mock the privacy service, so this test owns it.
jest.mock("@/services/privacy.service", () => ({
  __esModule: true,
  default: {
    exportMyData: (...args: unknown[]) => mockExportMyData(...args),
    eraseMyAccount: (...args: unknown[]) => mockEraseMyAccount(...args),
  },
}));

// downloadJson calls URL.createObjectURL, which jsdom does not implement.
jest.mock("@/lib/utils/csv", () => ({
  __esModule: true,
  downloadJson: (...args: unknown[]) => mockDownloadJson(...args),
}));

jest.mock("@/services/auth.service", () => ({
  __esModule: true,
  default: { signOutUser: (...args: unknown[]) => mockSignOutUser(...args) },
}));

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
}));

import AccountPrivacySection from "@/components/settingsComp/AccountPrivacySection";
import { COOKIE_SETTINGS_EVENT } from "@/lib/analytics/consent";

describe("AccountPrivacySection", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("downloads the caller's data on export", async () => {
    mockExportMyData.mockResolvedValue({ user: { id: "test-uid" } });
    render(<AccountPrivacySection />);

    await userEvent.click(screen.getByRole("button", { name: /export my data/i }));

    await waitFor(() => expect(mockExportMyData).toHaveBeenCalledTimes(1));
    expect(mockDownloadJson).toHaveBeenCalledWith(
      "paralegix-my-data.json",
      { user: { id: "test-uid" } },
    );
  });

  it("signs the user out and sends them home after a successful erase", async () => {
    mockEraseMyAccount.mockResolvedValue({ message: "erased" });
    render(<AccountPrivacySection />);

    await userEvent.click(screen.getByRole("button", { name: /delete my account/i }));
    // The ConfirmModal's own confirm button carries the same label.
    const confirmButtons = await screen.findAllByRole("button", { name: /delete my account/i });
    await userEvent.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() => expect(mockSignOutUser).toHaveBeenCalledTimes(1));
    expect(mockPush).toHaveBeenCalledWith("/");
  });

  it("surfaces the backend message and stays signed in when a firm owner cannot self-erase", async () => {
    mockEraseMyAccount.mockRejectedValue(
      new ApiError("Transfer ownership or delete the firms you own before deleting your account.", {
        status: 403,
      }),
    );
    render(<AccountPrivacySection />);

    await userEvent.click(screen.getByRole("button", { name: /delete my account/i }));
    const confirmButtons = await screen.findAllByRole("button", { name: /delete my account/i });
    await userEvent.click(confirmButtons[confirmButtons.length - 1]);

    expect(
      await screen.findByText(/transfer ownership or delete the firms you own/i),
    ).toBeInTheDocument();
    expect(mockSignOutUser).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("does not erase the account when the confirmation modal is cancelled", async () => {
    render(<AccountPrivacySection />);

    await userEvent.click(screen.getByRole("button", { name: /delete my account/i }));
    await userEvent.click(await screen.findByRole("button", { name: /cancel/i }));

    expect(mockEraseMyAccount).not.toHaveBeenCalled();
    expect(mockSignOutUser).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("surfaces an error message when the export fails", async () => {
    mockExportMyData.mockRejectedValue(new Error("Could not reach the server"));
    render(<AccountPrivacySection />);

    await userEvent.click(screen.getByRole("button", { name: /export my data/i }));

    expect(await screen.findByText(/could not reach the server/i)).toBeInTheDocument();
    expect(mockDownloadJson).not.toHaveBeenCalled();
  });

  it("shows the generic failure message and stays signed in on a non-403 delete error", async () => {
    // A non-Error rejection (e.g. an unexpected thrown value) falls outside
    // both the ApiError/403 branch and the `e instanceof Error` branch, so it
    // exercises the generic fallback message.
    mockEraseMyAccount.mockRejectedValue("network exploded");
    render(<AccountPrivacySection />);

    await userEvent.click(screen.getByRole("button", { name: /delete my account/i }));
    const confirmButtons = await screen.findAllByRole("button", { name: /delete my account/i });
    await userEvent.click(confirmButtons[confirmButtons.length - 1]);

    expect(await screen.findByText(/failed to delete your account/i)).toBeInTheDocument();
    // A failure from eraseMyAccount itself leaves the account intact, so it must
    // never sign the user out or navigate away — only a successful erase does.
    expect(mockSignOutUser).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  // Withdrawing analytics consent has to be as reachable as giving it, and a
  // signed-in user never sees the marketing footer.
  it("reopens the analytics choice from inside the account", async () => {
    const opened = jest.fn();
    window.addEventListener(COOKIE_SETTINGS_EVENT, opened);
    render(<AccountPrivacySection />);

    await userEvent.click(screen.getByRole("button", { name: "Cookie settings" }));

    expect(opened).toHaveBeenCalledTimes(1);
    window.removeEventListener(COOKIE_SETTINGS_EVENT, opened);
  });
});
