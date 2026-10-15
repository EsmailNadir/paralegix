import {
  CANONICAL_IDS,
  CANONICAL_VOCABULARY,
  fillSources,
  idsFilledBy,
  normalizeFieldKey,
  resolveCanonicalId,
  stripJudgeTitle,
  vocabularyEntry,
  clientFieldCaution,
} from '../../../src/modules/wordTemplates/lib/vocabulary'
import { assembleCaseDocumentContext, type CaseAutofillInputs } from '../../../src/modules/wordTemplates/lib/case-autofill'

// Tests for the canonical template-fill vocabulary (document automation).
//
// WHY these tests exist (Rule 9: tests verify intent, not just behavior):
//
//   vocabulary.ts is the single catalog the auto-bracketing detector maps a
//   detected field name onto. Two contracts must hold or the feature silently
//   breaks:
//     1. resolveCanonicalId() must map the legacy aliases the fill engine
//        already understands to their canonical id: otherwise the detector
//        writes a {tag} nothing fills.
//     2. The catalog must be a SUPERSET of every key the DB autofill layer
//        (assembleCaseDocumentContext) emits, so the detector can name every
//        auto-fillable field. If someone adds an autofill key without a
//        catalog entry, this test fails loudly (the drift guard).
//   normalizeFieldKey moved here from FillTemplateModal so the server-side
//   detector and the browser fill layer normalize identically; its behavior is
//   pinned below so that lift can't silently drift.

describe('normalizeFieldKey', () => {
  it('lowercases, trims, and snake-cases', () => {
    expect(normalizeFieldKey('  Client Name  ')).toBe('client_name')
    expect(normalizeFieldKey('Case No.')).toBe('case_no')
  })

  it('expands & to "and" and strips apostrophes', () => {
    expect(normalizeFieldKey('Ben & Jerry')).toBe('ben_and_jerry')
    expect(normalizeFieldKey("Today's Date")).toBe('todays_date')
    expect(normalizeFieldKey('Today’s Date')).toBe('todays_date') // curly apostrophe
  })

  it('collapses runs of non-alphanumerics and trims leading/trailing underscores', () => {
    expect(normalizeFieldKey('--Firm  City/State--')).toBe('firm_city_state')
    expect(normalizeFieldKey('___')).toBe('')
  })
})

describe('resolveCanonicalId', () => {
  it('resolves a canonical id to itself', () => {
    expect(resolveCanonicalId('client_name')).toBe('client_name')
    expect(resolveCanonicalId('case_number')).toBe('case_number')
  })

  it('resolves legacy aliases the fill engine understands', () => {
    expect(resolveCanonicalId('Client Name')).toBe('client_name')
    expect(resolveCanonicalId('full name')).toBe('client_name')
    expect(resolveCanonicalId('docket_number')).toBe('case_number')
    expect(resolveCanonicalId('matter')).toBe('case_name')
    expect(resolveCanonicalId('judge')).toBe('judge_name')
    expect(resolveCanonicalId('law firm')).toBe('firm_name')
    expect(resolveCanonicalId('prosecutor')).toBe('service_recipient')
  })

  it('returns null for an unknown name (→ custom field)', () => {
    expect(resolveCanonicalId('witness_signature')).toBeNull()
    expect(resolveCanonicalId('')).toBeNull()
  })

  it('never maps two different aliases of the same concept to different ids', () => {
    // "case", "matter", "matter name" are all the case-name concept.
    const ids = ['case', 'matter', 'matter_name'].map(resolveCanonicalId)
    expect(new Set(ids)).toEqual(new Set(['case_name']))
  })
})

