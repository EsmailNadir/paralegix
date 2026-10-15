/**
 * A time entry dated with an offset timestamp stores the caller's calendar day.
 */
import {
  testPool, createFirm, createPersonClient, ownerOf, drainEvents, as, tokenFor,
  type Actor, type Firm, type ClientRecord,
} from '../../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const T = () => `/api/lawfirms/${firm.id}/billing/time-entries`;
const body = (extra: Record<string, unknown> = {}) => ({
  clientId: client.id, userId: owner.uid, hours: 1, date: '2026-03-10', hourlyRate: 100, ...extra,
});
const rows = async () => (await testPool.query(
  `select hours::text as hours, activity_date::text as day from activities where kind = 'time' and law_firm_id = $1`,
  [firm.id])).rows;
beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Bounds Client' });
  await drainEvents();
});

describe('date', () => {
  it('keeps the calendar day of a date sent with a local time and offset, in the caller timezone', async () => {
    const agent = as(tokenFor({ uid: owner.uid }), 'America/Chicago');
    const res = await agent.post(T()).send(body({ date: '2026-03-10T23:30:00-05:00' }));

    expect(res.status).toBe(201);
    expect((await rows())[0].day).toBe('2026-03-10');
  });
});
