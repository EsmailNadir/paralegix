/**
 * Who is ON a matter: its clients, its members, and the billing split between
 * the clients.
 *
 * `matters.test.ts` covers the matter record itself with 45 tests. It does not
 * touch the two junctions, and neither does anything else in the suite, even
 * though ten routes write to them. Three rules live here:
 *
 *   THE BILLING SPLIT MUST BE COMPLETE AND ADD UP. Portions are basis points
 *   (10000 = 100%). A split that omits a client on the matter, or that sums to
 *   anything but 100%, is refused. Both mistakes produce invoices that quietly
 *   bill the wrong total to the wrong people, and no screen shows the shortfall.
 *
 *   MATTER MEMBERSHIP IS THE READ BOUNDARY. `matters.view` is baseline, so the
 *   thing that keeps one team's matter out of another's hands is the
 *   `matter_members` row, not a permission code.
 *
 *   ATTACHING A CLIENT IS `matters.manageClients`, which is NOT baseline. A
 *   member who can open a matter must not be able to change who is billed for
 *   it.
 *
 * Driven through the routes. `matters.repository` exposes `createMatter`, not
 * `create`, and the interesting rules are in the service and the middleware
 * above it in any case.
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

let firm: Firm;
let owner: Actor;
let matterId: string;
let otherFirm: Firm;
let otherOwner: Actor;

const M = (suffix = '', lawFirmId = firm.id, matter = matterId) =>
  `/api/lawfirms/${lawFirmId}/matters/${matter}${suffix}`;

async function seedMatter(lawFirmId: string, memberUid: string, name = 'Hollis v. Denton') {
  const id = randomUUID();
  await testPool.query(
    'insert into matters (id, law_firm_id, name, matter_reference_id) values ($1, $2, $3, $4)',
    [id, lawFirmId, name, `REF-${id.slice(0, 8)}`],
  );
  await testPool.query(
    'insert into matter_members (law_firm_id, matter_id, user_id) values ($1, $2, $3)',
    [lawFirmId, id, memberUid],
  );
  return id;
}

/** The junction rows, read directly so a route's own response cannot flatter it. */
async function clientLinks(matter = matterId) {
  const { rows } = await testPool.query(
    'select client_id, billing_portion_bp from matter_clients where matter_id = $1 order by client_id',
    [matter],
  );
  return rows;
}

async function memberLinks(matter = matterId) {
  const { rows } = await testPool.query(
    'select user_id from matter_members where matter_id = $1 order by user_id', [matter],
  );
  return rows.map((r: any) => r.user_id);
}

/** Attach an existing client record to the matter through the API. */
async function attachClient(actor: Actor, clientId: string, name: string) {
  const res = await actor.api.post(M('/clients')).send({ client: { clientId, name } });
  expect(res.status).toBe(201);
  return res;
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Matters Firm' });
  owner = await ownerOf(firm.id);
  matterId = await seedMatter(firm.id, owner.uid);

  otherFirm = await createFirm({ name: 'Neighbour LLP' });
  otherOwner = await ownerOf(otherFirm.id);
});

describe('attaching clients to a matter', () => {
  it('links an existing client record', async () => {
    const client = await createPersonClient(firm.id, { name: 'Acme Corp' });

    await attachClient(owner, client.id, 'Acme Corp');

    expect((await clientLinks()).map((r: any) => r.client_id)).toEqual([client.id]);
  });

  it('lists the attached clients', async () => {
    const first = await createPersonClient(firm.id, { name: 'First Client' });
    const second = await createPersonClient(firm.id, { name: 'Second Client' });
    await attachClient(owner, first.id, 'First Client');
    await attachClient(owner, second.id, 'Second Client');

    const res = await owner.api.get(M('/clients'));

    expect(res.status).toBe(200);
    expect(res.body.clients.map((c: any) => c.id).sort()).toEqual([first.id, second.id].sort());
  });

  it('removes a client from the matter without deleting the client record', async () => {
    const client = await createPersonClient(firm.id, { name: 'Acme Corp' });
    await attachClient(owner, client.id, 'Acme Corp');

    const res = await owner.api.delete(M(`/clients/${client.id}`));

    expect(res.status).toBe(200);
    expect(await clientLinks()).toHaveLength(0);
    // The client still exists firm-wide. Detaching from one matter must never
    // destroy the roster record, which other matters and invoices point at.
    const { rows } = await testPool.query('select 1 from clients where id = $1', [client.id]);
    expect(rows).toHaveLength(1);
  });

  it('refuses a member without matters.manageClients, and links nothing', async () => {
    const client = await createPersonClient(firm.id, { name: 'Acme Corp' });
    const bystander = await memberWith(firm.id, ['matters.view']);
    await testPool.query(
      'insert into matter_members (law_firm_id, matter_id, user_id) values ($1, $2, $3)',
      [firm.id, matterId, bystander.uid],
    );

    const res = await bystander.api.post(M('/clients')).send({ client: { clientId: client.id, name: 'Acme Corp' } });

    // The bystander IS on the matter, so this isolates the permission from the
    // membership check. Who is billed for a matter is not an ordinary edit.
    expect(res.status).toBe(403);
    expect(await clientLinks()).toHaveLength(0);
  });

  it('refuses a member of another firm, and links nothing', async () => {
    const client = await createPersonClient(firm.id, { name: 'Acme Corp' });

    const res = await otherOwner.api.post(M('/clients'))
      .send({ client: { clientId: client.id, name: 'Acme Corp' } });

    expect(res.status).toBe(403);
    expect(await clientLinks()).toHaveLength(0);
  });

  it('rejects an attach with no client name', async () => {
    const client = await createPersonClient(firm.id, { name: 'Acme Corp' });

    const res = await owner.api.post(M('/clients')).send({ client: { clientId: client.id, name: '' } });

    expect(res.status).toBe(400);
    expect(await clientLinks()).toHaveLength(0);
  });
});

