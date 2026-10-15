'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileSignature, Search } from 'lucide-react';
import ConfirmModal from '@/components/ui/ConfirmModal';
import ErrorToast from '@/components/ui/ErrorToast';
import ListEmptyState from '@/components/ui/ListEmptyState';
import ListBusyIndicator from '@/components/ui/ListBusyIndicator';
import ListPager, { DEFAULT_ROWS_PER_PAGE_OPTIONS } from '@/components/ui/ListPager';
import ListSkeleton from '@/components/ui/ListSkeleton';
import ListToolbar from '@/components/ui/ListToolbar';
import SegmentedToggle from '@/components/ui/SegmentedToggle';
import SearchInput from "@/components/ui/SearchInput";
import { usePermissions } from '@/contexts/PermissionsContext';
import signaturesService from '@/services/signatures.service';
import type {
  SigningParticipantSummary,
  SigningSession,
  SigningSessionSummary,
} from '@/types/signature';
import SigningPreviewModal, { type SigningPreviewKind } from './SigningPreviewModal';
import SigningSessionRow from './SigningSessionRow';
import { remindChannelLabel, signerDisplayName } from './sessionPresentation';
import { getErrorMessage } from '@/lib/utils/apiErrors';
import Button from '@/components/ui/Button';

/**
 * How long before the same signer can be reminded again.
 *
 * An hour, not a minute: a reminder is an email (or a portal notification) landing
 * with a client, and a control that lets you send another one a minute later
 * invites exactly the nagging the signer will remember. The automated reminder
 * sweep uses a 24-hour guard for the same reason (`signingReminders.service.js`).
 */
const REMIND_COOLDOWN_MINUTES = 60;

/**
 * How often the remaining wait is recomputed. Coarse on purpose: the label is
 * shown in whole minutes, so ticking every second would re-render the whole list
 * 3,600 times to change the text 60 times.
 */
const COOLDOWN_TICK_MS = 10_000;

/**
 * The status filters, in the order a firm reaches for them. '' is "no filter";
 * 'not_completed' is the server's synthetic "anything still outstanding".
 *
 * The three states every firm has are always offered. The endings - voided,
 * declined, expired - appear only once the firm has one, so a firm that has never
 * had a document declined is not asked to consider it.
 */
const STATUS_FILTERS: Array<{
  value: string;
  label: string;
  count: (summary: SigningSessionSummary) => number;
  alwaysShow?: boolean;
}> = [
  { value: '', label: 'All', count: (s) => s.total, alwaysShow: true },
  { value: 'not_completed', label: 'Outstanding', count: (s) => s.notCompleted, alwaysShow: true },
  { value: 'completed', label: 'Completed', count: (s) => s.counts.completed ?? 0, alwaysShow: true },
  { value: 'cancelled', label: 'Voided', count: (s) => s.counts.cancelled ?? 0 },
  { value: 'declined', label: 'Declined', count: (s) => s.counts.declined ?? 0 },
  { value: 'expired', label: 'Expired', count: (s) => s.counts.expired ?? 0 },
];

interface SigningSessionListProps {
  lawFirmId: string;
  sessions: SigningSession[];
  /** Size of the whole filtered history, not of `sessions`. */
  totalItems: number;
  summary: SigningSessionSummary;
  isLoading: boolean;
  isFetching: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  statusFilter: string;
  onStatusFilterChange: (value: string) => void;
  page: number;
  rowsPerPage: number;
  onPageChange: (page: number) => void;
  onRowsPerPageChange: (rowsPerPage: number) => void;
  onDownloadCertificate: (token: string) => void;
  onCancelSession: (token: string) => void;
  onSignNow: (token: string) => void;
  downloadingCert: string | null;
  cancellingSession: string | null;
}

/**
 * The firm's signing sessions: search, status filters, and a paged list of rows,
 * most recent activity first.
 *
 * This is the whole history rather than a preview of it. The page used to show
 * the five most recent sessions with a "Show all" link to a second page that
 * rendered the same list again with the controls switched on, so the firm's
 * signing record lived in two places that had to be kept in step. One paged list
 * with the controls always present is both less code and less to learn.
 */
