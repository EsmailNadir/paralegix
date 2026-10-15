"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import SuccessNotification from "@/components/SuccessNotification";
import { ChevronRight, Save } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import settingsService from "@/services/settings.service";
import Button from "@/components/ui/Button";
import Dropdown, { type DropdownOption } from "@/components/ui/Dropdown";
import ErrorNotification from "@/components/ErrorNotification";
import LoadingSpinner from "@/components/LoadingSpinner";
import type { ClientSettings } from "@/types/preferences";
import { DEFAULT_CLIENT_SETTINGS } from "@/types/preferences";
import Checkbox from "@/components/ui/Checkbox";
import ThemeSelector from "@/components/ui/ThemeSelector";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { useClientPortal } from "@/contexts/ClientPortalContext";
import NavigationLink from "@/components/ui/NavigationLink";
import useFormFeedback from "@/hooks/useFormFeedback";
import ClientRecordPicker from "@/components/portalComp/ClientRecordPicker";

function mergeClientSettings(settings?: Partial<ClientSettings>): ClientSettings {
  const resolvedDefaultView =
    settings?.portal?.defaultView === "files"
      ? "matters"
      : settings?.portal?.defaultView;

  return {
    notifications: {
      ...DEFAULT_CLIENT_SETTINGS.notifications,
      ...(settings?.notifications || {}),
    },
    communication: {
      ...DEFAULT_CLIENT_SETTINGS.communication,
      ...(settings?.communication || {}),
    },
    portal: {
      ...DEFAULT_CLIENT_SETTINGS.portal,
      ...(settings?.portal || {}),
      defaultView: resolvedDefaultView || DEFAULT_CLIENT_SETTINGS.portal.defaultView,
    },
  };
}

const PREFERRED_METHOD_OPTIONS: DropdownOption[] = [
  { label: "Email", value: "email" },
  { label: "Phone", value: "phone" },
  { label: "Portal", value: "portal" },
];

const DEFAULT_VIEW_OPTIONS: DropdownOption[] = [
  { label: "Matters", value: "matters" },
  { label: "Invoices", value: "invoices" },
  { label: "Messages", value: "messages" },
];

