"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronRight, Clock, Download, Eye, FileText, Files, Folder, Lock, Shield } from "lucide-react";
import ActionIconButton from "@/components/ui/ActionIconButton";
import FieldError from "@/components/ui/FieldError";
import FieldLabel from "@/components/ui/FieldLabel";
import Spinner from "@/components/ui/Spinner";
import FileBreadcrumbs from "./FileBreadcrumbs";
import PublicSharePreviewModal from "./PublicSharePreviewModal";
import { formatFileSize } from "@/lib/utils/format";

interface PublicItem {
  id: string;
  name: string;
  isFolder: boolean;
  sizeBytes: number | null;
  contentType: string | null;
}

interface Listing {
  folder: { id: string; name: string } | null;
  /** The shared folder the recipient opened, down to the one on screen. */
  path: Array<{ id: string; name: string }>;
  items: PublicItem[];
}

interface Preview {
  item: PublicItem;
  name: string;
  url: string;
  contentType: string | null;
  sizeBytes?: number;
}

const INCORRECT_PASSWORD = "Incorrect password. Please try again.";

const ROW_BUTTON_CLS =
  "inline-flex items-center gap-1 shrink-0 px-2.5 py-1.5 rounded-md border border-outline bg-surface text-on-surface-secondary text-xs font-medium hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";

/**
 * The recipient's view of a share link that names several files and folders.
 *
 * Nothing is listed until the link's password (when it has one) is given: the
 * item names are part of what the password protects. Folders open in place, and
 * each file is downloaded or previewed on its own, by id.
 */
