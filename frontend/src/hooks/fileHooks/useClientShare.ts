"use client";

import { useCallback, useState } from "react";
import FilesService, { type FileInfo } from "@/services/files.service";
import { type FileScope, canShareWithClient } from "@/lib/files/fileScope";
import type { ShareClient } from "@/components/filesComp/ClientSharePickerModal";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { bulkFailureMessage } from "@/lib/utils/bulkRequests";

export interface ClientShareState {
  /** Whether this scope can share with the portal at all. */
  canShare: boolean;
  /** Object paths with a share request in flight (row controls disable on these). */
  pendingIds: Set<string>;
  /** Recipient-picker state, for a multi-client matter or task. */
  picker: {
    open: boolean;
    items: FileInfo[];
    initialSelectedIds: string[];
    label: string;
    close: () => void;
    confirm: (clientIds: string[], notify: boolean) => void;
  };
  /**
   * Warning shown instead of sharing when there's nobody who could actually
   * see it yet: no client on the scope, or none of them have a portal
   * account. Left `null` when nothing needs flagging, including scopes that
   * never resolved portal status for their clients (`ShareClient.userId`
   * is `undefined` for all of them): silence there means "unknown", not
   * "confirmed fine".
   */
  warning: {
    kind: "no-client" | "no-portal";
    itemLabel: string;
    close: () => void;
    confirm: () => void;
  } | null;
  /** Share or unshare items, prompting for recipients when that is meaningful. */
  share: (items: FileInfo[], visible: boolean) => void;
}

/**
 * Sharing files with the client portal, including who receives them.
 *
 * Sharing is optimistic: the rows flip immediately and revert if the request
 * fails, because the toggle sits on the row and a round-trip's worth of nothing
 * reads as a control that did not work.
 *
 * Recipients are only asked for when the answer is not already determined - a
 * matter or task with more than one client. Unsharing, a single-client scope,
 * and a client's own file area all apply straight away. Choosing every client is
 * recorded as "no restriction" rather than as that list, so a client added to
 * the matter later can still see the file.
 */