// A rep agreement drafted in Word names its blanks however the author talks.
// Each name below has a stored source in the app, so resolving it to nothing
// makes the paralegal retype a value the portal already holds.
describe('resolveCanonicalId: names authors actually type', () => {
  it('resolves a possessive the way the plain form resolves', () => {
    expect(resolveCanonicalId("Client's Name")).toBe('client_name')
    expect(resolveCanonicalId('client’s address')).toBe('client_address')
    // The apostrophe-stripped key still wins when it is itself an alias.
    expect(resolveCanonicalId("Today's Date")).toBe(resolveCanonicalId('todays_date'))
  })

  it('splits CamelCase and camelCase names into words', () => {
    expect(resolveCanonicalId('ClientName')).toBe('client_name')
    expect(resolveCanonicalId('courtName')).toBe('court_name')
    expect(resolveCanonicalId('HourlyRate')).toBe('hourly_rate')
  })

  it('resolves the short names a representation agreement uses', () => {
    expect(resolveCanonicalId('attorney')).toBe('attorney_name')
    expect(resolveCanonicalId('lawyer')).toBe('attorney_name')
    expect(resolveCanonicalId('defendant')).toBe('client_name')
    expect(resolveCanonicalId('fee')).toBe('flat_fee_amount')
    expect(resolveCanonicalId('flat rate')).toBe('flat_fee_amount')
    expect(resolveCanonicalId('initial payment')).toBe('initial_payment_amount')
    expect(resolveCanonicalId('first payment date')).toBe('initial_payment_date')
    expect(resolveCanonicalId('retainer')).toBe('retainer_amount')
    expect(resolveCanonicalId('down payment')).toBe('down_payment_amount')
    expect(resolveCanonicalId('deposit')).toBe('down_payment_amount')
    expect(resolveCanonicalId('Charge(s)')).toBe('charges')
    expect(resolveCanonicalId('case type')).toBe('practice_area')
    expect(resolveCanonicalId('client street address')).toBe('client_address')
    expect(resolveCanonicalId('client phone number')).toBe('client_phone')
  })

  it('still treats a name with no stored source as custom', () => {
    // No column holds these; resolving them would promise a fill nothing makes.
    expect(resolveCanonicalId('engagement_date')).toBeNull()
    expect(resolveCanonicalId('scope_of_representation')).toBeNull()
  })
})

describe('catalog integrity', () => {
  it('has unique canonical ids, all normalized', () => {
    const ids = CANONICAL_VOCABULARY.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(normalizeFieldKey(id)).toBe(id)
  })

  it('CANONICAL_IDS matches the catalog', () => {
    expect(CANONICAL_IDS.size).toBe(CANONICAL_VOCABULARY.length)
    expect(vocabularyEntry('client_name')?.group).toBe('client')
    expect(vocabularyEntry('not_a_real_id')).toBeNull()
  })
})

// ── Drift guard: every autofill key the DB layer emits must be in the catalog ──

function autofillInputs(): CaseAutofillInputs {
  return {
    caseRow: {
      name: 'State v. Thistlewood',
      case_number: 'TRC0000551',
      court_name: 'Franklin County Municipal Court',
      lead_user_name: 'Morgan Hale',
      opposing_party: 'Sunrise Care Facility',
      judge_name: 'Judge James E. Green',
      charges: 'OVI (M1)',
      prosecutor_name: 'Jane Smith',
      prosecutor_email: 'jsmith@columbus.gov',
    },
    client: { name: 'Corwin Thistlewood', email: 'corwin@example.com' },
    firm: {
      name: 'Hale Law LLC',
      address: '123 Main St',
      city: 'Columbus',
      state: 'Ohio',
      zip: '43209',
      phone: '(614) 555-1234',
      fax: '(614) 555-0199',
      email: 'office@halelaw.example',
    },
    nextHearing: { typeLabel: 'Hearing', date: new Date('2026-03-10T14:30:00Z') },
    // Two installments → initial payment + one {#payments} repeater row.
    installments: [
      { amountCents: 250000, dueDate: '2026-04-01' },
      { amountCents: 100000, dueDate: '2026-05-01' },
    ],
    flatFeeTotalCents: null,
    hourlyRateCents: 30000,
    now: new Date('2026-03-04T12:00:00Z'),
  }
}

describe('drift guard: catalog ⊇ autofill vocabulary', () => {
  it('every scalar autofill key resolves to a canonical catalog entry', () => {
    const { values } = assembleCaseDocumentContext(autofillInputs())
    const unresolved = Object.keys(values).filter((k) => resolveCanonicalId(k) === null)
    expect(unresolved).toEqual([])
  })

  it('every repeater row key resolves to a canonical catalog entry', () => {
    const { repeaterValues } = assembleCaseDocumentContext(autofillInputs())
    const rowKeys = Object.values(repeaterValues).flatMap((rows) =>
      rows.flatMap((row) => Object.keys(row)),
    )
    const unresolved = rowKeys.filter((k) => resolveCanonicalId(k) === null)
    expect(unresolved).toEqual([])
  })
})

