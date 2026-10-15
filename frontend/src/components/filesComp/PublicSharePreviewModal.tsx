"use client";

import DocumentPreviewOverlay from "./DocumentPreviewOverlay";

interface PublicSharePreviewModalProps {
  open: boolean;
  onClose: () => void;
  name: string;
  contentType: string | null;
  /** Already-resolved, ready-to-fetch signed url - no lawFirmId to mint one from here. */
  fileUrl: string | null;
  /**
   * The shared file's size, when the share response carried one. Decides whether
   * a PDF is fetched whole or read in page ranges. Left out, the overlay
   * resolves it with a HEAD rather than assuming small, which is what pulled a
   * multi-gigabyte share into the tab whole.
   */
  sizeBytes?: number;
  /**
   * Shows the preview's Download button. Passed only for a link whose
   * permission allows downloading; a view-only link omits it.
   */
  onDownload?: () => void;
}

/**
 * Read-only preview for the public share-link landing page. Thin wrapper
 * around the shared `DocumentPreviewOverlay` (also used by the authenticated
 * `FilePreviewModal`): the content type and signed url are already resolved by
 * the caller rather than fetched via a `lawFirmId`, since this page has no firm
 * session to fetch through.
 */
export default function PublicSharePreviewModal({ open, onClose, name, contentType, fileUrl, sizeBytes, onDownload }: PublicSharePreviewModalProps) {
  return (
    <DocumentPreviewOverlay
      open={open && !!fileUrl}
      onClose={onClose}
      name={name}
      contentType={contentType || ''}
      fileUrl={fileUrl}
      sizeBytes={sizeBytes}
      onDownload={onDownload}
    />
  );
}
