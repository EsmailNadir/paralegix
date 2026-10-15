"use client";

import { useCallback, useEffect, useState } from "react";
import FilesService from "@/services/files.service";
import { useLastOpenValue } from "@/hooks/useMountTransition";
import { formatFileSize } from "@/lib/utils/format";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import DocumentPreviewOverlay from "./DocumentPreviewOverlay";

/**
 * What the preview needs, which is less than a whole file row.
 *
 * Deliberately narrower than `FileInfo`. Half the surfaces that open this are
 * not browsing the file tree at all: a note attachment, a message attachment and
 * a portal document each have a name, a type and a url, and no row of their own.
 * Demanding the full row forced each of them to invent the missing fields.
 */
export interface PreviewableFile {
  /** The file row, when there is one. Needed only to mint a URL. */
  id?: string;
  name: string;
  contentType: string;
  size: number;
  /** A url already in hand. When absent, `id` plus `lawFirmId` mints one. */
  signedUrl?: string;
}

interface FilePreviewModalProps {
  file: PreviewableFile | null;
  isOpen: boolean;
  onClose: () => void;
  onDownload: () => void;
  /** Needed to mint a signed URL for files that came from a listing, which
   *  carries none. Surfaces whose files already have a URL can omit it. */
  lawFirmId?: string;
}

/**
 * Thin wrapper around the shared `DocumentPreviewOverlay`: resolves a signed
 * url for the file (minting one via `lawFirmId` when the listing it came from
 * didn't carry one) and hands the overlay an already-resolved url, the same
 * contract the public share preview satisfies without any auth of its own.
 */
export default function FilePreviewModal({
  file: fileProp,
  isOpen,
  onClose,
  onDownload,
  lawFirmId,
}: FilePreviewModalProps) {
  // Keep the last opened file rendered through the exit animation, after the
  // parent clears the `file` prop on close.
  const file = useLastOpenValue(isOpen, fileProp);

  const [resolving, setResolving] = useState(false);
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !fileProp) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting for a newly opened file is the teardown of the async resolution this effect starts
    setResolving(true);
    setResolveError(null);
    setResolvedUrl(null);

    (async () => {
      try {
        // Listings carry no signed URL, so resolve one for this file before any
        // consumer touches it. Files that arrived with a URL reuse it unchanged.
        const fileUrl = lawFirmId && fileProp.id
          ? await FilesService.ensureSignedUrl(lawFirmId, {
            signedUrl: fileProp.signedUrl ?? '', id: fileProp.id,
          })
          : fileProp.signedUrl;
        if (!fileUrl) throw new Error('This file could not be opened.');
        if (cancelled) return;
        setResolvedUrl(fileUrl);
      } catch (err) {
        if (cancelled) return;
        setResolveError(getErrorMessage(err, 'Failed to load preview'));
      } finally {
        if (!cancelled) setResolving(false);
      }
    })();

    return () => { cancelled = true; };
  }, [isOpen, fileProp, lawFirmId]);

  const fileId = file?.id;

  /**
   * Mints a fresh read url for the same file, minutes into reading it.
   *
   * Goes back through the route rather than reusing or extending the url in
   * hand: the route is where firm membership and the file's own permission are
   * checked, so a read that outlives its first url does not also outlive the
   * access that granted it. A file with no row of its own (a note or message
   * attachment carrying only a url) has nothing to check, so it gets none.
   */
  const refreshUrl = useCallback(async () => {
    if (!lawFirmId || !fileId) throw new Error('This file has no record, so it cannot be reopened.');
    return FilesService.refreshSignedUrl(lawFirmId, fileId);
  }, [lawFirmId, fileId]);

  if (!file) return null;

  return (
    <DocumentPreviewOverlay
      open={isOpen && !!file}
      onClose={onClose}
      name={file.name}
      contentType={file.contentType}
      fileUrl={resolveError ? null : resolvedUrl}
      resolving={resolving}
      loadError={resolveError}
      sizeLabel={formatFileSize(file.size)}
      sizeBytes={file.size}
      onRefreshUrl={lawFirmId && fileId ? refreshUrl : undefined}
      onDownload={onDownload}
    />
  );
}
