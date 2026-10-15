"use client";

import { useCallback, useState } from "react";
import { useParams } from "next/navigation";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  sortableKeyboardCoordinates,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Eye, EyeOff, GripVertical } from "lucide-react";
import { usePreferences } from "@/contexts/PreferencesContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useFirmSettings } from "@/contexts/FirmSettingsContext";
import ErrorNotification from "@/components/ErrorNotification";
import LockIndicator from "@/components/ui/LockIndicator";
import RequirePermission from "@/components/ui/RequirePermission";
import ThemeSelector from "@/components/ui/ThemeSelector";
import AdminLockSettings from "@/components/settingsComp/AdminLockSettings";
import settingsService from "@/services/settings.service";
import SectionLabel from "@/components/ui/SectionLabel";
import type {
  SidebarItem,
  SidebarItemKey,
  SidebarPreferences,
  ThemePreference,
} from "@/types/preferences";
import {
  SIDEBAR_ITEM_LABELS,
  SIDEBAR_FEATURE_REQUIREMENTS,
  DEFAULT_SIDEBAR_PREFERENCES,
} from "@/types/preferences";

// Each sidebar row as a dnd-kit sortable node. The grip is the only drag
// surface (attributes/listeners stay off the row itself) so clicking the
// visibility toggle or the row's own text never starts a drag.
function SortableSidebarRow({
  id,
  disabled,
  children,
}: {
  id: string;
  disabled: boolean;
  children: (dragHandleProps: { attributes: any; listeners: any }) => React.ReactNode;
}) {
  const { setNodeRef, transform, transition, isDragging, attributes, listeners } = useSortable({
    id,
    disabled,
  });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={`relative ${isDragging ? "z-10 opacity-90 shadow-lg" : ""}`}
    >
      {children({ attributes, listeners })}
    </div>
  );
}

