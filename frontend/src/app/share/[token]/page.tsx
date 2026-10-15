"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { Download, Eye, Lock, FileText, Clock, Shield, AlertCircle } from "lucide-react";
import LoadingSpinner from "@/components/LoadingSpinner";
import FieldError from "@/components/ui/FieldError";
import PublicSharePreviewModal from "@/components/filesComp/PublicSharePreviewModal";
import PublicShareItems from "@/components/filesComp/PublicShareItems";
import { publicFetch } from "@/lib/utils/fetchWithTokenRefresh";
import FieldLabel from "@/components/ui/FieldLabel";

const API_ROOT = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:5001/api").replace(/\/$/, "");

type ShareLinkPermission = "view" | "download";

interface ShareMeta {
  /** The link names several items or a folder, listed once the password (if any) is given. */
  isMultiItem?: boolean;
  displayName: string;
  permission: ShareLinkPermission;
  requiresPassword: boolean;
  expiresAt: string | null;
  contentType: string | null;
}

// Terminal states the metadata fetch can settle into.
type LoadState = "loading" | "ready" | "not_found" | "expired" | "error";

/** Friendly expiry line for the recipient. */
function formatExpiry(expiresAt: string | null): string | null {
  if (!expiresAt) return null;
  const when = new Date(expiresAt);
  if (Number.isNaN(when.getTime())) return null;
  return when.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

/** Centered message card used for the not-found / expired / error states. */
function MessageCard({ title, message, headingId }: { title: string; message: string; headingId?: string }) {
  return (
    <div className="w-full max-w-md rounded-xl bg-surface border border-outline shadow-sm p-8 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-surface-alt">
        <AlertCircle size={24} className="text-on-surface-muted" />
      </div>
      <h1 id={headingId} tabIndex={-1} className="text-lg font-semibold text-on-surface">{title}</h1>
      <p className="mt-2 text-sm text-on-surface-secondary">{message}</p>
    </div>
  );
}

export default function SharePage() {
  const params = useParams();
  const headingId = useId();
  const passwordRef = useRef<HTMLInputElement>(null);
  const token = (Array.isArray(params?.token) ? params.token[0] : params?.token) || "";

  const [state, setState] = useState<LoadState>("loading");
  const [meta, setMeta] = useState<ShareMeta | null>(null);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewContentType, setPreviewContentType] = useState<string | null>(null);
  useEffect(() => {
    if (passwordError) passwordRef.current?.focus();
  }, [passwordError]);
  useEffect(() => {
    if (state === 'expired' || state === 'not_found' || state === 'error') document.getElementById(headingId)?.focus();
  }, [state, headingId]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!token) {
        if (!cancelled) setState("not_found");
        return;
      }
      try {
        const res = await publicFetch(`${API_ROOT}/share/${encodeURIComponent(token)}`);
        if (cancelled) return;
        if (res.status === 404) {
          setState("not_found");
          return;
        }
        if (res.status === 410) {
          setState("expired");
          return;
        }
        if (!res.ok) {
          setState("error");
          return;
        }
        const data = (await res.json()) as ShareMeta;
        if (cancelled) return;
        setMeta(data);
        setState("ready");
      } catch {
        if (!cancelled) setState("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleOpen = useCallback(async () => {
    if (!token || !meta) return;
    setSubmitting(true);
    setPasswordError(null);
    setDownloadError(null);
    try {
      const res = await fetch(`${API_ROOT}/share/${encodeURIComponent(token)}/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(meta.requiresPassword ? { password } : {}),
      });

      const data = await res.json().catch(() => ({} as { url?: string; contentType?: string | null; code?: string; error?: string }));

      if (res.status === 401 || data?.code === "SHARE_LINK_PASSWORD") {
        setPasswordError("Incorrect password. Please try again.");
        return;
      }
      if (res.status === 404) {
        setState("not_found");
        return;
      }
      if (res.status === 410) {
        setState("expired");
        return;
      }
      if (!res.ok || !data?.url) {
        setDownloadError("Something went wrong opening this file. Please try again.");
        return;
      }

      if (meta.permission === "download") {
        // A real download: hand off to the storage url.
        window.location.href = data.url;
        return;
      }

      // "view" shows the same in-app preview popup every other file-view
      // affordance in the product uses, rather than navigating away.
      setPreviewUrl(data.url);
      setPreviewContentType(data.contentType ?? meta.contentType);
      setPreviewOpen(true);
    } catch {
      setDownloadError("Unable to reach the server. Please check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }, [token, meta, password]);

  if (state === "loading") {
    return <LoadingSpinner />;
  }

  if (state === "not_found") {
    return (
      <MessageCard
        headingId={headingId}
        title="Link not available"
        message="This share link does not exist or has been revoked. Ask the sender for a new link."
      />
    );
  }

  if (state === "expired") {
    return (
      <MessageCard
        headingId={headingId}
        title="Link expired"
        message="This share link has expired. Ask the sender to create a new one."
      />
    );
  }

  if (state === "error" || !meta) {
    return (
      <MessageCard
        headingId={headingId}
        title="Something went wrong"
        message="We couldn't load this share link. Please try again in a few minutes."
      />
    );
  }

  if (meta.isMultiItem) {
    return (
      <PublicShareItems
        token={token}
        apiRoot={API_ROOT}
        displayName={meta.displayName}
        permission={meta.permission}
        requiresPassword={meta.requiresPassword}
        expiry={formatExpiry(meta.expiresAt)}
        onLinkGone={setState}
      />
    );
  }

  const isDownload = meta.permission === "download";
  const actionLabel = isDownload ? "Download file" : "View file";
  const ActionIcon = isDownload ? Download : Eye;
  const expiry = formatExpiry(meta.expiresAt);

  return (
    <>
    <div className="w-full max-w-md rounded-xl bg-surface border border-outline shadow-sm p-8">
      <div className="flex flex-col items-center text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-surface-alt">
          <FileText size={28} className="text-on-surface-secondary" />
        </div>
        <h1 className="text-lg font-semibold text-on-surface break-words">{meta.displayName}</h1>
        <p className="mt-1 text-sm text-on-surface-secondary">
          {isDownload ? "This file has been shared with you to download." : "This file has been shared with you to view."}
        </p>
        {expiry && (
          <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-on-surface-muted">
            <Clock size={13} /> Available until {expiry}
          </p>
        )}
      </div>

      {meta.requiresPassword && (
        <div className="mt-6">
          <FieldLabel htmlFor="share-password">
            Password *
          </FieldLabel>
          <div className="relative">
            <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-muted" />
            <input
              ref={passwordRef}
              aria-invalid={!!passwordError || undefined}
              aria-describedby={passwordError ? `${headingId}-password-error` : undefined}
              id="share-password"
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (passwordError) setPasswordError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && password.trim() && !submitting) handleOpen();
              }}
              placeholder="Enter the link password"
              autoComplete="off"
              className="w-full rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted pl-9 pr-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
          </div>
          <div id={`${headingId}-password-error`}><FieldError message={passwordError} /></div>
        </div>
      )}

      <FieldError message={downloadError} className="mt-4 justify-center" />

      <button
        type="button"
        onClick={handleOpen}
        disabled={submitting || (meta.requiresPassword && !password.trim())}
        className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-md bg-accent-solid px-4 py-2.5 text-sm font-medium text-accent-foreground transition-[background-color,transform] active:scale-[0.985] motion-reduce:active:scale-100 hover:bg-accent-solid-hover disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
      >
        <ActionIcon size={16} />
        {submitting ? "Opening…" : actionLabel}
      </button>

      <p className="mt-5 flex items-center justify-center gap-1.5 text-xs text-on-surface-muted">
        <Shield size={13} className="shrink-0 -translate-y-[1px]" /> Secured by Paralegix
      </p>
    </div>

    <PublicSharePreviewModal
      open={previewOpen}
      onClose={() => setPreviewOpen(false)}
      name={meta.displayName}
      contentType={previewContentType}
      fileUrl={previewUrl}
    />
    </>
  );
}
