"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Settings, Briefcase } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import { useMountTransition } from "@/hooks/useMountTransition";
import { menuAnim } from "@/components/ui/transitionClasses";
import ToggleSwitch from "@/components/ui/ToggleSwitch";
import ErrorNotification from "@/components/ErrorNotification";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { Avatar } from "@/components/ui/Avatar";
import messagesService from "@/services/messages.service";
import userService from "@/services/users.service";
import { useLawFirm } from "@/contexts/LawFirmContext";
import { useAuth } from "@/hooks/useAuth";
import GroupMattersModal, { type GroupClient } from "./GroupMattersModal";

interface MessagingSettingsMenuProps {
  lawFirmId: string;
  conversationId: string;
  // Whether this is a group thread. Group-only sections (matter scope, per-
  // conversation client-name privacy) are hidden on direct threads; the personal
  // "send as firm" identity toggle shows on every thread.
  isGroup: boolean;
  matterIds: string[];
  // Client participants of this conversation, so the matter picker can flag
  // matters that don't include them and offer to add them.
  groupClients: GroupClient[];
  // Current per-conversation "hide client names" setting.
  hideClientNames: boolean;
  onChanged: () => void;
}

// Inline settings for a conversation, reachable from the header gear. Always
// offers the firm member's personal "send as firm" messaging identity; for group
// threads it also holds the matter scope (a searchable picker) and the per-
// conversation client-name privacy toggle. Only rendered for firm members who can
// send (messaging.send), so no per-section permission gating is needed here.
export default function MessagingSettingsMenu({
  lawFirmId,
  conversationId,
  isGroup,
  matterIds,
  groupClients,
  hideClientNames,
  onChanged,
}: MessagingSettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const [mattersOpen, setMattersOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Local mirror so the switch flips instantly; re-synced when the prop changes
  // after the parent refetch.
  const [hidden, setHidden] = useState(hideClientNames);
  // Personal "send as firm" preference (members.present_as_firm). Global to the
  // member, so it's loaded lazily the first time the menu opens rather than on
  // every conversation view. `null` = not loaded yet.
  const [presentAsFirm, setPresentAsFirm] = useState<boolean | null>(null);
  const [pafSaving, setPafSaving] = useState(false);
  // The member's own profile photo + name, loaded lazily alongside the preference
  // so the "send as yourself" preview shows their real avatar and name (not just
  // initials or a generic "You").
  const [memberPhotoUrl, setMemberPhotoUrl] = useState<string | null>(null);
  const [memberProfileName, setMemberProfileName] = useState<string | null>(null);
  const [memberProfileEmail, setMemberProfileEmail] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Whether there's more room above the trigger than below it, so the panel
  // (up to max-h-[70vh]) opens on whichever side isn't about to run it off
  // the bottom of the viewport.
  const [openUp, setOpenUp] = useState(false);
  // Guards the one-time lazy load below so it fires once per menu-open without
  // depending on `presentAsFirm` in the effect deps (which would tear the effect
  // down mid-flight the moment presentAsFirm is set, discarding the profile fetch).
  const loadedRef = useRef(false);

  // Firm branding + the member's own identity, used to preview how a sent message
  // will appear to a client depending on the toggle.
  const { lawFirm } = useLawFirm();
  const { user } = useAuth();
  const firmName = lawFirm?.name || "Your firm";
  const firmLogoUrl = lawFirm?.logoUrl || null;
  const memberName = memberProfileName || user?.displayName || memberProfileEmail || "You";

  const { mounted, exiting } = useMountTransition(open, 150);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mirror the prop into local state so the switch flips instantly, re-synced on prop change
    setHidden(hideClientNames);
  }, [hideClientNames]);

  // Lazily load the member's "send as firm" preference + their own profile the
  // first time the menu opens. Depends only on [open, lawFirmId] (NOT
  // presentAsFirm) so setting presentAsFirm below doesn't re-run/cleanup this
  // effect and abort the still-pending getProfile call. loadedRef makes it fire
  // once per open; closing the menu resets it.
  useEffect(() => {
    if (!open) { loadedRef.current = false; return; }
    if (loadedRef.current) return;
    loadedRef.current = true;
    let active = true;
    (async () => {
      try {
        const { presentAsFirm: value } = await messagesService.getPresentAsFirm(lawFirmId);
        if (active) setPresentAsFirm(!!value);
      } catch {
        // Fall back to off; the toggle stays usable and a save can still fix it.
        if (active) setPresentAsFirm(false);
      }
      try {
        const profile = await userService.getProfile();
        if (active) {
          setMemberPhotoUrl(profile.photoUrl ?? null);
          setMemberProfileName(profile.name || null);
          setMemberProfileEmail(profile.email || null);
        }
      } catch {
        // The preview just falls back to initials/"You" if the profile can't load.
      }
    })();
    return () => { active = false; };
  }, [open, lawFirmId]);

  // Decide below-vs-above when the menu opens: prefer below (natural reading
  // order), but flip above the trigger when there isn't room below for the
  // (up to 70vh) panel and there's more room above than below. Runs before
  // paint so there's no visible jump.
  useLayoutEffect(() => {
    if (!open || !containerRef.current) return;
    const r = containerRef.current.getBoundingClientRect();
    const vh = window.innerHeight;
    const spaceBelow = vh - r.bottom;
    const spaceAbove = r.top;
    setOpenUp(spaceBelow < Math.min(vh * 0.7, 300) && spaceAbove > spaceBelow);
  }, [open]);

  // Close on outside click / Escape while the menu is open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = async () => {
    if (saving) return;
    const next = !hidden;
    setHidden(next);
    try {
      setSaving(true);
      setError(null);
      await messagesService.setGroupPrivacy(lawFirmId, conversationId, next);
      onChanged();
    } catch (err) {
      setHidden(!next);
      setError(getErrorMessage(err, "Failed to update messaging privacy."));
    } finally {
      setSaving(false);
    }
  };

  const togglePresentAsFirm = async () => {
    if (pafSaving || presentAsFirm === null) return;
    const next = !presentAsFirm;
    setPresentAsFirm(next);
    try {
      setPafSaving(true);
      setError(null);
      await messagesService.setPresentAsFirm(lawFirmId, next);
    } catch (err) {
      setPresentAsFirm(!next);
      setError(getErrorMessage(err, "Failed to update messaging identity."));
    } finally {
      setPafSaving(false);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <Tooltip title="Conversation settings" enterDelay={300}>
        <button aria-label="Conversation settings"
          type="button"
          onClick={() => setOpen((s) => !s)}
          aria-haspopup="menu"
          aria-expanded={open}
          className={`inline-flex items-center justify-center h-8 w-8 rounded-full transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer ${
            open
              ? "bg-surface-hover text-on-surface"
              : "text-on-surface-secondary hover:text-on-surface hover:bg-surface-hover"
          }`}
        >
          <Settings size={16} />
        </button>
      </Tooltip>

      {mounted && (
        <div
          role="menu"
          className={`absolute right-0 z-50 w-80 max-h-[70vh] overflow-y-auto overflow-x-hidden styled-scrollbar rounded-lg border border-outline bg-surface shadow-xl ${
            openUp ? "bottom-full mb-2 origin-bottom-right" : "top-full mt-2 origin-top-right"
          } ${menuAnim(exiting)}`}
        >
          <div className="px-4 py-3 border-b border-outline">
            <p className="text-sm font-semibold text-on-surface">Conversation settings</p>
          </div>

          {error && (
            <div className="px-4 pt-3">
              <ErrorNotification error={error} onClose={() => setError(null)} compact />
            </div>
          )}

          {/* Personal "send as firm" messaging identity. Available on every thread
              (direct + group); global to the member, not per conversation. */}
          <div className={`px-4 py-3 ${isGroup ? "border-b border-outline" : ""}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-on-surface">Message clients as the firm</p>
                <p className="text-xs text-on-surface-muted mt-0.5">
                  Your team still sees you. Applies to all your conversations.
                </p>
              </div>
              <ToggleSwitch
                checked={presentAsFirm ?? false}
                onChange={togglePresentAsFirm}
                disabled={presentAsFirm === null || pafSaving}
                ariaLabel="Message clients as the firm"
              />
            </div>

            {/* Who a client sees as the sender, flipping with the toggle. The
                only question the toggle raises is whose name and picture ends up
                on the message, so it is answered on one line rather than by a
                mock thread - firm logos are wordmarks, hence the contain fit. */}
            <div className="mt-2 flex items-center gap-2 text-xs text-on-surface-muted">
              <span className="shrink-0">Clients see</span>
              <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-outline-subtle bg-surface-alt px-1.5 py-0.5">
                <Avatar
                  size="xs"
                  photoUrl={presentAsFirm ? firmLogoUrl : memberPhotoUrl}
                  name={presentAsFirm ? firmName : memberName}
                  email={presentAsFirm ? undefined : memberProfileEmail ?? undefined}
                  fit={presentAsFirm ? 'contain' : 'cover'}
                />
                <span className="truncate text-on-surface-secondary">
                  {presentAsFirm ? firmName : memberName}
                </span>
              </span>
            </div>
          </div>

          {/* Group-only: matter scope - opens a searchable picker. */}
          {isGroup && (
            <div className="px-4 py-3 border-b border-outline">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-on-surface">Matter scope</p>
                  <p className="text-xs text-on-surface-muted mt-0.5">
                    {matterIds.length === 0
                      ? "Not linked to any matter"
                      : `${matterIds.length} matter${matterIds.length !== 1 ? "s" : ""} linked`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => { setOpen(false); setMattersOpen(true); }}
                  className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-outline-subtle bg-surface px-2.5 py-1.5 text-xs font-medium text-on-surface hover:bg-surface-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                >
                  <Briefcase size={13} /> Manage
                </button>
              </div>
            </div>
          )}

          {/* Group-only: per-conversation client-name privacy. */}
          {isGroup && (
            <div className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-on-surface">
                    Hide client names from other clients
                  </p>
                  <p className="text-xs text-on-surface-muted mt-0.5">
                    Here, clients see each other as &quot;Client&quot;. Your team sees real names.
                  </p>
                </div>
                <ToggleSwitch
                  checked={hidden}
                  onChange={toggle}
                  disabled={saving}
                  ariaLabel="Hide client names from other clients"
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Rendered outside the popover so it stays open after the popover closes.
          Group-only: direct threads have no matter-scope picker. */}
      {isGroup && (
        <GroupMattersModal
          open={mattersOpen}
          onClose={() => setMattersOpen(false)}
          lawFirmId={lawFirmId}
          conversationId={conversationId}
          matterIds={matterIds}
          groupClients={groupClients}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}
