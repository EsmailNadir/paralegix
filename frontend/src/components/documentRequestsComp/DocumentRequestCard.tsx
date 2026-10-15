"use client";

import { CheckCircle2, FileText, Paperclip, RotateCcw, Trash2, XCircle } from "lucide-react";
import ActionIconButton from "@/components/ui/ActionIconButton";
import { formatDateOnly } from "@/lib/utils/dateUtils";
import type { DocumentRequest, DocumentRequestItemStatus, Fulfillment } from "@/services/documentRequests.service";
import StatusBadge from "@/components/ui/StatusBadge";
import { documentRequestStatusMeta, documentRequestItemStatusMeta, styleOf } from "@/constants/statusMeta";

const ITEM_STATUSES: DocumentRequestItemStatus[] = ["pending", "received", "waived"];

interface DocumentRequestCardProps {
  request: DocumentRequest;
  /** Resolved display name for `request.clientId`, e.g. "For {clientName}". */
  clientName: string;
  canManage: boolean;
  requestBusy: boolean;
  /** Id of the item currently mid-mutation (status change, link, unlink), if any. */
  busyItemId: string | null;
  onSetRequestStatus: (request: DocumentRequest, status: DocumentRequest["status"]) => void;
  onDelete: (request: DocumentRequest) => void;
  onSetItemStatus: (request: DocumentRequest, itemId: string, status: DocumentRequestItemStatus) => void;
  onOpenFilePicker: (request: DocumentRequest, itemId: string) => void;
  onUnlinkFile: (request: DocumentRequest, itemId: string, fulfillmentId: string) => void;
  /** Switch to the Files tab, open the folder a fulfillment's file lives in,
   *  and briefly flash it. */
  onRevealFile?: (objectPath: string) => void;
  /** The backend rejects linking an existing file onto a request with no
   *  matter (a "General" request has no matter file area to link from), so
   *  the client-detail aggregate view suppresses this control there. Defaults
   *  to true, matching the existing per-matter behavior. */
  allowFileLink?: boolean;
}

/**
 * One document request: header (title, status, client, due date), note, and
 * checklist items with their per-item status controls and fulfilled files.
 *
 * Shared by the per-matter `DocumentRequestsPanel` and the client-detail
 * aggregate tab, so both surfaces render and behave identically.
 */
