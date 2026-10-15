/**
 * The CSV export/import helpers. Zero coverage before this file.
 *
 * These sit on both ends of a data boundary the user controls. `toCsv` writes
 * what a firm downloads and opens in Excel; `parseCsv` reads what they upload
 * back. The failure mode is not a crash, it is a row that silently splits in
 * two because a matter description contained a comma, or a client name that
 * loses everything after an apostrophe. Neither looks wrong on screen.
 *
 * Two cases below are CHARACTERISATION and marked as such: they record what
 * ships today rather than what is arguably correct, and are reported instead of
 * changed.
 */
import { toCsv, parseCsv, downloadCsv, downloadJson, type CsvColumn } from '@/lib/utils/csv';

const COLUMNS: CsvColumn[] = [
  { key: 'name', header: 'Name' },
  { key: 'notes', header: 'Notes' },
];

describe('toCsv', () => {
  it('writes the header row from the column spec, not from the data keys', () => {
    // Column order and labels are the caller's choice. A version that read
    // Object.keys(row) would reorder columns whenever a row happened to be
    // built in a different order.
    const csv = toCsv([{ notes: 'second', name: 'first' }], COLUMNS);
    expect(csv.split('\r\n')[0]).toBe('Name,Notes');
    expect(csv.split('\r\n')[1]).toBe('first,second');
  });

  it('neutralises formula-looking text but leaves signed numbers as data', () => {
    // Trust ledgers and audit reports are opened in Excel. A description of
    // `=HYPERLINK(...)` must open as text; a withdrawal of -12.50 must still sum.
    const csv = toCsv(
      [
        { name: '=1+2', notes: '@cmd' },
        { name: -1250, notes: '-12.50' },
      ],
      COLUMNS,
    );
    expect(csv).toBe("Name,Notes\r\n'=1+2,'@cmd\r\n-1250,-12.50");
  });

  it('quotes a value containing a newline so it stays one row', () => {
    // A multi-line note is the common source. Unquoted, it ends the record
    // early and the remainder becomes a bogus row.
    const csv = toCsv([{ name: 'x', notes: 'line1\nline2' }], COLUMNS);
    expect(csv).toBe('Name,Notes\r\nx,"line1\nline2"');
    expect(parseCsv(csv)).toEqual([['Name', 'Notes'], ['x', 'line1\nline2']]);
  });

  it('quotes a header that itself contains a comma', () => {
    const csv = toCsv([], [{ key: 'a', header: 'Last, First' }]);
    expect(csv).toBe('"Last, First"');
  });

  it.each([
    // RFC 4180 says CRLF, and Excel on Windows needs it to avoid rendering the
    // whole export as a single line.
    ['separates rows with CRLF', [{ name: 'a', notes: 'x' }, { name: 'b', notes: 'y' }], 'Name,Notes\r\na,x\r\nb,y'],
    // The bug this catches: "Smith, Jane" becoming two columns and shifting
    // every later column of that row by one.
    ['quotes a value containing a comma so it stays one field', [{ name: 'Smith, Jane', notes: '' }], 'Name,Notes\r\n"Smith, Jane",'],
    ['doubles an embedded quote and wraps the field', [{ name: 'He said "no"', notes: '' }], 'Name,Notes\r\n"He said ""no""",'],
    // An absent middle name must export as blank. String(null) would print the
    // literal text into the spreadsheet.
    ['renders null and undefined as empty, not as the words "null"/"undefined"', [{ name: null, notes: undefined }], 'Name,Notes\r\n,'],
    // A falsy-check instead of a null-check would blank out a zero balance,
    // which reads as "no data" instead of "nothing owed".
    ['renders zero and false rather than treating them as absent', [{ name: 0, notes: false }], 'Name,Notes\r\n0,false'],
    ['emits only the header row for an empty data set', [], 'Name,Notes'],
    ['emits an empty field for a key missing from the row', [{ name: 'only' }], 'Name,Notes\r\nonly,'],
  ] as Array<[string, Record<string, unknown>[], string]>)('%s', (_label, rows, expected) => {
    expect(toCsv(rows, COLUMNS)).toBe(expected);
  });
});

