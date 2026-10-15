/**
 * The combined calendar feed: one request answering the five range reads the
 * calendar used to make separately.
 *
 * The feed's whole promise is that it is NOT a new read. Each section must be
 * byte-for-byte what its standalone endpoint answers for the same window, so
 * every visibility rule those endpoints apply (matter membership on matter
 * events, the syncing member's own external events, the task ethical wall,
 * accessible matters on payment dates) carries over without being restated.
 * The parity cases below compare the feed against the real standalone routes,
 * for an owner and for a plain member, so a section that re-implemented its
 * query and dropped a filter goes red here.
 *
 * Permissions degrade per section. A caller who cannot read one dataset gets
 * `null` for it and the rest of the calendar still renders. Every one of the
 * four of the five codes are in DEFAULT_PERMISSIONS today, so no real role can
 * lack one of those; the cases take such a code out of the baseline for their
 * duration, which is the state a future baseline change would put a member in,
 * and prove the standalone route refuses that same member. `billing.viewInvoices`
 * is not baseline, so a member whose role grants nothing already lacks it.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  createPersonClient,
  ownerOf,
  memberWith,
  stranger,
  drainEvents,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { DEFAULT_PERMISSIONS } from '../../src/modules/lawfirms/roles/permissions';

const TZ = 'America/New_York';
const FROM = '2026-05-01';
const TO = '2026-05-31';

let firm: Firm;
let owner: Actor;
let rival: Firm;
let rivalOwner: Actor;

const base = (lawFirmId: string) => `/api/lawfirms/${lawFirmId}`;

const feed = (actor: Actor, lawFirmId: string = firm.id, query = `from=${FROM}&to=${TO}&tz=${TZ}`) =>
  actor.api.get(`${base(lawFirmId)}/calendar-feed?${query}`);

/** The five standalone reads, exactly as the calendar issues them. */
const standalone = {
  matterEvents: (actor: Actor, lawFirmId: string = firm.id) =>
    actor.api.get(`${base(lawFirmId)}/matters/events?from=${FROM}&to=${TO}&tz=${TZ}`),
  clientEvents: (actor: Actor, lawFirmId: string = firm.id) =>
    actor.api.get(`${base(lawFirmId)}/clients/events?from=${FROM}&to=${TO}&tz=${TZ}`),
  calendarEvents: (actor: Actor, lawFirmId: string = firm.id) =>
    actor.api.get(`${base(lawFirmId)}/calendar-events?from=${FROM}&to=${TO}&tz=${TZ}`),
  tasks: (actor: Actor, lawFirmId: string = firm.id) =>
    actor.api.get(`${base(lawFirmId)}/tasks?dueFrom=${FROM}&dueTo=${TO}&tz=${TZ}`),
  paymentDates: (actor: Actor, lawFirmId: string = firm.id) =>
    actor.api.get(`${base(lawFirmId)}/billing/invoices/calendar-payment-dates?from=${FROM}&to=${TO}`),
};

type Section = keyof typeof standalone;
const SECTIONS = Object.keys(standalone) as Section[];

/** The permission code each standalone route is gated on. */
const SECTION_PERMISSION: Record<Section, string> = {
  matterEvents: 'matters.view',
  clientEvents: 'clients.view',
  calendarEvents: 'calendar.view',
  tasks: 'tasks.view',
  paymentDates: 'billing.viewInvoices',
};

/**
 * Run `fn` with `codes` removed from the member baseline, restoring them after.
 *
 * `roles.service.ts` unions this exact array into every resolved permission
 * set, so removing a code in place is what a baseline without it would do.
 */
async function withoutBaseline(codes: string[], fn: () => Promise<void>) {
  const removed: Array<{ code: string; index: number }> = [];
  for (const code of codes) {
    const index = DEFAULT_PERMISSIONS.indexOf(code);
    // A code outside the baseline is already absent from every member's set.
    if (index < 0) continue;
    DEFAULT_PERMISSIONS.splice(index, 1);
    removed.unshift({ code, index });
  }
  try {
    await fn();
  } finally {
    for (const { code, index } of removed) DEFAULT_PERMISSIONS.splice(index, 0, code);
  }
}

/**
 * One of everything the calendar draws, inside the window, for `lawFirmId`.
 * `label` prefixes every title so a cross-firm leak is findable by text.
 */
