/**
 * The data layer under document signing.
 *
 * `signatures.repository.ts` is what every signing surface reads through: the
 * public signing routes, the firm's link-management routes, the portal's
 * "waiting on you" list, the reminder cron and the expiry sweep. Two kinds of
 * question live here and nowhere else, so they are what this file asks.
 *
 * TOKEN RESOLUTION. A signing link is a bearer credential, and four functions
 * decide what a given token still buys: `getSessionByParticipantToken` (may this
 * token sign), `invalidateParticipantToken` (spend it), `getConsumedTokenCompletion`
 * (a spent token may still be told it already signed) and
 * `getParticipantStatusByToken` (a waiting signer's poll). The line between them
 * is `consumed_at`, and getting it wrong in either direction is serious: too
 * loose and a spent single-use link re-authorizes signing, too tight and a
 * signer who reloads their own page is told their document does not exist.
 *
 * TENANT SCOPING. This module talks to Postgres through
 * `privilegedParameterizedQuery`, which is `adminQuery` underneath: DELIBERATELY
 * unscoped, because a signer holds no firm identity and is authorized by an
 * unguessable token instead. So the audited query contexts that refuse a query
 * which lost its `law_firm_id` predicate DO NOT protect this file. Every
 * firm-scoped read here carries the predicate by hand, and a dropped one would
 * run and return another firm's rows rather than throwing. That is why each
 * firm-scoped case below seeds a second firm's session first: without it the
 * assertion is satisfied by a world with nothing to leak.
 *
 * The repository is called directly rather than through a route. These are the
 * queries themselves, and the routes that wrap them are covered in
 * `signatureLinks.test.ts`; going through HTTP would only add a permission gate
 * between the assertion and the SQL it is about.
 *
 * Fixtures are plain SQL. `createSession` is exercised once, on its own, because
 * everything else needs to start from an exact known state rather than from
 * whatever the writer happened to produce.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  ensureUser,
  createPersonClient,
  createOrgClient,
  createPortalUser,
  linkPersonToOrg,
  type Firm,
} from '../support/setupInProcess';
import { sessionIdSql } from '../support/factories';
import { seedSigningSession, seedSigningParticipant } from '../support/signing';
const repo = require('../../src/modules/signatures/signatures.repository');

let firm: Firm;
/** A second firm, seeded in every scoping case so there is something to leak. */
let rival: Firm;

interface SeededSession {
  sessionToken: string;
  participantId: string;
  publicToken: string;
}

interface SeedOptions {
  lawFirmId?: string;
  createdBy?: string;
  status?: string;
  fileName?: string;
  objectPath?: string | null;
  completedAt?: string | null;
  createdAt?: string | null;
  currentSignerOrder?: number | null;
}

interface ParticipantOptions {
  status?: string;
  order?: number;
  name?: string;
  email?: string;
  roleLabel?: string;
  memberUserId?: string | null;
  clientUserId?: string | null;
  consumed?: boolean;
  signerName?: string | null;
}

/** A session row on its own. */
async function seedSessionRow(options: SeedOptions = {}): Promise<string> {
  const sessionToken = `sess-${randomUUID().slice(0, 12)}`;
  const lawFirmId = options.lawFirmId ?? firm.id;
  await ensureUser(options.createdBy ?? 'creator-uid');
  await seedSigningSession({
    lawFirmId,
    createdBy: options.createdBy ?? 'creator-uid',
    token: sessionToken,
    session: {
      status: options.status ?? 'pending',
      file_name: options.fileName ?? 'Engagement Agreement.pdf',
      object_path: options.objectPath === undefined ? `lawfirmids/${lawFirmId}/general/${sessionToken}.pdf` : options.objectPath,
      completed_at: options.completedAt ?? null,
      current_signer_order: options.currentSignerOrder ?? null,
      ...(options.createdAt ? { created_at: options.createdAt } : {}),
    },
  });
  return sessionToken;
}

/**
 * A participant plus its PUBLIC token row.
 *
 * The public token is what a signer holds; the session token is the firm's
 * handle. Seeding both is what makes the token-resolution cases below reach the
 * branch they are about instead of the "no participant" branch. The token row
 * takes its firm from the session, so a session that never landed fails here.
 */
async function seedParticipant(
  sessionToken: string,
  options: ParticipantOptions = {},
): Promise<{ participantId: string; publicToken: string }> {
  await ensureUser(options.memberUserId);
  await ensureUser(options.clientUserId);
  const suffix = randomUUID().slice(0, 12);
  const { participantId, publicToken } = await seedSigningParticipant({ sessionToken }, {
    roleLabel: options.roleLabel ?? 'Signer',
    order: options.order ?? 1,
    name: options.name ?? 'Signer One',
    email: options.email ?? `${suffix}@example.test`,
    status: options.status ?? 'active',
    consumed: options.consumed ?? false,
    columns: {
      member_user_id: options.memberUserId ?? null,
      client_user_id: options.clientUserId ?? null,
      signer_name: options.signerName ?? null,
    },
  }, { index: 0, idSuffix: suffix });
  return { participantId, publicToken };
}

