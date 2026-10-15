"use client";

import { ReactNode } from "react";
import type { FirmFeatures } from "@/types/preferences";
import { useFirmSettings } from "@/contexts/FirmSettingsContext";
import FeatureDisabledPage from "@/components/ui/FeatureDisabledPage";

export default function RequireFeature({
  feature,
  fallback,
  children,
}: {
  feature: keyof FirmFeatures;
  fallback?: ReactNode;
  children: ReactNode;
}) {
  const { loading, features } = useFirmSettings();

  if (loading) return null;
  if (!features[feature]) {
    return fallback ? <>{fallback}</> : <FeatureDisabledPage feature={feature} />;
  }
  return <>{children}</>;
}

