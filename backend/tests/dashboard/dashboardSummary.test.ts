/**
 * GET /api/lawfirms/:lawFirmId/dashboard-summary
 *
 * The dashboard is the widest cross-module read in the app: one request fans out
 * over matters, tasks, invoices, payments, time entries, calendar events,
 * conversations, the member roster and signing sessions. Two properties follow
 * from that, and this file exists for both.
 *
 * 1. It is the single most likely place for a tenant-scope or ethical-wall gap
 *    to appear, because a leak here is invisible: the number just looks bigger.
 *    Every isolation case below therefore asserts PRESENCE of the firm's own
 *    figure as well as ABSENCE of the neighbour's. An empty dashboard passes an
 *    absence-only assertion while proving nothing.
 * 2. Each figure is its own query. A single "the payload has the right shape"
 *    test stays green while any individual number is wrong, so every section
 *    gets seeded data, no data, and a neighbouring firm's data that WOULD match
 *    if the scope were missing.
 *
 * PERMISSIONS. `resolveFromRolePermissions` unions a role's codes with
 * DEFAULT_PERMISSIONS, and that baseline contains dashboard.view, matters.view,
 * tasks.view, messaging.view, members.view, calendar.view, clients.view,
 * signatures.view, billing.viewInvoices and billing.viewTimeEntries. So EVERY
 * firm member holds every code the dashboard's per-section gate reads, and
 * "refuses a member without X" is not expressible. The real boundary here is
 * row-level: the owner/admin test (`isResolvedMemberOwnerOrAdmin`, the same rule
 * as `isFirmOwnerOrAdmin`) decides firm-wide versus matter-membership scoping,
 * and that is what the ethical-wall cases below exercise.
 *
 * CLOCK. `freezeClockAt` fakes Node's Date, not Postgres's `now()`, and every
 * day-window in this service is computed in SQL. Dates are therefore anchored to
 * `(now() at time zone $tz)::date` read back from the same database, never to a
 * frozen JS clock.
 */
import { randomUUID } from 'crypto';
import {
  createFirm,
  createPersonClient,
  createPortalUser,
  drainEvents,
  memberWith,
  ownerOf,
  stranger,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { seedMatter, seedMatterClient, seedMatterMember } from '../support/matters';
import { sessionKeysSql } from '../support/factories';

const TZ = 'America/New_York';
// 26 hours apart, so their calendar dates never coincide. Used to prove the day
// windows resolve against the VIEWER's zone rather than the server's.
const TZ_AHEAD = 'Pacific/Kiritimati'; // UTC+14
const TZ_BEHIND = 'Etc/GMT+12'; // UTC-12

let firm: Firm;
let owner: Actor;
let other: Firm;
let otherOwner: Actor;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  other = await createFirm();
  otherOwner = await ownerOf(other.id);
  await drainEvents();
});

const summary = (actor: Actor, f: Firm = firm, tz: string = TZ) =>
  actor.api.get(`/api/lawfirms/${f.id}/dashboard-summary`).set('x-timezone', tz);

// ── date anchors ───────────────────────────────────────────────────────────
// Read back through the SAME expression the service uses, so a test cannot pass
// or fail because the container's clock sits in a different calendar day than
// the viewer's zone.
async function tzToday(tz: string = TZ): Promise<string> {
  const { rows } = await testPool.query('select (now() at time zone $1)::date::text as d', [tz]);
  return rows[0].d;
}
async function tzWeekStart(tz: string = TZ): Promise<string> {
  const { rows } = await testPool.query(
    "select date_trunc('week', (now() at time zone $1)::date)::date::text as d", [tz],
  );
  return rows[0].d;
}
async function tzMonthStart(tz: string = TZ): Promise<string> {
  const { rows } = await testPool.query(
    "select date_trunc('month', (now() at time zone $1)::date)::date::text as d", [tz],
  );
  return rows[0].d;
}
/** Day arithmetic on a 'YYYY-MM-DD' string, in UTC so no zone can shift it. */
function shift(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── fixtures (plain SQL only; never the code under test) ───────────────────
const joinMatter = (lawFirmId: string, matterId: string, userId: string) =>
  seedMatterMember(lawFirmId, matterId, userId, 'member');

async function seedTask(
  lawFirmId: string,
  o: { title?: string; status?: string; dueDate?: string | null; matterId?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into tasks (id, law_firm_id, title, status, priority, due_date, matter_id)
     values ($1, $2, $3, $4, 'medium', $5, $6)`,
    [id, lawFirmId, o.title ?? `Task ${id.slice(0, 8)}`, o.status ?? 'open',
      o.dueDate ?? null, o.matterId ?? null],
  );
  return id;
}

async function assign(taskId: string, userId: string): Promise<void> {
  await testPool.query(`insert into task_assignees (law_firm_id, task_id, user_id)
         select t.law_firm_id, t.id, $2 from tasks t where t.id = $1`, [taskId, userId]);
}

async function seedInvoice(
  lawFirmId: string,
  clientId: string,
  o: {
    totalCents?: number; dueDate?: string | null; amountPaidCents?: number;
    isPaid?: boolean; invoiceNumber?: string; clientName?: string | null; status?: string;
  } = {},
): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into invoices (id, law_firm_id, client_id, client_context_id, context_type,
                           invoice_number, status, total_cents, amount_paid_cents,
                           is_paid, invoice_date, due_date, client_name)
     values ($1, $2, $3, $3, 'client', $4, $5, $6, $7, $8, current_date, $9, $10)`,
    [id, lawFirmId, clientId, o.invoiceNumber ?? `INV-${id.slice(0, 8)}`, o.status ?? 'outstanding',
      o.totalCents ?? 100_000, o.amountPaidCents ?? 0, o.isPaid ?? false,
      o.dueDate ?? null, o.clientName ?? null],
  );
  return id;
}

async function seedPayment(
  lawFirmId: string, invoiceId: string, amountCents: number, paymentDate: string,
): Promise<void> {
  await testPool.query(
    `insert into invoice_payments (invoice_id, law_firm_id, amount_cents, payment_date)
     values ($1, $2, $3, $4)`,
    [invoiceId, lawFirmId, amountCents, paymentDate],
  );
}

async function seedTimeEntry(
  lawFirmId: string,
  o: {
    userId: string; clientId: string; entryDate: string; hours: number;
    rateCents?: number | null; billed?: boolean; billable?: boolean; description?: string;
  },
): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into activities (kind, id, law_firm_id, client_id, user_id, activity_date, hours,
                               rate_cents, billable, description)
     values ('time', $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, lawFirmId, o.clientId, o.userId, o.entryDate, o.hours, o.rateCents ?? null,
      o.billable ?? true, o.description ?? 'Fixture time'],
  );
  if (o.billed) {
    await billOntoInvoice(lawFirmId, o.clientId, 'time_entry', id, Math.round(o.hours * (o.rateCents ?? 0)));
  }
  return id;
}

/**
 * Put a row onto an invoice as a LINE ITEM. That is the only thing that makes it
 * billed: the `billed` / `is_billed` flags the fixtures used to set were dropped
 * by migration 0228 because nothing in the application ever set them, and the
 * dashboard was the last reader still filtering on them.
 */
async function billOntoInvoice(
  lawFirmId: string, clientId: string, kind: 'time_entry' | 'flat_fee' | 'expense', sourceId: string, amountCents: number,
): Promise<void> {
  const invoiceId = await seedInvoice(lawFirmId, clientId, { totalCents: amountCents });
  await testPool.query(
    `insert into invoice_line_items (invoice_id, law_firm_id, kind, source_id, quantity, rate_cents, amount_cents)
     values ($1, $2, $3, $4, 1, $5, $5)`,
    [invoiceId, lawFirmId, kind, sourceId, amountCents],
  );
}

