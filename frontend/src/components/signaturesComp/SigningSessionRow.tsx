'use client';

import { useId, useState } from 'react';
import Tooltip from "@/components/ui/Tooltip";
import {
  Award,
  Bell,
  ChevronRight,
  Download,
  Eye,
  FolderOpen,
  PenLine,
  XCircle,
} from 'lucide-react';
import RowActionMenu, { type RowAction } from '@/components/ui/RowActionMenu';
import Spinner from '@/components/ui/Spinner';
import StatusBadge from '@/components/ui/StatusBadge';
import { useNavigation } from '@/contexts/NavigationContext';
import type { SigningParticipantSummary, SigningSession } from '@/types/signature';
import type { SigningPreviewKind } from './SigningPreviewModal';
import {
  deliveredVia,
  formatSessionDateTime,
  isSessionOpen,
  participantStatusMeta,
  formatRemindCooldown,
  savedToHref,
  savedToLabel,
  sessionStatusMeta,
  sessionSummaryLine,
  signerDisplayName,
} from './sessionPresentation';

/** Above this many signers the segmented meter stops reading as a glance. */
const MAX_PROGRESS_SEGMENTS = 6;

interface SigningSessionRowProps {
  session: SigningSession;
  lawFirmId?: string;
  /** Whether the filing location should be a link into the file browser. */
  canOpenDestination: boolean;
  /** Whether the viewer holds `signatures.send`, so a Remind can actually go out. */
  canSend: boolean;
  onSignNow: (token: string) => void;
  onPreview: (kind: SigningPreviewKind) => void;
  onDownloadDocument: () => void;
  onVoid: () => void;
  onRemind: (signer: SigningParticipantSummary) => void;
  /** Seconds left before each participant can be reminded again. */
  remindCooldowns: Record<string, number>;
  downloadingDocument: boolean;
  voiding: boolean;
}

/** The multi-signer completion meter: one segment per signer, filled as they sign. */
function SignerProgress({ done, total }: { done: number; total: number }) {
  return (
    <div className="hidden shrink-0 items-center gap-2 sm:flex">
      {total <= MAX_PROGRESS_SEGMENTS && (
        <span className="flex items-center gap-0.5" aria-hidden>
          {Array.from({ length: total }).map((_, index) => (
            <span
              key={index}
              className={`h-1.5 w-4 rounded-full ${index < done ? 'bg-on-surface-secondary' : 'bg-outline'}`}
            />
          ))}
        </span>
      )}
      <span className="whitespace-nowrap text-xs font-medium tabular-nums text-on-surface-secondary">
        {done}/{total} signed
      </span>
    </div>
  );
}

/**
 * One signing session in the firm's list: a fixed two-line summary that opens
 * into the full record.
 *
 * The row is deliberately the same height whoever is on it. Rendering every
 * signer inline made a three-signer session five times the height of a one-signer
 * session, so a page of them had no rhythm to scan down and the eye had to
 * re-find the file name on every row. The signer track, the timestamps and the
 * filing location all live in the disclosure instead - reachable in one click, and
 * out of the way of "what happened to my documents lately".
 */
