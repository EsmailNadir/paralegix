/**
 * CSV and vCard translation for the contact directory.
 *
 * Firms arrive with an address book already in Outlook, a practice-management
 * system they are leaving, or a spreadsheet a paralegal maintains, and they
 * leave with one too. Both formats live here rather than in the route so the
 * reading and the writing of a format sit next to each other and stay
 * symmetrical — an export this module produces is an import it accepts.
 */

// Column order for the CSV, and the field each column maps to. Also the header
// row, so a file this module writes reads back in without editing.
export const CSV_COLUMNS = [
  ['Name', 'name'],
  ['Type', 'contactType'],
  ['Category', 'category'],
  ['Organization', 'organization'],
  ['Title', 'title'],
  ['Bar Number', 'barNumber'],
  ['Email', 'email'],
  ['Phone', 'phone'],
  ['Alternate Phone', 'phoneAlt'],
  ['Fax', 'fax'],
  ['Website', 'website'],
  ['Address', 'address'],
  ['Tags', 'tags'],
  ['Notes', 'notes'],
];

// Header spellings accepted on import, normalized to lowercase alphanumerics so
// "Bar Number", "bar_number" and "barnumber" all land on the same field.
const CSV_ALIASES = {
  name: 'name', fullname: 'name', displayname: 'name', contactname: 'name',
  type: 'contactType', contacttype: 'contactType',
  category: 'category', role: 'category',
  organization: 'organization', company: 'organization', firm: 'organization',
  title: 'title', jobtitle: 'title',
  barnumber: 'barNumber', bar: 'barNumber',
  email: 'email', emailaddress: 'email', email1: 'email', primaryemail: 'email',
  phone: 'phone', phonenumber: 'phone', mobile: 'phone', mobilephone: 'phone', businessphone: 'phone',
  alternatephone: 'phoneAlt', phonealt: 'phoneAlt', secondaryphone: 'phoneAlt', homephone: 'phoneAlt',
  fax: 'fax', faxnumber: 'fax',
  website: 'website', url: 'website', web: 'website',
  address: 'address', streetaddress: 'address', mailingaddress: 'address',
  tags: 'tags', categories: 'tags',
  notes: 'notes', note: 'notes', comments: 'notes',
};

const normalizeHeader = (h: any) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Quote a CSV field only when it needs it, and double any embedded quotes. */
function csvCell(value: any) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Split one CSV line, honouring quoted fields and doubled quotes inside them.
 * Newlines inside a quoted field are handled by `splitCsvRows` before this runs.
 */
function splitCsvLine(line: any) {
  const cells = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cell += '"'; i += 1; }
        else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { cells.push(cell); cell = ''; }
    else cell += ch;
  }
  cells.push(cell);
  return cells;
}

/**
 * Break the file into logical rows. A quoted field may contain newlines (a
 * multi-line address is the common case), so rows cannot be found by splitting
 * on newline alone.
 */
function splitCsvRows(text: any) {
  const rows = [];
  let row = '';
  let inQuotes = false;
  const source = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      row += ch;
    } else if (ch === '\n' && !inQuotes) {
      rows.push(row);
      row = '';
    } else row += ch;
  }
  if (row.trim()) rows.push(row);
  return rows.filter((r) => r.trim() !== '');
}

/** The directory as CSV, one row per contact, with a header row. */
export function toCsv(contacts: any) {
  const lines = [CSV_COLUMNS.map(([header]) => csvCell(header)).join(',')];
  for (const contact of contacts) {
    lines.push(CSV_COLUMNS.map(([, field]) => {
      const value = field === 'tags' ? (contact.tags || []).join('; ') : contact[field];
      return csvCell(value);
    }).join(','));
  }
  // Trailing newline: some spreadsheet apps drop the last row without one.
  return `${lines.join('\n')}\n`;
}

/**
 * Parse a CSV into contact-shaped rows. Unknown columns are ignored rather than
 * rejected, because exports from other systems always carry columns this one
 * has no field for, and losing those is better than refusing the file.
 */
export function parseCsv(text: any) {
  const rows = splitCsvRows(text);
  if (!rows.length) return [];

  const aliases = CSV_ALIASES as Record<string, string | undefined>;
  const headers = splitCsvLine(rows[0]).map((h: string) => aliases[normalizeHeader(h)] || null);
  if (!headers.some(Boolean)) return [];

  // Nameless rows are KEPT, carrying `sourceRow`, rather than filtered out here.
  // Dropping them made the importer's own "No name." branch unreachable, so a
  // file with twelve nameless rows reported twelve fewer contacts imported and
  // nothing failed. It also shifted every later row's number, because the
  // importer counts positions in this array: the user was sent to the wrong line
  // of their spreadsheet to fix a duplicate.
  //
  // `sourceRow` is the position among DATA rows, 1-based, so the header does not
  // count. That is the number the importer already reported and the frontend
  // already renders; it is now correct rather than merely present.
  return rows.slice(1).map((line, index) => {
    const cells = splitCsvLine(line);
    const row: Record<string, unknown> = { sourceRow: index + 1 };
    headers.forEach((field, i) => {
      if (!field) return;
      const value = (cells[i] || '').trim();
      if (!value) return;
      if (field === 'tags') row.tags = value.split(/[;|]/).map((t: string) => t.trim()).filter(Boolean);
      else row[field] = value;
    });
    return row;
  });
}

