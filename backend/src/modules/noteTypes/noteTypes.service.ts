const noteTypesRepo = require('./noteTypes.repository');
const { NotFoundError } = require('../../shared/errors/AppError');

// Mirrors the frontend's built-in NOTE_TYPE_META (src/constants/statusMeta.ts).
// A custom type slugifying to one of these would silently double up with the
// built-in option in the composer's dropdown, so it's treated as taken too.
// The labels are only used to seed a color-override row the first time a
// built-in type is recolored (see setNoteTypeColor) — the dropdown always
// displays its own frontend label, never this one.
const BUILT_IN_NOTE_TYPE_LABELS: Record<string, string> = {
  'general': 'General',
  'phone-call': 'Phone Call',
  'meeting': 'Meeting',
  'court': 'Court Appearance',
  'research': 'Research',
  'internal': 'Internal Memo',
  'communication': 'Communication',
  'document-review': 'Document Review',
};
const BUILT_IN_NOTE_TYPE_VALUES = new Set(Object.keys(BUILT_IN_NOTE_TYPE_LABELS));

function slugify(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'note-type';
}

function uniqueValue(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/**
 * Create a firm-custom note type. The slug is derived from the label and
 * de-duplicated against both the built-ins and the firm's existing custom
 * types, so this never fails on a name collision — it just picks the next
 * free slug. A label that already names a built-in or an existing custom
 * type (case-insensitively) reuses that type instead of creating a second
 * row with the same label but a different slug, which would otherwise show
 * up as an indistinguishable duplicate in the dropdown.
 */
export async function createNoteType({ lawFirmId, userId, body }: any) {
  const label = body.label.trim();
  const normalizedLabel = label.toLowerCase();

  const builtInMatch = Object.entries(BUILT_IN_NOTE_TYPE_LABELS)
    .find(([, builtInLabel]) => builtInLabel.toLowerCase() === normalizedLabel);
  if (builtInMatch) {
    const [value, builtInLabel] = builtInMatch;
    return { message: 'Note type already exists', noteType: { value, label: builtInLabel } };
  }

  const existing = await noteTypesRepo.listOrdered(lawFirmId);
  const existingMatch = existing.find((row: any) => row.label.trim().toLowerCase() === normalizedLabel);
  if (existingMatch) {
    return { message: 'Note type already exists', noteType: existingMatch };
  }

  const taken = new Set([...BUILT_IN_NOTE_TYPE_VALUES, ...existing.map((row: any) => row.value)]);
  const value = uniqueValue(slugify(label), taken);

  const result = await noteTypesRepo.create(lawFirmId, {
    value,
    label,
    createdBy: userId,
  });

  return { message: 'Note type created successfully', noteType: result };
}

/** List a firm's custom note types (built-ins are a static frontend list). */
export async function listNoteTypes({ lawFirmId }: any) {
  const noteTypes = await noteTypesRepo.listOrdered(lawFirmId);
  return { noteTypes };
}

/**
 * Set the color a firm sees for a note type. `value` may be a firm-custom
 * type (must already exist) or a built-in slug (recolored via a row created
 * on first use, keyed off the built-in label rather than anything client-
 * supplied).
 */
export async function setNoteTypeColor({ lawFirmId, value, color }: any) {
  if (BUILT_IN_NOTE_TYPE_VALUES.has(value)) {
    const noteType = await noteTypesRepo.setColor(lawFirmId, value, BUILT_IN_NOTE_TYPE_LABELS[value], color);
    return { message: 'Note type color updated successfully', noteType };
  }

  const existing = await noteTypesRepo.listOrdered(lawFirmId);
  const match = existing.find((row: any) => row.value === value);
  if (!match) throw new NotFoundError('Note type');

  const noteType = await noteTypesRepo.setColor(lawFirmId, value, match.label, color);
  return { message: 'Note type color updated successfully', noteType };
}