async function seedWorld(lawFirmId: string, actor: Actor, label: string) {
  const client = await createPersonClient(lawFirmId, { name: `${label} Client` });

  const matter = await actor.api.post(`${base(lawFirmId)}/matters`).send({
    name: `${label} Matter`, clients: [{ clientId: client.id, name: `${label} Client` }],
  });
  expect(matter.status).toBe(201);
  const matterId = matter.body.matterId as string;

  const matterEvent = await actor.api.post(`${base(lawFirmId)}/matters/${matterId}/events`).send({
    type: 'hearing', title: `${label} Hearing`, date: '2026-05-10', allDay: true,
  });
  expect(matterEvent.status).toBe(201);

  const clientEvent = await actor.api.post(`${base(lawFirmId)}/clients/${client.id}/events`).send({
    type: 'meeting', title: `${label} Client Meeting`, date: '2026-05-12', allDay: true,
  });
  expect(clientEvent.status).toBe(201);

  const external = await testPool.query(
    `insert into calendar_events
       (id, law_firm_id, title, starts_at, ends_at, all_day, provider, source, created_by)
     values ($1, $2, $3, '2026-05-14T15:00:00Z', '2026-05-14T16:00:00Z', false, 'google', 'external', $4)`,
    [randomUUID(), lawFirmId, `${label} Synced Event`, actor.uid],
  );
  expect(external.rowCount).toBe(1);

  const matterTask = await actor.api.post(`${base(lawFirmId)}/tasks`).send({
    title: `${label} Matter Task`, matterId, dueDate: '2026-05-15', allDay: true, skipCalendarEvent: true,
  });
  expect(matterTask.status).toBe(201);
  const firmTask = await actor.api.post(`${base(lawFirmId)}/tasks`).send({
    title: `${label} Firm Task`, dueDate: '2026-05-16', allDay: true, skipCalendarEvent: true,
  });
  expect(firmTask.status).toBe(201);

  const invoice = await testPool.query(
    `insert into invoices (id, law_firm_id, client_id, client_context_id, context_type,
                           invoice_number, status, total_cents, invoice_date, due_date, client_name)
     values ($1, $2, $3, $3, 'client', $4, 'outstanding', 125000, '2026-05-01', '2026-05-20', $5)`,
    [randomUUID(), lawFirmId, client.id, `${label}-INV-1`, `${label} Client`],
  );
  expect(invoice.rowCount).toBe(1);

  await drainEvents();
  return { matterId, clientId: client.id };
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  rival = await createFirm();
  rivalOwner = await ownerOf(rival.id);
});

describe('spanning tasks', () => {
  it('includes an all-day task that starts before the window in the feed and fallback read', async () => {
    const createTask = async (title: string, dueDate: string, endsAt: string, allDay = true) => {
      const res = await owner.api.post(`${base(firm.id)}/tasks`).send({ title, dueDate, endsAt, allDay });
      expect(res.status).toBe(201);
      return res.body.taskId as string;
    };
    const spanning = await createTask('Spanning', '2026-04-01', '2026-06-01');
    await createTask('Ends at boundary', '2026-04-01', FROM);
    await createTask('Starts after window', '2026-06-01', '2026-06-03');
    const timedSpanning = await createTask('Timed start outside window', '2026-04-01T13:00', '2026-06-01T14:00', false);
    const rivalTask = await rivalOwner.api.post(`${base(rival.id)}/tasks`).send({ title: 'RIVAL span', dueDate: '2026-04-01', endsAt: '2026-06-01', allDay: true });
    expect(rivalTask.status).toBe(201);

    const combined = await feed(owner);
    const fallback = await owner.api.get(`${base(firm.id)}/tasks?dueFrom=${FROM}&dueTo=${TO}&includeSpanning=true&tz=${TZ}`);
    expect(combined.status).toBe(200);
    expect(fallback.status).toBe(200);
    const ids = (tasks: { taskId: string }[]) => tasks.map((t) => t.taskId).sort();
    expect(ids(combined.body.tasks.tasks)).toEqual([spanning, timedSpanning].sort());
    expect(ids(fallback.body.tasks)).toEqual([spanning, timedSpanning].sort());
    const dueOnly = await standalone.tasks(owner);
    expect(dueOnly.status).toBe(200);
    expect(dueOnly.body.tasks).toEqual([]);
  });
});

