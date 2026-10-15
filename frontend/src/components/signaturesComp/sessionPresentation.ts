import {
  Ban,
  CalendarX,
  CheckCircle2,
  Clock,
  PenLine,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type {
  SigningDestination,
  SigningParticipantSummary,
  SigningSession,
} from '@/types/signature';
import type { StatusVariant } from '@/constants/statusMeta';

/**
 * How a signing session and its signers are described in the session list: the
 * words, the colour, and the icon for every status, plus the one-line summaries
 * the rows read as prose rather than as a dump of labelled fields.
 *
 * Kept apart from the components so the row stays about layout and the list stays
 * about paging, and so the status vocabulary has exactly one definition.
 */

export interface SessionStatusMeta {
  label: string;
  variant: StatusVariant;
  Icon: LucideIcon;
}

/**
 * The status vocabulary. Colour lives on the badge only - the leading tile is
 * neutral and distinguishes status by its glyph instead.
 *
 * A tinted tile beside a coloured badge said the same thing twice, in the same
 * colour, on every row; down a full page that read as decoration rather than as
 * information.
 *
 * 'cancelled' reads as "Voided" because voiding is what the button that produces
 * it is called; a session the user voided should not come back named something
 * else.
 */
const SESSION_STATUS: Record<string, SessionStatusMeta> = {
  pending: { label: 'Pending', variant: 'warning', Icon: Clock },
  in_progress: { label: 'In Progress', variant: 'info', Icon: PenLine },
  completed: { label: 'Completed', variant: 'success', Icon: CheckCircle2 },
  cancelled: { label: 'Voided', variant: 'danger', Icon: Ban },
  declined: { label: 'Declined', variant: 'danger', Icon: XCircle },
  expired: { label: 'Expired', variant: 'neutral', Icon: CalendarX },
};

export function sessionStatusMeta(status: string): SessionStatusMeta {
  return SESSION_STATUS[status] ?? SESSION_STATUS.pending;
}

export interface ParticipantStatusMeta {
  label: string;
  variant: StatusVariant;
}

// A signer is 'active' when the request has reached them and 'waiting' when an
// earlier signer still holds the document. "Awaiting" / "Queued" says which is
// which; the older "Active" / "Waiting" pair did not.
const PARTICIPANT_STATUS: Record<string, ParticipantStatusMeta> = {
  completed: { label: 'Signed', variant: 'success' },
  active: { label: 'Awaiting', variant: 'purple' },
  waiting: { label: 'Queued', variant: 'neutral' },
  cancelled: { label: 'Voided', variant: 'danger' },
  declined: { label: 'Declined', variant: 'danger' },
};

export function participantStatusMeta(status: string): ParticipantStatusMeta {
  return PARTICIPANT_STATUS[status] ?? PARTICIPANT_STATUS.waiting;
}

/** A session still moving: someone can sign it, and it can be voided. */
export function isSessionOpen(status: string): boolean {
  return status === 'pending' || status === 'in_progress';
}

export function formatSessionDate(dateStr: string | null): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return '';

  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);

  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * "Sent today" / "Sent Jun 14, 2026" - the date folded into a sentence.
 *
 * Only the relative labels are lowercased to continue the sentence; a month name
 * is a proper noun, so blanket-lowercasing the formatted date would produce "Sent
 * may 5, 2026".
 */
export function sentPhrase(dateStr: string | null): string {
  const label = formatSessionDate(dateStr);
  if (!label) return 'Sent';
  const isRelative = /^(Today|Yesterday|\d+ days ago)$/.test(label);
  return `Sent ${isRelative ? label.toLowerCase() : label}`;
}

