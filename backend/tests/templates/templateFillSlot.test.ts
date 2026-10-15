/**
 * How many template fills hold a whole document in memory at once, per instance.
 *
 * Filling a DOCX or overlay template reads the stored document (up to 25 MB)
 * and its images (up to 25 MB more) into this process, and the transform makes
 * further copies. Several at once is how a 512 MiB container restarts. The slot
 * admits a fixed number and queues the rest, with a deadline so a backlog
 * answers 503 rather than holding sockets open.
 *
 * It is deliberately NOT the signing transfer slot: a signing drain can hold
 * that one for minutes, and a person pressing Fill should not wait behind it.
 */
import { AppError } from '../../src/shared/errors/AppError';

const { createTemplateFillSlot, TEMPLATE_FILL_CONCURRENCY } = require('../../src/modules/templates/templateFillSlot');

function deferred() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let every already-settled promise chain run. */
const flush = () => new Promise((resolve) => { setImmediate(resolve); });

describe('the template fill slot', () => {
  it('admits two fills per instance', () => {
    expect(TEMPLATE_FILL_CONCURRENCY).toBe(2);
  });

  it('holds a third fill until one of the first two finishes', async () => {
    const slot = createTemplateFillSlot(2, 60_000);
    const started: string[] = [];
    const gates = { a: deferred(), b: deferred(), c: deferred() };
    const run = (name: 'a' | 'b' | 'c') => slot(async () => {
      started.push(name);
      await gates[name].promise;
      return name;
    });

    const a = run('a');
    const b = run('b');
    const c = run('c');
    await flush();
    expect(started).toEqual(['a', 'b']);

    gates.b.resolve();
    expect(await b).toBe('b');
    await flush();
    expect(started).toEqual(['a', 'b', 'c']);

    gates.a.resolve();
    gates.c.resolve();
    expect(await Promise.all([a, c])).toEqual(['a', 'c']);
  });

  it('releases the slot when a fill throws', async () => {
    const slot = createTemplateFillSlot(2, 60_000);
    const failures = await Promise.allSettled([
      slot(async () => { throw new Error('template unreadable'); }),
      slot(async () => { throw new Error('template unreadable'); }),
    ]);
    expect(failures.map((f) => f.status)).toEqual(['rejected', 'rejected']);
    expect((failures[0] as PromiseRejectedResult).reason.message).toBe('template unreadable');

    // Two failures that kept their slots would leave none for these.
    const started: string[] = [];
    const gate = deferred();
    const next = [1, 2].map((n) => slot(async () => { started.push(`fill ${n}`); await gate.promise; }));
    await flush();
    expect(started).toEqual(['fill 1', 'fill 2']);
    gate.resolve();
    await Promise.all(next);
  });

  it('answers 503 to a fill that waited past the queue deadline', async () => {
    const slot = createTemplateFillSlot(1, 20);
    const gate = deferred();
    const holding = slot(() => gate.promise);
    let ran = false;

    const refused = await slot(async () => { ran = true; }).catch((err: unknown) => err);

    expect(ran).toBe(false);
    expect(refused).toBeInstanceOf(AppError);
    expect(refused).toMatchObject({ statusCode: 503, code: 'TEMPLATE_FILL_BUSY' });
    gate.resolve();
    await holding;
  });

  it('passes through an error the fill itself raised, even a queue timeout from further in', async () => {
    // The document converter has its own limiter. Its timeout is a conversion
    // failure the caller already handles, not this slot being busy.
    const slot = createTemplateFillSlot(2, 60_000);
    const inner = Object.assign(new Error('converter queue timed out'), { code: 'CONCURRENCY_QUEUE_TIMEOUT' });

    const err = await slot(async () => { throw inner; }).catch((e: unknown) => e);

    expect(err).toBe(inner);
  });
});

describe('a busy refusal', () => {
  it('tells the client when to try again', async () => {
    // The 503 is about load, so the same request will work later. Retry-After
    // is how a client learns that without parsing the message.
    const slot = createTemplateFillSlot(1, 20);
    const gate = deferred();
    const holding = slot(() => gate.promise);

    const refused = await slot(async () => {}).catch((err: unknown) => err);

    expect(refused).toMatchObject({ statusCode: 503, code: 'TEMPLATE_FILL_BUSY', retryAfterSeconds: 5 });
    gate.resolve();
    await holding;
  });
});

