/**
 * The deploy settings the memory work depends on, asserted against the file
 * that actually deploys.
 *
 * Every bound in this project was chosen against one number: the API container
 * has 512 MiB. Signing limits, cache ceilings, read ceilings and the upload cap
 * are all derived from it. Raising the container silently would not break a
 * single test while making all of that reasoning stale, and lowering it would
 * make it wrong. So the number is pinned here, beside the reason.
 *
 * The document-conversion worker is a SEPARATE service with more memory and a
 * concurrency of one, and that separation is the other half of the budget.
 * LibreOffice must never be spawned inside the API process, and the one API
 * path that asks the worker for a conversion must go through the concurrency
 * limiter rather than the adapter underneath it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { SRC, tsFilesUnder, relToSrc } from '../support/srcFiles';

const ROOT = path.join(__dirname, '..', '..');
const cloudbuild = fs.readFileSync(path.join(ROOT, 'cloudbuild.yaml'), 'utf8');

/** The deploy arguments for one Cloud Run service, in file order. */
function argsForService(serviceRef: string): string[] {
  const at = cloudbuild.indexOf(serviceRef);
  expect(at).toBeGreaterThan(-1);
  // Each deploy step ends where the next `- name:` step begins.
  const rest = cloudbuild.slice(at);
  const nextStep = rest.indexOf("\n  - name:");
  const block = nextStep === -1 ? rest : rest.slice(0, nextStep);
  return block.split('\n').map((l) => l.trim()).filter((l) => l.startsWith("- '--"));
}

describe('the API container', () => {
  const args = argsForService("'${_SERVICE_NAME}'");

  it('stays at 512 MiB', () => {
    // Not a preference. Read the file's own comments and this project's plan:
    // the signing cap, the cache ceilings and the read ceilings are all sized
    // against this. Changing it invalidates them rather than relaxing them.
    expect(args).toContain("- '--memory=512Mi'");
  });

  it('keeps request concurrency, so one instance still serves many callers', () => {
    // A concurrency of 1 would make every bound here moot and turn signing into
    // a queue. The whole point of the streaming work is many concurrent signers
    // on one instance.
    expect(args).toContain("- '--concurrency=80'");
  });

  it('still scales to zero', () => {
    // min-instances above zero is the one setting that adds a cost floor rather
    // than tracking usage.
    expect(args).toContain("- '--min-instances=0'");
  });
});

describe('the document-conversion worker', () => {
  const args = argsForService("'${_DOCUMENT_WORKER_SERVICE_NAME}'");

  it('is a separate service with its own, larger memory', () => {
    expect(args).toContain("- '--memory=1Gi'");
    expect(args).toContain("- '--concurrency=1'");
  });

  it('is not reachable without authentication', () => {
    expect(args).toContain("- '--no-allow-unauthenticated'");
    expect(args).not.toContain("- '--allow-unauthenticated'");
  });
});

