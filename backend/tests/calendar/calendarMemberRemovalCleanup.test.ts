/**
 * What leaves a person's calendar, and what stops arriving from it, when they
 * lose access in a firm.
 *
 * Three removals reach the calendar listeners: leaving a matter
 * (MATTER_MEMBERS_UPDATED), losing the role that let them see billing (picked
 * up the next time the invoice changes), and leaving the firm (MEMBER_REMOVED).
 * Each has to take down every Paralegix copy the person still holds, including
 * invoice billing dates, and leaving the firm also has to stop importing their
 * own calendar into it.
 *
 * Provider requests are asserted at the network wall (`support/googleFetch.ts`).
 * Each connected member has a distinct access token, so the bearer on a call
 * names whose calendar it reached.
 */
import {
  installGoogleFetchWall, uninstallGoogleFetchWall, resetGoogleFetch, route, callsMatching,
} from './support/googleFetch';

installGoogleFetchWall();

import { randomUUID } from 'crypto';

import {
  createFirm, createFirmMember, createPersonClient, drainEvents, ownerOf, testPool, type Actor, type Firm,
} from '../support/setupInProcess';
import { describeNetworkWall } from './support/calendarWorld';

const eventBus = require('../../src/shared/events/eventBus');
const { INVOICE_UPDATED } = require('../../src/shared/events/eventTypes');
const calendarEntityResolver = require('../../src/modules/calendar/shared/calendarEntityResolver');

let firm: Firm;
let owner: Actor;

beforeEach(async () => {
  resetGoogleFetch();
  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

afterEach(async () => {
  await drainEvents();
});

afterAll(uninstallGoogleFetchWall);

describeNetworkWall();

/** A non-owner member with a working Google connection that syncs out only. */
async function connectedMember(lawFirmId: string, permissions: string[], uid?: string) {
  const accessToken = `tok-${randomUUID().slice(0, 8)}`;
  const member = await createFirmMember(lawFirmId, { isOwner: false, permissions, uid });
  const res = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token, is_sync_to_provider, is_sync_from_provider)
     values ($1, 'google', $2, 'refresh-seed', true, false)`,
    [member.uid, accessToken],
  );
  expect(res.rowCount).toBe(1);
  return { uid: member.uid, accessToken };
}

const BILLING = ['billing.viewInvoices', 'calendar.sync', 'matters.view', 'clients.view', 'tasks.view'];

async function seedMatter(members: string[]) {
  const matterId = randomUUID();
  const matter = await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id) values ($1, $2, 'Bell v. Ward', $3)`,
    [matterId, firm.id, `M-${matterId.slice(0, 8)}`],
  );
  expect(matter.rowCount).toBe(1);
  for (const uid of members) {
    const res = await testPool.query(
      `insert into matter_members (matter_id, user_id, law_firm_id, role, joined_at) values ($1, $2, $3, 'member', now())`,
      [matterId, uid, firm.id],
    );
    expect(res.rowCount).toBe(1);
  }
  return matterId;
}