describe('the billing split between clients on a matter', () => {
  let alpha: { id: string };
  let beta: { id: string };

  beforeEach(async () => {
    alpha = await createPersonClient(firm.id, { name: 'Alpha Co' });
    beta = await createPersonClient(firm.id, { name: 'Beta Co' });
    await attachClient(owner, alpha.id, 'Alpha Co');
    await attachClient(owner, beta.id, 'Beta Co');
  });

  it('stores a split that adds up to 100%', async () => {
    const res = await owner.api.put(M('/clients/billing-portions'))
      .send({ portions: { [alpha.id]: 6000, [beta.id]: 4000 } });

    expect(res.status).toBe(200);
    // Basis points, on the junction row. 6000 means 60.00%, and storing 60 here
    // instead would bill Alpha 0.6% of the matter.
    const links = await clientLinks();
    const byClient = Object.fromEntries(links.map((r: any) => [r.client_id, r.billing_portion_bp]));
    expect(byClient[alpha.id]).toBe(6000);
    expect(byClient[beta.id]).toBe(4000);
  });

  it('refuses a split that does not add up to 100%', async () => {
    const short = await owner.api.put(M('/clients/billing-portions'))
      .send({ portions: { [alpha.id]: 6000, [beta.id]: 3000 } });
    const over = await owner.api.put(M('/clients/billing-portions'))
      .send({ portions: { [alpha.id]: 6000, [beta.id]: 5000 } });

    // Both directions. A short split silently under-bills the matter; an over
    // split bills more than the work was worth. Neither shows up as an error on
    // any invoice.
    expect([short.status, over.status]).toEqual([400, 400]);
    expect((await clientLinks()).every((r: any) => r.billing_portion_bp === null)).toBe(true);
  });

  it('refuses a split that leaves out a client on the matter', async () => {
    const res = await owner.api.put(M('/clients/billing-portions'))
      .send({ portions: { [alpha.id]: 10000 } });

    // It sums to 100%, so a total-only check would accept it, and Beta would be
    // on the matter with no share and no bill.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/every client on this matter/i);
    expect((await clientLinks()).every((r: any) => r.billing_portion_bp === null)).toBe(true);
  });

  it('refuses a payer who is not a client on the matter', async () => {
    const stranger = await createPersonClient(firm.id, { name: 'Not On This Matter' });

    const res = await owner.api.put(M('/clients/billing-portions'))
      .send({ portions: { [alpha.id]: 5000, [beta.id]: 4000, [stranger.id]: 1000 } });

    // Sums to 100% and covers everyone on the matter, so only the membership
    // check can refuse it. Otherwise a matter could bill a client who has no
    // relationship to the work.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/must be a client on this matter/i);
  });

  it('accepts an empty map, which clears the split', async () => {
    await owner.api.put(M('/clients/billing-portions'))
      .send({ portions: { [alpha.id]: 6000, [beta.id]: 4000 } });

    const res = await owner.api.put(M('/clients/billing-portions')).send({ portions: {} });

    // "No split" is a valid state: the matter goes back to a single bill. The
    // completeness and total rules are deliberately skipped for the empty map,
    // so this is the case that proves the guard is not simply "always refuse".
    expect(res.status).toBe(200);
    expect((await clientLinks()).every((r: any) => r.billing_portion_bp === null)).toBe(true);
  });

  it('rejects a portion outside the basis-point range', async () => {
    const negative = await owner.api.put(M('/clients/billing-portions'))
      .send({ portions: { [alpha.id]: -1, [beta.id]: 10001 } });

    expect(negative.status).toBe(400);
  });

  it('refuses a member without matters.manageClients', async () => {
    const bystander = await memberWith(firm.id, ['matters.view']);
    await testPool.query(
      'insert into matter_members (law_firm_id, matter_id, user_id) values ($1, $2, $3)',
      [firm.id, matterId, bystander.uid],
    );

    const res = await bystander.api.put(M('/clients/billing-portions'))
      .send({ portions: { [alpha.id]: 10000, [beta.id]: 0 } });

    expect(res.status).toBe(403);
    expect((await clientLinks()).every((r: any) => r.billing_portion_bp === null)).toBe(true);
  });
});

