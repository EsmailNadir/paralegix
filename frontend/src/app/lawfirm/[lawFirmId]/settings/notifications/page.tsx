'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import settingsService from '@/services/settings.service';
import type { InAppNotificationPrefs, DigestDeliveryPrefs } from '@/types/preferences';
import ErrorNotification from '@/components/ErrorNotification';
import ToggleSwitch from '@/components/ui/ToggleSwitch';
import Dropdown, { type DropdownOption } from '@/components/ui/Dropdown';
import PanelLoadingSpinner from '@/components/ui/PanelLoadingSpinner';
import { getUserTimeZone } from '@/lib/utils/timezone';

const CATEGORIES: { key: keyof InAppNotificationPrefs; label: string; description: string }[] = [
  { key: 'taskAssigned', label: 'Task assignments', description: "When you're assigned to a task." },
  { key: 'mention', label: 'Mentions', description: 'When someone @mentions you in a note or message.' },
  { key: 'message', label: 'Messages', description: 'When a client sends a new message.' },
  { key: 'matterAdded', label: 'Matter membership', description: "When you're added to a matter." },
  { key: 'invoicePaid', label: 'Invoice paid', description: 'When one of your invoices is paid in full.' },
  { key: 'invoiceOverdue', label: 'Invoice overdue', description: 'When one of your invoices becomes overdue.' },
  { key: 'signingRequested', label: 'Signature requested', description: 'When someone requests your signature on a document.' },
  { key: 'signingCompleted', label: 'Document signed', description: 'When a document you sent for signature is fully signed.' },
  { key: 'signingDeclined', label: 'Signature declined', description: 'When a signer declines to sign a document.' },
  { key: 'documentUploaded', label: 'Client uploads', description: 'When a client uploads documents to one of your matters.' },
  { key: 'roleChanged', label: 'Role updated', description: 'When your role or permissions are changed.' },
];

/**
 * Digest delivery shown when the user has never saved a preference. Mirrors the
 * server's own fallback (`settings.defaults.js`), so the controls open on the
 * schedule the user is actually on rather than on an invented one.
 */
const DIGEST_DEFAULTS: Required<DigestDeliveryPrefs> = {
  enabled: true,
  hour: 7,
  days: 'weekdays',
};

/** Delivery hours 0-23, labelled on the 12-hour clock the app displays times in. */
const HOUR_OPTIONS: DropdownOption[] = Array.from({ length: 24 }, (_, hour) => ({
  value: String(hour),
  label: `${hour % 12 === 0 ? 12 : hour % 12}:00 ${hour < 12 ? 'AM' : 'PM'}`,
}));

const DAYS_OPTIONS: DropdownOption[] = [
  { value: 'weekdays', label: 'Weekdays only' },
  { value: 'daily', label: 'Every day' },
];

const DEFAULTS: Required<InAppNotificationPrefs> = {
  taskAssigned: true,
  message: true,
  mention: true,
  matterAdded: true,
  invoicePaid: true,
  invoiceOverdue: true,
  signingRequested: true,
  signingCompleted: true,
  signingDeclined: true,
  documentUploaded: true,
  roleChanged: true,
};

/**
 * Per-user notification preferences: daily digest delivery
 * (`user_settings.preferences.notifications.digest`) and the in-app category
 * toggles (`…notifications.inApp`), both read and written through the settings
 * service. Every control persists immediately (the backend deep-merges the
 * patch) and rolls back on failure.
 */
