/**
 * The in-app path a notification opens, or null when it names nothing to open.
 *
 * Shared by every place a notification is clicked (the firm bell, the firm
 * notifications page, the toaster and the portal bell) so they cannot disagree
 * about where a row goes.
 */

/** Which app the reader is in: the firm workspace or the client portal. */
export type NotificationSurface = "firm" | "portal";

export interface NotificationTarget {
  type?: string | null;
  actionUrl?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  matterId?: string | null;
}

/**
 * Reduce an actionUrl to a same-origin path. The backend builds absolute URLs
 * on its own FRONTEND_URL, which need not match the origin the reader is on, so
 * only the path, query and hash are kept. That also means a stored URL can
 * never navigate the reader off the app.
 */
function toInAppPath(actionUrl: string): string | null {
  try {
    const url = new URL(actionUrl, "http://in-app.invalid");
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return actionUrl.startsWith("/") ? actionUrl : null;
  }
}

function firmFallback(n: NotificationTarget, lawFirmId: string): string | null {
  const base = `/lawfirm/${lawFirmId}`;
  switch (n.entityType) {
    case "task":
      return n.entityId ? `${base}/tasks/${n.entityId}` : `${base}/tasks`;
    case "matter": {
      const matterId = n.entityId || n.matterId;
      return matterId ? `${base}/matters/${matterId}` : `${base}/matters`;
    }
    case "invoice":
      return `${base}/billing`;
    // A message row's entityId is a conversation id for a new-message
    // notification but a message id for a mention, so it cannot name a thread.
    case "message":
      return `${base}/messages`;
    case "note":
      return n.matterId ? `${base}/matters/${n.matterId}?tab=notes` : `${base}/notes`;
    case "file":
      return n.matterId ? `${base}/matters/${n.matterId}?tab=files` : `${base}/files`;
    default:
      return n.matterId ? `${base}/matters/${n.matterId}` : null;
  }
}

function portalFallback(n: NotificationTarget, lawFirmId: string): string | null {
  const base = `/client/lawfirm/${lawFirmId}`;
  if (n.type?.startsWith("document_request")) return `${base}/documents`;
  switch (n.entityType) {
    case "invoice":
      return `${base}/billing`;
    case "message":
      return `${base}/messages`;
    case "file":
      return `${base}/documents`;
    case "matter":
      return n.matterId ? `${base}/matters/${n.matterId}` : `${base}/matters`;
    // Tasks and notes have no portal page, so they open their matter when they
    // have one and nothing otherwise.
    default:
      return n.matterId ? `${base}/matters/${n.matterId}` : null;
  }
}

export function notificationHref(
  n: NotificationTarget,
  surface: NotificationSurface,
  lawFirmId: string | null | undefined,
): string | null {
  if (n.actionUrl) {
    const path = toInAppPath(n.actionUrl);
    if (path) return path;
  }
  if (!lawFirmId) return null;
  return surface === "portal" ? portalFallback(n, lawFirmId) : firmFallback(n, lawFirmId);
}
