/**
 * The billing workbench router's three untested routes.
 *
 * `workbench.routes.ts` mounts five endpoints on
 * `/api/lawfirms/:lawFirmId/billing`. `GET /workbench` is already covered by
 * firmBillingWindow.test.ts (the pure window/filter predicates) and
 * firmBillingPrefilter.test.ts (the SQL pre-filter superset property). The other
 * three had nothing.
 *
 * WHY EACH MATTERS
 *
 *   GET /unbilled-work is the list a firm bills FROM. Work wrongly missing from
 *   it is money that is never invoiced; work wrongly present gets captured
 *   twice. Read the service before writing a fixture: the list is NOT time
 *   entries, flat fees and expenses. It is COMPLETED TASKS that no time entry
 *   has been recorded against yet (`listFirmUnbilledWork`), plus a placeholder
 *   for calendar-event work that is `eventCount: 0` until matterEvents is
 *   ported. The "already captured" signal is a `time_entries.source_task_id`
 *   pointing back at the task, exactly as the freeze signal elsewhere in billing
 *   is an `invoice_line_items` row rather than a `billed` flag. A fixture that
 *   set some flag on the task would prove nothing.
 *
 *   GET / PUT /settings are the firm's billing defaults, stored in the
 *   `law_firms.settings -> 'billing'` jsonb sub-object rather than a table. The
 *   write is a read-modify-write merge, so the failure mode is not a wrong value
 *   but a WIPED one: a PUT that replaced the sub-object would silently discard
 *   the late-fee, tax and time-rounding config the settings module owns, and
 *   nothing on screen would say so. That merge, and the fact this route applies
 *   only `clientPaymentEmails`, are what the cases below pin.
 *
 *   GET /utbms-codes is static reference data compiled into
 *   `shared/data/utbmsCodes.ts`. It is GLOBAL, not firm-scoped, and the point of
 *   pinning that is so a later "let firms customize their codes" change has to
 *   confront a test rather than quietly change what every firm sees.
 *
 * PERMISSIONS: explicit-grant read, gated write. `billing.viewInvoices` and
 * `billing.viewTimeEntries` are NOT in DEFAULT_PERMISSIONS, so a member whose
 * role grants nothing is refused all three reads, and a member holding the view
 * code can read but is still refused the write, which needs
 * `billing.manageInvoices`.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  createPersonClient,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

const { BILLING_SETTINGS_DEFAULTS } = require('../../src/modules/billing/shared/billingSettings');

let firm: Firm;
let owner: Actor;

const base = () => `/api/lawfirms/${firm.id}/billing`;

/* ------------------------------------------------------------------ */
/*  Fixtures, all plain SQL                                            */
/* ------------------------------------------------------------------ */

async function insertMatter(lawFirmId: string, name = 'Workbench Matter'): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id, status)
     values ($1, $2, $3, $4, 'active')`,
    [id, lawFirmId, name, `REF-${id.slice(0, 8)}`],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

async function addMatterMember(lawFirmId: string, matterId: string, uid: string): Promise<void> {
  const res = await testPool.query(
    `insert into matter_members (law_firm_id, matter_id, user_id, role, joined_at)
     values ($1, $2, $3, 'lead', now())`,
    [lawFirmId, matterId, uid],
  );
  expect(res.rowCount).toBe(1);
}

async function attachClientToMatter(lawFirmId: string, matterId: string, clientId: string): Promise<void> {
  const res = await testPool.query(
    `insert into matter_clients (matter_id, client_id, law_firm_id) values ($1, $2, $3)`,
    [matterId, clientId, lawFirmId],
  );
  expect(res.rowCount).toBe(1);
}

/**
 * A task. `updated_at` is set explicitly because it is the value the service
 * uses as the item's `date` and therefore its sort key, and the schema's
 * `set_updated_at` trigger is BEFORE UPDATE only, so an insert keeps what it is
 * given.
 */
async function insertTask(
  lawFirmId: string,
  overrides: {
    title?: string;
    status?: string;
    matterId?: string | null;
    updatedAt?: string;
    description?: string;
  } = {},
): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into tasks (id, law_firm_id, title, description, status, matter_id, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz)`,
    [
      id,
      lawFirmId,
      overrides.title ?? 'Draft the settlement letter',
      overrides.description ?? '',
      overrides.status ?? 'completed',
      overrides.matterId ?? null,
      overrides.updatedAt ?? '2026-05-01T12:00:00.000Z',
    ],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

