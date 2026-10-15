import fs from 'fs';
import path from 'path';

const PizZip = require('pizzip');

/**
 * Documents the stress test uploads. Small on purpose: the run measures how the
 * pipeline copes with many users at once, not with one huge file.
 */
const PDF_FIXTURE = path.join(__dirname, '..', '..', 'db', 'seed', 'fixtures', 'notice-of-appearance-a.pdf');

export const samplePdf = (): Buffer => fs.readFileSync(PDF_FIXTURE);

export const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const DOCX_FIELDS = ['client_name', 'matter_name'];

const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

/** The smallest zip LibreOffice and docxtemplater both accept as a real DOCX. */
export function sampleDocx(): Buffer {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  const body = [
    paragraph('Engagement letter'),
    paragraph('Client: {client_name}'),
    paragraph('Matter: {matter_name}'),
    paragraph('This letter confirms the scope of our representation.'),
  ].join('');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}</w:body>
</w:document>`);
  return zip.generate({ type: 'nodebuffer' });
}

/** A 1x1 PNG, the same one the signing tests use as a drawn signature. */
export const SIGNATURE_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A one-page HTML template body for the Chromium export path. */
export const SAMPLE_HTML = [
  '<h1>Engagement letter</h1>',
  '<p>Client: Stress Client</p>',
  '<p>Matter: Stress Matter</p>',
  ...Array.from({ length: 20 }, (_, i) => `<p>Clause ${i + 1}. The firm will provide the services described above.</p>`),
].join('');
