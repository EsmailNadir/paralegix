/**
 * The finalize recovery pass, and the retry it exists to fix.
 *
 * A completion commits a `finalize` JOB in the same transaction as the last
 * signer's consent, and then usually runs it inline. The job seals both
 * artifacts, files the executed copy into the firm's tree, preserves the archive
 * copies, and only THEN moves the session to its terminal 'completed' state.
 * That order is deliberate: everything the outside world sees hangs off the
 * terminal write, so a failure before it leaves a retryable in-progress session
 * rather than a completed one with no downloadable document.
 *
 * `recoverStuckFinalizations` is the retry, and it now goes through the SAME job
 * claim as everything else rather than a claim of its own. Two claim mechanisms
 * for one piece of work was the defect: a live worker holding the job lease and
 * this pass holding a session stamp were each correct on their own terms while
 * producing two artifact sets, two quota charges and two sets of completion
 * emails.
 *
 * Rerunning is the operative word. A retry after the first attempt already filed
 * the document must land on the SAME row: it claims by `signed_via_session`, so
 * the copy goes to the object that row already names and the quota is charged
 * only the difference. Resolving a fresh name instead would file a second
 * executed copy next to the first, charge storage twice for one document, and
 * leave the browser showing a duplicate with no session pointing at the orphan.
 *
 * THE INJECTED FAILURE is `markSessionCompleted`, which is the terminal write
 * itself. Failing it reproduces exactly the state the recovery pass exists for:
 * artifacts sealed, document filed, quota charged, session still 'in_progress'.
 *
 * SEEDING. A session must be FIELD-DRIVEN to be recoverable at all: the job
 * rebuilds the executed document from the stored source plus the accumulated
 * field values, and a fieldless session has no server-rebuildable source
 * (`shouldRebuildSessionPdfFromFieldValues`). So this seeds one
 * `signature_fields` row and submits it through the real JSON /complete
 * request, exactly like a browser signing a text field would.
 *
 * THE BUCKET is the shared in-memory double, because the appending pipeline
 * pins generations, reads byte ranges and asks storage to JOIN objects server
 * side. A stub answering only `download()` would fail all three, and this file
 * would be asserting against the stub. `failNextSave` is layered on top of it,
 * for the one case that needs storage to refuse a write.
 */
