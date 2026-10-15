// The firm's own values, gathered so the auto-bracket detector can recognise
// them inside an uploaded document (layer 4, see ./auto-bracket/known-values).
//
// WHY a firm-wide sweep rather than one matter's context:
//   the matter document context answers "what fills this template FOR THIS
//   MATTER", and detection has no matter: someone uploads a precedent from
//   whichever matter it was last used on. So this reads the values themselves,
//   across the caller's firm, and asks only "is this string one of ours?".
//
// Pure assembly: the repository reads the rows (every read scoped to the
// caller's firm, never cached across firms) and this decides the order and the
// vocabulary id of each value.

import type { KnownValue } from './auto-bracket/known-values'

export type FirmKnownValueRows = {
  firm: {
    name?: string | null
    address?: string | null
    phone?: string | null
    fax?: string | null
    email?: string | null
    zip?: string | null
  } | null
  /** matters.matter_number: the matter's case number. */
  caseNumbers: Array<string | null>
  /** The firm's courts. */
  courtNames: Array<string | null>
  /** Contacts attached to a matter as its judge. */
  judgeNames: Array<string | null>
  /** Contacts attached to a matter as opposing counsel: the service recipient. */
  serviceRecipients: Array<string | null>
  clients: Array<{
    name?: string | null
    email?: string | null
    phone?: string | null
    organization?: string | null
  }>
}

/** Split a stored full name into a surname, for naming "Ms. Avery". */
function surname(fullName: string): string | null {
  const parts = fullName.trim().split(/\s+/)
  if (parts.length < 2) return null
  const last = parts[parts.length - 1].replace(/[^A-Za-z'’-]/g, '')
  return last.length >= 3 ? last : null
}

export function assembleFirmKnownValues(rows: FirmKnownValueRows): KnownValue[] {
  const out: KnownValue[] = []
  const push = (value: unknown, canonicalId: string, nameOnly?: boolean) => {
    if (typeof value === 'string' && value.trim()) out.push({ value, canonicalId, nameOnly })
  }

  // Firm first: its values are the most stable and the least ambiguous, and
  // buildKnownValueIndex lets the first writer win on a tie. This is what keeps
  // the letterhead's email from being offered as a client's.
  const { firm } = rows
  push(firm?.name, 'firm_name')
  push(firm?.address, 'firm_address')
  push(firm?.phone, 'firm_phone')
  push(firm?.fax, 'firm_fax')
  push(firm?.email, 'firm_email')
  push(firm?.zip, 'firm_zip')

  for (const value of rows.caseNumbers) push(value, 'case_number')
  for (const value of rows.courtNames) push(value, 'court_name')
  for (const value of rows.judgeNames) push(value, 'judge_name')
  for (const value of rows.serviceRecipients) push(value, 'service_recipient')

  for (const row of rows.clients) {
    push(row.name, 'client_name')
    push(row.email, 'client_email')
    push(row.phone, 'client_phone')
    push(row.organization, 'client_organization')
    // A surname names a salutation the author highlighted ("Ms. Avery") but
    // is never allowed to go hunting on its own: far too many false hits in
    // prose, and a wrongly bracketed word ships into every future filing.
    if (typeof row.name === 'string') {
      const last = surname(row.name)
      if (last) {
        out.push({ value: last, canonicalId: 'client_last_name', nameOnly: true, ofName: row.name })
      }
    }
  }

  return out
}