async function attachClientToTask(taskId: string, clientId: string): Promise<void> {
  const res = await testPool.query(
    `insert into task_clients (law_firm_id, task_id, client_id)
         select t.law_firm_id, t.id, $2 from tasks t where t.id = $1`,
    [taskId, clientId],
  );
  expect(res.rowCount).toBe(1);
}

/**
 * Record time against a task, which is what makes the task "captured" and drops
 * it off the unbilled list. `source_task_id` is the signal; nothing on the task
 * itself records it.
 */
async function captureTimeFor(lawFirmId: string, taskId: string | null): Promise<string> {
  const id = randomUUID();
  // A time entry needs exactly one context (schema check: matter XOR client), so
  // it gets a throwaway client. The context is irrelevant to the capture rule,
  // which reads `source_task_id` alone.
  const client = await createPersonClient(lawFirmId, { name: `Timekeeping client ${id.slice(0, 6)}` });
  const res = await testPool.query(
    `insert into activities (kind, id, law_firm_id, client_id, activity_date, hours, description, source_task_id)
     values ('time', $1, $2, $3, current_date, 1.5, 'Time recorded', $4)`,
    [id, lawFirmId, client.id, taskId],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

/** The stored settings blob, the only place the merge is observable. */
async function storedSettings(lawFirmId: string): Promise<any> {
  const { rows } = await testPool.query('select settings from law_firms where id = $1', [lawFirmId]);
  return rows[0]?.settings;
}

async function seedSettings(lawFirmId: string, settings: Record<string, unknown>): Promise<void> {
  const res = await testPool.query(
    'update law_firms set settings = $2::jsonb where id = $1',
    [lawFirmId, JSON.stringify(settings)],
  );
  expect(res.rowCount).toBe(1);
}

const itemIds = (body: any): string[] => body.items.map((item: any) => item.id);

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

/* ------------------------------------------------------------------ */
/*  GET /unbilled-work                                                 */
/* ------------------------------------------------------------------ */

describe('GET /billing/unbilled-work', () => {
  /**
   * Red if the item identity changes: the `task:` id prefix the frontend keys
   * on, the workType discriminator, the source label, or the summary counters.
   */
  it('lists a completed firm-scoped task with its identity fields and counts', async () => {
    const taskId = await insertTask(firm.id, { title: 'File the appearance', updatedAt: '2026-05-04T15:00:00.000Z' });

    const res = await owner.api.get(`${base()}/unbilled-work`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      id: `task:${taskId}`,
      workType: 'task',
      taskId,
      eventId: null,
      title: 'File the appearance',
      sourceLabel: 'Completed task',
      matterId: null,
      matterName: null,
      clientId: null,
      date: '2026-05-04T15:00:00.000Z',
    });
    expect(res.body.summary).toEqual({ totalCount: 1, taskCount: 1, eventCount: 0 });
    expect(res.body.totalItems).toBe(1);
  });

  /**
   * Red if the `status: 'completed'` argument is dropped from the tasks read.
   * Open work on this list is work a firm would bill before it is done.
   */
  it('omits tasks that are not completed', async () => {
    const done = await insertTask(firm.id, { title: 'Done', status: 'completed' });
    await insertTask(firm.id, { title: 'Still open', status: 'open' });
    await insertTask(firm.id, { title: 'In progress', status: 'in_progress' });

    const res = await owner.api.get(`${base()}/unbilled-work`);

    expect(res.status).toBe(200);
    expect(itemIds(res.body)).toEqual([`task:${done}`]);
  });

  /**
   * The double-billing guard. Red if the `capturedSourceIds` filter is removed
   * or inverted. The sibling task with an unrelated time entry proves the filter
   * keys on the LINK and not on "the firm has any time entries", which a broken
   * implementation could also satisfy.
   */
  it('drops a completed task once a time entry points back at it', async () => {
    const captured = await insertTask(firm.id, { title: 'Already captured' });
    const uncaptured = await insertTask(firm.id, { title: 'Not captured' });
    await captureTimeFor(firm.id, captured);
    // Firm time that names no task at all must not hide anything.
    await captureTimeFor(firm.id, null);

    const res = await owner.api.get(`${base()}/unbilled-work`);

    expect(res.status).toBe(200);
    expect(itemIds(res.body)).toEqual([`task:${uncaptured}`]);
    expect(res.body.summary.totalCount).toBe(1);
  });

  /**
   * Matter work is visible only to the matter's members, and a firm OWNER is no
   * exception here: `listFirmUnbilledWork` reads tasks without `seeAll`. Red if
   * the membership predicate is dropped (an owner would then see, and bill,
   * work on matters they are walled off from) or if it starts excluding
   * firm-scoped tasks, which belong to everyone.
   */
  it('shows matter work only for matters the caller is on', async () => {
    const mine = await insertMatter(firm.id, 'My Matter');
    const theirs = await insertMatter(firm.id, 'Walled-off Matter');
    await addMatterMember(firm.id, mine, owner.uid);

    const onMine = await insertTask(firm.id, { title: 'Mine', matterId: mine });
    const onTheirs = await insertTask(firm.id, { title: 'Theirs', matterId: theirs });
    const firmWide = await insertTask(firm.id, { title: 'Firm wide' });

    const res = await owner.api.get(`${base()}/unbilled-work`);

    expect(res.status).toBe(200);
    const ids = itemIds(res.body);
    expect(ids).toContain(`task:${onMine}`);
    expect(ids).toContain(`task:${firmWide}`);
    expect(ids).not.toContain(`task:${onTheirs}`);
    expect(res.body.summary.totalCount).toBe(2);
  });

  /**
   * The item has to say WHO the work is for or the firm cannot decide which
   * invoice it belongs on. Red if the matter join or the client resolution is
   * lost, which would leave a list of unattributable line items.
   */
  it('carries the matter and client of matter work', async () => {
    const matterId = await insertMatter(firm.id, 'Acme v. Globex');
    await addMatterMember(firm.id, matterId, owner.uid);
    const client = await createPersonClient(firm.id, { name: 'Wile E. Coyote' });
    await attachClientToMatter(firm.id, matterId, client.id);
    const taskId = await insertTask(firm.id, { title: 'Depose the roadrunner', matterId });

    const res = await owner.api.get(`${base()}/unbilled-work`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      id: `task:${taskId}`,
      matterId,
      matterName: 'Acme v. Globex',
      clientId: client.id,
      clientName: 'Wile E. Coyote',
    });
  });

  /** Red if the sort comparator is dropped or reversed. */
  it('orders newest work first', async () => {
    const oldest = await insertTask(firm.id, { title: 'Oldest', updatedAt: '2026-01-02T10:00:00.000Z' });
    const newest = await insertTask(firm.id, { title: 'Newest', updatedAt: '2026-06-30T10:00:00.000Z' });
    const middle = await insertTask(firm.id, { title: 'Middle', updatedAt: '2026-03-15T10:00:00.000Z' });

    const res = await owner.api.get(`${base()}/unbilled-work`);

    expect(res.status).toBe(200);
    expect(itemIds(res.body)).toEqual([`task:${newest}`, `task:${middle}`, `task:${oldest}`]);
  });

  /**
   * Paging is opt-in and must never shrink the reported total: a firm reading
   * "3 items of unbilled work" off a paged response would stop chasing the rest.
   * Red if `totalItems` starts reporting the slice length, if the summary is
   * computed after the slice, or if paging stops applying.
   */
  it('pages the items while still counting the whole set', async () => {
    const newest = await insertTask(firm.id, { title: 'A', updatedAt: '2026-06-30T10:00:00.000Z' });
    await insertTask(firm.id, { title: 'B', updatedAt: '2026-05-30T10:00:00.000Z' });
    const third = await insertTask(firm.id, { title: 'C', updatedAt: '2026-04-30T10:00:00.000Z' });

    const first = await owner.api.get(`${base()}/unbilled-work?limit=1`);
    expect(first.status).toBe(200);
    expect(itemIds(first.body)).toEqual([`task:${newest}`]);
    expect(first.body.totalItems).toBe(3);
    expect(first.body.summary.totalCount).toBe(3);

    const third_page = await owner.api.get(`${base()}/unbilled-work?limit=1&page=3`);
    expect(third_page.status).toBe(200);
    expect(itemIds(third_page.body)).toEqual([`task:${third}`]);
    expect(third_page.body.totalItems).toBe(3);
  });

  /** Red if the limit bound is widened or removed; 200 is above the cap. */
  it('rejects an out-of-range limit', async () => {
    const res = await owner.api.get(`${base()}/unbilled-work?limit=500`);
    expect(res.status).toBe(400);
  });

  /**
   * Tenant isolation. The other firm's work is seeded firm-scoped on purpose, so
   * it needs no matter membership and WOULD appear the moment the law_firm_id
   * predicate is lost. Both halves are asserted: absent for this firm, present
   * for its own owner, so an empty world cannot pass this.
   */
  it('never shows another firm\'s unbilled work', async () => {
    const other = await createFirm();
    const otherOwner = await ownerOf(other.id);
    const otherTask = await insertTask(other.id, { title: 'Their work' });
    const mine = await insertTask(firm.id, { title: 'My work' });

    const res = await owner.api.get(`${base()}/unbilled-work`);
    expect(res.status).toBe(200);
    expect(itemIds(res.body)).toEqual([`task:${mine}`]);

    const theirs = await otherOwner.api.get(`/api/lawfirms/${other.id}/billing/unbilled-work`);
    expect(theirs.status).toBe(200);
    expect(itemIds(theirs.body)).toEqual([`task:${otherTask}`]);

    const crossFirm = await owner.api.get(`/api/lawfirms/${other.id}/billing/unbilled-work`);
    expect(crossFirm.status).toBe(403);
  });

  /**
   * Financial read needs an explicit grant. Red if the gate is dropped or moved
   * to a code in DEFAULT_PERMISSIONS, which would expose the unbilled list to a
   * member whose role grants nothing.
   */
  it('refuses a member whose role grants nothing', async () => {
    await insertTask(firm.id, { title: 'Visible work' });

    const emptyRole = await memberWith(firm.id, []);
    const res = await emptyRole.api.get(`${base()}/unbilled-work`);

    expect(res.status).toBe(403);
  });

  /**
   * The whole response body for a firm that has some of everything: two
   * matters (one the caller is walled off from), two clients, four completed
   * tasks of which one is already captured, and one task still open.
   *
   * Every other case here asserts one field with `toMatchObject`, which is blind
   * to a field that appears, disappears or changes shape beside the one it
   * names. This one is `toEqual` on the entire body, so it is the case that goes
   * red if the reads behind this list are restaged and any part of what comes
   * back moves: a dropped key, a new key, a renamed summary counter, a
   * re-ordered list, or a client name resolved from a different source.
   */
  it('returns exactly this body for a firm with matters, clients, captured and open work', async () => {
    const myMatter = await insertMatter(firm.id, 'Acme v. Globex');
    await addMatterMember(firm.id, myMatter, owner.uid);
    const walledOff = await insertMatter(firm.id, 'Initech v. Umbrella');

    const matterClient = await createPersonClient(firm.id, { name: 'Wile E. Coyote' });
    await attachClientToMatter(firm.id, myMatter, matterClient.id);
    const taskClient = await createPersonClient(firm.id, { name: 'Roadrunner Holdings' });

    const onMatter = await insertTask(firm.id, {
      title: 'Depose the roadrunner',
      description: 'Half a day, downtown',
      matterId: myMatter,
      updatedAt: '2026-05-04T15:00:00.000Z',
    });
    const firmWide = await insertTask(firm.id, {
      title: 'Reconcile the trust ledger',
      updatedAt: '2026-05-02T09:30:00.000Z',
    });
    await attachClientToTask(firmWide, taskClient.id);
    const captured = await insertTask(firm.id, {
      title: 'Already billed for this',
      updatedAt: '2026-05-06T11:00:00.000Z',
    });
    await captureTimeFor(firm.id, captured);
    await insertTask(firm.id, {
      title: 'Not mine to see',
      matterId: walledOff,
      updatedAt: '2026-05-05T11:00:00.000Z',
    });
    await insertTask(firm.id, { title: 'Still open', status: 'open', updatedAt: '2026-05-07T11:00:00.000Z' });

    const res = await owner.api.get(`${base()}/unbilled-work`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      summary: { totalCount: 2, taskCount: 2, eventCount: 0 },
      items: [
        {
          id: `task:${onMatter}`,
          workType: 'task',
          taskId: onMatter,
          eventId: null,
          title: 'Depose the roadrunner',
          details: 'Half a day, downtown',
          matterId: myMatter,
          matterName: 'Acme v. Globex',
          clientId: matterClient.id,
          clientName: 'Wile E. Coyote',
          date: '2026-05-04T15:00:00.000Z',
          sourceLabel: 'Completed task',
        },
        {
          id: `task:${firmWide}`,
          workType: 'task',
          taskId: firmWide,
          eventId: null,
          title: 'Reconcile the trust ledger',
          details: '',
          matterId: null,
          matterName: null,
          clientId: taskClient.id,
          clientName: 'Roadrunner Holdings',
          date: '2026-05-02T09:30:00.000Z',
          sourceLabel: 'Completed task',
        },
      ],
      totalItems: 2,
    });
  });

  /**
   * The firm-clients read is the OTHER source of an item's client name: the task
   * read carries `clientNames` from its own join, and `clientNameMap`, built from
   * `listFirmClients`, is the fallback for when that name is blank. Nothing else
   * in this file reaches it, so without this case the firm-clients read could be
   * dropped or left unscoped and every assertion here would still pass.
   *
   * A blank `clients.name` is what makes the fallback observable: the column is
   * NOT NULL, so an empty string is the only value that is falsy enough to fall
   * through. Red if the firm-clients read stops feeding the map, or if the map
   * stops preferring the client's email over its raw id.
   */
  it('falls back to the firm client list for the name of a blank-named client', async () => {
    const blank = await createPersonClient(firm.id, { name: '', email: 'billing@roadrunner.test' });
    const taskId = await insertTask(firm.id, { title: 'Chase the invoice' });
    await attachClientToTask(taskId, blank.id);

    const res = await owner.api.get(`${base()}/unbilled-work`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].clientId).toBe(blank.id);
    expect(res.body.items[0].clientName).toBe('billing@roadrunner.test');
  });
});

