/**
 * Every route that still writes a whole document as its response body.
 *
 * This is the outbound half of `bufferedUploadInventory.test.ts`, and it exists
 * for the same reason. A `res.send(buffer)` holds the complete object in the
 * container's heap while it is written out, on an instance that serves 80
 * concurrent requests on 512 MiB and is signing documents at the same time. It
 * also holds the request open for the whole transfer, so a slow reader on a
 * large file occupies a slot that nothing else can use.
 *
 * The converted routes answer with a signed URL instead. Storage serves the
 * bytes, the browser fetches them directly, and the API holds nothing. That is
 * the shape `files.download.routes.ts` already used and the one the template,
 * preview and conversion routes moved to.
 *
 * This file is an inventory, not an approval. Each entry is a route that has
 * not been converted yet, with what it costs. The list may shrink freely. It
 * may not grow, and no listed file may gain another one, without someone
 * writing down why the bytes have to leave through this process.
 */
import * as ts from 'typescript';
import { tsFilesUnder, relToSrc, parseTs } from '../support/srcFiles';


/**
 * Routes that write a whole body, how many places do it, and why.
 *
 * `sends` is a ceiling rather than a description. A file that gains one has
 * gained a defect of exactly the kind this file was written to stop, whether or
 * not the count in the inventory still reads plausibly.
 */
const OUTBOUND: Record<string, { sends: number; why: string }> = {
  'modules/billing/invoices/invoices.routes.ts': {
    sends: 2,
    why: 'LEDES export, which is a string this process just built from database rows and '
      + 'not a stored object. There is nothing in storage to hand out a link to. It is '
      + 'listed rather than exempted because the body is still unbounded: it grows with '
      + 'the number of time entries on the invoices being exported.',
  },
};

/**
 * Files under `src/` that write a response body, and how many places do it.
 *
 * Parsed rather than grepped, for the same reason as the inbound inventory: a
 * text match also finds the phrase in a comment, and this exact subject is
 * discussed in comments across the signing modules.
 *
 * `res.send()` with no argument is a status-only reply and holds nothing, so it
 * does not count. A stream piped to the response does not count either: a pipe
 * holds one window at a time, which is the bounded shape, not the pathology.
 */
function sendingWholeBodies(): Record<string, number> {
  const out: Record<string, number> = {};

  for (const full of tsFilesUnder()) {
    const source = parseTs(full);
    let count = 0;
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'res'
        && (node.expression.name.text === 'send' || node.expression.name.text === 'end')
        && node.arguments.length > 0
      ) {
        count += 1;
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
    if (count > 0) out[relToSrc(full)] = count;
  }
  return out;
}

it('adds no new route that writes a whole document as its response', () => {
  const unlisted = Object.keys(sendingWholeBodies()).filter((f) => !OUTBOUND[f]).sort();

  expect(
    unlisted.length === 0 ? '' :
      'These files write a response body and are not in the inventory:\n'
      + unlisted.map((f) => `  ${f}`).join('\n')
      + '\n\nWriting a whole object out holds it in the process and holds the\n'
      + 'request open for the transfer, on a 512 MiB instance serving 80\n'
      + 'concurrent requests. Answer with a signed URL instead: see\n'
      + 'templates.service.ts (signStoredDocument) for the shape, and mint it\n'
      + 'only AFTER the same authorization the route already performs. If the\n'
      + 'bytes genuinely have to leave through this process, add the file to\n'
      + 'OUTBOUND in tests/config/outboundBodyInventory.test.ts and say why.',
  ).toBe('');
});

it('lists nothing that has already been converted', () => {
  // A stale entry is how the ratchet stops working: the file gets a new
  // response body later and the entry silently pre-approves it.
  const present = sendingWholeBodies();

  expect(Object.keys(OUTBOUND).filter((f) => !present[f])).toEqual([]);
});

it('is a RATCHET: no listed file may gain another one', () => {
  const present = sendingWholeBodies();

  for (const [file, { sends }] of Object.entries(OUTBOUND)) {
    expect({ file, sends: present[file] }).toEqual({ file, sends });
  }
});

it('keeps the four converted routes converted', () => {
  // Named explicitly rather than left to the unlisted check, because these are
  // the ones that moved. A regression here reads as a normal-looking
  // `res.send` in a route that used to have one. `signing.routes.ts` is the
  // newest of the four: it wrote out the archived signed document until the
  // archive read became a minted url like every other signed artifact.
  const present = sendingWholeBodies();

  for (const file of [
    'modules/templates/templates.routes.ts',
    'modules/templates/templates.service.ts',
    'modules/signatures/signatures.routes.ts',
    'modules/signatures/signing.routes.ts',
  ]) {
    expect({ file, sends: present[file] ?? 0 }).toEqual({ file, sends: 0 });
  }
});

it('proves the scan reaches route files at all', () => {
  // Without this, a scan that walked the wrong directory would report an empty
  // set and every assertion above would pass for the wrong reason. A COUNT
  // cannot say that any more: one genuine writer is left, so a threshold and a
  // broken scan agree. The positive control is the file itself.
  const present = sendingWholeBodies();

  expect(present['modules/billing/invoices/invoices.routes.ts']).toBe(2);
});
