'use client';

import { useState } from 'react';
import { ChevronRight, PenLine, X } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import type { NeedsMySignatureDocument } from '@/hooks/signatureHooks/useSigningNeedsMySignature';

/** Listing more than this turns a prompt into a second list, so the rest go in the dialog. */
const MAX_LISTED = 3;

interface NeedsSignatureBannerProps {
  documents: NeedsMySignatureDocument[];
  onSign: (token: string) => void;
}

/** One document awaiting signature: name, the role being signed as, and the action. */
function DocumentRow({
  document,
  onSign,
}: {
  document: NeedsMySignatureDocument;
  onSign: (token: string) => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-outline-subtle bg-surface px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-on-surface">
        {document.fileName}
      </span>
      <span className="shrink-0 text-xs text-on-surface-muted">{document.participantRole}</span>
      <button
        type="button"
        onClick={() => onSign(document.publicToken || document.sessionToken)}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-accent-solid px-3 py-1.5 text-xs font-medium text-accent-foreground transition-[background-color,transform] hover:bg-accent-solid-hover active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
      >
        <PenLine size={13} />
        Sign
      </button>
    </li>
  );
}

/**
 * What is waiting on the signed-in member's own signature, pulled to the top of
 * the page.
 *
 * The list below is ordered by recent activity and paged, so a document waiting
 * on this member can sit pages deep with nothing on screen saying so - the one
 * thing on the page they have to act on personally was the easiest thing to miss.
 * Amber is the app's "needs attention" colour (see `ConflictCheckBanner`), kept
 * distinct from the blue accent used for ordinary actions like "Send a document"
 * and the "Sign" button itself.
 *
 * Only the first few are listed inline; past that the banner would become a
 * second list competing with the real one, so the remainder open in a dialog.
 */
export default function NeedsSignatureBanner({ documents, onSign }: NeedsSignatureBannerProps) {
  const [allOpen, setAllOpen] = useState(false);
  const closeAll = () => setAllOpen(false);

  if (documents.length === 0) return null;

  const listed = documents.slice(0, MAX_LISTED);
  const remaining = documents.length - listed.length;

  return (
    <div className="rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-500/10 p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-amber-500/10 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400">
          <PenLine size={17} strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-on-surface">
            {documents.length === 1
              ? 'A document needs your signature'
              : `${documents.length} documents need your signature`}
          </h2>
          <p className="mt-0.5 text-xs text-on-surface-secondary">
            You&apos;ve been added as a signer. Signing here files the executed copy automatically.
          </p>

          <ul className="mt-3 space-y-1.5">
            {listed.map((document) => (
              <DocumentRow key={document.sessionToken} document={document} onSign={onSign} />
            ))}
          </ul>

          {/* Only once there is actually something held back. At three or fewer the
              banner already shows every one of them, so a "see all" would open a
              dialog onto the same list the reader is looking at. */}
          {remaining > 0 && (
            <button
              type="button"
              onClick={() => setAllOpen(true)}
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-amber-700 transition-colors hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300 cursor-pointer"
            >
              and {remaining} more
              <ChevronRight size={13} />
            </button>
          )}
        </div>
      </div>

      <Modal
        isOpen={allOpen}
        onClose={closeAll}
        title="Waiting on your signature"
        // One template literal rather than JSX text around the count: an
        // `&apos;` in the same text chunk as an interpolation makes the
        // compiler drop the space before it ("42 documentsyou've").
        subtitle={`${documents.length} document${documents.length !== 1 ? 's' : ''} you've been added to as a signer.`}
        closeIcon={<X size={18} strokeWidth={2} />}
        size="xl"
        lockScroll
        bodyClassName={null}
      >
        <ul className="styled-scrollbar min-h-0 flex-1 space-y-1.5 overflow-y-auto px-6 py-4">
          {documents.map((document) => (
            <DocumentRow key={document.sessionToken} document={document} onSign={onSign} />
          ))}
        </ul>
      </Modal>
    </div>
  );
}