/**
 * The common case: one session, one active participant, one live token.
 *
 * The participant's status is named `participantStatus` rather than sharing
 * `status` with the session: the two columns take different value sets (a
 * session is `in_progress`, a signer is `active`), and the check constraints
 * reject the mix-up rather than storing it.
 */
async function seedSession(
  options: SeedOptions & Omit<ParticipantOptions, 'status'> & { participantStatus?: string } = {},
): Promise<SeededSession> {
  const sessionToken = await seedSessionRow(options);
  const participant = await seedParticipant(sessionToken, {
    ...options,
    status: options.participantStatus ?? 'active',
  });
  return { sessionToken, ...participant };
}

const tokenRow = async (publicToken: string) => {
  const { rows } = await testPool.query(
    `select consumed_at from signature_participant_tokens where token = $1`, [publicToken],
  );
  return rows[0];
};

const currentSignerOrder = async (sessionToken: string) => {
  const { rows } = await testPool.query(
    `select current_signer_order from signature_sessions where token = $1`, [sessionToken],
  );
  return rows[0].current_signer_order;
};

const participantStatuses = async (sessionToken: string) => {
  const { rows } = await testPool.query(
    `select id, status from signature_participants
      where session_id = ${sessionIdSql('$1')} order by signing_order`,
    [sessionToken],
  );
  return rows.map((r: any) => r.status);
};

beforeEach(async () => {
  firm = await createFirm();
  rival = await createFirm();
});

describe('resolving a signer token', () => {
  it('resolves a live token to its session', async () => {
    const seeded = await seedSession({ fileName: 'Retainer.pdf' });

    const session = await repo.getSessionByParticipantToken(seeded.publicToken);

    expect(session.token).toBe(seeded.sessionToken);
    expect(session.fileName).toBe('Retainer.pdf');
  });

  it('attaches the participant graph the signing routes read', async () => {
    const seeded = await seedSession({ roleLabel: 'Client', name: 'Reginald Hollis' });

    const session = await repo.getSessionByParticipantToken(seeded.publicToken);

    // The routes decide whose turn it is, which fields to show and where to
    // stamp them entirely from this array. A session resolved without it would
    // reach the gate with no participant and refuse every real signer.
    expect(session.participants).toHaveLength(1);
    expect(session.participants[0].participantId).toBe(seeded.participantId);
    expect(session.participants[0].publicToken).toBe(seeded.publicToken);
    expect(session.participants[0].roleLabel).toBe('Client');
  });

  it('refuses a token that has already been spent', async () => {
    const seeded = await seedSession({ consumed: true });

    // Single-use is the entire protection on a link that has done its job: a
    // signer who forwards the confirmation email must not hand over the ability
    // to sign again. Verified against the seed, so this is not passing because
    // the row is missing.
    expect((await tokenRow(seeded.publicToken)).consumed_at).not.toBeNull();
    expect(await repo.getSessionByParticipantToken(seeded.publicToken)).toBeNull();
  });

  it('answers nothing for a token nobody issued', async () => {
    expect(await repo.getSessionByParticipantToken('pub-never-issued')).toBeNull();
  });

  it('does not resolve a session token as if it were a signer token', async () => {
    const seeded = await seedSession();

    // The two are different credentials with different lifetimes. Accepting the
    // session token here would give anyone who saw a firm-side URL a link that
    // never expires and is never consumed.
    expect(await repo.getSessionByParticipantToken(seeded.sessionToken)).toBeNull();
  });
});

describe('spending a signer token', () => {
  it('marks the token consumed, reports that it did, and stops the link authorizing', async () => {
    const seeded = await seedSession();

    const stamped = await repo.invalidateParticipantToken(seeded.sessionToken, seeded.participantId);

    expect(stamped).toBe(1);
    expect((await tokenRow(seeded.publicToken)).consumed_at).not.toBeNull();
    // The column being stamped is only the mechanism; this is the property. A
    // stamp the resolve path did not consult would leave the spent link live.
    expect(await repo.getSessionByParticipantToken(seeded.publicToken)).toBeNull();
  });

  it('leaves the NEXT signer\'s link alone', async () => {
    const sessionToken = await seedSessionRow();
    const first = await seedParticipant(sessionToken, { order: 1, status: 'active' });
    const second = await seedParticipant(sessionToken, { order: 2, status: 'waiting' });

    await repo.invalidateParticipantToken(sessionToken, first.participantId);

    // Sequential routing hands the document on. Spending the whole session's
    // tokens when one signer finishes would kill the document mid-execution.
    expect((await tokenRow(second.publicToken)).consumed_at).toBeNull();
    expect(await repo.getSessionByParticipantToken(second.publicToken)).not.toBeNull();
  });

  it('reports zero for a token already spent, and does not re-stamp it', async () => {
    const seeded = await seedSession({ consumed: true });
    const before = (await tokenRow(seeded.publicToken)).consumed_at;

    // The count is how a caller distinguishes "I spent it" from "somebody else
    // already did", which is what makes a double submit safe.
    expect(await repo.invalidateParticipantToken(seeded.sessionToken, seeded.participantId)).toBe(0);
    // The original spend time is part of the audit trail of an executed
    // document; a second call must not move it.
    expect((await tokenRow(seeded.publicToken)).consumed_at).toEqual(before);
  });
});