export default function PublicShareItems({
  token,
  apiRoot,
  displayName,
  permission,
  requiresPassword,
  expiry,
  onLinkGone,
}: {
  token: string;
  apiRoot: string;
  displayName: string;
  permission: "view" | "download";
  requiresPassword: boolean;
  /** Formatted expiry, or null when there is none to show. */
  expiry: string | null;
  /** The link was revoked or expired while the recipient had the page open. */
  onLinkGone: (state: "not_found" | "expired") => void;
}) {
  const [password, setPassword] = useState("");
  const passwordRef = useRef<HTMLInputElement>(null);
  const passwordErrorId = useId();
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(!requiresPassword);
  const [error, setError] = useState<string | null>(null);
  /** The file and action waiting on a signed url, so only that button says so. */
  const [opening, setOpening] = useState<{ id: string; mode: "view" | "download" } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  useEffect(() => {
    if (passwordError) passwordRef.current?.focus();
  }, [passwordError]);

  const base = `${apiRoot}/share/${encodeURIComponent(token)}`;
  const isDownload = permission === "download";

  /** The password to send, once the recipient has one to give. */
  const credentials = useCallback(
    () => (requiresPassword ? { password } : {}),
    [requiresPassword, password],
  );

  // Id of the most recent listing request. The breadcrumb stays clickable while
  // a folder loads, so an older answer landing after a newer one must not put
  // the recipient back in the folder they left.
  const loadRequestIdRef = useRef(0);

  const load = useCallback(async (folderId: string | null) => {
    const requestId = ++loadRequestIdRef.current;
    const isCurrent = () => requestId === loadRequestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${base}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...credentials(), ...(folderId ? { folderId } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!isCurrent()) return;
      if (res.status === 401) {
        setPasswordError(INCORRECT_PASSWORD);
        return;
      }
      if (res.status === 410) {
        onLinkGone("expired");
        return;
      }
      if (res.status === 404) {
        // The link itself is gone only when its top level is. A folder can be
        // deleted or moved out while the link stays live.
        if (!folderId) onLinkGone("not_found");
        else setError("This folder is no longer available.");
        return;
      }
      if (!res.ok) {
        setError("Something went wrong loading these files. Please try again.");
        return;
      }
      setListing(data as Listing);
    } catch {
      if (!isCurrent()) return;
      setError("Unable to reach the server. Please check your connection and try again.");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [base, credentials, onLinkGone]);

  // A link without a password lists straight away.
  useEffect(() => {
    if (requiresPassword) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first listing, fetched once on arrival
    void load(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- list once on arrival; later loads are navigation
  }, []);

  /**
   * Fetch a short-lived url for one file, then download it or show it in the
   * preview. A download link can be previewed too: the preview reads the bytes
   * itself, so the url's download disposition does not stop it rendering.
   */
  const openFile = async (item: PublicItem, mode: "view" | "download") => {
    setOpening({ id: item.id, mode });
    setError(null);
    try {
      const res = await fetch(`${base}/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...credentials(), fileId: item.id }),
      });
      const data = await res.json().catch(() => ({} as { url?: string; contentType?: string | null }));
      if (res.status === 401) {
        setListing(null);
        setPasswordError(INCORRECT_PASSWORD);
        return;
      }
      if (res.status === 410 && data?.code === "SHARE_LINK_EXPIRED") {
        onLinkGone("expired");
        return;
      }
      if (!res.ok || !data?.url) {
        setError(`${item.name} is no longer available.`);
        return;
      }
      if (mode === "download") {
        window.location.href = data.url;
        return;
      }
      setPreview({
        item,
        name: item.name,
        url: data.url,
        contentType: data.contentType ?? item.contentType,
        sizeBytes: item.sizeBytes ?? undefined,
      });
      setPreviewOpen(true);
    } catch {
      setError("Unable to reach the server. Please check your connection and try again.");
    } finally {
      setOpening(null);
    }
  };

  const locked = requiresPassword && !listing;
  const path = listing?.path ?? [];

  return (
    <>
      <div className="w-full max-w-2xl rounded-xl bg-surface border border-outline shadow-sm p-8">
        <div className="flex flex-col items-center text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-surface-alt">
            <Files size={28} className="text-on-surface-secondary" />
          </div>
          <h1 className="text-lg font-semibold text-on-surface break-words">{displayName}</h1>
          <p className="mt-1 text-sm text-on-surface-secondary">
            {isDownload ? "These files have been shared with you to download." : "These files have been shared with you to view."}
          </p>
          {expiry && (
            <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-on-surface-muted">
              <Clock size={13} /> Available until {expiry}
            </p>
          )}
        </div>

        {locked ? (
          <>
            <div className="mt-6">
              <FieldLabel htmlFor="share-password">
                Password *
              </FieldLabel>
              <div className="relative">
                <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-muted" />
                <input
                  ref={passwordRef}
                  aria-invalid={!!passwordError || undefined}
                  aria-describedby={passwordError ? passwordErrorId : undefined}
                  id="share-password"
                  type="password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (passwordError) setPasswordError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && password.trim() && !loading) void load(null);
                  }}
                  placeholder="Enter the link password"
                  autoComplete="off"
                  className="w-full rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted pl-9 pr-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                />
              </div>
              <div id={passwordErrorId}><FieldError message={passwordError} /></div>
            </div>
            <FieldError message={error} className="mt-4 justify-center" />
            <button
              type="button"
              onClick={() => void load(null)}
              disabled={loading || !password.trim()}
              className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-md bg-accent-solid px-4 py-2.5 text-sm font-medium text-accent-foreground transition-[background-color,transform] active:scale-[0.985] motion-reduce:active:scale-100 hover:bg-accent-solid-hover disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {loading ? "Opening…" : "Continue"}
            </button>
          </>
        ) : (
          <div className="mt-6 space-y-3">
            <FileBreadcrumbs
              trail={path}
              rootLabel="All items"
              onUp={() => void load(path.length > 1 ? path[path.length - 2].id : null)}
              onRoot={() => void load(null)}
              onSegment={(index) => void load(path[index].id)}
            />
            <FieldError message={error} className="justify-center" />
            {!listing ? (
              <div className="flex justify-center py-6"><Spinner size={20} /></div>
            ) : listing.items.length === 0 ? (
              <p className="py-6 text-center text-sm text-on-surface-muted">
                {listing.folder ? "This folder is empty." : "These files are no longer available."}
              </p>
            ) : (
              <ul className="divide-y divide-outline-subtle rounded-md border border-outline-subtle">
                {listing.items.map((item) => (
                  <li key={item.id} className="flex items-center gap-3 px-3 py-2.5">
                    {item.isFolder ? (
                      <button
                        type="button"
                        onClick={() => void load(item.id)}
                        disabled={loading}
                        aria-label={`Open ${item.name}`}
                        className="flex min-w-0 flex-1 items-center gap-3 text-left cursor-pointer disabled:cursor-not-allowed"
                      >
                        <Folder size={18} className="shrink-0 text-on-surface-secondary" />
                        <span className="min-w-0 flex-1 truncate text-sm text-on-surface">{item.name}</span>
                        <ChevronRight size={16} className="shrink-0 text-on-surface-muted" />
                      </button>
                    ) : (
                      <>
                        <FileText size={18} className="shrink-0 text-on-surface-secondary" />
                        <span className="min-w-0 flex-1 truncate text-sm text-on-surface">{item.name}</span>
                        {!!item.sizeBytes && (
                          <span className="shrink-0 text-xs text-on-surface-muted">{formatFileSize(item.sizeBytes)}</span>
                        )}
                        <button
                          type="button"
                          onClick={() => void openFile(item, "view")}
                          disabled={opening !== null}
                          aria-label={`View ${item.name}`}
                          className={ROW_BUTTON_CLS}
                        >
                          <Eye size={13} /> {opening?.id === item.id && opening.mode === "view" ? "Opening…" : "View"}
                        </button>
                        {/* Viewing is the main action; a download link adds a compact download. */}
                        {isDownload && (
                          <ActionIconButton
                            label={`Download ${item.name}`}
                            tooltip="Download"
                            onClick={() => void openFile(item, "download")}
                            disabled={opening !== null}
                            className="shrink-0"
                          >
                            {opening?.id === item.id && opening.mode === "download"
                              ? <Spinner size={15} />
                              : <Download size={15} />}
                          </ActionIconButton>
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <p className="mt-5 flex items-center justify-center gap-1.5 text-xs text-on-surface-muted">
          <Shield size={13} className="shrink-0 -translate-y-[1px]" /> Secured by Paralegix
        </p>
      </div>

      <PublicSharePreviewModal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        name={preview?.name ?? ""}
        contentType={preview?.contentType ?? null}
        fileUrl={preview?.url ?? null}
        sizeBytes={preview?.sizeBytes}
        // A fresh url for the download: the preview's may lapse while it is read.
        onDownload={isDownload && preview ? () => void openFile(preview.item, "download") : undefined}
      />
    </>
  );
}