export default function NotificationsSettingsPage() {
  const params = useParams();
  const lawFirmId = Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : (params?.lawFirmId as string);

  const [prefs, setPrefs] = useState<Required<InAppNotificationPrefs>>(DEFAULTS);
  const [digest, setDigest] = useState<Required<DigestDeliveryPrefs>>(DIGEST_DEFAULTS);
  // Resolved after mount: reading the browser zone during SSR would render a
  // server-side zone into the markup and mismatch on hydration.
  const [browserTimeZone, setBrowserTimeZone] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the browser zone is only readable after mount, so it cannot seed the initial state
    setBrowserTimeZone(getUserTimeZone());
  }, []);

  useEffect(() => {
    let cancelled = false;
    settingsService
      .getUserSettings(lawFirmId)
      .then((res) => {
        if (cancelled) return;
        const inApp = res.preferences?.notifications?.inApp || {};
        setPrefs({ ...DEFAULTS, ...inApp });
        setDigest({ ...DIGEST_DEFAULTS, ...(res.preferences?.notifications?.digest || {}) });
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load preferences'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [lawFirmId]);

  const toggle = async (key: keyof InAppNotificationPrefs) => {
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    setSaving(true);
    setError(null);
    try {
      await settingsService.updateUserSettings({ notifications: { inApp: { [key]: next[key] } } }, lawFirmId);
    } catch (e) {
      // Roll back the toggle on failure.
      setPrefs((p) => ({ ...p, [key]: !next[key] }));
      setError(e instanceof Error ? e.message : 'Failed to save preference');
    } finally {
      setSaving(false);
    }
  };

  /**
   * Applies one change to the digest schedule, sending the whole resolved
   * `{ enabled, hour, days }` rather than the single changed key, so a first
   * write records the schedule the user was shown instead of leaving the other
   * two fields to server defaults that could later drift away from it.
   */
  const saveDigest = async (patch: Partial<DigestDeliveryPrefs>) => {
    const previous = digest;
    const next = { ...digest, ...patch };
    setDigest(next);
    setSaving(true);
    setError(null);
    try {
      await settingsService.updateUserSettings({ notifications: { digest: next } }, lawFirmId);
    } catch (e) {
      // Roll back to the schedule that is still stored on the server.
      setDigest(previous);
      setError(e instanceof Error ? e.message : 'Failed to save preference');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <PanelLoadingSpinner label="Loading notification preferences" />;
  }

  return (
    <div className="px-6 py-6 space-y-6">
      {error && <ErrorNotification error={error} onClose={() => setError(null)} />}

      <div>
        <h2 className="text-lg font-semibold text-on-surface">Notifications</h2>
        <p className="text-sm text-on-surface-secondary mt-1">
          Choose what you get emailed about and what shows up in-app.
        </p>
      </div>

      {/* Email first: it governs mail leaving the building, so it is the
          costlier setting to have wrong. */}
      <section className="space-y-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-muted">Email</h3>

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-on-surface">Daily digest</p>
            <p className="text-xs text-on-surface-muted">
              One summary each morning of what&apos;s overdue and due soon
            </p>
          </div>
          <ToggleSwitch
            checked={digest.enabled}
            onChange={() => saveDigest({ enabled: !digest.enabled })}
            disabled={saving}
            ariaLabel="Daily digest"
          />
        </div>

        {/* The schedule only means anything while the digest is on. */}
        {digest.enabled && (
          <div className="space-y-3 pl-1">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:max-w-md">
              <Dropdown
                label="Delivery time"
                value={String(digest.hour)}
                onChange={(v) => saveDigest({ hour: Number(v) })}
                options={HOUR_OPTIONS}
                busy={saving}
                className="text-sm"
                portal
              />
              <Dropdown
                label="Days"
                value={digest.days}
                onChange={(v) => saveDigest({ days: v as Required<DigestDeliveryPrefs>['days'] })}
                options={DAYS_OPTIONS}
                busy={saving}
                className="text-sm"
                portal
              />
            </div>
            {browserTimeZone && (
              <p className="text-xs text-on-surface-muted">
                Sent at this hour in {browserTimeZone}, the timezone this browser reports.
              </p>
            )}
          </div>
        )}
      </section>

      <div className="border-t border-outline pt-4">
        <h3 className="mb-4 text-xs font-semibold uppercase tracking-wide text-on-surface-muted">In-app</h3>
        <div className="space-y-4">
          {CATEGORIES.map((c) => (
            <div key={c.key} className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-on-surface">{c.label}</p>
                <p className="text-xs text-on-surface-muted">{c.description}</p>
              </div>
              <ToggleSwitch
                checked={prefs[c.key]}
                onChange={() => toggle(c.key)}
                disabled={saving}
                ariaLabel={c.label}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
