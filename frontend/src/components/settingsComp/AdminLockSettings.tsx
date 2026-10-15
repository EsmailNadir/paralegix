"use client";

import Dropdown, { type DropdownOption } from "@/components/ui/Dropdown";

type LockableSetting = {
  key: string;
  title: string;
  description: string;
  valueOptions?: DropdownOption[];
};

const LOCKABLE_SETTINGS: LockableSetting[] = [
  {
    key: "theme",
    title: "Theme",
    description:
      "When on, every member uses the theme you set below. Members can no longer choose light, dark, or system themselves.",
    valueOptions: [
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
      { value: "system", label: "System" },
    ],
  },
  {
    key: "sidebar",
    title: "Sidebar Preferences",
    description:
      "The sidebar layout is firm-wide, not personal. When on, only an administrator can reorder or hide its items.",
  },
];

export default function AdminLockSettings({
  locks,
  lockedSettings,
  disabled = false,
  updatingKey,
  onToggleLock,
  onChangeLockedValue,
}: {
  locks: Record<string, boolean>;
  lockedSettings: Record<string, unknown>;
  disabled?: boolean;
  updatingKey?: string | null;
  onToggleLock: (key: string, locked: boolean) => Promise<void>;
  onChangeLockedValue: (key: string, value: unknown) => Promise<void>;
}) {
  return (
    <div className="rounded-xl border border-outline divide-y divide-outline-subtle overflow-hidden">
      {LOCKABLE_SETTINGS.map((setting) => {
        const isLocked = !!locks?.[setting.key];
        const isUpdating = updatingKey === setting.key;
        return (
          <div key={setting.key} className="px-4 py-3 bg-surface space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-on-surface">{setting.title}</p>
                <p className="text-xs text-on-surface-secondary mt-1">{setting.description}</p>
              </div>
              <button
                type="button"
                onClick={() => onToggleLock(setting.key, !isLocked)}
                disabled={disabled || isUpdating}
                aria-pressed={isLocked}
                className={[
                  "relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer",
                  isLocked ? "bg-accent-solid" : "bg-surface-alt border border-outline",
                ].join(" ")}
              >
                <span
                  className={[
                    "inline-block h-4 w-4 transform rounded-full bg-accent-foreground transition-transform",
                    isLocked ? "translate-x-6" : "translate-x-1",
                  ].join(" ")}
                />
              </button>
            </div>

            {isLocked && setting.valueOptions && (
              <div className="max-w-xs">
                <Dropdown
                  label="Locked Value"
                  value={String(lockedSettings?.[setting.key] ?? "system")}
                  options={setting.valueOptions}
                  disabled={disabled || isUpdating}
                  onChange={(value) => onChangeLockedValue(setting.key, value)}
                  portal
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
