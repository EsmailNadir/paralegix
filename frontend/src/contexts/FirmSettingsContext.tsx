"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import settingsService from "@/services/settings.service";
import type { FirmFeatures, FirmSettings } from "@/types/preferences";
import { DEFAULT_FIRM_FEATURES, DEFAULT_FIRM_SETTINGS } from "@/types/preferences";

type FirmSettingsContextValue = {
  loading: boolean;
  lawFirmId?: string;
  settings: FirmSettings;
  features: FirmFeatures;
  isLocked: (key: string) => boolean;
  refresh: () => Promise<void>;
  updateFirmSettings: (partial: Partial<FirmSettings>) => Promise<void>;
  /**
   * Merge a slice another provider has already saved to the server, without a
   * request. Keeps this copy current so a later update here, or a lock that
   * snapshots it, does not carry the pre-save value.
   */
  applySavedSettings: (partial: Partial<FirmSettings>) => void;
};

const defaultContext: FirmSettingsContextValue = {
  loading: true,
  lawFirmId: undefined,
  settings: DEFAULT_FIRM_SETTINGS,
  features: DEFAULT_FIRM_FEATURES,
  isLocked: () => false,
  refresh: async () => {},
  updateFirmSettings: async () => {},
  applySavedSettings: () => {},
};

const FirmSettingsContext = createContext<FirmSettingsContextValue>(defaultContext);

function mergeFirmSettings(partial: Partial<FirmSettings> | undefined | null): FirmSettings {
  if (!partial) return DEFAULT_FIRM_SETTINGS;
  return {
    ...DEFAULT_FIRM_SETTINGS,
    ...partial,
    sidebar: {
      ...DEFAULT_FIRM_SETTINGS.sidebar,
      ...(partial.sidebar || {}),
    },
    billing: {
      ...DEFAULT_FIRM_SETTINGS.billing,
      ...(partial.billing || {}),
    },
    // `branding` is a client-only slice: the backend DEFAULTS.firm canonical
    // shape never produces one and nothing persists/reads settings.branding
    // (firm branding lives on first-class law_firms columns owned by
    // LawFirmService (see backend settings.defaults.js). We still merge it
    // here off DEFAULT_FIRM_SETTINGS so the required `branding` slice is always
    // present and consistently shaped, even though the server never sends it.
    branding: {
      ...DEFAULT_FIRM_SETTINGS.branding,
      ...(partial.branding || {}),
    },
    storage: {
      ...DEFAULT_FIRM_SETTINGS.storage,
      ...(partial.storage || {}),
    },
    features: {
      ...DEFAULT_FIRM_FEATURES,
      ...(partial.features || {}),
    },
    locks: {
      ...(DEFAULT_FIRM_SETTINGS.locks || {}),
      ...(partial.locks || {}),
    },
    lockedSettings: {
      ...(DEFAULT_FIRM_SETTINGS.lockedSettings || {}),
      ...(partial.lockedSettings || {}),
    },
  };
}

export function FirmSettingsProvider({
  lawFirmId,
  initialSettings,
  children,
}: {
  lawFirmId: string;
  initialSettings?: Partial<FirmSettings>;
  children: React.ReactNode;
}) {
  // When the layout seeds initialSettings (derived from the already-fetched
  // firm record + plan features), we treat it as the source of truth and skip
  // the network fetch entirely. The data is equivalent to GET /settings/firm.
  const hasInitialSettings = !!initialSettings;
  const [loading, setLoading] = useState(!hasInitialSettings);
  const [settings, setSettings] = useState<FirmSettings>(() => mergeFirmSettings(initialSettings));
  const scope = useRef({ lawFirmId, generation: 0 });
  const loadGeneration = useRef(0);
  if (scope.current.lawFirmId !== lawFirmId) {
    scope.current = { lawFirmId, generation: scope.current.generation + 1 };
  }

  useEffect(() => {
    if (hasInitialSettings) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs context state from the seeded initialSettings prop; settings is also mutated independently via update/load
      setSettings(mergeFirmSettings(initialSettings));
      setLoading(false);
    }
  }, [initialSettings, lawFirmId, hasInitialSettings]);

  const loadFirmSettings = useCallback(async () => {
    const generation = scope.current.generation;
    const request = ++loadGeneration.current;
    const isCurrent = () => scope.current.generation === generation
      && scope.current.lawFirmId === lawFirmId && loadGeneration.current === request;
    if (!lawFirmId) {
      setSettings(mergeFirmSettings(initialSettings));
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const remote = await settingsService.getFirmSettings(lawFirmId);
      if (isCurrent()) setSettings(mergeFirmSettings(remote));
    } catch (error) {
      console.error("Failed to load firm settings:", error);
      if (isCurrent()) setSettings(mergeFirmSettings(initialSettings));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [initialSettings, lawFirmId]);

  // Only fetch on mount when not seeded. Once seeded, callers use refresh()
  // to pull the canonical server copy on demand.
  useEffect(() => {
    if (hasInitialSettings) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loadFirmSettings is an async data fetch that updates state on completion
    loadFirmSettings();
  }, [hasInitialSettings, loadFirmSettings]);

  const updateFirmSettings = useCallback(
    async (partial: Partial<FirmSettings>) => {
      if (!lawFirmId) return;
      const generation = scope.current.generation;
      const merged = mergeFirmSettings({ ...settings, ...partial });
      setSettings(merged);
      try {
        await settingsService.updateFirmSettings(lawFirmId, partial);
      } catch (error) {
        if (scope.current.generation === generation && scope.current.lawFirmId === lawFirmId) {
          setSettings((current) => current === merged ? settings : current);
        }
        throw error;
      }
    },
    [lawFirmId, settings],
  );

  const applySavedSettings = useCallback((partial: Partial<FirmSettings>) => {
    setSettings((current) => mergeFirmSettings({ ...current, ...partial }));
  }, []);

  const isLocked = useCallback(
    (key: string) => {
      return !!settings?.locks?.[key];
    },
    [settings],
  );

  const value = useMemo<FirmSettingsContextValue>(
    () => ({
      loading,
      lawFirmId,
      settings,
      features: settings.features || DEFAULT_FIRM_FEATURES,
      isLocked,
      refresh: loadFirmSettings,
      updateFirmSettings,
      applySavedSettings,
    }),
    [loading, lawFirmId, settings, isLocked, loadFirmSettings, updateFirmSettings, applySavedSettings],
  );

  return (
    <FirmSettingsContext value={value}>
      {children}
    </FirmSettingsContext>
  );
}

export function useFirmSettings() {
  return useContext(FirmSettingsContext);
}
