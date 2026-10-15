/**
 * A ratchet on the one rule the incremental signing lifecycle is built around.
 *
 * A PDF is a range of bytes in storage, never an object in this process. A 2 GB
 * document cannot be a Buffer on a 512 MiB instance, so nothing in that
 * lifecycle may hold one.
 *
 * The reason this is a test and not a comment: every one of the calls below is
 * REASONABLE in isolation. `download()` reads an object, `PDFDocument.load`
 * opens a PDF, `readFileSync` reads a file. Each is the obvious thing to reach
 * for, each works perfectly on the documents a developer tests with, and each
 * silently reintroduces the failure this whole design exists to remove. The old
 * path peaked at 299 MB for a 20 MB document, and nothing about it looked
 * wrong.
 *
 * The list is a RATCHET. Adding a file to it needs a reason written beside the
 * entry, and the reason has to say why the bytes genuinely must be in memory.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { tsFilesUnder, relToSrc, parseTs } from '../support/srcFiles';

/**
 * The files this rule covers.
 *
 * The older signing code is deliberately outside it. That code is what the
 * lifecycle is replacing, and listing it here would mean either a hundred
 * exemptions or a red test that says nothing new.
 */
const COVERED = [
  'modules/signatures/pdf',
  'modules/signatures/signingSources.ts',
  'modules/signatures/signingJobs.ts',
  'modules/signatures/signingPipeline.ts',
  'modules/signatures/signingAudit.ts',
  'modules/signatures/signingProfile.ts',
];

/**
 * Calls that read a whole thing into this process.
 *
 * `download` without a range is the one that matters most: `file.download()`
 * and `file.download({ start, end })` are the same identifier, and only the
 * second is bounded. The check below looks at the arguments.
 */
const FORBIDDEN_CALLS = new Set(['load', 'readFileSync', 'readFile']);

interface Finding { file: string; line: number; what: string }

/** No exemptions today. An entry here needs a reason, not a path. */
const ALLOWED: Record<string, string> = {};

function sourceFiles(): string[] {
  return tsFilesUnder().filter((full) => {
    const rel = relToSrc(full);
    return COVERED.some((c) => rel === c || rel.startsWith(`${c}/`));
  });
}

/** Whether a `download` call names a byte range. */
function isRangedDownload(node: ts.CallExpression): boolean {
  const [first] = node.arguments;
  if (!first || !ts.isObjectLiteralExpression(first)) return false;
  const names = first.properties
    .map((p) => (p.name && ts.isIdentifier(p.name) ? p.name.text : ''))
    .filter(Boolean);
  return names.includes('start') || names.includes('end');
}

function findWholeReads(): Finding[] {
  const out: Finding[] = [];

  for (const file of sourceFiles()) {
    const source = parseTs(file);
    const rel = relToSrc(file);

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;

        if (method === 'download' && !isRangedDownload(node)) {
          out.push({ file: rel, line, what: 'download() with no byte range' });
        }
        if (FORBIDDEN_CALLS.has(method)) {
          const receiver = ts.isIdentifier(node.expression.expression)
            ? node.expression.expression.text : '';
          // `PDFDocument.load` and `fs.readFileSync` both put a whole file here.
          if (receiver === 'PDFDocument' || receiver === 'fs' || method === 'readFileSync') {
            out.push({ file: rel, line, what: `${receiver}.${method}()` });
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    ts.forEachChild(source, visit);
  }
  return out;
}

it('reads no whole document anywhere in the incremental signing lifecycle', () => {
  const findings = findWholeReads().filter((f) => !ALLOWED[`${f.file}:${f.line}`]);

  expect(
    findings.length === 0 ? '' :
      'These read a whole object into a 512 MiB container:\n'
      + findings.map((f) => `  ${f.file}:${f.line}  ${f.what}`).join('\n')
      + '\n\nRead a bounded window instead: openGcsPdfSource gives ranged reads and\n'
      + 'a stream, and every structure above it is built from windows. If the\n'
      + 'bytes genuinely must be in this process, add the site to ALLOWED in\n'
      + 'tests/config/signingLifecycleBounded.test.ts and say why.',
  ).toBe('');
});

it('covers the files it claims to, so the rule cannot be dodged by moving code', () => {
  // A ratchet that scans nothing passes forever. This asserts the scan actually
  // reached the engine, which is the part the rule is about.
  const scanned = sourceFiles().map((f) => path.basename(f));

  expect(scanned).toEqual(expect.arrayContaining([
    'gcsSource.ts', 'reader.ts', 'writer.ts', 'seal.ts', 'signingPipeline.ts',
  ]));
  expect(scanned.length).toBeGreaterThan(15);
});

it('lists nothing in ALLOWED that is no longer there', () => {
  // A stale exemption is how a ratchet stops working: the line moves, the
  // exemption keeps matching nothing, and the next whole read at that path is
  // pre-approved.
  const findings = findWholeReads().map((f) => `${f.file}:${f.line}`);

  expect(Object.keys(ALLOWED).filter((a) => !findings.includes(a))).toEqual([]);
});
