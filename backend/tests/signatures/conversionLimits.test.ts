/**
 * The document converter's concurrency and queue deadline, read from the
 * environment.
 *
 * They were read as `Number(x) || default`, which keeps any truthy number. A
 * negative queue timeout is truthy, reached the limiter, and silently disabled
 * the deadline: a saturated converter then held every caller's socket open
 * instead of answering 503 CONVERSION_BUSY. A fractional or negative
 * concurrency is a typo with no sensible meaning either. Anything that is not a
 * positive integer now keeps the default, as the template render limits do.
 */
const KNOBS = ['DOC_CONVERT_CONCURRENCY', 'DOC_CONVERT_QUEUE_TIMEOUT_MS'];

/** The module's constants, loaded fresh with `env` applied. */
function loadWith(env: Record<string, string>) {
  const saved = Object.fromEntries(KNOBS.map((k) => [k, process.env[k]]));
  for (const k of KNOBS) delete process.env[k];
  Object.assign(process.env, env);
  let mod: any;
  try {
    jest.isolateModules(() => { mod = require('../../src/modules/signatures/conversionLimits'); });
  } finally {
    for (const k of KNOBS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  return mod;
}

describe('the converter limits, read from the environment', () => {
  it('defaults to one conversion at a time and a 45 second queue', () => {
    const mod = loadWith({});

    expect(mod.DOC_CONVERT_CONCURRENCY).toBe(1);
    expect(mod.DOC_CONVERT_QUEUE_TIMEOUT_MS).toBe(45_000);
  });

  it('takes each one from its env var', () => {
    const mod = loadWith({ DOC_CONVERT_CONCURRENCY: '2', DOC_CONVERT_QUEUE_TIMEOUT_MS: '1500' });

    expect(mod.DOC_CONVERT_CONCURRENCY).toBe(2);
    expect(mod.DOC_CONVERT_QUEUE_TIMEOUT_MS).toBe(1500);
  });

  it.each(['-1', '-45000', '1.5', '0', 'two', ''])('falls back to the default for %j', (bad) => {
    const mod = loadWith({ DOC_CONVERT_CONCURRENCY: bad, DOC_CONVERT_QUEUE_TIMEOUT_MS: bad });

    expect(mod.DOC_CONVERT_CONCURRENCY).toBe(1);
    expect(mod.DOC_CONVERT_QUEUE_TIMEOUT_MS).toBe(45_000);
  });
});

describe('positiveIntFromEnv', () => {
  const NAME = 'POSITIVE_INT_FROM_ENV_TEST';
  afterEach(() => { delete process.env[NAME]; });

  it('reads a positive integer and refuses anything else', () => {
    const { positiveIntFromEnv } = require('../../src/shared/utils/positiveIntFromEnv');

    process.env[NAME] = '7';
    expect(positiveIntFromEnv(NAME, 3)).toBe(7);
    for (const bad of ['-7', '0', '7.5', 'seven', '']) {
      process.env[NAME] = bad;
      expect(positiveIntFromEnv(NAME, 3)).toBe(3);
    }
    delete process.env[NAME];
    expect(positiveIntFromEnv(NAME, 3)).toBe(3);
  });
});
