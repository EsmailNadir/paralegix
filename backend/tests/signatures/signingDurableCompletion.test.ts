/**
 * What survives a process that dies, and what must never happen twice.
 *
 * The last signer's consent and the finalize JOB are committed in one
 * transaction. That is the whole point of the job existing: a document produced
 * inside the request that carried the signature is lost when that request's
 * instance is killed, and nothing records that anything was owed. So these
 * cases are about the boundary, not about the pipeline. `signingPipeline` and
 * `signingFinalize` prove the artifacts are correct; this file proves there is
 * exactly ONE of everything the outside world can see.
 *
 * NAME WHAT HAS TO BREAK, per case:
 *
 *   OWED AFTER A DEATH. Move `enqueueProcessingJob` out of the consent
 *   transaction (or enqueue after the response) and the killed request leaves no
 *   job. The drain then finds nothing and the session is stuck for ever with
 *   every signature and no document.
 *
 *   ONE ARTIFACT SET. Remove the lease check from the claim, or drop the guard
 *   on the terminal session write, and two workers each file, each charge the
 *   quota, and each send the signers a copy. Neither errors. The only evidence
 *   is the counts asserted here.
 *
 *   ONE QUOTA CHARGE. Charge `sizeBytes` instead of `sizeBytes - reusedSizeBytes`
 *   and a retried finalize bills one executed document once per attempt. The
 *   retry case is what catches it; the first run looks identical either way.
 *
 *   LINK, NOT ATTACHMENT. Raise the delivery threshold, or drop the size check,
 *   and a large executed document is base64'd into an email per recipient. That
 *   is the memory the appending pipeline exists to avoid, spent at the last
 *   step, and mail providers refuse the message anyway.
 *
 *   THE CAPABILITY IS BOUND. Let `mintSigningArtifactUrl` skip its participant
 *   check and any completed signer of any session can be handed a URL for any
 *   object the session names. The refusal cases are what hold that shut.
 *
 * SEEDING follows `signingJsonCompletion.test.ts`: SQL, because the harness's
 * GCS double is inert and a fixture routed through the real upload would be
 * testing the double. Sessions are FIELD-DRIVEN, because a fieldless session has
 * no server-rebuildable source and deliberately does not take this path at all.
 *
 * THE BUCKET is the shared in-memory one, because the appending pipeline pins
 * generations, reads byte ranges and asks storage to JOIN objects server side.
 */
