// Canonical template-fill vocabulary, the single source of truth for the
// field names the autofill engine understands (document automation).
//
// WHY this module exists:
//   The fill vocabulary has historically been duplicated across three places:
//     1. case-autofill.ts, canonical keys the DB layer emits (layer 1)
//     2. FillTemplateModal.tsx, build*ValueMap alias maps          (layer 2)
//     3. PlaceholderModal.tsx, SUGGESTION_GROUPS insert catalog
//   docs/document-automation.md warns these three must stay in sync or a
//   detected/inserted name lands on a key nothing fills. This module is the
//   authoritative catalog they map onto: it lists every fillable canonical id,
//   its aliases, and its display grouping.
//
//   The auto-bracketing detector (Phase 1) maps a name it finds in an uploaded
//   document to a canonical id via resolveCanonicalId() so the bracketed tag it
//   writes is one the fill engine can populate. Because the detector runs
//   server-side and the modal runs in the browser, normalizeFieldKey lives here
//   (not in FillTemplateModal) so both normalize a name identically, otherwise
//   the detector and the fill layer would disagree on what "Client Name" maps to.
//
// Pure module: no React, no server-only, no I/O, safe to import from both a
// Server Component / server action and a 'use client' component.

// Normalizes a human-facing field name to a stable snake_case key.
// (Lifted verbatim from FillTemplateModal.tsx, behavior is unchanged; the
//  modal now imports it from here so client and server normalize identically.)
export function normalizeFieldKey(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

export type VocabularyGroup =
  | 'client'
  | 'case'
  | 'court'
  | 'firm'
  | 'date'
  | 'hearing'
  | 'deadline'
  | 'billing'

// Which layer can actually put a value in this field. A catalog entry with no
// source is a promise the fill engine cannot keep: the detector would happily
// bracket the name, the modal would call it auto-fillable, and the generated
// document would come out blank. The type makes an empty list a compile error,
// and tests/unit/vocabulary.test.ts checks each declaration against the layer
// it names.
//
//   'case-context', assembleCaseDocumentContext() in case-autofill.ts, the
//                      DB layer used when filling from a case (Documents tab).
//   'template-modal', the build*ValueMap alias maps in FillTemplateModal.tsx,
//                      used when filling a hand-authored template from
//                      /templates with a case/client picked in the modal.
export type FillSource = 'case-context' | 'template-modal'

// A field whose value is sensitive in a document that leaves the firm.
//   'party', pulls from THIS case's client on a form that may name
//                    several parties.
//   'work-product', the firm's own narrative about the matter (case summary,
//                    time-entry descriptions). Privileged / attorney work
//                    product; fine on an internal memo, rarely fine on a filing
//                    or a document handed to the other side.
export type FieldCaution = 'party' | 'work-product'

export type VocabularyEntry = {
  // The canonical placeholder tag the fill engine populates, e.g. `client_name`
  // → `{client_name}`. Must be a normalized snake_case key.
  id: string
  // Human label for the review/insert UI.
  label: string
  // Which suggestion group the field belongs to.
  group: VocabularyGroup
  // Alternative names a detector or author might use for this field. Matched
  // case-insensitively via normalizeFieldKey, so "Case No." and "case_no" both
  // resolve here. The id itself is always an implicit alias.
  aliases: string[]
  // Every layer that can fill this field. Non-empty by construction.
  sources: readonly [FillSource, ...FillSource[]]
  // Set when the value needs a warning beside it at review time.
  // Client-group fields carry the 'party' caution implicitly.
  caution?: FieldCaution
}

// The catalog. Every entry is backed by at least one fill layer (see `sources`),
// so anything that resolves to an id here is auto-fillable; a name that resolves
// to nothing is a custom field the user types.
export const CANONICAL_VOCABULARY: VocabularyEntry[] = [
  // ── Client (the case client doubles as criminal defendant / ODH resident) ──
  // POSTURE WARNING: the bare aliases here ('name', 'full_name') resolve any
  // unqualified name label to THIS CASE'S CLIENT. That is right for a letter or
  // an engagement agreement, and can be wrong on a court form, where "Name"
  // appears once per party, on a complaint the first one is the plaintiff, who
  // is the client only when the firm is on that side. The aliases are kept
  // (removing them would break every hand-authored template that relies on
  // them); the review step warns instead, see clientFieldCaution below and its
  // use in AutoBracketReview.
  { id: 'client_name', label: 'Client full name', group: 'client',
    aliases: ['client', 'name', 'full_name', 'defendant_name', 'resident_name', 'defendant',
              'client_full_name'],
    sources: ['case-context', 'template-modal'] },
  { id: 'defendant_name_caps', label: 'Client name (UPPERCASE)', group: 'client',
    aliases: ['defendant_name_caps'], sources: ['case-context', 'template-modal'] },
  { id: 'client_salutation', label: 'Client first name (salutation)', group: 'client',
    aliases: ['client_first_name', 'first_name'], sources: ['case-context', 'template-modal'] },
  { id: 'client_last_name', label: 'Client last name', group: 'client',
    aliases: ['last_name', 'surname'], sources: ['case-context', 'template-modal'] },
  { id: 'client_email', label: 'Client email', group: 'client',
    aliases: ['email', 'email_address', 'client_email_address'],
    sources: ['case-context', 'template-modal'] },
  { id: 'client_phone', label: 'Client phone', group: 'client',
    aliases: ['phone', 'phone_number', 'telephone', 'mobile', 'mobile_phone', 'client_phone_number',
              'client_telephone', 'client_cell_phone'],
    sources: ['case-context', 'template-modal'] },
  { id: 'client_address', label: 'Client mailing address', group: 'client',
    aliases: ['client_location', 'address', 'street_address', 'mailing_address',
              'client_street_address', 'client_mailing_address', 'client_home_address'],
    sources: ['case-context', 'template-modal'] },
  { id: 'client_organization', label: 'Client organization', group: 'client',
    aliases: ['organization', 'company', 'company_name'],
    sources: ['case-context', 'template-modal'] },
  { id: 'client_preferred_contact_method', label: 'Preferred contact method', group: 'client',
    aliases: ['preferred_contact_method', 'contact_method'],
    sources: ['case-context', 'template-modal'] },
  // Lives on `clients`, not on the `case_clients` row the case context reads,
  // so only the modal (which has the firm client record) can fill it.
  { id: 'client_status', label: 'Client status', group: 'client', aliases: [],
    sources: ['template-modal'] },

  // ── Case / matter ──
  { id: 'case_name', label: 'Case / matter name', group: 'case',
    aliases: ['case', 'case_title', 'matter', 'matter_name'],
    sources: ['case-context', 'template-modal'] },
  { id: 'case_number', label: 'Case number', group: 'case',
    aliases: ['case_no', 'case_num', 'matter_number', 'file_number', 'file_no', 'docket_number'],
    sources: ['case-context', 'template-modal'] },
  { id: 'case_reference_id', label: 'Case reference ID', group: 'case',
    aliases: ['reference_id', 'matter_reference_id'],
    sources: ['case-context', 'template-modal'] },
  // The firm's own summary of the matter, see the 'work-product' caution.
  { id: 'case_description', label: 'Case description', group: 'case', aliases: [],
    sources: ['case-context', 'template-modal'], caution: 'work-product' },
  { id: 'case_status', label: 'Case status', group: 'case', aliases: [],
    sources: ['case-context', 'template-modal'] },
  { id: 'practice_area', label: 'Practice area', group: 'case',
    aliases: ['practice_area_name', 'case_type', 'matter_type', 'type_of_case'],
    sources: ['case-context', 'template-modal'] },
  { id: 'case_category', label: 'Case category', group: 'case', aliases: ['category'],
    sources: ['case-context', 'template-modal'] },
  // `cases.created_at`, when the matter was opened in the system. Close enough
  // to the engagement date for a status letter; NOT aliased to
  // "engagement_date" or "retainer_date", which are legal facts this column
  // does not record.
  { id: 'case_open_date', label: 'Case open date', group: 'case',
    aliases: ['date_opened', 'case_opened_date', 'open_date'], sources: ['case-context'] },
  { id: 'attorney_bar_number', label: 'Attorney bar number', group: 'case',
    // Per-attorney, filled from the case lead attorney's profile. Court
    // signature blocks label this several ways.
    aliases: ['bar_number', 'bar_no', 'attorney_registration_number', 'registration_number',
              'supreme_court_no', 'ohio_bar_number'],
    sources: ['case-context'] },
  { id: 'attorney_name', label: 'Lead attorney name', group: 'case',
    // The court-filing aliases come from federal/Ohio form signature blocks,
    // where the attorney's name line is labelled by what it is FOR rather than
    // whose it is. Unambiguous: these labels never appear in a party block.
    aliases: [
      'lead_attorney', 'lead_user_name', 'lead_lawyer',
      'signature_of_attorney', 'printed_name_of_attorney',
      'attorney_signature', 'attorney_printed_name', 'attorney_for_plaintiff',
      'attorney_for_defendant',
      // Engagement letters name the signing lawyer plainly.
      'attorney', 'lawyer', 'responsible_attorney', 'handling_attorney', 'attorney_of_record',
    ],
    sources: ['case-context', 'template-modal'] },
  { id: 'attorney_email', label: 'Lead attorney email', group: 'case',
    aliases: ['lead_attorney_email', 'attorney_email_address'], sources: ['case-context'] },
  // NOTE: PlaceholderModal offers a `charge_code` insert suggestion, but the
  // fill engine only populates `charges`, inserting `{charge_code}` yields an
  // unfilled tag. Aliased here so the detector maps "charge code" → charges;
  // the modal-suggestion mismatch itself is a pre-existing follow-up (out of
  // Phase 0.1 scope, surgical).
  { id: 'charges', label: 'Charges', group: 'case',
    aliases: ['charge', 'offenses', 'charge_code', 'charge(s)', 'offense', 'charged_offenses'],
    sources: ['case-context', 'template-modal'] },
  // Seized vehicle (Motion to Release Vehicle, Vehicle Release Order).
  { id: 'license_plate', label: 'License plate', group: 'case',
    aliases: ['license_plate_number', 'plate', 'plate_number', 'tag_number'],
    sources: ['case-context'] },
  { id: 'citation_date', label: 'Citation date', group: 'case',
    aliases: ['date_cited', 'date_of_citation', 'offense_date', 'date_of_offense'],
    sources: ['case-context'] },

  // ── Court filing (caption + certificate of service) ──
  { id: 'court_name', label: 'Court name', group: 'court', aliases: ['court'],
    sources: ['case-context', 'template-modal'] },
  { id: 'court_division', label: 'Court division / district', group: 'court',
    // A property of the court, not the matter, see the 2026-08-18 migration.
    aliases: ['division', 'district', 'district_of', 'court_district', 'judicial_division'],
    sources: ['case-context'] },
  { id: 'court_name_caps', label: 'Court name (UPPERCASE)', group: 'court', aliases: [],
    sources: ['case-context', 'template-modal'] },
  { id: 'court_address', label: 'Court street address', group: 'court',
    aliases: ['court_street_address'], sources: ['case-context'] },
  // Certificate of service: how and where the filing reached the court. Set per
  // court (Settings, Courts), overridable on a case.
  { id: 'filing_method', label: 'Filing method', group: 'court',
    aliases: ['method_of_filing', 'method_of_service', 'service_method', 'filing_via'],
    sources: ['case-context'] },
  { id: 'filing_address', label: 'Filing email or address', group: 'court',
    aliases: ['filing_email', 'filing_email_address', 'filing_email_or_address', 'clerk_email'],
    sources: ['case-context'] },
  { id: 'court_city', label: 'Court city', group: 'court', aliases: [], sources: ['case-context'] },
  { id: 'court_state', label: 'Court state', group: 'court', aliases: [], sources: ['case-context'] },
  { id: 'judge_name', label: 'Judge name', group: 'court', aliases: ['judge'],
    sources: ['case-context', 'template-modal'] },
  { id: 'judge_name_caps', label: 'Judge name (UPPERCASE)', group: 'court', aliases: [],
    sources: ['case-context', 'template-modal'] },
  { id: 'opposing_party', label: 'Opposing party / facility', group: 'court',
    aliases: ['facility_name', 'facility'], sources: ['case-context', 'template-modal'] },
  { id: 'service_recipient', label: 'Service recipient', group: 'court',
    aliases: ['prosecutor', 'prosecutor_name'], sources: ['case-context', 'template-modal'] },
  { id: 'service_recipient_email', label: 'Service recipient email', group: 'court',
    aliases: ['prosecutor_email'], sources: ['case-context', 'template-modal'] },
  { id: 'service_date_legal', label: 'Service date (legal form)', group: 'court', aliases: [],
    sources: ['case-context', 'template-modal'] },

  // ── Firm (signature block) ──
  { id: 'firm_name', label: 'Firm name', group: 'firm',
    aliases: ['firm', 'law_firm', 'law_firm_name', 'name_of_law_firm'],
    sources: ['case-context', 'template-modal'] },
  { id: 'firm_address', label: 'Firm street address', group: 'firm',
    aliases: ['law_firm_address', 'office_address'], sources: ['case-context', 'template-modal'] },
  { id: 'firm_city', label: 'Firm city', group: 'firm', aliases: ['law_firm_city'],
    sources: ['case-context', 'template-modal'] },
  { id: 'firm_state', label: 'Firm state', group: 'firm', aliases: ['law_firm_state'],
    sources: ['case-context', 'template-modal'] },
  { id: 'firm_zip', label: 'Firm ZIP', group: 'firm',
    aliases: ['law_firm_zip', 'firm_postal_code'], sources: ['case-context', 'template-modal'] },
  { id: 'firm_full_address', label: 'Firm full address', group: 'firm',
    aliases: ['law_firm_full_address'], sources: ['case-context', 'template-modal'] },
  { id: 'firm_city_state_zip', label: 'Firm city, state ZIP', group: 'firm', aliases: [],
    sources: ['case-context', 'template-modal'] },
  { id: 'firm_phone', label: 'Firm phone', group: 'firm',
    aliases: ['law_firm_phone', 'office_phone'], sources: ['case-context', 'template-modal'] },
  { id: 'firm_fax', label: 'Firm fax', group: 'firm',
    aliases: ['fax', 'law_firm_fax', 'office_fax'], sources: ['case-context', 'template-modal'] },
  { id: 'firm_email', label: 'Firm email', group: 'firm',
    aliases: ['law_firm_email', 'office_email'], sources: ['case-context', 'template-modal'] },

  // ── Date ──
  { id: 'letter_date', label: 'Letter date', group: 'date', aliases: [],
    sources: ['case-context', 'template-modal'] },
  { id: 'full_date', label: 'Full date', group: 'date', aliases: ['long_date', 'date_long'],
    sources: ['case-context', 'template-modal'] },
  { id: 'date', label: "Today's date", group: 'date',
    aliases: ['today', 'current_date', 'todays_date', 'document_date'],
    sources: ['case-context', 'template-modal'] },
  { id: 'year', label: 'Current year', group: 'date', aliases: ['current_year'],
    sources: ['case-context', 'template-modal'] },
  { id: 'month', label: 'Current month', group: 'date', aliases: ['current_month'],
    sources: ['case-context', 'template-modal'] },
  { id: 'day', label: 'Day of month', group: 'date', aliases: ['current_day', 'day_of_month'],
    sources: ['case-context', 'template-modal'] },

  // ── Hearing (next upcoming setting) ──
  { id: 'hearing_type', label: 'Hearing type', group: 'hearing', aliases: [],
    sources: ['case-context'] },
  { id: 'hearing_date', label: 'Hearing date', group: 'hearing',
    aliases: ['hearing_date_informal'], sources: ['case-context'] },
  { id: 'hearing_date_legal', label: 'Hearing date (legal form)', group: 'hearing', aliases: [],
    sources: ['case-context'] },
  { id: 'hearing_time', label: 'Hearing time', group: 'hearing', aliases: [],
    sources: ['case-context'] },
  { id: 'hearing_location', label: 'Hearing location', group: 'hearing',
    aliases: ['courtroom', 'hearing_courtroom'], sources: ['case-context'] },

  // ── Key dates (case_events of a specific type, wherever they fall) ──
  { id: 'trial_date', label: 'Trial date', group: 'deadline', aliases: ['date_of_trial'],
    sources: ['case-context'] },
  { id: 'statute_of_limitations_date', label: 'Statute of limitations date', group: 'deadline',
    aliases: ['statute_of_limitations', 'sol_date', 'limitations_date'],
    sources: ['case-context'] },
  { id: 'next_deadline_date', label: 'Next deadline date', group: 'deadline',
    aliases: ['next_deadline', 'upcoming_deadline_date'], sources: ['case-context'] },
  { id: 'next_deadline_title', label: 'Next deadline description', group: 'deadline',
    aliases: ['upcoming_deadline', 'next_deadline_description'], sources: ['case-context'] },

  // ── Billing ──
  //
  // A representation agreement is a contract, so a money field autofills ONLY
  // when it is a fact stored on this case. A blank the paralegal fills in is a
  // nuisance; a plausible-looking wrong fee is a client-facing problem. That
  // rules out anything the system would have to infer, default, or pick between
  // candidates for, a "usual fee for this charge type", the total of one
  // invoice among several, a declared down payment that may not match what was
  // actually received. Those are deliberately absent from this catalog rather
  // than present and unreliable.
  //
  // The fields below are either stored directly, summed unambiguously over
  // every invoice on the case, or read off the one installment plan the context
  // builder already selects (newest case invoice that has a schedule).

  // ── Billing: the fee terms a representation agreement states ──
  { id: 'flat_fee_amount', label: 'Flat fee amount', group: 'billing',
    aliases: ['flat_fee', 'flat_rate', 'fee_amount', 'legal_fee', 'fee', 'total_fee', 'legal_fees',
              'attorney_fee', 'attorney_fees'],
    sources: ['case-context'] },
  // Paid in full: the due date of the one invoice carrying the flat fee.
  { id: 'flat_fee_due_date', label: 'Flat fee due date (paid in full)', group: 'billing',
    aliases: ['full_payment_date', 'fee_due_date', 'paid_in_full_date'],
    sources: ['case-context'] },
  // The agreement's contingent fees, stored on the case.
  { id: 'motion_hearing_fee_amount', label: 'Motion-hearing fee', group: 'billing',
    aliases: ['motion_hearing_fee', 'suppression_hearing_fee', 'motion_fee'],
    sources: ['case-context'] },
  { id: 'trial_fee_amount', label: 'Trial fee', group: 'billing',
    aliases: ['trial_fee'], sources: ['case-context'] },
  { id: 'hourly_rate', label: 'Hourly rate', group: 'billing',
    aliases: ['rate', 'attorney_hourly_rate', 'billing_rate', 'rate_per_hour'],
    sources: ['case-context'] },
  // The recurring amount of the ONE active retainer billing plan on the case
  // (or, with no case plan, on the picked client). Two active retainer plans
  // leave it blank rather than choosing between them.
  { id: 'retainer_amount', label: 'Retainer amount (per installment)', group: 'billing',
    aliases: ['retainer', 'retainer_fee', 'retainer_payment', 'monthly_retainer'],
    sources: ['case-context'] },
  // invoices.down_payment_cents on the invoice whose schedule the payment
  // fields already read. NULL there means none was declared, so nothing prints.
  { id: 'down_payment_amount', label: 'Down payment amount', group: 'billing',
    aliases: ['down_payment', 'deposit', 'deposit_amount'], sources: ['case-context'] },
  { id: 'initial_payment_amount', label: 'Initial payment amount', group: 'billing',
    aliases: ['initial_payment', 'first_payment', 'first_payment_amount'],
    sources: ['case-context'] },
  { id: 'initial_payment_date', label: 'Initial payment date', group: 'billing',
    aliases: ['first_payment_date', 'initial_payment_due_date'],
    sources: ['case-context'] },
  { id: 'installment_count', label: 'Number of installments', group: 'billing',
    aliases: ['number_of_payments', 'number_of_installments', 'payment_count'],
    sources: ['case-context'] },
  { id: 'installment_amount', label: 'Installment amount (uniform plans)', group: 'billing',
    aliases: ['monthly_payment', 'monthly_payment_amount', 'installment_payment_amount'],
    sources: ['case-context'] },
  { id: 'final_payment_date', label: 'Final payment date', group: 'billing',
    aliases: ['final_installment_date'], sources: ['case-context'] },
  { id: 'next_payment_amount', label: 'Next payment amount', group: 'billing',
    aliases: ['next_installment_amount'], sources: ['case-context'] },
  { id: 'next_payment_due_date', label: 'Next payment due date', group: 'billing',
    aliases: ['next_payment_date', 'next_payment_due', 'next_due_date'],
    sources: ['case-context'] },

  // ── Billing: where the matter stands financially ──
  { id: 'total_invoiced_amount', label: 'Total invoiced', group: 'billing',
    aliases: ['total_invoiced', 'amount_invoiced', 'total_billed', 'total_charges'],
    sources: ['case-context'] },
  { id: 'total_paid_amount', label: 'Total paid to date', group: 'billing',
    aliases: ['total_paid', 'amount_paid', 'paid_to_date', 'payments_received'],
    sources: ['case-context'] },
  { id: 'outstanding_balance', label: 'Outstanding balance', group: 'billing',
    aliases: ['balance', 'balance_due', 'amount_due', 'outstanding_amount',
              'unpaid_balance', 'remaining_balance'],
    sources: ['case-context'] },
  { id: 'total_hours_billed', label: 'Total hours billed', group: 'billing',
    aliases: ['total_hours', 'hours_billed'], sources: ['case-context'] },
  { id: 'trust_balance', label: 'Trust (IOLTA) balance', group: 'billing',
    aliases: ['iolta_balance', 'trust_account_balance', 'client_trust_balance', 'funds_in_trust'],
    sources: ['case-context'] },

  // ── Billing repeater rows ──
  // Scheduled installments still to come: {#payments} … {/payments}.
  { id: 'payment_amount', label: 'Payment amount (schedule row)', group: 'billing', aliases: [],
    sources: ['case-context'] },
  { id: 'payment_date', label: 'Payment date (schedule row)', group: 'billing', aliases: [],
    sources: ['case-context'] },
  // Payments actually received: {#payment_history} … {/payment_history}.
  { id: 'payment_received_date', label: 'Payment received date (history row)', group: 'billing',
    aliases: ['payment_history_date'], sources: ['case-context'] },
  { id: 'payment_received_amount', label: 'Payment received amount (history row)', group: 'billing',
    aliases: ['payment_history_amount'], sources: ['case-context'] },
  { id: 'payment_method', label: 'Payment method (history row)', group: 'billing',
    aliases: ['payment_type'], sources: ['case-context'] },
  { id: 'payment_reference', label: 'Payment reference (history row)', group: 'billing',
    aliases: ['payment_reference_number', 'check_number'], sources: ['case-context'] },
  // Billable charges on the matter: {#line_items} … {/line_items}.
  { id: 'line_item_date', label: 'Charge date (line-item row)', group: 'billing', aliases: [],
    sources: ['case-context'] },
  // Time-entry narratives describe what the firm did and why, see the
  // 'work-product' caution.
  { id: 'line_item_description', label: 'Charge description (line-item row)', group: 'billing',
    aliases: ['line_item_narrative'], sources: ['case-context'], caution: 'work-product' },
  { id: 'line_item_amount', label: 'Charge amount (line-item row)', group: 'billing', aliases: [],
    sources: ['case-context'] },
]

// id → entry, and every normalized alias (and the id itself) → entry.
const ENTRY_BY_ALIAS: Map<string, VocabularyEntry> = (() => {
  const map = new Map<string, VocabularyEntry>()
  for (const entry of CANONICAL_VOCABULARY) {
    for (const key of [entry.id, ...entry.aliases]) {
      const norm = normalizeFieldKey(key)
      if (!norm) continue
      // First writer wins: an id is authoritative over another entry's alias.
      if (!map.has(norm)) map.set(norm, entry)
    }
  }
  // Second pass: ids always win, even over an earlier entry's alias collision.
  for (const entry of CANONICAL_VOCABULARY) {
    map.set(normalizeFieldKey(entry.id), entry)
  }
  return map
})()

// The set of canonical ids (for quick "is this already a canonical tag" checks).
export const CANONICAL_IDS: ReadonlySet<string> = new Set(
  CANONICAL_VOCABULARY.map((e) => e.id),
)

// Resolves any name (a detected span, an inserted tag, a legacy alias) to the
// canonical fill id it maps to, or null when nothing in the catalog matches
// (→ the caller should treat it as a custom, non-autofilling field).
//
// Two spellings an author commonly uses are tried after the plain key, and only
// here: normalizeFieldKey itself is also used to compare record VALUES (client
// names in known-values.ts), where splitting "McDonald" would be wrong.
//   - a possessive: "Client's Name" is the same field as "Client Name". Tried
//     second, so a key that is itself an alias ("todays_date") keeps its match.
//   - CamelCase: "ClientName" / "courtName" are "client name" / "court name".
export function resolveCanonicalId(name: string): string | null {
  const candidates = [
    name,
    name.replace(/['’]s\b/gi, ''),
    name.replace(/([a-z0-9])([A-Z])/g, '$1 $2'),
  ]
  for (const candidate of candidates) {
    const norm = normalizeFieldKey(candidate)
    if (!norm) continue
    const entry = ENTRY_BY_ALIAS.get(norm)
    if (entry) return entry.id
  }
  return null
}

// Returns the catalog entry for a canonical id (or null).
export function vocabularyEntry(id: string): VocabularyEntry | null {
  return CANONICAL_VOCABULARY.find((e) => e.id === id) ?? null
}

// A court-filing caption prints its own judicial label ("JUDGE: {judge_name_caps}"),
// so a judge value that already carries the title ("Judge James E. Green",
// "Hon. Thistlewood", "The Honorable ...") would double it → "JUDGE: JUDGE ...".
// Strip a single leading judicial title so the caption reads cleanly no matter
// how staff typed the name. Guards: \b + a required trailing space mean a real
// name ("Theodore", "Judgey") is never touched, and the value is never reduced
// to empty (falls back to the trimmed original). Applied by BOTH autofill layers
// (case-autofill.ts + FillTemplateModal.tsx) so they agree, see
// docs/document-automation.md.
export function stripJudgeTitle(name: string): string {
  const stripped = name
    .replace(/^\s*(?:the\s+)?(?:hon(?:orable)?\.?\s+)?(?:judge\b[.:]?\s+)?/i, '')
    .trim()
  return stripped || name.trim()
}

// The layers that can fill a canonical id. Empty for a name that is not in the
// catalog at all (→ a custom field the user types).
export function fillSources(id: string): readonly FillSource[] {
  return vocabularyEntry(id)?.sources ?? []
}

// Every canonical id a given layer is expected to fill. The drift guard in
// tests/unit/vocabulary.test.ts compares these sets against what each layer
// really emits, so a field can never sit in the catalog promising a value that
// nothing produces.
export function idsFilledBy(source: FillSource): string[] {
  return CANONICAL_VOCABULARY.filter((e) => e.sources.includes(source)).map((e) => e.id)
}

/**
 * A caution to show beside a field whose value needs a second look before it
 * goes into a document that leaves the firm. Returns null when there is nothing
 * to warn about.
 *
 * Two hazards:
 *
 * 'party' (every client-group field), court forms label a blank by its role
 * ("Name", "Street Address") once per party, and the client vocabulary resolves
 * those unqualified labels to THIS case's client. That is correct on a letter
 * and can be exactly wrong on a complaint, so the reviewer is told what the name
 * will actually do before they save.
 *
 * 'work-product', the field carries the firm's own narrative about the matter
 * (the case summary, a time-entry description). That is privileged material and
 * routine on an internal memo, but putting it on a filing or a document handed
 * to the other side waives more than the author intended.
 */
export function clientFieldCaution(tag: string): string | null {
  const id = resolveCanonicalId(tag)
  if (!id) return null
  const entry = vocabularyEntry(id)
  if (!entry) return null
  if (entry.group === 'client' || entry.caution === 'party') {
    return `Fills with this case's client. On a form that names more than one party, check this blank is your client's and not the other side's.`
  }
  if (entry.caution === 'work-product') {
    return `Fills with the firm's own write-up of this matter. That is attorney work product: check it belongs in a document that leaves the firm.`
  }
  return null
}

// The name a person reads for a template field, in place of the tag the
// template stores: the vocabulary's label for a known field
// ("judge_name_caps" -> "Judge name (UPPERCASE)"), otherwise the tag made
// readable ("some_custom_field" -> "Some Custom Field"). A field inside a
// section ("payment_plan.initial_payment_amount") reads by its own name.
export function fieldLabel(tag: string): string {
  const leaf = tag.includes('.') ? tag.slice(tag.lastIndexOf('.') + 1) : tag
  const id = resolveCanonicalId(leaf)
  const entry = id ? vocabularyEntry(id) : null
  if (entry) return entry.label
  const words = normalizeFieldKey(leaf).split('_').filter(Boolean)
  if (words.length === 0) return tag
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}