async function seedFlatFee(
  lawFirmId: string, clientId: string, amountCents: number, billed = false,
): Promise<void> {
  const id = randomUUID();
  await testPool.query(
    `insert into activities (kind, id, law_firm_id, client_id, description, charge_cents)
     values ('flat_fee', $1, $2, $3, 'Fixture flat fee', $4)`,
    [id, lawFirmId, clientId, amountCents],
  );
  if (billed) await billOntoInvoice(lawFirmId, clientId, 'flat_fee', id, amountCents);
}

async function seedExpense(
  lawFirmId: string, clientId: string, amountCents: number,
  o: { billable?: boolean; isBilled?: boolean } = {},
): Promise<void> {
  const id = randomUUID();
  await testPool.query(
    `insert into activities (kind, id, law_firm_id, client_id, description, charge_cents, billable)
     values ('expense', $1, $2, $3, 'Fixture expense', $4, $5)`,
    [id, lawFirmId, clientId, amountCents, o.billable ?? true],
  );
  if (o.isBilled) await billOntoInvoice(lawFirmId, clientId, 'expense', id, amountCents);
}

async function seedMatterEvent(
  lawFirmId: string, matterId: string,
  o: { title: string; offsetHours: number; status?: string },
): Promise<void> {
  await testPool.query(
    `insert into events (law_firm_id, matter_id, title, type, status, date, location_name)
     values ($1, $2, $3, 'hearing', $4, now() + make_interval(hours => $5), 'Courtroom 3')`,
    [lawFirmId, matterId, o.title, o.status ?? 'upcoming', o.offsetHours],
  );
}

async function seedClientEvent(
  lawFirmId: string, clientId: string,
  o: { title: string; offsetHours: number; status?: string },
): Promise<void> {
  await testPool.query(
    `insert into events (law_firm_id, client_id, title, type, status, date)
     values ($1, $2, $3, 'meeting', $4, now() + make_interval(hours => $5))`,
    [lawFirmId, clientId, o.title, o.status ?? 'upcoming', o.offsetHours],
  );
}