export default function SigningSessionRow({
  session,
  lawFirmId,
  canOpenDestination,
  canSend,
  onSignNow,
  onPreview,
  onDownloadDocument,
  onVoid,
  onRemind,
  remindCooldowns,
  downloadingDocument,
  voiding,
}: SigningSessionRowProps) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const { navigate } = useNavigation();

  const { label: statusLabel, variant, Icon } = sessionStatusMeta(session.status);
  const isSigned = session.status === 'completed';
  const isOpen = isSessionOpen(session.status);
  const sessionKey = session.sessionToken || session.token;

  const signers = (session.signers || []).slice().sort((a, b) => a.order - b.order);
  const totalSigners = session.totalParticipants || 0;
  const completedSigners = session.completedParticipants || 0;
  // Signers the request has actually reached. Anyone still queued behind them
  // cannot be reminded of a document they have not been sent.
  const awaitingSigners = signers.filter((signer) => signer.status === 'active');
  const soleAwaitingSigner = isOpen && awaitingSigners.length === 1 ? awaitingSigners[0] : null;
  const soleAwaitingCooldown = soleAwaitingSigner
    ? remindCooldowns[soleAwaitingSigner.participantId]
    : undefined;

  const destinationHref = lawFirmId
    ? (session.destination
        ? savedToHref(lawFirmId, session.destination)
        : savedToHref(lawFirmId, { scope: 'firm', folderPath: '' }))
    : null;

  // The row's secondary actions, defined once and rendered two ways: as buttons on
  // the row from `lg` up, and as the three-dot menu below it. One definition so the
  // wide and narrow layouts cannot end up offering different things.
  // The filing location is deliberately not here: the disclosure's "Filed in"
  // field already names the folder and links to it, so a second copy on the row
  // only crowds the actions.
  const secondaryActions: Array<RowAction & {
    /** Inline appearance. The menu renders every entry the same way. */
    tone?: 'primary' | 'danger';
    /** Replaces the inline icon while the action is running. */
    busy?: boolean;
  }> = [];

  if (isSigned) {
    secondaryActions.push({
      label: 'Download',
      icon: <Download size={14} />,
      onClick: onDownloadDocument,
      tone: 'primary',
      busy: downloadingDocument,
    });
    secondaryActions.push({
      label: 'Certificate',
      icon: <Award size={14} />,
      onClick: () => onPreview('certificate'),
    });
  }

  if (isOpen) {
    secondaryActions.push({
      label: 'Void',
      icon: <XCircle size={14} />,
      onClick: onVoid,
      danger: true,
      tone: 'danger',
    });
  }

  /**
   * The outlined buttons carry their own `bg-surface` rather than inheriting the
   * row's.
   *
   * `--outline` (#2a2a2a dark) is only a few shades off `--surface-hover`
   * (#242424), so on a hovered row a transparent button's border sat on almost
   * exactly its own colour and vanished. Keeping the button on the base surface
   * holds that contrast, and their own hover brightens the border rather than the
   * fill so the pointed-at button never blends into the band either.
   */
  const inlineActionClass = (tone?: 'primary' | 'danger') => {
    if (tone === 'primary') {
      return 'bg-accent-solid text-accent-foreground hover:bg-accent-solid-hover disabled:opacity-50';
    }
    if (tone === 'danger') {
      return 'border border-outline bg-surface text-on-surface-secondary hover:border-red-400 hover:bg-surface-alt hover:text-red-600 dark:hover:border-red-500/60 dark:hover:text-red-400';
    }
    return 'border border-outline bg-surface text-on-surface hover:border-on-surface-muted hover:bg-surface-alt';
  };

  return (
    // Same card as a signing template: `rounded-xl border border-outline bg-surface
    // p-4`. The padding sits on the header rather than the card so the disclosure
    // below it can span the full width.
    <div className="overflow-hidden rounded-xl border border-outline bg-surface">
      {/* The hover belongs to the header, not the card. On the card it also lit up
          the open disclosure below, which made the whole thing look clickable when
          only this band toggles. */}
      <div className="flex items-center gap-3 p-4 transition-colors hover:bg-surface-hover">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-controls={panelId}
          // Negative margins pull the hit area out to the header's edges and its own
          // padding puts the content back, so the whole band left of the actions
          // toggles - not just the text.
          className="-my-4 -ml-4 flex min-w-0 flex-1 items-center gap-3 py-4 pl-4 text-left cursor-pointer"
        >
          <ChevronRight
            size={15}
            className={`shrink-0 text-on-surface-muted transition-transform duration-200 motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`}
          />
          {/* The tile carries the status for assistive tech at every width, which
              is what lets the badge beside the file name be dropped on narrow
              screens without the status going with it. */}
          <span
            role="img"
            aria-label={statusLabel}
            className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-alt text-on-surface-secondary"
          >
            <Icon size={17} strokeWidth={2} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-semibold text-on-surface">{session.fileName}</span>
              {/* Hidden on mobile: a fixed-width badge there costs the file name
                  the characters that tell two documents apart. */}
              <span aria-hidden className="hidden shrink-0 sm:inline-flex">
                <StatusBadge variant={variant}>{statusLabel}</StatusBadge>
              </span>
            </span>
            <span className="mt-0.5 block truncate text-xs text-on-surface-muted sm:mt-px">
              {sessionSummaryLine(session)}
            </span>
          </span>
        </button>

        {totalSigners > 1 && <SignerProgress done={completedSigners} total={totalSigners} />}

        <div className="flex shrink-0 items-center gap-1.5">
          {session.readyForCurrentUser && !isSigned && (
            <button
              type="button"
              onClick={() => onSignNow(session.currentUserSigningToken || sessionKey)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent-solid px-2.5 py-1.5 text-xs font-medium text-accent-foreground transition-[background-color,transform] hover:bg-accent-solid-hover active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            >
              <PenLine size={13} />
              Sign now
            </button>
          )}

          {isSigned && (
            <Tooltip title="View signed document" enterDelay={300}>
              <button
                type="button"
                onClick={() => onPreview('document')}
                // Labelled explicitly because the text drops away on narrow
                // screens, leaving an unnamed icon button.
                aria-label="View signed document"
                className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer ${inlineActionClass()}`}
              >
                <Eye size={13} />
                <span className="hidden sm:inline">View</span>
              </button>
            </Tooltip>
          )}

          {canSend && soleAwaitingSigner && !session.readyForCurrentUser && (
            <Tooltip
              title={soleAwaitingCooldown
                ? `Just reminded, you can send another in ${formatRemindCooldown(soleAwaitingCooldown)}`
                : `Remind ${signerDisplayName(soleAwaitingSigner)}`}
              enterDelay={300}
            >
              <span>
                <button
                  type="button"
                  onClick={() => onRemind(soleAwaitingSigner)}
                  disabled={!!soleAwaitingCooldown}
                  aria-label={`Remind ${signerDisplayName(soleAwaitingSigner)}`}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 disabled:cursor-not-allowed disabled:text-on-surface-muted cursor-pointer ${inlineActionClass()}`}
                >
                  <Bell size={13} />
                  <span className="hidden sm:inline">
                    {soleAwaitingCooldown ? `Wait ${formatRemindCooldown(soleAwaitingCooldown)}` : 'Remind'}
                  </span>
                </button>
              </span>
            </Tooltip>
          )}

          {voiding ? (
            <span className="grid size-7 place-items-center">
              <Spinner size={14} className="text-on-surface-muted" />
            </span>
          ) : secondaryActions.length > 0 && (
            <>
              {/* Wide screens have the room to put every action on the row, which
                  is one click instead of two. Narrow ones fold them into the
                  three-dot menu rather than shrinking the file name to fit. */}
              <div className="hidden items-center gap-1.5 lg:flex">
                {secondaryActions.map((action) => (
                  <Tooltip key={action.label} title={action.label} enterDelay={300}>
                    <button
                      type="button"
                      onClick={action.onClick}
                      disabled={action.busy}
                      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-medium transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer ${inlineActionClass(action.tone)}`}
                    >
                      {action.busy ? <Spinner size={13} /> : action.icon}
                      {action.label}
                    </button>
                  </Tooltip>
                ))}
              </div>
              <div className="lg:hidden">
                <RowActionMenu actions={secondaryActions} />
              </div>
            </>
          )}
        </div>
      </div>

      {/* Animating grid-template-rows keeps the disclosure a CSS transition in both
          directions without measuring the panel's height in JS. */}
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
          expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        {/* The panel stays mounted so the transition has something to animate, so
            while it is closed it has to be taken out of the page properly: `inert`
            is what stops Tab from landing on controls nobody can see. */}
        <div id={panelId} className="overflow-hidden" inert={!expanded}>
          {/* Tinted so the detail reads as a drawer inside the card rather than as
              more of the row. */}
          <div className="space-y-4 border-t border-outline-subtle bg-surface-alt/40 p-4">
            {signers.length > 0 && (
              <ol className="space-y-1.5">
                {signers.map((signer, index) => {
                  const meta = participantStatusMeta(signer.status);
                  const cooldown = remindCooldowns[signer.participantId];
                  const canRemind = canSend && isOpen && lawFirmId
                    && (signer.status === 'active' || signer.status === 'waiting');

                  return (
                    <li
                      key={signer.participantId}
                      // `bg-surface-alt`, not `bg-surface`: in dark mode surface
                      // (#141414) is darker than the drawer's tint, so a signer row
                      // on it sank into a black hole instead of sitting on top.
                      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-outline-subtle bg-surface-alt px-3 py-2"
                    >
                      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-surface-alt text-[10px] font-semibold text-on-surface-secondary">
                        {index + 1}
                      </span>
                      <span className="min-w-0 truncate text-xs font-medium text-on-surface">
                        {signerDisplayName(signer)}
                      </span>
                      {signer.isCurrentUser && (
                        <span className="shrink-0 text-xs text-on-surface-muted">(You)</span>
                      )}
                      <span className="shrink-0 text-xs text-on-surface-muted">{signer.roleLabel}</span>
                      <StatusBadge variant={meta.variant} className="shrink-0">
                        {meta.label}
                      </StatusBadge>
                      {/* When THIS signer signed. On a multi-signer document that
                          is a different moment from the session's own completion,
                          which is the only one the detail grid below reports. */}
                      {signer.status === 'completed' && signer.completedAt && (
                        <span className="shrink-0 text-xs text-on-surface-muted">
                          {formatSessionDateTime(signer.completedAt)}
                        </span>
                      )}
                      {canRemind && (
                        <button
                          type="button"
                          onClick={() => onRemind(signer)}
                          disabled={!!cooldown}
                          aria-label={`Remind ${signerDisplayName(signer)}`}
                          className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs font-medium text-accent-emphasis transition-colors hover:text-accent-emphasis-hover disabled:text-on-surface-muted dark:text-accent-emphasis dark:hover:text-accent-emphasis-hover cursor-pointer"
                        >
                          <Bell size={12} />
                          {cooldown ? `Wait ${formatRemindCooldown(cooldown)}` : 'Remind'}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}

            <dl className="grid gap-x-8 gap-y-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt className="font-semibold uppercase tracking-wide text-on-surface-secondary">Sent</dt>
                <dd className="mt-0.5 text-on-surface">{formatSessionDateTime(session.createdAt)}</dd>
              </div>
              <div>
                <dt className="font-semibold uppercase tracking-wide text-on-surface-secondary">Signed</dt>
                <dd className="mt-0.5 text-on-surface">
                  {isSigned
                    ? formatSessionDateTime(session.completedAt)
                    : <span className="text-on-surface-muted">Not yet signed</span>}
                </dd>
              </div>
              <div>
                <dt className="font-semibold uppercase tracking-wide text-on-surface-secondary">Expires</dt>
                <dd className="mt-0.5 text-on-surface">
                  {/* Settled before expiring: the row's own expires_at still holds
                      the original 7-day deadline, which reads as a live countdown
                      unless it is muted out here. */}
                  {isOpen || session.status === 'expired'
                    ? formatSessionDateTime(session.expiresAt ?? null)
                    : <span className="text-on-surface-muted">-</span>}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="font-semibold uppercase tracking-wide text-on-surface-secondary">Filed in</dt>
                <dd className="mt-0.5 min-w-0">
                  {isSigned ? (
                    canOpenDestination && destinationHref ? (
                      <button
                        type="button"
                        onClick={() => navigate(destinationHref)}
                        className="inline-flex min-w-0 max-w-full items-center gap-1 text-on-surface transition-colors hover:text-accent-emphasis hover:underline dark:hover:text-accent-emphasis-hover cursor-pointer"
                      >
                        <FolderOpen size={12} className="shrink-0 text-on-surface-muted" />
                        <span className="truncate">{savedToLabel(session)}</span>
                      </button>
                    ) : (
                      <span className="flex min-w-0 items-center gap-1 text-on-surface">
                        <FolderOpen size={12} className="shrink-0 text-on-surface-muted" />
                        <span className="truncate">{savedToLabel(session)}</span>
                      </span>
                    )
                  ) : (
                    <span className="text-on-surface-muted">Filed once signed</span>
                  )}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="font-semibold uppercase tracking-wide text-on-surface-secondary">Delivery</dt>
                <dd className="mt-0.5 truncate text-on-surface">
                  {deliveredVia(session) || <span className="text-on-surface-muted">-</span>}
                </dd>
              </div>
            </dl>

            {/* No action row here: every action is on the row itself, and the
                certificate's own download sits inside the certificate reader. */}
          </div>
        </div>
      </div>
    </div>
  );
}
