'use client'

// Review step for Word-first uploads. Given the spans the server's scan
// proposed, the user confirms which become {placeholders} and what each is
// named, then the commit rewrites and stores the file.
//
// A lightweight LIST (not a document editor): one row per proposal, context
// snippet, category, occurrence count, an include checkbox, and an editable
// field name backed by the canonical vocabulary (so a renamed field lands on a
// key the fill engine can auto-populate). Default: everything checked with the
// detector's suggested name → "Save" is one click ("accept all"); the user can
// deselect or rename any row first (the legal-safety review pass).

import { useId, useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import Modal from '@/components/ui/Modal'
import Spinner from '@/components/ui/Spinner'
import type {
  BracketEdit,
  FieldCategory,
  FormFieldControl,
  LeftoverClientText,
  TemplateFieldProposal,
} from '@/lib/wordTemplates/auto-bracket-types'
import { LeftoverClientTextList } from './LeftoverClientText'
import {
  CANONICAL_VOCABULARY,
  clientFieldCaution,
  normalizeFieldKey,
  resolveCanonicalId,
} from '@/lib/wordTemplates/vocabulary'

// Mirrors the server's PLACEHOLDER_NAME_RE so we reject a bad name
// before the round-trip. Validate the trimmed value, handleSave sends tag.trim().
const PLACEHOLDER_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)*$/
const isValidTag = (tag: string) => PLACEHOLDER_NAME_RE.test(tag.trim())

const CATEGORY_LABEL: Record<FieldCategory, string> = {
  marker: 'Blank',
  highlight: 'Highlighted',
  known: 'From your records',
  label: 'Labelled',
  case_number: 'Case number',
  money: 'Amount',
  date: 'Date',
  time: 'Time',
  email: 'Email',
  phone: 'Phone',
  zip: 'ZIP',
}

const CATEGORY_CLASS: Record<FieldCategory, string> = {
  // An authored blank is the strongest signal in the list, give it the
  // strongest chip so a reviewer reads those rows first.
  marker: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300',
  // Yellow, because the chip is naming the highlighter the author used.
  highlight: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-950/40 dark:text-yellow-300',
  // Green: this one is not a guess, the value is in the firm's database.
  known: 'bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-300',
  label: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-950/40 dark:text-cyan-300',
  case_number: 'bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300',
  money: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  date: 'bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300',
  time: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  email: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  phone: 'bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300',
  zip: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
}

// Word form-field controls get their own chips, so a blank on a form is never
// confused with a value the detector matched in prose.
const CONTROL_LABEL: Record<FormFieldControl, string> = {
  text: 'Form blank',
  checkbox: 'Checkbox',
}

const CONTROL_CLASS: Record<FormFieldControl, string> = {
  text: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300',
  checkbox: 'bg-teal-100 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300',
}

type RowState = { included: boolean; tag: string }

interface AutoBracketReviewProps {
  open: boolean
  fileName: string
  proposals: TemplateFieldProposal[]
  submitting: boolean
  error: string | null
  /**
   * Client details the server found still in plain text on the last save
   * attempt. While set, saving means keeping them, and says so.
   */
  leftovers: LeftoverClientText[] | null
  onCancel: () => void
  onConfirm: (edits: BracketEdit[]) => void
  /** Save, keeping exactly the leftovers shown. */
  onSaveAnyway: (edits: BracketEdit[]) => void
}

// Bold the detected literal inside its context line.
function HighlightedSnippet({ snippet, literal }: { snippet: string; literal: string }) {
  const idx = snippet.indexOf(literal)
  if (idx === -1) return <span className="text-on-surface-secondary">{snippet}</span>
  return (
    <span className="text-on-surface-secondary">
      {snippet.slice(0, idx)}
      <mark className="rounded bg-accent-soft px-0.5 font-medium text-accent-emphasis">
        {literal}
      </mark>
      {snippet.slice(idx + literal.length)}
    </span>
  )
}

