import { DOCX_FIELDS, sampleDocx, samplePdf } from '../../../scripts/stress-test/fixtures';
import { parseDocxPlaceholders } from '../../../src/modules/templates/docx.service';

describe('stress-test fixtures', () => {
  it('builds a DOCX whose placeholders the template parser finds', () => {
    const parsed = parseDocxPlaceholders(sampleDocx());
    expect([...parsed.fields].sort()).toEqual([...DOCX_FIELDS].sort());
  });

  it('loads a real PDF', () => {
    expect(samplePdf().subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
