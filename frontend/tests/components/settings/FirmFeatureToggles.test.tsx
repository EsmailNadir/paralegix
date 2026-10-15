import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installApiMock, type ApiMock } from "../../support/apiMock";
import { DEFAULT_FIRM_FEATURES } from "@/types/preferences";
import type { FirmFeatures } from "@/types/preferences";

// The transport is faked, not the service, so the real `settings.service` runs:
// its url building, its body, and its ApiError parsing. A wrong path or a wrong
// payload shape is a defect this spec can see, which a service-level jest.mock
// would hide.
jest.unmock("@/services/settings.service");
jest.unmock("@/services/requestDeduplicator");

// setup.ts does not mock FirmSettingsContext, so this spec owns it. These are
// state, not transport, so faking them is the right level.
let mockFeatures: FirmFeatures = { ...DEFAULT_FIRM_FEATURES };
const mockRefresh = jest.fn();
jest.mock("@/contexts/FirmSettingsContext", () => ({
  __esModule: true,
  useFirmSettings: () => ({ features: mockFeatures, refresh: mockRefresh }),
}));

let mockPlan: Record<string, unknown> | undefined = { planId: "professional" };
jest.mock("@/contexts/LawFirmContext", () => ({
  __esModule: true,
  useLawFirm: () => ({ lawFirm: { id: "test-law-firm-id", plan: mockPlan } }),
}));

let mockHasPermission: (permission: string) => boolean = () => true;
jest.mock("@/contexts/PermissionsContext", () => ({
  __esModule: true,
  usePermissions: () => ({ hasPermission: (p: string) => mockHasPermission(p) }),
}));

import FirmFeatureToggles from "@/components/settingsComp/FirmFeatureToggles";

const TRUST_PATH = "/lawfirms/test-law-firm-id/settings/features/trustAccounting";
const trustSwitch = () => screen.getByRole("switch", { name: "Trust accounting" });