// Show the live tag sitting in the sentence around the blank. A form field has
// no text of its own, so this IS the affordance: the reviewer reads
// "…Bar Number {bar_number} Name of Law Firm…" and can tell at a glance whether
// the name they typed fits the slot.
function FieldContextSnippet({
  before,
  after,
  tag,
}: {
  before: string
  after: string
  tag: string
}) {
  return (
    <span className="text-on-surface-secondary">
      {before ? `…${before} ` : ''}
      <mark className="rounded bg-accent-soft px-0.5 font-mono font-medium text-accent-emphasis">
        {`{${tag}}`}
      </mark>
      {after ? ` ${after}…` : ''}
    </span>
  )
}

// A stable list key across every proposal kind.
const proposalKey = (p: TemplateFieldProposal, i: number) => {
  if (p.kind === 'formField') return `field-${p.index}`
  if (p.kind === 'pdfField') return `pdf-${p.pdfName}`
  if (p.kind === 'repeater') return `repeater-${p.index}`
  return `literal-${p.literal}-${i}`
}

// What the include checkbox announces to a screen reader.
const proposalLabel = (p: TemplateFieldProposal) => {
  if (p.kind === 'formField') return `Include form blank ${p.wordName ?? p.index + 1}`
  if (p.kind === 'pdfField') return `Include ${p.pdfName}`
  if (p.kind === 'repeater') return `Include the ${p.rowTexts.length}-row schedule`
  return `Include ${p.literal}`
}

// One chip per proposal kind. Kept exhaustive so a new kind is a type error
// here rather than an empty chip at runtime.
function chipFor(p: TemplateFieldProposal): { label: string; cls: string } {
  if (p.kind === 'literal') {
    return { label: CATEGORY_LABEL[p.category], cls: CATEGORY_CLASS[p.category] }
  }
  if (p.kind === 'repeater') {
    return {
      label: 'Repeating rows',
      cls: 'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-950/40 dark:text-fuchsia-300',
    }
  }
  if (p.kind === 'pdfField') {
    return {
      label: p.control === 'checkbox' ? 'PDF checkbox' : 'PDF field',
      cls: CONTROL_CLASS[p.control],
    }
  }
  return { label: CONTROL_LABEL[p.control], cls: CONTROL_CLASS[p.control] }
}

