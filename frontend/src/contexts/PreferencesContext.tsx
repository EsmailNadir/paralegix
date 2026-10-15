"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
} from "react";
import settingsService from "@/services/settings.service";
import { useFirmSettings } from "@/contexts/FirmSettingsContext";
import type {
  SidebarPreferences,
  DashboardPreferences,
  UserPreferences,
  ThemePreference,
  TemplateVersion,
} from "@/types/preferences";
import {
  DEFAULT_SIDEBAR_PREFERENCES,
  DEFAULT_DASHBOARD_PREFERENCES,
  DEFAULT_THEME,
  DEFAULT_TEMPLATE_VERSION,
  isTemplateVersion,
  mergeSidebarPreferences,
  mergeDashboardPreferences,
} from "@/types/preferences";

const getSidebarStorageKey = (lawFirmId: string) => `paralegix-sidebar:${lawFirmId}`;

function readStoredSidebar(lawFirmId: string): SidebarPreferences {
  if (typeof window === "undefined" || !lawFirmId) {
    return mergeSidebarPreferences(undefined);
  }

  try {
    const raw = localStorage.getItem(getSidebarStorageKey(lawFirmId));
    if (!raw) return mergeSidebarPreferences(undefined);

    const parsed = JSON.parse(raw) as Partial<SidebarPreferences>;
    return mergeSidebarPreferences(parsed);
  } catch {
    return mergeSidebarPreferences(undefined);
  }
}

function persistSidebar(lawFirmId: string, sidebar: SidebarPreferences) {
  if (typeof window === "undefined" || !lawFirmId) return;

  try {
    localStorage.setItem(getSidebarStorageKey(lawFirmId), JSON.stringify(sidebar));
  } catch {
    // Ignore storage failures and fall back to server-backed state only.
  }
}

type PreferenceWrite<T> = { value: T; status: "pending" | "saved" | "failed" };
type PreferenceWrites<T> = { generation: number; base?: T; entries: PreferenceWrite<T>[] };

// Keep the newest pending or successful choice. If every write fails, restore
// the value from before the batch, regardless of the order responses arrive in.
async function savePreference<T>(options: {
  tracker: { current: PreferenceWrites<T> | null };
  generation: number;
  value: T;
  setValue: (update: (current: T) => T) => void;
  persist: (value: T) => void;
  send: () => Promise<unknown>;
  isCurrent: () => boolean;
}) {
  const { tracker, generation, value, setValue, persist, send, isCurrent } = options;
  if (!tracker.current || tracker.current.generation !== generation
    || tracker.current.entries.every((entry) => entry.status !== "pending")) {
    tracker.current = { generation, entries: [] };
  }
  const writes = tracker.current;
  const first = writes.entries.length === 0;
  const entry: PreferenceWrite<T> = { value, status: "pending" };
  writes.entries.push(entry);
  setValue((current) => {
    if (first) writes.base = current;
    return value;
  });
  persist(value);
  try {
    await send();
    entry.status = "saved";
  } catch (error) {
    entry.status = "failed";
    throw error;
  } finally {
    setValue((current) => {
      if (!isCurrent()) return current;
      const latest = writes.entries.findLast((write) => write.status !== "failed");
      const resolved = latest ? latest.value : (writes.base ?? current);
      persist(resolved);
      return resolved;
    });
  }
}

type PreferencesContextType = {
  sidebar: SidebarPreferences;
  dashboard: DashboardPreferences;
  theme: ThemePreference;
  templateVersion: TemplateVersion;
  loading: boolean;
  updateSidebarPreferences: (sidebar: SidebarPreferences) => Promise<void>;
  updateDashboardPreferences: (dashboard: DashboardPreferences) => Promise<void>;
  updateTheme: (theme: ThemePreference) => Promise<void>;
  updateTemplateVersion: (version: TemplateVersion) => Promise<void>;
};

const PreferencesContext = createContext<PreferencesContextType>({
  sidebar: DEFAULT_SIDEBAR_PREFERENCES,
  dashboard: DEFAULT_DASHBOARD_PREFERENCES,
  theme: DEFAULT_THEME,
  templateVersion: DEFAULT_TEMPLATE_VERSION,
  loading: true,
  updateSidebarPreferences: async () => {},
  updateDashboardPreferences: async () => {},
  updateTheme: async () => {},
  updateTemplateVersion: async () => {},
});