export default function DocumentRequestCard({
  request,
  clientName,
  canManage,
  requestBusy,
  busyItemId,
  onSetRequestStatus,
  onDelete,
  onSetItemStatus,
  onOpenFilePicker,
  onUnlinkFile,
  onRevealFile,
  allowFileLink = true,
}: DocumentRequestCardProps) {
  return (
    <div className="rounded-lg border border-outline bg-surface overflow-hidden">
      {/* Card header. Tinted like the client-portal request panel's own header
          row, so the title reads as this card's title bar rather than blending
          into the checklist below it. */}
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 border-b border-outline-subtle bg-surface-alt/60">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold text-on-surface truncate">{request.title}</h4>
            <StatusBadge variant={documentRequestStatusMeta(request.status).variant}>
              {documentRequestStatusMeta(request.status).label}
            </StatusBadge>
          </div>
          <p className="mt-1 text-xs text-on-surface-secondary">
            For {clientName}
            {request.dueDate && (
              <>
                {" · "}Due {formatDateOnly(request.dueDate, { year: "numeric", month: "short", day: "numeric" })}
              </>
            )}
          </p>
        </div>

        {canManage && request.status === "open" && (
          <div className="flex items-center gap-1 shrink-0">
            <ActionIconButton
              label="Mark completed"
              onClick={() => onSetRequestStatus(request, "completed")}
              disabled={requestBusy}
              tone="success"
            >
              <CheckCircle2 size={16} />
            </ActionIconButton>
            <ActionIconButton
              label="Cancel request"
              onClick={() => onSetRequestStatus(request, "cancelled")}
              disabled={requestBusy}
              tone="warning"
            >
              <XCircle size={16} />
            </ActionIconButton>
            <ActionIconButton
              label="Delete request"
              onClick={() => onDelete(request)}
              disabled={requestBusy}
              tone="danger"
            >
              <Trash2 size={16} />
            </ActionIconButton>
          </div>
        )}

        {canManage && request.status !== "open" && (
          <div className="flex items-center gap-1 shrink-0">
            <ActionIconButton
              label="Reopen request"
              tooltip="Reopen: an item's status can otherwise silently re-complete this later"
              onClick={() => onSetRequestStatus(request, "open")}
              disabled={requestBusy}
            >
              <RotateCcw size={16} />
            </ActionIconButton>
            <ActionIconButton
              label="Delete request"
              onClick={() => onDelete(request)}
              disabled={requestBusy}
              tone="danger"
            >
              <Trash2 size={16} />
            </ActionIconButton>
          </div>
        )}
      </div>

      {/* Note. Bordered off from the checklist below so it reads as context
          about the request, not one more item in the list. */}
      {request.note && (
        <p className="px-4 py-3 border-b border-outline-subtle text-sm text-on-surface-secondary whitespace-pre-wrap">
          {request.note}
        </p>
      )}

      {/* Checklist */}
      <ul className="divide-y divide-outline-subtle px-4 py-2">
        {request.items.length === 0 && (
          <li className="py-2 text-sm text-on-surface-muted italic">No items on this request.</li>
        )}
        {request.items.map((item) => {
          const itemBusy = busyItemId === item.id;
          return (
            <li key={item.id} className="py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm text-on-surface">{item.label}</span>
                    <StatusBadge variant={documentRequestItemStatusMeta(item.status).variant}>
                      {documentRequestItemStatusMeta(item.status).label}
                    </StatusBadge>
                  </div>
                  {item.description && (
                    <p className="mt-0.5 text-xs text-on-surface-secondary whitespace-pre-wrap">{item.description}</p>
                  )}
                </div>

                {canManage && (
                  <div className="flex items-center gap-1 shrink-0">
                    {allowFileLink && (
                      <ActionIconButton
                        label="Link an existing file"
                        onClick={() => onOpenFilePicker(request, item.id)}
                        disabled={itemBusy}
                      >
                        <Paperclip size={14} />
                      </ActionIconButton>
                    )}
                    {ITEM_STATUSES.map((status) => (
                      <button
                        key={status}
                        onClick={() => onSetItemStatus(request, item.id, status)}
                        disabled={itemBusy || item.status === status}
                        className={`px-2 py-1 text-xs font-medium rounded-md border transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer capitalize disabled:cursor-not-allowed ${
                          item.status === status
                            ? `${styleOf(documentRequestItemStatusMeta(status)).tint} ${styleOf(documentRequestItemStatusMeta(status)).text} border-outline-subtle opacity-100`
                            : "bg-surface border-outline-subtle text-on-surface-secondary hover:bg-surface-hover disabled:opacity-40"
                        }`}
                      >
                        {status}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {item.fulfillments.length > 0 && (
                <ItemFulfillments
                  fulfillments={item.fulfillments}
                  canManage={canManage}
                  busy={itemBusy}
                  onUnlink={(fulfillmentId) => onUnlinkFile(request, item.id, fulfillmentId)}
                  onRevealFile={onRevealFile}
                />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The files fulfilling one checklist item. */
function ItemFulfillments({
  fulfillments,
  canManage,
  busy,
  onUnlink,
  onRevealFile,
}: {
  fulfillments: Fulfillment[];
  canManage: boolean;
  busy: boolean;
  onUnlink: (fulfillmentId: string) => void;
  onRevealFile?: (objectPath: string) => void;
}) {
  return (
    <ul className="mt-2 space-y-1 pl-1">
      {fulfillments.map((f) => (
        <li
          key={f.id}
          className="group flex flex-wrap items-center gap-x-2 text-xs text-on-surface-secondary"
        >
          <FileText size={13} className="shrink-0 text-on-surface-muted" />
          {onRevealFile ? (
            <button
              type="button"
              onClick={() => onRevealFile(f.objectPath)}
              className="text-on-surface truncate hover:underline cursor-pointer"
            >
              {f.fileName}
            </button>
          ) : (
            <span className="text-on-surface truncate">{f.fileName}</span>
          )}
          <span className="text-on-surface-muted">
            {f.uploadedByName ? `${f.uploadedByName} · ` : ""}
            {formatDateOnly(f.uploadedAt, { year: "numeric", month: "short", day: "numeric" })}
          </span>
          {canManage && (
            <ActionIconButton
              label="Remove file"
              onClick={() => onUnlink(f.id)}
              disabled={busy}
              tone="danger"
              size="sm"
              className="opacity-0 group-hover:opacity-100"
            >
              <Trash2 size={12} />
            </ActionIconButton>
          )}
        </li>
      ))}
    </ul>
  );
}