export default function ClientPortalSettingsPage() {
  const params = useParams();
  const { user } = useAuth();
  const lawFirmId = Array.isArray(params?.lawFirmId)
    ? params.lawFirmId[0]
    : (params?.lawFirmId as string);
  const { associations, associationsLoading, activeAssociation, selectionRequired, setActiveClientRecordId } = useClientPortal();
  const clientRecordId = activeAssociation?.clientRecordId;

  const [settings, setSettings] = useState<ClientSettings>(DEFAULT_CLIENT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { errorMessage: error, setErrorMessage: setError, feedbackRef } = useFormFeedback();
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const saveRef = useRef<HTMLButtonElement>(null);
  const generationRef = useRef(0);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads the current theme from the DOM on mount (SSR-safe)
    setIsDark(document.documentElement.classList.contains("dark"));
  }, []);

  const applyTheme = (theme: "light" | "dark") => {
    if (theme === "dark") {
      document.documentElement.classList.add("dark");
      localStorage.setItem("paralegix-theme", "dark");
    } else {
      document.documentElement.classList.remove("dark");
      localStorage.setItem("paralegix-theme", "light");
    }
    setIsDark(theme === "dark");
  };

  const loadSettings = useCallback(async () => {
    const generation = ++generationRef.current;
    if (!lawFirmId || !user?.uid || associationsLoading || selectionRequired) return;
    try {
      setLoading(true);
      setSaving(false);
      setError('');
      setSettingsLoaded(false);
      setSuccessMessage(null);
      const response = await settingsService.getPortalClientSettings(lawFirmId, clientRecordId);
      if (generation !== generationRef.current) return;
      setSettings(mergeClientSettings(response));
      setSettingsLoaded(true);
    } catch (err) {
      if (generation !== generationRef.current) return;
      setError(getErrorMessage(err, "Failed to load client settings"));
      setSettings(DEFAULT_CLIENT_SETTINGS);
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [lawFirmId, user?.uid, associationsLoading, selectionRequired, clientRecordId, setError]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loadSettings is an async data fetch that updates state on completion
    loadSettings();
    return () => { generationRef.current += 1; };
  }, [loadSettings]);

  const updateSettings = (next: Partial<ClientSettings>) => {
    setSettings((prev) => mergeClientSettings({ ...prev, ...next }));
    setSuccessMessage(null);
  };

  const handleSave = async () => {
    if (!lawFirmId || !user?.uid || !settingsLoaded || saving) return;
    const generation = generationRef.current;
    try {
      setSaving(true);
      setError('');
      setSuccessMessage(null);
      await settingsService.updatePortalClientSettings(lawFirmId, settings, clientRecordId);
      if (generation !== generationRef.current) return;
      setSuccessMessage("Settings saved successfully.");
      requestAnimationFrame(() => saveRef.current?.focus());
    } catch (err) {
      if (generation === generationRef.current) setError(getErrorMessage(err, "Failed to save client settings"));
    } finally {
      setSaving(false);
    }
  };

  if (selectionRequired) {
    return <ClientRecordPicker associations={associations} onSelect={setActiveClientRecordId} />;
  }

  if (loading) {
    return <LoadingSpinner fullPage />;
  }

  return (
    <div className="p-8 max-w-[1600px] mx-auto min-w-0">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-on-surface">Portal Settings</h1>
        <p className="text-sm text-on-surface-muted mt-1">
          Manage your notification and communication preferences for this law firm.
        </p>
      </div>

      <div ref={feedbackRef} tabIndex={-1}>
        <ErrorNotification error={error} onClose={() => { setError(''); saveRef.current?.focus(); }} />
      </div>

      <div role="status" aria-label="Settings update" className="sr-only">{saving ? 'Saving settings...' : ''}</div>
      <SuccessNotification message={successMessage} className="mt-4" />

      {/* Your profile, data export, and account deletion are per-user, not
          per-firm, so they live on /account - reachable even without a firm. */}
      <div className="mt-6 bg-surface rounded-2xl border border-outline-subtle p-5 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium text-on-surface">Your Account</p>
          <p className="text-xs text-on-surface-muted mt-1">
            Profile picture, name, data export, and account deletion.
          </p>
        </div>
        <NavigationLink href="/account" className="inline-flex items-center justify-center font-medium transition-[background-color,border-color,color,transform] duration-100 active:scale-[0.985] motion-reduce:active:scale-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--surface)] bg-surface text-on-surface border border-control-border hover:bg-surface-hover focus-visible:ring-focus-ring shrink-0 gap-1.5 px-3.5 py-2 text-xs rounded-xl cursor-pointer">
          Account Settings
          <ChevronRight size={14} strokeWidth={2} />
        </NavigationLink>
      </div>

      <div className="mt-6 bg-surface rounded-2xl border border-outline-subtle p-5">
        <p className="text-sm font-medium text-on-surface mb-1">Appearance</p>
        <p className="text-xs text-on-surface-muted mb-3">
          Choose your preferred color theme for the portal.
        </p>
        <ThemeSelector
          value={isDark ? "dark" : "light"}
          onChange={(theme) => applyTheme(theme === "dark" ? "dark" : "light")}
          includeSystem={false}
        />
      </div>

      <div className="mt-6 bg-surface rounded-2xl border border-outline-subtle p-5 space-y-5">
        <div>
          <p className="text-sm font-medium text-on-surface mb-3">Notifications</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Checkbox
              checked={settings.notifications.emailOnNewInvoice}
              onChange={(checked) =>
                updateSettings({
                  notifications: {
                    ...settings.notifications,
                    emailOnNewInvoice: checked,
                  },
                })
              }
              label="Email on new invoice"
            />
            <Checkbox
              checked={settings.notifications.emailOnNewMessage}
              onChange={(checked) =>
                updateSettings({
                  notifications: {
                    ...settings.notifications,
                    emailOnNewMessage: checked,
                  },
                })
              }
              label="Email on new message"
            />
            <Checkbox
              checked={settings.notifications.emailOnMatterUpdate}
              onChange={(checked) =>
                updateSettings({
                  notifications: {
                    ...settings.notifications,
                    emailOnMatterUpdate: checked,
                  },
                })
              }
              label="Email on matter update"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Dropdown
            label="Preferred Contact Method"
            value={settings.communication.preferredMethod}
            options={PREFERRED_METHOD_OPTIONS}
            onChange={(value) =>
              updateSettings({
                communication: {
                  ...settings.communication,
                  preferredMethod: value as ClientSettings["communication"]["preferredMethod"],
                },
              })
            }
          />

          <Dropdown
            label="Portal Default View"
            value={settings.portal.defaultView}
            options={DEFAULT_VIEW_OPTIONS}
            onChange={(value) =>
              updateSettings({
                portal: {
                  ...settings.portal,
                  defaultView: value as ClientSettings["portal"]["defaultView"],
                },
              })
            }
          />
        </div>

        <div className="flex justify-end">
          <Button ref={saveRef} type="primary" onClick={handleSave} loading={saving} disabled={!settingsLoaded} icon={<Save size={14} />}>
            Save Settings
          </Button>
        </div>
      </div>
    </div>
  );
}