describe('the render limits, read from the environment', () => {
  const KNOBS = [
    'TEMPLATE_FILL_CONCURRENCY',
    'TEMPLATE_EXPORT_CONCURRENCY',
    'TEMPLATE_RENDERS_PER_PERSON',
    'TEMPLATE_FILL_QUEUE_TIMEOUT_MS',
    'TEMPLATE_EXPORT_QUEUE_TIMEOUT_MS',
  ];

  /** The module's constants, loaded fresh with `env` applied. */
  function loadWith(env: Record<string, string>) {
    const saved = Object.fromEntries(KNOBS.map((k) => [k, process.env[k]]));
    for (const k of KNOBS) delete process.env[k];
    Object.assign(process.env, env);
    let mod: any;
    try {
      jest.isolateModules(() => { mod = require('../../src/modules/templates/templateFillSlot'); });
    } finally {
      for (const k of KNOBS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
    return mod;
  }

  it('defaults to the values the memory budget was sized for', () => {
    const mod = loadWith({});

    expect(mod.TEMPLATE_FILL_CONCURRENCY).toBe(2);
    expect(mod.TEMPLATE_EXPORT_CONCURRENCY).toBe(1);
    expect(mod.TEMPLATE_RENDERS_PER_PERSON).toBe(2);
    expect(mod.TEMPLATE_FILL_QUEUE_TIMEOUT_MS).toBe(30_000);
    expect(mod.TEMPLATE_EXPORT_QUEUE_TIMEOUT_MS).toBe(45_000);
  });

  it('takes each one from its env var', () => {
    const mod = loadWith({
      TEMPLATE_FILL_CONCURRENCY: '3',
      TEMPLATE_EXPORT_CONCURRENCY: '2',
      TEMPLATE_RENDERS_PER_PERSON: '4',
      TEMPLATE_FILL_QUEUE_TIMEOUT_MS: '1000',
      TEMPLATE_EXPORT_QUEUE_TIMEOUT_MS: '2000',
    });

    expect(mod.TEMPLATE_FILL_CONCURRENCY).toBe(3);
    expect(mod.TEMPLATE_EXPORT_CONCURRENCY).toBe(2);
    expect(mod.TEMPLATE_RENDERS_PER_PERSON).toBe(4);
    expect(mod.TEMPLATE_FILL_QUEUE_TIMEOUT_MS).toBe(1000);
    expect(mod.TEMPLATE_EXPORT_QUEUE_TIMEOUT_MS).toBe(2000);
  });

  it.each(['0', '-1', '1.5', 'two', ''])('falls back to the default for %j', (bad) => {
    // A zero concurrency would stall every render; a fraction or a negative is
    // a typo, not a setting. None of them should reach the limiter.
    const mod = loadWith(Object.fromEntries(KNOBS.map((k) => [k, bad])));

    expect(mod.TEMPLATE_FILL_CONCURRENCY).toBe(2);
    expect(mod.TEMPLATE_EXPORT_CONCURRENCY).toBe(1);
    expect(mod.TEMPLATE_RENDERS_PER_PERSON).toBe(2);
    expect(mod.TEMPLATE_FILL_QUEUE_TIMEOUT_MS).toBe(30_000);
    expect(mod.TEMPLATE_EXPORT_QUEUE_TIMEOUT_MS).toBe(45_000);
  });

  it('applies the per-person setting to the shared cap', async () => {
    const mod = loadWith({ TEMPLATE_RENDERS_PER_PERSON: '1' });
    const gate = deferred();
    const first = mod.withPersonRenderCap('u1', () => gate.promise);

    const second = await mod.withPersonRenderCap('u1', async () => 'ran').catch((e: unknown) => e);

    expect(second).toMatchObject({ statusCode: 429, code: 'TEMPLATE_RENDER_IN_PROGRESS' });
    gate.resolve();
    await first;
  });
});
