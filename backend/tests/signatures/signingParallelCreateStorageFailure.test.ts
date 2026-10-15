/**
 * Parallel-routed session creation, and the storage boundary it never had
 * coverage for: `createParallelWorkingCopies` (signatureLinks.routes.ts).
 *
 * `createPreparedSigningSession` (the function behind `/generate`, `/send-email`
 * and `/send`) does its DB write BEFORE giving every parallel participant their
 * own working copy of the prepared PDF:
 *
 *   1. `createSigningSession` -> `repo.createSession` commits the session row,
 *      every participant row (each with `working_object_path: null`) and every
 *      participant's public token in ONE Postgres transaction.
 *   2. Only THEN, for `routingMode: 'parallel'`, does `createParallelWorkingCopies`
 *      upload one PDF per participant to `lawfirmids/<firm>/signing-work/<token>/
 *      <participantId>.pdf` and return their `workingObjectPath`s for
 *      `repo.replaceParticipants` to persist.
 *
 * If step 2 fails partway - a storage write for one signer's copy is rejected -
 * the function throws past both the failed and the already-succeeded upload,
 * with nothing to catch it. The route has no try/catch (this repo's convention:
 * let it throw to the error handler), so the caller sees a bare 5xx and no
 * link. But step 1 already committed for real: a `signature_sessions` row, its
 * `signature_participants` rows and their `signature_participant_tokens` all
 * persist regardless of what step 2 does afterward. Nothing ever notifies a
 * signer (the invite loop in `/send` runs only after `createPreparedSigningSession`
 * returns), and nothing ever deletes the row, so the firm is left with a
 * `pending` session it was never told exists, and any object step 2 DID
 * manage to write before failing sits in storage with no reference cleaned up.
 *
 * This drives the real `/generate` route with `routingMode: 'parallel'` and two
 * named signers, and fails the SECOND signer's working-copy write at the exact
 * storage boundary while letting the first one land for real - proving the
 * failure is genuinely partial, not a same-request short-circuit.
 */