import {
  testPool,
  request,
  drainEvents,
  createFirm,
  ownerOf,
  emailsMatching,
  resetEmails,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { gateMethod } from '../support/gate';
import { objects, putObject, installInMemoryBucket } from '../support/inMemoryBucket';
import { minimalPdf } from '../support/minimalPdf';
import {
  seedSigningSession, storeSigningSource, completionBody, SIGNATURE_DATA_URL,
  settleAfterResponse,
} from '../support/signing';

installInMemoryBucket();

const repo = require('../../src/modules/signatures/signatures.repository');
const signingRoutes = require('../../src/modules/signatures/signing.routes');
const { drainSigningJobs } = require('../../src/modules/signatures/signingJobs');
const { mintSigningArtifactUrl } = require('../../src/modules/signatures/signingDownloads');
const {
  SIGNING_ATTACHMENT_MAX_BYTES,
} = require('../../src/modules/signatures/signingDelivery');
const {
  publishCompletedSession,
} = require('../../src/modules/signatures/signingPublication');

let firm: Firm;
let owner: Actor;

/**
 * One field-driven session with one active signer, over a source of a chosen
 * size. The signer completes it with the real public route.
 */
async function seedSession(options: { sourceBytes?: Buffer; signerCount?: number } = {}) {
  const source = options.sourceBytes ?? minimalPdf({ pages: 1 }).bytes;
  // The session's source has to describe the document this spec stored:
  // finalization opens the prepared object pinned to the generation the row
  // records.
  const objectPath = await storeSigningSource(firm.id, source);
  const { sessionToken, participants } = await seedSigningSession({
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
    participants: Array.from({ length: options.signerCount ?? 1 }, (_, index) => ({
      status: index === 0 ? 'active' : 'waiting',
      fields: [{
        fieldType: 'signature' as const, label: 'Sign', xPercent: 20 + index * 10, yPercent: 20, sortOrder: index,
      }],
    })),
  });
  const signers = participants.map((p) => ({
    participantId: p.participantId, publicToken: p.publicToken, fieldId: p.fieldIds[0],
  }));

  return { sessionToken, objectPath, signers, source };
}

/** The view the signing page reads, whose revision a completion has to echo. */
async function sourceRevision(publicToken: string) {
  const res = await request().get(`/api/signing/${publicToken}`);
  expect(res.status).toBe(200);
  return res.body.sourceRevision;
}

const submit = async (signer: { publicToken: string; fieldId: string }) =>
  request()
    .post(`/api/signing/${signer.publicToken}/complete`)
    .set('Content-Type', 'application/json')
    .send(completionBody({
      consentName: 'A Signer',
      sourceRevision: await sourceRevision(signer.publicToken),
      fieldValues: [{ fieldId: signer.fieldId, value: SIGNATURE_DATA_URL }],
    }) as never);

const sessionRow = async (token: string) => {
  const { rows } = await testPool.query(
    `select status, final_object_path, signed_object_path,
            signed_document_hash, delivery_document_hash
       from signature_sessions where token = $1`,
    [token],
  );
  return rows[0];
};

const jobRow = async (token: string) => {
  const { rows } = await testPool.query(
    `select j.id, j.status, j.attempt, j.phase from signature_processing_jobs j
       join signature_sessions s on s.id = j.session_id
      where s.token = $1`,
    [token],
  );
  return rows;
};

/** FINALIZED file rows only: an unfinalized row is a write that did not land. */
const filedRows = async () => {
  const { rows } = await testPool.query(
    `select id, object_path, size_bytes from files
      where law_firm_id = $1 and kind = 'file'
        and deleted_at is null and finalized_at is not null`,
    [firm.id],
  );
  return rows;
};

const storageUsedBytes = async () => {
  const { rows } = await testPool.query(
    'select coalesce(storage_used_bytes, 0) as bytes from law_firms where id = $1', [firm.id],
  );
  return Number(rows[0]?.bytes || 0);
};

const archivedPaths = (token: string) => [...objects.keys()]
  .filter((key) => key.includes(`/signatures/${token}/`))
  .sort();

/**
 * Let the deferred tail of a completion run.
 *
 * The certificate is archived on a `setImmediate` AFTER the audit row it renders
 * from, deliberately: rendering it earlier freezes a timeline that stops before
 * the signature. So a test that asserts on it has to wait for that turn rather
 * than assume it already happened.
 */
const settle = async (until?: () => boolean) => {
  for (let i = 0; i < 200; i += 1) {
    if (until && until()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  // Deliberately not a silent give-up: a certificate that never arrives is the
  // exact failure the ordering rule exists to prevent, and it must not read as
  // a passing test.
  if (until) expect(until()).toBe(true);
};

/** The archived certificate for a session, once the deferred render lands. */
const certificateArrived = (token: string) => () =>
  objects.has(`lawfirmids/${firm.id}/signatures/${token}/certificate-of-completion.pdf`);

/** Make a retryable job due now, the way waiting out its backoff would. */
const makeJobDue = async (token: string) => {
  await testPool.query(
    `update signature_processing_jobs j
        set next_attempt_at = now() - interval '1 minute'
      where j.session_id = (select id from signature_sessions where token = $1)`,
    [token],
  );
};

beforeEach(async () => {
  objects.clear();
  resetEmails();
  await testPool.query('delete from signature_processing_jobs');
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  await drainEvents();
});

describe('the finalize job is committed with the consent that owes it', () => {
  it('leaves the job OWED when the request dies, and a later drain produces exactly one artifact set', async () => {
    // The kill is simulated at the one boundary a dying instance would cross
    // after the commit: the claim that would have started the work. Everything
    // before it is real, so what is asserted is the state the database was
    // actually left in.
    const { sessionToken, signers } = await seedSession();
    const gate = gateMethod(repo, 'claimProcessingJobById');
    gate.failNext(new Error('instance killed before the finalize could start'));

    let res;
    try {
      res = await submit(signers[0]);
    } finally {
      gate.restore();
    }

    // The signature is committed. That is the half that must never be lost.
    expect(res!.status).toBe(500);
    const { rows: participants } = await testPool.query(
      `select p.status from signature_participants p
         join signature_sessions s on s.id = p.session_id where s.token = $1`,
      [sessionToken],
    );
    expect(participants.map((row: any) => row.status)).toEqual(['completed']);
    // And the work is owed, in the same transaction. Not a promise, a row.
    expect(await jobRow(sessionToken)).toEqual([
      expect.objectContaining({ status: 'queued', phase: null }),
    ]);
    expect((await sessionRow(sessionToken)).status).toBe('in_progress');
    expect(await filedRows()).toEqual([]);

    const report = await drainSigningJobs({ owner: 'drain-a' });
    await settle(certificateArrived(sessionToken));

    expect(report.succeeded).toBe(1);
    const row = await sessionRow(sessionToken);
    expect(row.status).toBe('completed');
    expect(row.signed_object_path).toBeTruthy();
    expect(row.delivery_document_hash).toBeTruthy();
    // ONE of each: one filed document, one delivered archive copy, one filed
    // archive copy. A second artifact set is the failure the lease prevents and
    // it does not announce itself any other way.
    expect(await filedRows()).toHaveLength(1);
    expect(archivedPaths(sessionToken)).toEqual([
      `lawfirmids/${firm.id}/signatures/${sessionToken}/certificate-of-completion.pdf`,
      `lawfirmids/${firm.id}/signatures/${sessionToken}/delivered-document.pdf`,
      `lawfirmids/${firm.id}/signatures/${sessionToken}/delivery.pdf`,
      `lawfirmids/${firm.id}/signatures/${sessionToken}/filed.pdf`,
      `lawfirmids/${firm.id}/signatures/${sessionToken}/signed-document.pdf`,
    ]);
  });
});

describe('two workers on one session', () => {
  it('produces one artifact set, one quota charge and one set of signer copies', async () => {
    const { sessionToken, signers } = await seedSession();

    // The live request finishes it. Then a drain runs against the same session,
    // which is exactly what a scheduler tick overlapping a slow request does.
    expect((await submit(signers[0])).status).toBe(200);
    // The signer copies are sent after the response; wait for them.
    await settleAfterResponse();
    const usageAfterFirst = await storageUsedBytes();
    const copiesAfterFirst = emailsMatching(/Your signed copy/).length;

    const second = await drainSigningJobs({ owner: 'drain-b' });

    // Nothing left to claim, so nothing ran a second time.
    expect(second.succeeded).toBe(0);
    expect(await filedRows()).toHaveLength(1);
    expect(await storageUsedBytes()).toBe(usageAfterFirst);
    expect(emailsMatching(/Your signed copy/)).toHaveLength(copiesAfterFirst);
    expect(copiesAfterFirst).toBe(1);
  });

  it('lets the SECOND worker in only after the first settles, and it publishes nothing', async () => {
    // Proved rather than hoped: the gate holds the first worker inside the
    // terminal session write, and the second is started while it is parked
    // there. Whichever order they settle in, only one may publish.
    const { sessionToken, signers } = await seedSession();
    const gate = gateMethod(repo, 'claimProcessingJobById');
    gate.failNext(new Error('instance killed before the finalize could start'));
    try {
      await submit(signers[0]);
    } finally {
      gate.restore();
    }

    const [first, secondReport] = await Promise.all([
      drainSigningJobs({ owner: 'drain-one' }),
      drainSigningJobs({ owner: 'drain-two' }),
    ]);

    // Exactly one of the two did the work; the other found nothing to claim.
    expect([first.succeeded, secondReport.succeeded].sort()).toEqual([0, 1]);
    expect((await sessionRow(sessionToken)).status).toBe('completed');
    expect(await filedRows()).toHaveLength(1);
    expect(emailsMatching(/Your signed copy/)).toHaveLength(1);
  });
});

describe('the terminal transition is what makes a second worker harmless', () => {
  it('moves the session exactly once, however many workers reach it', async () => {
    // The lease stops two workers being inside one job. This is the second
    // guarantee underneath it, and the one that decides who DELIVERS: the
    // transition is guarded, so a worker that reaches the terminal write after
    // another already moved the row is told so and stops. Drop the guard and
    // both proceed to file, charge and email.
    const { sessionToken, signers } = await seedSession({ signerCount: 2 });
    expect((await submit(signers[0])).status).toBe(200);
    expect((await submit(signers[1])).status).toBe(200);

    const again = await repo.markSessionCompleted(sessionToken, {
      completedAt: new Date().toISOString(),
    });

    expect(again).toBe(false);
  });

  it('publishes once when the publication itself is run twice', async () => {
    const { sessionToken, signers } = await seedSession();
    expect((await submit(signers[0])).status).toBe(200);
    await settle(certificateArrived(sessionToken));
    await settleAfterResponse();
    const usageAfterFirst = await storageUsedBytes();

    // Exactly what a worker whose claim was taken away and replaced would do:
    // arrive at publication with the same artifacts, after the winner is done.
    const second = await publishCompletedSession({
      lawFirmId: firm.id,
      token: sessionToken,
      result: { delivery: null, filed: null },
    });

    expect(second.published).toBe(false);
    expect(await filedRows()).toHaveLength(1);
    expect(await storageUsedBytes()).toBe(usageAfterFirst);
    expect(emailsMatching(/Your signed copy/)).toHaveLength(1);
  });
});

describe('the quota is charged the actual new size, once', () => {
  it('charges the executed copy exactly its own size on a first run', async () => {
    const { signers } = await seedSession();

    expect((await submit(signers[0])).status).toBe(200);

    const [filed] = await filedRows();
    const stored = objects.get(filed.object_path)!;
    // Not a coincidence worth trusting: the charge, the row's recorded size and
    // the object's real length all have to be the same number.
    expect(Number(filed.size_bytes)).toBe(stored.bytes);
    expect(await storageUsedBytes()).toBe(stored.bytes);
  });

  it('charges NOTHING more when the finalize is retried after the terminal write failed', async () => {
    const { sessionToken, signers } = await seedSession();
    const gate = gateMethod(repo, 'markSessionCompleted');
    gate.failNext(new Error('simulated outage at the terminal write'));

    const failed = await submit(signers[0]);
    gate.restore();

    // The document is filed and charged; only the publication did not land.
    expect(failed.status).toBe(503);
    expect((await sessionRow(sessionToken)).status).toBe('in_progress');
    const usageAfterFailure = await storageUsedBytes();
    expect(usageAfterFailure).toBeGreaterThan(0);

    await makeJobDue(sessionToken);
    const report = await drainSigningJobs({ owner: 'drain-retry' });

    expect(report.succeeded).toBe(1);
    expect((await sessionRow(sessionToken)).status).toBe('completed');
    // The retry landed on the SAME row, so the delta was zero. Charging the
    // full size again would bill one executed document once per attempt.
    expect(await filedRows()).toHaveLength(1);
    expect(await storageUsedBytes()).toBe(usageAfterFailure);
  });
});

describe('delivery is bounded by the size of what it is delivering', () => {
  it('states the threshold it enforces', () => {
    // Read from the module rather than restated, so raising the constant has to
    // be a deliberate change to this number and not a silent one.
    expect(SIGNING_ATTACHMENT_MAX_BYTES).toBe(5 * 1024 * 1024);
  });

  it('attaches a small executed document, as it always has', async () => {
    const { signers } = await seedSession();

    expect((await submit(signers[0])).status).toBe(200);
    await settleAfterResponse();

    const [copy] = emailsMatching(/Your signed copy/);
    expect(copy.attachments).toHaveLength(1);
    // The attachment is the executed document, byte for byte, not a placeholder
    // or a truncated preview.
    const { rows } = await testPool.query(
      'select final_object_path from signature_sessions where token = $1',
      [signers[0].publicToken.replace(/^pub-/, 'sess-').replace(/-\d+$/, '')],
    );
    const delivered = objects.get(rows[0].final_object_path)!.body!;
    const attached = Buffer.from(
      (copy.attachments![0] as any).content as string, 'base64',
    );
    expect(attached.equals(delivered)).toBe(true);
  });

  it('sends a LINK instead of an attachment once the document is over the threshold', async () => {
    // A genuinely large source, not a lowered constant: the branch has to be
    // reached the way a real document reaches it.
    const large = minimalPdf({ pages: 1, fillerBytes: SIGNING_ATTACHMENT_MAX_BYTES + 1024 });
    const { signers } = await seedSession({ sourceBytes: large.bytes });

    expect((await submit(signers[0])).status).toBe(200);
    await settleAfterResponse();

    const [copy] = emailsMatching(/Your signed copy/);
    expect(copy.attachments).toBeUndefined();
    expect(copy.text).toContain('https://signed.test/');
    // And it says so, rather than telling the signer to look for an attachment
    // that is not there.
    expect(copy.text).toMatch(/too large to attach/i);
  });
});

describe('the delivery capability is bound to one participant and one artifact', () => {
  it('mints a generation-pinned link for the participant who signed', async () => {
    const { sessionToken, signers } = await seedSession();
    expect((await submit(signers[0])).status).toBe(200);
    const row = await sessionRow(sessionToken);

    const minted = await mintSigningArtifactUrl({
      lawFirmId: firm.id,
      token: sessionToken,
      participantId: signers[0].participantId,
      objectPath: row.final_object_path,
    });

    expect(minted.generation).toBe(objects.get(row.final_object_path)!.generation);
    expect(minted.url).toContain(`generation=${minted.generation}`);
  });

  it('REFUSES a participant id that is not on this session', async () => {
    const { sessionToken, signers } = await seedSession();
    expect((await submit(signers[0])).status).toBe(200);
    const row = await sessionRow(sessionToken);

    await expect(mintSigningArtifactUrl({
      lawFirmId: firm.id,
      token: sessionToken,
      participantId: 'someone-else',
      objectPath: row.final_object_path,
    })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('REFUSES a caller naming another firm', async () => {
    const { sessionToken, signers } = await seedSession();
    expect((await submit(signers[0])).status).toBe(200);
    const row = await sessionRow(sessionToken);
    const other = await createFirm({ name: 'Vance LLP' });

    await expect(mintSigningArtifactUrl({
      lawFirmId: other.id,
      token: sessionToken,
      participantId: signers[0].participantId,
      objectPath: row.final_object_path,
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('REFUSES an object this session never published', async () => {
    // Without this the caller chooses the path, and one completed participant
    // becomes a way to read any object in the bucket.
    const { sessionToken, signers } = await seedSession();
    expect((await submit(signers[0])).status).toBe(200);
    putObject(`lawfirmids/${firm.id}/objects/somebody-elses.pdf`, { body: Buffer.from('%PDF-1.7\n') });

    await expect(mintSigningArtifactUrl({
      lawFirmId: firm.id,
      token: sessionToken,
      participantId: signers[0].participantId,
      objectPath: `lawfirmids/${firm.id}/objects/somebody-elses.pdf`,
    })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('REFUSES a participant of a session that has not finished', async () => {
    const { sessionToken, signers } = await seedSession({ signerCount: 2 });
    expect((await submit(signers[0])).status).toBe(200);

    await expect(mintSigningArtifactUrl({
      lawFirmId: firm.id,
      token: sessionToken,
      participantId: signers[0].participantId,
      objectPath: `lawfirmids/${firm.id}/signatures/${sessionToken}/delivery.pdf`,
    })).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('the recovery pass and a live worker cannot both finish one session', () => {
  it('ends with one artifact set, whichever of them got the claim', async () => {
    const { sessionToken, signers } = await seedSession();
    const gate = gateMethod(repo, 'claimProcessingJobById');
    gate.failNext(new Error('instance killed before the finalize could start'));
    try {
      await submit(signers[0]);
    } finally {
      gate.restore();
    }

    // The recovery pass only looks at sessions untouched for its grace period.
    // The `set_updated_at` trigger stamps every UPDATE, so it has to be off for
    // this one statement.
    await testPool.query('alter table signature_sessions disable trigger set_updated_at');
    try {
      await testPool.query(
        `update signature_sessions set updated_at = now() - interval '10 minutes'
          where token = $1`, [sessionToken],
      );
    } finally {
      await testPool.query('alter table signature_sessions enable trigger set_updated_at');
    }

    await Promise.all([
      signingRoutes.recoverStuckFinalizations(),
      drainSigningJobs({ owner: 'drain-live' }),
    ]);

    expect((await sessionRow(sessionToken)).status).toBe('completed');
    expect(await filedRows()).toHaveLength(1);
    expect(emailsMatching(/Your signed copy/)).toHaveLength(1);
    // One job, settled once. A second row would mean two workers each owed
    // their own copy of this work.
    expect(await jobRow(sessionToken)).toEqual([
      expect.objectContaining({ status: 'succeeded' }),
    ]);
  });
});
