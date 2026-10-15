/**
 * How many pool connections the two heaviest billing reads hold at once.
 *
 * Every request on an instance shares one small pool (12 connections against a
 * Supabase session pooler that allows 15). A read that starts six or seven
 * queries in one `Promise.all` lets two users drain that pool and leaves every
 * other request waiting behind them. These pin the staged shape: the service
 * never runs more than 3 queries at once, plus 1 for the middleware that may
 * still hold its checkout while the handler starts.
 *
 * The peak is read from the app's own pool `acquire`/`release` events, so it
 * counts every checkout the request makes. The lower bound proves the listener
 * is attached to the pool the app actually uses, so a low peak is a real
 * measurement rather than a detached pool reporting zero.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  drainEvents,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

// Loaded after the harness, which points DATABASE_URL at this worker's test
// database: `db.ts` reads the URL when it is first imported.
const { pool } = require('../../src/shared/database/db');

/** Three queries at once in the service, plus one middleware checkout. */
const MAX_CONNECTIONS_PER_BILLING_READ = 4;

/**
 * The unbilled-work list runs its reads one at a time, so it holds a single
 * connection for the whole request and nothing else on the route overlaps it.
 */
const MAX_CONNECTIONS_UNBILLED_WORK = 1;

let firm: Firm;
let owner: Actor;
let matterId: string;

/** A completed task, which is what `GET /billing/unbilled-work` lists. */
async function seedCompletedTask(lawFirmId: string, matterId: string) {
  const id = randomUUID();
  await testPool.query(
    `insert into tasks (id, law_firm_id, title, status, matter_id, created_at, updated_at)
     values ($1, $2, 'Connection task', 'completed', $3, now(), now())`,
    [id, lawFirmId, matterId],
  );
  return id;
}

async function seedMatterWithWork(lawFirmId: string, userId: string) {
  const id = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id, status)
     values ($1, $2, 'Connection matter', $3, 'active')`,
    [id, lawFirmId, `REF-${id.slice(0, 8)}`],
  );
  await testPool.query(
    `insert into matter_members (law_firm_id, matter_id, user_id) values ($1, $2, $3)`,
    [lawFirmId, id, userId],
  );
  await testPool.query(
    `insert into activities (kind, id, law_firm_id, matter_id, user_id, activity_date, hours, name)
     values ('time', $1, $2, $3, $4, current_date, 2, 'Connection entry')`,
    [randomUUID(), lawFirmId, id, userId],
  );
  return id;
}

/**
 * Open idle connections up front. A cold pool spends longer dialing a new
 * connection than a local query takes, so later queries in a batch reuse a
 * client an earlier one already released and the overlap never shows. Warm
 * clients make the measured peak the real number of queries in flight.
 */
async function warmPool(size: number) {
  const clients = await Promise.all(Array.from({ length: size }, () => pool.connect()));
  clients.forEach((client: any) => client.release());
}

async function peakConnectionsDuring(work: () => Promise<unknown>) {
  let active = 0;
  let peak = 0;
  const onAcquire = () => { active += 1; peak = Math.max(peak, active); };
  const onRelease = () => { active -= 1; };
  pool.on('acquire', onAcquire);
  pool.on('release', onRelease);
  try {
    const result = await work();
    return { result, peak };
  } finally {
    pool.off('acquire', onAcquire);
    pool.off('release', onRelease);
  }
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  matterId = await seedMatterWithWork(firm.id, owner.uid);
  await drainEvents();
  await warmPool(8);
});

describe('billing read connection use', () => {
  it('GET matter unbilled-summary stays within the per-request cap and still returns the entry', async () => {
    const { result, peak } = await peakConnectionsDuring(() => owner.api
      .get(`/api/lawfirms/${firm.id}/billing/invoices/matter/${matterId}/unbilled-summary`)
      .set('x-timezone', 'America/New_York'));
    const res = result as any;

    expect(res.status).toBe(200);
    expect(res.body.unbilledTimeEntries).toHaveLength(1);
    expect(res.body.totalUnbilledHours).toBe(2);
    expect(peak).toBeGreaterThanOrEqual(2);
    expect(peak).toBeLessThanOrEqual(MAX_CONNECTIONS_PER_BILLING_READ);
  });

  /**
   * The route the billing page fires beside the workbench. Its four firm reads
   * used to run as one flat `Promise.all`, so a single viewer of that page held
   * 4 + 3 of the instance's 12 connections and two viewers exceeded what the
   * Supabase pooler allows. Staging them in pairs halved that; dropping the
   * accessible-matter read (which nothing in the list consumed) left three
   * reads, few and cheap enough to run one at a time.
   *
   * Red if any two of the remaining reads are put back into a `Promise.all`, or
   * if the accessible-matter read is reintroduced beside them.
   */
  it('GET billing unbilled-work holds one connection at a time and still returns the completed task', async () => {
    const taskId = await seedCompletedTask(firm.id, matterId);

    const { result, peak } = await peakConnectionsDuring(() => owner.api
      .get(`/api/lawfirms/${firm.id}/billing/unbilled-work`));
    const res = result as any;

    expect(res.status).toBe(200);
    expect(res.body.items.map((item: any) => item.id)).toEqual([`task:${taskId}`]);
    expect(peak).toBeGreaterThanOrEqual(1);
    expect(peak).toBeLessThanOrEqual(MAX_CONNECTIONS_UNBILLED_WORK);
  });

  it('GET billing workbench stays within the per-request cap and still counts the unbilled hours', async () => {
    const { result, peak } = await peakConnectionsDuring(() => owner.api
      .get(`/api/lawfirms/${firm.id}/billing/workbench`)
      .set('x-timezone', 'America/New_York'));
    const res = result as any;

    expect(res.status).toBe(200);
    expect(res.body.summary.unbilledHours).toBe(2);
    expect(peak).toBeGreaterThanOrEqual(2);
    expect(peak).toBeLessThanOrEqual(MAX_CONNECTIONS_PER_BILLING_READ);
  });
});