export function useClientShare({
  lawFirmId,
  scope,
  shareClients,
  patchFiles,
  onError,
  onSuccess,
}: {
  lawFirmId: string;
  scope: FileScope;
  /** The clients who could receive a share in this scope. */
  shareClients: ShareClient[];
  patchFiles: (updater: (files: FileInfo[]) => FileInfo[]) => void;
  onError?: (message: string) => void;
  onSuccess?: (message: string) => void;
}): ClientShareState {
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerItems, setPickerItems] = useState<FileInfo[]>([]);
  const [pickerInitialIds, setPickerInitialIds] = useState<string[]>([]);
  const [warning, setWarning] = useState<{ kind: "no-client" | "no-portal"; items: FileInfo[] } | null>(null);

  const canShare = canShareWithClient(scope);

  const apply = useCallback(async (
    items: FileInfo[],
    visible: boolean,
    visibleClientIds?: string[],
    notify: boolean = true,
  ) => {
    const targets = (items || []).filter(Boolean);
    if (!canShare || targets.length === 0) return;
    const targetIds = new Set(targets.map((i) => i.id));

    const setVisibility = (ids: Set<string>, vis: boolean, clientIds: string[] | null) =>
      patchFiles((files) => files.map((f) => (
        ids.has(f.id)
          ? { ...f, clientVisible: vis, visibleClientIds: vis ? clientIds : null }
          : f
      )));

    // Each row's sharing as it stood before the optimistic patch. A selection
    // can mix hidden rows with rows shared to a subset of the matter's clients,
    // so a failure restores each to exactly this rather than to `!visible`.
    const prior = new Map(targets.map((item) => [
      item.id,
      { clientVisible: item.clientVisible, visibleClientIds: item.visibleClientIds },
    ]));
    const restore = (ids: Iterable<string>) => {
      const failed = new Set(ids);
      patchFiles((files) => files.map((f) => {
        const was = failed.has(f.id) ? prior.get(f.id) : undefined;
        return was ? { ...f, ...was } : f;
      }));
    };

    setPendingIds((prev) => new Set([...prev, ...targetIds]));
    setVisibility(targetIds, visible, visibleClientIds ?? null);

    // The sentence a partial or failed run shows. Built from ids rather than
    // from request outcomes: with one request per selection there is a single
    // outcome, and what varies is which files inside it the server applied.
    const failureMessage = (failedIds: string[]) => bulkFailureMessage(
      {
        succeeded: targets.filter((item) => !failedIds.includes(item.id)),
        failed: failedIds.map((id) => ({ item: id, error: null })),
      },
      visible ? "shared" : "removed from the portal",
      "files",
      "stayed unchanged",
    );

    try {
      // ONE request for the whole selection. This used to be a PATCH per file:
      // all of them at once, and then four at a time, which was bounded but
      // still a round trip per file against a Postgres pool every other request
      // on the instance shares.
      const result = await FilesService.setClientVisibilityBulk({
        lawFirmId,
        scope,
        fileIds: targets.map((item) => item.id),
        clientVisible: visible,
        visibleClientIds: visible ? visibleClientIds : undefined,
        notifyClient: notify,
      });

      const failedIds = result.failed || [];
      if (failedIds.length === 0) {
        onSuccess?.(visible ? "Shared with client portal" : "Removed from client portal");
        return;
      }

      // Roll back ONLY what the server named. The route applies what it can, so
      // reverting the whole selection would leave rows claiming the client
      // cannot see files the client can already see.
      restore(failedIds);

      // One row is the common case (the toggle on the row itself), and there the
      // server's own reason says more than counting to one does.
      if (targets.length === 1) {
        onError?.(result.errors?.[targets[0].id] || "Failed to update sharing");
        return;
      }
      onError?.(failureMessage(failedIds));
    } catch (error) {
      // The request itself failed, so nothing was applied and every optimistic
      // row goes back. This is the one case where reverting the whole selection
      // is right, and it is why the per-id rollback above is separate from it.
      restore(targetIds);
      if (targets.length === 1) {
        onError?.(getErrorMessage(error, "Failed to update sharing"));
        return;
      }
      onError?.(failureMessage(targets.map((item) => item.id)));
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        targetIds.forEach((id) => next.delete(id));
        return next;
      });
    }
  }, [canShare, lawFirmId, scope, patchFiles, onError, onSuccess]);

  // The recipient-picker step of sharing, run once the "is there anyone to
  // share with" check (in `share`, below) has passed or been overridden.
  const proceed = useCallback((items: FileInfo[], visible: boolean) => {
    const needsRecipients =
      visible && scope.type !== "client" && shareClients.length > 1;
    if (!needsRecipients) {
      void apply(items, visible);
      return;
    }
    // Re-sharing a single restricted item pre-selects its current audience;
    // anything else defaults to everyone.
    const single = items.length === 1 ? items[0] : null;
    const current = single?.clientVisible && single.visibleClientIds?.length
      ? single.visibleClientIds.filter((id) => shareClients.some((c) => c.id === id))
      : [];
    setPickerItems(items);
    setPickerInitialIds(current.length > 0 ? current : shareClients.map((c) => c.id));
    setPickerOpen(true);
  }, [scope.type, shareClients, apply]);

  const share = useCallback((items: FileInfo[], visible: boolean) => {
    if (!canShare) return;
    if (visible) {
      if (shareClients.length === 0) {
        setWarning({ kind: "no-client", items });
        return;
      }
      // Clients whose portal status this scope actually resolved. A scope
      // that never looked it up (every userId is `undefined`) has nothing
      // to warn about: that's "unknown", not "confirmed no one's on it".
      const known = shareClients.filter((c) => c.userId !== undefined);
      if (known.length > 0 && known.every((c) => !c.userId)) {
        setWarning({ kind: "no-portal", items });
        return;
      }
    }
    proceed(items, visible);
  }, [canShare, shareClients, proceed]);

  const confirmWarning = useCallback(() => {
    if (!warning) return;
    const items = warning.items;
    setWarning(null);
    proceed(items, true);
  }, [warning, proceed]);

  const dismissWarning = useCallback(() => setWarning(null), []);

  const confirm = useCallback((clientIds: string[], notify: boolean) => {
    // Every client selected means "no restriction", so clients added to the
    // matter later still see it.
    const restrict = clientIds.length === shareClients.length ? undefined : clientIds;
    void apply(pickerItems, true, restrict, notify);
    setPickerOpen(false);
    setPickerItems([]);
  }, [shareClients.length, pickerItems, apply]);

  return {
    canShare,
    pendingIds,
    picker: {
      open: pickerOpen,
      items: pickerItems,
      initialSelectedIds: pickerInitialIds,
      label: pickerItems.length === 1
        ? (pickerItems[0]?.displayName ?? pickerItems[0]?.name ?? "this item")
        : `${pickerItems.length} items`,
      close: () => setPickerOpen(false),
      confirm,
    },
    warning: warning ? {
      kind: warning.kind,
      itemLabel: warning.items.length === 1
        ? (warning.items[0]?.displayName ?? warning.items[0]?.name ?? "this item")
        : `${warning.items.length} items`,
      close: dismissWarning,
      confirm: confirmWarning,
    } : null,
    share,
  };
}
