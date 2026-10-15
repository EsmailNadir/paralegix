/**
 * The per-request deadline, and why reads and writes get different ones.
 *
 * The browser stops waiting for a read at `REQUEST_TIMEOUT_MS.read` (20s,
 * `frontend/src/lib/constants/requestTimeouts.ts`). A server that kept a read
 * open to 40s past that answered nobody, and logged a 200 for a request the
 * user saw fail. So reads (GET, HEAD) get a deadline equal to the browser's,
 * while writes keep the longer one: aborting a write in the browser does not
 * undo it, and the write budget exists so the client hears the real outcome.
 *
 * Three exceptions are pinned here because each one, removed, breaks a screen:
 *
 *   - `LONG_RUNNING_PATTERNS` routes have no deadline at all, reads included
 *     (a LEDES export and a template preview are GETs).
 *   - A template fill and a signing DOCX conversion queue behind the document
 *     converter, so they get a longer conversion budget instead of the write
 *     one. Longer, not none: a request stuck past every queue deadline still
 *     answers rather than holding its socket open indefinitely.
 *   - `GET /api/lawfirms/:lawFirmId` is the workspace shell's bootstrap read.
 *     The browser gives it 45s because it is the request that wakes a
 *     scaled-to-zero API, so it keeps the general budget rather than the read
 *     one; otherwise the server would answer 504 while the client still waits.
 *
 * Every case runs a real Express app through supertest with a handler that
 * sleeps for `?ms=`, and budgets of tens of milliseconds, so the assertions are
 * on the status the client actually receives.
 */
import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import supertest from 'supertest';

const GENERAL_MS = 400;
const READ_MS = 60;
/** Past the read budget, well under the general one. */
const BETWEEN_MS = 200;
const CONVERSION_MS = 900;

function appWith(middleware: express.RequestHandler) {
  const app = express();
  app.use(middleware);
  app.use(async (req, res) => {
    await new Promise((resolve) => { setTimeout(resolve, Number(req.query.ms) || 0); });
    if (!res.headersSent) res.json({ ok: true });
  });
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) return;
    res.status(err.statusCode || 500).json({ code: err.code });
  });
  return supertest(app);
}

/** The numeric default a source file gives an env knob it reads as `Number(process.env.X) || 55_000`. */
function codeDefault(relPath: string, name: string): number {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', relPath), 'utf8');
  const match = source.match(new RegExp(`process\\.env\\.${name}\\)\\s*\\|\\|\\s*([\\d_]+)`));
  return Number(String(match?.[1]).replace(/_/g, ''));
}

function withBudgets() {
  const { requestTimeout } = require('../../src/shared/middleware/requestTimeout');
  return appWith(requestTimeout(GENERAL_MS, READ_MS, CONVERSION_MS));
}

