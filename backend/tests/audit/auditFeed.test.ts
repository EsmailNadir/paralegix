/**
 * The firm audit feed: `GET /api/lawfirms/:lawFirmId/audit-events`.
 *
 * The log exists to answer "who did what, in this firm". Both halves of that
 * sentence are load-bearing and neither was covered. If the read loses its
 * tenant scope the log becomes a cross-firm disclosure channel that is worse
 * than the data it protects: it names other firms' users, their IP addresses and
 * the paths they visited. If the filters do not filter, an investigator paging
 * a real firm's log reads the wrong events and concludes the wrong thing.
 *
 * Events for TWO firms are seeded in every scoping case. Seeding one firm only
 * would let an unscoped read pass: with nothing else in the table, "everything"
 * and "this firm's events" are the same list.
 *
 * Rows go in with SQL. The table has an append-only trigger and the writer is a
 * fire-and-forget call from `res.on('finish')`, so building fixtures through the
 * middleware would make the arrangement of a test a race. One case at the end
 * deliberately does go through the middleware, because "the feed shows real
 * mutations" is not something seeded rows can prove.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let otherFirm: Firm;
let otherOwner: Actor;

const A = (lawFirmId: string) => `/api/lawfirms/${lawFirmId}/audit-events`;

interface EventOptions {
  lawFirmId?: string | null;
  actorUid?: string | null;
  actorEmail?: string | null;
  action?: string;
  method?: string | null;
  path?: string | null;
  statusCode?: number | null;
  ip?: string | null;
  createdAt?: string;
}

async function seedEvent(options: EventOptions = {}) {
  const id = randomUUID();
  await testPool.query(
    `insert into audit_events
       (id, law_firm_id, actor_uid, actor_email, action, method, path, status_code, ip, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10::timestamptz, now()))`,
    [
      id,
      options.lawFirmId ?? null,
      options.actorUid ?? null,
      options.actorEmail ?? null,
      options.action ?? 'POST /api/lawfirms/:id/matters',
      options.method ?? 'POST',
      options.path ?? '/api/lawfirms/x/matters',
      options.statusCode ?? 201,
      options.ip ?? '203.0.113.7',
      options.createdAt ?? null,
    ],
  );
  return { id };
}

/**
 * Settle the fire-and-forget audit write the global middleware starts from
 * `res.on('finish')`. Supertest can resolve a tick before that handler runs, so
 * the setImmediate turn comes first and the drain is repeated after it.
 */
async function settleAuditWrites() {
  const { drainAuditWrites } = require('../../src/modules/audit/audit.service');
  await drainAuditWrites();
  await new Promise((resolve) => setImmediate(resolve));
  await drainAuditWrites();
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  otherFirm = await createFirm();
  otherOwner = await ownerOf(otherFirm.id);
});

