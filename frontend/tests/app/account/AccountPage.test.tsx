import React from "react";
import { render, screen } from "@testing-library/react";
import "../../setup";
import { ProfileContext } from "@/contexts/ProfileContext";
import type { User } from "@/types";

jest.mock("@/components/settingsComp/ProfilePhotoSection", () => ({
  __esModule: true,
  default: () => React.createElement("div", { "data-testid": "photo-section" }),
}));
jest.mock("@/components/settingsComp/ProfileNameSection", () => ({
  __esModule: true,
  default: () => React.createElement("div", { "data-testid": "name-section" }),
}));
jest.mock("@/components/settingsComp/AccountPrivacySection", () => ({
  __esModule: true,
  default: () => React.createElement("div", { "data-testid": "privacy-section" }),
}));

import AccountPage from "@/app/account/page";

const renderWithProfile = (profile: User | null) =>
  render(
    <ProfileContext value={{ profile }}>
      <AccountPage />
    </ProfileContext>,
  );

const clientProfile = {
  uid: "test-uid",
  email: "c@example.com",
  name: "Client User",
  userType: "client",
} as User;

const memberProfile = { ...clientProfile, userType: "firm_member" } as User;

describe("AccountPage", () => {
  it("renders all three account cards", () => {
    renderWithProfile(memberProfile);

    expect(screen.getByTestId("photo-section")).toBeInTheDocument();
    expect(screen.getByTestId("name-section")).toBeInTheDocument();
    expect(screen.getByTestId("privacy-section")).toBeInTheDocument();
  });

  it("sends a client back to the client portal", () => {
    renderWithProfile(clientProfile);

    expect(screen.getByRole("link", { name: /back/i })).toHaveAttribute(
      "href",
      "/client/dashboard",
    );
  });

  it("sends a firm member back to the firm picker", () => {
    renderWithProfile(memberProfile);

    expect(screen.getByRole("link", { name: /back/i })).toHaveAttribute("href", "/dashboard");
  });

  it("falls back to the firm picker when the profile never resolved", () => {
    renderWithProfile(null);

    expect(screen.getByRole("link", { name: /back/i })).toHaveAttribute("href", "/dashboard");
  });
});