/* ------------------------------------------------------------------ */
/*  GET /settings                                                      */
/* ------------------------------------------------------------------ */

describe('GET /billing/settings', () => {
  /**
   * A firm that has never saved gets the full default blob, not `{}`. Red if a
   * default is dropped or its value flipped: `clientPaymentEmails` defaulting
   * to false would silently stop every client receipt, and `timeRounding`
   * defaulting to on would alter recorded hours nobody asked to round.
   */
  it('returns the full default blob for a firm that never saved any', async () => {
    const res = await owner.api.get(`${base()}/settings`);

    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({
      clientPaymentEmails: true,
      timeRounding: { enabled: false, incrementMinutes: 6 },
      lateFee: { enabled: false, flatAmount: 0, percent: 0, graceDays: 0, autoApply: false },
      tax: { enabled: false, defaultRate: 0, label: 'Tax' },
      processingFees: { card: 'firm', bank: 'firm' },
      cardFees: { debitCards: 'absorb', internationalCards: 'absorb', ratePercent: 2.9, fixedCents: 30, confirmation: null },
    });
    // The defaults the rest of the app reads are the same object, so a change
    // there has to come through this response too.
    expect(res.body.settings).toEqual(BILLING_SETTINGS_DEFAULTS);
    // Nothing was written by a read.
    expect(await storedSettings(firm.id)).toEqual({});
  });

  /**
   * Stored values override the defaults and the untouched defaults survive. Red
   * if the merge order flips (defaults would win and a firm's configured late
   * fee would read as disabled) or if the defaults stop being merged (keys the
   * firm never saved would come back undefined).
   */
  it('merges stored overrides over the defaults', async () => {
    await seedSettings(firm.id, {
      billing: {
        clientPaymentEmails: false,
        lateFee: { enabled: true, flatAmount: 25, percent: 1.5, graceDays: 10, autoApply: true },
      },
    });

    const res = await owner.api.get(`${base()}/settings`);

    expect(res.status).toBe(200);
    expect(res.body.settings.clientPaymentEmails).toBe(false);
    expect(res.body.settings.lateFee).toEqual({
      enabled: true, flatAmount: 25, percent: 1.5, graceDays: 10, autoApply: true,
    });
    expect(res.body.settings.tax).toEqual({ enabled: false, defaultRate: 0, label: 'Tax' });
    expect(res.body.settings.timeRounding).toEqual({ enabled: false, incrementMinutes: 6 });
  });

  /**
   * A partial nested group stored by the firm-settings PUT reads back complete.
   * Red if the defaults merge is shallow again: the late-fee group would come
   * back as just `{ enabled: true }`, with no amounts, grace or auto-apply.
   */
  it('fills the late-fee fields a partial save left out, through the real settings write', async () => {
    const put = await owner.api
      .put(`/api/lawfirms/${firm.id}/settings/firm`)
      .send({ settings: { billing: { lateFee: { enabled: true } } } });
    expect(put.status).toBe(200);
    // The precondition: the stored group really is partial.
    expect((await storedSettings(firm.id)).billing.lateFee).toEqual({ enabled: true });

    const res = await owner.api.get(`${base()}/settings`);

    expect(res.status).toBe(200);
    expect(res.body.settings.lateFee).toEqual({
      enabled: true, flatAmount: 0, percent: 0, graceDays: 0, autoApply: false,
    });
  });

  it('fills partial tax and time-rounding groups the same way', async () => {
    await seedSettings(firm.id, {
      billing: { tax: { enabled: true, defaultRate: 8 }, timeRounding: { enabled: true } },
    });

    const res = await owner.api.get(`${base()}/settings`);

    expect(res.status).toBe(200);
    expect(res.body.settings.tax).toEqual({ enabled: true, defaultRate: 8, label: 'Tax' });
    expect(res.body.settings.timeRounding).toEqual({ enabled: true, incrementMinutes: 6 });
    // Untouched group still comes back whole.
    expect(res.body.settings.lateFee).toEqual(BILLING_SETTINGS_DEFAULTS.lateFee);
  });

  /** A stored group that is not an object reads as the defaults, not as `null`. */
  it('treats a non-object stored group as absent', async () => {
    await seedSettings(firm.id, { billing: { lateFee: null } });

    const res = await owner.api.get(`${base()}/settings`);

    expect(res.status).toBe(200);
    expect(res.body.settings.lateFee).toEqual(BILLING_SETTINGS_DEFAULTS.lateFee);
  });

  /**
   * Tenant isolation on the read: a second firm with the OPPOSITE stored value
   * so a lost predicate is visible rather than indistinguishable.
   */
  it('reads only this firm\'s settings', async () => {
    const other = await createFirm();
    const otherOwner = await ownerOf(other.id);
    await seedSettings(firm.id, { billing: { clientPaymentEmails: false } });
    await seedSettings(other.id, { billing: { clientPaymentEmails: true, tax: { enabled: true, defaultRate: 8, label: 'GST' } } });

    const mine = await owner.api.get(`${base()}/settings`);
    expect(mine.status).toBe(200);
    expect(mine.body.settings.clientPaymentEmails).toBe(false);
    expect(mine.body.settings.tax).toEqual({ enabled: false, defaultRate: 0, label: 'Tax' });

    const theirs = await otherOwner.api.get(`/api/lawfirms/${other.id}/billing/settings`);
    expect(theirs.status).toBe(200);
    expect(theirs.body.settings.clientPaymentEmails).toBe(true);
    expect(theirs.body.settings.tax).toEqual({ enabled: true, defaultRate: 8, label: 'GST' });

    const crossFirm = await owner.api.get(`/api/lawfirms/${other.id}/billing/settings`);
    expect(crossFirm.status).toBe(403);
  });

  /** Explicit-grant read, paired with the gated write two describes down. */
  it('refuses a member whose role grants nothing', async () => {
    const emptyRole = await memberWith(firm.id, []);

    const res = await emptyRole.api.get(`${base()}/settings`);

    expect(res.status).toBe(403);
  });
});