export default function SigningSessionList({
  lawFirmId,
  sessions,
  totalItems,
  summary,
  isLoading,
  isFetching,
  search,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  page,
  rowsPerPage,
  onPageChange,
  onRowsPerPageChange,
  onDownloadCertificate,
  onCancelSession,
  onSignNow,
  downloadingCert,
  cancellingSession,
}: SigningSessionListProps) {
  const { hasPermission } = usePermissions();
  // The filing location is only a link for someone who can open the files page it
  // points at; everyone else keeps it as plain text.
  const canOpenDestination = hasPermission('files.view');
  const canSend = hasPermission('signatures.send');

  const [voidTarget, setVoidTarget] = useState<string | null>(null);
  // Mirrors the footer's own click acknowledgement, so the inline indicator
  // stays quiet while the pager button already carries the wait.
  const [pagerPending, setPagerPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Signed-document download state, keyed by token so only the clicked control
  // shows a spinner.
  const [downloadingDocument, setDownloadingDocument] = useState<string | null>(null);
  // What is being read in the preview dialog. Held as its own object so the dialog
  // still has a title while its close animation plays.
  const [previewTarget, setPreviewTarget] = useState<
    { token: string; fileName: string; kind: SigningPreviewKind } | null
  >(null);

  // When each signer may be reminded again, as an epoch ms. Held as an expiry
  // rather than a countdown so one clock can serve every signer.
  const [remindUntil, setRemindUntil] = useState<Record<string, number>>({});
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [remindTarget, setRemindTarget] = useState<{
    sessionToken: string;
    fileName: string;
    signer: SigningParticipantSummary;
  } | null>(null);
  const [sendingRemind, setSendingRemind] = useState(false);

  // Only runs while something is actually cooling down, and stops on its own once
  // the last expiry passes.
  const hasCooldowns = Object.keys(remindUntil).length > 0;
  useEffect(() => {
    if (!hasCooldowns) return;
    const id = setInterval(() => setClockNow(Date.now()), COOLDOWN_TICK_MS);
    return () => clearInterval(id);
  }, [hasCooldowns]);

  /** Seconds left per signer, expired entries dropped. */
  const remindCooldowns = useMemo(() => {
    const remaining: Record<string, number> = {};
    for (const [participantId, until] of Object.entries(remindUntil)) {
      const seconds = Math.ceil((until - clockNow) / 1000);
      if (seconds > 0) remaining[participantId] = seconds;
    }
    return remaining;
  }, [remindUntil, clockNow]);

  const handleDownloadDocument = useCallback(async (token: string) => {
    setDownloadingDocument(token);
    setActionError(null);
    try {
      await signaturesService.downloadSignedDocument(token);
    } catch (err) {
      setActionError(getErrorMessage(err, 'Failed to download the signed document'));
    } finally {
      setDownloadingDocument(null);
    }
  }, []);

  const performRemind = useCallback(async () => {
    if (!remindTarget) return;
    const { sessionToken, signer } = remindTarget;
    const participantId = signer.participantId;
    if (remindCooldowns[participantId]) { setRemindTarget(null); return; }

    setSendingRemind(true);
    setActionError(null);
    try {
      await signaturesService.resendParticipant(lawFirmId, sessionToken, participantId);
      setRemindUntil((prev) => ({
        ...prev,
        [participantId]: Date.now() + REMIND_COOLDOWN_MINUTES * 60_000,
      }));
      setClockNow(Date.now());
    } catch (err) {
      setActionError(getErrorMessage(err, 'Failed to send the reminder'));
    } finally {
      setSendingRemind(false);
      setRemindTarget(null);
    }
  }, [lawFirmId, remindTarget, remindCooldowns]);

  const visibleFilters = useMemo(
    () => STATUS_FILTERS
      .filter((filter) => filter.alwaysShow || filter.value === statusFilter || filter.count(summary) > 0)
      .map((filter) => ({
        value: filter.value,
        label: filter.label,
        // Left off until the counts have actually arrived; a row of filters all
        // reading 0 says the firm has no documents, which is a different claim
        // from "we don't know yet".
        count: summary.total > 0 ? filter.count(summary) : undefined,
      })),
    [statusFilter, summary]
  );

  const isFiltering = !!search || !!statusFilter;
  const totalPages = Math.max(1, Math.ceil(totalItems / Math.max(1, rowsPerPage)));

  // Nothing has ever been sent for signature: the filters and search would have
  // nothing to act on, so the empty state takes the whole space instead. It points
  // at the send panel above rather than repeating its button. Both counts have to
  // agree - the summary resolves to zeroes when it fails, and a failed count must
  // not hide a list that loaded.
  if (!isLoading && totalItems === 0 && summary.total === 0 && !isFiltering) {
    return (
      <ListEmptyState
        icon={<FileSignature size={40} />}
        title="No documents sent for signature yet"
        message="Send one above to get started. Everything you send shows up here with its signing status, who it is waiting on, and where the executed copy was filed."
      />
    );
  }

  return (
    <div className="space-y-4">
      <ListToolbar>
        <div className="flex flex-col gap-3">
          <SearchInput
            size="sm"
            placeholder="Search by document, client, or signer..."
            aria-label="Search signing sessions"
            value={search}
            onChange={(next) => onSearchChange(next)}
            onClear={() => onSearchChange('')}
          />

          <div className="flex items-center gap-3">
            {/* Scrolls rather than wraps: the filters read as one control, and a
                wrapped second row of them next to the search box reads as two. */}
            <div className="-mx-1 min-w-0 flex-1 overflow-x-auto px-1 py-px scrollbar-hide">
              <SegmentedToggle
                options={visibleFilters}
                value={statusFilter}
                onChange={onStatusFilterChange}
                ariaLabel="Filter by signing status"
              />
            </div>
            {/* Keep the background-fetch acknowledgement immediately before the
                stale count at the far right of the row. */}
            <ListBusyIndicator
              busy={isFetching && !isLoading && !pagerPending}
              className="hidden sm:flex"
            />
            <p className="hidden shrink-0 text-xs text-on-surface-muted sm:block">
              {isFiltering
                ? `${totalItems} of ${summary.total} document${summary.total !== 1 ? 's' : ''}`
                : `${summary.total} document${summary.total !== 1 ? 's' : ''}`}
            </p>
          </div>
        </div>
      </ListToolbar>

      {isLoading ? (
        <ListSkeleton rows={Math.min(rowsPerPage, 8)} label="Loading signing sessions" />
      ) : sessions.length === 0 ? (
        <ListEmptyState
          compact
          icon={<Search size={36} />}
          title="No sessions match these filters"
          message="Try a different search term, or widen the status filter."
          action={(
            <Button
              type="secondary"
              onClick={() => { onSearchChange(''); onStatusFilterChange(''); }}
            >
              Clear filters
            </Button>
          )}
        />
      ) : (
        <div>
          {/* One card per session, on the same `gap-3` rhythm as the template grid.
              Single-column rather than the template grid's 2/3 columns: a session
              carries a status, a signer summary, a progress meter and up to three
              actions, none of which fit beside each other in a third of the page. */}
          <div className="grid grid-cols-1 gap-3">
            {sessions.map((session) => {
              const sessionKey = session.sessionToken || session.token;
              return (
                <SigningSessionRow
                  key={session.token}
                  session={session}
                  lawFirmId={lawFirmId}
                  canOpenDestination={canOpenDestination}
                  canSend={canSend}
                  onSignNow={onSignNow}
                  onPreview={(kind) => setPreviewTarget({ token: session.token, fileName: session.fileName, kind })}
                  onDownloadDocument={() => handleDownloadDocument(session.token)}
                  onVoid={() => setVoidTarget(sessionKey)}
                  onRemind={(signer) => setRemindTarget({ sessionToken: sessionKey, fileName: session.fileName, signer })}
                  remindCooldowns={remindCooldowns}
                  downloadingDocument={downloadingDocument === session.token}
                  voiding={cancellingSession === sessionKey}
                />
              );
            })}
          </div>

          <div className="px-1 pt-4">
            <ListPager
              page={page}
              totalPages={totalPages}
              total={totalItems}
              rowsPerPage={rowsPerPage}
              onPageChange={onPageChange}
              rowsPerPageOptions={DEFAULT_ROWS_PER_PAGE_OPTIONS}
              onRowsPerPageChange={onRowsPerPageChange}
              busy={isFetching}
              onPendingChange={setPagerPending}
              serverPaged
            />
          </div>
        </div>
      )}

      <ConfirmModal
        isOpen={!!voidTarget}
        title="Void Signing Session"
        message="This will cancel the signing session and notify all pending signers. Completed signatures will be preserved. This cannot be undone."
        confirmText="Void Session"
        confirmType="danger"
        onConfirm={() => {
          if (voidTarget) onCancelSession(voidTarget);
          setVoidTarget(null);
        }}
        onClose={() => setVoidTarget(null)}
      />

      <ConfirmModal
        isOpen={!!remindTarget}
        title="Send a reminder?"
        message={remindTarget
          ? `We'll re-send the signing request to ${signerDisplayName(remindTarget.signer)} ${remindChannelLabel(remindTarget.signer)}, reminding them to review and sign "${remindTarget.fileName}". You can send another reminder after ${REMIND_COOLDOWN_MINUTES} minutes.`.replace(/\s+/g, ' ').trim()
          : ''}
        confirmText="Send Reminder"
        confirmType="primary"
        loading={sendingRemind}
        onConfirm={performRemind}
        onClose={() => setRemindTarget(null)}
      />

      {/* Reader for both of a session's PDFs: the executed document and the
          certificate of completion. Each still downloads from inside the dialog. */}
      <SigningPreviewModal
        isOpen={!!previewTarget}
        kind={previewTarget?.kind ?? 'document'}
        token={previewTarget?.token ?? null}
        fileName={previewTarget?.fileName ?? null}
        downloading={
          previewTarget?.kind === 'certificate'
            ? downloadingCert === previewTarget?.token
            : downloadingDocument === previewTarget?.token
        }
        onClose={() => setPreviewTarget(null)}
        onDownload={() => {
          if (!previewTarget) return;
          if (previewTarget.kind === 'certificate') onDownloadCertificate(previewTarget.token);
          else handleDownloadDocument(previewTarget.token);
        }}
      />

      {actionError && <ErrorToast message={actionError} onDismiss={() => setActionError(null)} />}
    </div>
  );
}