/** Escape the vCard delimiters (`\ ; , ` and newline) in a property value. */
const vCardValue = (value: any) => String(value == null ? '' : value)
  .replace(/\\/g, '\\\\')
  .replace(/\n/g, '\\n')
  .replace(/,/g, '\\,')
  .replace(/;/g, '\\;');

/** The directory as vCard 3.0, the format Outlook and Apple Contacts import. */
export function toVCard(contacts: any) {
  const cards = contacts.map((contact: any) => {
    const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
    lines.push(`FN:${vCardValue(contact.name)}`);
    // N is required by the spec. A company has no given/family split, and
    // neither do most of the names firms actually type, so the whole name goes
    // in the family-name slot rather than being guessed apart.
    lines.push(`N:${vCardValue(contact.name)};;;;`);
    if (contact.organization) lines.push(`ORG:${vCardValue(contact.organization)}`);
    if (contact.title) lines.push(`TITLE:${vCardValue(contact.title)}`);
    if (contact.email) lines.push(`EMAIL;TYPE=INTERNET:${vCardValue(contact.email)}`);
    if (contact.phone) lines.push(`TEL;TYPE=WORK,VOICE:${vCardValue(contact.phone)}`);
    if (contact.phoneAlt) lines.push(`TEL;TYPE=CELL:${vCardValue(contact.phoneAlt)}`);
    if (contact.fax) lines.push(`TEL;TYPE=FAX:${vCardValue(contact.fax)}`);
    if (contact.website) lines.push(`URL:${vCardValue(contact.website)}`);
    if (contact.address) lines.push(`ADR;TYPE=WORK:;;${vCardValue(contact.address)};;;;`);
    if (contact.tags?.length) lines.push(`CATEGORIES:${contact.tags.map(vCardValue).join(',')}`);
    if (contact.notes) lines.push(`NOTE:${vCardValue(contact.notes)}`);
    lines.push('END:VCARD');
    return lines.join('\r\n');
  });
  return `${cards.join('\r\n')}\r\n`;
}

/** Undo `vCardValue`. */
const unescapeVCard = (value: any) => String(value || '')
  .replace(/\\n/gi, '\n')
  .replace(/\\,/g, ',')
  .replace(/\\;/g, ';')
  .replace(/\\\\/g, '\\');

/**
 * Parse a vCard file into contact-shaped rows.
 *
 * Handles the line folding the spec requires (a continuation line starts with a
 * space or tab), which is how most real exports wrap long addresses and notes —
 * reading them line-by-line without unfolding truncates every one of them.
 */
export function parseVCard(text: any) {
  const unfolded = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n[ \t]/g, '');

  const contacts = [];
  let current: Record<string, any> | null = null;
  // Counts every BEGIN:VCARD, so a nameless card still consumes its number and
  // the cards after it keep the position the user sees in their file.
  let cardNumber = 0;

  for (const rawLine of unfolded.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^BEGIN:VCARD$/i.test(line)) {
      cardNumber += 1;
      current = { sourceRow: cardNumber } as Record<string, any>;
      continue;
    }
    if (/^END:VCARD$/i.test(line)) {
      // A nameless card is pushed too, for the reason given on parseCsv: the
      // importer reports it rather than silently losing it.
      if (current) contacts.push(current);
      current = null;
      continue;
    }
    if (!current) continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    // "TEL;TYPE=CELL" -> property TEL with the params after it.
    const [property, ...params] = line.slice(0, colon).split(';');
    const value = unescapeVCard(line.slice(colon + 1)).trim();
    if (!value) continue;
    const prop = property.toUpperCase();
    const paramText = params.join(';').toUpperCase();

    if (prop === 'FN') current.name = value;
    else if (prop === 'N' && !current.name) current.name = value.split(';').filter(Boolean).reverse().join(' ').trim();
    else if (prop === 'ORG') current.organization = value.split(';')[0].trim();
    else if (prop === 'TITLE') current.title = value;
    else if (prop === 'EMAIL' && !current.email) current.email = value;
    else if (prop === 'URL') current.website = value;
    else if (prop === 'NOTE') current.notes = value;
    else if (prop === 'CATEGORIES') current.tags = value.split(',').map((t) => t.trim()).filter(Boolean);
    else if (prop === 'ADR' && !current.address) {
      // ADR is 7 semicolon-separated parts; join the ones that carry an address.
      current.address = value.split(';').map((p) => p.trim()).filter(Boolean).join(', ');
    } else if (prop === 'TEL') {
      if (paramText.includes('FAX')) current.fax = current.fax || value;
      else if (!current.phone) current.phone = value;
      else if (!current.phoneAlt) current.phoneAlt = value;
    }
  }

  return contacts;
}