/* ------------------------------------------------------------------ */
/*  PUT /settings                                                      */
/* ------------------------------------------------------------------ */

describe('PUT /billing/settings', () => {
  /**
   * The round trip, asserted through the COLUMN as well as the two responses. A
   * response echoing the request back passes whether anything was persisted or
   * not.
   */
  it('persists the toggle and reads it back', async () => {
    const put = await owner.api.put(`${base()}/settings`).send({ clientPaymentEmails: false });

    expect(put.status).toBe(200);
    expect(put.body.settings.clientPaymentEmails).toBe(false);
    expect((await storedSettings(firm.id)).billing.clientPaymentEmails).toBe(false);

    const get = await owner.api.get(`${base()}/settings`);
    expect(get.status).toBe(200);
    expect(get.body.settings.clientPaymentEmails).toBe(false);

    const back = await owner.api.put(`${base()}/settings`).send({ clientPaymentEmails: true });
    expect(back.status).toBe(200);
    expect((await storedSettings(firm.id)).billing.clientPaymentEmails).toBe(true);
  });

  /**
   * The read-modify-write merge, which is the whole reason this write is not a
   * plain jsonb assignment. Red the moment the write replaces `settings` or
   * replaces `settings.billing`: the firm's late fee, tax rate and rounding
   * increment would be erased by someone toggling receipt emails, and the next
   * invoice would quietly carry no tax.
   */
  it('preserves the rest of the settings blob', async () => {
    await seedSettings(firm.id, {
      billing: {
        invoicePrefix: 'ACME',
        lateFee: { enabled: true, flatAmount: 25, percent: 1.5, graceDays: 10, autoApply: true },
        tax: { enabled: true, defaultRate: 8.25, label: 'Sales tax' },
      },
      storage: { warnAtPercent: 80 },
    });

    const res = await owner.api.put(`${base()}/settings`).send({ clientPaymentEmails: false });
    expect(res.status).toBe(200);

    const stored = await storedSettings(firm.id);
    expect(stored.billing.clientPaymentEmails).toBe(false);
    expect(stored.billing.invoicePrefix).toBe('ACME');
    expect(stored.billing.lateFee).toEqual({
      enabled: true, flatAmount: 25, percent: 1.5, graceDays: 10, autoApply: true,
    });
    expect(stored.billing.tax).toEqual({ enabled: true, defaultRate: 8.25, label: 'Sales tax' });
    expect(stored.storage).toEqual({ warnAtPercent: 80 });

    // And the response reflects the same merged blob, not just the one key.
    expect(res.body.settings.lateFee.flatAmount).toBe(25);
    expect(res.body.settings.tax.label).toBe('Sales tax');
  });

  /**
   * The PUT's response is built by the same merge. Red if setFirmBillingSettings
   * keeps its own shallow spread while the read is fixed.
   */
  it('answers with complete nested groups after a partial late-fee save', async () => {
    await seedSettings(firm.id, { billing: { lateFee: { enabled: true, flatAmount: 25 } } });

    const put = await owner.api.put(`${base()}/settings`).send({ clientPaymentEmails: false });

    expect(put.status).toBe(200);
    expect(put.body.settings.lateFee).toEqual({
      enabled: true, flatAmount: 25, percent: 0, graceDays: 0, autoApply: false,
    });
    // Nothing the client did not send was written back.
    expect((await storedSettings(firm.id)).billing.lateFee).toEqual({ enabled: true, flatAmount: 25 });
  });

  /**
   * This route owns exactly one key. The late fee and tax live behind the
   * settings module's own validation (bounds on `flatAmount`, `percent`,
   * `graceDays`), and letting them through here would be an unvalidated side
   * door into the same blob. Red if the handler starts merging `req.body`
   * wholesale.
   */
  it('ignores keys it does not own', async () => {
    await seedSettings(firm.id, {
      billing: { lateFee: { enabled: false, flatAmount: 0, percent: 0, graceDays: 0, autoApply: false } },
    });

    const res = await owner.api.put(`${base()}/settings`).send({
      clientPaymentEmails: false,
      lateFee: { enabled: true, flatAmount: 999999, percent: 90, graceDays: 0, autoApply: true },
      tax: { enabled: true, defaultRate: 99 },
    });

    expect(res.status).toBe(200);
    const stored = await storedSettings(firm.id);
    expect(stored.billing.clientPaymentEmails).toBe(false);
    expect(stored.billing.lateFee).toEqual({
      enabled: false, flatAmount: 0, percent: 0, graceDays: 0, autoApply: false,
    });
    expect(stored.billing.tax).toBeUndefined();
  });

  /**
   * A non-boolean is refused, and refused BEFORE anything is written. Asserting
   * the status alone would pass against a handler that wrote first and rejected
   * afterwards.
   */
  it('rejects a non-boolean toggle without writing', async () => {
    await seedSettings(firm.id, { billing: { clientPaymentEmails: true } });

    const res = await owner.api.put(`${base()}/settings`).send({ clientPaymentEmails: 'yes' });

    expect(res.status).toBe(400);
    expect((await storedSettings(firm.id)).billing.clientPaymentEmails).toBe(true);
  });

  /**
   * An empty body is a no-op patch, not a wipe. Red if the service started
   * writing `undefined` for an unsent key.
   */
  it('treats an empty body as a no-op', async () => {
    await seedSettings(firm.id, { billing: { clientPaymentEmails: false, invoicePrefix: 'ACME' } });

    const res = await owner.api.put(`${base()}/settings`).send({});

    expect(res.status).toBe(200);
    expect(res.body.settings.clientPaymentEmails).toBe(false);
    const stored = await storedSettings(firm.id);
    expect(stored.billing.clientPaymentEmails).toBe(false);
    expect(stored.billing.invoicePrefix).toBe('ACME');
  });

  /**
   * The gated half of the design. A member who may READ the settings may not
   * change them, and the refusal is checked against the column: a route that
   * wrote and then returned 403 would pass a status-only assertion.
   */
  it('refuses a member who can read the settings but not manage invoices', async () => {
    // Holds `billing.viewInvoices` (enough to GET this endpoint) and nothing more.
    const reader = await memberWith(firm.id, ['billing.viewInvoices']);
    expect((await reader.api.get(`${base()}/settings`)).status).toBe(200);

    const refused = await reader.api.put(`${base()}/settings`).send({ clientPaymentEmails: false });
    expect(refused.status).toBe(403);
    expect((await storedSettings(firm.id)).billing).toBeUndefined();

    const manager = await memberWith(firm.id, ['billing.manageInvoices']);
    const allowed = await manager.api.put(`${base()}/settings`).send({ clientPaymentEmails: false });
    expect(allowed.status).toBe(200);
    expect((await storedSettings(firm.id)).billing.clientPaymentEmails).toBe(false);
  });

  /**
   * Tenant isolation on the write. The second firm is seeded with the value the
   * request would set, inverted, so a write that escaped its firm is visible.
   */
  it('writes only to this firm', async () => {
    const other = await createFirm();
    await seedSettings(other.id, { billing: { clientPaymentEmails: true, invoicePrefix: 'OTHER' } });

    const mine = await owner.api.put(`${base()}/settings`).send({ clientPaymentEmails: false });
    expect(mine.status).toBe(200);

    const otherStored = await storedSettings(other.id);
    expect(otherStored.billing.clientPaymentEmails).toBe(true);
    expect(otherStored.billing.invoicePrefix).toBe('OTHER');

    const crossFirm = await owner.api.put(`/api/lawfirms/${other.id}/billing/settings`)
      .send({ clientPaymentEmails: false });
    expect(crossFirm.status).toBe(403);
    expect((await storedSettings(other.id)).billing.clientPaymentEmails).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  GET /utbms-codes                                                   */
/* ------------------------------------------------------------------ */

describe('GET /billing/utbms-codes', () => {
  /**
   * The three lists and their `{ code, label }` shape are what the LEDES 1998B
   * export and the time-entry pickers read. Red if a list is renamed, emptied,
   * or reshaped.
   */
  it('returns the three UTBMS code lists', async () => {
    const res = await owner.api.get(`${base()}/utbms-codes`);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['activityCodes', 'expenseCodes', 'taskCodes']);

    for (const key of ['taskCodes', 'activityCodes', 'expenseCodes']) {
      const list = res.body[key];
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeGreaterThan(0);
      for (const entry of list) {
        expect(Object.keys(entry).sort()).toEqual(['code', 'label']);
        expect(typeof entry.code).toBe('string');
        expect(typeof entry.label).toBe('string');
      }
    }

    // One known member of each series, so "returns some non-empty array" is not
    // enough to pass.
    expect(res.body.taskCodes).toContainEqual({ code: 'L110', label: 'Fact Investigation/Development' });
    expect(res.body.activityCodes).toContainEqual({ code: 'A103', label: 'Draft' });
    expect(res.body.expenseCodes).toContainEqual({ code: 'E101', label: 'Copying' });
  });

  /**
   * The codes are a compiled-in industry standard, identical for every firm.
   * Pinned so a later per-firm customization has to change this test on purpose
   * rather than by accident.
   */
  it('serves the same global list to every firm', async () => {
    const other = await createFirm();
    const otherOwner = await ownerOf(other.id);

    const mine = await owner.api.get(`${base()}/utbms-codes`);
    const theirs = await otherOwner.api.get(`/api/lawfirms/${other.id}/billing/utbms-codes`);

    expect(mine.status).toBe(200);
    expect(theirs.status).toBe(200);
    expect(theirs.body).toEqual(mine.body);
  });

  /**
   * The gate is `billing.viewTimeEntries`, which is no longer baseline, so a
   * member whose role grants nothing is refused. Red if the gate is dropped.
   */
  it('refuses a member whose role grants nothing', async () => {
    const emptyRole = await memberWith(firm.id, []);

    const res = await emptyRole.api.get(`${base()}/utbms-codes`);

    expect(res.status).toBe(403);
  });

  /** Reference data is still behind membership, not public. */
  it('refuses a caller who is not a member of the firm', async () => {
    const other = await createFirm();
    const otherOwner = await ownerOf(other.id);

    const res = await otherOwner.api.get(`${base()}/utbms-codes`);
    expect(res.status).toBe(403);
  });
});