// ── Drift guard: the insert catalog (PlaceholderModal SUGGESTION_GROUPS) ──
//
// Hardcoded here rather than imported: PlaceholderModal is a 'use client'
// React component with JSX icons, so importing it into a unit test pulls in the
// DOM. These ids are the contract; if PlaceholderModal adds a suggestion, add
// it here and to the catalog together.
const SUGGESTION_IDS = [
  'client_name', 'client_first_name', 'client_last_name', 'client_email',
  'client_phone', 'client_address', 'client_organization',
  'client_preferred_contact_method', 'client_status',
  'case_name', 'case_number', 'case_reference_id', 'case_description',
  'case_status', 'practice_area', 'charge_code', 'case_category', 'lead_attorney',
  'firm_name', 'firm_address', 'firm_city', 'firm_state', 'firm_zip',
  'firm_full_address', 'firm_phone', 'firm_email',
  'date', 'full_date', 'year', 'month', 'day',
]

describe('drift guard: catalog ⊇ insert suggestions', () => {
  it('every PlaceholderModal suggestion id resolves to a catalog entry', () => {
    const unresolved = SUGGESTION_IDS.filter((id) => resolveCanonicalId(id) === null)
    expect(unresolved).toEqual([])
  })
})

// ── Drift guards: the catalog and the two fill layers must agree ───────────
//
// WHY (the bug these exist to stop): the catalog, the DB context builder and
// FillTemplateModal's alias maps were kept in sync by prose in
// docs/document-automation.md, and they drifted. hearing_*, attorney_bar_number,
// court_division and every billing field were fillable from a case but had no
// entry in the modal's maps, so filling the same template from /templates left
// them permanently blank: silently, because an unfilled tag renders as nothing.
// Each entry now DECLARES which layers fill it, and these tests check the
// declaration against what each layer really does.

// A case with every fact populated, so the context builder emits its whole
// vocabulary. Anything it does NOT emit from this input is a field the catalog
// promises and the builder cannot deliver.
function maximalAutofillInputs(): CaseAutofillInputs {
  return {
    caseRow: {
      name: 'State v. Thistlewood',
      case_number: 'TRC0000551',
      case_reference_id: 'CP-000123',
      description: 'Traffic stop on Livingston Ave; breath test refused.',
      status: 'in_progress',
      practice_area_name: 'Criminal Defense',
      category: 'OVI',
      created_at: '2026-01-12T15:00:00Z',
      court_name: 'Franklin County Municipal Court',
      lead_user_name: 'Morgan Hale',
      opposing_party: 'Sunrise Care Facility',
      judge_name: 'Judge James E. Green',
      charges: 'OVI (M1)',
      prosecutor_name: 'Jane Smith',
      prosecutor_email: 'jsmith@columbus.gov',
      license_plate: 'JKL1234',
      citation_date: '2026-01-10',
      motion_hearing_fee_cents: 75000,
      trial_fee_cents: 150000,
    },
    attorney: { barNumber: '0091234', email: 'morgan@halelaw.example' },
    court: {
      division: 'Eastern Division',
      address: '375 S High St',
      city: 'Columbus',
      state: 'Ohio',
      filingMethod: 'electronic mail',
      filingAddress: 'clerk@fcmcclerk.com',
    },
    client: {
      name: 'Corwin Thistlewood',
      email: 'corwin@example.com',
      phone: '(614) 555-0100',
      address: '88 Oak St, Columbus, OH 43209',
      organization: 'Thistlewood Roofing LLC',
      preferredContactMethod: 'email',
    },
    firm: {
      name: 'Hale Law LLC',
      address: '123 Main St',
      city: 'Columbus',
      state: 'Ohio',
      zip: '43209',
      phone: '(614) 555-1234',
      fax: '(614) 555-0199',
      email: 'office@halelaw.example',
    },
    nextHearing: {
      typeLabel: 'Hearing',
      date: new Date('2026-03-10T14:30:00Z'),
      location: 'Courtroom 4C',
    },
    keyDates: {
      trial: new Date('2026-06-01T13:00:00Z'),
      statuteOfLimitations: new Date('2026-09-01T13:00:00Z'),
      nextDeadline: { title: 'Discovery cutoff', date: new Date('2026-04-15T13:00:00Z') },
    },
    installments: [
      { amountCents: 100000, dueDate: '2026-04-01', status: 'pending' },
      { amountCents: 100000, dueDate: '2026-05-01', status: 'pending' },
    ],
    flatFeeTotalCents: null,
    hourlyRateCents: 30000,
    retainerCents: 150000,
    downPaymentCents: 50000,
    billing: {
      invoiceCount: 2,
      totalInvoicedCents: 300000,
      totalPaidCents: 100000,
      outstandingCents: 200000,
      totalHours: 6.5,
      trustBalanceCents: 50000,
      payments: [
        { date: '2026-03-01', amountCents: 100000, method: 'zelle', reference: 'ZL-4412' },
      ],
      lineItems: [
        { date: '2026-02-20', description: 'Review discovery packet', amountCents: 45000 },
      ],
    },
    now: new Date('2026-03-04T12:00:00Z'),
  }
}

