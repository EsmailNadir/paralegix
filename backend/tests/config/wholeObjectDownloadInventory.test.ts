/**
 * Every place the API reads a WHOLE storage object into memory, listed.
 *
 * `.download()` answers a Buffer of the entire object. It is the one call that
 * turns a process bounded by windows into one bounded by whatever a document
 * weighs, on a 512 MiB container, and it looks harmless at the call site. A
 * new use has to be added here with the bound that makes it safe, or this
 * fails; so does removing one without removing its line here.
 */
import fs from 'fs';
import { tsFilesUnder, relToSrc } from '../support/srcFiles';


/** File, relative to src/, to the number of whole-object reads and why each is bounded. */
const ALLOWED: Record<string, { count: number; bound: string }> = {
  'shared/documentConversion/converter.ts': {
    count: 2,
    bound: 'the worker buffer result (template conversions, 100 MB converter cap), and the local adapter, '
      + 'which measures the source against the caller cap before reading it',
  },
  'shared/storage/recordArchive.ts': {
    count: 1,
    bound: 'getArtifact: archived certificates and invoice PDFs, generated documents of a few pages',
  },
  'modules/signatures/signingDelivery.ts': {
    count: 1,
    bound: 'the emailed copy, read only when at most SIGNING_ATTACHMENT_MAX_BYTES (5 MiB)',
  },
  'modules/templates/templates.routes.ts': {
    count: 2,
    bound: 'a DOCX template, after settleDirectUpload checked it against OVERLAY_UPLOAD_MAX_BYTES',
  },
  'modules/templates/templates.service.ts': {
    count: 2,
    bound: 'the stored template HTML, and readBounded, which checks the 25 MB cap first',
  },
};

it('lists every whole-object .download() call, with the bound that makes it safe', () => {
  const found: Record<string, number> = {};
  for (const file of tsFilesUnder()) {
    const count = (fs.readFileSync(file, 'utf8').match(/\.download\(\s*\)/g) || []).length;
    if (count > 0) found[relToSrc(file)] = count;
  }
  const allowed = Object.fromEntries(Object.entries(ALLOWED).map(([file, v]) => [file, v.count]));
  expect(found).toEqual(allowed);
});
