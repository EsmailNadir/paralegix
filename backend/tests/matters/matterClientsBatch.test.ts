/**
 * GET /api/lawfirms/:lawFirmId/matters/clients?matterIds=a,b,c
 *
 * The clients of SEVERAL matters in one request.
 *
 * WHY THIS ROUTE EXISTS. Every API instance shares one 12-connection pool
 * against a Supabase session pooler that allows 15 in total. Until this route,
 * matter clients could only be read one matter at a time, so the invoice-run
 * page fired one request per unbilled matter: a firm with sixty unbilled
 * matters opened sixty requests, and one user could hold the whole pool while
 * everyone else queued behind them.
 *
 * WHAT THESE TESTS PIN, and what has to break for each to go red:
 *
 *   - the batch answers with the SAME rows the per-matter route answers with,
 *     `billingPortionBp` included. Reshape either read and the equality test
 *     fails, which is what stops the invoice-run page's split-share logic from
 *     silently losing its shares.
 *   - the batch applies the SAME access rule as the per-matter route. Widen it
 *     to "any firm member sees any matter" and the partial-access test fails;
 *     drop the tenant scope and the cross-firm tests fail.
 *   - the batch costs a CONSTANT number of pool checkouts. Reintroduce a
 *     per-id query and the connection test fails, which is the entire point of
 *     the route.
 *   - the cap is enforced BEFORE any read. Move the check into the service and
 *     the over-cap test sees a checkout and fails.
 */
import { installInMemoryBucket } from '../support/inMemoryBucket';
import {
  createFirm,
  createPersonClient,
  drainEvents,
  memberWith,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

// Loaded after the harness, which points DATABASE_URL at this worker's test
// database: `db.ts` reads the URL when it is first imported.
const { pool } = require('../../src/shared/database/db');
// The cap is read from the module that enforces it rather than copied, so a
// change to it moves the boundary these tests probe instead of going unnoticed.
const { MAX_BATCH_MATTER_IDS } = require('../../src/modules/matters/clients/matterClients.validation');

installInMemoryBucket();

let firm: Firm;
let owner: Actor;

const M = () => `/api/lawfirms/${firm.id}/matters`;
const batchUrl = (ids: string[], lawFirmId = firm.id) =>
  `/api/lawfirms/${lawFirmId}/matters/clients?matterIds=${ids.join(',')}`;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  await drainEvents();
});

/** A matter carrying one freshly created person client per name given. */
async function createMatter(name: string, clientNames: string[]): Promise<string> {
  const clients = [];
  for (const clientName of clientNames) {
    const client = await createPersonClient(firm.id, { name: clientName });
    clients.push({ clientId: client.id, name: clientName });
  }
  const res = await owner.api.post(M()).send({ name, clients });
  expect(res.status).toBe(201);
  await drainEvents();
  return (res.body.matterId ?? res.body.matter?.id) as string;
}

/**
 * What one request cost the pool: how many connections it checked out, and the
 * SQL it ran on them.
 *
 * Read off the app's own pool, so it covers the auth and permission middleware
 * as well as the handler. The SQL is captured by wrapping each checked-out
 * client's `query` for the duration, which observes the real driver rather than
 * standing in for it; the wrapper is removed again on the way out.
 */
async function observe(work: () => Promise<unknown>) {
  // Settle first. A listener still running from an earlier request holds a
  // queued checkout that the pool hands out whenever a connection frees, and
  // counting that stray against this request would make the measurement a race.
  await drainEvents();
  await new Promise((resolve) => setImmediate(resolve));

  let checkouts = 0;
  const sql: string[] = [];
  // Keyed by client, because the pool hands the SAME client back for the next
  // checkout: wrapping it again would stack the recorders and count one
  // statement once per layer.
  const originals = new Map<any, any>();
  const onAcquire = (client: any) => {
    checkouts += 1;
    if (originals.has(client)) return;
    const original = client.query;
    originals.set(client, original);
    client.query = function patched(this: unknown, ...args: any[]) {
      const first = args[0];
      sql.push(typeof first === 'string' ? first : String(first?.text ?? ''));
      return original.apply(this, args);
    };
  };
  pool.on('acquire', onAcquire);
  try {
    const result = await work();
    return { result: result as any, checkouts, sql };
  } finally {
    pool.off('acquire', onAcquire);
    for (const [client, original] of originals) client.query = original;
  }
}

