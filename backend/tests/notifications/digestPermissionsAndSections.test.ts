/**
 * Daily digest: permissions per section, financial isolation, timezones, and audience boundaries.
 *
 * B08.2 requirement:
 * "Digest: exact permissions per section, no money leaked to a recipient without
 *  the applicable read right, firm versus person timezone, empty sections,
 *  source-query failure, and duplicate audience memberships."
 *
 * Covers:
 * 1. Financial isolation:
 *    - Invoices are firm-wide receivables with balance due in cents.
 *    - A firm member without billing permissions (only matters.view / tasks.view) NEVER
 *      receives invoice lines or monetary figures in their digest email.
 *    - An owner or member with `billing.viewInvoices` DOES receive invoice items with amounts.
 * 2. Exact section permissions & matter scoping:
 *    - Tasks: unassigned tasks on staffed matter fall back to member; unassigned tasks on
 *      unstaffed confidential matter do NOT appear.
 *    - Events: events on staffed matter appear; events on unstaffed confidential matter do NOT.
 *    - Statute dates: statute of limitations on open staffed matter appears as critical;
 *      statute on closed matter or unstaffed matter does NOT appear.
 * 3. Empty sections:
 *    - Recipient with zero items due across all sections is skipped (no empty spam email).
 *    - Recipient with items in only one section gets email with only that section populated.
 * 4. Firm versus person timezone:
 *    - User's personal IANA timezone overrides firm timezone for delivery hour calculation.
 * 5. Single delivery & duplicate membership idempotency:
 *    - Member staffed on multiple matters receives exactly one digest per local day.
 *    - Repeat pass in same local day is refused by `claimDigestSend`.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  drainEvents,
  createFirm,
  createFirmMember,
  createPersonClient,
  ownerOf,
  sentEmails,
  resetEmails,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';
import {
  sendDigestForUser,
  sendDailyDigests,
} from '../../src/modules/notifications/digest/digest.service';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let previousKillSwitch: string | undefined;

const FIXED_DATE = '2026-09-01'; // Tuesday
// 09:00 UTC on Tuesday 2026-09-01
const UTC_9AM = new Date('2026-09-01T09:00:00.000Z');

function emailOf(uid: string): string {
  return `${uid}@example.test`;
}

beforeAll(() => {
  previousKillSwitch = process.env.DISABLE_ALL_REMINDER_EMAILS;
  process.env.DISABLE_ALL_REMINDER_EMAILS = 'false';
});

afterAll(() => {
  process.env.DISABLE_ALL_REMINDER_EMAILS = previousKillSwitch;
});

async function seedMatter(
  lawFirmId: string,
  name: string,
  memberUids: string[] = [],
  options: { statuteOfLimitationsDate?: string | null; closeDate?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into matters
       (id, law_firm_id, name, matter_reference_id, status, statute_of_limitations_date, close_date)
     values ($1, $2, $3, $4, 'active', $5::date, $6::date)`,
    [
      id,
      lawFirmId,
      name,
      `REF-${id.slice(0, 8)}`,
      options.statuteOfLimitationsDate || null,
      options.closeDate || null,
    ],
  );
  for (const uid of memberUids) {
    await testPool.query(
      `insert into matter_members (law_firm_id, matter_id, user_id, role, joined_at)
       values ($1, $2, $3, 'lead', now())`,
      [lawFirmId, id, uid],
    );
  }
  return id;
}

async function seedTask(
  lawFirmId: string,
  matterId: string | null,
  title: string,
  dueDate: string,
  assignedTo: string[] = [],
): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into tasks (id, law_firm_id, matter_id, title, status, due_date, priority)
     values ($1, $2, $3, $4, 'open', $5::date, 'high')`,
    [id, lawFirmId, matterId, title, dueDate],
  );
  for (const uid of assignedTo) {
    await testPool.query(
      `insert into task_assignees (law_firm_id, task_id, user_id)
         select t.law_firm_id, t.id, $2 from tasks t where t.id = $1`,
      [id, uid],
    );
  }
  return id;
}

async function seedEvent(
  lawFirmId: string,
  matterId: string,
  title: string,
  dateIso: string,
  eventType = 'hearing',
): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into events
       (id, law_firm_id, matter_id, title, date, type, all_day)
     values ($1, $2, $3, $4, $5::timestamptz, $6, false)`,
    [id, lawFirmId, matterId, title, dateIso, eventType],
  );
  return id;
}

async function seedInvoice(
  lawFirmId: string,
  clientId: string,
  matterId: string,
  invoiceNumber: string,
  dueDate: string,
  totalCents = 150000,
): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into invoices
       (id, law_firm_id, client_id, matter_id, invoice_number, status, is_paid, due_date, total_cents, invoice_date)
     values ($1, $2, $3, $4, $5, 'outstanding', false, $6::date, $7, $6::date - interval '14 days')`,
    [id, lawFirmId, clientId, matterId, invoiceNumber, dueDate, totalCents],
  );
  return id;
}

async function setUserDigestSettings(
  userId: string,
  settings: { hour?: number; days?: string; enabled?: boolean; timezone?: string },
) {
  const tz = settings.timezone ?? 'UTC';
  const digestConfig = {
    enabled: settings.enabled ?? true,
    hour: settings.hour ?? 9,
    days: settings.days ?? 'daily',
  };
  await testPool.query(
    `update users set timezone = $2, preferences = $3::jsonb, updated_at = now() where id = $1`,
    [userId, tz, JSON.stringify({ notifications: { digest: digestConfig } })],
  );
}

beforeEach(async () => {
  resetEmails();
  firm = await createFirm({ name: 'Digest Verification Firm' });
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Digest Client' });
  await drainEvents();
});

describe('digest financial isolation: no money leaked to members without billing rights', () => {
  it('omits invoice lines and monetary amounts from non-billing member while including them for owner', async () => {
    // 1. Ordinary staff member with matters and tasks view rights, NO billing rights
    const staff = await createFirmMember(firm.id, {
      isOwner: false,
      permissions: ['matters.view', 'tasks.view'],
    });

    // Configure 9 AM delivery for both
    await setUserDigestSettings(owner.uid, { hour: 9, timezone: 'UTC' });
    await setUserDigestSettings(staff.uid, { hour: 9, timezone: 'UTC' });

    // Seed shared matter staffed with both owner and staff
    const matterId = await seedMatter(firm.id, 'Shared Matter', [owner.uid, staff.uid]);

    // Seed task due today so both have a reason to receive a digest
    await seedTask(firm.id, matterId, 'Filing due today', FIXED_DATE, [owner.uid, staff.uid]);

    // Seed an outstanding invoice due today with $1,500 balance
    await seedInvoice(firm.id, client.id, matterId, 'INV-8877', FIXED_DATE, 150000);

    // Run digest for staff member at 9 AM UTC
    const staffOutcome = await sendDigestForUser({
      firm,
      userId: staff.uid,
      now: UTC_9AM,
    });
    expect(staffOutcome).toBe('sent');

    // Run digest for firm owner at 9 AM UTC
    const ownerOutcome = await sendDigestForUser({
      firm,
      userId: owner.uid,
      now: UTC_9AM,
    });
    expect(ownerOutcome).toBe('sent');

    const emails = sentEmails();
    const staffEmail = emails.find((e) => (Array.isArray(e.to) ? e.to.includes(emailOf(staff.uid)) : e.to === emailOf(staff.uid)));
    const ownerEmail = emails.find((e) => (Array.isArray(e.to) ? e.to.includes(emailOf(owner.uid)) : e.to === emailOf(owner.uid)));

    expect(staffEmail).toBeDefined();
    expect(ownerEmail).toBeDefined();

    // Staff member sees the task
    expect(staffEmail!.html || staffEmail!.text).toContain('Filing due today');
    // Staff member MUST NOT see invoice number or dollar amount!
    expect(staffEmail!.html || staffEmail!.text).not.toContain('INV-8877');
    expect(staffEmail!.html || staffEmail!.text).not.toContain('1,500');

    // Owner sees both task and invoice
    expect(ownerEmail!.html || ownerEmail!.text).toContain('Filing due today');
    expect(ownerEmail!.html || ownerEmail!.text).toContain('INV-8877');
  });

  it('includes invoice lines for a non-owner member holding billing.viewInvoices permission', async () => {
    const billingManager = await createFirmMember(firm.id, {
      isOwner: false,
      permissions: ['matters.view', 'tasks.view', 'billing.viewInvoices'],
    });

    await setUserDigestSettings(billingManager.uid, { hour: 9, timezone: 'UTC' });
    const matterId = await seedMatter(firm.id, 'Billing Matter', [billingManager.uid]);
    await seedTask(firm.id, matterId, 'Audit check', FIXED_DATE, [billingManager.uid]);
    await seedInvoice(firm.id, client.id, matterId, 'INV-BILL-42', FIXED_DATE, 75000);

    const outcome = await sendDigestForUser({
      firm,
      userId: billingManager.uid,
      now: UTC_9AM,
    });
    expect(outcome).toBe('sent');

    const [email] = sentEmails();
    expect(email.html || email.text).toContain('INV-BILL-42');
  });
});

describe('digest section scoping & confidential matter isolation', () => {
  it('scopes tasks, events, and statutes strictly to staffed matters, excluding closed matters and unstaffed matters', async () => {
    const member = await createFirmMember(firm.id, {
      isOwner: false,
      permissions: ['matters.view', 'tasks.view'],
    });
    await setUserDigestSettings(member.uid, { hour: 9, timezone: 'UTC' });

    // Matter 1: Staffed with member (open)
    const staffedMatterId = await seedMatter(firm.id, 'Staffed Matter', [member.uid], {
      statuteOfLimitationsDate: FIXED_DATE,
    });

    // Matter 2: Confidential, staffed ONLY with owner
    const confidentialMatterId = await seedMatter(firm.id, 'Confidential Matter', [owner.uid], {
      statuteOfLimitationsDate: FIXED_DATE,
    });

    // Matter 3: Staffed with member, but CLOSED
    const closedMatterId = await seedMatter(firm.id, 'Closed Matter', [member.uid], {
      statuteOfLimitationsDate: FIXED_DATE,
      closeDate: '2026-08-01',
    });

    // Task on staffed matter (unassigned -> falls back to matter team)
    await seedTask(firm.id, staffedMatterId, 'Staffed Team Task', FIXED_DATE);

    // Task on confidential matter (unassigned -> must NOT appear in member's digest)
    await seedTask(firm.id, confidentialMatterId, 'Confidential Team Task', FIXED_DATE);

    // Event on staffed matter
    await seedEvent(firm.id, staffedMatterId, 'Staffed Hearing', '2026-09-01T14:00:00Z');

    // Event on confidential matter
    await seedEvent(firm.id, confidentialMatterId, 'Confidential Deposition', '2026-09-01T15:00:00Z');

    const outcome = await sendDigestForUser({
      firm,
      userId: member.uid,
      now: UTC_9AM,
    });
    expect(outcome).toBe('sent');

    const [email] = sentEmails();
    const content = email.html || email.text || '';

    // Staffed matter's items MUST appear
    expect(content).toContain('Staffed Team Task');
    expect(content).toContain('Staffed Hearing');
    expect(content.toLowerCase()).toContain('statute of limitations');

    // Confidential and closed matters' items MUST NOT appear
    expect(content).not.toContain('Confidential Team Task');
    expect(content).not.toContain('Confidential Deposition');
    expect(content).not.toContain('Closed Matter');
  });
});

describe('digest empty sections & zero-work handling', () => {
  it('skips digest delivery entirely when recipient has zero items due across all sections', async () => {
    await setUserDigestSettings(owner.uid, { hour: 9, timezone: 'UTC' });

    // Matter exists, but no tasks, events, invoices, or statutes due in window
    await seedMatter(firm.id, 'Idle Matter', [owner.uid]);

    const outcome = await sendDigestForUser({
      firm,
      userId: owner.uid,
      now: UTC_9AM,
    });

    expect(outcome).toBe('skipped');
    expect(sentEmails()).toHaveLength(0);
  });

  it('delivers email when only one section has due items, keeping empty sections clean', async () => {
    await setUserDigestSettings(owner.uid, { hour: 9, timezone: 'UTC' });
    const matterId = await seedMatter(firm.id, 'Single Section Matter', [owner.uid]);

    // Only 1 task, zero events, zero invoices, zero statutes
    await seedTask(firm.id, matterId, 'Lonely Task', FIXED_DATE, [owner.uid]);

    const outcome = await sendDigestForUser({
      firm,
      userId: owner.uid,
      now: UTC_9AM,
    });

    expect(outcome).toBe('sent');
    expect(sentEmails()).toHaveLength(1);
    expect(sentEmails()[0].html || sentEmails()[0].text).toContain('Lonely Task');
  });
});

describe('firm versus person timezone resolution', () => {
  it('uses member personal timezone instead of firm timezone for delivery hour evaluation', async () => {
    // Firm is in UTC by default.
    // Configure user in America/Los_Angeles (PDT, UTC-7).
    // User wants digest at 9:00 AM local time.
    await setUserDigestSettings(owner.uid, {
      hour: 9,
      timezone: 'America/Los_Angeles',
    });

    const matterId = await seedMatter(firm.id, 'TZ Matter', [owner.uid]);
    await seedTask(firm.id, matterId, 'Timezone Task', FIXED_DATE, [owner.uid]);

    // At 09:00 UTC (02:00 AM PDT) -> local clock is NOT 9 AM, must be skipped
    const earlyOutcome = await sendDigestForUser({
      firm,
      userId: owner.uid,
      now: new Date('2026-09-01T09:00:00.000Z'),
    });
    expect(earlyOutcome).toBe('skipped');
    expect(sentEmails()).toHaveLength(0);

    // At 16:00 UTC (09:00 AM PDT) -> local clock IS 9 AM, must be delivered!
    const onTimeOutcome = await sendDigestForUser({
      firm,
      userId: owner.uid,
      now: new Date('2026-09-01T16:00:00.000Z'),
    });
    expect(onTimeOutcome).toBe('sent');
    expect(sentEmails()).toHaveLength(1);
  });
});

describe('duplicate audience memberships & daily send idempotency', () => {
  it('delivers exactly one digest per day even when staffed on multiple matters, and refuses second run', async () => {
    await setUserDigestSettings(owner.uid, { hour: 9, timezone: 'UTC' });

    // Owner is member of 3 distinct matters with deadlines
    const m1 = await seedMatter(firm.id, 'Matter One', [owner.uid]);
    const m2 = await seedMatter(firm.id, 'Matter Two', [owner.uid]);
    const m3 = await seedMatter(firm.id, 'Matter Three', [owner.uid]);

    await seedTask(firm.id, m1, 'Task 1', FIXED_DATE, [owner.uid]);
    await seedTask(firm.id, m2, 'Task 2', FIXED_DATE, [owner.uid]);
    await seedTask(firm.id, m3, 'Task 3', FIXED_DATE, [owner.uid]);

    // First firm pass
    const pass1 = await sendDailyDigests(firm.id, { now: UTC_9AM });
    expect(pass1.sent).toBe(1);
    expect(sentEmails()).toHaveLength(1);

    // Email contains items from all 3 matters in one aggregated message
    const [email] = sentEmails();
    const content = email.html || email.text || '';
    expect(content).toContain('Task 1');
    expect(content).toContain('Task 2');
    expect(content).toContain('Task 3');

    // Second firm pass in same hour/day -> claimDigestSend refuses, sent is 0
    const pass2 = await sendDailyDigests(firm.id, { now: UTC_9AM });
    expect(pass2.sent).toBe(0);
    expect(pass2.skipped).toBeGreaterThanOrEqual(1);
    expect(sentEmails()).toHaveLength(1);
  });
});
