'use client';

import { useEffect, useId, useState, useRef, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import Image from 'next/image';
import SuccessNotification from "@/components/SuccessNotification";
import { ChevronRight } from 'lucide-react';
import Button from '@/components/ui/Button';
import Checkbox from "@/components/ui/Checkbox";
import ConfirmModal from '@/components/ui/ConfirmModal';
import AdminTransferModal from '@/components/ui/AdminTransferModal';
import Dropdown from '@/components/ui/Dropdown';
import AuthService from '@/services/auth.service';
import LawFirmService from '@/services/lawfirm.service';
import TasksService from '@/services/tasks.service';
import MatterEventsService from '@/services/matterEvents.service';
import ClientsService from '@/services/clients.service';
import { GoogleCalendarSync } from '@/services/googleCalendarSync.service';
import { OutlookCalendarSync } from '@/services/outlookCalendarSync.service';
import ErrorNotification from '@/components/ErrorNotification';
import { getFirebaseErrorMessage } from '@/lib/utils/firebaseErrors';
import { apiFetch, API_UNREACHABLE_MESSAGE } from '@/lib/utils/fetchWithTokenRefresh';
import ConnectionUnavailable from '@/components/ui/ConnectionUnavailable';
import RequirePermission from '@/components/ui/RequirePermission';
import type { LawFirm } from '@/types';
import { usePermissions } from '@/contexts/PermissionsContext';
import { useFirmSettings } from '@/contexts/FirmSettingsContext';
import { useLawFirm } from '@/contexts/LawFirmContext';
import { useNavigation } from '@/contexts/NavigationContext';
import settingsService from '@/services/settings.service';
import LogoCropModal from '@/components/settingsComp/LogoCropModal';
import PresentAsFirmCard from '@/components/settingsComp/PresentAsFirmCard';
import LockIndicator from '@/components/ui/LockIndicator';
import PanelLoadingSpinner from '@/components/ui/PanelLoadingSpinner';
import FieldLabel from '@/components/ui/FieldLabel';
import SectionLabel from '@/components/ui/SectionLabel';
import { buildExistingEventsPayload } from '@/lib/utils/existingEventsSyncPayload';
import { normalizeUsStateName, stateFromZip, US_STATE_NAMES } from '@/lib/constants/usStates';
import type { CalendarConnectionState } from '@/types/preferences';

type Settings = {
  googleState: CalendarConnectionState;
  microsoftState: CalendarConnectionState;
  /** Derived from the state: a grant that can sync (connected or unverified). */
  loggedInWithGoogle: boolean;
  loggedInWithMicrosoft: boolean;
  allowParalegixToOutlookSync: boolean;
  allowParalegixToGoogleSync: boolean;
  allowGoogleToParalegixSync: boolean;
  allowOutlookToParalegixSync: boolean;
  googleCalendarTarget?: 'paralegix' | 'default';
  outlookCalendarTarget?: 'paralegix' | 'default';
};

type LawFirmFormData = {
  name: string;
  description: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  email: string;
};

/**
 * The form's starting values for a firm. A state stored as free text ("TX",
 * "tx", "D.C.") opens on its full name so the picker shows it selected; one
 * that is not a recognisable US state is kept as it is.
 */
function lawFirmFormFrom(firm: LawFirm): LawFirmFormData {
  return {
    name: firm.name || '',
    description: firm.description || '',
    address: firm.address || '',
    city: firm.city || '',
    state: normalizeUsStateName(firm.state) ?? (firm.state || ''),
    zip: firm.zip || '',
    phone: firm.phone || '',
    email: firm.email || '',
  };
}

/**
 * An optional contact field as the update sends it: trimmed, since a pasted
 * email with a trailing space fails the API's email check, and null when left
 * empty, which clears it.
 */
function optionalField(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

const STATE_OPTIONS = US_STATE_NAMES.map((name) => ({ label: name, value: name }));

type SyncDirection = 'none' | 'paralegix-to-outlook' | 'outlook-to-paralegix' | 'paralegix-to-google' | 'google-to-paralegix' | 'both';

/** A grant the API still syncs: connected, or an older grant whose permission was never recorded. */
function canSync(state: CalendarConnectionState): boolean {
  return state === 'connected' || state === 'unverified';
}

const CONNECTION_STATUS: Record<Exclude<CalendarConnectionState, 'connected'>, string> = {
  unverified: 'Reconnect to confirm access',
  permission_required: 'Permission needed: reconnect and allow calendar access',
  reconnect_required: 'Connection lost: reconnect to resume sync',
  disconnected: 'Not connected',
};

/** One provider's row in Calendar Connections. */
function CalendarConnectionRow({
  label,
  state,
  email,
  disabled,
  onConnect,
  onDisconnect,
}: {
  label: string;
  state: CalendarConnectionState;
  email?: string;
  disabled: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const status = state === 'connected'
    ? (email ? `Connected: ${email}` : 'Connected')
    : CONNECTION_STATUS[state];
  const buttonClass = 'w-full sm:w-[165px] shrink-0';
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-on-surface-secondary break-all">{status}</div>
      </div>
      {state === 'connected' ? (
        <Button type="secondary" size="small" onClick={onDisconnect} disabled={disabled} className={buttonClass}>
          Disconnect
        </Button>
      ) : state === 'disconnected' ? (
        <Button type="secondary" size="small" onClick={onConnect} disabled={disabled} className={buttonClass}>
          Connect {label}
        </Button>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row shrink-0">
          <Button type="secondary" size="small" onClick={onConnect} disabled={disabled} className={buttonClass}>
            Reconnect {label}
          </Button>
          <Button type="secondary" size="small" onClick={onDisconnect} disabled={disabled} className={buttonClass}>
            Disconnect
          </Button>
        </div>
      )}
    </div>
  );
}

export default function GeneralSettingsPage() {
  const router = useRouter();
  const params = useParams();
  const lawFirmId = params.lawFirmId as string;
  const { lawFirm: contextLawFirm, refetchLawFirm } = useLawFirm();

  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<Settings>({
    googleState: 'disconnected',
    microsoftState: 'disconnected',
    loggedInWithGoogle: false,
    loggedInWithMicrosoft: false,
    allowParalegixToOutlookSync: false,
    allowParalegixToGoogleSync: false,
    allowGoogleToParalegixSync: false,
    allowOutlookToParalegixSync: false,
    googleCalendarTarget: 'default',
    outlookCalendarTarget: 'default',
  });
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [lawFirm, setLawFirm] = useState<LawFirm | null>(null);
  const [lawFirmLoading, setLawFirmLoading] = useState(true);
  const [lawFirmSaving, setLawFirmSaving] = useState(false);
  const [showLawFirmForm, setShowLawFirmForm] = useState(false);
  const [lawFirmFormData, setLawFirmFormData] = useState<LawFirmFormData>({
    name: '',
    description: '',
    address: '',
    city: '',
    state: '',
    zip: '',
    phone: '',
    email: '',
  });
  // A stored state the picker does not list, offered as its own option so
  // opening and saving the form never erases it.
  const [unlistedStoredState, setUnlistedStoredState] = useState<string | null>(null);
  // True while State holds what the ZIP filled in, so a later ZIP may replace
  // it; a stored or hand-picked state is never overwritten.
  const [stateFilledFromZip, setStateFilledFromZip] = useState(false);
  const stateHintId = useId();
  const [lawFirmSaveError, setLawFirmSaveError] = useState<Error | string | null>(null);
  const [lawFirmSuccess, setLawFirmSuccess] = useState<string | null>(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoDeleting, setLogoDeleting] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const logoCropObjectUrlRef = useRef<string | null>(null);
  const [logoCropSource, setLogoCropSource] = useState<string | null>(null);
  const [logoCropFileName, setLogoCropFileName] = useState('');
  const [showDeleteLogoModal, setShowDeleteLogoModal] = useState(false);
  const [showLeaveLawFirmModal, setShowLeaveLawFirmModal] = useState(false);
  const [showDeleteLawFirmModal, setShowDeleteLawFirmModal] = useState(false);
  const [showAdminTransferModal, setShowAdminTransferModal] = useState(false);
  const [eligibleMembers, setEligibleMembers] = useState<Array<{ userId: string; name: string }>>([]);
  const [syncingToGoogle, setSyncingToGoogle] = useState(false);
  const [syncingToOutlook, setSyncingToOutlook] = useState(false);
  const [syncResultMessage, setSyncResultMessage] = useState<string | null>(null);
  const [syncingEventsToGoogle, setSyncingEventsToGoogle] = useState(false);
  const [syncingEventsToOutlook, setSyncingEventsToOutlook] = useState(false);
  const [syncEventsResultMessage, setSyncEventsResultMessage] = useState<string | null>(null);
  const [retryingConnection, setRetryingConnection] = useState(false);
  const [googleEmail, setGoogleEmail] = useState<string | undefined>();
  const [microsoftEmail, setMicrosoftEmail] = useState<string | undefined>();
  const { hasPermission } = usePermissions();
  const { features, isLocked } = useFirmSettings();
  const { navigate } = useNavigation();

  const canEditFirmInfo = hasPermission('firm.update');
  const canManageBranding = hasPermission('firm.manageBranding');
  const canDeleteLawFirm = hasPermission('firm.delete');

  // When an admin locks `calendarSyncEnabled`, the backend rejects any
  // sync-direction change and force-overrides it on read, for every member,
  // administrators included (the same as a locked theme). Mirror that here:
  // disable the sync dropdowns and surface a "locked by firm" indicator so
  // nobody flips a control that the server will 403.
  const calendarSyncLocked = isLocked('calendarSyncEnabled');

  // The layout's calendar background sync reads these preferences from a query
  // that stays mounted for the whole workspace and is not refetched on window
  // focus, so each save here has to refresh it.
  const queryClient = useQueryClient();
  const refreshSyncPreferences = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['userSyncSettings', lawFirmId] }),
    [queryClient, lawFirmId],
  );
  // A disconnect also changes what the get-started checklist reads, so it
  // refreshes both caches the firm shell refreshes after a connect.
  const refreshCalendarConnection = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['userSyncSettings', lawFirmId] });
    void queryClient.invalidateQueries({ queryKey: ['getStartedProgress', lawFirmId, 'calendar'] });
  }, [queryClient, lawFirmId]);

  const loadInitialData = useCallback(async () => {
    try {
      setError(null);
      const response = await settingsService.getUserSettings(lawFirmId);
      const s = response.preferences || {};
      // The API derives both states from the stored grant. A Firebase sign-in
      // with the same provider is identity only and says nothing about calendar access.
      const googleState = s.googleCalendarState ?? 'disconnected';
      const microsoftState = s.microsoftCalendarState ?? 'disconnected';
      if (s.googleConnectedEmail) setGoogleEmail(s.googleConnectedEmail);
      setSettings({
        googleState,
        microsoftState,
        loggedInWithGoogle: canSync(googleState),
        loggedInWithMicrosoft: canSync(microsoftState),
        allowParalegixToOutlookSync: !!s.allowParalegixToOutlookSync,
        allowParalegixToGoogleSync: !!s.allowParalegixToGoogleSync,
        allowGoogleToParalegixSync: !!s.allowGoogleToParalegixSync,
        allowOutlookToParalegixSync: !!s.allowOutlookToParalegixSync,
        googleCalendarTarget: s.googleCalendarTarget ?? 'default',
        outlookCalendarTarget: s.outlookCalendarTarget ?? 'default',
      });

      // check-auth reports the account address and resolves an older
      // unverified grant against the provider, so its state wins when it answers.
      if (googleState !== 'disconnected') {
        GoogleCalendarSync.checkGoogleAuth().then(({ email, state }) => {
          if (email) setGoogleEmail(email);
          if (state) setSettings((prev) => ({ ...prev, googleState: state, loggedInWithGoogle: canSync(state) }));
        }).catch(() => {});
      }
      if (microsoftState !== 'disconnected') {
        OutlookCalendarSync.checkOutlookAuth().then(({ email, state }) => {
          if (email) setMicrosoftEmail(email);
          if (state) setSettings((prev) => ({ ...prev, microsoftState: state, loggedInWithMicrosoft: canSync(state) }));
        }).catch(() => {});
      }

      // The firm record is seeded from LawFirmContext below (already fetched by
      // the layout), so this page no longer re-requests it. The user's own
      // profile card reads ProfileContext directly.
    } catch (e: any) {
      setError(e?.message || 'Failed to load settings');
    } finally {
      setLawFirmLoading(false);
    }
  }, [lawFirmId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch: firm settings/loading/error state set as the request progresses
    loadInitialData();
  }, [loadInitialData]);

  // Follow the shared LawFirmContext for the firm record instead of re-fetching
  // it; a save refreshes the context through refetchLawFirm. The edit form is
  // seeded when it opens, not here, so a context change never overwrites what
  // the user is typing.
  useEffect(() => {
    if (!contextLawFirm) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- follows the firm record in shared context (external source), updating only when the shared record changes
    setLawFirm(contextLawFirm);
    setLawFirmLoading(false);
  }, [contextLawFirm]);

  useEffect(() => {
    return () => {
      if (logoCropObjectUrlRef.current) {
        URL.revokeObjectURL(logoCropObjectUrlRef.current);
      }
    };
  }, []);

  const isConnectionError = error?.includes(API_UNREACHABLE_MESSAGE) ?? false;

  const handleRetryConnection = useCallback(async () => {
    setRetryingConnection(true);
    setError(null);
    await loadInitialData();
    setRetryingConnection(false);
  }, [loadInitialData]);

  const getOutlookSyncDirection = (): SyncDirection => {
    const toOutlook = settings.allowParalegixToOutlookSync;
    const fromOutlook = settings.allowOutlookToParalegixSync;
    
    if (toOutlook && fromOutlook) return 'both';
    if (toOutlook) return 'paralegix-to-outlook';
    if (fromOutlook) return 'outlook-to-paralegix';
    return 'none';
  };

  const getGoogleSyncDirection = (): SyncDirection => {
    const toGoogle = settings.allowParalegixToGoogleSync;
    const fromGoogle = settings.allowGoogleToParalegixSync;
    
    if (toGoogle && fromGoogle) return 'both';
    if (toGoogle) return 'paralegix-to-google'; // Using same value for consistency
    if (fromGoogle) return 'google-to-paralegix'; // Using same value for consistency
    return 'none';
  };

  const handleOutlookSyncChange = async (direction: string) => {
    if (!settings.loggedInWithMicrosoft) return;
    // Calendar sync is firm-locked: don't optimistically flip the UI before the
    // server rejects the write.
    if (calendarSyncLocked) return;
    const previousOutlook = {
      allowParalegixToOutlookSync: settings.allowParalegixToOutlookSync,
      allowOutlookToParalegixSync: settings.allowOutlookToParalegixSync,
    };
    
    try {
      setSaving(true);
      const newSettings = {
        allowParalegixToOutlookSync: false,
        allowOutlookToParalegixSync: false,
      };
      
      switch (direction) {
        case 'paralegix-to-outlook':
          newSettings.allowParalegixToOutlookSync = true;
          newSettings.allowOutlookToParalegixSync = false;
          break;
        case 'outlook-to-paralegix':
          newSettings.allowOutlookToParalegixSync = true;
          newSettings.allowParalegixToOutlookSync = false;
          break;
        case 'both':
          newSettings.allowParalegixToOutlookSync = true;
          newSettings.allowOutlookToParalegixSync = true;
          break;
        case 'none':
          newSettings.allowParalegixToOutlookSync = false;
          newSettings.allowOutlookToParalegixSync = false;
          break;
        default:
          break;
      }
      
      setSettings(prev => ({ ...prev, ...newSettings }));
      await settingsService.updateUserSettings(newSettings, lawFirmId);
      void refreshSyncPreferences();

      // Automatically enable/disable silent sync based on direction.
      // This is best-effort. Will fail locally (requires HTTPS) but works in production.
      if (newSettings.allowOutlookToParalegixSync) {
        OutlookCalendarSync.enableSilentSync(lawFirmId).catch(() => {});
      } else {
        OutlookCalendarSync.disableSilentSync().catch(() => {});
      }
    } catch (e: any) {
      // The dropdown changed before the save; put back what is stored.
      setSettings(prev => ({ ...prev, ...previousOutlook }));
      setError(e?.message || 'Failed to save Outlook sync settings');
    } finally {
      setSaving(false);
    }
  };

  const handleGoogleSyncChange = async (direction: string) => {
    if (!settings.loggedInWithGoogle) return;
    // Calendar sync is firm-locked: don't optimistically flip the UI before the
    // server rejects the write.
    if (calendarSyncLocked) return;
    const previousGoogle = {
      allowParalegixToGoogleSync: settings.allowParalegixToGoogleSync,
      allowGoogleToParalegixSync: settings.allowGoogleToParalegixSync,
    };
    
    try {
      setSaving(true);
      const newSettings = {
        allowParalegixToGoogleSync: false,
        allowGoogleToParalegixSync: false,
      };
      
      switch (direction) {
        case 'paralegix-to-google':
          newSettings.allowParalegixToGoogleSync = true;
          newSettings.allowGoogleToParalegixSync = false;
          break;
        case 'google-to-paralegix':
          newSettings.allowGoogleToParalegixSync = true;
          newSettings.allowParalegixToGoogleSync = false;
          break;
        case 'both':
          newSettings.allowParalegixToGoogleSync = true;
          newSettings.allowGoogleToParalegixSync = true;
          break;
        case 'none':
          newSettings.allowParalegixToGoogleSync = false;
          newSettings.allowGoogleToParalegixSync = false;
          break;
        default:
          break;
      }
      
      setSettings(prev => ({ ...prev, ...newSettings }));
      await settingsService.updateUserSettings(newSettings, lawFirmId);
      void refreshSyncPreferences();

      // Automatically enable/disable silent sync (watch channel) based on direction.
      // This is best-effort. Will fail locally (requires HTTPS) but works in production.
      if (newSettings.allowGoogleToParalegixSync) {
        GoogleCalendarSync.enableSilentSync(lawFirmId).catch(() => {});
      } else {
        GoogleCalendarSync.disableSilentSync().catch(() => {});
      }
    } catch (e: any) {
      // The dropdown changed before the save; put back what is stored.
      setSettings(prev => ({ ...prev, ...previousGoogle }));
      setError(e?.message || 'Failed to save Google sync settings');
    } finally {
      setSaving(false);
    }
  };

  const handleGoogleCalendarTargetChange = async (value: string) => {
    if (!settings.loggedInWithGoogle) return;
    const target = value as 'paralegix' | 'default';
    if (target !== 'paralegix' && target !== 'default') return;
    const previousTarget = settings.googleCalendarTarget;
    try {
      setSaving(true);
      setSettings(prev => ({ ...prev, googleCalendarTarget: target }));
      await settingsService.updateUserSettings({ googleCalendarTarget: target }, lawFirmId);
      void refreshSyncPreferences();
    } catch (e: any) {
      setSettings(prev => ({ ...prev, googleCalendarTarget: previousTarget }));
      setError(e?.message || 'Failed to save Google calendar target');
    } finally {
      setSaving(false);
    }
  };

  const handleOutlookCalendarTargetChange = async (value: string) => {
    if (!settings.loggedInWithMicrosoft) return;
    const target = value as 'paralegix' | 'default';
    if (target !== 'paralegix' && target !== 'default') return;
    const previousTarget = settings.outlookCalendarTarget;
    try {
      setSaving(true);
      setSettings(prev => ({ ...prev, outlookCalendarTarget: target }));
      await settingsService.updateUserSettings({ outlookCalendarTarget: target }, lawFirmId);
      void refreshSyncPreferences();
    } catch (e: any) {
      setSettings(prev => ({ ...prev, outlookCalendarTarget: previousTarget }));
      setError(e?.message || 'Failed to save Outlook calendar target');
    } finally {
      setSaving(false);
    }
  };

  const handleSyncExistingToGoogle = async () => {
    if (!lawFirmId || !settings.loggedInWithGoogle || googleSyncValue === 'none') return;
    try {
      setSyncingToGoogle(true);
      setError(null);
      setSyncResultMessage(null);
      const allTasks = await TasksService.listLawFirmTasks(lawFirmId);
      const toSync = allTasks.filter(
        (t) => t.dueDate && !t.googleEventId
      );
      if (toSync.length === 0) {
        setSyncResultMessage('No unsynced tasks with a due date to sync to Google.');
        setTimeout(() => setSyncResultMessage(null), 5000);
        return;
      }
      const payload = toSync.map((t) => ({
        taskId: t.taskId ?? (t as any).id,
        lawFirmId: t.lawFirmId ?? lawFirmId,
        title: t.title,
        description: t.description,
        location: t.location ?? null,
        dueDate: t.dueDate,
        dueDateTimeZone: t.dueDateTimeZone ?? null,
      }));
      const result = await GoogleCalendarSync.syncTasksToGoogle(payload);
      const count = result?.syncedCount ?? 0;
      setSyncResultMessage(`Synced ${count} task${count !== 1 ? 's' : ''} to Google Calendar.`);
      setTimeout(() => setSyncResultMessage(null), 5000);
    } catch (e: any) {
      setError(e?.message || 'Failed to sync tasks to Google');
    } finally {
      setSyncingToGoogle(false);
    }
  };

  const handleSyncExistingToOutlook = async () => {
    if (!lawFirmId || !settings.loggedInWithMicrosoft || outlookSyncValue === 'none') return;
    try {
      setSyncingToOutlook(true);
      setError(null);
      setSyncResultMessage(null);
      const allTasks = await TasksService.listLawFirmTasks(lawFirmId);
      const toSync = allTasks.filter(
        (t) => t.dueDate && !t.outlookId
      );
      if (toSync.length === 0) {
        setSyncResultMessage('No unsynced tasks with a due date to sync to Outlook.');
        setTimeout(() => setSyncResultMessage(null), 5000);
        return;
      }
      const payload = toSync.map((t) => ({
        taskId: t.taskId ?? (t as any).id,
        lawFirmId: t.lawFirmId ?? lawFirmId,
        title: t.title,
        description: t.description,
        location: t.location ?? null,
        dueDate: t.dueDate,
        dueDateTimeZone: t.dueDateTimeZone ?? null,
      }));
      const result = await OutlookCalendarSync.syncTasksToOutlook(payload);
      const count = result?.syncedCount ?? 0;
      setSyncResultMessage(`Synced ${count} task${count !== 1 ? 's' : ''} to Outlook Calendar.`);
      setTimeout(() => setSyncResultMessage(null), 5000);
    } catch (e: any) {
      setError(e?.message || 'Failed to sync tasks to Outlook');
    } finally {
      setSyncingToOutlook(false);
    }
  };

  const handleSyncExistingEventsToGoogle = async () => {
    if (!lawFirmId || !settings.loggedInWithGoogle || googleSyncValue === 'none') return;
    try {
      setSyncingEventsToGoogle(true);
      setError(null);
      setSyncEventsResultMessage(null);
      const [{ events }, { events: clientEvents }] = await Promise.all([
        MatterEventsService.listAllEvents(lawFirmId),
        ClientsService.listAllClientEvents(lawFirmId),
      ]);
      const payload = buildExistingEventsPayload(lawFirmId, events, clientEvents, 'googleEventId');
      if (payload.length === 0) {
        setSyncEventsResultMessage('No unsynced events with a date to sync to Google.');
        setTimeout(() => setSyncEventsResultMessage(null), 5000);
        return;
      }
      const result = await GoogleCalendarSync.syncEventsToGoogle(payload);
      const count = result?.syncedCount ?? 0;
      setSyncEventsResultMessage(`Synced ${count} event${count !== 1 ? 's' : ''} to Google Calendar.`);
      setTimeout(() => setSyncEventsResultMessage(null), 5000);
    } catch (e: any) {
      setError(e?.message || 'Failed to sync events to Google');
    } finally {
      setSyncingEventsToGoogle(false);
    }
  };

  const handleSyncExistingEventsToOutlook = async () => {
    if (!lawFirmId || !settings.loggedInWithMicrosoft || outlookSyncValue === 'none') return;
    try {
      setSyncingEventsToOutlook(true);
      setError(null);
      setSyncEventsResultMessage(null);
      const [{ events }, { events: clientEvents }] = await Promise.all([
        MatterEventsService.listAllEvents(lawFirmId),
        ClientsService.listAllClientEvents(lawFirmId),
      ]);
      const payload = buildExistingEventsPayload(lawFirmId, events, clientEvents, 'outlookId');
      if (payload.length === 0) {
        setSyncEventsResultMessage('No unsynced events with a date to sync to Outlook.');
        setTimeout(() => setSyncEventsResultMessage(null), 5000);
        return;
      }
      const result = await OutlookCalendarSync.syncEventsToOutlook(payload);
      const count = result?.syncedCount ?? 0;
      setSyncEventsResultMessage(`Synced ${count} event${count !== 1 ? 's' : ''} to Outlook Calendar.`);
      setTimeout(() => setSyncEventsResultMessage(null), 5000);
    } catch (e: any) {
      setError(e?.message || 'Failed to sync events to Outlook');
    } finally {
      setSyncingEventsToOutlook(false);
    }
  };

  const linkGoogle = async () => {
    try {
      setSaving(true);
      // This redirects the user to Google for OAuth consent. The firm layout
      // reports the outcome when the callback returns here.
      await AuthService.linkGoogle();
    } catch (e: unknown) {
      const msg = getFirebaseErrorMessage(e, 'Failed to connect Google');
      if (msg) setError(msg);
      setSaving(false);
    }
  };

  const linkMicrosoft = async () => {
    try {
      setSaving(true);
      // This redirects the user to Microsoft for OAuth consent. The firm layout
      // reports the outcome when the callback returns here.
      await AuthService.linkMicrosoft();
    } catch (e: unknown) {
      const msg = getFirebaseErrorMessage(e, 'Failed to connect Microsoft');
      if (msg) setError(msg);
      setSaving(false);
    }
  };

  const [disconnectProvider, setDisconnectProvider] = useState<'google' | 'microsoft' | null>(null);
  const [removeCalendarCopies, setRemoveCalendarCopies] = useState(false);

  const unlinkGoogle = async (removeParalegixEvents = false) => {
    try {
      setSaving(true);
      await AuthService.unlinkGoogle({ removeParalegixEvents });
      setDisconnectProvider(null);
      setRemoveCalendarCopies(false);
      setGoogleEmail(undefined);
      setSettings((s) => ({
        ...s,
        googleState: 'disconnected',
        loggedInWithGoogle: false,
        allowParalegixToGoogleSync: false,
        allowGoogleToParalegixSync: false,
      }));
      refreshCalendarConnection();
      setSuccessMessage('Google account disconnected. You can reconnect anytime.');
    } catch (e: any) {
      setError(e?.message || 'Failed to disconnect Google');
    } finally {
      setSaving(false);
    }
  };

  const unlinkMicrosoft = async (removeParalegixEvents = false) => {
    try {
      setSaving(true);
      await AuthService.unlinkMicrosoft({ removeParalegixEvents });
      setDisconnectProvider(null);
      setRemoveCalendarCopies(false);
      setMicrosoftEmail(undefined);
      setSettings((s) => ({
        ...s,
        microsoftState: 'disconnected',
        loggedInWithMicrosoft: false,
        allowParalegixToOutlookSync: false,
        allowOutlookToParalegixSync: false,
      }));
      refreshCalendarConnection();
      setSuccessMessage('Microsoft account disconnected. You can reconnect anytime.');
    } catch (e: any) {
      setError(e?.message || 'Failed to disconnect Microsoft');
    } finally {
      setSaving(false);
    }
  };

  const finishLeaving = (responseData: any) => {
    if (responseData.message === 'Law firm deleted successfully') {
      setSuccessMessage('Law firm deleted successfully');
      setTimeout(() => {
        router.push('/dashboard');
      }, 2000);
    } else {
      router.push('/dashboard');
    }
  };

  // The transfer dialog shows its own busy state and failure, so this lets a
  // refusal reach it rather than the page banner.
  const handleTransferAndLeave = async (newAdminUserId: string) => {
    const responseData = await LawFirmService.leaveLawFirm(lawFirmId, { newAdminUserId });
    finishLeaving(responseData);
  };

  const handleLeaveLawFirm = async () => {
    try {
      setSaving(true);

      const responseData = await LawFirmService.leaveLawFirm(lawFirmId, {});
      finishLeaving(responseData);
    } catch (e: any) {
      // Handle last-admin case: show transfer modal with eligible members
      if (e.code === 'LAST_ADMIN_TRANSFER_REQUIRED') {
        setEligibleMembers(e.eligibleMembers || []);
        setShowLeaveLawFirmModal(false);
        setShowAdminTransferModal(true);
        return;
      }
      console.error('Error leaving law firm:', e);
      setError(e?.message || 'Failed to leave law firm');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteLawFirm = async () => {
    try {
      setSaving(true);

      await LawFirmService.deleteLawFirm(lawFirmId);

      setSuccessMessage('Law firm deleted successfully');
      setTimeout(() => {
        router.push('/dashboard');
      }, 2000);
    } catch (e: any) {
      console.error('Error deleting law firm:', e);
      setError(e?.message || 'Failed to delete law firm');
    } finally {
      setSaving(false);
    }
  };

  const openLawFirmForm = () => {
    if (lawFirm) {
      const seeded = lawFirmFormFrom(lawFirm);
      setLawFirmFormData(seeded);
      setUnlistedStoredState(seeded.state && !normalizeUsStateName(seeded.state) ? seeded.state : null);
    }
    setStateFilledFromZip(false);
    setLawFirmSaveError(null);
    setLawFirmSuccess(null);
    setShowLawFirmForm(true);
  };

  const handleLawFirmZipChange = (zip: string) => {
    const zipState = stateFromZip(zip);
    const fillState = !!zipState && (lawFirmFormData.state === '' || stateFilledFromZip);
    setLawFirmFormData({ ...lawFirmFormData, zip, ...(fillState ? { state: zipState } : {}) });
    if (fillState) setStateFilledFromZip(true);
  };

  const handleUpdateLawFirm = async () => {
    if (!lawFirm) return;

    try {
      setLawFirmSaving(true);
      setLawFirmSaveError(null);
      setLawFirmSuccess(null);

      // Every field goes, and an emptied optional field goes as null so the
      // save clears it rather than leaving the old value in place.
      const updatedLawFirm = await LawFirmService.updateLawFirm(lawFirmId, {
        name: lawFirmFormData.name.trim(),
        description: optionalField(lawFirmFormData.description),
        email: optionalField(lawFirmFormData.email),
        phone: optionalField(lawFirmFormData.phone),
        address: optionalField(lawFirmFormData.address),
        city: optionalField(lawFirmFormData.city),
        state: optionalField(lawFirmFormData.state),
        zip: optionalField(lawFirmFormData.zip),
      });
      // The update answers with the stored row, which carries no signed logo
      // url, so the logo on screen is kept until the refreshed record lands.
      setLawFirm((prev) => ({ ...updatedLawFirm, logoUrl: updatedLawFirm.logoUrl ?? prev?.logoUrl }));
      // The shared record feeds every other page (and this one), so it is
      // re-read before the form closes rather than left stale until a reload.
      await refetchLawFirm();
      setShowLawFirmForm(false);
      setLawFirmSuccess('Law firm information updated successfully!');
      setTimeout(() => setLawFirmSuccess(null), 3000);
    } catch (e) {
      setLawFirmSaveError(e instanceof Error ? e : 'Failed to update law firm information');
    } finally {
      setLawFirmSaving(false);
    }
  };

  const clearLogoCropper = useCallback(() => {
    if (logoCropObjectUrlRef.current) {
      URL.revokeObjectURL(logoCropObjectUrlRef.current);
      logoCropObjectUrlRef.current = null;
    }
    setLogoCropSource(null);
    setLogoCropFileName('');
    if (logoInputRef.current) {
      logoInputRef.current.value = '';
    }
  }, []);

  const uploadLogoFile = useCallback(async (file: File) => {
    try {
      setLogoUploading(true);
      setLogoError(null);
      setSuccessMessage(null);

      // Uploads straight to storage through the service, which shares one
      // uploader with the files and profile-picture paths. The hand-rolled
      // multipart POST that used to live here sent the whole image through the
      // API container.
      const responseData = await LawFirmService.uploadLogo(lawFirmId, file);
      setLawFirm(responseData.lawFirm);
      await refetchLawFirm();
      setSuccessMessage('Logo uploaded successfully!');

      setTimeout(() => {
        setSuccessMessage(null);
      }, 3000);
    } catch (e: any) {
      console.error('Logo upload exception:', e);
      const message = e?.message || 'Failed to upload logo';
      setLogoError(message);
      throw new Error(message);
    } finally {
      setLogoUploading(false);
    }
  }, [lawFirmId, refetchLawFirm]);

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      setLogoError('Invalid file type. Only JPEG, PNG, GIF, and WebP images are allowed.');
      e.target.value = '';
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      setLogoError('File size must be less than 5MB.');
      e.target.value = '';
      return;
    }

    clearLogoCropper();
    setLogoError(null);
    setSuccessMessage(null);

    const objectUrl = URL.createObjectURL(file);
    logoCropObjectUrlRef.current = objectUrl;
    setLogoCropSource(objectUrl);
    setLogoCropFileName(file.name);
    e.target.value = '';
  };

  const handleCroppedLogoUpload = useCallback(async (file: File) => {
    try {
      await uploadLogoFile(file);
      clearLogoCropper();
    } catch {
      // Keep the crop modal open so the user can retry.
    }
  }, [clearLogoCropper, uploadLogoFile]);

  const handleLogoDelete = async () => {
    try {
      setLogoDeleting(true);
      setError(null);
      setSuccessMessage(null);

      const user = await AuthService.getCurrentUser();
      if (!user) {
        throw new Error('User not authenticated');
      }

      const idToken = await user.getIdToken();
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';

      const response = await apiFetch(`${apiUrl}/lawfirms/${lawFirmId}/logo`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${idToken}`,
        },
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to delete logo');
      }

      const responseData = await response.json();
      setLawFirm(responseData.lawFirm);
      await refetchLawFirm();
      setSuccessMessage('Logo deleted successfully!');

      setTimeout(() => {
        setSuccessMessage(null);
      }, 3000);
    } catch (e: any) {
      setError(e?.message || 'Failed to delete logo');
    } finally {
      setLogoDeleting(false);
    }
  };

  const syncDirectionOptions = [
    { value: 'none', label: 'None' },
    { value: 'paralegix-to-outlook', label: 'Send Events to Outlook' },
    { value: 'outlook-to-paralegix', label: 'Import Events from Outlook' },
    { value: 'both', label: 'Two-Way Sync' },
  ];

  const googleSyncDirectionOptions = [
    { value: 'none', label: 'None' },
    { value: 'paralegix-to-google', label: 'Send Events to Google' },
    { value: 'google-to-paralegix', label: 'Import Events from Google' },
    { value: 'both', label: 'Two-Way Sync' },
  ];

  const googleCalendarTargetOptions = [
    { value: 'paralegix', label: 'Separate Paralegix Calendar' },
    { value: 'default', label: 'Your Main Calendar' },
  ];

  const outlookCalendarTargetOptions = [
    { value: 'paralegix', label: 'Separate Paralegix Calendar' },
    { value: 'default', label: 'Your Main Calendar' },
  ];
  
  const outlookSyncValue = getOutlookSyncDirection();
  const googleSyncValue = getGoogleSyncDirection();

  if (isConnectionError) {
    return (
      <ConnectionUnavailable
        onRetry={handleRetryConnection}
        isRetrying={retryingConnection}
      />
    );
  }

  return (
    <div className="p-4 pl-5 md:p-6 pb-8 md:pb-6 min-w-0">
      <div className="mb-5">
        <SectionLabel gap="1">General</SectionLabel>
        <p className="text-sm text-on-surface-secondary">Manage your account preferences and calendar connections.</p>
      </div>

      <ErrorNotification 
        error={error} 
        onClose={() => setError(null)}
        className="mb-6"
      />

      <SuccessNotification message={successMessage} className="mb-6" />

      {features.calendarSync && <RequirePermission
        permission="calendar.sync"
        fallback={(
          <div className="bg-surface rounded-lg border border-outline">
            <div className="px-6 py-5">
              <h2 className="text-lg font-semibold text-on-surface">Calendar Connections</h2>
              <p className="text-sm text-on-surface-secondary mt-1">
                You need <code>calendar.sync</code> permission to manage calendar connections and sync settings.
              </p>
            </div>
          </div>
        )}
      >
        <div className="bg-surface rounded-lg border border-outline">
          <div className="px-6 py-4 border-b border-outline">
            <h2 className="text-lg font-semibold text-on-surface">Calendar Connections</h2>
            <p className="text-sm text-on-surface-secondary">Link your calendar provider and configure sync directions.</p>
          </div>

          <div className="px-6 py-6 space-y-6">
            <CalendarConnectionRow
              label="Google"
              state={settings.googleState}
              email={googleEmail}
              disabled={saving}
              onConnect={linkGoogle}
              onDisconnect={() => setDisconnectProvider('google')}
            />

            <CalendarConnectionRow
              label="Microsoft"
              state={settings.microsoftState}
              email={microsoftEmail}
              disabled={saving}
              onConnect={linkMicrosoft}
              onDisconnect={() => setDisconnectProvider('microsoft')}
            />

            <div className="pt-4 border-t border-outline-subtle space-y-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 max-w-2xl">
                <div>
                  <Dropdown
                    label="Google Calendar Sync"
                    value={googleSyncValue}
                    onChange={handleGoogleSyncChange}
                    options={googleSyncDirectionOptions}
                    disabled={!settings.loggedInWithGoogle || calendarSyncLocked}
                  />

                  {calendarSyncLocked && (
                    <LockIndicator className="mt-2" message="Calendar sync is managed by your firm administrator." />
                  )}
                  {!settings.loggedInWithGoogle && (
                    <div className="text-xs text-on-surface-secondary mt-1">Connect Google to enable sync.</div>
                  )}
                  {settings.loggedInWithGoogle && googleSyncValue !== 'none' && (
                    <div className="mt-3">
                      <Dropdown
                        label="Google Calendar Target"
                        value={settings.googleCalendarTarget ?? 'default'}
                        onChange={handleGoogleCalendarTargetChange}
                        options={googleCalendarTargetOptions}
                        disabled={saving}
                      />
                    </div>
                  )}
                </div>
                <div>
                  <Dropdown
                    label="Outlook Calendar Sync"
                    value={outlookSyncValue}
                    onChange={handleOutlookSyncChange}
                    options={syncDirectionOptions}
                    disabled={!settings.loggedInWithMicrosoft || calendarSyncLocked}
                  />
                  {calendarSyncLocked && (
                    <LockIndicator className="mt-2" message="Calendar sync is managed by your firm administrator." />
                  )}
                  {!settings.loggedInWithMicrosoft && (
                    <div className="text-xs text-on-surface-secondary mt-1">Connect Microsoft to enable sync.</div>
                  )}
                  {settings.loggedInWithMicrosoft && outlookSyncValue !== 'none' && (
                    <div className="mt-3">
                      <Dropdown
                        label="Outlook Calendar Target"
                        value={settings.outlookCalendarTarget ?? 'default'}
                        onChange={handleOutlookCalendarTargetChange}
                        options={outlookCalendarTargetOptions}
                        disabled={saving}
                      />
                    </div>
                  )}
                </div>
              </div>
              {(googleSyncValue !== 'none' || outlookSyncValue !== 'none') && (
                <div className="text-xs text-on-surface-secondary mt-1 space-y-1">
                  <p><strong>Default Calendar</strong> - Syncs tasks to your main calendar (the one you use for everything else). Paralegix events appear alongside your other meetings and events.</p>
                  <p><strong>Paralegix Calendar</strong> - Creates a separate calendar named &quot;Paralegix&quot; and syncs only Paralegix tasks there. You can show or hide it in Google/Outlook to keep work tasks separate from your main schedule.</p>
                </div>
              )}
              {(googleSyncValue !== 'none' || outlookSyncValue !== 'none') && (
                <div className="mt-4 pt-4 border-t border-outline-subtle">
                  <p className="text-sm font-medium text-on-surface mb-2">Sync existing tasks &amp; events</p>
                  <p className="text-xs text-on-surface-secondary mb-3">
                    If you enabled calendar sync after tasks or events were already created, use this to push them to your calendar. Items already synced are skipped so nothing is duplicated.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {googleSyncValue !== 'none' && (
                      <Button
                        type="secondary"
                        size="small"
                        onClick={async () => { await handleSyncExistingToGoogle(); await handleSyncExistingEventsToGoogle(); }}
                        disabled={syncingToGoogle || syncingEventsToGoogle || !settings.loggedInWithGoogle}
                      >
                        {(syncingToGoogle || syncingEventsToGoogle) ? 'Syncing...' : 'Sync to Google Calendar'}
                      </Button>
                    )}
                    {outlookSyncValue !== 'none' && (
                      <Button
                        type="secondary"
                        size="small"
                        onClick={async () => { await handleSyncExistingToOutlook(); await handleSyncExistingEventsToOutlook(); }}
                        disabled={syncingToOutlook || syncingEventsToOutlook || !settings.loggedInWithMicrosoft}
                      >
                        {(syncingToOutlook || syncingEventsToOutlook) ? 'Syncing...' : 'Sync to Outlook Calendar'}
                      </Button>
                    )}
                  </div>
                  {(syncResultMessage || syncEventsResultMessage) && (
                    <div className="mt-2 space-y-0.5">
                      {syncResultMessage && <p className="text-xs text-on-surface-secondary">{syncResultMessage}</p>}
                      {syncEventsResultMessage && <p className="text-xs text-on-surface-secondary">{syncEventsResultMessage}</p>}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </RequirePermission>}

      {/* Personal messaging identity ("send as firm"). */}
      {features.messaging && <PresentAsFirmCard lawFirmId={lawFirmId} />}

      {/* Law Firm Information Section */}
      {canEditFirmInfo && (
        <div className="bg-surface rounded-lg border border-outline mt-4 md:mt-6">
          <div className="px-4 py-4 md:px-6">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold text-on-surface">Law Firm Information</h2>
                <p className="text-sm text-on-surface-secondary mt-1">Update your law firm's contact information for invoices.</p>
              </div>
              <Button
                type="secondary"
                size="small"
                onClick={() => (showLawFirmForm ? setShowLawFirmForm(false) : openLawFirmForm())}
                disabled={lawFirmLoading}
                className="w-full md:w-auto shrink-0"
              >
                {showLawFirmForm ? 'Cancel' : 'Edit Information'}
              </Button>
            </div>
            <SuccessNotification message={lawFirmSuccess} className="mt-3" />
          </div>

          {showLawFirmForm ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleUpdateLawFirm();
              }}
              className="px-4 py-4 md:px-6 md:py-6 space-y-4"
            >
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <FieldLabel htmlFor="lawFirmName">
                    Law Firm Name *
                  </FieldLabel>
                  <input
                    type="text"
                    id="lawFirmName"
                    autoComplete="organization"
                    value={lawFirmFormData.name}
                    onChange={(e) => setLawFirmFormData({ ...lawFirmFormData, name: e.target.value })}
                    className="w-full px-3 py-2 border border-input-border rounded-md bg-input-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                    required
                  />
                </div>

                <div>
                  <FieldLabel htmlFor="lawFirmEmail">
                    Email
                  </FieldLabel>
                  <input
                    type="email"
                    id="lawFirmEmail"
                    autoComplete="email"
                    value={lawFirmFormData.email}
                    onChange={(e) => setLawFirmFormData({ ...lawFirmFormData, email: e.target.value })}
                    className="w-full px-3 py-2 border border-input-border rounded-md bg-input-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  />
                </div>

                <div>
                  <FieldLabel htmlFor="lawFirmPhone">
                    Phone
                  </FieldLabel>
                  <input
                    type="tel"
                    id="lawFirmPhone"
                    autoComplete="tel"
                    value={lawFirmFormData.phone}
                    onChange={(e) => setLawFirmFormData({ ...lawFirmFormData, phone: e.target.value })}
                    className="w-full px-3 py-2 border border-input-border rounded-md bg-input-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  />
                </div>

                <div>
                  <FieldLabel htmlFor="lawFirmDescription">
                    Description
                  </FieldLabel>
                  <input
                    type="text"
                    id="lawFirmDescription"
                    value={lawFirmFormData.description}
                    onChange={(e) => setLawFirmFormData({ ...lawFirmFormData, description: e.target.value })}
                    className="w-full px-3 py-2 border border-input-border rounded-md bg-input-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  />
                </div>

                <div>
                  <FieldLabel htmlFor="lawFirmAddress">
                    Street Address
                  </FieldLabel>
                  <input
                    type="text"
                    id="lawFirmAddress"
                    autoComplete="address-line1"
                    value={lawFirmFormData.address}
                    onChange={(e) => setLawFirmFormData({ ...lawFirmFormData, address: e.target.value })}
                    className="w-full px-3 py-2 border border-input-border rounded-md bg-input-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  />
                </div>

                <div>
                  <FieldLabel htmlFor="lawFirmCity">
                    City
                  </FieldLabel>
                  <input
                    type="text"
                    id="lawFirmCity"
                    autoComplete="address-level2"
                    value={lawFirmFormData.city}
                    onChange={(e) => setLawFirmFormData({ ...lawFirmFormData, city: e.target.value })}
                    className="w-full px-3 py-2 border border-input-border rounded-md bg-input-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  />
                </div>

                <div>
                  <Dropdown
                    label="State"
                    value={lawFirmFormData.state}
                    onChange={(state) => {
                      setLawFirmFormData({ ...lawFirmFormData, state });
                      setStateFilledFromZip(false);
                    }}
                    options={[
                      { label: 'Select a state', value: '' },
                      ...(unlistedStoredState ? [{ label: unlistedStoredState, value: unlistedStoredState }] : []),
                      ...STATE_OPTIONS,
                    ]}
                    ariaDescribedBy={stateFilledFromZip ? stateHintId : undefined}
                  />
                  {stateFilledFromZip && (
                    <p id={stateHintId} className="mt-1 text-xs text-on-surface-muted">Filled in from the ZIP code.</p>
                  )}
                </div>

                <div>
                  <FieldLabel htmlFor="lawFirmZip">
                    ZIP Code
                  </FieldLabel>
                  <input
                    type="text"
                    id="lawFirmZip"
                    autoComplete="postal-code"
                    value={lawFirmFormData.zip}
                    onChange={(e) => handleLawFirmZipChange(e.target.value)}
                    className="w-full px-3 py-2 border border-input-border rounded-md bg-input-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  />
                </div>
              </div>

              <ErrorNotification error={lawFirmSaveError} onClose={() => setLawFirmSaveError(null)} compact />

              <div className="flex justify-end gap-2 pt-4">
                <Button
                  type="secondary"
                  size="small"
                  onClick={() => setShowLawFirmForm(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="primary"
                  size="small"
                  htmlType="submit"
                  disabled={lawFirmSaving || !lawFirmFormData.name.trim()}
                >
                  {lawFirmSaving ? 'Saving...' : 'Save Changes'}
                </Button>
              </div>
            </form>
          ) : (
            <div className="px-4 py-4 md:px-6 md:py-6 border-t border-outline">
              {lawFirmLoading ? (
                <PanelLoadingSpinner label="Loading firm details" />
              ) : lawFirm ? (
                <div className="space-y-2 text-sm">
                  <div><span className="font-medium">Name:</span> {lawFirm.name}</div>
                  {lawFirm.description && <div><span className="font-medium">Description:</span> {lawFirm.description}</div>}
                  {(lawFirm.address || lawFirm.city || lawFirm.state || lawFirm.zip) && (
                    <div>
                      <span className="font-medium">Address:</span>{' '}
                      {[lawFirm.address, lawFirm.city, lawFirm.state, lawFirm.zip].filter(Boolean).join(', ')}
                    </div>
                  )}
                  {lawFirm.phone && <div><span className="font-medium">Phone:</span> {lawFirm.phone}</div>}
                  {lawFirm.email && <div><span className="font-medium">Email:</span> {lawFirm.email}</div>}
                  {!lawFirm.address && !lawFirm.city && !lawFirm.state && !lawFirm.zip && !lawFirm.phone && !lawFirm.email && (
                    <p className="text-on-surface-secondary">No contact information set.</p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-on-surface-secondary">Unable to load law firm information.</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Logo Upload Section */}
      {canManageBranding && (
        <div className="bg-surface rounded-lg border border-outline mt-4 md:mt-6">
          <div className="px-4 py-4 md:px-6 border-b border-outline">
            <h2 className="text-lg font-semibold text-on-surface">Law Firm Logo</h2>
            <p className="text-sm text-on-surface-secondary mt-1">Upload your law firm logo to display on invoices and the dashboard. Recommended size: 200x80 pixels (or similar aspect ratio), and you&apos;ll be able to crop it before saving.</p>
          </div>
          <div className="px-4 py-4 md:px-6 md:py-6">
            <ErrorNotification error={logoError} onClose={() => setLogoError(null)} compact className="mb-4" />
            {lawFirm?.logoUrl ? (
              <div className="space-y-4">
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
                  <div className="border border-outline rounded-lg p-4 bg-surface-alt shrink-0">
                    <Image
                      src={lawFirm.logoUrl}
                      alt="Law firm logo"
                      // Rendered size is bounded by max-h-20/max-w-[200px] (≤200×80).
                      // Keep the intrinsic props larger than that box so neither
                      // rendered dimension can exactly match a prop, which is what
                      // triggers Next's "width or height modified" dev warning.
                      width={400}
                      height={160}
                      unoptimized
                      className="max-h-20 max-w-[200px] object-contain"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm text-on-surface-secondary mb-2">
                      Current logo will appear on all invoices. For best results, use a logo with:
                    </p>
                    <ul className="text-xs text-on-surface-secondary space-y-1 list-disc list-inside mb-4">
                      <li>Recommended dimensions: 200x80 pixels (or similar 2.5:1 aspect ratio)</li>
                      <li>Maximum file size: 5MB</li>
                      <li>Formats: JPEG, PNG, GIF, or WebP</li>
                      <li>Transparent background recommended</li>
                    </ul>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <input
                    ref={logoInputRef}
                    type="file"
                    accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
                    onChange={handleLogoUpload}
                    disabled={logoUploading}
                    className="hidden"
                  />
                  <Button
                    type="secondary"
                    size="small"
                    disabled={logoUploading}
                    onClick={() => logoInputRef.current?.click()}
                    className="flex-1 min-w-[120px] md:flex-initial md:min-w-0"
                  >
                    {logoUploading ? 'Uploading...' : 'Replace Logo'}
                  </Button>
                  <Button
                    type="secondary"
                    size="small"
                    onClick={() => setShowDeleteLogoModal(true)}
                    disabled={logoDeleting}
                    className="flex-1 min-w-[120px] md:flex-initial md:min-w-0 text-red-600 border-red-300 hover:bg-red-50 dark:text-red-400 dark:border-red-500/30 dark:hover:bg-red-500/10"
                  >
                    {logoDeleting ? 'Deleting...' : 'Delete Logo'}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="border-2 border-dashed border-outline rounded-lg p-6 md:p-8 text-center">
                  <svg className="mx-auto h-10 w-10 md:h-12 md:w-12 text-on-surface-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <p className="mt-2 text-sm text-on-surface-secondary">No logo uploaded</p>
                </div>
                <div>
                  <p className="text-sm text-on-surface-secondary mb-2">
                    For best results, use a logo with:
                  </p>
                  <ul className="text-xs text-on-surface-secondary space-y-1 list-disc list-inside mb-4">
                    <li>Recommended dimensions: 200x80 pixels (or similar 2.5:1 aspect ratio)</li>
                    <li>Maximum file size: 5MB</li>
                    <li>Formats: JPEG, PNG, GIF, or WebP</li>
                    <li>Transparent background recommended</li>
                  </ul>
                </div>
                <input
                  ref={logoInputRef}
                  type="file"
                  accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
                  onChange={handleLogoUpload}
                  disabled={logoUploading}
                  className="hidden"
                />
                <Button
                  type="primary"
                  size="small"
                  disabled={logoUploading}
                  onClick={() => logoInputRef.current?.click()}
                  className="w-full md:w-auto"
                >
                  {logoUploading ? 'Uploading...' : 'Upload Logo'}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Your profile, data export, and account deletion are per-user, not
          per-firm, so they live on /account - reachable even without a firm. */}
      <div className="bg-surface rounded-lg border border-outline mt-4 md:mt-6">
        <div className="px-4 py-4 md:px-6 md:py-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-on-surface">Your Account</h2>
            <p className="text-sm text-on-surface-secondary mt-1">
              Profile picture, name, data export, and account deletion.
            </p>
          </div>
          <Button
            type="secondary"
            size="compact"
            onClick={() => navigate('/account')}
          >
            Account Settings
            <ChevronRight size={14} strokeWidth={2} />
          </Button>
        </div>
      </div>

      {/* Leave Law Firm Section */}
      <div className="bg-surface rounded-lg border border-outline mt-4 md:mt-6">
        <div className="px-4 py-4 md:px-6 md:py-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <div className="text-sm font-medium text-on-surface">Leave Law Firm</div>
              <div className="text-xs text-on-surface-secondary mt-1">
                You will lose access to all matters, tasks, and files in this law firm.
              </div>
            </div>
            <Button 
              type="secondary" 
              size="small" 
              onClick={() => setShowLeaveLawFirmModal(true)}
              disabled={saving}
              className="w-full md:w-auto shrink-0 text-red-600 border-red-300 hover:bg-red-50 dark:text-red-400 dark:border-red-500/30 dark:hover:bg-red-500/10"
            >
              Leave Law Firm
            </Button>
          </div>
        </div>
      </div>

      {/* Delete Law Firm Section */}
      {canDeleteLawFirm && (
        <div className="bg-surface rounded-lg border border-red-200 dark:border-red-500/30 mt-4 md:mt-6">
          <div className="px-4 py-4 md:px-6 md:py-6">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0">
                <div className="text-sm font-medium text-red-600 dark:text-red-400">Delete Law Firm</div>
                <div className="text-xs mt-1 text-red-500 dark:text-red-400/70">
                  This revokes access for every member and stops billing immediately. Matters, tasks, files, and
                  signed documents are retained for the legal retention period before being permanently deleted.
                </div>
              </div>
              <Button
                type="secondary"
                size="small"
                onClick={() => setShowDeleteLawFirmModal(true)}
                disabled={saving}
                className="w-full md:w-auto shrink-0 text-red-600 border-red-300 hover:bg-red-50 dark:text-red-400 dark:border-red-500/30 dark:hover:bg-red-500/10"
              >
                Delete Law Firm
              </Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        isOpen={!!disconnectProvider}
        onClose={() => { setDisconnectProvider(null); setRemoveCalendarCopies(false); }}
        onConfirm={() => disconnectProvider === 'google' ? unlinkGoogle(removeCalendarCopies) : unlinkMicrosoft(removeCalendarCopies)}
        title="Disconnect calendar"
        message="Disconnecting stops calendar sync. You can also remove the calendar copies created by Paralegix."
        confirmText="Disconnect"
        loading={saving}
        extra={<Checkbox checked={removeCalendarCopies} onChange={setRemoveCalendarCopies} label="Remove Paralegix events from this calendar" />}
      />
      <ConfirmModal
        isOpen={showDeleteLogoModal}
        onClose={() => setShowDeleteLogoModal(false)}
        onConfirm={handleLogoDelete}
        title="Delete Logo"
        message="Are you sure you want to delete the logo? This action cannot be undone."
        confirmText="Delete Logo"
      />

      <ConfirmModal
        isOpen={showLeaveLawFirmModal}
        onClose={() => setShowLeaveLawFirmModal(false)}
        onConfirm={() => handleLeaveLawFirm()}
        title="Leave Law Firm"
        message="Are you sure you want to leave this law firm? You will lose access to all matters, tasks, and files. This action cannot be undone."
        confirmText="Leave Law Firm"
      />

      <AdminTransferModal
        isOpen={showAdminTransferModal}
        onClose={() => setShowAdminTransferModal(false)}
        onConfirm={handleTransferAndLeave}
        eligibleMembers={eligibleMembers}
      />

      <LogoCropModal
        isOpen={!!logoCropSource}
        imageSrc={logoCropSource}
        fileName={logoCropFileName}
        loading={logoUploading}
        onClose={clearLogoCropper}
        onConfirm={handleCroppedLogoUpload}
      />

      <ConfirmModal
        isOpen={showDeleteLawFirmModal}
        onClose={() => setShowDeleteLawFirmModal(false)}
        onConfirm={handleDeleteLawFirm}
        title="Delete Law Firm"
        message="Are you sure you want to delete this law firm? Every member loses access and billing stops immediately. Matters, tasks, files, and signed documents are retained for the legal retention period, then permanently deleted."
        confirmText="Delete Law Firm"
      />
    </div>
  );
}