describe("FirmFeatureToggles", () => {
  let api: ApiMock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFeatures = { ...DEFAULT_FIRM_FEATURES };
    mockPlan = { planId: "professional" };
    mockHasPermission = () => true;
    api = installApiMock();
  });

  afterEach(() => {
    api.restore();
  });

  describe("which rows appear", () => {
    it("shows the trust row on a plan that includes trust accounting", () => {
      render(<FirmFeatureToggles />);
      expect(trustSwitch()).toBeInTheDocument();
    });

    it("renders nothing at all on a plan without it", () => {
      // A feature the plan does not sell is not the firm's to switch. The
      // pricing table above already offers the upgrade, so a disabled row here
      // would be a second, contradictory answer to the same question.
      mockPlan = { planId: "starter" };
      const { container } = render(<FirmFeatureToggles />);
      expect(container).toBeEmptyDOMElement();
    });

    it("shows the row for a starter firm an admin granted the feature", () => {
      mockPlan = { planId: "starter", featureOverrides: { trustAccounting: true } };
      render(<FirmFeatureToggles />);
      expect(trustSwitch()).toBeInTheDocument();
    });
  });

  describe("the switch position", () => {
    it("reads on when the firm has the feature", () => {
      render(<FirmFeatureToggles />);
      expect(trustSwitch()).toHaveAttribute("aria-checked", "true");
    });

    it("reads off when the firm has opted out", () => {
      // The row is still SHOWN (the plan includes it) but the switch is off.
      // This is the pairing that breaks if the component ever reads one source
      // for both decisions.
      mockFeatures = { ...DEFAULT_FIRM_FEATURES, trustAccounting: false };
      render(<FirmFeatureToggles />);
      expect(trustSwitch()).toHaveAttribute("aria-checked", "false");
    });
  });

  describe("turning it off", () => {
    it("asks first and sends nothing until the confirmation is accepted", async () => {
      const user = userEvent.setup();
      render(<FirmFeatureToggles />);

      await user.click(trustSwitch());

      expect(await screen.findByText(/turn off trust accounting\?/i)).toBeInTheDocument();
      // The click alone must not write. Switching off hides a whole area of the
      // product, so an accidental tap cannot be allowed to do it. No route is
      // registered in this case, so a request would also fail at the transport.
      expect(api.calls()).toHaveLength(0);
    });

    it("PUTs enabled:false to the feature route, then re-reads the settings", async () => {
      const user = userEvent.setup();
      api.put(TRUST_PATH, { message: "ok" });
      render(<FirmFeatureToggles />);

      await user.click(trustSwitch());
      await user.click(await screen.findByRole("button", { name: /turn it off/i }));

      await waitFor(() => expect(api.callsTo(TRUST_PATH)).toHaveLength(1));
      const [call] = api.callsTo(TRUST_PATH);
      // The firm-settings PUT silently drops `features`, so hitting the wrong
      // path here would look like success and change nothing on the server.
      expect(call.method).toBe("PUT");
      expect(call.body).toEqual({ enabled: false });

      // The resolved feature map lives on the server, so the component must not
      // guess the new value locally.
      await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    });

    it("sends nothing when the confirmation is dismissed", async () => {
      const user = userEvent.setup();
      render(<FirmFeatureToggles />);

      await user.click(trustSwitch());
      await screen.findByText(/turn off trust accounting\?/i);
      await user.click(screen.getByRole("button", { name: /cancel/i }));

      expect(api.calls()).toHaveLength(0);
    });
  });

  describe("turning it back on", () => {
    it("PUTs enabled:true with no confirmation", async () => {
      const user = userEvent.setup();
      mockFeatures = { ...DEFAULT_FIRM_FEATURES, trustAccounting: false };
      api.put(TRUST_PATH, { message: "ok" });
      render(<FirmFeatureToggles />);

      await user.click(trustSwitch());

      // Switching on is additive and restores what was already there, so it
      // does not warrant a dialog.
      await waitFor(() => expect(api.callsTo(TRUST_PATH)).toHaveLength(1));
      expect(api.callsTo(TRUST_PATH)[0].body).toEqual({ enabled: true });
      expect(screen.queryByText(/turn off trust accounting\?/i)).not.toBeInTheDocument();
    });
  });

  describe("when the server refuses", () => {
    const heldFunds = {
      status: 400,
      body: {
        error:
          "Trust accounting cannot be turned off while the firm holds client funds. "
          + "$4,126.00 is still on deposit across 2 client ledgers.",
      },
    };

    it("shows the held-funds message from the backend rather than a generic failure", async () => {
      const user = userEvent.setup();
      // The amount the backend names is the actionable part, so the component
      // must surface it rather than replacing it with its own wording.
      api.put(TRUST_PATH, heldFunds);
      render(<FirmFeatureToggles />);

      await user.click(trustSwitch());
      await user.click(await screen.findByRole("button", { name: /turn it off/i }));

      expect(await screen.findByText(/\$4,126\.00 is still on deposit/i)).toBeInTheDocument();
    });

    it("leaves the switch on, matching the server state", async () => {
      const user = userEvent.setup();
      api.put(TRUST_PATH, heldFunds);
      render(<FirmFeatureToggles />);

      await user.click(trustSwitch());
      await user.click(await screen.findByRole("button", { name: /turn it off/i }));

      await screen.findByText(/still on deposit/i);
      // Nothing changed server-side, so the switch must not show otherwise.
      expect(trustSwitch()).toHaveAttribute("aria-checked", "true");
      expect(mockRefresh).not.toHaveBeenCalled();
    });
  });

  describe("permissions", () => {
    it("disables the switch without settings.manageFirm", () => {
      mockHasPermission = (permission) => permission !== "settings.manageFirm";
      render(<FirmFeatureToggles />);

      // The row stays visible so a member can see how the firm is configured;
      // only the control is closed to them.
      expect(trustSwitch()).toBeDisabled();
    });
  });
});
