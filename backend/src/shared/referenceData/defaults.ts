/**
 * Default reference-data lists seeded for a new firm.
 *
 * Single home for the small standard lists every firm starts with. Firms can
 * edit/add/remove freely after seeding, and can also pull additional entries
 * from the global catalog (court_catalog / utbms_codes) via the catalog module.
 *
 * Courts are intentionally NOT seeded. They start empty and the firm picks
 * from the global court_catalog (the directory is too large to seed a sensible
 * subset).
 */

export const DEFAULT_PRACTICE_AREAS = [
  'Estate Planning', 'Wills', 'Probate', 'Family Law', 'Immigration',
  'Personal Injury', 'Real Estate', 'Criminal Defense', 'Business Law',
  'Dispute Resolution',
];

export const DEFAULT_CHARGE_CODES = [
  { code: 'CON001', name: 'Consultation - Initial' },
  { code: 'LIT001', name: 'Litigation - Research' },
  { code: 'LIT002', name: 'Litigation - Court Appearance' },
  { code: 'DOC001', name: 'Document Review' },
  { code: 'DOC002', name: 'Document Drafting' },
  { code: 'COM001', name: 'Client Communication' },
  { code: 'EST001', name: 'Estate Planning' },
  { code: 'REA001', name: 'Real Estate' },
  { code: 'BUS001', name: 'Business Law' },
  { code: 'FAM001', name: 'Family Law' },
];

/**
 * Default lead pipeline seeded for a new firm — the intake steps most law
 * firms actually run (initial contact, then a consultation) before a lead is
 * Retained, with "lost" branches off the two points where a lead realistically
 * falls out: never responds after contact, or isn't a fit after the
 * consultation. `key` is a local reference used only to wire up `parentKey`
 * at seed time — it is never persisted.
 */
export const DEFAULT_LEAD_STAGE_PIPELINE = [
  { key: 'new', name: 'New', color: '#64748b', isClosed: false, parentKey: null },
  { key: 'contacted', name: 'Contacted', color: '#3b82f6', isClosed: false, parentKey: 'new' },
  { key: 'consultation_scheduled', name: 'Consultation Scheduled', color: '#06b6d4', isClosed: false, parentKey: 'contacted' },
  { key: 'retained', name: 'Retained', color: '#10b981', isClosed: true, parentKey: 'consultation_scheduled' },
  { key: 'unresponsive', name: 'Unresponsive', color: '#64748b', isClosed: true, parentKey: 'contacted' },
  { key: 'not_a_fit', name: 'Not a Fit', color: '#ef4444', isClosed: true, parentKey: 'consultation_scheduled' },
];

/** Default public intake form seeded for a new firm. */
export const DEFAULT_INTAKE_FORM = {
  name: 'General Intake',
  fields: [
    { key: 'full_name', label: 'Full name', type: 'text', required: true },
    { key: 'email', label: 'Email', type: 'email', required: true },
    { key: 'phone', label: 'Phone', type: 'phone', required: false },
    {
      key: 'matter_type', label: 'What can we help you with?', type: 'select', required: true,
      options: ['General Inquiry', 'Family Law', 'Estate Planning', 'Real Estate', 'Business Law', 'Other'],
    },
    { key: 'details', label: 'Tell us about your situation', type: 'textarea', required: false },
  ],
};

export const DEFAULT_EXPENSE_CATEGORIES = [
  { code: 'COURT_FEES', name: 'Court Fees' },
  { code: 'FILING_FEES', name: 'Filing Fees' },
  { code: 'TRAVEL', name: 'Travel' },
  { code: 'EXPERT_WITNESS', name: 'Expert Witness' },
  { code: 'POSTAGE', name: 'Postage' },
  { code: 'COPYING', name: 'Copying' },
  { code: 'SERVICE_OF_PROCESS', name: 'Service of Process' },
  { code: 'OTHER', name: 'Other' },
];