// Every canonical id the context builder actually produces, resolved through
// aliases: it emits `defendant_name` and `resident_name`, both of which are
// aliases of client_name, not ids of their own.
function idsEmittedByCaseContext(): Set<string> {
  // Two runs: the maximal case has an installment plan, and flat_fee_due_date is
  // only emitted when there is none (a fee paid in full), so the second run
  // drops the plan and puts the fee on one invoice.
  const withPlan = assembleCaseDocumentContext(maximalAutofillInputs())
  const paidInFull = assembleCaseDocumentContext({
    ...maximalAutofillInputs(),
    installments: [],
    flatFeeTotalCents: 250000,
    flatFeeDueDate: '2026-02-01',
  })
  const keys = [withPlan, paidInFull].flatMap(({ values, repeaterValues }) => [
    ...Object.keys(values),
    ...Object.values(repeaterValues).flatMap((rows) => rows.flatMap((row) => Object.keys(row))),
  ])
  return new Set(keys.map((k) => resolveCanonicalId(k)).filter((id): id is string => !!id))
}

// The canonical ids FillTemplateModal's build*ValueMap functions can fill.
// Hardcoded rather than imported: the modal is a 'use client' React component,
// so importing it into a unit test pulls in the DOM (same reason SUGGESTION_IDS
// above is a copy). This list is the contract: change an alias array in
// buildCaseValueMap / buildClientValueMap / buildDateValueMap / buildFirmValueMap
// and this list plus the catalog's `sources` have to move with it.
const MODAL_FILLED_IDS = [
  // buildCaseValueMap
  'case_name', 'case_number', 'case_reference_id', 'case_description', 'case_status',
  'practice_area', 'case_category', 'attorney_name', 'court_name', 'court_name_caps',
  'judge_name', 'judge_name_caps', 'charges', 'opposing_party', 'service_recipient',
  'service_recipient_email',
  // buildClientValueMap
  'client_name', 'defendant_name_caps', 'client_salutation', 'client_last_name',
  'client_email', 'client_phone', 'client_address', 'client_organization',
  'client_preferred_contact_method', 'client_status',
  // buildDateValueMap
  'date', 'full_date', 'letter_date', 'service_date_legal', 'year', 'month', 'day',
  // buildFirmValueMap
  'firm_name', 'firm_address', 'firm_city', 'firm_state', 'firm_zip', 'firm_phone',
  'firm_fax', 'firm_email', 'firm_full_address', 'firm_city_state_zip',
]

describe('drift guard: every catalog field has a layer that fills it', () => {
  it('declares at least one fill source per entry', () => {
    const orphans = CANONICAL_VOCABULARY.filter((e) => e.sources.length === 0).map((e) => e.id)
    expect(orphans).toEqual([])
  })

  it('never declares a source twice on one entry', () => {
    const dupes = CANONICAL_VOCABULARY.filter(
      (e) => new Set(e.sources).size !== e.sources.length,
    ).map((e) => e.id)
    expect(dupes).toEqual([])
  })

  it('fillSources() is empty only for names outside the catalog', () => {
    expect(fillSources('client_name')).toContain('case-context')
    expect(fillSources('witness_signature')).toEqual([])
  })
})

describe('drift guard: catalog ↔ case-autofill context builder', () => {
  it('emits every field it claims as a case-context source', () => {
    const emitted = idsEmittedByCaseContext()
    const promised = idsFilledBy('case-context')
    // A field in the catalog marked case-context that the builder never
    // produces is a blank the reviewer is told will fill itself.
    expect(promised.filter((id) => !emitted.has(id))).toEqual([])
  })

  it('emits nothing the catalog does not list as a case-context source', () => {
    const emitted = [...idsEmittedByCaseContext()]
    const promised = new Set(idsFilledBy('case-context'))
    // The reverse: a key the builder produces that the catalog does not know
    // about cannot be detected, inserted or explained in the review UI.
    expect(emitted.filter((id) => !promised.has(id))).toEqual([])
  })
})

