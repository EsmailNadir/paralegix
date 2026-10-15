/**
 * How many uploads the app runs at once.
 *
 * A batch used to hand every picked file to `Promise.all`, which starts all of
 * them. Twenty files means twenty sockets competing for one uplink, so each
 * chunk takes twenty times as long, each is twenty times more likely to time
 * out mid-flight, and every failure costs a status query and a resend. The
 * upload gets slower the more the user asks of it, which is the opposite of
 * what the progress bar implies.
 *
 * The gate is app-wide rather than per call: a document sent for signature and
 * a batch dropped on the files page are the same uplink.
 */
import { runWithUploadLimit, MAX_ACTIVE_UPLOADS } from '@/lib/files/uploadConcurrency';
import { UploadCancelledError } from '@/lib/files/resumableUpload';

/** A task that reports when it starts and finishes only when told to. */
function gated(log: string[], name: string) {
  let finish!: (value: string) => void;
  let fail!: (error: Error) => void;
  const settled = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
  const run = () => {
    log.push(`start:${name}`);
    return settled;
  };
  return { run, finish, fail };
}

/** Let every already-resolved continuation run. */
const drain = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

it('caps the uploads in flight at two', () => {
  // Named, because the number is the whole behaviour and a test that read it
  // from the module would pass at any value including twenty.
  expect(MAX_ACTIVE_UPLOADS).toBe(2);
});

it('starts only two, whatever it is handed', async () => {
  const log: string[] = [];
  const tasks = ['a', 'b', 'c', 'd'].map((name) => gated(log, name));

  const all = Promise.all(tasks.map((t) => runWithUploadLimit(t.run)));
  await drain();

  expect(log).toEqual(['start:a', 'start:b']);

  tasks.forEach((t) => t.finish('done'));
  await all;
});

it('starts the next one the moment a slot frees', async () => {
  const log: string[] = [];
  const tasks = ['a', 'b', 'c'].map((name) => gated(log, name));

  const all = Promise.all(tasks.map((t) => runWithUploadLimit(t.run)));
  await drain();
  tasks[0].finish('done');
  await drain();

  // A gate that waited for the whole batch instead of one slot would leave the
  // uplink idle for as long as the slowest file in each pair.
  expect(log).toEqual(['start:a', 'start:b', 'start:c']);

  tasks[1].finish('done');
  tasks[2].finish('done');
  await all;
});

it('frees the slot of a task that failed', async () => {
  const log: string[] = [];
  const tasks = ['a', 'b', 'c'].map((name) => gated(log, name));

  const results = tasks.map((t) => runWithUploadLimit(t.run).catch((e: Error) => e.message));
  await drain();
  tasks[0].fail(new Error('storage refused it'));
  await drain();

  // Removing the `finally` around the release is the mutation: a single failed
  // file would then permanently consume a slot, and after two failures no
  // upload in the tab would ever start again, with no error to explain it.
  expect(log).toEqual(['start:a', 'start:b', 'start:c']);
  expect(await results[0]).toBe('storage refused it');

  tasks[1].finish('done');
  tasks[2].finish('done');
  await Promise.all(results);
});

it('hands back what the task returned', async () => {
  expect(await runWithUploadLimit(async () => 'the value')).toBe('the value');
});

it('rejects with what the task threw', async () => {
  // The callers map a rejection onto per-file failure copy, so a gate that
  // swallowed it would report every failed upload as a success.
  await expect(runWithUploadLimit(async () => { throw new Error('nope'); }))
    .rejects.toThrow('nope');
});

it('releases the slot when the task throws synchronously', async () => {
  await expect(runWithUploadLimit((() => { throw new Error('sync'); }) as () => Promise<never>))
    .rejects.toThrow('sync');

  const log: string[] = [];
  const next = gated(log, 'next');
  const running = runWithUploadLimit(next.run);
  await drain();

  expect(log).toEqual(['start:next']);
  next.finish('done');
  await running;
});

describe('a cancel while waiting for a slot', () => {
  /** What `work` settled to within a few turns, or 'still waiting'. */
  const settledSoon = async (work: Promise<unknown>) => {
    let outcome: unknown = 'still waiting';
    work.then(() => { outcome = 'resolved'; }, (error: unknown) => { outcome = error; });
    await drain();
    return outcome;
  };

  it('stops waiting and never starts the task', async () => {
    const log: string[] = [];
    const [a, b, c] = ['a', 'b', 'c'].map((name) => gated(log, name));
    const controller = new AbortController();

    const first = runWithUploadLimit(a.run);
    const second = runWithUploadLimit(b.run);
    const queued = runWithUploadLimit(c.run, controller.signal);
    await drain();
    controller.abort();

    try {
      // Queued behind two multi-gigabyte uploads, a cancel that is not heard
      // until a slot frees is a cancel that does nothing for an hour.
      expect(await settledSoon(queued)).toBeInstanceOf(UploadCancelledError);

      a.finish('done');
      b.finish('done');
      await Promise.all([first, second]);
      await drain();
      expect(log).toEqual(['start:a', 'start:b']);
    } finally {
      // Settle everything so the app-wide gate is empty for the next spec.
      [a, b, c].forEach((t) => t.finish('done'));
      await Promise.all([first, second, queued.catch(() => {})]);
    }
  });

  it('gives no slot away to the cancelled waiter', async () => {
    const log: string[] = [];
    const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map((name) => gated(log, name));
    const controller = new AbortController();

    const first = runWithUploadLimit(a.run);
    const second = runWithUploadLimit(b.run);
    const cancelled = runWithUploadLimit(c.run, controller.signal).catch(() => 'cancelled');
    await drain();
    controller.abort();
    a.finish('done');
    b.finish('done');
    await Promise.all([first, second]);

    // Both slots are free again. A waiter left in the queue would take one and
    // never give it back, so only one of these two would start.
    const next = [runWithUploadLimit(d.run), runWithUploadLimit(e.run)];
    await drain();
    try {
      expect(log).toEqual(['start:a', 'start:b', 'start:d', 'start:e']);
    } finally {
      // Settle everything so the app-wide gate is empty for the next spec.
      [c, d, e].forEach((t) => t.finish('done'));
      await Promise.all([cancelled, ...next]);
    }
  });

  it('refuses at once for a signal already aborted', async () => {
    const log: string[] = [];
    const task = gated(log, 'a');
    const controller = new AbortController();
    controller.abort();

    const run = runWithUploadLimit(task.run, controller.signal);
    try {
      expect(await settledSoon(run)).toBeInstanceOf(UploadCancelledError);
      expect(log).toEqual([]);
    } finally {
      task.finish('done');
      await run.catch(() => {});
    }
  });
});