/** The statements that read the matter-clients junction. */
const clientReads = (sql: string[]) => sql.filter((text) => /matter_clients/i.test(text));

describe('GET /matters/clients (batch): tenant isolation', () => {
  it('gives another firm owner nothing for this firm matter ids', async () => {
    const matterId = await createMatter('Alpha', ['Pat Person']);
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    // Asked through their OWN firm, which they legitimately own: the ids are
    // real, but they name matters in a firm the read is not scoped to.
    const throughOwnFirm = await otherOwner.api.get(batchUrl([matterId], otherFirm.id));
    expect(throughOwnFirm.status).toBe(200);
    expect(throughOwnFirm.body.clientsByMatterId).toEqual({});
    expect(JSON.stringify(throughOwnFirm.body)).not.toContain('Pat Person');

    // Asked through THIS firm: refused outright, not answered with an empty map.
    const throughThisFirm = await otherOwner.api.get(batchUrl([matterId]));
    expect(throughThisFirm.status).toBe(403);
    expect(JSON.stringify(throughThisFirm.body)).not.toContain('Pat Person');
  });

  it('drops a matter id belonging to another firm from an otherwise valid batch', async () => {
    const mine = await createMatter('Mine', ['My Client']);
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    const theirClient = await createPersonClient(otherFirm.id, { name: 'Their Client' });
    const theirMatter = await otherOwner.api.post(`/api/lawfirms/${otherFirm.id}/matters`)
      .send({ name: 'Theirs', clients: [{ clientId: theirClient.id, name: 'Their Client' }] });
    expect(theirMatter.status).toBe(201);
    const theirMatterId = (theirMatter.body.matterId ?? theirMatter.body.matter?.id) as string;
    await drainEvents();

    // The firm owner takes the owner/admin path, which is the one that could
    // wave a foreign id through if it trusted the caller instead of the scope.
    const res = await owner.api.get(batchUrl([mine, theirMatterId]));

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.clientsByMatterId)).toEqual([mine]);
    expect(JSON.stringify(res.body)).not.toContain('Their Client');
  });
});

describe('GET /matters/clients (batch): matter-level access', () => {
  it('returns the matters a member is on and omits the one they are not', async () => {
    const onIt = await createMatter('Staffed', ['Visible Client']);
    const offIt = await createMatter('Not Staffed', ['Hidden Client']);
    const member = await memberWith(firm.id, ['matters.view']);

    const staffed = await owner.api.post(`${M()}/${onIt}/members`)
      .send({ targetUserIds: [member.uid] });
    expect(staffed.status).toBe(200);
    await drainEvents();

    const res = await member.api.get(batchUrl([onIt, offIt]));

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.clientsByMatterId)).toEqual([onIt]);
    expect(res.body.clientsByMatterId[onIt].map((c: any) => c.name)).toEqual(['Visible Client']);
    // The whole point of the omission: the unstaffed matter's client never
    // crosses the wire, not even as a name in a key the caller could read.
    expect(JSON.stringify(res.body)).not.toContain('Hidden Client');
  });
});