describe('what a spent token may still be told', () => {
  it('recognises a spent token whose signer completed', async () => {
    const seeded = await seedSession({ status: 'completed', participantStatus: 'completed' });
    await repo.invalidateParticipantToken(seeded.sessionToken, seeded.participantId);

    const answer = await repo.getConsumedTokenCompletion(seeded.publicToken);

    // A signer who reloads their own link after signing should be shown "you are
    // done", not a dead page. This is the one thing a spent token still buys.
    expect(answer).not.toBeNull();
    expect(answer.participantStatus).toBe('completed');
    expect(answer.fileName).toBe('Engagement Agreement.pdf');
  });

  it('says nothing for a token that is still live', async () => {
    const seeded = await seedSession();
    await testPool.query(`update signature_participants set status = 'completed' where id = $1`, [seeded.participantId]);

    // The participant IS completed, so only the consumed check keeps this null.
    // Answering here would tell a holder of an unspent link about a session they
    // have not yet proved they may see.
    expect(await repo.getConsumedTokenCompletion(seeded.publicToken)).toBeNull();
  });

  it('says nothing for a spent token whose signer never completed', async () => {
    const seeded = await seedSession({ consumed: true });
    await testPool.query(`update signature_participants set status = 'declined' where id = $1`, [seeded.participantId]);

    // A token can be spent without its signer completing: they declined, or the
    // session was cancelled underneath them. Reporting completion here would
    // tell a declining signer their signature was collected.
    expect(await repo.getConsumedTokenCompletion(seeded.publicToken)).toBeNull();
  });
});

describe('polling a signer link for status', () => {
  it('reports the progress of a live link', async () => {
    const sessionToken = await seedSessionRow({ status: 'in_progress' });
    const first = await seedParticipant(sessionToken, { order: 1, status: 'completed' });
    const second = await seedParticipant(sessionToken, { order: 2, status: 'active' });
    void first;

    const status = await repo.getParticipantStatusByToken(second.publicToken);

    expect(status.participant_status).toBe('active');
    expect(status.session_status).toBe('in_progress');
    // The counts are what a waiting signer's page renders as "1 of 2 signed".
    expect(Number(status.total)).toBe(2);
    expect(Number(status.completed)).toBe(1);
  });

  it('reports nothing for a spent link', async () => {
    const seeded = await seedSession({ consumed: true });

    // Same consumed rule as the resolve path. The poll answers on every page
    // load, so a spent link that kept answering would keep reporting a session's
    // progress to whoever holds the old URL.
    expect(await repo.getParticipantStatusByToken(seeded.publicToken)).toBeNull();
  });

  it('reports for a spent link whose own signer COMPLETED', async () => {
    const seeded = await seedSession({
      status: 'in_progress', participantStatus: 'completed', consumed: true,
    });

    // Completing a turn consumes the token, and that signer still has to watch
    // the executed document being produced. The exception is exactly this one:
    // the case above proves a token spent WITHOUT completing still answers
    // nothing, so a decline does not become a progress feed.
    const status = await repo.getParticipantStatusByToken(seeded.publicToken);

    expect(status.participant_status).toBe('completed');
    expect(status.session_status).toBe('in_progress');
  });
});

describe('resolving a session token', () => {
  it('returns the session graph with its participants in signing order', async () => {
    const sessionToken = await seedSessionRow();
    await seedParticipant(sessionToken, { order: 2, status: 'waiting', roleLabel: 'Counsel' });
    await seedParticipant(sessionToken, { order: 1, status: 'active', roleLabel: 'Client' });

    const session = await repo.getSessionByToken(sessionToken);

    // Order is what the sequential state machine advances through. Reading the
    // list in insertion order would hand the document to the wrong signer.
    expect(session.participants.map((p: any) => p.roleLabel)).toEqual(['Client', 'Counsel']);
  });

  it('carries the owning firm so a caller can compare it', async () => {
    const seeded = await seedSession({ lawFirmId: rival.id });

    const session = await repo.getSessionByToken(seeded.sessionToken);

    // This read is deliberately NOT firm-scoped: a signer holds no firm
    // identity, and the session token is the credential. The firm-side routes
    // therefore have to compare `session.lawFirmId` against the firm in the URL
    // themselves, which they can only do if the field survives the mapping.
    expect(session.lawFirmId).toBe(rival.id);
  });

  it('answers nothing for a token nobody issued', async () => {
    expect(await repo.getSessionByToken('sess-never-issued')).toBeNull();
  });
});

