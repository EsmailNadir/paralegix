"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import MattersService from "@/services/matters.service";
import TasksService from "@/services/tasks.service";
import type { FileInfo } from "@/services/files.service";
import type { FolderCrumb } from "@/lib/files/filePaths";
import type { Matter } from "@/types/matter";
import { findLinkedCompanyName } from "@/hooks/clientHooks/useClients";
import useClientTaskFiles from "@/hooks/fileHooks/useClientTaskFiles";
import FilesSection from "@/components/filesComp/FilesSection";
import ErrorNotification from "@/components/ErrorNotification";
import ClientPortalFilePreview from "@/components/filesComp/ClientPortalFilePreview";
import type { LinkedFolder } from "@/components/filesComp/FileRowList";
import type { ShareClient } from "@/components/filesComp/ClientSharePickerModal";
import Spinner from "@/components/ui/Spinner";
import StatusBadge from "@/components/ui/StatusBadge";
import TruncatedListNotice from "@/components/ui/TruncatedListNotice";

/** A matter or standalone task opened from the root of the client's files. */
type OpenArea = { kind: "matter" | "task"; id: string };

const fileCountLabel = (count: number) => (count ? `${count} file${count === 1 ? "" : "s"}` : "Empty");

/**
 * A client's Files view: a file browser over the client's own files, with each
 * of their matters and standalone tasks listed as a folder at its root. Opening
 * one moves the browser into that matter's or task's files, and the breadcrumb
 * leads back. `previewMode` shows what the client sees in their portal instead.
 */