import {
  createFirm,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { sessionIdSql } from '../support/factories';
import { minimalPdfBytes } from '../support/minimalPdf';

const crypto = require('crypto');
const { admin } = require('../../src/shared/database/firebase');

/**
 * The shared in-memory bucket, with one write made to fail.
 *
 * This file used to carry a bucket of its own. Sending a document now ADMITS
 * it: the boundary pins the landed generation and inspects the structure
 * through bounded windows, and a double that answers only `download()` cannot
 * serve either. The shared one can, so the failure is injected on top of it
 * rather than reimplemented beside it.
 *
 * The injection moved from `save` to `copy` with the code: a participant's
 * working copy is a server-side copy of the prepared object now, not a Buffer
 * written once per signer.
 */
import { inMemoryBucket, objects, putObject } from '../support/inMemoryBucket';

/**
 * The working copy of the signer with this email is made to fail.
 *
 * The path names the participant by the id the server minted, which the
 * request cannot know in advance. The participant rows are committed before any
 * working copy is written, so the id in the path is resolved back to its row
 * and the failure lands on that one signer whatever order the copies run in.
 */
let failCopyForEmail: string | null = null;

/** The email of the participant a working-copy path belongs to, if any. */
async function participantEmailFor(objectPath: string): Promise<string | null> {
  const match = /\/signing-work\/[^/]+\/([^/]+)\.pdf$/.exec(objectPath);
  if (!match) return null;
  const { rows } = await testPool.query(
    'select email from signature_participants where id = $1', [match[1]],
  );
  return rows[0]?.email ?? null;
}

const failingBucket: any = new Proxy(inMemoryBucket, {
  get(target, property) {
    if (property !== 'file') {
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
    return (objectPath: string, options?: any) => {
      const handle: any = (target as any).file(objectPath, options);
      return {
        ...handle,
        copy: async (destination: any, copyOptions: any = {}) => {
          const target_ = String(destination?.name || destination);
          if (failCopyForEmail && (await participantEmailFor(target_)) === failCopyForEmail) {
            throw Object.assign(
              new Error('simulated storage outage writing a working copy'), { code: 503 },
            );
          }
          return handle.copy(destination, copyOptions);
        },
      };
    };
  },
});

// Module-scope, before the app (and therefore signatureLinks.routes.ts) ever
// loads: the route resolves `admin.storage().bucket(...)` once, at import time.
admin.storage = () => ({ bucket: () => failingBucket });

let firm: Firm;
let owner: Actor;

const seedGeneralPdf = async () => {
  const objectPath = `lawfirmids/${firm.id}/general/agreement.pdf`;
  // A real PDF: sending admits the document, and admission resolves its page
  // tree. A string that merely starts with the right bytes is refused, which is
  // the right answer to those bytes and the wrong subject for these cases.
  putObject(objectPath, { body: minimalPdfBytes({ pages: 2 }), contentType: 'application/pdf' });
  return objectPath;
};

const generate = (body: any) =>
  owner.api.post(`/api/lawfirms/${firm.id}/signature-links/generate`).send(body);

const sessionRows = async () => {
  const { rows } = await testPool.query(
    `select token, status, routing_mode from signature_sessions where law_firm_id = $1`,
    [firm.id],
  );
  return rows;
};

const participantRows = async (token: string) => {
  const { rows } = await testPool.query(
    `select id, working_object_path, status from signature_participants
      where session_id = ${sessionIdSql('$1')} order by signing_order`,
    [token],
  );
  return rows;
};

const tokenRows = async (token: string) => {
  const { rows } = await testPool.query(
    `select participant_id from signature_participant_tokens
      where session_id = ${sessionIdSql('$1')}`,
    [token],
  );
  return rows;
};

const workingCopyPaths = () => Array.from(objects.keys()).filter((key) => key.includes('/signing-work/')).sort();

beforeEach(async () => {
  objects.clear();
  failCopyForEmail = null;
  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

describe('a parallel session whose second working copy cannot be stored', () => {
  it('does not leave an orphaned session, tokens, or the first signer\'s stray working copy behind', async () => {
    const objectPath = await seedGeneralPdf();
    const aliceId = `alice-${crypto.randomBytes(4).toString('hex')}`;
    const bobId = `bob-${crypto.randomBytes(4).toString('hex')}`;
    // Alice's write succeeds; Bob's is the one the storage provider rejects.
    failCopyForEmail = 'bob@example.test';

    const res = await generate({
      objectPath,
      fileName: 'agreement.pdf',
      routingMode: 'parallel',
      signers: [
        { participantId: aliceId, roleLabel: 'Signer 1', name: 'Alice', email: 'alice@example.test' },
        { participantId: bobId, roleLabel: 'Signer 2', name: 'Bob', email: 'bob@example.test' },
      ],
    });

    // The storage fault must actually surface: this is not a "handled and
    // still succeeded" case.
    expect(res.status).toBeGreaterThanOrEqual(500);

    // The real defect: `repo.createSession` already committed a session,
    // two participants and two participant tokens before the working-copy
    // step ran, and nothing rolls that transaction's effects back when the
    // very next step fails. A caller who saw a 500 has no way to know a
    // `pending` session now exists in their firm.
    expect(await sessionRows()).toEqual([]);

    // Alice's working copy DID get written before Bob's write failed. A
    // correct rollback has to notice and remove it too, not just stop the
    // session from lingering - otherwise a real storage object survives with
    // no session left to reference it.
    expect(workingCopyPaths()).toEqual([]);
  });

  it('never leaves participant rows or tokens reachable once the session itself is gone', async () => {
    const objectPath = await seedGeneralPdf();
    const aliceId = `alice-${crypto.randomBytes(4).toString('hex')}`;
    const bobId = `bob-${crypto.randomBytes(4).toString('hex')}`;
    failCopyForEmail = 'bob@example.test';

    await generate({
      objectPath,
      fileName: 'agreement.pdf',
      routingMode: 'parallel',
      signers: [
        { participantId: aliceId, roleLabel: 'Signer 1', name: 'Alice', email: 'alice@example.test' },
        { participantId: bobId, roleLabel: 'Signer 2', name: 'Bob', email: 'bob@example.test' },
      ],
    });

    const { rows: allParticipants } = await testPool.query(
      `select p.id from signature_participants p
         join signature_sessions s on s.id = p.session_id
        where s.law_firm_id = $1`,
      [firm.id],
    );
    expect(allParticipants).toEqual([]);

    const { rows: allTokens } = await testPool.query(
      `select participant_id from signature_participant_tokens where law_firm_id = $1`,
      [firm.id],
    );
    expect(allTokens).toEqual([]);
  });

  it('leaves a clean slate to retry from: a second, unimpaired attempt succeeds fully', async () => {
    const objectPath = await seedGeneralPdf();
    const aliceId = `alice-${crypto.randomBytes(4).toString('hex')}`;
    const bobId = `bob-${crypto.randomBytes(4).toString('hex')}`;
    failCopyForEmail = 'bob@example.test';

    const failedRes = await generate({
      objectPath,
      fileName: 'agreement.pdf',
      routingMode: 'parallel',
      signers: [
        { participantId: aliceId, roleLabel: 'Signer 1', name: 'Alice', email: 'alice@example.test' },
        { participantId: bobId, roleLabel: 'Signer 2', name: 'Bob', email: 'bob@example.test' },
      ],
    });
    expect(failedRes.status).toBeGreaterThanOrEqual(500);

    // Storage recovers; retry with fresh participant identities (the client
    // would generate new ones on a fresh submit).
    failCopyForEmail = null;
    const carolId = `carol-${crypto.randomBytes(4).toString('hex')}`;
    const daveId = `dave-${crypto.randomBytes(4).toString('hex')}`;
    const retryRes = await generate({
      objectPath,
      fileName: 'agreement.pdf',
      routingMode: 'parallel',
      signers: [
        { participantId: carolId, roleLabel: 'Signer 1', name: 'Carol', email: 'carol@example.test' },
        { participantId: daveId, roleLabel: 'Signer 2', name: 'Dave', email: 'dave@example.test' },
      ],
    });

    expect(retryRes.status).toBe(200);
    expect(retryRes.body.sessionToken).toBeTruthy();

    const rows = await sessionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].routing_mode).toBe('parallel');

    const participants = await participantRows(rows[0].token);
    expect(participants).toHaveLength(2);
    for (const participant of participants) {
      expect(participant.working_object_path).toMatch(/\/signing-work\//);
    }
    expect(await tokenRows(rows[0].token)).toHaveLength(2);
    expect(workingCopyPaths()).toHaveLength(2);
  });
});