export default function CustomizationPage() {
  const params = useParams();
  const lawFirmId = Array.isArray(params?.lawFirmId)
    ? params.lawFirmId[0]
    : (params?.lawFirmId as string);

  const { sidebar, theme, updateSidebarPreferences, updateTheme, loading: preferencesLoading } = usePreferences();
  const { hasPermission } = usePermissions();
  const { settings: firmSettings, isLocked, features, refresh: refreshFirmSettings } = useFirmSettings();
  // The sidebar is persisted through PUT /settings/firm, which the backend gates
  // on `settings.manageFirm`. Both permissions are required here so the page
  // never offers a control the server answers with a 403.
  const canManageSidebar =
    hasPermission("firm.managePreferences") && hasPermission("settings.manageFirm");
  const canManageLocked = hasPermission("settings.manageLocked");
  const themeLocked = isLocked("theme");
  const sidebarLocked = isLocked("sidebar");
  // A locked theme binds administrators too: the backend rejects a write to any
  // locked key regardless of permission, so leaving this selector live for an
  // admin produced a control that changed nothing. Admins set the firm-wide
  // value in Admin-Locked Settings below instead.
  const canEditTheme = !themeLocked;
  const canEditSidebar = canManageSidebar && (!sidebarLocked || canManageLocked);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [updatingLockKey, setUpdatingLockKey] = useState<string | null>(null);
  const sidebarDragSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleToggleLock = useCallback(
    async (key: string, locked: boolean) => {
      if (!canManageLocked) return;
      try {
        setUpdatingLockKey(key);
        setError(null);
        if (!locked) {
          await settingsService.unlockSetting(lawFirmId, key);
        } else {
          const nextValue =
            key === "theme"
              ? (firmSettings.lockedSettings?.theme ?? theme)
              : key === "sidebar"
                ? firmSettings.sidebar
                : (firmSettings.lockedSettings?.[key] ?? null);
          await settingsService.lockSetting(lawFirmId, key, nextValue);
        }
        await refreshFirmSettings();
      } catch (e: any) {
        setError(e?.message || "Failed to update setting lock");
      } finally {
        setUpdatingLockKey(null);
      }
    },
    [canManageLocked, firmSettings.lockedSettings, firmSettings.sidebar, lawFirmId, refreshFirmSettings, theme],
  );

  const handleChangeLockedValue = useCallback(
    async (key: string, value: unknown) => {
      if (!canManageLocked) return;
      try {
        setUpdatingLockKey(key);
        setError(null);
        await settingsService.lockSetting(lawFirmId, key, value);
        await refreshFirmSettings();
      } catch (e: any) {
        setError(e?.message || "Failed to update locked setting");
      } finally {
        setUpdatingLockKey(null);
      }
    },
    [canManageLocked, lawFirmId, refreshFirmSettings],
  );

  const handleChangeTheme = async (nextTheme: ThemePreference) => {
    if (!canEditTheme) return;
    setError(null);
    try {
      await updateTheme(nextTheme);
    } catch (e: any) {
      setError(e?.message || "Failed to update theme");
    }
  };

  // Single write path for every sidebar edit on this page. While the sidebar is
  // locked, an admin's edits have to land on the locked value, because that is
  // what members (and this page) read back; the firm sidebar is written too so
  // unlocking keeps the layout the admin just built rather than reverting to
  // whatever was stored when the lock went on.
  const saveSidebar = async (next: SidebarPreferences) => {
    if (!sidebarLocked) {
      await updateSidebarPreferences(next);
      return;
    }
    await settingsService.updateFirmSettings(lawFirmId, { sidebar: next });
    await settingsService.lockSetting(lawFirmId, "sidebar", next);
    await refreshFirmSettings();
  };

  const handleToggleSidebarItem = async (key: SidebarItemKey) => {
    if (!canEditSidebar) return;
    setSaving(true);
    setError(null);
    try {
      const updated: SidebarItem[] = sidebar.items.map((item) =>
        item.key === key ? { ...item, visible: !item.visible } : item
      );
      await saveSidebar({ items: updated });
    } catch (e: any) {
      setError(e?.message || "Failed to update sidebar");
    } finally {
      setSaving(false);
    }
  };

  const handleSidebarDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!canEditSidebar || !over || active.id === over.id) return;
    // Looked up by key rather than the filtered render's index, so a
    // feature-gated item sitting elsewhere in the real list never throws off
    // which two items actually swap.
    const oldIndex = sidebar.items.findIndex((item) => item.key === active.id);
    const newIndex = sidebar.items.findIndex((item) => item.key === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    setSaving(true);
    setError(null);
    try {
      const updated = arrayMove(sidebar.items, oldIndex, newIndex);
      await saveSidebar({ items: updated });
    } catch (e: any) {
      setError(e?.message || "Failed to reorder sidebar");
    } finally {
      setSaving(false);
    }
  };

  const handleResetSidebar = async () => {
    if (!canEditSidebar) return;
    setSaving(true);
    setError(null);
    try {
      await saveSidebar(DEFAULT_SIDEBAR_PREFERENCES);
    } catch (e: any) {
      setError(e?.message || "Failed to reset sidebar");
    } finally {
      setSaving(false);
    }
  };

  if (!lawFirmId) return null;

  const visibleSidebarItems = sidebar.items.filter((item) => {
    const requiredFeature = SIDEBAR_FEATURE_REQUIREMENTS[item.key];
    return !requiredFeature || features[requiredFeature];
  });

  return (
    <div className="p-6">
      <div className="mb-5">
        <SectionLabel gap="1">
          Customization
        </SectionLabel>
        <p className="text-sm text-on-surface-secondary">
          Theme, sidebar visibility, and dashboard widget preferences.
        </p>
      </div>

      <ErrorNotification error={error} onClose={() => setError(null)} className="mb-6" />

      {/* Appearance / Theme */}
      <div className="mt-6">
        <div className="flex items-center gap-2 mb-1">
          <p className="text-xs font-semibold text-on-surface">Appearance</p>
          {themeLocked && (
            <LockIndicator
              message={
                canManageLocked
                  ? "Locked firm-wide. Change the value in Admin-Locked Settings below."
                  : "This setting is managed by your firm administrator."
              }
            />
          )}
        </div>
        <p className="text-sm text-on-surface-secondary mb-3">
          {themeLocked
            ? "Your firm administrator has set one theme for every member."
            : "Choose your preferred color theme. This setting is personal and does not affect other team members."}
        </p>
        <ThemeSelector
          value={theme}
          onChange={handleChangeTheme}
          disabled={!canEditTheme || preferencesLoading}
        />
      </div>

      {/* Sidebar Configuration */}
      <div className="mt-6">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <p className="text-xs font-semibold text-on-surface">Sidebar Navigation</p>
            {sidebarLocked && !canManageLocked && <LockIndicator />}
          </div>
          {canEditSidebar && (
            <button
              onClick={handleResetSidebar}
              disabled={saving || preferencesLoading}
              className="text-xs text-accent-emphasis hover:text-accent-emphasis-hover font-medium transition-colors cursor-pointer disabled:opacity-50"
            >
              Reset to default
            </button>
          )}
        </div>

        {!canManageSidebar && (
          <div className="flex items-center gap-2 mb-4 px-3 py-2.5 bg-amber-50 dark:bg-amber-500/10 border border-amber-100 dark:border-amber-500/30 rounded-xl">
            <p className="text-xs text-amber-700 dark:text-amber-400">
              You need <code>firm.managePreferences</code> and <code>settings.manageFirm</code> to
              modify sidebar settings.
            </p>
          </div>
        )}
        {canManageSidebar && sidebarLocked && (
          <div className="flex items-center gap-2 mb-4 px-3 py-2.5 bg-amber-50 dark:bg-amber-500/10 border border-amber-100 dark:border-amber-500/30 rounded-xl">
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {canManageLocked
                ? "Sidebar preferences are locked firm-wide. Changes you make here update the layout every member sees."
                : "Sidebar preferences are locked by an administrator."}
            </p>
          </div>
        )}

        <div className="rounded-xl border border-outline bg-surface overflow-hidden divide-y divide-outline-subtle">
          <DndContext
            sensors={sidebarDragSensors}
            collisionDetection={closestCenter}
            onDragEnd={handleSidebarDragEnd}
          >
            <SortableContext
              items={visibleSidebarItems.map((item) => item.key)}
              strategy={verticalListSortingStrategy}
            >
              {visibleSidebarItems.map((item) => (
                <SortableSidebarRow key={item.key} id={item.key} disabled={!canEditSidebar || saving || preferencesLoading}>
                  {({ attributes, listeners }) => (
                    <div className="flex items-center gap-3 bg-surface px-4 py-3 hover:bg-surface-hover transition-colors">
                      {canEditSidebar && (
                        <button
                          {...attributes}
                          {...listeners}
                          disabled={saving || preferencesLoading}
                          aria-label={`Drag to reorder ${SIDEBAR_ITEM_LABELS[item.key] || item.key}`}
                          className="shrink-0 rounded-md p-1 text-on-surface-muted transition-colors hover:bg-surface-hover hover:text-on-surface-secondary cursor-grab active:cursor-grabbing disabled:opacity-40 disabled:cursor-not-allowed touch-none"
                        >
                          <GripVertical size={16} />
                        </button>
                      )}
                      <span
                        className={`flex-1 text-sm font-medium ${
                          item.visible ? "text-on-surface" : "text-on-surface-muted"
                        }`}
                      >
                        {SIDEBAR_ITEM_LABELS[item.key] || item.key}
                      </span>
                      {canEditSidebar ? (
                        <button
                          onClick={() => handleToggleSidebarItem(item.key)}
                          disabled={saving || preferencesLoading}
                          className={`p-1.5 rounded-lg transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer disabled:opacity-50 ${
                            item.visible
                              ? "text-accent-emphasis hover:bg-accent-active-hover"
                              : "text-on-surface-muted hover:bg-surface-hover"
                          }`}
                        >
                          {item.visible ? <Eye size={16} /> : <EyeOff size={16} />}
                        </button>
                      ) : (
                        <span
                          className={`p-1.5 ${
                            item.visible ? "text-accent-emphasis" : "text-on-surface-muted"
                          }`}
                        >
                          {item.visible ? <Eye size={16} /> : <EyeOff size={16} />}
                        </span>
                      )}
                    </div>
                  )}
                </SortableSidebarRow>
              ))}
            </SortableContext>
          </DndContext>
        </div>
        <p className="text-[11px] text-on-surface-muted mt-2 px-1">
          The Settings item is always visible and cannot be hidden.
          {saving && <span className="ml-2 text-accent-emphasis">Saving...</span>}
        </p>
      </div>

      {/* Dashboard Widgets Info */}
      <div className="mt-6">
        <p className="text-xs font-semibold text-on-surface mb-1">Dashboard Widgets</p>
        <p className="text-sm text-on-surface-secondary">
          Each user can customize their own dashboard layout using the{" "}
          <span className="font-medium text-on-surface-secondary">customize button</span> on the dashboard page.
          Dashboard preferences are personal and do not affect other team members.
        </p>
      </div>

      {/* Admin-Locked Settings - only firm admins with settings.manageLocked see this */}
      <RequirePermission permission="settings.manageLocked">
        <div className="mt-6 bg-surface rounded-lg border border-outline">
          <div className="px-6 py-4 border-b border-outline">
            <h2 className="text-lg font-semibold text-on-surface">Admin-Locked Settings</h2>
            <p className="text-sm text-on-surface-secondary">
              Force a firm-wide value for a setting below. Once locked, members can no longer change it
              themselves, and only an administrator can update it here.
            </p>
          </div>
          <div className="px-6 py-6">
            <AdminLockSettings
              locks={firmSettings.locks || {}}
              lockedSettings={firmSettings.lockedSettings || {}}
              updatingKey={updatingLockKey}
              onToggleLock={handleToggleLock}
              onChangeLockedValue={handleChangeLockedValue}
            />
          </div>
        </div>
      </RequirePermission>
    </div>
  );
}