describe('matter members', () => {
  it('adds a firm member to the matter', async () => {
    const colleague = await memberWith(firm.id, ['matters.view']);

    const res = await owner.api.post(M('/members')).send({ targetUserIds: [colleague.uid] });

    expect(res.status).toBe(200);
    expect(await memberLinks()).toEqual([owner.uid, colleague.uid].sort());
  });

  it('makes the matter readable to the member it just added', async () => {
    const colleague = await memberWith(firm.id, ['matters.view']);
    const before = await colleague.api.get(M('/clients'));

    await owner.api.post(M('/members')).send({ targetUserIds: [colleague.uid] });
    const after = await colleague.api.get(M('/clients'));

    // The before/after pair is the point. `matters.view` is baseline, so the
    // membership row is the only thing that changed, and it is what decides
    // whether this person can open the matter at all.
    expect(before.status).toBe(403);
    expect(after.status).toBe(200);
  });

  it('removes a member and closes their access again', async () => {
    const colleague = await memberWith(firm.id, ['matters.view']);
    await owner.api.post(M('/members')).send({ targetUserIds: [colleague.uid] });

    const res = await owner.api.post(M('/members/remove'))
      .send({ targetUserIds: [colleague.uid] });

    expect(res.status).toBe(200);
    expect(await memberLinks()).toEqual([owner.uid]);
    expect((await colleague.api.get(M('/clients'))).status).toBe(403);
  });

  it('refuses a member without matters.manageMembers', async () => {
    const colleague = await memberWith(firm.id, ['matters.view']);
    const bystander = await memberWith(firm.id, ['matters.view']);
    await testPool.query(
      'insert into matter_members (law_firm_id, matter_id, user_id) values ($1, $2, $3)',
      [firm.id, matterId, bystander.uid],
    );

    const res = await bystander.api.post(M('/members')).send({ targetUserIds: [colleague.uid] });

    // Otherwise anyone already on a matter could add anyone else to it, and
    // matter membership would stop being a boundary.
    expect(res.status).toBe(403);
    expect(await memberLinks()).toEqual([owner.uid, bystander.uid].sort());
  });

  it('does not add a member of another firm to this matter', async () => {
    const theirs = await memberWith(otherFirm.id, ['matters.view']);

    const res = await owner.api.post(M('/members')).send({ targetUserIds: [theirs.uid] });

    // The uid is a real person at a real firm. Adding them would hand another
    // firm's employee a row that grants read access to this matter.
    expect(await memberLinks()).toEqual([owner.uid]);
    expect(res.status).toBeLessThan(500);
  });

  it('sets a member matter-specific hourly rate', async () => {
    const colleague = await memberWith(firm.id, ['matters.view']);
    await owner.api.post(M('/members')).send({ targetUserIds: [colleague.uid] });

    const res = await owner.api.put(M('/members/hourly-rate'))
      .send({ userId: colleague.uid, hourlyRate: 425 });

    expect(res.status).toBe(200);
    // Money is cents everywhere. A rate stored as 425 would bill this person at
    // $4.25 an hour on this matter and read correctly on the settings screen.
    const { rows } = await testPool.query(
      'select hourly_rate_cents from matter_members where matter_id = $1 and user_id = $2',
      [matterId, colleague.uid],
    );
    expect(Number(rows[0].hourly_rate_cents)).toBe(42500);
  });
});

describe('reaching another firm matter', () => {
  it('does not list its clients', async () => {
    const theirMatter = await seedMatter(otherFirm.id, otherOwner.uid, 'Their Matter');
    const theirClient = await createPersonClient(otherFirm.id, { name: 'Their Client' });
    // Attached through the OTHER firm's own path; the shared helper is bound to
    // this firm's matter.
    const attached = await otherOwner.api
      .post(M('/clients', otherFirm.id, theirMatter))
      .send({ client: { clientId: theirClient.id, name: 'Their Client' } });
    expect(attached.status).toBe(201);

    const res = await owner.api.get(M('/clients', firm.id, theirMatter));

    // Seeded first, so the refusal cannot pass as an empty matter.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).not.toContain('Their Client');
  });

  it('does not set its billing split', async () => {
    const theirMatter = await seedMatter(otherFirm.id, otherOwner.uid, 'Their Matter');
    const theirClient = await createPersonClient(otherFirm.id, { name: 'Their Client' });
    await testPool.query(
      'insert into matter_clients (matter_id, client_id, law_firm_id) values ($1, $2, $3)',
      [theirMatter, theirClient.id, otherFirm.id],
    );

    const res = await owner.api.put(M('/clients/billing-portions', firm.id, theirMatter))
      .send({ portions: { [theirClient.id]: 10000 } });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await clientLinks(theirMatter))[0].billing_portion_bp).toBeNull();
  });
});