describe('the firm signing history', () => {
  it('returns this firm\'s sessions and not another firm\'s', async () => {
    const mine = await seedSession({ fileName: 'Mine.pdf' });
    await seedSession({ lawFirmId: rival.id, fileName: 'Theirs.pdf' });

    const { sessions, totalItems } = await repo.listForFirmPaged(firm.id);

    expect(sessions.map((s: any) => s.token)).toEqual([mine.sessionToken]);
    expect(totalItems).toBe(1);
  });

  it('orders by most recent activity, signed date first', async () => {
    const old = await seedSession({ createdAt: '2026-01-01T00:00:00Z' });
    const recent = await seedSession({ createdAt: '2026-06-01T00:00:00Z' });
    // Created first of the three, completed last: activity order, not creation
    // order, is what the history page presents.
    const signed = await seedSession({
      createdAt: '2025-01-01T00:00:00Z',
      status: 'completed',
      completedAt: '2026-08-01T00:00:00Z',
      participantStatus: 'completed',
    });

    const { sessions } = await repo.listForFirmPaged(firm.id);

    expect(sessions.map((s: any) => s.token))
      .toEqual([signed.sessionToken, recent.sessionToken, old.sessionToken]);
  });

  it('counts the whole matching set while returning one page', async () => {
    await seedSession();
    await seedSession();
    await seedSession();

    const { sessions, totalItems } = await repo.listForFirmPaged(firm.id, { limit: 2 });

    // The count is taken over the filter, not the window. A count of the page
    // would make every page after the first unreachable.
    expect(sessions).toHaveLength(2);
    expect(totalItems).toBe(3);
  });

  it('counts only this firm even when another firm has more sessions', async () => {
    await seedSession();
    await seedSession({ lawFirmId: rival.id });
    await seedSession({ lawFirmId: rival.id });

    // The count runs as its own query with its own copy of the WHERE clause, so
    // it can lose the firm predicate independently of the page above it.
    expect((await repo.listForFirmPaged(firm.id)).totalItems).toBe(1);
  });

  it('hides a cancelled session nobody ever signed', async () => {
    await seedSession({ status: 'cancelled' });
    const live = await seedSession();

    const { sessions } = await repo.listForFirmPaged(firm.id);

    // A request withdrawn before anyone signed is noise, not a record. Filtered
    // in SQL rather than in the route so the count beside the page agrees with
    // what the page holds.
    expect(sessions.map((s: any) => s.token)).toEqual([live.sessionToken]);
  });

  it('keeps a cancelled session somebody DID sign', async () => {
    const partly = await seedSession({ status: 'cancelled' });
    await testPool.query(`update signature_participants set status = 'completed' where id = $1`, [partly.participantId]);

    // The boundary from below. A document one party executed before the request
    // was withdrawn is a record of a real signature and must stay visible.
    const { sessions } = await repo.listForFirmPaged(firm.id);
    expect(sessions.map((s: any) => s.token)).toEqual([partly.sessionToken]);
  });

  it('hides an unsigned pending session whose document was already executed', async () => {
    const objectPath = `lawfirmids/${firm.id}/general/Retainer.pdf`;
    const superseded = await seedSession({ objectPath, status: 'pending' });
    const executed = await seedSession({ objectPath, status: 'completed' });
    await testPool.query(`update signature_participants set status = 'completed' where session_id = ${sessionIdSql('$1')}`, [executed.sessionToken]);

    const { sessions } = await repo.listForFirmPaged(firm.id);

    // Two sends of the same file where one came back signed: the abandoned one
    // is noise. Note that hiding it from the history is NOT revocation, its
    // signer link stays live until the session expires.
    expect(sessions.map((s: any) => s.token)).toEqual([executed.sessionToken]);
    expect(superseded.sessionToken).not.toBe(executed.sessionToken);
  });

  it('narrows to a single status', async () => {
    const pending = await seedSession({ status: 'pending' });
    const done = await seedSession({ status: 'completed' });
    await testPool.query(`update signature_participants set status = 'completed' where session_id = ${sessionIdSql('$1')}`, [done.sessionToken]);

    const { sessions, totalItems } = await repo.listForFirmPaged(firm.id, { status: 'pending' });

    expect(sessions.map((s: any) => s.token)).toEqual([pending.sessionToken]);
    expect(totalItems).toBe(1);
  });

  it('treats not_completed as everything still outstanding', async () => {
    const pending = await seedSession({ status: 'pending' });
    const expired = await seedSession({ status: 'expired' });
    const done = await seedSession({ status: 'completed' });
    await testPool.query(`update signature_participants set status = 'completed' where session_id = ${sessionIdSql('$1')}`, [done.sessionToken]);

    const { sessions } = await repo.listForFirmPaged(firm.id, { status: 'not_completed' });

    // A synthetic filter spanning several real statuses, so it cannot be served
    // by the equality branch beside it.
    expect(sessions.map((s: any) => s.token).sort())
      .toEqual([expired.sessionToken, pending.sessionToken].sort());
  });

  it('searches the file name', async () => {
    const wanted = await seedSession({ fileName: 'Settlement Agreement.pdf' });
    await seedSession({ fileName: 'Retainer.pdf' });

    const { sessions } = await repo.listForFirmPaged(firm.id, { search: 'Settlement' });

    expect(sessions.map((s: any) => s.token)).toEqual([wanted.sessionToken]);
  });

  it('searches the participant rows, not only the session columns', async () => {
    const wanted = await seedSession({ email: 'reginald@counterparty.test' });
    await seedSession({ email: 'somebody@else.test' });

    const { sessions } = await repo.listForFirmPaged(firm.id, { search: 'counterparty' });

    // On a multi-signer document the session carries no single signer, so a
    // search that only read the session's own columns could not find a document
    // by the person it was sent to.
    expect(sessions.map((s: any) => s.token)).toEqual([wanted.sessionToken]);
  });

  it('does not reach into another firm while searching', async () => {
    await seedSession({ lawFirmId: rival.id, fileName: 'Settlement Agreement.pdf' });

    // The firm predicate and the search predicate are separate clauses, so the
    // scoping needs its own case under search rather than being inherited from
    // the unfiltered one.
    expect((await repo.listForFirmPaged(firm.id, { search: 'Settlement' })).sessions).toEqual([]);
  });
});

