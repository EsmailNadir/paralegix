/**
 * Modules that build a storage bucket the moment they are imported.
 *
 * `files.storage.ts` does `admin.storage().bucket(...)` at module scope, so
 * importing it anywhere initializes Firebase. That is fine inside the files
 * module, which cannot work without it. It is not fine as a transitive import
 * of something that has nothing to do with storage.
 *
 * This exists because it already happened: adding a signed-url call to
 * `invoices.service.ts` pulled `files.storage` into the billing graph, and a
 * pure late-fee ARITHMETIC test then failed trying to load cloud credentials.
 * The failure surfaced as an unrelated ESM error deep in a Firebase dependency,
 * in a suite that had nothing to do with the change, which is why it cost more
 * to find than to fix.
 *
 * `recordArchive.ts` shows the shape to copy: its `bucket()` is a FUNCTION, and
 * its own comment says why, so answering a question about a string does not
 * depend on credentials being loadable.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { SRC, tsFilesUnder, relToSrc, parseTs } from '../support/srcFiles';


/**
 * Modules allowed to build cloud clients at import time.
 *
 * Each is either the storage module itself or an entrypoint that cannot run
 * without storage anyway. Adding to this list widens what a stray import can
 * drag into an unrelated module graph, so it needs a reason.
 */
const EAGER_ALLOWED: Record<string, string> = {
  'modules/files/files.storage.ts':
    'the files module IS storage; every export here needs the bucket',

  // Pre-existing, and listed rather than fixed. Each of these is storage-facing
  // enough that a caller reaching it already expects credentials, so none is
  // currently dragging cloud init somewhere it does not belong. They are here so
  // the list is honest and so a NEW one has to be argued for; the same argument
  // applies to converting them, which is a separate change.
  'modules/files/shareLinks.service.ts': 'pre-existing: every export mints or revokes a signed link',
  'modules/messaging/messaging.routes.ts': 'pre-existing: attachment routes read and write objects',
  'modules/signatures/signatureLinks.routes.ts': 'pre-existing: serves signing documents',
  'modules/signatures/signingRouteSupport.ts': 'pre-existing: the signing routes serve and store documents through its bucket',
  'modules/signatures/signingTemplates.routes.ts': 'pre-existing: serves template documents',
  'shared/utils/attachmentSigning.ts': 'pre-existing: signing attachment urls is all it does',

  // The one worth a second look. A matter REPOSITORY is a database module, and
  // it holds a bucket so it can delete a matter's objects. Nothing has tripped
  // over it, but it is the same shape as the billing regression that produced
  // this file: a data module that cannot be imported without credentials.
  'modules/matters/matters.repository.ts':
    'pre-existing: deletes a matter object tree. A data module holding a bucket '
    + 'is the shape that caused the billing break; worth making lazy.',
};

/** Files that call `admin.storage()` or `admin.auth()` at module scope. */
function eagerCloudInit(): string[] {
  const out: string[] = [];

  for (const full of tsFilesUnder()) {
    const source = parseTs(full);
    let eager = false;
    // Only calls that run at IMPORT time. The same call inside a function
    // runs when that function is called, which is the shape being asked for,
    // so the walk stops at every function boundary.
    //
    // Matching the statement's TEXT instead reported `const bucket = () =>
    // admin.storage()...` as eager. That is the lazy shape written as an
    // arrow function rather than a declaration, so the guard was pushing
    // people to rewrite correct code or to exempt it, and an exemption for
    // code that is already right is how the list stops meaning anything.
    const isFunctionLike = (node: ts.Node) => ts.isFunctionDeclaration(node)
      || ts.isFunctionExpression(node)
      || ts.isArrowFunction(node)
      || ts.isMethodDeclaration(node)
      || ts.isGetAccessorDeclaration(node)
      || ts.isSetAccessorDeclaration(node)
      || ts.isConstructorDeclaration(node);

    const visit = (node: ts.Node) => {
      if (eager || isFunctionLike(node)) return;
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'admin'
        && (node.expression.name.text === 'storage' || node.expression.name.text === 'auth')
      ) {
        eager = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    for (const statement of source.statements) {
      if (eager) break;
      visit(statement);
    }
    if (eager) out.push(relToSrc(full));
  }
  return out.sort();
}

it('builds no cloud client at import time outside the storage module', () => {
  const unexplained = eagerCloudInit().filter((f) => !EAGER_ALLOWED[f]);

  expect(
    unexplained.length === 0 ? '' :
      'These modules build a Firebase client when they are imported:\n'
      + unexplained.map((f) => `  ${f}`).join('\n')
      + '\n\nAnything that imports them, however indirectly, then needs cloud\n'
      + 'credentials to load at all. Wrap the call in a function, the way\n'
      + 'shared/storage/recordArchive.ts does, or add the file to\n'
      + 'EAGER_ALLOWED in tests/config/lazyCloudInit.test.ts with a reason.',
  ).toBe('');
});

it('lists nothing in EAGER_ALLOWED that no longer does it', () => {
  // A stale allowance pre-approves whatever takes that path next.
  const present = new Set(eagerCloudInit());

  expect(Object.keys(EAGER_ALLOWED).filter((f) => !present.has(f))).toEqual([]);
});

it('keeps the billing graph clear of the files storage module', () => {
  // The specific regression. Billing reaches archived invoice PDFs through
  // `recordArchive`, whose bucket is lazy; going through the files module
  // instead is what dragged Firebase into a late-fee arithmetic test.
  const billing = path.join(SRC, 'modules', 'billing');
  const offenders = tsFilesUnder(billing)
    .filter((full) => /files\/files\.storage/.test(fs.readFileSync(full, 'utf8')))
    .map(relToSrc);

  expect(offenders).toEqual([]);
});