describe('drift guard: catalog ↔ FillTemplateModal alias maps', () => {
  it('every id the modal fills is in the catalog', () => {
    expect(MODAL_FILLED_IDS.filter((id) => resolveCanonicalId(id) !== id)).toEqual([])
  })

  it('the catalog marks exactly those ids as template-modal fillable', () => {
    const declared = idsFilledBy('template-modal')
    expect([...declared].sort()).toEqual([...MODAL_FILLED_IDS].sort())
  })
})

describe('stripJudgeTitle: the caption prints "JUDGE:" so a titled value must not double', () => {
  it('strips a leading "Judge" title (any case), with or without separators', () => {
    expect(stripJudgeTitle('Judge James E. Green')).toBe('James E. Green')
    expect(stripJudgeTitle('judge Thistlewood')).toBe('Thistlewood')
    expect(stripJudgeTitle('JUDGE: James E. Green')).toBe('James E. Green')
  })

  it('strips Hon. / Honorable / The Honorable prefixes too', () => {
    expect(stripJudgeTitle('Hon. James E. Green')).toBe('James E. Green')
    expect(stripJudgeTitle('Honorable James E. Green')).toBe('James E. Green')
    expect(stripJudgeTitle('The Honorable Judge James E. Green')).toBe('James E. Green')
  })

  it('leaves an untitled name untouched', () => {
    expect(stripJudgeTitle('Thistlewood')).toBe('Thistlewood')
    expect(stripJudgeTitle('James E. Green')).toBe('James E. Green')
  })

  it('never mistakes a real name that merely starts with the letters for a title', () => {
    expect(stripJudgeTitle('Theodore Smith')).toBe('Theodore Smith') // not "the"
    expect(stripJudgeTitle('Judgey McName')).toBe('Judgey McName') // not "judge"
  })

  it('never reduces the value to empty (falls back to the original)', () => {
    expect(stripJudgeTitle('Judge')).toBe('Judge')
    expect(stripJudgeTitle('  Judge  ')).toBe('Judge')
  })
})

describe('court-filing vocabulary', () => {
  // WHY (Rule 9): these labels come from federal/Ohio form signature blocks. A
  // missing alias here is silent: the field just never auto-fills, and staff
  // retype the firm's own details on every filing.
  it('resolves court-form signature-block labels', () => {
    expect(resolveCanonicalId('name_of_law_firm')).toBe('firm_name')
    expect(resolveCanonicalId('signature_of_attorney')).toBe('attorney_name')
    expect(resolveCanonicalId('printed_name_of_attorney')).toBe('attorney_name')
    expect(resolveCanonicalId('attorney_for_plaintiff')).toBe('attorney_name')
  })

  it('resolves court-form labels that now have a data source', () => {
    // These two were dead ends until users.bar_number and courts.division
    // existed (migration 20260818000020): before that, naming a field
    // bar_number promised autofill and delivered nothing.
    expect(resolveCanonicalId('bar_number')).toBe('attorney_bar_number')
    expect(resolveCanonicalId('supreme_court_no')).toBe('attorney_bar_number')
    expect(resolveCanonicalId('division')).toBe('court_division')
    expect(resolveCanonicalId('district_of')).toBe('court_division')
  })

  it('does not warn on the new court fields: they are not party-scoped', () => {
    expect(clientFieldCaution('bar_number')).toBeNull()
    expect(clientFieldCaution('division')).toBeNull()
  })

  it('warns when a name will pull from this case client', () => {
    // The hazard this guards: on a complaint, "Name" appears once per party and
    // resolves to the CLIENT: which is wrong whenever the firm is on the other
    // side. The alias is deliberately kept (hand-authored templates rely on it),
    // so the reviewer has to be told what it will do.
    expect(clientFieldCaution('name')).toMatch(/check this blank is your client/i)
    expect(clientFieldCaution('client_address')).toMatch(/this case/i)
  })

  it('does not warn for fields that are not party-scoped', () => {
    // A caution on every row would be noise, and noise gets ignored.
    expect(clientFieldCaution('firm_name')).toBeNull()
    expect(clientFieldCaution('case_number')).toBeNull()
    expect(clientFieldCaution('bar_number')).toBeNull()
  })
})
