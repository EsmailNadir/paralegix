"use client";

import { useEffect } from "react";
import { setAnalyticsContext, type AnalyticsUserType } from "@/lib/analytics/analytics";

// Tags analytics with the portal the user is in and the firm they are viewing.
// Mounted by the firm and client layouts, which are the ones that know both.
export default function useAnalyticsContext(userType: AnalyticsUserType, lawFirmId: string | null) {
  useEffect(() => {
    setAnalyticsContext(userType, lawFirmId);
  }, [userType, lawFirmId]);
}
