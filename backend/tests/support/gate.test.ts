/**
 * The gate, proving it does what a bare `Promise.all` cannot.
 *
 * Deliberately mechanism-level, with no database: the claim under test is about
 * the helper itself, and mixing a real route in would let a passing result be
 * explained by the route rather than by the gate.
 */
import { gateMethod } from './gate';

/** Stands in for a repository method two requests contend over. */
function makeCounter() {
  const target = {
    calls: 0,
    order: [] as string[],
    async bump(label: string) {
      target.calls += 1;
      target.order.push(label);
      return `${label}:${target.calls}`;
    },
  };
  return target;
}

describe('the gate produces evidence of overlap, not a hope of it', () => {
  it('holds two callers inside the same function at the same time', async () => {
    const target = makeCounter();
    const gate = gateMethod(target, 'bump');

    const first = target.bump('a');
    const second = target.bump('b');

    await gate.arrived(2);

    // The assertion the whole helper exists for. Both calls are inside `bump`,
    // neither has returned, and the real implementation has not run for either.
    expect(gate.waiting()).toBe(2);
    expect(target.calls).toBe(0);

    gate.open();

    await expect(first).resolves.toMatch(/^a:/);
    await expect(second).resolves.toMatch(/^b:/);
    expect(target.calls).toBe(2);
    gate.restore();
  });

  it('wakes a waiter that was already waiting when the second caller arrives', async () => {
    // The first test above calls both functions before `arrived`, so the set is
    // already full and the notification path never runs. This one starts waiting
    // FIRST, which is the ordering a real request pair produces: the second
    // request is still travelling through the route when the test begins to wait.
    const target = makeCounter();
    const gate = gateMethod(target, 'bump');

    const first = target.bump('a');
    const waitingForTwo = gate.arrived(2);

    // Arrives a turn later, after `arrived` has registered its watcher.
    //
    // Assigned inside the callback rather than resolved out of it: `await` on a
    // promise that RESOLVES to a promise flattens it, so the test would wait for
    // the gated call to finish, which cannot happen until the gate opens. That
    // deadlocks, and it deadlocked here before this comment existed.
    let second!: Promise<string>;
    await new Promise<void>((resolve) => {
      setImmediate(() => { second = target.bump('b'); resolve(); });
    });

    await waitingForTwo;
    expect(gate.waiting()).toBe(2);

    gate.open();
    await Promise.all([first, second]);
    gate.restore();
  });

  it('a bare Promise.all proves nothing, which is the point', async () => {
    // The shape every concurrency test in this suite uses today. The two calls
    // run to completion one after the other, because nothing forced them to
    // meet. An assertion about the final state cannot tell this apart from a
    // genuine overlap, so it would pass against code with no locking at all.
    const target = makeCounter();

    await Promise.all([target.bump('a'), target.bump('b')]);

    expect(target.order).toEqual(['a', 'b']);
    expect(target.calls).toBe(2);
    // Nothing here says whether they were ever inside `bump` together. They were
    // not. That absence is invisible without a gate.
  });

  it('releases exactly one caller when asked, so an ordering can be forced', async () => {
    const target = makeCounter();
    const gate = gateMethod(target, 'bump');

    const first = target.bump('first');
    await gate.arrived(1);
    const second = target.bump('second');
    await gate.arrived(2);

    gate.openOne();
    await first;

    // Deterministic ordering, chosen by the test rather than by the event loop.
    expect(target.order).toEqual(['first']);
    expect(gate.waiting()).toBe(1);

    gate.open();
    await second;
    expect(target.order).toEqual(['first', 'second']);
    gate.restore();
  });

  it('names itself when the overlap never happens, instead of hanging', async () => {
    // A gate on the wrong function, or on a path only one request takes, must
    // fail with an explanation. Waiting out the 120s suite timeout would report
    // a slow test rather than a test whose premise was wrong.
    const target = makeCounter();
    const gate = gateMethod(target, 'bump');

    void target.bump('only-one');

    await expect(gate.arrived(2, 60)).rejects.toThrow(
      /gate\(bump\): waited 60ms for 2 concurrent calls, saw 1 paused and 1 total/,
    );

    gate.restore();
  });
});

describe('the gate fails ONE boundary while everything else stays real', () => {
  it('rejects only the next call, then behaves normally', async () => {
    const target = makeCounter();
    const gate = gateMethod(target, 'bump');
    gate.open();

    gate.failNext(new Error('balance write failed'));

    await expect(target.bump('doomed')).rejects.toThrow('balance write failed');
    // The real implementation did NOT run for the failed call. A test asserting
    // "no ledger row was written" needs that to be true.
    expect(target.calls).toBe(0);

    await expect(target.bump('healthy')).resolves.toBe('healthy:1');
    expect(target.order).toEqual(['healthy']);
    gate.restore();
  });

  it('counts a failed call as having entered, so the boundary was reached', async () => {
    // The difference between "the failure happened at this boundary" and "the
    // request never got that far". Only the first proves the recovery path ran.
    const target = makeCounter();
    const gate = gateMethod(target, 'bump');
    gate.open();
    gate.failNext(new Error('nope'));

    await target.bump('x').catch(() => {});

    expect(gate.entered()).toBe(1);
    expect(target.calls).toBe(0);
    gate.restore();
  });
});

describe('restoration', () => {
  it('puts the original function back', async () => {
    const target = makeCounter();
    const before = target.bump;
    const gate = gateMethod(target, 'bump');

    expect(target.bump).not.toBe(before);
    gate.restore();
    expect(target.bump).toBe(before);
  });

  it('does not leave a paused caller hanging when a spec fails before opening', async () => {
    // Without this, an assertion that fails between `arrived` and `open` turns a
    // clear failure into a suite timeout, and the real error is never printed.
    const target = makeCounter();
    const gate = gateMethod(target, 'bump');

    const pending = target.bump('stranded');
    await gate.arrived(1);

    gate.restore();

    // Raced against a short timer rather than simply awaited. A gate that failed
    // to release would leave `pending` unsettled forever, and a bare await would
    // report that as a 120s suite timeout instead of naming this assertion.
    const settled = await Promise.race([
      pending,
      new Promise((resolve) => { setTimeout(() => resolve('STILL_HANGING'), 200); }),
    ]);

    expect(settled).toBe('stranded:1');
  });

  it('refuses to gate something that is not a function', () => {
    const target = makeCounter();

    expect(() => gateMethod(target as never, 'calls')).toThrow(/is not a function/);
  });
});
