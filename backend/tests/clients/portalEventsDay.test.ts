/**
 * Which of a matter's events a client sees as upcoming in the portal.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  createPersonClient,
  createPortalUser,
  as,
  tokenFor,
} from '../support/setupInProcess';
import { freezeClockAt } from '../support/clock';

async function seedWorld() {
  const firm = await createFirm({ planId: 'enterprise' });
  const portalUser = await createPortalUser();
  const client = await createPersonClient(firm.id, { name: 'Pat Client', userId: portalUser.uid, email: 'pat@example.test' });
  const matterId = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id) values ($1, $2, 'Pat v. Lee', $3)`,
    [matterId, firm.id, `M-${matterId.slice(0, 8)}`],
  );
  await testPool.query(
    `insert into matter_clients (matter_id, client_id, law_firm_id) values ($1, $2, $3)`,
    [matterId, client.id, firm.id],
  );
  await testPool.query(
    `insert into events (law_firm_id, matter_id, title, type, status, date, all_day, client_visible)
     values ($1, $2, 'Hearing', 'hearing', 'upcoming', '2026-09-27T12:00:00Z', true, true)`,
    [firm.id, matterId],
  );
  const api = as(tokenFor({ uid: portalUser.uid }), 'America/Los_Angeles');
  return { firm, client, matterId, api };
}

describe('an all-day hearing today, seen in the portal at 8pm Pacific', () => {
  test('shares only the separate portal description, never internal notes', async () => {
    const { firm, client, matterId, api } = await seedWorld();
    freezeClockAt('2026-09-27T12:00:00Z');
    await testPool.query('update events set notes = $2, client_description = $3 where matter_id = $1', [matterId, 'Internal settlement strategy', 'Bring identification']);
    const res = await api.get(`/api/client-portal/lawfirm/${firm.id}/events?clientRecordId=${client.id}`);
    expect(res.status).toBe(200);
    expect(res.body.events[0].description).toBe('Bring identification');
    expect(JSON.stringify(res.body)).not.toContain('Internal settlement strategy');
    await testPool.query('update events set client_description = null where matter_id = $1', [matterId]);
    const empty = await api.get(`/api/client-portal/lawfirm/${firm.id}/events?clientRecordId=${client.id}`);
    expect(empty.body.events[0].description).toBeNull();
  });

  test('includes shared direct client events and excludes another client and private entries', async () => {
    const { firm, client, api } = await seedWorld();
    freezeClockAt('2026-09-27T12:00:00Z');
    const other = await createPersonClient(firm.id, { name: 'Other' });
    for (const [clientId, title, visible] of [[client.id, 'Client appointment', true], [client.id, 'Internal appointment', false], [other.id, 'Other appointment', true]] as const) {
      await testPool.query("insert into events (law_firm_id, client_id, title, type, status, date, all_day, client_visible) values ($1,$2,$3,'meeting','upcoming','2026-09-28T12:00:00Z',true,$4)", [firm.id, clientId, title, visible]);
    }
    const res = await api.get(`/api/client-portal/lawfirm/${firm.id}/events?clientRecordId=${client.id}`);
    expect(res.status).toBe(200);
    expect(res.body.events.map((e: any) => e.title)).toEqual(['Hearing', 'Client appointment']);
  });
  /**
   * An all-day event is upcoming for its whole day. Goes red if it is held to
   * "not started yet": at its noon-UTC anchor it vanished from the portal at
   * 5am Pacific on the day of the hearing.
   */
  test('is still listed, as all-day', async () => {
    const { firm, client, matterId, api } = await seedWorld();
    freezeClockAt('2026-09-27T20:00:00-07:00');

    const res = await api.get(`/api/client-portal/lawfirm/${firm.id}/events?matterId=${matterId}&clientRecordId=${client.id}`);

    expect(res.status).toBe(200);
    expect(res.body.events.map((e: any) => [e.title, e.allDay])).toEqual([['Hearing', true]]);
  });

  test('is gone the next day', async () => {
    const { firm, client, matterId, api } = await seedWorld();
    freezeClockAt('2026-09-28T08:00:00-07:00');

    const res = await api.get(`/api/client-portal/lawfirm/${firm.id}/events?matterId=${matterId}&clientRecordId=${client.id}`);

    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
  });
});
