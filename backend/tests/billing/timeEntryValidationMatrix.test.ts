/**
 * B02.3 validation matrix, money-field overflow slice: time entries.
 *
 * `timeEntries.test.ts` already covers negative hours/rates and the frozen-
 * once-billed contract. It does not cover JSON numeric overflow. Note that
 * `1e309` as a JS SOURCE LITERAL evaluates to `Infinity` at parse time, so
 * `.send({ hourlyRate: 1e309 })` never puts the digits `1e309` on the wire:
 * `JSON.stringify` turns that `Infinity` into `null` before the request body
 * is built, and the server only ever sees `hourlyRate: null`. That is a
 * different (and already covered) case: a null-vs-number type rejection, not
 * an overflow one.
 *
 * A genuine overflow test has to put the literal text `1e309` on the wire and
 * let the SERVER's own `JSON.parse` turn it into `Infinity` while parsing the
 * request body, exactly as `express.json()` does for a real attacker's
 * request. That means bypassing supertest's object-mode serialization: build
 * the JSON body as a hand-written string (so the digits survive) and send it
 * with `.type('json')`, which superagent sends byte-for-byte without calling
 * `JSON.stringify` again.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  ownerOf,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const base = () => `/api/lawfirms/${firm.id}/billing/time-entries`;

async function entryCount() {
  const { rows } = await testPool.query(
    `select count(*)::int c from activities where kind = 'time' and law_firm_id = $1`, [firm.id],
  );
  return rows[0].c as number;
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Time Entry Validation Firm' });
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Overflow Client' });
  await drainEvents();
});

describe('genuine JSON numeric overflow on hourlyRate', () => {
  it('rejects a raw-wire 1e309 hourlyRate instead of storing an infinite rate', async () => {
    const before = await entryCount();
    const rawBody = `{"clientId":"${client.id}","userId":"${owner.uid}","hours":1.5,`
      + `"date":"2026-03-10","description":"Overflow attempt","hourlyRate":1e309}`;

    const res = await owner.api.post(base())
      .type('json')
      .send(rawBody);

    expect(res.status).toBe(400);
    expect(await entryCount()).toBe(before);
  });

  it('still accepts an ordinary hourlyRate as the control', async () => {
    const before = await entryCount();
    const rawBody = `{"clientId":"${client.id}","userId":"${owner.uid}","hours":1.5,`
      + `"date":"2026-03-10","description":"Ordinary rate","hourlyRate":250}`;

    const res = await owner.api.post(base())
      .type('json')
      .send(rawBody);

    expect(res.status).toBe(201);
    expect(await entryCount()).toBe(before + 1);
  });

  it('accepts an hourlyRate right at the documented maximum', async () => {
    const before = await entryCount();
    const res = await owner.api.post(base()).send({
      clientId: client.id,
      userId: owner.uid,
      hours: 1.5,
      date: '2026-03-10',
      description: 'At the cap',
      hourlyRate: 1_000_000,
    });

    expect(res.status).toBe(201);
    expect(await entryCount()).toBe(before + 1);
  });

  it('rejects an hourlyRate one dollar past the documented maximum', async () => {
    const before = await entryCount();
    const res = await owner.api.post(base()).send({
      clientId: client.id,
      userId: owner.uid,
      hours: 1.5,
      date: '2026-03-10',
      description: 'One past the cap',
      hourlyRate: 1_000_001,
    });

    expect(res.status).toBe(400);
    expect(await entryCount()).toBe(before);
  });

  it('rejects the same huge finite value on UPDATE, not just create', async () => {
    const createRes = await owner.api.post(base()).send({
      clientId: client.id,
      userId: owner.uid,
      hours: 1.5,
      date: '2026-03-10',
      description: 'Update-path control',
      hourlyRate: 250,
    });
    expect(createRes.status).toBe(201);
    const id = createRes.body.timeEntry.id;

    const res = await owner.api
      .put(`${base()}/client/${client.id}/${id}`)
      .send({ hourlyRate: 1e17 });

    expect(res.status).toBe(400);
    const { rows } = await testPool.query(
      `select rate_cents from activities where kind = 'time' and id = $1`, [id],
    );
    // Unchanged from the control's $250/hr (25000 cents), not corrupted and
    // not silently accepted.
    expect(Number(rows[0].rate_cents)).toBe(25_000);
  });
});
