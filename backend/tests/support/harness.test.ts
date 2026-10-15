/**
 * Proves the three helpers Phase 2 depends on actually work.
 *
 * Each is load-bearing for a specific organization regression: the email capture
 * for "who was told about the invoice", the event drain for the notification
 * fan-out, and the clock for the reminder windows.
 */
import {
  testPool,
  resetCaches,
  memberWith,
  drainEvents,
  sentEmails,
  recipientsOf,
  freezeClockAt,
  unfreezeClock,
  createFirm,
} from './setupInProcess';

describe('email capture', () => {
  it('captures a real send instead of dispatching it', async () => {
    // The real helper, not a stub: it builds the subject and body, and the real
    // sendEmail runs the firm-preference and daily-cap checks on the way through.
    // Only the transport is replaced.
    const { sendClientInvitationEmail } = require('../../src/shared/services/emailService');

    await sendClientInvitationEmail({
      recipientEmail: 'roster.person@example.test',
      lawFirmName: 'Test Firm',
      inviterName: 'Owner',
      inviteUrl: 'https://example.test/invite/abc',
    });

    expect(sentEmails()).toHaveLength(1);
    expect(sentEmails()[0].to).toBe('roster.person@example.test');
    // The compliance footer is appended by the real sendEmail, so its presence
    // is the proof that the whole path ran rather than a mocked shortcut.
    expect(sentEmails()[0].headers?.['List-Unsubscribe']).toBeDefined();
  });

  it('answers "who was told" by subject', async () => {
    const { sendClientInvitationEmail } = require('../../src/shared/services/emailService');
    await sendClientInvitationEmail({
      recipientEmail: 'a@example.test',
      lawFirmName: 'Test Firm',
      inviterName: 'Owner',
      inviteUrl: 'https://example.test/invite/a',
    });

    expect(recipientsOf(/invit/i)).toEqual(['a@example.test']);
    expect(recipientsOf('Nothing Matches This')).toEqual([]);
  });

  it('starts each test with an empty outbox', () => {
    expect(sentEmails()).toHaveLength(0);
  });
});

describe('event drain', () => {
  it('calls each listener exactly once', async () => {
    // The regression this guards: an earlier version captured promises by
    // invoking every listener a second time on top of the real emit. A listener
    // that is not perfectly idempotent double-wrote, and a spec asserting "one
    // notification" saw two.
    const eventBus = require('../../src/shared/events/eventBus');
    const EVENT = 'harness.once-only';
    let calls = 0;

    eventBus.on(EVENT, async () => { calls += 1; });

    try {
      eventBus.emit(EVENT, {});
      await drainEvents();

      expect(calls).toBe(1);
    } finally {
      eventBus.removeAllListeners(EVENT);
    }
  });

  it('unsubscribes a listener passed by its original reference', async () => {
    // Registration is wrapped, so EventEmitter's identity-based removal would
    // not find the original function without the wrapper map.
    const eventBus = require('../../src/shared/events/eventBus');
    const EVENT = 'harness.unsubscribe';
    let calls = 0;
    const listener = async () => { calls += 1; };

    eventBus.on(EVENT, listener);
    eventBus.removeListener(EVENT, listener);
    eventBus.emit(EVENT, {});
    await drainEvents();

    expect(calls).toBe(0);
    expect(eventBus.listenerCount(EVENT)).toBe(0);
  });

  it('waits for an async listener that emit does not await', async () => {
    const eventBus = require('../../src/shared/events/eventBus');
    const EVENT = 'harness.probe';
    let finished = false;

    eventBus.on(EVENT, async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      finished = true;
    });

    try {
      eventBus.emit(EVENT, { lawFirmId: 'probe' });

      // This is the race every notification assertion would otherwise lose:
      // emit has returned, the listener has not.
      expect(finished).toBe(false);

      await drainEvents();

      expect(finished).toBe(true);
    } finally {
      eventBus.removeAllListeners(EVENT);
    }
  });
});

describe('fixed clock', () => {
  afterEach(() => unfreezeClock());

  it('pins Date for the app, not just the test', () => {
    freezeClockAt('2026-03-15T09:00:00-04:00');

    expect(new Date().toISOString()).toBe('2026-03-15T13:00:00.000Z');
    expect(Date.now()).toBe(new Date('2026-03-15T13:00:00.000Z').getTime());
  });

  it('refuses a date with no offset', () => {
    // A bare date parses as UTC midnight, which is the previous day in every US
    // timezone, so a day-boundary test written that way passes or fails for a
    // reason unrelated to the code.
    expect(() => freezeClockAt('2026-03-15')).toThrow(/explicit offset/);
  });

  it('still serves requests while frozen', async () => {
    freezeClockAt('2026-03-15T09:00:00-04:00');

    // The pg driver and Express both schedule on nextTick and setImmediate, so
    // this deadlocks if the clock helper fakes those too.
    const firm = await createFirm();

    expect(firm.id).toEqual(expect.any(String));
  });
});

describe('cache reset', () => {
  it('clears the permission cache, which otherwise serves a stale role', async () => {
    // The permission cache is keyed on (lawFirmId, userId) with a 30s TTL. That
    // is correct in production and a source of FALSE PASSES in a test, which
    // changes a role and asserts within milliseconds. This proves both halves:
    // the cache is real, and resetCaches() clears it.
    const firm = await createFirm();
    const member = await memberWith(firm.id, ['clients.manage']);

    const allowed = await member.api
      .post(`/api/lawfirms/${firm.id}/clients`)
      .send({ name: 'Allowed' });
    expect(allowed.status).toBe(201);

    // Revoke it behind the app's back, exactly as a concurrent role edit would.
    await testPool.query(
      `update roles set permissions = '{}' where law_firm_id = $1`,
      [firm.id],
    );

    // Still authorized: the resolved set is memoized, and nothing invalidated it.
    const stale = await member.api
      .post(`/api/lawfirms/${firm.id}/clients`)
      .send({ name: 'Stale' });
    expect(stale.status).toBe(201);

    resetCaches();

    const refused = await member.api
      .post(`/api/lawfirms/${firm.id}/clients`)
      .send({ name: 'Refused' });
    expect(refused.status).toBe(403);
  });
});
