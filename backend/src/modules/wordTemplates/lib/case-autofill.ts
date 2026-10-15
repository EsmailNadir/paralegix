// Canonical document-autofill context for a case (document automation).
//
// buildCaseDocumentContext() assembles the exact placeholder vocabulary the
// seeded court-filing / rep-agreement / ODH templates use (see
// docs/document-automation.md) from case + client + firm + calendar + billing
// data. It is layer 1 of the two-layer autofill: layer 2 is the heuristic
// alias maps in FillTemplateModal.tsx, which cover hand-authored templates.
//
// Only NON-EMPTY keys are returned: FillTemplateModal treats initialValues as
// user-provided, so an empty string would mask the modal's own heuristics.
//
// MONEY RULE: a money field is emitted only when it is a fact stored on this
// case. Nothing here infers a fee, defaults one, or picks between candidate
// invoices: a representation agreement is a contract, and a plausible-looking
// wrong number is worse than a blank the paralegal fills in. Numeric totals
// additionally have to be KNOWN, not merely zero: a case with no invoices
// yields no balance key at all rather than "$0.00", which would read as a
// statement that nothing is owed.
//
// assembleCaseDocumentContext() is pure (plain data in, values out) so the
// vocabulary is unit-testable without a Supabase client; the async wrapper
// only fetches.

import { normalizeFieldKey, stripJudgeTitle } from './vocabulary'

// A firm-defined matter field, as the custom-field merge needs it
// (matter_field_defs: id, label, field_type).
export type CaseFieldDef = {
  id: string
  label: string
  field_type: string
}

// The zone a date prints in when the caller names none. Every request path
// passes the firm's own time zone; this default only keeps the pure formatters
// callable on their own.
export const DEFAULT_TIME_ZONE = 'America/New_York'

export type CaseDocumentContext = {
  values: Record<string, string>
  repeaterValues: Record<string, Record<string, string>[]>
  // Set when a billing read failed, so its rows (and every section filled from
  // them) are missing rather than genuinely empty.
  billingIncomplete?: boolean
}

// ── Pure formatters (exported for tests) ──────────────────────────────────

export function formatMoneyFromCents(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  })
}

export function ordinalDay(day: number): string {
  const mod100 = day % 100
  if (mod100 >= 11 && mod100 <= 13) return `${day}th`
  switch (day % 10) {
    case 1: return `${day}st`
    case 2: return `${day}nd`
    case 3: return `${day}rd`
    default: return `${day}th`
  }
}

function datePartsInZone(date: Date, timeZone: string = DEFAULT_TIME_ZONE): { day: number; month: string; year: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).formatToParts(date)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return { day: Number(get('day')), month: get('month'), year: Number(get('year')) }
}

// Certificate-of-service style: "4th day of March 2026".
export function formatLegalDate(date: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  const { day, month, year } = datePartsInZone(date, timeZone)
  return `${ordinalDay(day)} day of ${month} ${year}`
}

// Letter style: "March 4, 2026".
export function formatLongDate(date: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  const { day, month, year } = datePartsInZone(date, timeZone)
  return `${month} ${day}, ${year}`
}

// Numeric style: "3/4/2026". Matches what FillTemplateModal writes into {date}
// so the two layers agree on the short form.
export function formatShortDate(date: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).format(date)
}

// "9:00 AM" in the firm's time zone.
export function formatTimeOfDay(date: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date)
}

// A Postgres `date` column arrives as 'YYYY-MM-DD'; format it without a
// timezone conversion (new Date('YYYY-MM-DD') would parse as UTC midnight and
// shift a day in Eastern time).
export function formatLongDateFromDateOnly(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate)
  if (!m) return isoDate
  const [, y, mo, d] = m
  const monthName = new Date(Date.UTC(Number(y), Number(mo) - 1, 15)).toLocaleString(
    'en-US',
    { month: 'long', timeZone: 'UTC' },
  )
  return `${monthName} ${Number(d)}, ${Number(y)}`
}

export function formatCityStateZip(
  city: string | null | undefined,
  state: string | null | undefined,
  zip: string | null | undefined,
): string {
  const cityPart = (city ?? '').trim()
  const tail = [(state ?? '').trim(), (zip ?? '').trim()].filter(Boolean).join(' ')
  return [cityPart, tail].filter(Boolean).join(', ')
}