describe('what the feed shows', () => {
  it('returns the caller firm events and NOT another firm events', async () => {
    await seedEvent({ lawFirmId: firm.id, action: 'POST /api/lawfirms/:id/matters' });
    await seedEvent({
      lawFirmId: otherFirm.id,
      action: 'DELETE /api/lawfirms/:id/clients/:id',
      actorEmail: 'partner@otherfirm.test',
      ip: '198.51.100.4',
    });

    const res = await owner.api.get(A(firm.id));

    expect(res.status).toBe(200);
    expect(res.body.items.map((row: any) => row.action))
      .toEqual(['POST /api/lawfirms/:id/matters']);
    expect(res.body.totalItems).toBe(1);
    // Named explicitly: the leak this route would produce is other firms' people
    // and addresses, not just a row count.
    expect(JSON.stringify(res.body)).not.toContain('partner@otherfirm.test');
    expect(JSON.stringify(res.body)).not.toContain('198.51.100.4');
  });

  it('hides an unscoped event from every firm', async () => {
    // `law_firm_id` is nullable and the middleware writes null for traffic it
    // cannot attribute to a firm. A read that treated null as "matches" would
    // put platform-level events in every tenant's log.
    await seedEvent({ lawFirmId: null, actorUid: 'platform-robot', action: 'POST /api/admin/sweep' });
    await seedEvent({ lawFirmId: firm.id, action: 'POST /api/lawfirms/:id/matters' });

    const res = await owner.api.get(A(firm.id));

    expect(res.body.items.map((row: any) => row.action))
      .toEqual(['POST /api/lawfirms/:id/matters']);
    expect(res.body.totalItems).toBe(1);
  });

  it('returns the newest event first', async () => {
    await seedEvent({ lawFirmId: firm.id, action: 'OLDEST', createdAt: '2026-01-01T00:00:00Z' });
    await seedEvent({ lawFirmId: firm.id, action: 'NEWEST', createdAt: '2026-03-01T00:00:00Z' });
    await seedEvent({ lawFirmId: firm.id, action: 'MIDDLE', createdAt: '2026-02-01T00:00:00Z' });

    const res = await owner.api.get(A(firm.id));

    // The log is read from the top. Ordered the other way, the first page of a
    // firm with any history at all shows its oldest events forever.
    expect(res.body.items.map((row: any) => row.action)).toEqual(['NEWEST', 'MIDDLE', 'OLDEST']);
  });

  it('carries the fields an investigator reads', async () => {
    await seedEvent({
      lawFirmId: firm.id,
      actorUid: owner.uid,
      actorEmail: 'partner@firm.test',
      action: 'DELETE /api/lawfirms/:id/clients/:id',
      method: 'DELETE',
      path: '/api/lawfirms/abc/clients/def',
      statusCode: 403,
      ip: '203.0.113.7',
    });

    const res = await owner.api.get(A(firm.id));

    expect(res.body.items[0]).toMatchObject({
      actorUid: owner.uid,
      actorEmail: 'partner@firm.test',
      action: 'DELETE /api/lawfirms/:id/clients/:id',
      method: 'DELETE',
      path: '/api/lawfirms/abc/clients/def',
      statusCode: 403,
      ip: '203.0.113.7',
    });
    // A timestamptz reaches the client as an ISO string, never a Date or a
    // Postgres literal: the log's whole value is the ordering of its rows in
    // time, and the frontend parses this.
    expect(res.body.items[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('filtering the feed', () => {
  it('filters by action and counts only the matches', async () => {
    await seedEvent({ lawFirmId: firm.id, action: 'POST /api/lawfirms/:id/matters' });
    await seedEvent({ lawFirmId: firm.id, action: 'DELETE /api/lawfirms/:id/clients/:id' });
    await seedEvent({ lawFirmId: firm.id, action: 'DELETE /api/lawfirms/:id/clients/:id' });

    const res = await owner.api.get(A(firm.id)).query({ action: 'DELETE /api/lawfirms/:id/clients/:id' });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items.every((row: any) => row.action.startsWith('DELETE'))).toBe(true);
    // The count must describe the FILTERED set. Report the unfiltered total and
    // the pager offers pages that come back empty.
    expect(res.body.totalItems).toBe(2);
  });

  it('matches the action exactly rather than by prefix', async () => {
    await seedEvent({ lawFirmId: firm.id, action: 'POST /api/lawfirms/:id/matters' });
    await seedEvent({ lawFirmId: firm.id, action: 'POST /api/lawfirms/:id/matters/:id/notes' });

    const res = await owner.api.get(A(firm.id)).query({ action: 'POST /api/lawfirms/:id/matters' });

    expect(res.body.items.map((row: any) => row.action))
      .toEqual(['POST /api/lawfirms/:id/matters']);
  });

  it('filters by actor', async () => {
    await seedEvent({ lawFirmId: firm.id, actorUid: 'user-alice', action: 'ALICE ACTION' });
    await seedEvent({ lawFirmId: firm.id, actorUid: 'user-bob', action: 'BOB ACTION' });

    const res = await owner.api.get(A(firm.id)).query({ actorUid: 'user-alice' });

    // "What did this person do" is the question the log is opened for.
    expect(res.body.items.map((row: any) => row.action)).toEqual(['ALICE ACTION']);
    expect(res.body.totalItems).toBe(1);
  });

  it('applies the action and actor filters together, not either one', async () => {
    await seedEvent({ lawFirmId: firm.id, actorUid: 'user-alice', action: 'DELETE' });
    await seedEvent({ lawFirmId: firm.id, actorUid: 'user-alice', action: 'CREATE' });
    await seedEvent({ lawFirmId: firm.id, actorUid: 'user-bob', action: 'DELETE' });

    const res = await owner.api.get(A(firm.id)).query({ actorUid: 'user-alice', action: 'DELETE' });

    expect(res.body.totalItems).toBe(1);
    expect(res.body.items[0]).toMatchObject({ actorUid: 'user-alice', action: 'DELETE' });
  });

  it('keeps the tenant scope while a filter is applied', async () => {
    await seedEvent({ lawFirmId: otherFirm.id, actorUid: 'user-alice', action: 'DELETE' });
    await seedEvent({ lawFirmId: firm.id, actorUid: 'user-alice', action: 'CREATE' });

    const res = await owner.api.get(A(firm.id)).query({ actorUid: 'user-alice' });

    // The filter is combined with the scope, not substituted for it. Both firms
    // have an event by this actor, so an `and` that became an `or` shows here.
    expect(res.body.items.map((row: any) => row.action)).toEqual(['CREATE']);
    expect(res.body.totalItems).toBe(1);
  });
});

describe('paging the feed', () => {
  const seedThree = async () => {
    await seedEvent({ lawFirmId: firm.id, action: 'FIRST', createdAt: '2026-03-01T00:00:00Z' });
    await seedEvent({ lawFirmId: firm.id, action: 'SECOND', createdAt: '2026-02-01T00:00:00Z' });
    await seedEvent({ lawFirmId: firm.id, action: 'THIRD', createdAt: '2026-01-01T00:00:00Z' });
  };

  it('honours limit and reports the unpaged total', async () => {
    await seedThree();

    const res = await owner.api.get(A(firm.id)).query({ limit: 2 });

    expect(res.body.items.map((row: any) => row.action)).toEqual(['FIRST', 'SECOND']);
    // The total is what tells the pager there is a second page at all.
    expect(res.body.totalItems).toBe(3);
  });

  it('honours offset', async () => {
    await seedThree();

    const res = await owner.api.get(A(firm.id)).query({ limit: 2, offset: 2 });

    expect(res.body.items.map((row: any) => row.action)).toEqual(['THIRD']);
    expect(res.body.totalItems).toBe(3);
  });

  it('returns an empty page past the end without losing the total', async () => {
    await seedThree();

    const res = await owner.api.get(A(firm.id)).query({ limit: 2, offset: 50 });

    expect(res.body.items).toEqual([]);
    // The count query is separate from the page query for exactly this case: an
    // empty page must still say how many matches exist so the pager can clamp
    // back into range instead of rendering "no events" for a firm with history.
    expect(res.body.totalItems).toBe(3);
  });

  it('refuses a limit above the ceiling', async () => {
    await seedEvent({ lawFirmId: firm.id });

    const res = await owner.api.get(A(firm.id)).query({ limit: 201 });

    // The bound is what stops one request from materialising a firm's whole
    // history into JSON. Rejected at the schema rather than silently clamped, so
    // a caller asking for too much learns it did.
    expect(res.status).toBe(400);
  });

  it('refuses a limit of zero', async () => {
    const res = await owner.api.get(A(firm.id)).query({ limit: 0 });

    expect(res.status).toBe(400);
  });

  it('refuses a negative offset', async () => {
    const res = await owner.api.get(A(firm.id)).query({ offset: -1 });

    expect(res.status).toBe(400);
  });

  it('refuses an offset past the depth ceiling', async () => {
    const res = await owner.api.get(A(firm.id)).query({ offset: 1_000_001 });

    // A deep offset costs a full scan that is thrown away, plus the fallback
    // count on the empty page it returns. `?offset=99999999` is two full scans
    // for nothing.
    expect(res.status).toBe(400);
  });

  it('refuses a non-numeric limit', async () => {
    const res = await owner.api.get(A(firm.id)).query({ limit: 'lots' });

    expect(res.status).toBe(400);
  });
});

describe('who may read the feed', () => {
  it('refuses a member without firm.viewAuditLog', async () => {
    await seedEvent({
      lawFirmId: firm.id,
      actorEmail: 'partner@firm.test',
      action: 'DELETE /api/lawfirms/:id/clients/:id',
    });
    // A broadly permissioned role that simply lacks the audit code. The events
    // above exist, so the refusal below is the gate and not an empty log.
    const manager = await memberWith(firm.id, [
      'clients.manage', 'matters.update', 'members.manage',
    ]);

    const res = await manager.api.get(A(firm.id));

    // `firm.viewAuditLog` is deliberately outside DEFAULT_PERMISSIONS: the log
    // records what every colleague did, including their IP addresses, so it is
    // firm administration rather than a baseline read.
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('partner@firm.test');
  });

  it('admits a member holding exactly firm.viewAuditLog', async () => {
    await seedEvent({ lawFirmId: firm.id, action: 'POST /api/lawfirms/:id/matters' });
    const auditor = await memberWith(firm.id, ['firm.viewAuditLog']);

    const res = await auditor.api.get(A(firm.id));

    // The other half. A gate that refused everyone would satisfy the case above
    // on its own while locking the compliance role out of the only screen it
    // exists for.
    expect(res.status).toBe(200);
    expect(res.body.items.map((row: any) => row.action))
      .toEqual(['POST /api/lawfirms/:id/matters']);
  });

  it('refuses a member of another firm asking under this firm', async () => {
    await seedEvent({ lawFirmId: firm.id, actorEmail: 'partner@firm.test' });

    const res = await otherOwner.api.get(A(firm.id));

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('partner@firm.test');
  });
});

describe('what actually reaches the feed', () => {
  it('records a real mutation, attributed to the person who made it', async () => {
    const created = await owner.api.post(`/api/lawfirms/${firm.id}/practice-areas`)
      .send({ name: 'Family Law' });
    expect(created.status).toBe(201);
    await settleAuditWrites();

    const res = await owner.api.get(A(firm.id));

    // Seeded rows can prove the read; only a real request can prove the WRITE.
    // The middleware fires from `res.on('finish')`, so a change that moved it
    // ahead of the route, or dropped the firm id it parses out of the URL, leaves
    // the log silently empty while every screen still works.
    expect(res.body.totalItems).toBe(1);
    expect(res.body.items[0]).toMatchObject({
      lawFirmId: firm.id,
      actorUid: owner.uid,
      method: 'POST',
      action: `POST /api/lawfirms/:id/practice-areas`,
      statusCode: 201,
    });
  });

  it('records a REFUSED mutation too', async () => {
    const narrow = await memberWith(firm.id, []);

    await narrow.api.post(`/api/lawfirms/${firm.id}/practice-areas`).send({ name: 'Family Law' });
    await settleAuditWrites();

    const res = await owner.api.get(A(firm.id));

    // "Who tried what" is the question the log answers during an incident, so a
    // recorder that only kept successes would drop the events worth keeping.
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ actorUid: narrow.uid, statusCode: 403 });
  });

  it('does NOT store the request body', async () => {
    await owner.api.post(`/api/lawfirms/${firm.id}/practice-areas`)
      .send({ name: 'Zzyzx Confidential Practice' });
    await settleAuditWrites();

    const res = await owner.api.get(A(firm.id));

    // Deliberate: a request body can carry PII, a client's name, or a secret,
    // and the audit log is readable by a role that may not be allowed to see any
    // of it. Only small derived hints are kept.
    expect(res.body.totalItems).toBe(1);
    expect(JSON.stringify(res.body)).not.toContain('Zzyzx Confidential Practice');
  });

  it('records nothing for a read', async () => {
    await owner.api.get(`/api/lawfirms/${firm.id}/practice-areas`);
    await settleAuditWrites();

    const res = await owner.api.get(A(firm.id));

    // Reads are skipped on purpose: recording them would bury the mutations
    // under page loads and roughly multiply the table's growth by the read
    // traffic. The GET above returned 200, so this is the recorder declining and
    // not a request that failed.
    expect(res.body.items).toEqual([]);
    expect(res.body.totalItems).toBe(0);
  });

  it('attributes a mutation to the firm in the URL, not to the caller other firm', async () => {
    await owner.api.post(`/api/lawfirms/${firm.id}/practice-areas`).send({ name: 'Family Law' });
    await settleAuditWrites();

    const res = await otherOwner.api.get(A(otherFirm.id));

    // The firm id is parsed out of the request URL. Take it from the session or
    // default it and one firm's activity lands in another firm's log.
    expect(res.body.items).toEqual([]);
    expect(res.body.totalItems).toBe(0);
  });
});
