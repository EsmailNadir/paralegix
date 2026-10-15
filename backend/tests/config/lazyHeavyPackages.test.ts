/**
 * Packages that only some routes use, kept out of the boot graph.
 *
 * The API runs in a 512 MiB Cloud Run container, and everything a module
 * requires at its top level is loaded when the app boots, whether or not a
 * request ever needs it. The packages below are each a few megabytes to more
 * than ten once loaded (measured with a require hook over the compiled app
 * graph), and each serves one feature: stamping or signing a PDF, filling a
 * DOCX, zipping a folder export. So they are required INSIDE the function that
 * uses them, and a module's top level may only `import type` from them.
 *
 * `geoip-lite` is here for a different reason: its main module reads about
 * 104 MB of data files into memory on require. `src/shared/utils/geoip.ts`
 * reads those files from disk instead and must never require the package at
 * all; `tests/shared/geoip.test.ts` proves that at runtime.
 *
 * What makes this go red: a top-level `require('pdf-lib')`, a value import
 * such as `import { PDFDocument } from 'pdf-lib'`, or an `export ... from` of
 * one of these packages, in any file under `src/`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import { SRC, tsFilesUnder } from '../support/srcFiles';


/** Packages (and their sub-paths) that must not load at import time. */
const LAZY_ONLY_PACKAGES = [
  'pdf-lib',
  '@pdf-lib/fontkit',
  '@signpdf/signpdf',
  '@signpdf/placeholder-pdf-lib',
  '@signpdf/signer-p12',
  'docxtemplater',
  'pizzip',
  'archiver',
  'geoip-lite',
  'puppeteer-core',
  'puppeteer',
];

function isLazyOnly(specifier: string): boolean {
  return LAZY_ONLY_PACKAGES.some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`));
}

function isFunctionBoundary(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node);
}

/** A value import brings the package in; a type-only one is erased at compile time. */
function isValueImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return true; // `import 'pkg'` runs the package for its side effects
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  const bindings = clause.namedBindings;
  if (!bindings) return false;
  if (ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.length === 0 || bindings.elements.some((element) => !element.isTypeOnly);
}

function eagerLoads(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const at = (node: ts.Node, what: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart());
    found.push(`${path.relative(SRC, file)}:${line + 1} ${what}`);
  };

  const visit = (node: ts.Node) => {
    // A call inside a function runs when the function does, which is the point.
    if (isFunctionBoundary(node)) return;

    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && isLazyOnly(node.moduleSpecifier.text) && isValueImport(node)) {
      at(node, `import from '${node.moduleSpecifier.text}'`);
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier) && isLazyOnly(node.moduleSpecifier.text)) {
      at(node, `export from '${node.moduleSpecifier.text}'`);
    }
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly
      && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteral(node.moduleReference.expression)
      && isLazyOnly(node.moduleReference.expression.text)) {
      at(node, `import = require('${node.moduleReference.expression.text}')`);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require'
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])
      && isLazyOnly(node.arguments[0].text)) {
      at(node, `require('${node.arguments[0].text}')`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('heavy, feature-specific packages', () => {
  it('are never loaded at module top level anywhere under src/', () => {
    const offenders = tsFilesUnder().flatMap(eagerLoads);

    expect(offenders).toEqual([]);
  });

  it('are still found by the scan when they are loaded eagerly', () => {
    // Guards the guard: a scan that silently matched nothing would pass above.
    const probe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-packages-')), 'probe.ts');
    fs.writeFileSync(probe, [
      "import type { PDFFont } from 'pdf-lib';",
      "import { PDFDocument } from 'pdf-lib';",
      "const archiver = require('archiver');",
      "export function later() { return require('docxtemplater'); }",
      "export const alsoLater = () => require('pizzip');",
    ].join('\n'));
    try {
      const found = eagerLoads(probe).map((entry) => entry.replace(/^.*:(\d+) /, '$1 '));
      expect(found).toEqual(["2 import from 'pdf-lib'", "3 require('archiver')"]);
    } finally {
      fs.unlinkSync(probe);
      fs.rmdirSync(path.dirname(probe));
    }
  });
});