describe('parseCsv', () => {
  it.each([
    ['splits a plain LF-delimited file into rows and cells', 'a,b\nc,d', [['a', 'b'], ['c', 'd']]],
    // Consuming only the LF leaves "b\r", which then fails every downstream
    // string comparison for a reason that is invisible in a log.
    ['splits a CRLF-delimited file without leaving a stray CR on the last cell', 'a,b\r\nc,d', [['a', 'b'], ['c', 'd']]],
    ['treats a lone CR as a row break', 'a,b\rc,d', [['a', 'b'], ['c', 'd']]],
    ['keeps a comma that appears inside quotes in one cell', '"Smith, Jane",x', [['Smith, Jane', 'x']]],
    ['unescapes a doubled quote back to a single quote', '"He said ""no""",x', [['He said "no"', 'x']]],
    ['keeps a newline that appears inside quotes in one cell', '"line1\nline2",x', [['line1\nline2', 'x']]],
    // Inside quotes the CR is literal content, not a record separator.
    ['keeps a CRLF that appears inside quotes in one cell', '"line1\r\nline2",x', [['line1\r\nline2', 'x']]],
    // Almost every file ends with a newline. An extra empty row at the end
    // imports as a blank client.
    ['ignores the blank row a terminal LF would otherwise produce', 'a,b\nc,d\n', [['a', 'b'], ['c', 'd']]],
    ['ignores the blank row a terminal CRLF would otherwise produce', 'a,b\r\nc,d\r\n', [['a', 'b'], ['c', 'd']]],
    ['returns no rows for empty input', '', []],
    // Column position carries meaning. Dropping empties would shift every
    // later value left into the wrong column.
    ['preserves empty leading, middle, and trailing cells', ',b,', [['', 'b', '']]],
    ['preserves whitespace inside a cell rather than trimming it', ' a , b ', [[' a ', ' b ']]],
    ['treats an empty quoted field as an empty cell', '"",b', [['', 'b']]],
    ['flushes the final field when the input does not end in a newline', 'a,b', [['a', 'b']]],
    // A row of empty FIELDS is data: three blank cells is a real record in a
    // template file, and dropping it silently loses a row on import. Only a
    // trailing blank LINE is an artifact, and the two are distinguishable by
    // cell count.
    ['keeps a final record whose fields are all empty', 'a,b\r\n,,', [['a', 'b'], ['', '', '']]],
    // The case the cleanup exists for. A file ending in a bare newline, or in
    // two, must not import as a blank record.
    ['still drops a trailing blank LF line', 'a,b\n\n', [['a', 'b']]],
    ['still drops a trailing blank CRLF line', 'a,b\r\n\r\n', [['a', 'b']]],
  ] as Array<[string, string, string[][]]>)('%s', (_label, input, expected) => {
    expect(parseCsv(input)).toEqual(expected);
  });

  it('CHARACTERISATION: leaves an unterminated quoted field open to end of input', () => {
    // A file with an odd number of quotes swallows the rest of itself into one
    // cell instead of raising. Callers get one giant row rather than an error.
    expect(parseCsv('"unterminated,a\nb,c')).toEqual([['unterminated,a\nb,c']]);
  });

  it('round-trips whatever toCsv produced', () => {
    // The property that matters: anything exported can be re-imported. This is
    // the single assertion that would go red if either side of the pair changed
    // its escaping rules without the other.
    const rows = [
      { name: 'plain', notes: 'nothing special' },
      { name: 'Smith, Jane', notes: 'He said "no"' },
      { name: 'multi\nline', notes: '' },
      { name: '', notes: 'leading empty' },
    ];
    const parsed = parseCsv(toCsv(rows, COLUMNS));
    expect(parsed[0]).toEqual(['Name', 'Notes']);
    expect(parsed.slice(1)).toEqual(rows.map((r) => [r.name, r.notes]));
  });
});

describe('downloadCsv / downloadJson', () => {
  let createdUrls: string[];
  let revokedUrls: string[];
  let clicks: { href: string; download: string }[];
  let blobs: { text: string; type: string }[];
  const RealBlob = global.Blob;

  beforeEach(() => {
    createdUrls = [];
    revokedUrls = [];
    clicks = [];
    blobs = [];

    // jsdom's Blob has no `.text()`, so the parts are captured on the way in.
    // Recording them here also pins the exact byte prefix, which is the point
    // of the BOM case below.
    class CapturingBlob extends RealBlob {
      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        blobs.push({ text: parts.join(''), type: options?.type ?? '' });
      }
    }
    global.Blob = CapturingBlob as unknown as typeof Blob;

    // jsdom implements neither of these, so without stubs the functions throw
    // before doing anything observable.
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => {
      const url = `blob:test/${createdUrls.length}`;
      createdUrls.push(url);
      return url;
    };
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = (url) => {
      revokedUrls.push(url);
    };

    jest
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicks.push({ href: this.href, download: this.download });
      });
  });

  afterEach(() => {
    global.Blob = RealBlob;
    jest.restoreAllMocks();
  });

  it('names the downloaded file and clicks the link exactly once', () => {
    downloadCsv('clients.csv', 'a,b');
    expect(clicks).toHaveLength(1);
    expect(clicks[0].download).toBe('clients.csv');
    expect(clicks[0].href).toBe(createdUrls[0]);
  });

  it('revokes the object URL it created', () => {
    // Not cosmetic: an un-revoked blob URL pins the whole file in memory for
    // the life of the tab, and exports are the largest strings this app builds.
    downloadCsv('clients.csv', 'a,b');
    expect(revokedUrls).toEqual(createdUrls);
  });

  it('prepends a UTF-8 BOM so spreadsheet apps render accents', () => {
    // Without the BOM, Excel reads the bytes as Latin-1 and a client named
    // "Munoz" with a tilde imports as mojibake.
    downloadCsv('clients.csv', 'Mu\u00f1oz');
    expect(blobs[0].text).toBe('\ufeffMu\u00f1oz');
  });

  it('marks the CSV blob as text/csv with a UTF-8 charset', () => {
    downloadCsv('clients.csv', 'a,b');
    expect(blobs[0].type).toBe('text/csv;charset=utf-8;');
  });

  it('writes pretty-printed JSON with no BOM', () => {
    // The JSON path deliberately omits the BOM: JSON.parse rejects a leading
    // U+FEFF, so adding one here would break re-import.
    downloadJson('backup.json', { b: 2, a: [1] });
    expect(blobs[0].text).toBe('{\n  "b": 2,\n  "a": [\n    1\n  ]\n}');
    expect(blobs[0].text.startsWith('\ufeff')).toBe(false);
    expect(blobs[0].type).toBe('application/json;charset=utf-8;');
  });
});