describe('the status summary beside the history', () => {
  it('counts each status for this firm only', async () => {
    await seedSession({ status: 'pending' });
    await seedSession({ status: 'pending' });
    const done = await seedSession({ status: 'completed' });
    await testPool.query(`update signature_participants set status = 'completed' where session_id = ${sessionIdSql('$1')}`, [done.sessionToken]);
    await seedSession({ lawFirmId: rival.id, status: 'pending' });

    expect(await repo.countByStatusForFirm(firm.id)).toEqual({ pending: 2, completed: 1 });
  });

  it('describes exactly the set the list returns', async () => {
    // A cancelled session nobody signed, which the list hides. The summary
    // labels the list's own filters, so a count including a session the list
    // will never show would advertise a filter that comes back empty.
    await seedSession({ status: 'cancelled' });
    await seedSession({ status: 'pending' });

    const counts = await repo.countByStatusForFirm(firm.id);
    const { totalItems } = await repo.listForFirmPaged(firm.id);

    expect(counts).toEqual({ pending: 1 });
    expect(Object.values(counts).reduce((sum: any, n: any) => sum + n, 0)).toBe(totalItems);
  });
});

describe('what one firm user has open', () => {
  it('returns a session whose active signer is that user', async () => {
    const seeded = await seedSession({ memberUserId: 'member-uid', createdBy: 'someone-else' });

    const sessions = await repo.listPendingOrInProgressForUser(firm.id, 'member-uid');

    expect(sessions.map((s: any) => s.token)).toEqual([seeded.sessionToken]);
  });

  it('leaves out a session where that user is only WAITING their turn', async () => {
    const sessionToken = await seedSessionRow();
    await seedParticipant(sessionToken, { order: 1, status: 'active' });
    await seedParticipant(sessionToken, { order: 2, status: 'waiting', memberUserId: 'member-uid' });

    // The list is "needs your signature now". A waiting slot cannot be acted on,
    // so surfacing it would send the user to a page that refuses them.
    expect(await repo.listPendingOrInProgressForUser(firm.id, 'member-uid')).toEqual([]);
  });

  it('leaves out another firm\'s session for the same user', async () => {
    await seedSession({ lawFirmId: rival.id, memberUserId: 'member-uid', createdBy: 'member-uid' });

    // The same person can be a member of two firms. Only the firm predicate
    // keeps one firm's document off the other firm's dashboard.
    expect(await repo.listPendingOrInProgressForUser(firm.id, 'member-uid', { includeCreatedBy: true })).toEqual([]);
  });

  it('adds sessions the user sent only when asked', async () => {
    const sent = await seedSession({ createdBy: 'member-uid', memberUserId: null });

    const without = await repo.listPendingOrInProgressForUser(firm.id, 'member-uid');
    const withCreated = await repo.listPendingOrInProgressForUser(firm.id, 'member-uid', { includeCreatedBy: true });

    // Two callers with different questions read this: "what needs me" and "what
    // did I send". Folding the second into the first would put every request a
    // partner sent into their own to-sign queue.
    expect(without).toEqual([]);
    expect(withCreated.map((s: any) => s.token)).toEqual([sent.sessionToken]);
  });

  it('leaves out a session that is already finished', async () => {
    await seedSession({ status: 'completed', createdBy: 'member-uid', memberUserId: 'member-uid' });

    expect(await repo.listPendingOrInProgressForUser(firm.id, 'member-uid', { includeCreatedBy: true })).toEqual([]);
  });

});