/** The same instant spelled out in full, for the expanded detail rows. */
export function formatSessionDateTime(dateStr: string | null): string {
  if (!dateStr) return '-';
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// The firm's copy is always filed somewhere: the folder the sender picked, or the
// firm's General Files by default (the backend falls back to .../general/).
export function savedToLabel(session: SigningSession): string {
  return session.destinationLabel?.trim() || 'General Files';
}

/**
 * The files page that opens on the folder a session was filed in. It reads
 * view/entity/path off the query string, which is also how it writes its own
 * history entries, so arriving by this link is indistinguishable from having
 * browsed there.
 */
export function savedToHref(lawFirmId: string, destination: SigningDestination): string {
  const params = new URLSearchParams();
  if (destination.scope === 'matter' && destination.matterId) {
    params.set('view', 'matter');
    params.set('matterId', destination.matterId);
  } else if (destination.scope === 'task' && destination.taskId) {
    params.set('view', 'task');
    params.set('taskId', destination.taskId);
  } else if (destination.scope === 'client' && destination.clientId) {
    params.set('view', 'client');
    params.set('clientId', destination.clientId);
  } else {
    params.set('view', 'lawFirm');
  }
  if (destination.folderPath) params.set('path', destination.folderPath);
  return `/lawfirm/${lawFirmId}/files?${params.toString()}`;
}

/** How the signer received their copy, independent of where the firm filed it. */
export function deliveredVia(session: SigningSession): string | null {
  const methods = new Set((session.signers || []).map((s) => s.deliveryMethod).filter(Boolean));
  if (methods.has('portal')) return 'Sent to client portal';
  if (session.recipientEmail) return `Sent to ${session.recipientEmail}`;
  if (methods.has('email')) return 'Emailed to the signer';
  if (methods.has('copy_link')) return 'Shared via signing link';
  if (methods.has('in_person')) return 'Signed in person';
  return null;
}

/**
 * Plain-language description of how a reminder reaches a signer, used in the
 * confirmation prompt so the sender knows exactly what pressing "Remind" does.
 */
export function remindChannelLabel(signer: SigningParticipantSummary): string {
  switch (signer.deliveryMethod) {
    case 'portal':
      return 'in their client portal';
    case 'email':
    case 'internal_email':
      return signer.email ? `by email at ${signer.email}` : 'by email';
    case 'copy_link':
      return 'via their signing link';
    case 'in_person':
      return 'for in-person signing';
    default:
      return signer.email ? `at ${signer.email}` : '';
  }
}

/**
 * The remaining reminder wait, as a label. Whole minutes above a minute: a
 * countdown of raw seconds reads as "Wait 3541s" on an hour-long cooldown.
 */
export function formatRemindCooldown(secondsRemaining: number): string {
  if (secondsRemaining >= 60) return `${Math.ceil(secondsRemaining / 60)}m`;
  return `${Math.max(1, secondsRemaining)}s`;
}

export function signerDisplayName(signer: SigningParticipantSummary): string {
  return signer.name || signer.email || signer.roleLabel;
}

/**
 * The single line under a session's file name: who it is with, and what happened
 * to it, in that order.
 *
 * Replaces the "Signer: … Created: … Signed: …" field dump the row used to carry.
 * A row is scanned, not read, so the one fact that changes what you would do
 * about it - who it is waiting on - leads, and the rest of the record is left to
 * the expanded view.
 */
export function sessionSummaryLine(session: SigningSession): string {
  const total = session.totalParticipants || 0;
  const done = session.completedParticipants || 0;
  const parallel = session.routingMode === 'parallel';

  if (session.status === 'completed') {
    const who = total > 1
      ? `Signed by all ${total} signers`
      : `Signed by ${session.signerName || session.recipientEmail || 'the signer'}`;
    return `${who} · ${formatSessionDate(session.completedAt)}`;
  }

  const sent = sentPhrase(session.createdAt);

  if (!isSessionOpen(session.status)) {
    // Voided, declined or expired: the signer is no longer the point - how far it
    // got before it stopped is.
    const progress = total > 1 ? `${done} of ${total} signed` : null;
    return [sent, progress].filter(Boolean).join(' · ');
  }

  if (total > 1 && parallel) {
    return `Waiting on ${total - done} of ${total} signers · ${sent}`;
  }

  const waitingOn = session.currentSignerName
    ? `Waiting on ${session.currentSignerName}${session.currentSignerRole ? ` (${session.currentSignerRole})` : ''}`
    : `Waiting on ${session.signerName || session.recipientEmail || 'the signer'}`;

  return `${waitingOn} · ${sent}`;
}