import {
  testPool,
  request,
  drainEvents,
  createFirm,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { gateMethod } from '../support/gate';
import {
  seedSigningSession, storeSigningSource, makePdf, completionBody,
} from '../support/signing';

const { admin } = require('../../src/shared/database/firebase');
const {
  objects: storedObjects,
  inMemoryBucket,
  fakeFile: bucketFile,
} = require('../support/inMemoryBucket');

/** When true, the next storage write is refused. */
let failNextSave = false;

const failingBucket = {
  ...inMemoryBucket,
  file: (objectPath: string, options?: any) => {
    const handle = bucketFile(objectPath, options) as any;
    return {
      ...handle,
      save: async (body: any, saveOptions: any = {}) => {
        if (failNextSave) {
          failNextSave = false;
          throw Object.assign(new Error('archive storage unavailable'), { code: 503 });
        }
        return handle.save(body, saveOptions);
      },
    };
  },
};

// Module-scope, before the app (and therefore signing.routes.ts) ever loads:
// the route resolves `admin.storage().bucket(...)` once, at import time.
admin.storage = () => ({ bucket: () => failingBucket });

const signingRoutes = require('../../src/modules/signatures/signing.routes');
const signaturesRepo = require('../../src/modules/signatures/signatures.repository');

let firm: Firm;
let owner: Actor;
let onePagePdf: Buffer;

/** A field-driven, single-participant session whose one signer completes it outright. */
async function seedFieldDrivenSession() {
  // The session's source has to describe the document this spec stored:
  // finalization opens the prepared object pinned to the generation the row
  // records.
  const objectPath = await storeSigningSource(firm.id, onePagePdf);
  const { sessionToken, participants: [signer] } = await seedSigningSession({
    lawFirmId: firm.id,
    createdBy: owner.uid,
    session: {
      routing_mode: 'sequential',
      object_path: objectPath,
      current_signer_order: 1,
      notify_email: null,
      document_hash: 'originalhash',
    },
    participants: [{
      name: 'Jane Doe',
      email: 'jane@example.test',
      fields: [{
        fieldType: 'text', label: 'Full name', xPercent: 10, yPercent: 10, widthPercent: 40, heightPercent: 8,
      }],
    }],
  });

  return { sessionToken, objectPath, publicToken: signer.publicToken, fieldId: signer.fieldIds[0] };
}

/** The revision the signing page carried, which a completion has to echo back. */
const viewRevision = async (publicToken: string) => {
  const res = await request().get(`/api/signing/${publicToken}`);
  expect(res.status).toBe(200);
  return res.body.sourceRevision;
};

const complete = async (publicToken: string, fieldId: string) =>
  request().post(`/api/signing/${publicToken}/complete`)
    .set('Content-Type', 'application/json')
    .send(completionBody({
      consentName: 'Jane Doe',
      sourceRevision: await viewRevision(publicToken),
      fieldValues: [{ fieldId, value: 'Jane Doe' }],
    }) as never);

const sessionStatus = async (token: string) => {
  const { rows } = await testPool.query(
    'select status from signature_sessions where token = $1', [token],
  );
  return rows[0]?.status;
};

/**
 * Put a session's `updated_at` far enough in the past to fall inside the
 * recovery pass's grace window, without waiting the real 5 minutes out.
 *
 * Every table with an `updated_at` column gets a `set_updated_at` trigger that
 * unconditionally stamps `now()` on any UPDATE (see the whole-schema sweep at
 * the bottom of db/schema.sql), so an ordinary `update ... set updated_at = ...`
 * is overwritten by its own trigger before it commits. The trigger has to be
 * disabled for this one statement and put back immediately after.
 */
const backdateSessionForRecovery = async (token: string) => {
  await testPool.query('alter table signature_sessions disable trigger set_updated_at');
  try {
    await testPool.query(
      `update signature_sessions set updated_at = now() - interval '10 minutes' where token = $1`,
      [token],
    );
  } finally {
    await testPool.query('alter table signature_sessions enable trigger set_updated_at');
  }
};

const storageUsedBytes = async () => {
  const { rows } = await testPool.query(
    'select coalesce(storage_used_bytes, 0) as bytes from law_firms where id = $1', [firm.id],
  );
  return Number(rows[0]?.bytes || 0);
};

/**
 * The objects this firm has FILED, as opposed to the ones the system keeps for
 * itself (the preserved archive copies, the scratch copies of an open session).
 *
 * Asked of the files table rather than of storage. A filed document IS a row,
 * and the row picks the object path, so there is no longer a prefix to test a
 * string against. That coupling is what the old check depended on, and it is
 * what made a folder rename have to rewrite every object beneath it.
 *
 * FINALIZED rows only, which is the same condition every listing applies. A row
 * is claimed before its bytes are saved, so an unfinalized row is a write that
 * did not finish. It is invisible to the browser, it is not counted against the
 * quota, and the unfinished-upload sweep collects it. Counting one here would
 * report a document as filed that nobody can open.
 */
const filedDocumentPaths = async () => {
  const { rows } = await testPool.query(
    `select object_path from files
      where law_firm_id = $1 and kind = 'file'
        and deleted_at is null and finalized_at is not null
      order by object_path`,
    [firm.id],
  );
  return rows.map((row: any) => row.object_path);
};

const filesRowCount = async (objectPath: string) => {
  const { rows } = await testPool.query(
    'select count(*)::int as n from files where law_firm_id = $1 and object_path = $2',
    [firm.id, objectPath],
  );
  return rows[0]?.n ?? 0;
};

beforeEach(async () => {
  storedObjects.clear();
  failNextSave = false;
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  onePagePdf = await makePdf();
  await drainEvents();
});

describe('a session stuck after the document was stored but the session commit failed', () => {
  it('leaves the session in_progress and the document already filed', async () => {
    const { sessionToken, publicToken, fieldId } = await seedFieldDrivenSession();
    const gate = gateMethod(signaturesRepo, 'markSessionCompleted');
    gate.failNext(new Error('simulated DB outage at the terminal commit'));

    try {
      const res = await complete(publicToken, fieldId);

      // The request failed: the terminal write is the one thing standing between
      // a stored document and a session that says so, and it was made to fail.
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(await sessionStatus(sessionToken)).toBe('in_progress');
      // The design comment's whole point: the bytes are NOT lost by this failure.
      expect(await filedDocumentPaths()).toHaveLength(1);
    } finally {
      gate.restore();
    }
  });

  it('recovers to completed WITHOUT filing a second copy or double-charging storage', async () => {
    const { sessionToken, publicToken, fieldId } = await seedFieldDrivenSession();
    const gate = gateMethod(signaturesRepo, 'markSessionCompleted');
    gate.failNext(new Error('simulated DB outage at the terminal commit'));

    const failedRes = await complete(publicToken, fieldId);
    gate.restore();
    expect(failedRes.status).toBeGreaterThanOrEqual(500);

    const pathsAfterFailure = await filedDocumentPaths();
    expect(pathsAfterFailure).toHaveLength(1);
    const [filedPath] = pathsAfterFailure;
    const sizeAfterFirstAttempt = storedObjects.get(filedPath)!.bytes;
    const usageAfterFirstAttempt = await storageUsedBytes();

    await backdateSessionForRecovery(sessionToken);
    await signingRoutes.recoverStuckFinalizations();

    expect(await sessionStatus(sessionToken)).toBe('completed');

    // The crux of the fix: recovery must land on the SAME object the failed
    // live request already filed, not a second "(1)" copy next to it.
    const pathsAfterRecovery = await filedDocumentPaths();
    expect(pathsAfterRecovery).toEqual([filedPath]);

    // Only one `files` mirror row for the document, not a duplicate for an
    // orphaned second copy.
    expect(await filesRowCount(filedPath)).toBe(1);

    // Storage is charged once for the document, not twice. The rebuilt PDF on
    // recovery can differ by a few bytes from the first attempt (the
    // certificate page's rendered timestamp differs), so this checks the
    // charge did not compound rather than asserting exact equality with the
    // first attempt's own size.
    const usageAfterRecovery = await storageUsedBytes();
    const sizeAfterRecovery = storedObjects.get(filedPath)!.bytes;
    expect(usageAfterRecovery).toBe(usageAfterFirstAttempt + (sizeAfterRecovery - sizeAfterFirstAttempt));
  });
});

describe('a stuck session whose filed copy the firm has since deleted', () => {
  it('recovers to completed without resurrecting the copy or charging for it', async () => {
    const { sessionToken, publicToken, fieldId } = await seedFieldDrivenSession();
    const gate = gateMethod(signaturesRepo, 'markSessionCompleted');
    gate.failNext(new Error('simulated DB outage at the terminal commit'));
    const failedRes = await complete(publicToken, fieldId);
    gate.restore();
    expect(failedRes.status).toBeGreaterThanOrEqual(500);

    // Between the failed attempt and the recovery pass, the firm deletes the
    // executed copy from their files. Nothing stops them: it is an ordinary
    // document in their tree.
    const filesRepo = require('../../src/modules/files/files.repository');
    const [filedPath] = await filedDocumentPaths();
    const filed = await filesRepo.findByObjectPath(firm.id, filedPath);
    await filesRepo.softDeleteSubtree(firm.id, filed.id, owner.uid);
    const usageAfterDelete = await storageUsedBytes();

    await backdateSessionForRecovery(sessionToken);
    await signingRoutes.recoverStuckFinalizations();

    // The session still completes: the archive copy is the durable record, and
    // a firm's decision to remove the filed copy is not a reason to leave a
    // signer's session stuck. It is also not undone. The row stays deleted,
    // no second copy is filed beside it, and the firm is charged nothing.
    expect(await sessionStatus(sessionToken)).toBe('completed');
    expect(await filedDocumentPaths()).toEqual([]);
    const { rows } = await testPool.query(
      'select count(*)::int n from files where law_firm_id = $1 and signed_via_session = $2',
      [firm.id, sessionToken],
    );
    expect(rows[0].n).toBe(1);
    expect(await storageUsedBytes()).toBe(usageAfterDelete);
  });
});

describe('a session whose final document cannot be stored', () => {
  it('does not mark the session complete or charge storage when the provider rejects the final write', async () => {
    const { sessionToken, publicToken, fieldId } = await seedFieldDrivenSession();
    failNextSave = true;

    const res = await complete(publicToken, fieldId);

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await sessionStatus(sessionToken)).toBe('in_progress');
    expect(await filedDocumentPaths()).toHaveLength(0);
    expect(await storageUsedBytes()).toBe(0);
  });
});

describe('the recovery pass has a deadline', () => {
  it('claims nothing once its deadline has passed, and recovers on the next pass', async () => {
    // It runs inside the housekeeping request, beside four other passes with
    // one shared budget. Up to 200 finalizations, each able to seal a whole
    // document, with no deadline, could hold that request past its own.
    const { sessionToken, publicToken, fieldId } = await seedFieldDrivenSession();
    const gate = gateMethod(signaturesRepo, 'markSessionCompleted');
    gate.failNext(new Error('simulated DB outage at the terminal commit'));
    const failed = await complete(publicToken, fieldId);
    gate.restore();
    expect(failed.status).toBeGreaterThanOrEqual(500);
    await backdateSessionForRecovery(sessionToken);

    await signingRoutes.recoverStuckFinalizations({ deadline: Date.now() - 1 });
    expect(await sessionStatus(sessionToken)).toBe('in_progress');

    await signingRoutes.recoverStuckFinalizations({ deadline: Date.now() + 60_000 });
    expect(await sessionStatus(sessionToken)).toBe('completed');
  });
});
