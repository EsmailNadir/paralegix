/**
 * A signer's completion answers before its own request deadline.
 *
 * The last signer's consent and the finalize job commit together, and the
 * request then tries to finish the job inline by queueing for a transfer slot.
 * That queue's deadline (60s) used to be longer than the request's (40s). Under
 * load the request deadline fired first and the signer was told 504 while the
 * queued work went on to complete their document anyway, which reads as "it
 * failed, sign again" for a signature that had already landed.
 *
 * So the inline wait is bounded by what is left of the request, minus room for
 * the finalize work itself. Past that the answer is `processing` (202), the
 * same answer a document too large to finalize inline gets, and the drain owns
 * the job.
 *
 * The deadline here is shrunk to seconds so the cases run in seconds. The slot's
 * own queue deadline is left at its default on purpose: that is the mismatch
 * the fix is for.
 *
 * NAME WHAT HAS TO BREAK, per case:
 *
 *   PROCESSING BEFORE THE DEADLINE. Stop passing the remaining budget into
 *   `runJobNow` and the queued completion waits the slot's full 60s, the request
 *   deadline fires first, and the first case receives 504.
 *
 *   A SPENT BUDGET SKIPS THE QUEUE. Let `runJobNow` treat a zero budget as "no
 *   deadline" (the limiter's meaning of 0) and the second case claims and runs
 *   the job instead of reporting it busy.
 *
 *   NO FALSE FAILURE AFTER A 504. Drop the `headersSent` guard on the final write
 *   and the late write throws ERR_HTTP_HEADERS_SENT, which the catch logs as
 *   "Failed to complete signing session" for a session that completed.
 *
 *   DELIVERY OUTSIDE THE SLOT. Move `deliverCompletedSession` back inside the
 *   slot and, while a delivery is in progress, one of the slots is still held,
 *   so holding every slot does not succeed.
 *
 *   DELIVERY IS NOT LOST. Run deferred delivery only when the job settles as
 *   `succeeded` and a job whose terminal write fails after publication never
 *   emails anyone: the retry finds the session already completed and stops.
 */
process.env.REQUEST_TIMEOUT_MS = '3000';
process.env.SIGNING_INLINE_FINALIZE_MARGIN_MS = '1000';

