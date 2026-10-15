"use client";

import { FIELD_LABEL_BLOCK_CLS, FULL_INPUT_CLS } from "@/components/ui/inputClasses";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link2, Copy, Check, Lock, Clock, Trash2, Files } from "lucide-react";
import FilesService, { type ShareLink, type ShareLinkPermission } from "@/services/files.service";
import Button from "@/components/ui/Button";
import Dropdown from "@/components/ui/Dropdown";
import ErrorNotification from "@/components/ErrorNotification";
import Modal from "@/components/ui/Modal";
import ConfirmModal from "@/components/ui/ConfirmModal";
import Tooltip from "@/components/ui/Tooltip";
import { useLastOpenValue } from "@/hooks/useMountTransition";
import { getErrorMessage } from "@/lib/utils/apiErrors";

/** One file or folder the link is being made for. */
export interface ShareLinkItem {
  fileId: string;
  name: string;
  isFolder: boolean;
}

interface ShareLinkModalProps {
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
  /** What the link will share: one item, or a selection. Every selection gets ONE link. */
  items: ShareLinkItem[];
}

const INPUT_CLASS = FULL_INPUT_CLS;
const LABEL_CLASS = FIELD_LABEL_BLOCK_CLS;

// Expiry choices map to the backend's expiresInHours integer.
const EXPIRY_OPTIONS = [
  { label: "1 hour", value: "1" },
  { label: "24 hours", value: "24" },
  { label: "7 days", value: "168" },
  { label: "30 days", value: "720" },
];
const DEFAULT_EXPIRY = "168";

const PERMISSION_OPTIONS = [
  { label: "Download", value: "download" },
  { label: "View only", value: "view" },
];