// Enum columns are stored snake_case ('on_hold'); a document should read
// "On Hold", not the database's spelling.
export function humanizeEnumValue(value: string | null | undefined): string {
  return (value ?? '')
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

// Hours print with two decimals, the way every billing surface shows them.
export function formatHours(hours: number): string {
  return hours.toFixed(2)
}

// "Corwin" / "Thistlewood" from a single stored name. Mirrors splitName() in
// FillTemplateModal so both layers cut the name the same way.
export function splitClientName(name: string | null | undefined): {
  firstName: string
  lastName: string
} {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  return { firstName: parts[0] ?? '', lastName: parts.slice(1).join(' ') }
}

// ── Pure assembly ──────────────────────────────────────────────────────────

// One payment already received against an invoice on this case.
export type ReceivedPayment = {
  // Date-only ISO string ('YYYY-MM-DD').
  date: string
  amountCents: number
  method: string
  reference: string | null
}

// One billable charge on the case (a time entry, flat fee or expense).
export type BillableLineItem = {
  // Date-only ISO string ('YYYY-MM-DD').
  date: string
  description: string
  amountCents: number
}

// Money already recorded against this case. Every figure is a sum over the
// case's own rows: no candidate invoice is singled out, and no fee is
// inferred. `invoiceCount` is what makes a zero total meaningful: with no
// invoices the totals are unknown, not zero, and are omitted.
export type CaseBillingTotals = {
  invoiceCount: number
  totalInvoicedCents: number
  totalPaidCents: number
  outstandingCents: number
  totalHours: number
  // Null when the case has no single unambiguous client, or that client holds
  // no trust ledger. Zero is a real balance and is emitted.
  trustBalanceCents: number | null
  payments: ReceivedPayment[]
  lineItems: BillableLineItem[]
}

/** One invoice row, as the case totals need to see it. */
type CaseInvoiceRow = {
  total_amount_cents: number
  amount_paid_cents: number
  remaining_balance_cents: number
  total_hours: number
  is_paid: boolean
  status: string
}

/**
 * Sum a case's invoices into the totals a document can print.
 *
 * Drafts are excluded outright. A draft is an invoice the firm is still
 * assembling; it has not been sent, and every client-facing read in the billing
 * module hides it (`billing/queries.ts` filters `status <> 'draft'`). Counting
 * one here would put money on firm letterhead that the client has never been
 * asked for: `{outstanding_balance}` on a status letter would demand payment
 * for an invoice that does not yet exist as far as they know.
 *
 * Separate from the fetch so the rule can be tested without a database.
 */
export function summarizeCaseInvoices(
  rows: readonly CaseInvoiceRow[],
): Pick<
  CaseBillingTotals,
  'invoiceCount' | 'totalInvoicedCents' | 'totalPaidCents' | 'outstandingCents' | 'totalHours'
> {
  const issued = rows.filter((i) => i.status !== 'draft')
  return {
    invoiceCount: issued.length,
    totalInvoicedCents: issued.reduce((sum, i) => sum + i.total_amount_cents, 0),
    totalPaidCents: issued.reduce((sum, i) => sum + i.amount_paid_cents, 0),
    // Written-off invoices are settled, not owed; leaving them in would overstate
    // what the client still has to pay.
    outstandingCents: issued
      .filter((i) => !i.is_paid && i.status !== 'written_off')
      .reduce((sum, i) => sum + i.remaining_balance_cents, 0),
    totalHours: issued.reduce((sum, i) => sum + Number(i.total_hours ?? 0), 0),
  }
}

export type CaseAutofillInputs = {
  // EMPTY_CASE_ROW when a client is picked with no case: the client, firm and
  // date fields still fill, and every case-derived field stays absent.
  caseRow: {
    name: string
    case_number: string | null
    court_name: string | null
    lead_user_name: string
    case_reference_id?: string | null
    description?: string | null
    status?: string | null
    practice_area_name?: string | null
    category?: string | null
    // Record creation time (ISO). Printed as the case open date.
    created_at?: string | null
    opposing_party?: string | null
    judge_name?: string | null
    charges?: string | null
    prosecutor_name?: string | null
    prosecutor_email?: string | null
    // Case document packet (20260924000010).
    license_plate?: string | null
    // Date-only 'YYYY-MM-DD'.
    citation_date?: string | null
    motion_hearing_fee_cents?: number | null
    trial_fee_cents?: number | null
    // Per-case overrides of the court's filing method/address.
    filing_method?: string | null
    filing_address?: string | null
  }
  // The case lead attorney's bar number and email, and the court's division and
  // address: all of which court-filing signature blocks and captions ask for.
  attorney?: { barNumber: string | null; email?: string | null } | null
  court?: {
    division: string | null
    address?: string | null
    city?: string | null
    state?: string | null
    // How and where filings reach this court (certificate of service).
    filingMethod?: string | null
    filingAddress?: string | null
  } | null
  client: {
    name: string
    email: string | null
    phone?: string | null
    address?: string | null
    organization?: string | null
    preferredContactMethod?: string | null
  } | null
  firm: {
    name: string
    address: string | null
    city: string | null
    state: string | null
    zip: string | null
    phone: string | null
    fax?: string | null
    email: string | null
  } | null
  nextHearing: { typeLabel: string; date: Date; location?: string | null } | null
  // Dated milestones taken from the case calendar, each the next upcoming
  // non-cancelled event of its kind.
  keyDates?: {
    trial?: Date | null
    statuteOfLimitations?: Date | null
    nextDeadline?: { title: string; date: Date } | null
  } | null
  // Ordered by seq. `dueDate` is a date-only ISO string. These come from the
  // ONE plan the fetch wrapper selects: the newest case invoice that has a
  // schedule. Every installment-derived field below reads that same plan.
  installments: Array<{ amountCents: number; dueDate: string; status?: string | null }>
  flatFeeTotalCents: number | null
  // Due date ('YYYY-MM-DD') of the one invoice that holds the case's flat fees,
  // when there is exactly one and no installment plan: the day a fee paid in
  // full is due. Null when there is a plan, no such invoice, or several.
  flatFeeDueDate?: string | null
  hourlyRateCents: number | null
  // installment_amount_cents of the single active retainer plan, when exactly
  // one applies. See the retainer_amount entry in vocabulary.ts.
  retainerCents?: number | null
  // invoices.down_payment_cents on the plan invoice; null means none declared.
  downPaymentCents?: number | null
  billing?: CaseBillingTotals | null
  now: Date
  // IANA zone every date and time prints in: the firm's own. Defaults to
  // DEFAULT_TIME_ZONE.
  timeZone?: string
}

// Every case field goes through setIfPresent, so this row emits none of them.
export const EMPTY_CASE_ROW: CaseAutofillInputs['caseRow'] = {
  name: '',
  case_number: null,
  court_name: null,
  lead_user_name: '',
}

function setIfPresent(
  values: Record<string, string>,
  key: string,
  value: string | null | undefined,
): void {
  const v = (value ?? '').trim()
  if (v) values[key] = v
}

export function assembleCaseDocumentContext(inputs: CaseAutofillInputs): CaseDocumentContext {
  const { caseRow, attorney, court, client, firm, nextHearing, installments, billing, now } = inputs
  const timeZone = inputs.timeZone ?? DEFAULT_TIME_ZONE
  const values: Record<string, string> = {}
  const repeaterValues: Record<string, Record<string, string>[]> = {}

  // Caption (court filings).
  setIfPresent(values, 'court_name', caseRow.court_name)
  setIfPresent(values, 'court_name_caps', caseRow.court_name?.toUpperCase())
  setIfPresent(values, 'case_number', caseRow.case_number)
  setIfPresent(values, 'court_division', court?.division)
  setIfPresent(values, 'court_address', court?.address)
  setIfPresent(values, 'court_city', court?.city)
  setIfPresent(values, 'court_state', court?.state)
  setIfPresent(values, 'attorney_bar_number', attorney?.barNumber)
  // Strip a doubled judicial title: the caption already prints "JUDGE:".
  const judgeName = caseRow.judge_name ? stripJudgeTitle(caseRow.judge_name) : caseRow.judge_name
  setIfPresent(values, 'judge_name', judgeName)
  setIfPresent(values, 'judge_name_caps', judgeName?.toUpperCase())
  setIfPresent(values, 'defendant_name', client?.name)
  setIfPresent(values, 'defendant_name_caps', client?.name?.toUpperCase())
  setIfPresent(values, 'charges', caseRow.charges)

  // Matter identity (letters, status updates, engagement documents).
  setIfPresent(values, 'case_name', caseRow.name)
  setIfPresent(values, 'case_reference_id', caseRow.case_reference_id)
  setIfPresent(values, 'case_description', caseRow.description)
  setIfPresent(values, 'case_status', humanizeEnumValue(caseRow.status))
  setIfPresent(values, 'practice_area', caseRow.practice_area_name)
  setIfPresent(values, 'case_category', caseRow.category)
  if (caseRow.created_at) {
    setIfPresent(values, 'case_open_date', formatLongDate(new Date(caseRow.created_at), timeZone))
  }

  // Signature block.
  setIfPresent(values, 'attorney_name', caseRow.lead_user_name)
  setIfPresent(values, 'attorney_email', attorney?.email)
  setIfPresent(values, 'firm_name', firm?.name)
  setIfPresent(values, 'firm_address', firm?.address)
  setIfPresent(values, 'firm_city', firm?.city)
  setIfPresent(values, 'firm_state', firm?.state)
  setIfPresent(values, 'firm_zip', firm?.zip)
  setIfPresent(
    values,
    'firm_full_address',
    firm ? [firm.address, firm.city, firm.state, firm.zip].filter(Boolean).join(', ') : null,
  )
  setIfPresent(
    values,
    'firm_city_state_zip',
    firm ? formatCityStateZip(firm.city, firm.state, firm.zip) : null,
  )
  setIfPresent(values, 'firm_phone', firm?.phone)
  setIfPresent(values, 'firm_fax', firm?.fax)
  setIfPresent(values, 'firm_email', firm?.email)

  // Certificate of service. Recipient falls back to the court when no
  // prosecutor is on file.
  setIfPresent(values, 'service_recipient', caseRow.prosecutor_name || caseRow.court_name)
  setIfPresent(values, 'service_recipient_email', caseRow.prosecutor_email)
  values.service_date_legal = formatLegalDate(now, timeZone)
  // How the filing reaches the court. The case's own override wins; otherwise
  // the court's standing method, set once per court.
  setIfPresent(values, 'filing_method', caseRow.filing_method || court?.filingMethod)
  setIfPresent(values, 'filing_address', caseRow.filing_address || court?.filingAddress)

  // Seized vehicle (Motion to Release Vehicle, Vehicle Release Order).
  setIfPresent(values, 'license_plate', caseRow.license_plate)
  if (caseRow.citation_date) {
    setIfPresent(values, 'citation_date', formatLongDateFromDateOnly(caseRow.citation_date))
  }

  // Letters / rep agreement.
  values.letter_date = formatLongDate(now, timeZone)
  values.full_date = formatLongDate(now, timeZone)
  values.date = formatShortDate(now, timeZone)
  const nowParts = datePartsInZone(now, timeZone)
  values.year = String(nowParts.year)
  values.month = nowParts.month
  values.day = String(nowParts.day)

  const { firstName, lastName } = splitClientName(client?.name)
  setIfPresent(values, 'client_name', client?.name)
  setIfPresent(values, 'client_email', client?.email)
  setIfPresent(values, 'client_phone', client?.phone)
  setIfPresent(values, 'client_address', client?.address)
  setIfPresent(values, 'client_organization', client?.organization)
  setIfPresent(values, 'client_preferred_contact_method', client?.preferredContactMethod)
  // "Dear Corwin,": first name.
  setIfPresent(values, 'client_salutation', firstName)
  setIfPresent(values, 'client_last_name', lastName)

  // ODH (resident = case client, facility = opposing party).
  setIfPresent(values, 'resident_name', client?.name)
  setIfPresent(values, 'facility_name', caseRow.opposing_party)
  setIfPresent(values, 'opposing_party', caseRow.opposing_party)

  // Next upcoming hearing (Motion to Continue "current setting" + ODH letter).
  if (nextHearing) {
    values.hearing_type = nextHearing.typeLabel
    values.hearing_date = formatLongDate(nextHearing.date, timeZone)
    values.hearing_date_legal = formatLegalDate(nextHearing.date, timeZone)
    values.hearing_time = formatTimeOfDay(nextHearing.date, timeZone)
    values.hearing_date_informal = formatLongDate(nextHearing.date, timeZone)
    setIfPresent(values, 'hearing_location', nextHearing.location)
  }

  // Dated milestones off the case calendar.
  const keyDates = inputs.keyDates
  if (keyDates?.trial) values.trial_date = formatLongDate(keyDates.trial, timeZone)
  if (keyDates?.statuteOfLimitations) {
    values.statute_of_limitations_date = formatLongDate(keyDates.statuteOfLimitations, timeZone)
  }
  if (keyDates?.nextDeadline) {
    values.next_deadline_date = formatLongDate(keyDates.nextDeadline.date, timeZone)
    setIfPresent(values, 'next_deadline_title', keyDates.nextDeadline.title)
  }

  // Payment schedule (rep agreement). The first installment is called out as
  // the initial payment; the {#payments} repeater lists the remainder.
  if (installments.length > 0) {
    const [first, ...rest] = installments
    values.initial_payment_amount = formatMoneyFromCents(first.amountCents)
    values.initial_payment_date = formatLongDateFromDateOnly(first.dueDate)
    values.installment_count = String(installments.length)
    values.final_payment_date = formatLongDateFromDateOnly(
      installments[installments.length - 1].dueDate,
    )
    // Only when the plan is level. On an uneven schedule there is no single
    // "the installment amount", so the field stays blank rather than naming one
    // of several figures.
    const uniform = installments.every((i) => i.amountCents === first.amountCents)
    if (uniform) values.installment_amount = formatMoneyFromCents(first.amountCents)

    // Next payment = the first installment that has not been paid. A row marked
    // 'partial' is skipped deliberately: what is still owed on it is not stored,
    // so any figure printed would be a guess.
    const nextDue = installments.find((i) => i.status !== 'paid')
    if (nextDue && nextDue.status !== 'partial') {
      values.next_payment_amount = formatMoneyFromCents(nextDue.amountCents)
      values.next_payment_due_date = formatLongDateFromDateOnly(nextDue.dueDate)
    }

    // One row, so `{#payment_plan}...{/payment_plan}` prints the plan paragraph
    // exactly once. The row carries its own values: the engine treats a section
    // as a loop, and both fill paths (the packet and the fill modal) hand a
    // loop its rows, not the top-level values.
    repeaterValues.payment_plan = [
      {
        initial_payment_amount: values.initial_payment_amount,
        initial_payment_date: values.initial_payment_date,
      },
    ]

    // Only the installments still to come, as the vocabulary promises: a paid
    // row here would ask the client for money already received.
    const toCome = rest.filter((i) => i.status !== 'paid')
    if (toCome.length > 0) {
      repeaterValues.payments = toCome.map((i) => ({
        payment_date: formatLongDateFromDateOnly(i.dueDate),
        payment_amount: formatMoneyFromCents(i.amountCents),
      }))
    }
  }

  const flatFeeCents =
    installments.length > 0
      ? installments.reduce((sum, i) => sum + i.amountCents, 0)
      : inputs.flatFeeTotalCents
  if (flatFeeCents != null && flatFeeCents > 0) {
    values.flat_fee_amount = formatMoneyFromCents(flatFeeCents)
  }
  // Paid in full: the due date of the invoice carrying the fee. Only without a
  // plan, since with one the schedule is the answer to "when".
  if (installments.length === 0 && inputs.flatFeeDueDate) {
    values.flat_fee_due_date = formatLongDateFromDateOnly(inputs.flatFeeDueDate)
  }
  // The paid-in-full counterpart of payment_plan: one row when there is a fee
  // and no plan, so `{#paid_in_full}...{/paid_in_full}` prints its wording and
  // the plan paragraph does not. A due date that is not known stays out of the
  // row, so the engine reports it as a blank instead of printing nothing.
  if (installments.length === 0 && values.flat_fee_amount) {
    const row: Record<string, string> = { flat_fee_amount: values.flat_fee_amount }
    setIfPresent(row, 'flat_fee_due_date', values.flat_fee_due_date)
    repeaterValues.paid_in_full = [row]
  }
  // The representation agreement's contingent fees. A stored fact on the case,
  // so a recorded $0 prints as $0.00 and an unrecorded one stays blank.
  if (caseRow.motion_hearing_fee_cents != null) {
    values.motion_hearing_fee_amount = formatMoneyFromCents(caseRow.motion_hearing_fee_cents)
  }
  if (caseRow.trial_fee_cents != null) {
    values.trial_fee_amount = formatMoneyFromCents(caseRow.trial_fee_cents)
  }
  if (inputs.hourlyRateCents != null && inputs.hourlyRateCents > 0) {
    values.hourly_rate = formatMoneyFromCents(inputs.hourlyRateCents)
  }
  if (inputs.retainerCents != null && inputs.retainerCents > 0) {
    values.retainer_amount = formatMoneyFromCents(inputs.retainerCents)
  }
  if (inputs.downPaymentCents != null && inputs.downPaymentCents > 0) {
    values.down_payment_amount = formatMoneyFromCents(inputs.downPaymentCents)
  }

  // Where the matter stands financially. Gated on the case actually having an
  // invoice: with none, these totals are unknown rather than zero, and "$0.00"
  // in a letter reads as a statement that nothing is owed.
  if (billing && billing.invoiceCount > 0) {
    values.total_invoiced_amount = formatMoneyFromCents(billing.totalInvoicedCents)
    values.total_paid_amount = formatMoneyFromCents(billing.totalPaidCents)
    values.outstanding_balance = formatMoneyFromCents(billing.outstandingCents)
    if (billing.totalHours > 0) values.total_hours_billed = formatHours(billing.totalHours)
  }
  // Trust money is tracked on its own ledger, so it is known independently of
  // whether anything has been invoiced.
  if (billing?.trustBalanceCents != null) {
    values.trust_balance = formatMoneyFromCents(billing.trustBalanceCents)
  }

  if (billing && billing.payments.length > 0) {
    repeaterValues.payment_history = billing.payments.map((p) => {
      const row: Record<string, string> = {
        payment_received_date: formatLongDateFromDateOnly(p.date),
        payment_received_amount: formatMoneyFromCents(p.amountCents),
        payment_method: humanizeEnumValue(p.method),
      }
      // Cash and Zelle payments often have no reference number; leaving the key
      // off keeps the same "never write an empty value" rule the scalars follow.
      setIfPresent(row, 'payment_reference', p.reference)
      return row
    })
  }

  if (billing && billing.lineItems.length > 0) {
    repeaterValues.line_items = billing.lineItems.map((l) => ({
      line_item_date: formatLongDateFromDateOnly(l.date),
      line_item_description: l.description,
      line_item_amount: formatMoneyFromCents(l.amountCents),
    }))
  }

  return { values, repeaterValues }
}

// The case client a document is about. The client picked in the fill form wins
// (matched through its clients.id link); with no pick, the case's first client,
// as before. Null for a pick that is not on this case, so the caller loads that
// client's own record instead of silently printing a different person.
export function pickCaseClient<T extends { client_id: string | null }>(
  caseClients: T[],
  clientId: string | null | undefined,
): T | null {
  if (!clientId) return caseClients[0] ?? null
  return caseClients.find((c) => c.client_id === clientId) ?? null
}

// Whose trust ledger a case document may print. A case with two clients has two
// ledgers, so without a pick there is no answer; a pick answers it only when the
// picked client is on the case, since any other client's balance would sit next
// to this matter's bill.
export function trustClientFor(
  linkedClientIds: readonly string[],
  pickedClientId: string | null,
): string | null {
  if (pickedClientId && linkedClientIds.includes(pickedClientId)) return pickedClientId
  return linkedClientIds.length === 1 ? linkedClientIds[0] : null
}

// Firm-defined case fields (firm_config.case_fields) answered on this case,
// keyed by the normalized label so a template tag named after the field
// ("{County}", "{arrest_date}") finds it. Answers for a field the firm has since
// deleted are skipped: nobody can see or correct them any more.
export function customFieldValues(
  defs: CaseFieldDef[],
  answers: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!answers) return out
  for (const def of defs) {
    const key = normalizeFieldKey(def.label)
    const raw = answers[def.id]
    if (!key || raw === undefined || raw === null) continue
    let text: string
    if (def.field_type === 'checkbox') text = raw === true ? 'Yes' : 'No'
    else if (def.field_type === 'date' && typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      text = formatLongDateFromDateOnly(raw)
    } else text = String(raw).trim()
    if (text) out[key] = text
  }
  return out
}

// Built-in values first, then firm-defined ones only under keys no built-in
// value uses. Order matters: the fill resolver keeps the FIRST value it meets
// for a canonical id, so a firm field labelled "Offense" (an alias of charges)
// placed first would print in place of the recorded charges.
export function withCustomFieldValues(
  values: Record<string, string>,
  custom: Record<string, string>,
): Record<string, string> {
  const merged = { ...values }
  for (const [key, value] of Object.entries(custom)) {
    if (!(key in merged)) merged[key] = value
  }
  return merged
}