export default function AutoBracketReview({
  open,
  fileName,
  proposals,
  submitting,
  error,
  leftovers,
  onCancel,
  onConfirm,
  onSaveAnyway,
}: AutoBracketReviewProps) {
  const [rows, setRows] = useState<RowState[]>(() =>
    proposals.map((p) => ({ included: true, tag: p.suggestedTag })),
  )
  // The dialog owns focus and Escape; while a save is in flight neither
  // Escape nor the backdrop can dismiss it.
  const titleId = useId()

  const includedCount = rows.filter((r) => r.included).length
  const invalidCount = rows.filter((r) => r.included && !isValidTag(r.tag)).length

  const setRow = (i: number, patch: Partial<RowState>) =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const allIncluded = includedCount === rows.length
  const toggleAll = () =>
    setRows((prev) => prev.map((r) => ({ ...r, included: !allIncluded })))

  const hasLeftovers = !!leftovers && leftovers.length > 0

  const handleSave = () => {
    if (invalidCount > 0) return
    const edits: BracketEdit[] = rows
      .map((r, i) => ({ r, p: proposals[i] }))
      .filter(({ r }) => r.included)
      .map(({ r, p }) =>
        p.kind === 'formField'
          ? { kind: 'formField' as const, index: p.index, wordName: p.wordName, tag: r.tag.trim() }
          : p.kind === 'pdfField'
            ? { kind: 'pdfField' as const, pdfName: p.pdfName, tag: r.tag.trim() }
            : p.kind === 'repeater'
              ? {
                  // The loop NAME is what the reviewer edits; the per-row field
                  // names travel as the detector proposed them, and the server
                  // rebuilds the row template from its own scan.
                  kind: 'repeater' as const,
                  index: p.index,
                  name: r.tag.trim(),
                  fields: p.fields,
                }
              : { kind: 'literal' as const, find: p.literal, tag: r.tag.trim() },
      )
    if (hasLeftovers) onSaveAnyway(edits)
    else onConfirm(edits)
  }

  return (
    <Modal
      isOpen={open}
      onClose={onCancel}
      dismissible={!submitting}
      showClose={false}
      labelledBy={titleId}
      size="2xl"
      className="border-2 border-outline"
      bodyClassName={null}
    >
        <div className="flex min-h-0 flex-1 flex-col" data-testid="auto-bracket-review">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-outline px-6 py-4 shrink-0">
            <div className="min-w-0">
              <h2 id={titleId} className="flex items-center gap-2 text-base font-semibold text-on-surface">
                <Sparkles size={16} className="text-accent-emphasis" />
                Review detected fields
              </h2>
              <p className="mt-0.5 truncate text-xs text-on-surface-muted">
                {proposals.length === 0
                  ? `No fields found in ${fileName}.`
                  : `${proposals.length} field${proposals.length === 1 ? '' : 's'} found in ${fileName}. Uncheck any you don’t want, and rename to an auto-fill field where it fits.`}
              </p>
            </div>
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-on-surface-muted transition-colors hover:text-on-surface disabled:opacity-50"
              aria-label="Cancel"
            >
              <X size={18} />
            </button>
          </div>

          {/* Rows */}
          <div className="min-h-0 flex-1 overflow-y-auto styled-scrollbar px-6 py-3">
            {proposals.some((p) => p.kind === 'formField') && (
              <p className="mb-3 rounded-lg border border-amber-500/30 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                Names were suggested from the nearest label in the document: check them before
                saving. On a court form the blank next to &ldquo;Name&rdquo; may be the plaintiff,
                the defendant, or your client.
              </p>
            )}
            {/* Nothing detected used to mean saved on the spot, unseen. Every
                document made from a template repeats its text, so the one
                upload most likely to carry a whole precedent through verbatim
                now stops here like any other. */}
            {proposals.length === 0 && (
              <p
                className="rounded-lg border border-amber-500/30 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-xs leading-snug text-amber-600 dark:text-amber-400"
                data-testid="auto-bracket-empty-notice"
              >
                Nothing to fill in was detected, so this document will be saved exactly as
                written, and every document made from it will say the same thing. If it
                names a client or a matter, cancel, highlight those spots in Word (or type a
                label in brackets, like [CLIENT NAME]), and upload it again.
              </p>
            )}
            {proposals.length > 0 && (
              <label className="mb-2 flex items-center gap-2 text-xs text-on-surface-muted">
                <input
                  type="checkbox"
                  checked={allIncluded}
                  onChange={toggleAll}
                  className="h-3.5 w-3.5 accent-accent-solid"
                  data-testid="auto-bracket-toggle-all"
                />
                {allIncluded ? 'Deselect all' : 'Select all'}
              </label>
            )}
            <ul className="space-y-2">
              {proposals.map((p, i) => {
                const row = rows[i]
                const tagInvalid = row.included && !isValidTag(row.tag)
                // Re-evaluate auto-fillability against the CURRENT tag (the user
                // may have renamed a custom field to a canonical one, or vice
                // versa), not the proposal's static `canonical` flag.
                // A LOOP's name is never a vocabulary id, its COLUMNS are, and
                // the case supplies its rows by the loop's own name (payments).
                // Judging a repeater by resolveCanonicalId(name) therefore always
                // said "won't auto-fill" about the one proposal that fills itself
                // from the case's installment schedule.
                const willAutoFill =
                  !tagInvalid &&
                  (p.kind === 'repeater'
                    ? p.canonical && normalizeFieldKey(row.tag.trim()) === p.suggestedTag
                    : !!resolveCanonicalId(row.tag.trim()))
                const prev = proposals[i - 1]
                const startsLiterals =
                  p.kind === 'literal' && prev !== undefined && prev.kind !== 'literal'
                return (
                  <li
                    key={proposalKey(p, i)}
                    className={`rounded-lg border border-outline-subtle bg-surface-alt p-3 ${
                      startsLiterals ? 'mt-4 border-t-2 border-t-outline' : ''
                    }`}
                    data-testid="auto-bracket-row"
                  >
                    {startsLiterals && (
                      <p className="-mt-1 mb-2 text-sm font-medium uppercase tracking-[0.06em] text-on-surface-muted">
                        Values found in the text
                      </p>
                    )}
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={row.included}
                        disabled={submitting}
                        onChange={(e) => setRow(i, { included: e.target.checked })}
                        className="mt-1 h-4 w-4 accent-accent-solid disabled:opacity-50"
                        aria-label={proposalLabel(p)}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="mb-1 flex items-center gap-2">
                          <span
                            className={`inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-sm font-medium ${chipFor(p).cls}`}
                          >
                            {chipFor(p).label}
                          </span>
                          {p.kind === 'pdfField' && (
                            <span className="h-5 min-w-0 truncate rounded-md bg-surface px-1.5 font-mono text-xs leading-5 text-on-surface-muted">
                              {p.pdfName}
                            </span>
                          )}
                          {p.kind === 'formField' && p.wordName && (
                            <span className="h-5 min-w-0 truncate rounded-md bg-surface px-1.5 font-mono text-xs leading-5 text-on-surface-muted">
                              {p.wordName}
                            </span>
                          )}
                          {p.kind === 'literal' && p.occurrences > 1 && (
                            <span className="text-xs text-on-surface-muted">
                              {p.occurrences} occurrences
                            </span>
                          )}
                          {p.kind === 'repeater' && (
                            <span className="text-xs text-on-surface-muted">
                              {p.rowTexts.length} rows → one repeating row
                            </span>
                          )}
                        </div>
                        <p className="mb-2 text-xs leading-snug">
                          {p.kind === 'pdfField' ? (
                            <FieldContextSnippet
                              before={p.pdfName}
                              after=""
                              tag={row.tag.trim() || p.suggestedTag}
                            />
                          ) : p.kind === 'formField' ? (
                            <FieldContextSnippet
                              before={p.contextBefore}
                              after={p.contextAfter}
                              tag={row.tag.trim() || p.suggestedTag}
                            />
                          ) : p.kind === 'repeater' ? (
                            // Show the rows being collapsed and what the single
                            // remaining row will say, the reviewer is agreeing
                            // to DELETE paragraphs, so they have to see which.
                            <span className="text-on-surface-secondary">
                              {p.rowTexts.map((t) => (
                                <span key={t} className="block truncate font-mono text-xs opacity-70">
                                  {t}
                                </span>
                              ))}
                              <span className="mt-1 block font-mono text-xs text-on-surface">
                                {`{#${row.tag.trim() || p.suggestedTag}}`} {p.rowTemplate}{' '}
                                {`{/${row.tag.trim() || p.suggestedTag}}`}
                              </span>
                            </span>
                          ) : (
                            <HighlightedSnippet snippet={p.contextSnippet} literal={p.literal} />
                          )}
                        </p>
                        {p.kind !== 'literal' && p.kind !== 'repeater' && row.included && clientFieldCaution(row.tag.trim()) && (
                          <p className="mb-2 rounded border border-amber-500/30 bg-amber-50 dark:bg-amber-950/20 px-2 py-1 text-xs text-amber-600 dark:text-amber-400">
                            {clientFieldCaution(row.tag.trim())}
                          </p>
                        )}
                        {p.kind !== 'literal' && p.kind !== 'repeater' && p.control === 'checkbox' && row.included && (
                          <p className="mb-2 text-xs text-on-surface-muted">
                            Replaces the checkbox with a text placeholder: fill it with an X.
                            Uncheck to keep it as a real Word checkbox.
                          </p>
                        )}
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm text-on-surface-muted">{'{'}</span>
                          <input
                            type="text"
                            value={row.tag}
                            disabled={!row.included || submitting}
                            onChange={(e) => setRow(i, { tag: e.target.value })}
                            list="auto-bracket-vocab"
                            spellCheck={false}
                            className={`h-8 w-56 rounded-lg border bg-input-bg px-3 font-mono text-sm text-on-surface focus:outline-none focus:ring-2 disabled:opacity-50 ${
                              tagInvalid
                                ? 'border-red-600 focus:ring-red-600'
                                : 'border-input-border focus:ring-accent-control-ring'
                            }`}
                            data-testid="auto-bracket-tag-input"
                          />
                          <span className="font-mono text-sm text-on-surface-muted">{'}'}</span>
                          {row.included && !tagInvalid && !willAutoFill && (
                            <span className="text-xs text-on-surface-muted">
                              custom: won&apos;t auto-fill
                            </span>
                          )}
                        </div>
                        {tagInvalid && (
                          <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                            Use letters, numbers, and underscores only (e.g. client_name).
                          </p>
                        )}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
            {/* Canonical field names for the datalist autocomplete. */}
            <datalist id="auto-bracket-vocab">
              {CANONICAL_VOCABULARY.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </datalist>
          </div>

          {/* Outside the scrolling list, so it appears right where the
              reviewer just clicked Save. */}
          {hasLeftovers && (
            <div
              role="alert"
              className="max-h-56 shrink-0 overflow-y-auto styled-scrollbar border-t border-red-600/30 bg-red-50 dark:bg-red-950/20 px-6 py-3 text-red-600 dark:text-red-400"
              data-testid="auto-bracket-leftovers"
            >
              <p className="text-xs font-semibold">
                These client details will stay in the template exactly as written, and
                appear in every document made from it:
              </p>
              <LeftoverClientTextList leftovers={leftovers!} rowTestId="auto-bracket-leftover-row" />
              <p className="mt-2 text-xs opacity-80">
                To take them out, check the matching field above if there is one, or
                cancel and change them in the Word document. Save anyway only if they
                belong in every document.
              </p>
            </div>
          )}

          {/* Footer */}
          <div className="flex items-center justify-between gap-3 border-t border-outline bg-surface-alt px-6 py-4 rounded-b-xl shrink-0">
            <span className="text-xs text-on-surface-muted">
              {proposals.length === 0 ? 'No fields' : `${includedCount} of ${proposals.length} selected`}
            </span>
            <div className="flex items-center gap-2">
              {/* Shown even under the leftover warning: a leftovers response
                  never sets `error`, so anything here is a separate failure of
                  the Save-anyway attempt, and hiding it would look like a
                  button that does nothing. */}
              {error && <span className="max-w-xs truncate text-xs text-red-600 dark:text-red-400">{error}</span>}
              <button
                type="button"
                onClick={onCancel}
                disabled={submitting}
                className="inline-flex h-8 items-center justify-center rounded-lg px-3 text-sm font-medium text-on-surface-secondary transition-colors hover:bg-surface-hover disabled:opacity-50"
                data-testid="auto-bracket-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={submitting || invalidCount > 0}
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-accent-solid px-3 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-solid/90 disabled:opacity-60"
                data-testid="auto-bracket-save"
              >
                {submitting && <Spinner />}
                {hasLeftovers
                  ? 'Save anyway'
                  : includedCount === 0
                    ? 'Save without fields'
                    : 'Save template'}
              </button>
            </div>
          </div>
        </div>
    </Modal>
  )
}