describe('timed spanning tasks', () => {
  /**
   * The window opens at midnight on May 1 in the caller's zone (New York),
   * which is 04:00 UTC. A timed task that started in April is on the calendar
   * if it is still running after that moment. Goes red if timed spans are left
   * out, or if the window start is read as UTC midnight: the task ending at
   * 23:30 on April 30 New York time (03:30 UTC on May 1) would then be shown.
   */
  it('includes a timed task running into the window, judged in the caller zone', async () => {
    const createTimed = async (title: string, dueDate: string, endsAt: string) => {
      const res = await owner.api.post(`${base(firm.id)}/tasks`).set('x-timezone', TZ)
        .send({ title, dueDate, endsAt, allDay: false });
      expect(res.status).toBe(201);
      return res.body.taskId as string;
    };
    const runsIn = await createTimed('Overnight filing', '2026-04-30T22:00', '2026-05-01T00:30');
    await createTimed('Done before midnight', '2026-04-30T22:00', '2026-04-30T23:30');
    await createTimed('Ends at the window start', '2026-04-30T22:00', '2026-05-01T00:00');
    const rivalTask = await rivalOwner.api.post(`${base(rival.id)}/tasks`).set('x-timezone', TZ)
      .send({ title: 'RIVAL overnight', dueDate: '2026-04-30T22:00', endsAt: '2026-05-01T00:30', allDay: false });
    expect(rivalTask.status).toBe(201);

    const combined = await feed(owner);
    const fallback = await owner.api.get(`${base(firm.id)}/tasks?dueFrom=${FROM}&dueTo=${TO}&includeSpanning=true&tz=${TZ}`);

    expect(combined.status).toBe(200);
    expect(fallback.status).toBe(200);
    expect(combined.body.tasks.tasks.map((t: { taskId: string }) => t.taskId)).toEqual([runsIn]);
    expect(fallback.body.tasks.map((t: { taskId: string }) => t.taskId)).toEqual([runsIn]);
  });
});

describe('another firm', () => {
  it('refuses a caller from another firm with the same status as the standalone reads', async () => {
    await seedWorld(firm.id, owner, 'HOME');

    const res = await feed(rivalOwner, firm.id);
    const original = await standalone.matterEvents(rivalOwner, firm.id);

    expect(original.status).toBe(403);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('HOME');
  });

  it('refuses a signed-in caller who belongs to no firm', async () => {
    const res = await feed(stranger(), firm.id);

    expect(res.status).toBe(403);
  });

  it('never returns another firm\'s rows in any section', async () => {
    await seedWorld(firm.id, owner, 'HOME');
    await seedWorld(rival.id, rivalOwner, 'RIVAL');

    const mine = await feed(owner);
    const theirs = await feed(rivalOwner, rival.id);

    expect(mine.status).toBe(200);
    expect(theirs.status).toBe(200);
    // Every section holds this firm's row, so the absence below is not vacuous.
    expect(mine.body.matterEvents.events.map((e: any) => e.title)).toEqual(['HOME Hearing']);
    expect(mine.body.clientEvents.events.map((e: any) => e.title)).toEqual(['HOME Client Meeting']);
    expect(mine.body.calendarEvents.events.map((e: any) => e.title)).toEqual(['HOME Synced Event']);
    expect(mine.body.tasks.tasks.map((t: any) => t.title).sort()).toEqual(['HOME Firm Task', 'HOME Matter Task']);
    expect(mine.body.paymentDates.paymentDates.length).toBeGreaterThan(0);
    expect(JSON.stringify(mine.body)).not.toContain('RIVAL');
    expect(JSON.stringify(theirs.body)).not.toContain('HOME');
  });
});

