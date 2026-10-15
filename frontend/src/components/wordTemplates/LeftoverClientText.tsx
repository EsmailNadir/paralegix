'use client'

// The client details a .docx would store as plain text, as the server's
// leftover guard reports them. One list for
// every way a .docx becomes a template: the upload review shows it inline;
// Re-upload and the editor's Word import show it in LeftoverClientTextDialog.

import ConfirmModal from '@/components/ui/ConfirmModal'
import { useLastOpenValue } from '@/hooks/useMountTransition'
import type { LeftoverClientText, LeftoverPart } from '@/lib/wordTemplates/auto-bracket-types'
import { CANONICAL_VOCABULARY } from '@/lib/wordTemplates/vocabulary'

// Where in the Word document the reviewer has to look for a leftover.
const PART_LABEL: Record<LeftoverPart, string> = {
  body: 'text',
  header: 'header',
  footer: 'footer',
  footnote: 'footnotes',
  comment: 'comments',
  deleted: 'deleted text (tracked changes)',
  field: 'field codes',
  properties: 'document properties',
}

const vocabularyLabel = (id: string) => CANONICAL_VOCABULARY.find((e) => e.id === id)?.label ?? id

export function LeftoverClientTextList({
  leftovers,
  rowTestId,
}: {
  leftovers: LeftoverClientText[]
  rowTestId: string
}) {
  return (
    <ul className="mt-2 space-y-1.5">
      {leftovers.map((l) => (
        <li key={l.literal} className="text-xs" data-testid={rowTestId}>
          <span className="font-semibold">{l.literal}</span>
          <span className="opacity-80">
            {' '}
            · {vocabularyLabel(l.canonicalId)} · in the {l.parts.map((p) => PART_LABEL[p]).join(', ')}
            {l.occurrences > 1 ? ` · ${l.occurrences} times` : ''}
          </span>
          <span className="block truncate opacity-70">{l.contextSnippet}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Asks before a .docx is stored with a client's details in it. Open while
 * `leftovers` is set. Save anyway resends with exactly these values
 * acknowledged; the server scans again, so anything new is asked about in turn.
 */
export function LeftoverClientTextDialog({
  leftovers,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  leftovers: LeftoverClientText[] | null
  pending: boolean
  /** A failure of the Save-anyway attempt itself, shown in the dialog so the button never looks dead. */
  error: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  // The list stays on screen while the dialog animates out.
  const shown = useLastOpenValue(leftovers !== null, leftovers) ?? []
  return (
    <ConfirmModal
      isOpen={leftovers !== null}
      onClose={() => {
        if (!pending) onCancel()
      }}
      onConfirm={onConfirm}
      title="Client details are still in this document"
      message="These will stay in the template exactly as written, and appear in every document made from it:"
      confirmText={pending ? 'Saving…' : 'Save anyway'}
      confirmType="danger"
      loading={pending}
      error={error}
      extra={
        <>
          <div className="max-h-56 overflow-y-auto rounded-lg border border-red-600/30 bg-red-50 dark:bg-red-950/20 px-3 pb-2 text-red-600 dark:text-red-400">
            <LeftoverClientTextList leftovers={shown} rowTestId="leftover-client-text-row" />
          </div>
          <p className="mt-3 text-xs text-on-surface-muted">
            To take them out, cancel and change them in the Word document. Save anyway only if they belong
            in every document.
          </p>
        </>
      }
    />
  )
}