export function PreferencesProvider({
  lawFirmId,
  children,
}: {
  lawFirmId: string;
  children: React.ReactNode;
}) {
  const themeWrites = useRef<PreferenceWrites<ThemePreference> | null>(null);
  const sidebarWrites = useRef<PreferenceWrites<SidebarPreferences> | null>(null);
  const dashboardWrites = useRef<PreferenceWrites<DashboardPreferences> | null>(null);
  const templateVersionWrites = useRef<PreferenceWrites<TemplateVersion> | null>(null);
  const scope = useRef({ lawFirmId, generation: 0 });
  if (scope.current.lawFirmId !== lawFirmId) {
    scope.current = { lawFirmId, generation: scope.current.generation + 1 };
  }
  const [sidebar, setSidebar] = useState<SidebarPreferences>(() => readStoredSidebar(lawFirmId));
  const [dashboard, setDashboard] = useState<DashboardPreferences>(() => mergeDashboardPreferences(undefined));
  const [templateVersion, setTemplateVersion] = useState<TemplateVersion>(DEFAULT_TEMPLATE_VERSION);
  const [theme, setTheme] = useState<ThemePreference>(() => {
    // Read from localStorage for instant hydration (avoids waiting for API)
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("paralegix-theme");
      if (stored === "light" || stored === "dark" || stored === "system") {
        return stored;
      }
    }
    return DEFAULT_THEME;
  });
  const [userLoading, setUserLoading] = useState(true);
  const [lockState, setLockState] = useState<{ theme: boolean; sidebar: boolean }>({
    theme: false,
    sidebar: false,
  });
  // The user's own theme preference from /settings/user, combined with the
  // firm lock below to resolve the effective theme.
  const [userThemePreference, setUserThemePreference] = useState<ThemePreference | undefined>(undefined);

  // Firm settings come from FirmSettingsContext (this provider is mounted
  // inside FirmSettingsProvider), avoiding a duplicate getFirmSettings fetch.
  const { settings: firmSettings, loading: firmSettingsLoading, applySavedSettings } = useFirmSettings();
  const loading = firmSettingsLoading || userLoading;
  const currentLocks = useRef(firmSettings.locks);
  currentLocks.current = firmSettings.locks;
  const currentSidebar = useRef(sidebar);
  currentSidebar.current = sidebar;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads sidebar prefs from localStorage (browser-only external source) on firm change
    setSidebar(readStoredSidebar(lawFirmId));
  }, [lawFirmId]);

  // Derive lock state + sidebar from the shared firm settings. Reactive so it
  // updates if firm settings resolve after mount or are changed.
  useEffect(() => {
    if (!lawFirmId) return;

    const themeLocked = !!firmSettings.locks?.theme;
    const sidebarLocked = !!firmSettings.locks?.sidebar;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- effect also persists the resolved sidebar to localStorage; sidebar is independently user-editable
    setLockState({ theme: themeLocked, sidebar: sidebarLocked });

    const resolvedSidebar = sidebarLocked
      ? (firmSettings.lockedSettings?.sidebar as SidebarPreferences | undefined)
      : firmSettings.sidebar;
    const mergedSidebar = mergeSidebarPreferences(resolvedSidebar);
    // Re-deriving the layout already on screen keeps the current value, so a
    // firm settings change that did not touch the sidebar is a no-op here.
    const onScreen = currentSidebar.current;
    const next = JSON.stringify(mergeSidebarPreferences(onScreen)) === JSON.stringify(mergedSidebar)
      ? onScreen
      : mergedSidebar;
    setSidebar(next);
    persistSidebar(lawFirmId, next);
  }, [lawFirmId, firmSettings]);

  // Fetch the user's own settings (dashboard widgets + theme preference).
  useEffect(() => {
    if (!lawFirmId) return;
    let cancelled = false;

    const load = async () => {
      setUserLoading(true);
      try {
        const userSettings = await settingsService
          .getUserSettings(lawFirmId)
          .catch(() => ({ preferences: {} as UserPreferences }));

        if (cancelled) return;

        const userPreferences = userSettings.preferences || {};
        setDashboard(mergeDashboardPreferences(userPreferences.dashboard));
        setTemplateVersion(
          isTemplateVersion(userPreferences.templateVersion)
            ? userPreferences.templateVersion
            : DEFAULT_TEMPLATE_VERSION
        );
        setUserThemePreference(
          userPreferences.theme === "light" || userPreferences.theme === "dark" || userPreferences.theme === "system"
            ? userPreferences.theme
            : undefined
        );
      } catch {
        // Defaults are already set
      } finally {
        if (!cancelled) setUserLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [lawFirmId]);

  // Resolve the effective theme: a firm-locked theme wins over the user's
  // preference. Mirrors the original combined logic, now reactive to both
  // the shared firm settings and the fetched user preference.
  useEffect(() => {
    if (!lawFirmId) return;
    const themeLocked = !!firmSettings.locks?.theme;
    const serverTheme = themeLocked
      ? (firmSettings.lockedSettings?.theme as ThemePreference | undefined)
      : userThemePreference;
    if (serverTheme === "light" || serverTheme === "dark" || serverTheme === "system") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- effect also writes the resolved theme to localStorage; theme is independently user-editable
      setTheme(serverTheme);
      if (typeof window !== "undefined") {
        localStorage.setItem("paralegix-theme", serverTheme);
      }
    }
  }, [lawFirmId, firmSettings, userThemePreference]);

  const updateSidebarPreferences = useCallback(
    async (newSidebar: SidebarPreferences) => {
      if (lockState.sidebar || loading) return;
      const generation = scope.current.generation;
      const isCurrent = () => scope.current.generation === generation
        && scope.current.lawFirmId === lawFirmId && !currentLocks.current?.sidebar;
      try {
        await savePreference({
          tracker: sidebarWrites, generation, value: newSidebar, setValue: setSidebar,
          persist: (value) => persistSidebar(lawFirmId, value),
          send: () => settingsService.updateFirmSettings(lawFirmId, { sidebar: newSidebar }),
          isCurrent,
        });
      } finally {
        // The sidebar is a firm setting, so once the last overlapping write
        // settles its outcome is copied into the shared firm settings. Left
        // stale, the next unrelated firm save re-derives the sidebar from the
        // pre-edit copy, and a sidebar lock snapshots the old layout.
        const writes = sidebarWrites.current;
        if (isCurrent() && writes?.generation === generation
          && writes.entries.every((write) => write.status !== "pending")) {
          const latest = writes.entries.findLast((write) => write.status !== "failed");
          const resolved = latest ? latest.value : writes.base;
          if (resolved) applySavedSettings({ sidebar: resolved });
        }
      }
    },
    [lawFirmId, lockState.sidebar, loading, applySavedSettings]
  );

  const updateDashboardPreferences = useCallback(
    async (newDashboard: DashboardPreferences) => {
      if (userLoading) return;
      const generation = scope.current.generation;
      await savePreference({
        tracker: dashboardWrites, generation, value: newDashboard, setValue: setDashboard,
        persist: () => {},
        send: () => settingsService.updateUserSettings({ dashboard: newDashboard }, lawFirmId),
        isCurrent: () => scope.current.generation === generation && scope.current.lawFirmId === lawFirmId,
      }).catch(() => {});
    },
    [lawFirmId, userLoading]
  );

  const updateTheme = useCallback(
    async (newTheme: ThemePreference) => {
      if (lockState.theme || loading) return;
      const generation = scope.current.generation;
      await savePreference({
        tracker: themeWrites, generation, value: newTheme, setValue: setTheme,
        persist: (value) => {
          localStorage.setItem("paralegix-theme", value);
          setUserThemePreference(value);
        },
        send: () => settingsService.updateUserSettings({ theme: newTheme }, lawFirmId),
        isCurrent: () => scope.current.generation === generation
          && scope.current.lawFirmId === lawFirmId && !currentLocks.current?.theme,
      });
    },
    [lawFirmId, lockState.theme, loading]
  );

  // A refused save puts back the version that was showing, the same way a
  // refused theme save does, and the rejection reaches the caller.
  const updateTemplateVersion = useCallback(
    async (newVersion: TemplateVersion) => {
      if (userLoading) return;
      const generation = scope.current.generation;
      await savePreference({
        tracker: templateVersionWrites, generation, value: newVersion, setValue: setTemplateVersion,
        persist: () => {},
        send: () => settingsService.updateUserSettings({ templateVersion: newVersion }, lawFirmId),
        isCurrent: () => scope.current.generation === generation && scope.current.lawFirmId === lawFirmId,
      });
    },
    [lawFirmId, userLoading]
  );

  const value = useMemo(
    () => ({
      sidebar, dashboard, theme, templateVersion, loading,
      updateSidebarPreferences, updateDashboardPreferences, updateTheme, updateTemplateVersion,
    }),
    [
      sidebar, dashboard, theme, templateVersion, loading,
      updateSidebarPreferences, updateDashboardPreferences, updateTheme, updateTemplateVersion,
    ]
  );

  return (
    <PreferencesContext value={value}>
      {children}
    </PreferencesContext>
  );
}

export function usePreferences() {
  return useContext(PreferencesContext);
}