export default function ClientFilesTab({
  previewMode,
  clientId,
  clientName,
  clientUserId,
  clientFiles,
  clientMatters,
  truncated,
  loading,
  lawFirmId,
  onFilesChanged,
  revealMatterId,
  revealTrail,
  revealHighlightId,
  companyNames,
}: {
  clientId: string;
  /** Names the recipient on the share badge for files in this client's own area. */
  clientName: string;
  /** Whether that client has a portal account; warns before sharing when they don't. */
  clientUserId?: string | null;
  clientFiles: Map<string, FileInfo[]>;
  clientMatters: Matter[];
  /** At least one matter's listing came back short, so this view is partial. */
  truncated: boolean;
  loading: boolean;
  lawFirmId: string;
  onFilesChanged: () => void;
  /** Set by "reveal this file" from the document requests tab: the matter
   *  whose file browser should open on mount, or null for the client's own
   *  file area (a General request's fulfillment). Undefined when no reveal
   *  is pending, in which case this tab opens exactly as it always has. */
  revealMatterId?: string | null;
  revealTrail?: FolderCrumb[];
  revealHighlightId?: string | null;
  /** Linked-company id -> name, naming why a matter pulled in from a company
   *  this client is linked to appears among its folders. */
  companyNames: Map<string, string>;
  /** Show what the client sees in their portal instead of the file browser. */
  previewMode: boolean;
}) {
  // The matter or task whose files the browser is in, or null for the client's
  // own. Initialized from a pending reveal so a "reveal this file" from the
  // document requests tab opens the right matter immediately, without an extra
  // click.
  const [openArea, setOpenArea] = useState<OpenArea | null>(
    revealMatterId ? { kind: "matter", id: revealMatterId } : null
  );
  // The open matter's or task's clients, so a share made in here names the same
  // recipients its own page would. Either can carry more clients than the one
  // whose page this is, so they're resolved rather than assumed.
  const [resolvedShare, setResolvedShare] = useState<{ areaKey: string; clients: ShareClient[] } | null>(null);
  // The area whose client list could not be read, and a counter bumped to read
  // it again.
  const [shareFailedKey, setShareFailedKey] = useState<string | null>(null);
  const [shareAttempt, setShareAttempt] = useState(0);

  const { tasks: clientTasks, loading: tasksLoading, reload: reloadTasks } = useClientTaskFiles({
    lawFirmId,
    clientId,
    enabled: !previewMode,
  });

  const openMatter = openArea?.kind === "matter" ? clientMatters.find((m) => m.id === openArea.id) ?? null : null;
  const openTask = openArea?.kind === "task" ? clientTasks.find((t) => t.id === openArea.id) ?? null : null;
  const areaKey = openArea ? `${openArea.kind}:${openArea.id}` : null;

  // Moving between areas re-reads the counts on the folders, which anything
  // done inside a browser (upload, delete, move) has just invalidated.
  const goTo = useCallback(
    (area: OpenArea | null) => {
      setOpenArea(area);
      onFilesChanged();
      void reloadTasks();
    },
    [onFilesChanged, reloadTasks]
  );

  // The folders at the root of the client's own files: every matter, then every
  // standalone task holding files. A matter's carries its number, its file
  // count, and the linked company that pulled it onto this client's page.
  const linkedFolders = useMemo<LinkedFolder[]>(
    () => [
      ...clientMatters.map((matterItem) => {
        const count = clientFiles.get(matterItem.id)?.length ?? 0;
        const companyName = findLinkedCompanyName(companyNames, matterItem.clients?.map((matterClient) => matterClient.id));
        const subtitle = [
          matterItem.matterNumber ? `#${matterItem.matterNumber}` : null,
          fileCountLabel(count),
          companyName ? `via ${companyName}` : null,
        ];
        return {
          id: matterItem.id,
          name: matterItem.name || "Unnamed Matter",
          subtitle: subtitle.filter(Boolean).join(" · "),
          badge: <StatusBadge variant="info">Matter</StatusBadge>,
          onOpen: () => goTo({ kind: "matter", id: matterItem.id }),
        };
      }),
      ...clientTasks.map((task) => ({
        id: task.id,
        name: task.title || "Untitled Task",
        subtitle: fileCountLabel(task.fileCount),
        badge: <StatusBadge variant="purple">Task</StatusBadge>,
        onOpen: () => goTo({ kind: "task", id: task.id }),
      })),
    ],
    [clientMatters, clientFiles, companyNames, clientTasks, goTo]
  );

  useEffect(() => {
    if (!openArea || !areaKey) return;
    let cancelled = false;
    const load: Promise<ShareClient[]> =
      openArea.kind === "matter"
        ? MattersService.listClients(lawFirmId, openArea.id).then((list) =>
            (list || []).map((c) => ({ id: c.id, name: c.name || "Client", userId: c.userId }))
          )
        : TasksService.getTask(lawFirmId, openArea.id).then((task) =>
            (task?.clientIds || []).map((id, i) => ({ id, name: task.clientNames?.[i] || "Client" }))
          );
    load
      .then((clients) => {
        if (!cancelled) setResolvedShare({ areaKey, clients });
      })
      .catch(() => {
        if (!cancelled) setShareFailedKey(areaKey);
      });
    return () => {
      cancelled = true;
    };
  }, [lawFirmId, openArea, areaKey, shareAttempt]);

  // The open area's clients, or null until they are known. There is no stand-in
  // meanwhile: a share made with only this client known is recorded with no
  // restriction, which reaches every client on the matter or task while the
  // badge names this one. The area's browser, and its share controls, wait.
  const areaShareClients = resolvedShare && resolvedShare.areaKey === areaKey ? resolvedShare.clients : null;

  const retryShareClients = () => {
    setShareFailedKey(null);
    setShareAttempt((n) => n + 1);
  };

  const backToClientFiles = { label: "Client Files", onOpen: () => goTo(null) };

  if (loading || tasksLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size={32} className="text-on-surface-muted" label="Loading client" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Sits above the browser: an incomplete scan would otherwise leave a
          matter folder's count reading lower than it is. */}
      {!previewMode && <TruncatedListNotice truncated={truncated} unitLabel="matter files" />}

      {previewMode ? (
        <ClientPortalFilePreview lawFirmId={lawFirmId} clientId={clientId} />
      ) : (openMatter || openTask) && !areaShareClients ? (
        shareFailedKey === areaKey ? (
          <ErrorNotification
            error={`Couldn't load this ${openMatter ? "matter" : "task"}'s clients, so its files can't be opened here yet.`}
            onRetry={retryShareClients}
            onClose={() => goTo(null)}
          />
        ) : (
          <div className="flex items-center justify-center py-12">
            <Spinner size={32} className="text-on-surface-muted" label="Loading files" />
          </div>
        )
      ) : openMatter && areaShareClients ? (
        /* One matter's files, managed exactly as they are on the matter itself */
        <FilesSection
          key={`matter:${openMatter.id}`}
          lawFirmId={lawFirmId}
          matterId={openMatter.id}
          rootLabel={openMatter.name || "Matter Files"}
          parentCrumb={backToClientFiles}
          shareClients={areaShareClients}
          // Only apply a pending reveal to the matter it actually targets:
          // browsing to a different matter than the one it named must not
          // borrow its folder position or flash.
          initialTrail={openMatter.id === revealMatterId ? revealTrail : undefined}
          highlightFileId={openMatter.id === revealMatterId ? revealHighlightId : undefined}
        />
      ) : openTask && areaShareClients ? (
        /* One standalone task's files, managed exactly as they are on the task itself */
        <FilesSection
          key={`task:${openTask.id}`}
          lawFirmId={lawFirmId}
          taskId={openTask.id}
          rootLabel={openTask.title || "Task Files"}
          parentCrumb={backToClientFiles}
          shareClients={areaShareClients}
        />
      ) : (
        <FilesSection
          key="client"
          lawFirmId={lawFirmId}
          clientId={clientId}
          rootLabel="Client Files"
          rootFolders={linkedFolders}
          // A client's own area has exactly one recipient: that client. Naming
          // them here is what lets the share badge read "Visible to <name>"
          // instead of warning that nobody can see the file.
          shareClients={[{ id: clientId, name: clientName, userId: clientUserId }]}
          // A pending reveal with no matter (a General request's file)
          // belongs here, in the client's own area.
          initialTrail={revealMatterId == null ? revealTrail : undefined}
          highlightFileId={revealMatterId == null ? revealHighlightId : undefined}
        />
      )}
    </div>
  );
}