describe('where document conversion runs', () => {

  it('reaches LibreOffice from exactly two places, and says which', () => {
    // `convertLocally` spawns soffice in whatever process imports it. On the API
    // that is a second large process inside the same 512 MiB, beside Node's own
    // heap, while the instance serves 80 concurrent requests.
    //
    // It is imported twice, and the difference matters:
    //
    //   `document-worker.ts` is the worker entrypoint, a SEPARATE Cloud Run
    //   service with 1 GiB and a concurrency of one. That is where it belongs.
    //
    //   `converter.ts` is the ADAPTER SWITCH, which picks local or worker from
    //   `DOCUMENT_CONVERTER`. So the API can still run soffice in-process, and
    //   does whenever that variable is not "worker".
    //
    // An earlier version of this test matched on the absolute path and so missed
    // the relative import in `converter.ts`, and claimed the API never runs
    // LibreOffice. It can. What is pinned here is the true, smaller statement:
    // only those two files reach it, so a third would show up.
    const importers = tsFilesUnder(SRC)
      .filter((f) => /from '.*localConverter'/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => relToSrc(f))
      .sort();

    expect(importers).toEqual([
      'document-worker.ts',
      'shared/documentConversion/converter.ts',
    ]);
  });

  it('defaults the adapter to LOCAL, which is the in-process one', () => {
    // Written down rather than assumed. `DOCUMENT_CONVERTER=local` is the
    // documented starting state and the rollback setting, so an API instance
    // that has not been switched over runs soffice itself. The concurrency
    // limiter below is what bounds that; nothing else does.
    const converter = fs.readFileSync(
      path.join(SRC, 'shared', 'documentConversion', 'converter.ts'), 'utf8',
    );
    expect(converter).toMatch(/DOCUMENT_CONVERTER === 'worker' \? 'worker' : 'local'/);
  });

  it('reaches the converter through the one concurrency-limited wrapper', () => {
    // The adapter itself is unlimited. `signatures.service.convertDocument`
    // wraps it in a limiter with a queue deadline, which is what keeps a burst
    // of conversions from becoming a burst of held-open sockets on an instance
    // that is also signing. A module importing the adapter directly would
    // bypass that limiter without looking like it was bypassing anything.
    const importers = tsFilesUnder(SRC)
      .filter((f) => /documentConversion\/converter/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => relToSrc(f));

    expect(importers).toEqual(['modules/signatures/signatures.service.ts']);
  });

  it('bounds that wrapper to one conversion per instance by default', () => {
    // Each conversion is a whole document in memory plus the worker round-trip.
    // The default is what the 512 MiB budget supports; the env var exists to
    // lower it, not as an invitation to raise it.
    //
    // Read through the module that owns the default, loaded with the knob
    // unset, so the assertion follows the value however the line is written.
    const saved = process.env.DOC_CONVERT_CONCURRENCY;
    delete process.env.DOC_CONVERT_CONCURRENCY;
    let limits: any;
    try {
      jest.isolateModules(() => { limits = require('../../src/modules/signatures/conversionLimits'); });
    } finally {
      if (saved !== undefined) process.env.DOC_CONVERT_CONCURRENCY = saved;
    }
    expect(limits.DOC_CONVERT_CONCURRENCY).toBe(1);
    // And the wrapper is gated by exactly those limits, with its queue deadline.
    const service = fs.readFileSync(
      path.join(SRC, 'modules', 'signatures', 'signatures.service.ts'), 'utf8',
    );
    expect(service).toMatch(/from '\.\/conversionLimits'/);
    expect(service).toMatch(/createBusyGate\(DOC_CONVERT_CONCURRENCY,\s*\{\s*queueTimeoutMs: DOC_CONVERT_QUEUE_TIMEOUT_MS,/);
  });
});

describe('where PDF export renders', () => {
  const importersOf = (pattern: RegExp) => tsFilesUnder(SRC)
    .filter((f) => pattern.test(fs.readFileSync(f, 'utf8')))
    .map((f) => relToSrc(f))
    .sort();

  it('launches Chromium from one module, reached only by the worker and the API adapter', () => {
    // `htmlPdf.ts` starts a browser in whatever process calls it. The worker is
    // where that belongs. The adapter calls it too, but only for local
    // development: it refuses under NODE_ENV=production.
    expect(importersOf(/from '[^']*htmlPdf'/)).toEqual([
      'document-worker.ts',
      'modules/templates/templates.service.ts',
      'shared/documentConversion/pdfRenderer.ts',
    ]);
    // templates.service takes only the size ceiling from it, never the renderer.
    const service = fs.readFileSync(path.join(SRC, 'modules', 'templates', 'templates.service.ts'), 'utf8');
    expect(service).toMatch(/import \{ EXPORT_HTML_MAX_BYTES \} from '[^']*htmlPdf'/);
  });

  it('reaches the renderer through the export slot and nowhere else', () => {
    expect(importersOf(/documentConversion\/pdfRenderer/)).toEqual(['modules/templates/templates.service.ts']);
    const service = fs.readFileSync(path.join(SRC, 'modules', 'templates', 'templates.service.ts'), 'utf8');
    const calls = service.match(/renderHtmlToStoredPdf\(/g) || [];
    expect(calls).toHaveLength(1);
    expect(service).toMatch(/withTemplateExportSlot\(\s*\(\) => renderHtmlToStoredPdf\(/);
  });

  it('asks the worker for no more jobs at once than it has instances', () => {
    // The worker runs one job per instance. The API's two gates in front of it,
    // LibreOffice conversion and PDF export, are each per API instance. If they
    // add up to more than the worker's instances, Cloud Run holds the extra
    // request and then refuses it, and a user's export fails instead of waiting.
    //
    // Read from the substitutions the deploy passes, not from the code defaults:
    // the deploy sets both gates explicitly, so those are the numbers that run.
    const workerMax = substitution('_DOCUMENT_WORKER_MAX_INSTANCES');
    const apiMax = substitution('_MAX_INSTANCES');
    const converter = substitution('_DOC_CONVERT_CONCURRENCY');
    const exporter = substitution('_TEMPLATE_EXPORT_CONCURRENCY');

    expect([workerMax, apiMax, converter, exporter].every(Number.isInteger)).toBe(true);
    expect(apiMax * (converter + exporter)).toBeLessThanOrEqual(workerMax);
  });
});

/** A numeric default from the `substitutions:` block of `cloudbuild.yaml`. */
function substitution(name: string): number {
  return Number(cloudbuild.match(new RegExp(`^\\s*${name}: '(\\d+)'`, 'm'))?.[1]);
}

describe('the render and conversion limits the deploy sets', () => {
  // Each knob is passed to the API from a substitution, so it can be changed per
  // trigger without a code change. The defaults must EQUAL the code's own, so
  // that passing them changes nothing until someone deliberately overrides one.
  const KNOBS: Array<[string, () => number]> = [
    ['DOC_CONVERT_CONCURRENCY', () => require('../../src/modules/signatures/conversionLimits').DOC_CONVERT_CONCURRENCY],
    ['TEMPLATE_FILL_CONCURRENCY', () => require('../../src/modules/templates/templateFillSlot').TEMPLATE_FILL_CONCURRENCY],
    ['TEMPLATE_EXPORT_CONCURRENCY', () => require('../../src/modules/templates/templateFillSlot').TEMPLATE_EXPORT_CONCURRENCY],
    ['TEMPLATE_RENDERS_PER_PERSON', () => require('../../src/modules/templates/templateFillSlot').TEMPLATE_RENDERS_PER_PERSON],
    ['TEMPLATE_FILL_QUEUE_TIMEOUT_MS', () => require('../../src/modules/templates/templateFillSlot').TEMPLATE_FILL_QUEUE_TIMEOUT_MS],
    ['TEMPLATE_EXPORT_QUEUE_TIMEOUT_MS', () => require('../../src/modules/templates/templateFillSlot').TEMPLATE_EXPORT_QUEUE_TIMEOUT_MS],
  ];
  const envArg = argsForService("'${_SERVICE_NAME}'").find((a) => a.startsWith("- '--update-env-vars="));

  it.each(KNOBS)('passes %s to the API from its own substitution', (name) => {
    // One `KEY=${_KEY}` pair of the comma-separated list, matched whole.
    const pairs = String(envArg).replace(/^- '--update-env-vars=|'$/g, '').split(',');
    expect(pairs).toContain(`${name}=\${_${name}}`);
  });

  it.each(KNOBS)('defaults the %s substitution to the code default', (name, codeDefault) => {
    const fromDeploy = substitution(`_${name}`);
    expect(Number.isInteger(fromDeploy)).toBe(true);
    expect(fromDeploy).toBe(codeDefault());
  });
});