/** Human-readable expiry for an existing link ("Never" when open-ended). */
function formatExpiry(expiresAt: string | null): string {
  if (!expiresAt) return "Never expires";
  const when = new Date(expiresAt);
  if (Number.isNaN(when.getTime())) return "Unknown expiry";
  return `Expires ${when.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
}

/** Names shown on a link's row before the rest fold into "+N more". */
const NAMES_SHOWN = 2;

const itemWord = (count: number) => `${count} ${count === 1 ? "item" : "items"}`;

/** "1 item you can't access", for what a link holds behind a wall. */
const hiddenPhrase = (count: number) => `${itemWord(count)} you can't access`;

/**
 * Names in a sentence: "A", "A and B", "A, B and 3 more". What the caller may
 * not read is counted, never named.
 */
function nameList(names: string[], hidden: number, shown = 3): string {
  const listed = names.slice(0, shown);
  const more = names.length - listed.length;
  const tail = [
    ...(more > 0 ? [`${more} more`] : []),
    ...(hidden > 0 ? [hiddenPhrase(hidden)] : []),
  ];
  const parts = [...listed, ...tail];
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * What a listed link holds beyond what the dialog was opened for. Opened on one
 * item, that is everything else on the link. Opened on a selection, it is the
 * whole link, since the link may cover only some of what is selected.
 */
function linkContents(link: ShareLink, selectedIds: Set<string>, forSelection: boolean) {
  const names = (link.items ?? [])
    .filter((item) => forSelection || !selectedIds.has(item.fileId))
    .map((item) => item.name);
  const hidden = link.hiddenItemCount ?? 0;
  return { names, hidden, count: names.length + hidden };
}

/** The sentence under the title, saying what the recipient will be able to open. */
function introFor(items: ShareLinkItem[]): string {
  const secure = "Set an expiry or add a password to keep it secure.";
  if (items.length === 1 && !items[0].isFolder) {
    return `Anyone with the link can open this file without logging in. ${secure}`;
  }
  const what = items.length === 1 ? "this folder" : "these items";
  return `Anyone with the link can open ${what} without logging in, including anything added to a shared folder later. ${secure}`;
}

/**
 * Create and manage secure external share links for a file, a folder, or a
 * selection. External recipients open the generated link with no login; access
 * is scoped by the chosen permission, optional expiry, and optional password.
 * Distinct from sharing a file with a client in the portal.
 *
 * Opened on one item, it also lists that item's live links, including any
 * multi-item link that names it, since that is where the firm finds a link
 * again to copy or revoke it. A selection has no such list to show.
 */
export default function ShareLinkModal({ open, onClose, lawFirmId, items }: ShareLinkModalProps) {
  const [expiry, setExpiry] = useState(DEFAULT_EXPIRY);
  const [permission, setPermission] = useState<ShareLinkPermission>("download");
  const [password, setPassword] = useState("");

  const [creating, setCreating] = useState(false);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  // The url last copied, so only the button that copied it says "Copied".
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [links, setLinks] = useState<ShareLink[]>([]);
  const [loadingLinks, setLoadingLinks] = useState(false);
  const [revokingToken, setRevokingToken] = useState<string | null>(null);
  // A link reaching past what this dialog is about is revoked only once the
  // firm has seen everything that revoking it cuts off.
  const [confirmRevoke, setConfirmRevoke] = useState<ShareLink | null>(null);
  const shownConfirmRevoke = useLastOpenValue(!!confirmRevoke, confirmRevoke);

  const single = items.length === 1 ? items[0] : null;
  // Joined so a fresh array with the same selection does not refetch.
  const selectionKey = items.map((item) => item.fileId).join(",");
  const selectedIds = useMemo(() => new Set(selectionKey ? selectionKey.split(",") : []), [selectionKey]);

  // Id of the most recent links request. Reopening the dialog on another item
  // starts a new one, and an older answer landing after it must neither show
  // the previous item's links nor end this item's loading state.
  const linksRequestIdRef = useRef(0);

  const loadLinks = useCallback(async () => {
    if (!selectionKey) return;
    const requestId = ++linksRequestIdRef.current;
    setLoadingLinks(true);
    try {
      const existing = await FilesService.listShareLinks(lawFirmId, selectionKey.split(","));
      if (requestId !== linksRequestIdRef.current) return;
      setLinks(existing);
    } catch (err) {
      if (requestId !== linksRequestIdRef.current) return;
      setError(getErrorMessage(err));
    } finally {
      if (requestId === linksRequestIdRef.current) setLoadingLinks(false);
    }
  }, [lawFirmId, selectionKey]);

  const clearCopied = useCallback(() => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = null;
    setCopiedUrl(null);
  }, []);

  // A pending "Copied" reset must not fire into an unmounted dialog.
  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  // Reset the form and (re)load existing links each time the modal opens.
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- re-seed the form only when the modal (re)opens for a file
    setExpiry(DEFAULT_EXPIRY);
    setPermission("download");
    setPassword("");
    setCreatedUrl(null);
    clearCopied();
    setError(null);
    setLinks([]);
    loadLinks();
  }, [open, loadLinks, clearCopied]);

  const handleCreate = async () => {
    if (items.length === 0) return;
    setCreating(true);
    setError(null);
    try {
      const link = await FilesService.createShareLink(lawFirmId, {
        ...(single ? { fileId: single.fileId } : { fileIds: items.map((i) => i.fileId) }),
        permission,
        expiresInHours: Number(expiry),
        password: password.trim() ? password : null,
      });
      setCreatedUrl(link.url);
      clearCopied();
      await loadLinks();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      // A newer copy restarts the two seconds rather than inheriting what is
      // left of an earlier copy's.
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      setCopiedUrl(url);
      copiedTimerRef.current = setTimeout(() => {
        copiedTimerRef.current = null;
        setCopiedUrl(null);
      }, 2000);
    } catch {
      setError("Could not copy the link. Copy it manually instead.");
    }
  };

  const requestRevoke = (link: ShareLink) => {
    // Anything outside what this dialog is about, named or behind a wall.
    if (linkContents(link, selectedIds, false).count > 0) {
      setConfirmRevoke(link);
      return;
    }
    void handleRevoke(link.token);
  };

  const handleRevoke = async (token: string) => {
    setRevokingToken(token);
    setError(null);
    try {
      await FilesService.revokeShareLink(lawFirmId, token);
      // If the freshly-created link was the one revoked, clear its display.
      setLinks((prev) => {
        const removed = prev.find((l) => l.token === token);
        if (removed && createdUrl === removed.url) setCreatedUrl(null);
        return prev.filter((l) => l.token !== token);
      });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setRevokingToken(null);
    }
  };

  // A create or revoke still in flight keeps the dialog open, so its result
  // (the new link's URL, or a refusal) lands where the user can see it.
  const busy = creating || revokingToken !== null;

  return (
    <>
      <Modal
        isOpen={open}
        onClose={onClose}
        dismissible={!busy}
        title="Share link"
        icon={<Link2 size={18} className="text-on-surface-secondary" />}
        subtitle={single ? single.name : items.length > 1 ? `${items.length} items` : undefined}
        showClose={false}
        size="lg"
        bodyClassName="px-6 py-5 space-y-5 overflow-y-auto overflow-x-hidden styled-scrollbar"
        footer={
          <Button type="secondary" onClick={onClose} disabled={busy}>
            Done
          </Button>
        }
      >
        {error && <ErrorNotification error={error} onClose={() => setError(null)} />}

              <p className="text-sm text-on-surface-secondary">{introFor(items)}</p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Dropdown
                  label="Link expires after"
                  value={expiry}
                  onChange={setExpiry}
                  options={EXPIRY_OPTIONS}
                  portal
                />
                <Dropdown
                  label="Permission"
                  value={permission}
                  onChange={(v) => setPermission(v as ShareLinkPermission)}
                  options={PERMISSION_OPTIONS}
                  portal
                />
              </div>

              <div>
                <label className={LABEL_CLASS} htmlFor="share-link-password">
                  Password
                </label>
                <input
                  id="share-link-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Leave blank for no password"
                  autoComplete="new-password"
                  className={INPUT_CLASS}
                />
              </div>

              <div>
                <Button type="primary" onClick={handleCreate} loading={creating} disabled={creating || items.length === 0}>
                  Create link
                </Button>
              </div>

              {createdUrl && (
                <div className="rounded-md border border-outline-subtle bg-surface-alt p-3 space-y-2">
                  <p className="text-xs font-medium text-on-surface-secondary">Your share link is ready</p>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      value={createdUrl}
                      onFocus={(e) => e.currentTarget.select()}
                      className={`${INPUT_CLASS} font-mono text-xs`}
                    />
                    <button
                      type="button"
                      onClick={() => handleCopy(createdUrl)}
                      className="inline-flex items-center gap-1.5 shrink-0 px-3 py-2 rounded-md border border-outline bg-surface text-on-surface text-sm font-medium hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                    >
                      {copiedUrl === createdUrl ? <Check size={15} className="text-green-600 dark:text-green-400" /> : <Copy size={15} />}
                      {copiedUrl === createdUrl ? "Copied" : "Copy"}
                    </button>
                  </div>
                </div>
              )}

              {items.length > 0 && (
              <div className="border-t border-outline-subtle pt-4">
                <h3 className="text-sm font-medium text-on-surface mb-3">Active links</h3>
                {loadingLinks ? (
                  <p className="text-sm text-on-surface-muted">Loading links…</p>
                ) : links.length === 0 ? (
                  <p className="text-sm text-on-surface-muted">
                    {single
                      ? `No active share links for this ${single.isFolder ? "folder" : "file"}.`
                      : "No active share links for these items."}
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {links.map((link) => (
                      <li
                        key={link.token}
                        className="flex items-center gap-3 rounded-md border border-outline-subtle bg-surface-alt px-3 py-2.5"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 text-sm text-on-surface">
                            <span className="capitalize">{link.permission === "download" ? "Download" : "View only"}</span>
                            {link.hasPassword && (
                              <span className="inline-flex items-center gap-1 text-xs text-on-surface-muted">
                                <Lock size={12} /> Password
                              </span>
                            )}
                          </div>
                          <LinkContentsLine link={link} selectedIds={selectedIds} forSelection={!single} />
                          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-on-surface-muted">
                            <Clock size={12} />
                            <span className="truncate">{formatExpiry(link.expiresAt)}</span>
                            <span aria-hidden="true">·</span>
                            <span>{link.accessCount} {link.accessCount === 1 ? "open" : "opens"}</span>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleCopy(link.url)}
                          title="Copy link"
                          className="inline-flex items-center gap-1 shrink-0 px-2.5 py-1.5 rounded-md border border-outline bg-surface text-on-surface-secondary text-xs font-medium hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                        >
                          {copiedUrl === link.url
                            ? <><Check size={13} className="text-green-600 dark:text-green-400" /> Copied</>
                            : <><Copy size={13} /> Copy</>}
                        </button>
                        <button
                          type="button"
                          onClick={() => requestRevoke(link)}
                          disabled={revokingToken === link.token}
                          title="Revoke link"
                          className="inline-flex items-center gap-1 shrink-0 px-2.5 py-1.5 rounded-md border border-red-600 dark:border-red-800/60 bg-surface text-red-600 dark:text-red-400 text-xs font-medium hover:bg-red-50 dark:hover:bg-red-950/20 transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer disabled:opacity-50"
                        >
                          <Trash2 size={13} /> {revokingToken === link.token ? "Revoking…" : "Revoke"}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              )}
      </Modal>

      {/* A sibling of the dialog, not inside it: the dialog's card is transformed
          by its entrance animation, which would pin a fixed overlay to the card. */}
      <ConfirmModal
        stacked
        isOpen={!!confirmRevoke}
        onClose={() => setConfirmRevoke(null)}
        onConfirm={() => {
          if (confirmRevoke) void handleRevoke(confirmRevoke.token);
          setConfirmRevoke(null);
        }}
        title="Revoke this link?"
        message={shownConfirmRevoke ? revokeMessage(shownConfirmRevoke, selectedIds) : ""}
        confirmText="Revoke link"
        confirmType="danger"
      />
    </>
  );
}

/** The confirmation for revoking a link that reaches past this dialog's items. */
function revokeMessage(link: ShareLink, selectedIds: Set<string>): string {
  const beyond = linkContents(link, selectedIds, false);
  const total = (link.items?.length ?? 0) + (link.hiddenItemCount ?? 0);
  return `It also shares ${nameList(beyond.names, beyond.hidden)}. Anyone with the link loses access to all ${itemWord(total)}.`;
}

/**
 * What a link holds beyond what the dialog is about, under its permission line:
 * "Also shares A, B +2 more" on one item's links, "Shares …" on a selection's.
 * Hovering the line lists every one of them, since a long name is cut off and
 * the rest are folded into "+N more". A link to nothing but this item has no
 * line, which is what tells the two apart.
 */
function LinkContentsLine({
  link,
  selectedIds,
  forSelection,
}: {
  link: ShareLink;
  selectedIds: Set<string>;
  forSelection: boolean;
}) {
  const { names, hidden, count } = linkContents(link, selectedIds, forSelection);
  if (count === 0) return null;
  const shown = names.slice(0, NAMES_SHOWN);
  const moreCount = names.length - shown.length + hidden;
  const everything = (
    <ul>
      {names.map((name, index) => (
        <li key={`${index}:${name}`}>{name}</li>
      ))}
      {hidden > 0 && <li className="italic">{hiddenPhrase(hidden)}</li>}
    </ul>
  );
  // Quicker than the app's usual 300ms: this tooltip is the content being
  // looked for, not a label for a control, so a pause reads as lag.
  return (
    <Tooltip title={everything} enterDelay={100}>
      <div className="mt-0.5 flex min-w-0 cursor-default items-center gap-1.5 text-xs text-on-surface-muted">
        <Files size={12} className="shrink-0" />
        <span className="truncate">
          {forSelection ? "Shares" : "Also shares"} {shown.join(", ")}
          {shown.length === 0 && hidden > 0 && hiddenPhrase(hidden)}
        </span>
        {moreCount > 0 && shown.length > 0 && (
          <span className="shrink-0 underline decoration-dotted underline-offset-2">+{moreCount} more</span>
        )}
      </div>
    </Tooltip>
  );
}