describe('parity with the standalone reads', () => {
  it('answers each section exactly as its own endpoint does, for the owner', async () => {
    await seedWorld(firm.id, owner, 'HOME');

    const res = await feed(owner);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([...SECTIONS].sort());
    for (const section of SECTIONS) {
      const original = await standalone[section](owner);
      expect(original.status).toBe(200);
      expect({ section, body: res.body[section] }).toEqual({ section, body: original.body });
    }
    expect(res.body.paymentDates.paymentDates.length).toBeGreaterThan(0);
  });

  it('applies each endpoint\'s own row visibility to a plain member', async () => {
    const { matterId } = await seedWorld(firm.id, owner, 'HOME');
    // A second matter the member is NOT on, with its own event and task, so the
    // matter wall has something to hide.
    const hidden = await owner.api.post(`${base(firm.id)}/matters`).send({ name: 'Walled Matter' });
    expect(hidden.status).toBe(201);
    expect((await owner.api.post(`${base(firm.id)}/matters/${hidden.body.matterId}/events`).send({
      type: 'hearing', title: 'Walled Hearing', date: '2026-05-11', allDay: true,
    })).status).toBe(201);
    expect((await owner.api.post(`${base(firm.id)}/tasks`).send({
      title: 'Walled Task', matterId: hidden.body.matterId, dueDate: '2026-05-17', allDay: true, skipCalendarEvent: true,
    })).status).toBe(201);

    const member = await memberWith(firm.id, ['billing.viewInvoices']);
    expect((await owner.api.post(`${base(firm.id)}/matters/${matterId}/members`)
      .send({ targetUserIds: [member.uid] })).status).toBe(200);
    await drainEvents();

    const res = await feed(member);

    expect(res.status).toBe(200);
    for (const section of SECTIONS) {
      const original = await standalone[section](member);
      expect(original.status).toBe(200);
      expect({ section, body: res.body[section] }).toEqual({ section, body: original.body });
    }
    // The member sees the matter they are on and not the walled one, and none of
    // the owner's personal synced calendar.
    expect(res.body.matterEvents.events.map((e: any) => e.title)).toEqual(['HOME Hearing']);
    expect(JSON.stringify(res.body)).not.toContain('Walled');
    expect(res.body.calendarEvents.events).toEqual([]);
  });
});

describe('per-section permissions', () => {
  it.each(SECTIONS)('answers null for %s alone when the caller lacks its permission', async (section) => {
    await seedWorld(firm.id, owner, 'HOME');
    // Holds the invoice read so the four other sections stay non-null, except
    // when payment dates is the section under test, which it must lack.
    const member = await memberWith(firm.id, section === 'paymentDates' ? [] : ['billing.viewInvoices']);

    await withoutBaseline([SECTION_PERMISSION[section]], async () => {
      const original = await standalone[section](member);
      const res = await feed(member);

      expect(original.status).toBe(403);
      expect(res.status).toBe(200);
      expect(res.body[section]).toBeNull();
      for (const other of SECTIONS.filter((s) => s !== section)) {
        expect({ other, value: res.body[other] }).not.toEqual({ other, value: null });
      }
    });
  });

  it('refuses a member who can read none of the five sections', async () => {
    const member = await memberWith(firm.id, []);

    await withoutBaseline(Object.values(SECTION_PERMISSION), async () => {
      const res = await feed(member);

      expect(res.status).toBe(403);
    });
  });
});

describe('the window', () => {
  it.each([
    ['a malformed day', `from=2026-13-01&to=${TO}&tz=${TZ}`],
    ['an impossible calendar date', `from=2026-02-30&to=${TO}&tz=${TZ}`],
    ['a missing bound', `from=${FROM}&tz=${TZ}`],
    ['an inverted window', `from=${TO}&to=${FROM}&tz=${TZ}`],
  ])('rejects %s', async (_label, query) => {
    const res = await feed(owner, firm.id, query);

    expect(res.status).toBe(400);
  });

  it('rejects a malformed day the same way the standalone reads do', async () => {
    const original = await owner.api.get(`${base(firm.id)}/matters/events?from=2026-13-01&to=${TO}&tz=${TZ}`);

    expect(original.status).toBe(400);
    expect((await feed(owner, firm.id, `from=2026-13-01&to=${TO}&tz=${TZ}`)).status).toBe(400);
  });

  it('leaves out rows outside the window', async () => {
    await seedWorld(firm.id, owner, 'HOME');

    const res = await feed(owner, firm.id, `from=2026-06-01&to=2026-06-30&tz=${TZ}`);

    expect(res.status).toBe(200);
    expect(res.body.matterEvents.events).toEqual([]);
    expect(res.body.clientEvents.events).toEqual([]);
    expect(res.body.calendarEvents.events).toEqual([]);
    expect(res.body.tasks.tasks).toEqual([]);
    expect(res.body.paymentDates.paymentDates).toEqual([]);
  });
});