describe('GET /matters/clients (batch): equals the per-matter route', () => {
  it('returns, for three matters, exactly what three single calls return', async () => {
    const first = await createMatter('One', ['Ada Adams', 'Bo Baker']);
    const second = await createMatter('Two', ['Cal Carter']);
    const third = await createMatter('Three', []);

    // A configured split, because `billingPortionBp` is the field the invoice-run
    // page reads and the one most easily lost when a read is reshaped.
    const single = await owner.api.get(`${M()}/${first}/clients`);
    expect(single.status).toBe(200);
    const portions: Record<string, number> = {};
    portions[single.body.clients[0].id] = 6000;
    portions[single.body.clients[1].id] = 4000;
    const split = await owner.api.put(`${M()}/${first}/clients/billing-portions`).send({ portions });
    expect(split.status).toBe(200);
    await drainEvents();

    const singles: Record<string, unknown> = {};
    for (const matterId of [first, second, third]) {
      const res = await owner.api.get(`${M()}/${matterId}/clients`);
      expect(res.status).toBe(200);
      singles[matterId] = res.body.clients;
    }
    // Proves the comparison below is not two empty objects agreeing.
    expect((singles[first] as any[]).map((c: any) => c.billingPortionBp)).toEqual([6000, 4000]);
    expect((singles[third] as any[])).toEqual([]);

    const batch = await owner.api.get(batchUrl([first, second, third]));

    expect(batch.status).toBe(200);
    expect(batch.body.clientsByMatterId).toEqual(singles);
  });
});

describe('GET /matters/clients (batch): connection cost', () => {
  it('takes the same number of pool checkouts for ten matters as for one', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      ids.push(await createMatter(`Matter ${i}`, [`Client ${i}`]));
    }
    // Warm the permission cache, so the measurements below compare the read
    // itself rather than one request's cold members/roles lookup.
    await owner.api.get(batchUrl([ids[0]]));

    const one = await observe(() => owner.api.get(batchUrl([ids[0]])));
    const ten = await observe(() => owner.api.get(batchUrl(ids)));

    expect(one.result.status).toBe(200);
    expect(ten.result.status).toBe(200);
    expect(Object.keys(ten.result.body.clientsByMatterId)).toHaveLength(10);
    // Proves the listener is attached to the pool the request actually uses, so
    // the equality below is a measurement and not a pair of zeroes.
    expect(one.checkouts).toBeGreaterThan(0);
    expect(ten.checkouts).toBe(one.checkouts);
    // The connection count alone would still allow ten sequential reads down one
    // connection. Ten matters must cost ONE statement against the junction.
    expect(clientReads(ten.sql)).toHaveLength(1);
    expect(clientReads(one.sql)).toHaveLength(1);
  });
});

describe('GET /matters/clients (batch): the cap', () => {
  it('refuses more ids than the cap, and reads nothing when it does', async () => {
    const real = await createMatter('Real', ['Real Client']);
    // Warm the permission cache, so what the over-cap request runs below is
    // whatever it runs on a warm instance rather than a first-request lookup.
    await owner.api.get(batchUrl([real]));

    const overCap = [
      real,
      ...Array.from(
        { length: MAX_BATCH_MATTER_IDS },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      ),
    ];

    const refused = await observe(() => owner.api.get(batchUrl(overCap)));
    expect(refused.result.status).toBe(400);
    expect(JSON.stringify(refused.result.body)).toMatch(/matterIds/);
    // The cap is enforced by the validation middleware, so the request is
    // refused before anything looks a matter or a client up: a real matter id
    // sits in the list above and still nothing reads it.
    expect(refused.sql.filter((text) => /matter|client/i.test(text))).toEqual([]);
    expect(JSON.stringify(refused.result.body)).not.toContain('Real Client');

    // Exactly at the cap still answers, so the boundary is the cap and not one
    // below it.
    const atCap = overCap.slice(0, MAX_BATCH_MATTER_IDS);
    expect(atCap).toHaveLength(MAX_BATCH_MATTER_IDS);
    const allowed = await owner.api.get(batchUrl(atCap));
    expect(allowed.status).toBe(200);
    expect(allowed.body.clientsByMatterId[real].map((c: any) => c.name)).toEqual(['Real Client']);
  });
});