import {
  testPool,
  request,
  createFirm,
  ownerOf,
  emailsMatching,
  resetEmails,
  drainEvents,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { gateMethod } from '../support/gate';
import { objects, installInMemoryBucket } from '../support/inMemoryBucket';
import { minimalPdf } from '../support/minimalPdf';
import {
  seedSigningSession, storeSigningSource, completionBody, holdEverySlot, SIGNATURE_DATA_URL,
  settleAfterResponse,
} from '../support/signing';

installInMemoryBucket();

const repo = require('../../src/modules/signatures/signatures.repository');
const signingDelivery = require('../../src/modules/signatures/signingDelivery');
const { drainSigningJobs, runJobNow, kickSigningDrain } = require('../../src/modules/signatures/signingJobs');

const REQUEST_DEADLINE_MS = 3000;

let firm: Firm;
let owner: Actor;

async function seedSession() {
  const objectPath = await storeSigningSource(firm.id, minimalPdf({ pages: 1 }).bytes);
  const { sessionToken, participants: [signer] } = await seedSigningSession({
    lawFirmId: firm.id,
    createdBy: owner.uid,
    session: {
      routing_mode: 'sequential',
      object_path: objectPath,
      current_signer_order: 1,
      notify_email: 'sender@example.test',
      email_signers_on_complete: true,
      document_hash: 'originalhash',
    },
    participants: [{
      name: 'Signer One',
      email: 'signer@example.test',
      fields: [{ fieldType: 'signature', label: 'Sign', yPercent: 20 }],
    }],
  });
  return { sessionToken, publicToken: signer.publicToken, fieldId: signer.fieldIds[0] };
}

type Seeded = Awaited<ReturnType<typeof seedSession>>;

async function submit(seeded: Seeded) {
  const page = await request().get(`/api/signing/${seeded.publicToken}`);
  expect(page.status).toBe(200);
  return request()
    .post(`/api/signing/${seeded.publicToken}/complete`)
    .set('Content-Type', 'application/json')
    .send(completionBody({
      sourceRevision: page.body.sourceRevision,
      fieldValues: [{ fieldId: seeded.fieldId, value: SIGNATURE_DATA_URL }],
    }) as never);
}

const finalizeJobs = async (token: string) => {
  const { rows } = await testPool.query(
    `select j.id, j.status, j.kind from signature_processing_jobs j
       join signature_sessions s on s.id = j.session_id
      where s.token = $1 and j.kind = 'finalize'`,
    [token],
  );
  return rows;
};

const sessionStatus = async (token: string) => {
  const { rows } = await testPool.query('select status from signature_sessions where token = $1', [token]);
  return rows[0]?.status;
};

/** Poll until `until()` holds, failing loudly rather than giving up quietly. */
async function eventually(until: () => boolean | Promise<boolean>, ms = 5_000) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    // eslint-disable-next-line no-await-in-loop
    if (await until()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  expect(await until()).toBe(true);
}

/** Whether every transfer slot can be taken within `ms`. */
async function everySlotFreeWithin(ms: number) {
  const slots = holdEverySlot();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  const free = await Promise.race([slots.ready.then(() => true), late]);
  clearTimeout(timer);
  return { free, release: slots.release };
}

beforeEach(async () => {
  objects.clear();
  resetEmails();
  await testPool.query('delete from signature_processing_jobs');
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  await drainEvents();
});

describe('a saturated transfer slot', () => {
  it('answers 202 processing before the request deadline, and this instance finishes the job once the slot frees', async () => {
    const seeded = await seedSession();
    const slots = holdEverySlot();
    await slots.ready;

    let res;
    const started = Date.now();
    try {
      res = await submit(seeded);
      const elapsed = Date.now() - started;

      expect(res.status).toBe(202);
      expect(res.body.state).toBe('processing');
      expect(elapsed).toBeLessThan(REQUEST_DEADLINE_MS);
      // Still owed. A busy answer that also dropped the job would leave a signed
      // session with no document and nothing recording that one was due.
      expect(await finalizeJobs(seeded.sessionToken)).toEqual([
        expect.objectContaining({ status: 'queued' }),
      ]);
      expect(await sessionStatus(seeded.sessionToken)).toBe('in_progress');
      expect(emailsMatching(/Your signed copy/)).toHaveLength(0);
    } finally {
      await slots.release();
    }

    // No cron call and no explicit drain: the completion's own background drain
    // takes the slot as it frees and finishes the document.
    await eventually(async () => (await sessionStatus(seeded.sessionToken)) === 'completed');
    await settleAfterResponse();
    expect(await finalizeJobs(seeded.sessionToken)).toEqual([
      expect.objectContaining({ status: 'succeeded' }),
    ]);
    expect(emailsMatching(/Your signed copy/)).toHaveLength(1);
  });
});

describe('the background drain a busy completion starts', () => {
  it('never runs two drain loops at once on one instance', async () => {
    // Parks each loop at its first claim. Two loops would both arrive here.
    const gate = gateMethod(repo, 'claimProcessingJob');
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    try {
      first = kickSigningDrain('kick-one');
      second = kickSigningDrain('kick-two');
      await gate.arrived(1);
      await expect(gate.arrived(2, 300)).rejects.toThrow(/waited 300ms for 2 concurrent calls/);
      expect(gate.entered()).toBe(1);
      gate.open();
      await Promise.all([first, second]);
    } finally {
      gate.restore();
    }
  });

  it('logs a failed drain instead of rejecting', async () => {
    const gate = gateMethod(repo, 'claimProcessingJob');
    gate.failNext(new Error('database unavailable'));
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(kickSigningDrain('kick-fails')).resolves.toBeUndefined();
      expect(errors.mock.calls.some((call) => String(call[0]).includes('Background signing drain failed'))).toBe(true);
    } finally {
      gate.restore();
      errors.mockRestore();
    }
  });
});

describe('runJobNow with no queue budget left', () => {
  it('reports busy without claiming, even when a slot is free', async () => {
    const seeded = await seedSession();
    // Fail the inline claim once so the completion leaves its job queued.
    const gate = gateMethod(repo, 'claimProcessingJobById');
    gate.failNext(new Error('inline finalize did not start'));
    try {
      await submit(seeded);
    } finally {
      gate.restore();
    }
    const [job] = await finalizeJobs(seeded.sessionToken);
    expect(job.status).toBe('queued');

    expect(await runJobNow(firm.id, job.id, 'request:spent', { queueTimeoutMs: 0 })).toBe('busy');

    // Not claimed: proved by the job being untouched and still runnable now.
    expect((await finalizeJobs(seeded.sessionToken))[0].status).toBe('queued');
    expect(await runJobNow(firm.id, job.id, 'request:fresh')).toBe('succeeded');
  });
});