/** Load the middleware with `env` applied, as a fresh module read. */
function withEnv(env: Record<string, string>) {
  const saved: Record<string, string | undefined> = {};
  let middleware: any;
  for (const key of Object.keys(env)) { saved[key] = process.env[key]; process.env[key] = env[key]; }
  try {
    jest.isolateModules(() => {
      middleware = require('../../src/shared/middleware/requestTimeout').requestTimeout();
    });
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
  return appWith(middleware);
}

describe('requestTimeout', () => {
  it('answers 504 REQUEST_TIMEOUT to a GET that outlives the read budget', async () => {
    const res = await withBudgets().get(`/api/lawfirms/f1/matters?ms=${BETWEEN_MS}`);

    expect(res.status).toBe(504);
    expect(res.body.code).toBe('REQUEST_TIMEOUT');
  });

  it('holds a HEAD to the read budget too', async () => {
    const res = await withBudgets().head(`/api/lawfirms/f1/matters?ms=${BETWEEN_MS}`);

    expect(res.status).toBe(504);
  });

  it('does not cut off a POST that is past the read budget but inside the write budget', async () => {
    const res = await withBudgets().post(`/api/lawfirms/f1/matters?ms=${BETWEEN_MS}`);

    // A write the browser was still waiting on, answered with its real outcome.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('still answers 504 to a POST that outlives the write budget', async () => {
    const res = await withBudgets().post(`/api/lawfirms/f1/matters?ms=${GENERAL_MS + 200}`);

    expect(res.status).toBe(504);
    expect(res.body.code).toBe('REQUEST_TIMEOUT');
  });

  it('exempts a long-running GET from every deadline', async () => {
    const res = await withBudgets().get(`/api/lawfirms/f1/files/abc?ms=${GENERAL_MS + 200}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  // Both queue behind the document converter (a template fill waits up to 30s
  // for its render slot, then up to 45s for the conversion slot), so under load
  // they legitimately outlive the 40s write budget. The browser gives them its
  // upload budget, and a 504 at 40s would answer a request it is still awaiting.
  const QUEUED_CONVERSIONS = [
    ['a template fill', '/api/lawfirms/f1/templates/t1/fill'],
    ['a signing DOCX conversion', '/api/signing/convert-upload-finalize'],
  ];

  it.each(QUEUED_CONVERSIONS)('lets %s outlive the write deadline', async (_label, route) => {
    const res = await withBudgets().post(`${route}?ms=${GENERAL_MS + 200}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it.each(QUEUED_CONVERSIONS)('still answers 504 to %s that outlives the conversion budget', async (_label, route) => {
    const res = await withBudgets().post(`${route}?ms=${CONVERSION_MS + 200}`);

    expect(res.status).toBe(504);
    expect(res.body.code).toBe('REQUEST_TIMEOUT');
  });

  it('keeps the write deadline on routes that merely resemble those two', async () => {
    const { isLongRunning, isQueuedConversion } = require('../../src/shared/middleware/requestTimeout');

    expect(isQueuedConversion('/api/lawfirms/f1/templates/t1/fill')).toBe(true);
    expect(isQueuedConversion('/api/signing/convert-upload-finalize')).toBe(true);
    for (const path of [
      '/api/lawfirms/f1/templates/t1/fill/extra',
      '/api/lawfirms/f1/templates/t1/fillable',
      '/api/lawfirms/f1/matters/m1/fill',
      '/api/signing/convert-upload-init',
    ]) {
      expect(isQueuedConversion(path)).toBe(false);
      expect(isLongRunning(path)).toBe(false);
    }
    // Neither is exempt from every deadline any more.
    expect(isLongRunning('/api/lawfirms/f1/templates/t1/fill')).toBe(false);
    expect(isLongRunning('/api/signing/convert-upload-finalize')).toBe(false);
  });

  it('sizes the conversion default above the queues it waits in and below the browser upload budget', () => {
    const {
      DEFAULT_CONVERSION_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
    } = require('../../src/shared/middleware/requestTimeout');
    const { REQUEST_TIMEOUT_MS } = require('../../../frontend/src/lib/constants/requestTimeouts');
    const { TEMPLATE_FILL_QUEUE_TIMEOUT_MS } = require('../../src/modules/templates/templateFillSlot');
    const { DOC_CONVERT_QUEUE_TIMEOUT_MS: convertQueueMs } = require('../../src/modules/signatures/conversionLimits');
    // Read from source: the worker client loads the storage client at import.
    const workerTimeoutMs = codeDefault('shared/documentConversion/workerClient.ts', 'DOCUMENT_WORKER_TIMEOUT_MS');
    expect(Number.isInteger(workerTimeoutMs) && workerTimeoutMs > 0).toBe(true);

    expect(DEFAULT_CONVERSION_REQUEST_TIMEOUT_MS).toBe(180_000);
    expect(DEFAULT_CONVERSION_REQUEST_TIMEOUT_MS).toBeGreaterThan(DEFAULT_REQUEST_TIMEOUT_MS);
    // A fill's worst success: its render slot, the converter queue, then the worker.
    expect(DEFAULT_CONVERSION_REQUEST_TIMEOUT_MS)
      .toBeGreaterThan(TEMPLATE_FILL_QUEUE_TIMEOUT_MS + convertQueueMs + workerTimeoutMs);
    // And the server still answers before the browser gives up on it.
    expect(DEFAULT_CONVERSION_REQUEST_TIMEOUT_MS).toBeLessThan(REQUEST_TIMEOUT_MS.upload);
  });

  it('lets CONVERSION_REQUEST_TIMEOUT_MS override the conversion default', async () => {
    const res = await withEnv({ CONVERSION_REQUEST_TIMEOUT_MS: String(READ_MS) })
      .post(`/api/lawfirms/f1/templates/t1/fill?ms=${BETWEEN_MS}`);

    expect(res.status).toBe(504);
  });

  it('gives the bootstrap firm read the general budget, not the read budget', async () => {
    const res = await withBudgets().get(`/api/lawfirms/f1?ms=${BETWEEN_MS}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('still bounds the bootstrap firm read by the general budget', async () => {
    const res = await withBudgets().get(`/api/lawfirms/f1?ms=${GENERAL_MS + 200}`);

    expect(res.status).toBe(504);
  });

  it('defaults reads to the browser read budget and everything else to 40s', () => {
    const {
      DEFAULT_READ_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
    } = require('../../src/shared/middleware/requestTimeout');
    const { REQUEST_TIMEOUT_MS } = require('../../../frontend/src/lib/constants/requestTimeouts');

    expect(DEFAULT_READ_REQUEST_TIMEOUT_MS).toBe(20_000);
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(40_000);
    // The two packages have to agree, or one side gives up while the other waits.
    expect(DEFAULT_READ_REQUEST_TIMEOUT_MS).toBe(REQUEST_TIMEOUT_MS.read);
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBeLessThan(REQUEST_TIMEOUT_MS.write);
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBeLessThan(REQUEST_TIMEOUT_MS.bootstrap);
  });

  it('lets READ_REQUEST_TIMEOUT_MS override the read default', async () => {
    const res = await withEnv({ READ_REQUEST_TIMEOUT_MS: String(READ_MS) })
      .get(`/api/lawfirms/f1/matters?ms=${BETWEEN_MS}`);

    expect(res.status).toBe(504);
  });

  it('lets REQUEST_TIMEOUT_MS keep overriding the write default', async () => {
    const res = await withEnv({ REQUEST_TIMEOUT_MS: String(READ_MS) })
      .post(`/api/lawfirms/f1/matters?ms=${BETWEEN_MS}`);

    expect(res.status).toBe(504);
  });
});