describe('who a signing request may be addressed to', () => {
  it('lists this firm\'s portal clients and not another firm\'s', async () => {
    const mine = await createPortalUser();
    await createPersonClient(firm.id, { name: 'Reginald Hollis', userId: mine.uid, email: 'reg@example.test' });
    const theirs = await createPortalUser();
    await createPersonClient(rival.id, { name: 'Outside Person', userId: theirs.uid });

    const { items } = await repo.listSigningRecipients(firm.id);

    expect(items.map((i: any) => i.name)).toEqual(['Reginald Hollis']);
    expect(items[0].userId).toBe(mine.uid);
  });

  it('leaves out a client with no portal login', async () => {
    await createPersonClient(firm.id, { name: 'No Account', userId: null });
    const withLogin = await createPortalUser();
    await createPersonClient(firm.id, { name: 'Has Account', userId: withLogin.uid });

    // The list exists to answer "who can I address an account-backed request
    // to". Someone with no login cannot receive one, and the firm has plain
    // email delivery for them instead.
    const { items } = await repo.listSigningRecipients(firm.id);
    expect(items.map((i: any) => i.name)).toEqual(['Has Account']);
  });

  it('leaves out an archived client', async () => {
    const archived = await createPortalUser();
    const client = await createPersonClient(firm.id, { name: 'Former Client', userId: archived.uid });
    await testPool.query(`update clients set status = 'archived' where id = $1`, [client.id]);

    expect((await repo.listSigningRecipients(firm.id)).items).toEqual([]);
  });

  it('annotates a person with the organization they sign for', async () => {
    const person = await createPortalUser();
    const personClient = await createPersonClient(firm.id, { name: 'Dana Reyes', userId: person.uid });
    const org = await createOrgClient(firm.id, { name: 'Denton Holdings' });
    const link = await linkPersonToOrg(firm.id, personClient.id, org.id, { canViewBilling: false });

    const { items } = await repo.listSigningRecipients(firm.id);

    // The picker shows "Dana Reyes - Denton Holdings" so the sender can tell
    // which capacity they are signing in. The link id is what pins the exact
    // relationship when a person represents more than one organization.
    expect(items).toHaveLength(1);
    expect(items[0].companyName).toBe('Denton Holdings');
    expect(items[0].companyLinkId).toBe(link.id);
  });

  it('never lists an organization itself', async () => {
    await createOrgClient(firm.id, { name: 'Denton Holdings' });

    // An organization holds no portal login of its own; its people do. A row for
    // the organization would be a recipient nothing could be delivered to.
    expect((await repo.listSigningRecipients(firm.id)).items).toEqual([]);
  });

  it('narrows to an organization\'s people when given the organization\'s id', async () => {
    const inside = await createPortalUser();
    const insideClient = await createPersonClient(firm.id, { name: 'Dana Reyes', userId: inside.uid });
    const org = await createOrgClient(firm.id, { name: 'Denton Holdings' });
    await linkPersonToOrg(firm.id, insideClient.id, org.id, { canViewBilling: false });
    const outside = await createPortalUser();
    await createPersonClient(firm.id, { name: 'Unrelated Person', userId: outside.uid });

    const { items } = await repo.listSigningRecipients(firm.id, { clientId: org.id });

    // Narrowing by the organization's own id has to resolve through the links,
    // because the organization is not a row here at all. Matching only the
    // client's own id would answer nothing from an organization's context.
    expect(items.map((i: any) => i.name)).toEqual(['Dana Reyes']);
  });

  it('answers nothing for a clientId that is not a uuid', async () => {
    const person = await createPortalUser();
    await createPersonClient(firm.id, { name: 'Dana Reyes', userId: person.uid });

    // `client_row_id` is a uuid column, so a malformed value would reach
    // Postgres as a cast error and surface as a 500 rather than an empty picker.
    expect((await repo.listSigningRecipients(firm.id, { clientId: 'not-a-uuid' })).items).toEqual([]);
  });

  it('searches by name', async () => {
    const wanted = await createPortalUser();
    await createPersonClient(firm.id, { name: 'Reginald Hollis', userId: wanted.uid });
    const other = await createPortalUser();
    await createPersonClient(firm.id, { name: 'Dana Reyes', userId: other.uid });

    const { items } = await repo.listSigningRecipients(firm.id, { search: 'Hollis' });

    expect(items.map((i: any) => i.name)).toEqual(['Reginald Hollis']);
  });

  it('treats a percent sign in the search as a literal character', async () => {
    const literal = await createPortalUser();
    await createPersonClient(firm.id, { name: '100% Holdings LLC', userId: literal.uid });
    const other = await createPortalUser();
    await createPersonClient(firm.id, { name: 'Dana Reyes', userId: other.uid });

    const { items } = await repo.listSigningRecipients(firm.id, { search: '100%' });

    // The term goes through `toIlikeTerm`, which escapes the LIKE
    // metacharacters. A term built by hand instead would turn a percent sign the
    // user typed into a wildcard, and the picker would offer every portal client
    // in the firm as a recipient for the document.
    expect(items.map((i: any) => i.name)).toEqual(['100% Holdings LLC']);
  });

  it('reports that more remain beyond the requested limit', async () => {
    for (const name of ['Aaron A', 'Bella B', 'Carl C']) {
      // eslint-disable-next-line no-await-in-loop
      const user = await createPortalUser();
      // eslint-disable-next-line no-await-in-loop
      await createPersonClient(firm.id, { name, userId: user.uid });
    }

    const { items, hasMore } = await repo.listSigningRecipients(firm.id, { limit: 2 });

    // The picker uses this to decide whether to prompt for a search instead of
    // silently showing a truncated roster.
    expect(items.map((i: any) => i.name)).toEqual(['Aaron A', 'Bella B']);
    expect(hasMore).toBe(true);
  });
});