describe('a completion that outlives its 504', () => {
  it('does not write a second response or log the completion as failed', async () => {
    const seeded = await seedSession();
    const errors = jest.spyOn(console, 'error');
    const warnings = jest.spyOn(console, 'warn');
    // Hold the handler AFTER the document is finished, past the deadline.
    const gate = gateMethod(repo, 'getProcessingJob');

    try {
      const res = await submit(seeded);
      expect(res.status).toBe(504);
      expect(gate.waiting()).toBe(1);
      gate.open();

      // Proof the handler reached its own response write after the 504.
      await eventually(() => warnings.mock.calls.some(
        (call) => String(call[0]).includes('Completion answered after the request deadline'),
      ));
      expect(await sessionStatus(seeded.sessionToken)).toBe('completed');
      expect(errors.mock.calls.filter(
        (call) => String(call[0]).includes('Failed to complete signing session'),
      )).toEqual([]);
    } finally {
      gate.restore();
      errors.mockRestore();
      warnings.mockRestore();
    }
  });
});

describe('completion emails are sent outside the transfer slot', () => {
  it('frees every slot before the signer request delivers', async () => {
    const seeded = await seedSession();
    const gate = gateMethod(signingDelivery, 'deliverCompletedSession');

    let probe: Awaited<ReturnType<typeof everySlotFreeWithin>> | undefined;
    try {
      const pending = submit(seeded);
      await gate.arrived(1);
      probe = await everySlotFreeWithin(500);
      gate.open();
      await probe.release();
      expect((await pending).status).toBe(200);
    } finally {
      gate.restore();
    }

    expect(probe!.free).toBe(true);
    // The emails are sent after the signer is answered, so wait for them.
    await settleAfterResponse();
    expect(emailsMatching(/Your signed copy/)).toHaveLength(1);
  });

  it('frees every slot before the drain delivers', async () => {
    const seeded = await seedSession();
    const claim = gateMethod(repo, 'claimProcessingJobById');
    claim.failNext(new Error('inline finalize did not start'));
    try {
      await submit(seeded);
    } finally {
      claim.restore();
    }

    const gate = gateMethod(signingDelivery, 'deliverCompletedSession');
    let probe: Awaited<ReturnType<typeof everySlotFreeWithin>> | undefined;
    try {
      const draining = drainSigningJobs({ owner: 'drain-delivery', maxJobs: 1 });
      await gate.arrived(1);
      probe = await everySlotFreeWithin(500);
      gate.open();
      await probe.release();
      expect((await draining).succeeded).toBe(1);
    } finally {
      gate.restore();
    }

    expect(probe!.free).toBe(true);
    expect(emailsMatching(/Your signed copy/)).toHaveLength(1);
  });

  it('still delivers exactly once when the job cannot record its own success', async () => {
    const seeded = await seedSession();
    const settle = gateMethod(repo, 'completeProcessingJob');
    settle.failNext(new Error('terminal job write failed'));

    try {
      await submit(seeded);
    } finally {
      settle.restore();
    }

    // Published, so the signers are owed their copy now. The retry below finds
    // the session already completed and must not send a second one.
    expect(await sessionStatus(seeded.sessionToken)).toBe('completed');
    // Sent after the signer is answered, so wait for it.
    await settleAfterResponse();
    expect(emailsMatching(/Your signed copy/)).toHaveLength(1);

    await testPool.query(
      `update signature_processing_jobs set next_attempt_at = now() - interval '1 minute'
        where status = 'queued'`,
    );
    await drainSigningJobs({ owner: 'drain-retry' });

    expect(emailsMatching(/Your signed copy/)).toHaveLength(1);
  });
});

describe('completion emails do not hold the signer response', () => {
  it('answers before a delivery slower than the request deadline, then delivers once', async () => {
    const seeded = await seedSession();
    // Parked until opened: a mail provider slower than the whole request budget.
    const gate = gateMethod(signingDelivery, 'deliverCompletedSession');

    try {
      const started = Date.now();
      const res = await submit(seeded);
      const elapsed = Date.now() - started;

      expect(res.status).toBe(200);
      expect(res.body.state).toBe('completed');
      expect(elapsed).toBeLessThan(REQUEST_DEADLINE_MS);
      // The answer went out with no email sent, and the delivery then reaches
      // the gate and parks there. The gate never opens on its own, so a route
      // that sent the emails BEFORE answering would never have answered: that
      // is the whole claim, nothing about the emails is in front of the signer.
      // The delivery is scheduled after the response, so it is awaited rather
      // than counted the instant the answer arrives.
      expect(emailsMatching(/Your signed copy/)).toHaveLength(0);
      await gate.arrived(1);

      gate.open();
      await settleAfterResponse();
    } finally {
      gate.restore();
    }

    expect(emailsMatching(/Your signed copy/)).toHaveLength(1);
    // A later drain finds nothing owed and sends nothing more.
    await drainSigningJobs({ owner: 'drain-after-delivery' });
    expect(emailsMatching(/Your signed copy/)).toHaveLength(1);
  });
});
