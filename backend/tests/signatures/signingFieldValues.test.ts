import {
  drawTextValue,
  findMissingRequiredFields,
  findForeignFieldSubmissions,
  filterValuesToParticipant,
  getFieldBox,
  findUnembeddableSignatureFields,
} from '../../src/modules/signatures/signingFieldValues';

const VALID_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const TRUNCATED_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAE=';
const NON_PNG_DATA_URL =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

describe('Signatures: signingFieldValues', () => {
  describe('findMissingRequiredFields', () => {
    const participantId = 'signer-1';
    const fields = [
      { id: 'f-sig', signerId: 'signer-1', fieldType: 'signature', required: true },
      { id: 'f-init', signerId: 'signer-1', fieldType: 'initials', required: true },
      { id: 'f-date', signerId: 'signer-1', fieldType: 'date', required: true },
      { id: 'f-text', signerId: 'signer-1', fieldType: 'text', required: true },
      { id: 'f-check', signerId: 'signer-1', fieldType: 'checkbox', required: true },
      { id: 'f-opt', signerId: 'signer-1', fieldType: 'text', required: false },
      { id: 'f-other', signerId: 'signer-2', fieldType: 'text', required: true },
    ];

    it('flags missing or unfilled required fields', () => {
      const submitted = [
        { fieldId: 'f-sig', value: 'not-a-png' },
        { fieldId: 'f-init', value: VALID_PNG_DATA_URL },
        { fieldId: 'f-date', value: '2026-08-15' },
        { fieldId: 'f-text', value: '   ' }, // Whitespace only
        { fieldId: 'f-check', value: false }, // Unchecked required checkbox
      ];

      const missing = findMissingRequiredFields(fields, participantId, submitted);
      const missingIds = missing.map((f: any) => f.id);

      expect(missingIds).toContain('f-sig'); // invalid PNG
      expect(missingIds).toContain('f-text'); // empty text
      expect(missingIds).toContain('f-check'); // false checkbox
      expect(missingIds).not.toContain('f-init'); // valid PNG
      expect(missingIds).not.toContain('f-date'); // valid date
      expect(missingIds).not.toContain('f-opt'); // optional
      expect(missingIds).not.toContain('f-other'); // other signer
    });

    it('accepts truthy checkbox values (true, "true", 1, "1")', () => {
      const checkField = [{ id: 'f-chk', signerId: 'signer-1', fieldType: 'checkbox' }];
      expect(findMissingRequiredFields(checkField, 'signer-1', [{ fieldId: 'f-chk', value: true }])).toHaveLength(0);
      expect(findMissingRequiredFields(checkField, 'signer-1', [{ fieldId: 'f-chk', value: 'true' }])).toHaveLength(0);
      expect(findMissingRequiredFields(checkField, 'signer-1', [{ fieldId: 'f-chk', value: 1 }])).toHaveLength(0);
      expect(findMissingRequiredFields(checkField, 'signer-1', [{ fieldId: 'f-chk', value: '1' }])).toHaveLength(0);
      expect(findMissingRequiredFields(checkField, 'signer-1', [{ fieldId: 'f-chk', value: '0' }])).toHaveLength(1);
    });
  });

  describe('Forgery prevention and owner separation', () => {
    const fields = [
      { id: 'f-mine-1', signerId: 'signer-1' },
      { id: 'f-theirs-1', signerId: 'signer-2' },
      { id: 'f-unowned-1', signerId: null },
    ];

    it('flags the foreign submission and keeps only owned or unowned values', () => {
      const submitted = [
        { fieldId: 'f-mine-1', value: 'my value' },
        { fieldId: 'f-theirs-1', value: 'forged value' },
        { fieldId: 'f-unowned-1', value: 'shared value' },
      ];

      expect(findForeignFieldSubmissions(fields, 'signer-1', submitted)).toEqual(['f-theirs-1']);
      expect(filterValuesToParticipant(fields, 'signer-1', submitted)).toEqual([
        { fieldId: 'f-mine-1', value: 'my value' },
        { fieldId: 'f-unowned-1', value: 'shared value' },
      ]);
    });
  });

  describe('findUnembeddableSignatureFields', () => {
    it('catches corrupt or truncated PNG images that pass initial header check', async () => {
      const fields = [
        { id: 'f-sig-good', fieldType: 'signature' },
        { id: 'f-sig-bad', fieldType: 'signature' },
        { id: 'f-txt', fieldType: 'text' },
      ];

      const submitted = [
        { fieldId: 'f-sig-good', value: VALID_PNG_DATA_URL },
        { fieldId: 'f-sig-bad', value: TRUNCATED_PNG_DATA_URL },
        { fieldId: 'f-txt', value: 'Some text' },
      ];

      const badFields = await findUnembeddableSignatureFields(fields, submitted);
      expect(badFields).toEqual(['f-sig-bad']);
    });
  });

  describe('drawTextValue: date field formatting', () => {
    // `page`/`font` are stubbed so the drawn text can be captured directly,
    // rather than re-parsing it back out of a rendered PDF. `widthOfTextAtSize`
    // returns a small constant so `fitTextToBox` keeps the date on one line.
    const stubFont = { widthOfTextAtSize: jest.fn(() => 10) };
    const box = { x: 0, y: 0, boxWidth: 300, boxHeight: 40 };

    function drawnLines(fieldType: string, value: string) {
      const lines: string[] = [];
      const page = { drawText: jest.fn((line: string) => lines.push(line)) };
      drawTextValue(page, stubFont, fieldType, value, box);
      return lines;
    }

    // Both the parse and the format are pinned to UTC now (see the doc
    // comment on the source), so this no longer depends on the SERVER
    // PROCESS's local time zone the way an ambient-zone round trip did.
    it.each([
      ['a day-only date as the literal calendar date', '2026-08-31', '8/31/2026'],
      ['the first day of a month', '2026-01-01', '1/1/2026'],
      ['the last day of a month', '2026-12-31', '12/31/2026'],
      ['a leap day', '2028-02-29', '2/29/2028'],
      ['a non-date-shaped value, untouched', 'signed in person', 'signed in person'],
    ])('formats %s', (_label, value, drawn) => {
      expect(drawnLines('date', value)).toEqual([drawn]);
    });
  });

  /**
   * `getFieldBox` is the percent-of-page box math the templates module reuses
   * for Document Overlay stamping. It outlived the pdf-lib stamper that used to
   * live beside it: the signing path composes an appended revision through
   * `pdf/` now, so nothing here loads a whole document to draw on it.
   */
  describe('placing a field on a page', () => {
    it('calculates getFieldBox accurately in PDF coordinates', () => {
      const field = {
        xPercent: 10,
        yPercent: 20,
        widthPercent: 30,
        heightPercent: 10,
      };
      const box = getFieldBox(field, 600, 800);

      expect(box.x).toBe(60); // 10% of 600
      expect(box.boxWidth).toBe(180); // 30% of 600
      expect(box.boxHeight).toBe(80); // 10% of 800
      expect(box.top).toBe(640); // 800 - 20% of 800
      expect(box.y).toBe(560); // 640 - 80
    });

  });

  describe('an unknown fieldId in a submission', () => {
    it('CHARACTERIZATION: is treated as unowned, not as a forgery attempt', () => {
      // `findForeignFieldSubmissions` only rejects a value whose fieldId resolves to
      // ANOTHER signer's field. A fieldId absent from `fields` altogether (never
      // created, or a stale id from a previous, edited layout) resolves to
      // `undefined` from the owner map, which is falsy - exactly like a
      // legitimately unowned field - so it passes through uncontested rather than
      // being flagged. It has no rendering effect (stampSessionFieldsOntoPdf only
      // ever iterates the real `fields` array), but it is silently ACCEPTED and
      // stored rather than rejected as "not part of this document".
      const fields = [{ id: 'f-real', signerId: 'signer-1' }];
      const submitted = [{ fieldId: 'f-does-not-exist', value: 'ghost value' }];

      const foreign = findForeignFieldSubmissions(fields, 'signer-1', submitted);
      expect(foreign).toEqual([]);

      const filtered = filterValuesToParticipant(fields, 'signer-1', submitted);
      expect(filtered).toEqual(submitted);
    });
  });
});
