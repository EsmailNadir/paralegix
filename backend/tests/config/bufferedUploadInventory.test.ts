/**
 * Proves that no route holds a whole upload request in the API process.
 *
 * `multer.memoryStorage()` puts the complete request body in the container's
 * heap before the handler runs. On its own that is survivable; the risk is
 * concurrency. The API serves 80 concurrent requests on 512 MiB, so ten people
 * attaching a file at the same moment is ten whole files resident, on the same
 * instance that is signing documents.
 *
 * Cloud Run rejects an HTTP/1 body over 32 MiB before it reaches the process,
 * so the per-route caps below are NOT what bounds this in production; 32 MiB
 * is. A cap above that is unreachable there and reachable everywhere else, and
 * either way ten of them at once is the number that matters.
 *
 * Six concurrent uploads at the largest cap here exceed the whole container,
 * and Node's own heap is already inside it. The route is allowed 80.
 *
 * This is a zero baseline. A new `multer.memoryStorage()` call fails the test
 * until the route is redesigned to upload directly to storage.
 */
import * as ts from 'typescript';
import { tsFilesUnder, relToSrc, parseTs } from '../support/srcFiles';


/**
 * Routes that buffer an upload, and what each one holds.
 *
 * `capBytes` is the multer limit the file declares. `why` says what the handler
 * does with the bytes that a direct upload could not do; "nothing" means it is
 * pure store-and-forward and is only waiting its turn to be converted.
 */
const BUFFERED: Record<string, { capBytes: number; why: string }> = {};

/**
 * Files under `src/` that CALL `multer.memoryStorage()`.
 *
 * Parsed rather than grepped. A text match also finds the phrase in a comment,
 * and this file's own subject is discussed in comments across the codebase, so
 * the grep version reported a module that explains the problem as a module that
 * has it.
 */
function buffering(): string[] {
  const out: string[] = [];

  for (const full of tsFilesUnder()) {
    const source = parseTs(full);
    let found = false;
    const visit = (node: ts.Node) => {
      if (found) return;
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'memoryStorage'
      ) {
        found = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
    if (found) out.push(relToSrc(full));
  }
  return out.sort();
}

it('adds no new route that holds a whole upload in the process', () => {
  const unlisted = buffering().filter((f) => !BUFFERED[f]);

  expect(
    unlisted.length === 0 ? '' :
      'These files call multer.memoryStorage() and are not in the inventory:\n'
      + unlisted.map((f) => `  ${f}`).join('\n')
      + '\n\nA memory-backed upload holds the whole body on a 512 MiB instance that\n'
      + 'serves 80 concurrent requests. Upload direct to storage instead: see\n'
      + 'files upload-init/finalize for the shape. If the bytes genuinely must\n'
      + 'reach the process, add the file to BUFFERED in\n'
      + 'tests/config/bufferedUploadInventory.test.ts and say why.',
  ).toBe('');
});

it('lists nothing that has already been converted', () => {
  // A stale entry is how the ratchet stops working: the path gets reused and
  // the new buffering route is silently pre-approved.
  const present = new Set(buffering());

  expect(Object.keys(BUFFERED).filter((f) => !present.has(f))).toEqual([]);
});