async function seedInvoice(context: { matterId?: string; clientId?: string }, calendarSync: object = {}) {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into invoices (id, law_firm_id, matter_id, client_context_id, context_type, invoice_number, due_date, total_cents, status, calendar_sync)
     values ($1, $2, $3, $4, $5, $6, '2030-10-01', 50000, 'outstanding', $7::jsonb)`,
    [id, firm.id, context.matterId ?? null, context.clientId ?? null, context.matterId ? 'matter' : 'client',
      `INV-${id.slice(0, 8)}`, JSON.stringify(calendarSync)],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

async function seedMapping(fields: {
  userId: string; externalEventId: string; entityType: string; entityId: string; scopeId?: string | null; itemKey: string; lawFirmId?: string;
}) {
  const res = await testPool.query(
    `insert into calendar_mappings (provider, external_event_id, calendar_id, user_id, law_firm_id, entity_type, entity_id, scope_id, item_key)
     values ('google', $1, 'primary', $2, $3, $4, $5, $6, $7)`,
    [fields.externalEventId, fields.userId, fields.lawFirmId ?? firm.id, fields.entityType, fields.entityId, fields.scopeId ?? null, fields.itemKey],
  );
  expect(res.rowCount).toBe(1);
}

const deletes = () => callsMatching('/events/').filter((call) => call.method === 'DELETE');
const deletedIds = () => deletes().map((call) => call.url.split('/events/')[1].split('?')[0]).sort();
const mappingsFor = async (uid: string) => (await testPool.query(
  'select external_event_id from calendar_mappings where user_id = $1 order by 1', [uid],
)).rows.map((row) => row.external_event_id);

describe('invoice billing dates', () => {
  /**
   * Goes red if taking a member off a matter unwinds only its hearings and tasks:
   * the matter's invoice due date stays on their calendar, with the amount owed
   * in its description, after their access to the matter ended.
   */
  test('leaving a matter removes that matter\'s invoice date from the member\'s calendar', async () => {
    const member = await connectedMember(firm.id, BILLING);
    const matterId = await seedMatter([member.uid, owner.uid]);
    const invoiceId = await seedInvoice({ matterId });
    await seedMapping({ userId: member.uid, externalEventId: 'g-inv', entityType: 'invoiceBilling', entityId: invoiceId, scopeId: `matter:${matterId}`, itemKey: 'dueDate' });
    route(/\/events\/g-inv/, { status: 204 }, { method: 'DELETE' });

    const res = await owner.api.post(`/api/lawfirms/${firm.id}/matters/${matterId}/members/remove`).send({ targetUserIds: [member.uid] });
    expect(res.status).toBe(200);
    await drainEvents();

    expect(deletes().map((call) => [call.url.split('/events/')[1].split('?')[0], call.bearer])).toEqual([['g-inv', member.accessToken]]);
    expect(await mappingsFor(member.uid)).toEqual([]);
  });

  /**
   * Goes red if an invoice change reaches only the people who may see it now:
   * someone who held a copy and has since lost billing access is never
   * addressed, so their copy outlives the access that justified it.
   */
  test('an invoice change takes the date off a holder who can no longer see billing', async () => {
    const recipient = await connectedMember(firm.id, BILLING);
    const former = await connectedMember(firm.id, ['calendar.sync', 'clients.view']);
    const client = await createPersonClient(firm.id);
    const invoiceId = await seedInvoice({ clientId: client.id }, { google: { [recipient.uid]: { dueDate: { eventId: 'g-current' } } } });
    await seedMapping({ userId: recipient.uid, externalEventId: 'g-current', entityType: 'invoiceBilling', entityId: invoiceId, scopeId: `client:${client.id}`, itemKey: 'dueDate' });
    await seedMapping({ userId: former.uid, externalEventId: 'g-stale', entityType: 'invoiceBilling', entityId: invoiceId, scopeId: `client:${client.id}`, itemKey: 'dueDate' });
    route(/\/events\/g-current/, { status: 200, json: { id: 'g-current', etag: '"2"', updated: '2030-09-01T00:00:00Z' } }, { method: 'PATCH' });
    route(/\/events\/g-stale/, { status: 204 }, { method: 'DELETE' });

    eventBus.emit(INVOICE_UPDATED, {
      lawFirmId: firm.id, invoiceId, userId: owner.uid,
      invoiceData: { id: invoiceId, lawFirmId: firm.id, contextType: 'client', clientId: client.id, clientContextId: client.id,
        invoiceNumber: `INV-${invoiceId.slice(0, 8)}`, dueDate: '2030-10-01', totalAmount: 500, amountPaid: 0, isPaid: false, status: 'outstanding' },
    });
    await drainEvents();

    expect(deletes().map((call) => [call.url.split('/events/')[1].split('?')[0], call.bearer])).toEqual([['g-stale', former.accessToken]]);
    expect(callsMatching('/events/g-current').filter((call) => call.method === 'PATCH').map((call) => call.bearer)).toEqual([recipient.accessToken]);
    expect(await mappingsFor(former.uid)).toEqual([]);
  });
});

describe('leaving the firm', () => {
  async function seedTaskWithCopy(holder: string, externalEventId: string) {
    const taskId = randomUUID();
    const res = await testPool.query(
      `insert into tasks (id, law_firm_id, title, status, due_date, created_by) values ($1, $2, 'File the motion', 'open', '2030-11-10', $3)`,
      [taskId, firm.id, owner.uid],
    );
    expect(res.rowCount).toBe(1);
    await seedMapping({ userId: holder, externalEventId, entityType: 'task', entityId: taskId, itemKey: 'dueDate' });
    return taskId;
  }

  /**
   * Goes red if the cleanup records and dispatches one copy at a time: a throw
   * while reading the first copy's entity abandons every copy after it, with no
   * row left for the retry sweep to find.
   */
  test('a failure on one copy still leaves durable delete work for every copy', async () => {
    const member = await connectedMember(firm.id, BILLING);
    for (const id of ['g-a', 'g-b', 'g-c']) await seedTaskWithCopy(member.uid, id);
    const original = calendarEntityResolver.resolveFromMapping;
    const fault = jest.spyOn(calendarEntityResolver, 'resolveFromMapping')
      .mockImplementationOnce(() => ({ getState: () => Promise.reject(new Error('entity read failed')) }))
      .mockImplementation((mapping: unknown) => original(mapping));
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await owner.api.delete(`/api/lawfirms/${firm.id}/members/${member.uid}`);
      expect(res.status).toBe(200);
      await drainEvents();
      expect(fault).toHaveBeenCalled();
    } finally {
      fault.mockRestore();
      errors.mockRestore();
    }

    // No provider route is registered, so each delete is refused at the wall
    // and its row stays queued for the sweep.
    const queued = (await testPool.query(
      `select payload from calendar_sync_failures where kind = 'outbound' and user_id = $1`, [member.uid],
    )).rows;
    expect(queued.map((row) => row.payload.action)).toEqual(['deleteEventsFromEntity', 'deleteEventsFromEntity', 'deleteEventsFromEntity']);
    expect(deletes()).toHaveLength(3);
  });

  /** The control: with nothing failing, every copy is taken down. */
  test('every copy is taken down', async () => {
    const member = await connectedMember(firm.id, BILLING);
    for (const id of ['g-a', 'g-b']) await seedTaskWithCopy(member.uid, id);
    route(/\/events\/g-[ab]/, { status: 204 }, { method: 'DELETE' });

    const res = await owner.api.delete(`/api/lawfirms/${firm.id}/members/${member.uid}`);
    expect(res.status).toBe(200);
    await drainEvents();

    expect(deletedIds()).toEqual(['g-a', 'g-b']);
    expect(await mappingsFor(member.uid)).toEqual([]);
  });
});

describe('live import after leaving a firm', () => {
  async function seedImport(lawFirmId: string, createdBy: string, title: string) {
    const res = await testPool.query(
      `insert into calendar_events (law_firm_id, title, starts_at, ends_at, provider, google_event_id, external_event_id, created_by)
       values ($1, $2, '2030-11-10T14:00:00Z', '2030-11-10T15:00:00Z', 'google', $3, $3, $4)`,
      [lawFirmId, title, `ext-${randomUUID().slice(0, 8)}`, createdBy],
    );
    expect(res.rowCount).toBe(1);
  }

  async function seedChannel(uid: string, lawFirmId: string) {
    const res = await testPool.query(
      `insert into calendar_subscriptions (id, provider, user_id, law_firm_id, calendar_id, resource, secret, expiration)
       values ('chan-1', 'google', $1, $2, 'primary', 'res-1', 'secret-1', now() + interval '5 days')`,
      [uid, lawFirmId],
    );
    expect(res.rowCount).toBe(1);
  }

  const importsBy = async (uid: string) => (await testPool.query(
    'select law_firm_id, title from calendar_events where created_by = $1 order by title', [uid],
  )).rows.map((row) => [row.law_firm_id, row.title]);

  /**
   * Goes red if leaving a firm leaves the import running for it: the person's
   * private meetings stay readable to the old firm, keep arriving there, and
   * never start arriving in the firm they still belong to.
   */
  test('moves the watch to a firm the person still belongs to and purges the old firm\'s imports', async () => {
    const other = await createFirm();
    const member = await connectedMember(firm.id, BILLING);
    await createFirmMember(other.id, { uid: member.uid, isOwner: false });
    await seedChannel(member.uid, firm.id);
    await seedImport(firm.id, member.uid, 'A dentist');
    await seedImport(firm.id, member.uid, 'B school run');
    await seedImport(other.id, member.uid, 'C kept in the other firm');
    await seedImport(firm.id, owner.uid, 'D the owner\'s own');

    const res = await owner.api.delete(`/api/lawfirms/${firm.id}/members/${member.uid}`);
    expect(res.status).toBe(200);
    await drainEvents();

    expect(await importsBy(member.uid)).toEqual([[other.id, 'C kept in the other firm']]);
    expect(await importsBy(owner.uid)).toEqual([[firm.id, 'D the owner\'s own']]);
    const channel = (await testPool.query(`select law_firm_id from calendar_subscriptions where id = 'chan-1'`)).rows;
    expect(channel).toEqual([{ law_firm_id: other.id }]);
    const catchUp = (await testPool.query(
      `select law_firm_id, payload from calendar_sync_failures where kind = 'webhook' and user_id = $1`, [member.uid],
    )).rows;
    expect(catchUp.map((row) => [row.law_firm_id, row.payload.changeType])).toEqual([[other.id, 'catch_up']]);
    expect(callsMatching('channels/stop')).toHaveLength(0);
  });

  /** Goes red if a person left with no firm keeps a live watch that imports into nothing. */
  test('stops the watch when the person belongs to no other firm', async () => {
    const member = await connectedMember(firm.id, BILLING);
    await seedChannel(member.uid, firm.id);
    await seedImport(firm.id, member.uid, 'A dentist');
    route('channels/stop', { status: 204 }, { method: 'POST' });

    const res = await owner.api.delete(`/api/lawfirms/${firm.id}/members/${member.uid}`);
    expect(res.status).toBe(200);
    await drainEvents();

    expect(callsMatching('channels/stop').map((call) => call.body)).toEqual([{ id: 'chan-1', resourceId: 'res-1' }]);
    expect((await testPool.query(`select 1 from calendar_subscriptions where id = 'chan-1'`)).rowCount).toBe(0);
    expect(await importsBy(member.uid)).toEqual([]);
  });
});

export {};