async function seedConversation(
  lawFirmId: string,
  o: { clientName?: string; type?: 'direct' | 'group'; archived?: boolean; clientUid?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into conversations (id, law_firm_id, client_id, conversation_type,
                                title, last_message_at, archived_at)
     values ($1, $2, $3, $4, $5, now(), $6)`,
    [id, lawFirmId, o.clientUid ?? null, o.type ?? 'direct',
      o.clientName ?? 'Thread', o.archived ? new Date() : null],
  );
  return id;
}

async function seedMessage(
  lawFirmId: string, conversationId: string,
  o: { senderType: 'client' | 'firm_member'; readByFirm?: boolean },
): Promise<void> {
  await testPool.query(
    `insert into messages (conversation_id, law_firm_id, sender_type, content, read_by_firm)
     values ($1, $2, $3, 'hello', $4)`,
    [conversationId, lawFirmId, o.senderType, o.readByFirm ?? false],
  );
}

async function seedSigningSession(
  lawFirmId: string, memberUid: string,
  o: { fileName?: string; participantStatus?: string; sessionStatus?: string } = {},
): Promise<string> {
  const token = `sig-${randomUUID()}`;
  await testPool.query(
    `insert into signature_sessions (token, law_firm_id, source_id, created_by,
                                     routing_mode, file_name, status)
     values ($1, $2, (select id from signature_sources where law_firm_id = $2 order by created_at limit 1), $3, 'sequential', $4, $5)`,
    [token, lawFirmId, memberUid, o.fileName ?? 'Retainer.pdf', o.sessionStatus ?? 'pending'],
  );
  await testPool.query(
    `insert into signature_participants (id, session_id, law_firm_id, role_label, signing_order,
                                         name, member_user_id, status)
     values ($1, ${sessionKeysSql('$2')}, 'Attorney', 1, 'Fixture Signer', $3, $4)`,
    [`part-${randomUUID()}`, token, memberUid, o.participantStatus ?? 'active'],
  );
  return token;
}

// ═══════════════════════════════════════════════════════════════════════════
// Membership is decided once, by `requirePermission('dashboard.view')` on the
// route, and the service reads the member it resolved rather than asking the
// database again. These cases are what keep that from becoming an open door:
// each seeds a figure the caller would see if the refusal were missing, and
// asserts it is absent from the refusal.
describe('who may read the dashboard', () => {
  it('refuses a signed-in caller who is a member of no firm', async () => {
    await seedMatter(firm.id, { name: 'Private Matter' });

    const res = await summary(stranger());

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(res.body).not.toHaveProperty('stats');
    expect(JSON.stringify(res.body)).not.toContain('Private Matter');
  });

  it('refuses the owner of a different firm', async () => {
    await seedMatter(firm.id, { name: 'Private Matter' });

    const res = await summary(otherOwner, firm);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(res.body).not.toHaveProperty('stats');
  });

  it('refuses a member the moment their firm is scheduled for deletion', async () => {
    await seedMatter(firm.id, { name: 'Private Matter' });
    const member = await memberWith(firm.id, []);
    // Served first, so the member's resolution is already cached when the firm
    // is deleted; the refusal below has to come from the invalidation.
    expect((await summary(member)).status).toBe(200);

    const deletion = await owner.api.delete(`/api/lawfirms/${firm.id}`);
    expect(deletion.status).toBe(200);
    await drainEvents();

    const res = await summary(member);
    expect(res.status).toBe(403);
    expect(res.body).not.toHaveProperty('stats');
  });

  it('does not query membership again once the route has resolved the member', async () => {
    const member = await memberWith(firm.id, []);
    // The first request resolves and caches the member, so the counted request
    // below isolates the queries the service itself issues.
    expect((await summary(member)).status).toBe(200);

    const { pool } = require('../../src/shared/database/db');
    const spy = jest.spyOn(pool, 'query');
    let res: any;
    let calls: any[][] = [];
    try {
      res = await summary(member);
      // Copied before the restore, which empties the recorded calls.
      calls = [...spy.mock.calls];
    } finally {
      spy.mockRestore();
    }
    // Both the membership assertion and the owner/admin probe select from
    // `members m`; the section reads never alias it that way.
    const membershipQueries = calls.filter(([arg]: any[]) => {
      const text = typeof arg === 'string' ? arg : arg?.text;
      return typeof text === 'string' && /from members m\b/.test(text);
    });

    expect(res.status).toBe(200);
    expect(res.body.sectionErrors).toEqual({});
    // Guards the filter below: a spy that recorded nothing would pass it.
    expect(calls.length).toBeGreaterThan(0);
    expect(membershipQueries).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('matters section', () => {
  it('buckets open, closed and total, and lists the recent matters', async () => {
    await seedMatter(firm.id, { name: 'Alpha Active', status: 'active' });
    await seedMatter(firm.id, { name: 'Beta Active', status: 'active' });
    await seedMatter(firm.id, { name: 'Gamma Closed', status: 'closed' });
    await seedMatter(firm.id, { name: 'Delta Completed', status: 'completed' });
    // 'on_hold' is neither open nor closed: it must land in total only. Goes red
    // if the open bucket widens from `status = 'active'`.
    await seedMatter(firm.id, { name: 'Epsilon Hold', status: 'on_hold' });

    const res = await summary(owner);

    expect(res.status).toBe(200);
    expect(res.body.stats.openMatters).toBe(2);
    expect(res.body.stats.closedMatters).toBe(2);
    expect(res.body.stats.totalMatters).toBe(5);
    expect(res.body.recentMatters.map((m: any) => m.name).sort()).toEqual(
      ['Alpha Active', 'Beta Active', 'Delta Completed', 'Epsilon Hold', 'Gamma Closed'],
    );
  });

  it('reports zeros and an empty list for a firm with no matters', async () => {
    const res = await summary(owner);

    expect(res.body.stats.totalMatters).toBe(0);
    expect(res.body.stats.openMatters).toBe(0);
    expect(res.body.recentMatters).toEqual([]);
    // A zero produced by a section that THREW is a different fact from a zero
    // produced by an empty firm, and the payload distinguishes them.
    expect(res.body.sectionErrors.matters).toBeUndefined();
  });

  it('does not count or list another firm matters', async () => {
    await seedMatter(firm.id, { name: 'Ours Active', status: 'active' });
    await seedMatter(other.id, { name: 'Neighbour Active', status: 'active' });
    await seedMatter(other.id, { name: 'Neighbour Closed', status: 'closed' });

    const res = await summary(owner);

    // Presence AND absence. Without the presence half this passes on a dashboard
    // that returned nothing at all.
    expect(res.body.stats.totalMatters).toBe(1);
    expect(res.body.stats.openMatters).toBe(1);
    expect(res.body.stats.closedMatters).toBe(0);
    expect(res.body.recentMatters.map((m: any) => m.name)).toEqual(['Ours Active']);
  });

  it('walls a plain member off matters they are not a member of', async () => {
    const mine = await seedMatter(firm.id, { name: 'My Matter', status: 'active' });
    await seedMatter(firm.id, { name: 'Not My Matter', status: 'active' });
    const member = await memberWith(firm.id, []);
    await joinMatter(firm.id, mine, member.uid);

    const res = await summary(member);

    expect(res.body.stats.totalMatters).toBe(1);
    expect(res.body.stats.openMatters).toBe(1);
    expect(res.body.recentMatters.map((m: any) => m.name)).toEqual(['My Matter']);
  });

  it('gives a member on no matters zeros rather than a failed section', async () => {
    await seedMatter(firm.id, { name: 'Somebody Else Matter', status: 'active' });
    const member = await memberWith(firm.id, []);

    const res = await summary(member);

    expect(res.status).toBe(200);
    expect(res.body.stats.totalMatters).toBe(0);
    expect(res.body.recentMatters).toEqual([]);
    expect(res.body.sectionErrors).toEqual({});
  });

  it('widens a member holding members.changeRole to firm-wide matter counts', async () => {
    await seedMatter(firm.id, { name: 'Firm Wide Matter', status: 'active' });
    // `isFirmOwnerOrAdmin` treats members.changeRole as the admin marker, so this
    // member is deliberately OUTSIDE the ethical wall. Pinned so a change to that
    // marker is a deliberate one.
    const admin = await memberWith(firm.id, ['members.changeRole']);

    const res = await summary(admin);

    expect(res.body.stats.totalMatters).toBe(1);
    expect(res.body.recentMatters.map((m: any) => m.name)).toEqual(['Firm Wide Matter']);
  });

  it('counts a matter with two clients once and lists both client names', async () => {
    const matterId = await seedMatter(firm.id, { name: 'Two Client Matter', status: 'active' });
    const a = await createPersonClient(firm.id, { name: 'Client Aaa' });
    const b = await createPersonClient(firm.id, { name: 'Client Bbb' });
    await seedMatterClient(firm.id, matterId, a.id);
    await seedMatterClient(firm.id, matterId, b.id);

    const res = await summary(owner);

    // Goes red if the client junction is joined into the count query instead of
    // aggregated laterally: the matter would be counted once per client.
    expect(res.body.stats.totalMatters).toBe(1);
    expect(res.body.recentMatters).toHaveLength(1);
    expect(res.body.recentMatters[0].clientNames.sort()).toEqual(['Client Aaa', 'Client Bbb']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('task stats', () => {
  it('buckets pending, completed and total', async () => {
    await seedTask(firm.id, { title: 'Open one', status: 'open' });
    await seedTask(firm.id, { title: 'In progress', status: 'in_progress' });
    await seedTask(firm.id, { title: 'Done', status: 'completed' });
    await seedTask(firm.id, { title: 'Blocked', status: 'blocked' });

    const res = await summary(owner);

    expect(res.body.stats.pendingTasks).toBe(2);
    expect(res.body.stats.completedTasks).toBe(1);
    expect(res.body.stats.totalTasks).toBe(4);
  });

  it('reports zeros for a firm with no tasks', async () => {
    const res = await summary(owner);

    expect(res.body.stats.totalTasks).toBe(0);
    expect(res.body.stats.pendingTasks).toBe(0);
    expect(res.body.stats.upcomingDeadlines).toBe(0);
    expect(res.body.stats.overdueTasks).toBe(0);
  });

  it('bounds upcomingDeadlines at both ends of today..+7', async () => {
    const today = await tzToday();
    await seedTask(firm.id, { title: 'Due today', dueDate: today });
    await seedTask(firm.id, { title: 'Due day seven', dueDate: shift(today, 7) });
    await seedTask(firm.id, { title: 'Due day eight', dueDate: shift(today, 8) });
    await seedTask(firm.id, { title: 'Due yesterday', dueDate: shift(today, -1) });
    await seedTask(firm.id, { title: 'No due date', dueDate: null });

    const res = await summary(owner);

    // Both bounds. Day 8 going red is the upper bound; yesterday going red is the
    // lower one; the no-due-date row proves the null guard.
    expect(res.body.stats.upcomingDeadlines).toBe(2);
    expect(res.body.stats.overdueTasks).toBe(1);
  });

  it('treats today as not yet overdue and yesterday as overdue', async () => {
    const today = await tzToday();
    await seedTask(firm.id, { title: 'Due today', dueDate: today });
    await seedTask(firm.id, { title: 'Due yesterday', dueDate: shift(today, -1) });
    await seedTask(firm.id, { title: 'Due long ago', dueDate: shift(today, -30) });

    const res = await summary(owner);

    expect(res.body.stats.overdueTasks).toBe(2);
  });

  it('never counts a completed task as upcoming or overdue', async () => {
    const today = await tzToday();
    await seedTask(firm.id, { title: 'Finished but past due', status: 'completed', dueDate: shift(today, -3) });
    await seedTask(firm.id, { title: 'Finished but due soon', status: 'completed', dueDate: shift(today, 2) });

    const res = await summary(owner);

    expect(res.body.stats.completedTasks).toBe(2);
    expect(res.body.stats.overdueTasks).toBe(0);
    expect(res.body.stats.upcomingDeadlines).toBe(0);
  });

  it('does not count another firm tasks', async () => {
    const today = await tzToday();
    await seedTask(firm.id, { title: 'Ours', status: 'open', dueDate: today });
    await seedTask(other.id, { title: 'Theirs open', status: 'open', dueDate: today });
    await seedTask(other.id, { title: 'Theirs overdue', status: 'open', dueDate: shift(today, -1) });

    const res = await summary(owner);

    expect(res.body.stats.totalTasks).toBe(1);
    expect(res.body.stats.pendingTasks).toBe(1);
    expect(res.body.stats.upcomingDeadlines).toBe(1);
    expect(res.body.stats.overdueTasks).toBe(0);
  });

  it('shows a plain member firm-scoped tasks and only their own matters tasks', async () => {
    const mine = await seedMatter(firm.id, { name: 'Mine' });
    const theirs = await seedMatter(firm.id, { name: 'Theirs' });
    await seedTask(firm.id, { title: 'Firm scoped', matterId: null });
    await seedTask(firm.id, { title: 'On my matter', matterId: mine });
    await seedTask(firm.id, { title: 'On a matter I am not on', matterId: theirs });
    const member = await memberWith(firm.id, []);
    await joinMatter(firm.id, mine, member.uid);

    const memberRes = await summary(member);
    const ownerRes = await summary(owner);

    // The member sees two of the three; the owner sees all three. Asserting both
    // is what separates "the wall works" from "the query returned nothing".
    expect(memberRes.body.stats.totalTasks).toBe(2);
    expect(ownerRes.body.stats.totalTasks).toBe(3);
  });

  it('counts a task with two assignees once', async () => {
    const second = await memberWith(firm.id, []);
    const taskId = await seedTask(firm.id, { title: 'Shared task', status: 'open' });
    await assign(taskId, owner.uid);
    await assign(taskId, second.uid);

    const res = await summary(owner);

    // Goes red if task_assignees is joined into the stat query rather than
    // aggregated laterally.
    expect(res.body.stats.totalTasks).toBe(1);
    expect(res.body.stats.pendingTasks).toBe(1);
  });

  it('resolves the today boundary against the viewer timezone, not the server', async () => {
    const behindToday = await tzToday(TZ_BEHIND);
    const aheadToday = await tzToday(TZ_AHEAD);
    // The two zones are 26 hours apart, so these are never the same calendar day.
    expect(behindToday < aheadToday).toBe(true);
    await seedTask(firm.id, { title: 'Boundary task', dueDate: behindToday });

    const behind = await summary(owner, firm, TZ_BEHIND);
    const ahead = await summary(owner, firm, TZ_AHEAD);

    // Same row, same instant, two viewers: due TODAY for one and already overdue
    // for the other. Goes red the moment the window stops binding the tz param.
    expect(behind.body.stats.upcomingDeadlines).toBe(1);
    expect(behind.body.stats.overdueTasks).toBe(0);
    expect(ahead.body.stats.upcomingDeadlines).toBe(0);
    expect(ahead.body.stats.overdueTasks).toBe(1);
    // And the LISTS must agree with the counts they sit beside.
    expect(behind.body.upcomingTasks.map((t: any) => t.title)).toEqual(['Boundary task']);
    expect(behind.body.overdueTasks).toEqual([]);
    expect(ahead.body.upcomingTasks).toEqual([]);
    expect(ahead.body.overdueTasks.map((t: any) => t.title)).toEqual(['Boundary task']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('upcomingTasks and overdueTasks lists', () => {
  it('lists the today..+7 window in due-date order and excludes both edges', async () => {
    const today = await tzToday();
    await seedTask(firm.id, { title: 'Day seven', dueDate: shift(today, 7) });
    await seedTask(firm.id, { title: 'Day zero', dueDate: today });
    await seedTask(firm.id, { title: 'Day three', dueDate: shift(today, 3) });
    await seedTask(firm.id, { title: 'Day eight', dueDate: shift(today, 8) });
    await seedTask(firm.id, { title: 'Yesterday', dueDate: shift(today, -1) });

    const res = await summary(owner);

    expect(res.body.upcomingTasks.map((t: any) => t.title)).toEqual(
      ['Day zero', 'Day three', 'Day seven'],
    );
    expect(res.body.overdueTasks.map((t: any) => t.title)).toEqual(['Yesterday']);
  });

  it('excludes completed tasks from the overdue list', async () => {
    const today = await tzToday();
    await seedTask(firm.id, { title: 'Still open', dueDate: shift(today, -2) });
    await seedTask(firm.id, { title: 'Already done', status: 'completed', dueDate: shift(today, -2) });

    const res = await summary(owner);

    expect(res.body.overdueTasks.map((t: any) => t.title)).toEqual(['Still open']);
  });

  it('walls the lists off tasks on matters the member is not on', async () => {
    const today = await tzToday();
    const mine = await seedMatter(firm.id, { name: 'Mine' });
    const theirs = await seedMatter(firm.id, { name: 'Theirs' });
    await seedTask(firm.id, { title: 'Visible upcoming', matterId: mine, dueDate: shift(today, 1) });
    await seedTask(firm.id, { title: 'Walled upcoming', matterId: theirs, dueDate: shift(today, 1) });
    await seedTask(firm.id, { title: 'Visible overdue', matterId: mine, dueDate: shift(today, -1) });
    await seedTask(firm.id, { title: 'Walled overdue', matterId: theirs, dueDate: shift(today, -1) });
    const member = await memberWith(firm.id, []);
    await joinMatter(firm.id, mine, member.uid);

    const res = await summary(member);

    expect(res.body.upcomingTasks.map((t: any) => t.title)).toEqual(['Visible upcoming']);
    expect(res.body.overdueTasks.map((t: any) => t.title)).toEqual(['Visible overdue']);
  });

  it('never lists another firm tasks', async () => {
    const today = await tzToday();
    await seedTask(firm.id, { title: 'Ours due soon', dueDate: shift(today, 1) });
    await seedTask(other.id, { title: 'Theirs due soon', dueDate: shift(today, 1) });
    await seedTask(other.id, { title: 'Theirs overdue', dueDate: shift(today, -1) });

    const res = await summary(owner);

    expect(res.body.upcomingTasks.map((t: any) => t.title)).toEqual(['Ours due soon']);
    expect(res.body.overdueTasks).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('myAssignments', () => {
  it('returns only the caller assignments, with a matching total', async () => {
    const colleague = await memberWith(firm.id, []);
    const mine = await seedTask(firm.id, { title: 'Assigned to me', status: 'open' });
    const theirs = await seedTask(firm.id, { title: 'Assigned to a colleague', status: 'open' });
    const done = await seedTask(firm.id, { title: 'Assigned to me but done', status: 'completed' });
    await assign(mine, owner.uid);
    await assign(theirs, colleague.uid);
    await assign(done, owner.uid);

    const res = await summary(owner);

    expect(res.body.myAssignments.tasks.map((t: any) => t.title)).toEqual(['Assigned to me']);
    expect(res.body.myAssignments.totalTasks).toBe(1);
  });

  it('is null-free and empty when the caller is assigned nothing', async () => {
    await seedTask(firm.id, { title: 'Unassigned', status: 'open' });

    const res = await summary(owner);

    expect(res.body.myAssignments).toEqual({ tasks: [], totalTasks: 0 });
  });

  it('does not reach into another firm assignments', async () => {
    // Same Firebase uid cannot be in two firms via the factories, so seed a task
    // in the neighbour firm assigned to ITS owner and assert our own is intact.
    const ours = await seedTask(firm.id, { title: 'Ours', status: 'open' });
    await assign(ours, owner.uid);
    const theirs = await seedTask(other.id, { title: 'Theirs', status: 'open' });
    await assign(theirs, otherOwner.uid);

    const res = await summary(owner);

    expect(res.body.myAssignments.tasks.map((t: any) => t.title)).toEqual(['Ours']);
    expect(res.body.myAssignments.totalTasks).toBe(1);
  });

  it('counts a task with two assignees once for each of them', async () => {
    const colleague = await memberWith(firm.id, []);
    const taskId = await seedTask(firm.id, { title: 'Shared', status: 'open' });
    await assign(taskId, owner.uid);
    await assign(taskId, colleague.uid);

    const res = await summary(owner);

    expect(res.body.myAssignments.tasks).toHaveLength(1);
    expect(res.body.myAssignments.totalTasks).toBe(1);
  });

  it('keeps the assignment TOTAL and the LIST in agreement behind the matter wall', async () => {
    // A member assigned to a task on a matter they were removed from. The list
    // (findAssignedToUser) filters on matter_members; the count
    // (countAssignedToUser) did not, so the widget showed "1" above an empty
    // list and the member had no way to find the task it was counting.
    const walled = await seedMatter(firm.id, { name: 'Walled matter' });
    const taskId = await seedTask(firm.id, { title: 'Assigned but walled', matterId: walled });
    const member = await memberWith(firm.id, []);
    await assign(taskId, member.uid);

    const res = await summary(member);

    expect(res.body.myAssignments.tasks).toEqual([]);
    expect(res.body.myAssignments.totalTasks).toBe(0);
  });

  it('still counts an assignment the member CAN see', async () => {
    const open = await seedMatter(firm.id, { name: 'Member matter' });
    const taskId = await seedTask(firm.id, { title: 'Assigned and visible', matterId: open });
    const member = await memberWith(firm.id, []);
    await assign(taskId, member.uid);
    await joinMatter(firm.id, open, member.uid);

    const res = await summary(member);

    // The pair that makes the case above meaningful. A count hard-wired to zero,
    // or one narrowed too far, would satisfy the wall case on its own.
    expect(res.body.myAssignments.totalTasks).toBe(1);
    expect(res.body.myAssignments.tasks).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('messaging section', () => {
  it('counts unread client messages and lists the direct threads', async () => {
    // The thread's client name is joined from `users`, so the fixture names the
    // portal account rather than stamping a copy onto the conversation.
    const portal = await createPortalUser({ name: 'Chatty Client' });
    const convo = await seedConversation(firm.id, { clientUid: portal.uid });
    await seedMessage(firm.id, convo, { senderType: 'client', readByFirm: false });
    await seedMessage(firm.id, convo, { senderType: 'client', readByFirm: true });
    await seedMessage(firm.id, convo, { senderType: 'firm_member', readByFirm: false });

    const res = await summary(owner);

    // Only the unread CLIENT message counts. Goes red if either the sender_type
    // or the read_by_firm term is dropped.
    expect(res.body.stats.unreadMessages).toBe(1);
    expect(res.body.stats.conversationCount).toBe(1);
    expect(res.body.recentConversations.map((c: any) => c.clientName)).toEqual(['Chatty Client']);
  });

  it('reports zero for a firm with no conversations', async () => {
    const res = await summary(owner);

    expect(res.body.stats.unreadMessages).toBe(0);
    expect(res.body.stats.conversationCount).toBe(0);
    expect(res.body.recentConversations).toEqual([]);
  });

  it('does not count or list another firm conversations', async () => {
    const oursPortal = await createPortalUser({ name: 'Our Client' });
    const theirsPortal = await createPortalUser({ name: 'Neighbour Client' });
    const ours = await seedConversation(firm.id, { clientUid: oursPortal.uid });
    await seedMessage(firm.id, ours, { senderType: 'client', readByFirm: false });
    const theirs = await seedConversation(other.id, { clientUid: theirsPortal.uid });
    await seedMessage(other.id, theirs, { senderType: 'client', readByFirm: false });

    const res = await summary(owner);

    expect(res.body.stats.conversationCount).toBe(1);
    expect(res.body.stats.unreadMessages).toBe(1);
    expect(res.body.recentConversations.map((c: any) => c.clientName)).toEqual(['Our Client']);
  });

  it('pins the three different populations the messaging widget reports', async () => {
    const portal = await createPortalUser({ name: 'Direct Thread' });
    const direct = await seedConversation(firm.id, { clientUid: portal.uid });
    await seedConversation(firm.id, { clientName: 'Group Thread', type: 'group' });
    const archivedPortal = await createPortalUser({ name: 'Archived Thread' });
    const archived = await seedConversation(firm.id, {
      clientUid: archivedPortal.uid, archived: true,
    });
    await seedMessage(firm.id, direct, { senderType: 'client', readByFirm: false });
    await seedMessage(firm.id, archived, { senderType: 'client', readByFirm: false });

    const res = await summary(owner);

    // Three populations, deliberately different, all shown side by side:
    //   conversationCount -> every conversations row, groups and archived included
    //   recentConversations -> direct threads only, archived STILL included
    //                          (matches the firm conversations list endpoint,
    //                          which only splits on archive when asked to)
    //   unreadMessages -> direct AND unarchived only
    // Pinned together so a change to any one of them is visible as a change.
    expect(res.body.stats.conversationCount).toBe(3);
    expect(res.body.recentConversations.map((c: any) => c.clientName).sort()).toEqual(
      ['Archived Thread', 'Direct Thread'],
    );
    expect(res.body.stats.unreadMessages).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('team section', () => {
  it('derives teamSize from the roster and excludes another firm members', async () => {
    await memberWith(firm.id, []);
    await memberWith(firm.id, []);
    await memberWith(other.id, []);

    const res = await summary(owner);

    // owner + two members.
    expect(res.body.stats.teamSize).toBe(3);
    expect(res.body.teamMembers).toHaveLength(3);
    const uids = res.body.teamMembers.map((m: any) => m.userId);
    expect(uids).toContain(owner.uid);
    expect(uids).not.toContain(otherOwner.uid);
  });

  it('returns the member default rate in DOLLARS while the column holds cents', async () => {
    const member = await memberWith(firm.id, []);
    await testPool.query(
      'update members set default_hourly_rate_cents = 42500 where law_firm_id = $1 and user_id = $2',
      [firm.id, member.uid],
    );

    const res = await summary(owner);

    const row = res.body.teamMembers.find((m: any) => m.userId === member.uid);
    expect(row.defaultHourlyRate).toBe(425);
    // And a member with no rate set stays null rather than becoming 0.
    const ownerRow = res.body.teamMembers.find((m: any) => m.userId === owner.uid);
    expect(ownerRow.defaultHourlyRate).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('financial section', () => {
  it('sums outstanding AR in CENTS and drops fully paid invoices', async () => {
    const client = await createPersonClient(firm.id, { name: 'Paying Client' });
    const today = await tzToday();
    await seedInvoice(firm.id, client.id, { totalCents: 250_000, dueDate: shift(today, 10) });
    await seedInvoice(firm.id, client.id, { totalCents: 100_000, amountPaidCents: 40_000, dueDate: shift(today, 10) });
    await seedInvoice(firm.id, client.id, {
      totalCents: 90_000, amountPaidCents: 90_000, isPaid: true, dueDate: shift(today, 10),
    });

    const res = await summary(owner);

    // Cents in the column, cents on the wire. 3100 would be the dollars answer.
    expect(res.body.stats.outstandingArCents).toBe(310_000);
  });

  it('counts an invoice overdue from the day AFTER its due date', async () => {
    const client = await createPersonClient(firm.id, { name: 'Late Client' });
    const today = await tzToday();
    await seedInvoice(firm.id, client.id, { totalCents: 70_000, dueDate: shift(today, -1) });
    await seedInvoice(firm.id, client.id, { totalCents: 50_000, dueDate: today });
    await seedInvoice(firm.id, client.id, { totalCents: 30_000, dueDate: null });

    const res = await summary(owner);

    // Due today is not yet overdue; the null due date is never overdue.
    expect(res.body.stats.overdueInvoiceCount).toBe(1);
    expect(res.body.stats.overdueInvoiceCents).toBe(70_000);
    expect(res.body.stats.outstandingArCents).toBe(150_000);
  });

  /**
   * The dashboard's "overdue" is billing's: not voided, and past its NEXT
   * payment date when a plan sets one, else its due date. Goes red if the
   * dashboard reads the due date alone (a plan invoice with an old due date and
   * a later instalment counted overdue here while billing said current) or
   * counts a voided invoice.
   */
  it('agrees with billing on what is overdue', async () => {
    const client = await createPersonClient(firm.id, { name: 'Plan Client' });
    const today = await tzToday();
    const onPlan = await seedInvoice(firm.id, client.id, { totalCents: 40_000, dueDate: shift(today, -20) });
    await testPool.query(`update invoices set next_payment_date = $2 where id = $1`, [onPlan, shift(today, 5)]);
    const planLate = await seedInvoice(firm.id, client.id, { totalCents: 25_000, dueDate: shift(today, 20) });
    await testPool.query(`update invoices set next_payment_date = $2 where id = $1`, [planLate, shift(today, -2)]);
    await seedInvoice(firm.id, client.id, { totalCents: 60_000, dueDate: shift(today, -3), status: 'voided' });

    const res = await summary(owner);

    expect(res.body.stats.overdueInvoiceCount).toBe(1);
    expect(res.body.stats.overdueInvoiceCents).toBe(25_000);
    expect(res.body.agingInvoices.map((i: any) => i.balanceDueCents)).toEqual([25_000]);
  });

  it('bounds collectedThisMonth at both ends of the calendar month', async () => {
    const client = await createPersonClient(firm.id, { name: 'Payer' });
    const monthStart = await tzMonthStart();
    const invoiceId = await seedInvoice(firm.id, client.id, { totalCents: 500_000 });
    await seedPayment(firm.id, invoiceId, 12_000, monthStart);
    await seedPayment(firm.id, invoiceId, 8_000, shift(monthStart, -1));
    // A month from the start is always in the NEXT month, so this is the upper bound.
    await seedPayment(firm.id, invoiceId, 5_000, shift(monthStart, 40));

    const res = await summary(owner);

    expect(res.body.stats.collectedThisMonthCents).toBe(12_000);
  });

  it('cannot record a payment on a malformed date at all', async () => {
    // This used to be the tail of the case above: it seeded
    // `payment_date = 'not-a-date'` and asserted the month total ignored it,
    // because the query carried a regex guard to stop `to_date` raising on
    // exactly that row. Migration 0196 made payment_date a `date` column, so the
    // garbage can no longer be stored, and the guard is gone with it.
    //
    // The guarantee moved rather than disappeared, so the assertion moves with
    // it: the database refuses the write instead of the report skipping the row.
    const client = await createPersonClient(firm.id, { name: 'Bad Date Payer' });
    const invoiceId = await seedInvoice(firm.id, client.id, { totalCents: 500_000 });

    await expect(
      seedPayment(firm.id, invoiceId, 99_000, 'not-a-date'),
    ).rejects.toMatchObject({ code: '22007' });
  });

  it('sums unbilled WIP from time, flat fees and billable expenses', async () => {
    const client = await createPersonClient(firm.id, { name: 'WIP Client' });
    const today = await tzToday();
    // 2h at 30000 cents/h -> 60000 cents of explicit-rate time.
    await seedTimeEntry(firm.id, { userId: owner.uid, clientId: client.id, entryDate: today, hours: 2, rateCents: 30_000 });
    await seedTimeEntry(firm.id, { userId: owner.uid, clientId: client.id, entryDate: today, hours: 5, rateCents: 30_000, billed: true });
    await seedFlatFee(firm.id, client.id, 25_000, false);
    await seedFlatFee(firm.id, client.id, 90_000, true);
    await seedExpense(firm.id, client.id, 7_000, { billable: true, isBilled: false });
    await seedExpense(firm.id, client.id, 4_000, { billable: false, isBilled: false });
    await seedExpense(firm.id, client.id, 3_000, { billable: true, isBilled: true });

    const res = await summary(owner);

    expect(res.body.stats.unbilledWipCents).toBe(60_000 + 25_000 + 7_000);
    expect(res.body.stats.unbilledHours).toBe(2);
  });

  it('leaves NON-BILLABLE time out of unbilled WIP, in dollars and in hours', async () => {
    const client = await createPersonClient(firm.id, { name: 'Pro Bono Client' });
    const today = await tzToday();
    // One of each, so the absence below is preceded by proof the query ran. A
    // lone non-billable entry would report zero against a broken query too.
    await seedTimeEntry(firm.id, {
      userId: owner.uid, clientId: client.id, entryDate: today,
      hours: 2, rateCents: 30_000, billable: true,
    });
    await seedTimeEntry(firm.id, {
      userId: owner.uid, clientId: client.id, entryDate: today,
      hours: 3, rateCents: 20_000, billable: false,
    });

    const res = await summary(owner);

    // The expenses leg of this same aggregate has always filtered
    // `billable = true`; the time leg did not, so pro bono and written-off time
    // counted as work in progress. That put the dashboard at odds with this
    // app's own billing module twice over: `firmBilling.service` already filters
    // `billable !== false` for the workbench's own unbilled figure, and
    // `invoices.service` THROWS if a non-billable entry reaches an invoice. The
    // dashboard was reporting money the invoice builder refuses to bill.
    //
    // Both figures matter. An entry with a null rate contributes no dollars but
    // full hours, so hours is where a firm would notice first.
    expect(res.body.stats.unbilledWipCents).toBe(60_000);
    expect(res.body.stats.unbilledHours).toBe(2);
  });

  it('keeps another firm money out of every financial figure', async () => {
    const ourClient = await createPersonClient(firm.id, { name: 'Ours' });
    const theirClient = await createPersonClient(other.id, { name: 'Theirs' });
    const today = await tzToday();
    await seedInvoice(firm.id, ourClient.id, { totalCents: 10_000, dueDate: shift(today, -1) });
    const theirInvoice = await seedInvoice(other.id, theirClient.id, {
      totalCents: 999_000, dueDate: shift(today, -1),
    });
    await seedPayment(other.id, theirInvoice, 777_000, await tzMonthStart());
    await seedFlatFee(other.id, theirClient.id, 555_000, false);
    await seedTimeEntry(other.id, {
      userId: otherOwner.uid, clientId: theirClient.id, entryDate: today, hours: 9, rateCents: 100_000,
    });

    const res = await summary(owner);

    // Presence of ours proves the query ran; absence of theirs proves the scope.
    expect(res.body.stats.outstandingArCents).toBe(10_000);
    expect(res.body.stats.overdueInvoiceCents).toBe(10_000);
    expect(res.body.stats.overdueInvoiceCount).toBe(1);
    expect(res.body.stats.collectedThisMonthCents).toBe(0);
    expect(res.body.stats.unbilledWipCents).toBe(0);
    expect(res.body.stats.unbilledHours).toBe(0);
  });

  it('pins that financial figures are firm-wide, NOT walled by matter membership', async () => {
    const client = await createPersonClient(firm.id, { name: 'Firm Wide Client' });
    const today = await tzToday();
    await seedInvoice(firm.id, client.id, { totalCents: 123_400, dueDate: shift(today, -2) });
    // A member on no matters at all. Money surfaces mirror the billing workbench,
    // which any billing.viewInvoices holder can already open, so the ethical wall
    // does NOT apply here. That is the current design; pinned so a future change
    // to it is intentional.
    const member = await memberWith(firm.id, ['billing.viewInvoices']);

    const res = await summary(member);

    expect(res.body.stats.outstandingArCents).toBe(123_400);
    expect(res.body.stats.overdueInvoiceCount).toBe(1);
  });

  it('lists aging invoices oldest first, in cents, with the client name resolved', async () => {
    const client = await createPersonClient(firm.id, { name: 'Resolved From Clients Table' });
    const today = await tzToday();
    await seedInvoice(firm.id, client.id, {
      totalCents: 20_000, dueDate: shift(today, -3), invoiceNumber: 'INV-NEWER',
    });
    await seedInvoice(firm.id, client.id, {
      totalCents: 30_000, dueDate: shift(today, -9), invoiceNumber: 'INV-OLDER',
    });
    // Not overdue, so it must not appear in the aging list at all.
    await seedInvoice(firm.id, client.id, {
      totalCents: 40_000, dueDate: shift(today, 5), invoiceNumber: 'INV-FUTURE',
    });

    const res = await summary(owner);

    expect(res.body.agingInvoices.map((i: any) => i.invoiceNumber)).toEqual(['INV-OLDER', 'INV-NEWER']);
    expect(res.body.agingInvoices[0].balanceDueCents).toBe(30_000);
    expect(res.body.agingInvoices[0].daysOverdue).toBe(9);
    // client_name is null on the row, so the coalesce falls through to clients.name.
    expect(res.body.agingInvoices[0].clientName).toBe('Resolved From Clients Table');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('upcomingPayments', () => {
  /**
   * What is due next on a payment plan is its next instalment. Goes red if the
   * list reads the due date alone: an instalment due in three days on an
   * invoice due in sixty was left off, and a voided invoice was listed.
   */
  it('lists a plan invoice by its next instalment, and leaves out voided ones', async () => {
    const client = await createPersonClient(firm.id, { name: 'Plan Payer' });
    const today = await tzToday();
    const onPlan = await seedInvoice(firm.id, client.id, { invoiceNumber: 'PLAN', dueDate: shift(today, 60) });
    await testPool.query(`update invoices set next_payment_date = $2 where id = $1`, [onPlan, shift(today, 3)]);
    await seedInvoice(firm.id, client.id, { invoiceNumber: 'VOID', dueDate: shift(today, 2), status: 'voided' });

    const res = await summary(owner);

    expect(res.body.upcomingPayments.map((p: any) => p.invoiceNumber)).toEqual(['PLAN']);
    expect(res.body.upcomingPayments[0].dueDate).toBe(shift(today, 3));
  });

  it('spans overdue through +30 days and stops there', async () => {
    const client = await createPersonClient(firm.id, { name: 'Payments Client' });
    const today = await tzToday();
    await seedInvoice(firm.id, client.id, { totalCents: 10_000, dueDate: shift(today, -5), invoiceNumber: 'P-OVERDUE' });
    await seedInvoice(firm.id, client.id, { totalCents: 20_000, dueDate: today, invoiceNumber: 'P-TODAY' });
    await seedInvoice(firm.id, client.id, { totalCents: 30_000, dueDate: shift(today, 30), invoiceNumber: 'P-DAY30' });
    await seedInvoice(firm.id, client.id, { totalCents: 40_000, dueDate: shift(today, 31), invoiceNumber: 'P-DAY31' });
    await seedInvoice(firm.id, client.id, {
      totalCents: 50_000, amountPaidCents: 50_000, isPaid: true, dueDate: today, invoiceNumber: 'P-PAID',
    });

    const res = await summary(owner);

    // Day 30 in, day 31 out: both ends of the window, plus the paid exclusion.
    expect(res.body.upcomingPayments.map((p: any) => p.invoiceNumber)).toEqual(
      ['P-OVERDUE', 'P-TODAY', 'P-DAY30'],
    );
  });

  it('reports cents and the client navigation context', async () => {
    const client = await createPersonClient(firm.id, { name: 'Context Client' });
    const today = await tzToday();
    await seedInvoice(firm.id, client.id, {
      totalCents: 80_000, amountPaidCents: 30_000, dueDate: shift(today, 3), invoiceNumber: 'P-CTX',
    });

    const res = await summary(owner);

    const row = res.body.upcomingPayments[0];
    expect(row.totalCents).toBe(80_000);
    expect(row.amountPaidCents).toBe(30_000);
    expect(row.balanceDueCents).toBe(50_000);
    expect(row.contextType).toBe('client');
    expect(row.entityId).toBe(client.id);
    // Negative days-relative: not yet due.
    expect(row.daysRelative).toBe(-3);
  });

  /**
   * The detail modal prints a Credits / Adjustments line from this field. Goes
   * red if the row omits the stored write-off, which left the modal inferring
   * credits from total - paid - balance.
   */
  it('reports the stored write-off in cents, and zero when there is none', async () => {
    const client = await createPersonClient(firm.id, { name: 'Credit Client' });
    const today = await tzToday();
    const credited = await seedInvoice(firm.id, client.id, {
      totalCents: 80_000, amountPaidCents: 30_000, dueDate: shift(today, 3), invoiceNumber: 'P-CREDIT',
    });
    await testPool.query(`update invoices set total_written_off_cents = 12500 where id = $1`, [credited]);
    await seedInvoice(firm.id, client.id, {
      totalCents: 20_000, dueDate: shift(today, 4), invoiceNumber: 'P-PLAIN',
    });

    const res = await summary(owner);

    const byNumber = Object.fromEntries(res.body.upcomingPayments.map((p: any) => [p.invoiceNumber, p]));
    expect(byNumber['P-CREDIT'].totalWrittenOffCents).toBe(12_500);
    expect(byNumber['P-CREDIT'].balanceDueCents).toBe(37_500);
    expect(byNumber['P-PLAIN'].totalWrittenOffCents).toBe(0);
  });

  it('never lists another firm invoices', async () => {
    const ourClient = await createPersonClient(firm.id, { name: 'Ours' });
    const theirClient = await createPersonClient(other.id, { name: 'Theirs' });
    const today = await tzToday();
    await seedInvoice(firm.id, ourClient.id, { totalCents: 11_000, dueDate: today, invoiceNumber: 'OURS' });
    await seedInvoice(other.id, theirClient.id, { totalCents: 22_000, dueDate: today, invoiceNumber: 'THEIRS' });

    const res = await summary(owner);

    expect(res.body.upcomingPayments.map((p: any) => p.invoiceNumber)).toEqual(['OURS']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('upcomingEvents', () => {
  it('spans now..+7 days and excludes both edges plus cancellations', async () => {
    const matterId = await seedMatter(firm.id, { name: 'Event Matter' });
    await seedMatterEvent(firm.id, matterId, { title: 'In two hours', offsetHours: 2 });
    await seedMatterEvent(firm.id, matterId, { title: 'In six days', offsetHours: 24 * 6 });
    await seedMatterEvent(firm.id, matterId, { title: 'In eight days', offsetHours: 24 * 8 });
    await seedMatterEvent(firm.id, matterId, { title: 'An hour ago', offsetHours: -1 });
    await seedMatterEvent(firm.id, matterId, { title: 'Cancelled soon', offsetHours: 3, status: 'cancelled' });

    const res = await summary(owner);

    // A rolling instant window, not a calendar-day one: an event earlier TODAY is
    // already past and drops out. Goes red on any of the four terms.
    expect(res.body.upcomingEvents.map((e: any) => e.title)).toEqual(['In two hours', 'In six days']);
    expect(res.body.upcomingEvents[0].source).toBe('matter');
    expect(res.body.upcomingEvents[0].matterName).toBe('Event Matter');
  });

  /**
   * An all-day event is upcoming for its whole day. Goes red if it is held to
   * the "not started yet" rule: at its noon-UTC anchor it dropped off the list
   * partway through its own day (at UTC-12 the anchor has always passed).
   */
  it('keeps today\'s all-day event, and says it is all-day', async () => {
    const zone = 'Etc/GMT+12';
    const matterId = await seedMatter(firm.id, { name: 'All-day Matter' });
    const today = await tzToday(zone);
    await testPool.query(
      `insert into events (law_firm_id, matter_id, title, type, status, date, all_day)
       values ($1, $2, 'Filing deadline', 'filing_deadline', 'upcoming', $3::timestamptz, true)`,
      [firm.id, matterId, `${today}T12:00:00Z`],
    );

    const res = await summary(owner, firm, zone);

    const listed = res.body.upcomingEvents.find((e: any) => e.title === 'Filing deadline');
    expect(listed).toBeDefined();
    expect(listed.allDay).toBe(true);
  });

  it('merges standalone client events with matter events in date order', async () => {
    const matterId = await seedMatter(firm.id, { name: 'Merge Matter' });
    const client = await createPersonClient(firm.id, { name: 'Merge Client' });
    await seedMatterEvent(firm.id, matterId, { title: 'Matter event later', offsetHours: 30 });
    await seedClientEvent(firm.id, client.id, { title: 'Client event sooner', offsetHours: 5 });

    const res = await summary(owner);

    expect(res.body.upcomingEvents.map((e: any) => e.title)).toEqual(
      ['Client event sooner', 'Matter event later'],
    );
    expect(res.body.upcomingEvents[0].source).toBe('client');
    expect(res.body.upcomingEvents[0].clientName).toBe('Merge Client');
  });

  it('walls a plain member off events on matters they are not a member of', async () => {
    const mine = await seedMatter(firm.id, { name: 'Mine' });
    const theirs = await seedMatter(firm.id, { name: 'Theirs' });
    await seedMatterEvent(firm.id, mine, { title: 'My hearing', offsetHours: 4 });
    await seedMatterEvent(firm.id, theirs, { title: 'Confidential hearing', offsetHours: 5 });
    const member = await memberWith(firm.id, []);
    await joinMatter(firm.id, mine, member.uid);

    const memberRes = await summary(member);
    const ownerRes = await summary(owner);

    expect(memberRes.body.upcomingEvents.map((e: any) => e.title)).toEqual(['My hearing']);
    expect(ownerRes.body.upcomingEvents.map((e: any) => e.title)).toEqual(
      ['My hearing', 'Confidential hearing'],
    );
  });

  it('does not list another firm events', async () => {
    const ourMatter = await seedMatter(firm.id, { name: 'Ours' });
    const theirMatter = await seedMatter(other.id, { name: 'Theirs' });
    const theirClient = await createPersonClient(other.id, { name: 'Their Client' });
    await seedMatterEvent(firm.id, ourMatter, { title: 'Our hearing', offsetHours: 6 });
    await seedMatterEvent(other.id, theirMatter, { title: 'Their hearing', offsetHours: 6 });
    await seedClientEvent(other.id, theirClient.id, { title: 'Their meeting', offsetHours: 6 });

    const res = await summary(owner);

    expect(res.body.upcomingEvents.map((e: any) => e.title)).toEqual(['Our hearing']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('my time', () => {
  it('reports the caller hours for today and this week, in HOURS not cents', async () => {
    const client = await createPersonClient(firm.id, { name: 'Time Client' });
    const today = await tzToday();
    const weekStart = await tzWeekStart();
    await seedTimeEntry(firm.id, { userId: owner.uid, clientId: client.id, entryDate: today, hours: 2.5, rateCents: 40_000 });
    await seedTimeEntry(firm.id, { userId: owner.uid, clientId: client.id, entryDate: weekStart, hours: 1, rateCents: 40_000 });
    // The day before the week starts must fall outside the week window.
    await seedTimeEntry(firm.id, { userId: owner.uid, clientId: client.id, entryDate: shift(weekStart, -1), hours: 8, rateCents: 40_000 });

    const res = await summary(owner);

    const expectedToday = weekStart === today ? 3.5 : 2.5;
    expect(res.body.stats.hoursToday).toBe(expectedToday);
    expect(res.body.stats.hoursThisWeek).toBe(3.5);
  });

  it('excludes another user hours and another firm hours', async () => {
    const client = await createPersonClient(firm.id, { name: 'Time Client' });
    const theirClient = await createPersonClient(other.id, { name: 'Their Client' });
    const colleague = await memberWith(firm.id, []);
    const today = await tzToday();
    await seedTimeEntry(firm.id, { userId: owner.uid, clientId: client.id, entryDate: today, hours: 1 });
    await seedTimeEntry(firm.id, { userId: colleague.uid, clientId: client.id, entryDate: today, hours: 6 });
    await seedTimeEntry(other.id, { userId: otherOwner.uid, clientId: theirClient.id, entryDate: today, hours: 9 });

    const res = await summary(owner);

    expect(res.body.stats.hoursToday).toBe(1);
    expect(res.body.todayTimeEntries).toHaveLength(1);
    expect(res.body.todayTimeEntries[0].hours).toBe(1);
  });

  it('lists only today entries, newest first, with the context name', async () => {
    const client = await createPersonClient(firm.id, { name: 'Context Client' });
    const today = await tzToday();
    await seedTimeEntry(firm.id, {
      userId: owner.uid, clientId: client.id, entryDate: today, hours: 1, description: 'Drafting',
    });
    await seedTimeEntry(firm.id, {
      userId: owner.uid, clientId: client.id, entryDate: shift(today, -1), hours: 4, description: 'Yesterday work',
    });

    const res = await summary(owner);

    expect(res.body.todayTimeEntries.map((e: any) => e.description)).toEqual(['Drafting']);
    expect(res.body.todayTimeEntries[0].contextName).toBe('Context Client');
    expect(res.body.todayTimeEntries[0].entryDate).toBe(today);
  });

  it('bounds hoursThisWeek at BOTH ends, so a future entry does not inflate it', async () => {
    const client = await createPersonClient(firm.id, { name: 'Future Client' });
    const today = await tzToday();
    await seedTimeEntry(firm.id, { userId: owner.uid, clientId: client.id, entryDate: shift(today, 20), hours: 7 });

    const res = await summary(owner);

    // Twenty days out is never "this week". The filter used to carry only
    // `entry_date >= date_trunc('week', today)`, so an entry dated next month
    // counted toward the current week and a member's weekly total read high
    // with nothing on screen explaining it. `collectedThisMonth`, three
    // sections up, bounds both ends; this now matches it.
    expect(res.body.stats.hoursThisWeek).toBe(0);
    expect(res.body.stats.hoursToday).toBe(0);
  });

  it('still counts an entry from earlier in the SAME week', async () => {
    const client = await createPersonClient(firm.id, { name: 'This Week Client' });
    const today = await tzToday();
    await seedTimeEntry(firm.id, { userId: owner.uid, clientId: client.id, entryDate: today, hours: 3 });

    const res = await summary(owner);

    // The pair that makes the case above meaningful. An upper bound written
    // wrongly (an exclusive `< today`, say) would zero this too, and the
    // exclusion test alone would not notice.
    expect(res.body.stats.hoursThisWeek).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('pending signatures', () => {
  it('returns sessions where the caller is an ACTIVE participant', async () => {
    await seedSigningSession(firm.id, owner.uid, { fileName: 'Mine.pdf', participantStatus: 'active' });
    await seedSigningSession(firm.id, owner.uid, { fileName: 'NotMyTurn.pdf', participantStatus: 'waiting' });
    await seedSigningSession(firm.id, owner.uid, {
      fileName: 'Finished.pdf', participantStatus: 'active', sessionStatus: 'completed',
    });

    const res = await summary(owner);

    expect(res.body.pendingSignatures.map((s: any) => s.fileName)).toEqual(['Mine.pdf']);
    expect(res.body.pendingSignatures[0].totalParticipants).toBe(1);
    expect(res.body.pendingSignatures[0].completedParticipants).toBe(0);
  });

  it('does not surface another firm signing sessions', async () => {
    await seedSigningSession(firm.id, owner.uid, { fileName: 'Ours.pdf' });
    await seedSigningSession(other.id, otherOwner.uid, { fileName: 'Theirs.pdf' });

    const res = await summary(owner);

    expect(res.body.pendingSignatures.map((s: any) => s.fileName)).toEqual(['Ours.pdf']);
  });

  it('withholds the section on a plan without documentSigning, without a 403', async () => {
    const starterFirm = await createFirm({ planId: 'starter' });
    const starterOwner = await ownerOf(starterFirm.id);
    await seedSigningSession(starterFirm.id, starterOwner.uid, { fileName: 'Gated.pdf' });

    const res = await summary(starterOwner, starterFirm);

    // Withheld by returning nothing, not by refusing the request: the dashboard
    // still renders. `permissions.signatures` stays true because the PERMISSION
    // is held; the PLAN is what removed the data.
    expect(res.status).toBe(200);
    expect(res.body.pendingSignatures).toEqual([]);
    expect(res.body.permissions.signatures).toBe(true);
    expect(res.body.sectionErrors).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('envelope', () => {
  it('withholds the financial sections from a member with an EMPTY role', async () => {
    // resolveFromRolePermissions unions the role's codes with DEFAULT_PERMISSIONS.
    // The invoice and time-entry view codes are not in that baseline, so an empty
    // role gets every other section and neither billing nor timeEntries. This
    // test is the tripwire: a financial code returning to the baseline turns it
    // red on purpose.
    const member = await memberWith(firm.id, []);

    const res = await summary(member);

    expect(res.body.permissions).toEqual({
      matters: true,
      tasks: true,
      messaging: true,
      members: true,
      signatures: true,
      billing: false,
      timeEntries: false,
      calendar: true,
      clients: true,
    });
  });

  it('returns every stat key as a number and no section errors on a healthy firm', async () => {
    const res = await summary(owner);

    expect(res.status).toBe(200);
    expect(res.body.sectionErrors).toEqual({});
    // Every key is a NUMBER, never null: a null here means the section did not
    // run, which for a fully permissioned owner is a regression.
    for (const key of [
      'openMatters', 'totalMatters', 'closedMatters',
      'pendingTasks', 'completedTasks', 'totalTasks', 'upcomingDeadlines', 'overdueTasks',
      'unreadMessages', 'conversationCount', 'teamSize',
      'outstandingArCents', 'overdueInvoiceCents', 'overdueInvoiceCount',
      'collectedThisMonthCents', 'unbilledWipCents', 'unbilledHours',
      'hoursToday', 'hoursThisWeek',
    ]) {
      expect(typeof res.body.stats[key]).toBe('number');
    }
  });

  it('requires the timezone header the day windows resolve against', async () => {
    const res = await owner.api.get(`/api/lawfirms/${firm.id}/dashboard-summary`).set('x-timezone', '');

    expect(res.status).toBe(400);
  });
});