describe('a portal client\'s open signing work', () => {
  it('returns the participant slots a client holds in multi-signer sessions', async () => {
    const seeded = await seedSession({ clientUserId: 'client-uid', status: 'in_progress' });

    const slots = await repo.listOpenParticipantSessionsForClient(firm.id, 'client-uid');

    // A client is bound on their participant row, so a
    // client bound as one signer among several is invisible to the lookup above.
    // Left unhandled, deleting that client leaves their signing link live.
    expect(slots).toEqual([{ token: seeded.sessionToken, participantId: seeded.participantId }]);
  });

  it('does not return another firm\'s participant slot for that client', async () => {
    await seedSession({ lawFirmId: rival.id, clientUserId: 'client-uid', status: 'in_progress' });

    expect(await repo.listOpenParticipantSessionsForClient(firm.id, 'client-uid')).toEqual([]);
  });

  it('does not return a slot the client has already dealt with', async () => {
    const seeded = await seedSession({ clientUserId: 'client-uid', status: 'in_progress' });
    await testPool.query(`update signature_participants set status = 'completed' where id = $1`, [seeded.participantId]);

    expect(await repo.listOpenParticipantSessionsForClient(firm.id, 'client-uid')).toEqual([]);
  });
});

describe('documents waiting on one portal client', () => {
  it('returns the document waiting on that client with its live link', async () => {
    const seeded = await seedSession({ clientUserId: 'client-uid', fileName: 'Retainer.pdf' });

    const { rows, totalItems } = await repo.findPendingDocumentsForClient('client-uid');

    expect(totalItems).toBe(1);
    expect(rows[0].file_name).toBe('Retainer.pdf');
    // The client's own signing link, so the portal can send them straight in.
    expect(rows[0].public_token).toBe(seeded.publicToken);
  });

  it('narrows to one firm when a firm is named', async () => {
    const mine = await seedSession({ clientUserId: 'client-uid' });
    await seedSession({ lawFirmId: rival.id, clientUserId: 'client-uid' });

    const { rows } = await repo.findPendingDocumentsForClient('client-uid', { lawFirmId: firm.id });

    // A client can sign for several firms. The firm's own portal page must show
    // only its own documents, and the filter is what keeps a second firm's
    // pending agreement off it.
    expect(rows.map((r: any) => r.session_token)).toEqual([mine.sessionToken]);
  });

  it('reports the single firm only when every waiting document is that firm\'s', async () => {
    await seedSession({ clientUserId: 'client-uid' });
    const single = await repo.findPendingDocumentsForClient('client-uid');
    await seedSession({ lawFirmId: rival.id, clientUserId: 'client-uid' });
    const spread = await repo.findPendingDocumentsForClient('client-uid');

    // The dashboard links straight to one firm's signing list only when that
    // list would hold everything waiting. Resolved over the whole matching set,
    // because the page on screen cannot answer it.
    expect(single.singleLawFirmId).toBe(firm.id);
    expect(spread.singleLawFirmId).toBeNull();
  });

  it('does not return a document waiting on somebody else', async () => {
    await seedSession({ clientUserId: 'another-client-uid' });

    expect((await repo.findPendingDocumentsForClient('client-uid')).rows).toEqual([]);
  });
});

