"use client";

import { DollarSign, Settings } from "lucide-react";
import SegmentedToggle from "@/components/ui/SegmentedToggle";
import BillingRatesView from "./BillingRatesView";
import BillingSettingsView from "./BillingSettingsView";
import type { ChargeCode } from "@/types/chargeCode";
import type { User } from "@/types";

export type SetupSubView = "rates" | "settings";

interface BillingSetupViewProps {
  lawFirmId: string;
  sub: SetupSubView;
  onSubChange: (sub: SetupSubView) => void;
  chargeCodes: ChargeCode[];
  users: User[];
  chargeCodesLoading: boolean;
  onRefreshChargeCodes: () => void;
}

export default function BillingSetupView({
  lawFirmId,
  sub,
  onSubChange,
  chargeCodes,
  users,
  chargeCodesLoading,
  onRefreshChargeCodes,
}: BillingSetupViewProps) {
  return (
    <div className="space-y-5">
      <SegmentedToggle
        size="md"
        ariaLabel="Rates and setup view"
        options={[
          { value: "rates", label: "Rates", icon: DollarSign },
          { value: "settings", label: "Settings", icon: Settings },
        ]}
        value={sub}
        onChange={onSubChange}
      />

      {sub === "settings" ? (
        <BillingSettingsView lawFirmId={lawFirmId} />
      ) : (
        <BillingRatesView
          lawFirmId={lawFirmId}
          chargeCodes={chargeCodes}
          users={users}
          isLoading={chargeCodesLoading}
          onRefresh={onRefreshChargeCodes}
        />
      )}
    </div>
  );
}