describe('cancelling a session', () => {
  it('cancels the session and every signer still outstanding', async () => {
    const sessionToken = await seedSessionRow({ status: 'in_progress', currentSignerOrder: 1 });
    await seedParticipant(sessionToken, { order: 1, status: 'active' });
    await seedParticipant(sessionToken, { order: 2, status: 'waiting' });
    // An open session points at whoever's turn it is. Seeded explicitly, because
    // the clearing assertion below is vacuous against a session that was already
    // pointing at nobody.
    expect(await currentSignerOrder(sessionToken)).toBe(1);

    await repo.cancelSession(sessionToken);

    const { rows } = await testPool.query(
      `select status, current_signer_order from signature_sessions where token = $1`, [sessionToken],
    );
    expect(rows[0].status).toBe('cancelled');
    // Cleared so the sequential state machine cannot advance a dead session.
    expect(rows[0].current_signer_order).toBeNull();
    expect(await participantStatuses(sessionToken)).toEqual(['cancelled', 'cancelled']);
  });

  it('leaves a signature that was already collected alone', async () => {
    const sessionToken = await seedSessionRow({ status: 'in_progress' });
    await seedParticipant(sessionToken, { order: 1, status: 'completed' });
    await seedParticipant(sessionToken, { order: 2, status: 'active' });

    await repo.cancelSession(sessionToken);

    // Cancelling withdraws the outstanding request; it does not un-sign a party
    // who already executed the document. Overwriting that status would erase the
    // record of a signature that was genuinely given.
    expect(await participantStatuses(sessionToken)).toEqual(['completed', 'cancelled']);
  });

  it('does not touch another session', async () => {
    const target = await seedSession();
    const bystander = await seedSession();

    await repo.cancelSession(target.sessionToken);

    expect(await participantStatuses(bystander.sessionToken)).toEqual(['active']);
  });
});

describe('updating one signer', () => {
  it('writes only the fields it was given', async () => {
    const seeded = await seedSession();
    const sentAt = new Date('2026-08-01T12:00:00Z').toISOString();

    await repo.updateParticipant(seeded.sessionToken, seeded.participantId, {
      lastReminderSentAt: sentAt, reminderCount: 3,
    });

    const { rows } = await testPool.query(
      `select p.status, p.role_label,
              coalesce(r.sent_count, 0) as reminder_count,
              r.last_sent_at            as last_reminder_sent_at
         from signature_participants p
         left join reminders r on r.signature_participant_id = p.id
        where p.id = $1`,
      [seeded.participantId],
    );
    expect(rows[0].reminder_count).toBe(3);
    expect(new Date(rows[0].last_reminder_sent_at).toISOString()).toBe(sentAt);
    // The targeted update exists so a reminder does not rewrite the whole
    // participant row. Blanking the status or the role would break the routing.
    expect(rows[0].status).toBe('active');
    expect(rows[0].role_label).toBe('Signer');
  });

  it('does not touch a different signer in the same session', async () => {
    const sessionToken = await seedSessionRow();
    const first = await seedParticipant(sessionToken, { order: 1, status: 'active' });
    const second = await seedParticipant(sessionToken, { order: 2, status: 'waiting' });

    await repo.updateParticipant(sessionToken, first.participantId, { reminderCount: 3 });

    const { rows } = await testPool.query(
      `select coalesce(r.sent_count, 0) as reminder_count
         from signature_participants p
         left join reminders r on r.signature_participant_id = p.id
        where p.id = $1`, [second.participantId],
    );
    expect(rows[0].reminder_count).toBe(0);
  });

  it('does not touch a same-named signer in a different session', async () => {
    const seeded = await seedSession();
    const otherSession = await seedSessionRow();
    const other = await seedParticipant(otherSession, {});

    await repo.updateParticipant(otherSession, seeded.participantId, { reminderCount: 9 });

    // Both the session token and the participant id are in the WHERE clause. A
    // participant id alone would be enough here because ids are unique, which is
    // exactly why this case asserts the write did NOT land: the pairing is what
    // stops one session's update reaching into another's row.
    const { rows } = await testPool.query(
      `select coalesce(r.sent_count, 0) as reminder_count
         from signature_participants p
         left join reminders r on r.signature_participant_id = p.id
        where p.id = $1`, [seeded.participantId],
    );
    expect(rows[0].reminder_count).toBe(0);
    expect(other.participantId).not.toBe(seeded.participantId);
  });
});
