/**
 * Two firm-side client controls that nothing else covers: revoking portal
 * access, and the per-client billing rate override.
 *
 * `clients.inprocess.test.ts` covers creating, listing, updating and deleting a
 * client, and the portal specs cover what a client can read once they are in.
 * Neither touches these, and both matter:
 *
 *   REVOKING PORTAL ACCESS DOES NOT CURRENTLY REVOKE IT. The route clears
 *   `clients.user_id` and drops the association caches, and the revoked client's
 *   very next request puts the uid straight back: the portal's self-heal step
 *   matches the caller's email against the firm's client rows, and revoke never
 *   clears the email. The case below pins that, with the row read on both sides
 *   so it cannot be mistaken for cache staleness.
 *
 *   A CLIENT RATE OVERRIDES THE FIRM RATE. It is a jsonb patch, so a write that
 *   replaced the object instead of merging would silently drop every per-member
 *   override the firm had set, and the only symptom would be an invoice at the
 *   wrong price weeks later.
 *
 * Reading rates is `billing.viewRates` and writing them is
 * `billing.manageRates`, neither of which is baseline, and both are a different
 * pair from the `clients.manage` gate on revoke. Both pairs are checked.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  createPersonClient,
  ownerOf,
  memberWith,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let otherFirm: Firm;
let otherOwner: Actor;

const C = (clientId: string, suffix = '', lawFirmId = firm.id) =>
  `/api/lawfirms/${lawFirmId}/clients/${clientId}${suffix}`;

/** A client record that carries portal access, plus that portal caller. */
async function clientWithPortalAccess(lawFirmId: string, name = 'Portal Client') {
  const uid = `portal-${randomUUID().slice(0, 8)}`;
  await testPool.query(
    `insert into users (id, email, name, user_type) values ($1, $2, $3, 'client')`,
    [uid, `${uid}@example.test`, name],
  );
  const id = randomUUID();
  await testPool.query(
    `insert into clients (id, law_firm_id, name, email, client_type, user_id, joined_at)
     values ($1, $2, $3, $4, 'person', $5, now())`,
    [id, lawFirmId, name, `${uid}@example.test`, uid],
  );
  return { id, uid, api: as(tokenFor({ uid })) };
}

async function clientRow(id: string) {
  const { rows } = await testPool.query('select * from clients where id = $1', [id]);
  return rows[0] || null;
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Clients Firm' });
  owner = await ownerOf(firm.id);
  otherFirm = await createFirm({ name: 'Neighbour LLP' });
  otherOwner = await ownerOf(otherFirm.id);
});

describe('revoking portal access', () => {
  it('clears the portal identity from the client record', async () => {
    const client = await clientWithPortalAccess(firm.id);

    const res = await owner.api.post(C(client.id, '/revoke-portal-access')).send({});

    expect(res.status).toBe(200);
    // Three fields, because a revoke that cleared only `user_id` would leave the
    // client looking like an invite is still outstanding.
    expect(await clientRow(client.id)).toMatchObject({
      user_id: null, joined_at: null, portal_invite_pending: false,
    });
  });

  it('CHARACTERISATION: does NOT actually stop the revoked person reading the portal', async () => {
    const client = await clientWithPortalAccess(firm.id);
    const before = await client.api.get(`/api/client-portal/lawfirm/${firm.id}/dashboard`);
    expect(before.status).toBe(200);

    const revoked = await owner.api.post(C(client.id, '/revoke-portal-access')).send({});
    expect(revoked.status).toBe(200);
    // The write really happens: the identity is off the row.
    expect(await clientRow(client.id)).toMatchObject({ user_id: null });

    const after = await client.api.get(`/api/client-portal/lawfirm/${firm.id}/dashboard`);

    // AND THE REVOKED CLIENT STILL GETS IN.
    //
    // `getActiveClientAccessContext` runs `selfHealPersonAssociation` before it
    // resolves anything. That helper looks the caller up by uid, finds nothing
    // (the revoke just cleared it), then falls back to matching the caller's
    // EMAIL against the firm's `clients` rows - and the revoked row still
    // carries that email, because revoke does not clear it. It then calls
    // `linkClientIdentityToFirm` and writes the uid straight back.
    //
    // So the revoke is undone by the victim's own next request. This is not a
    // cache-staleness problem: it reproduces with every portal cache cleared,
    // and the row below shows the uid restored in the database.
    //
    // Pinned rather than asserted-away because the fix is a product decision:
    // self-heal exists to repair genuinely broken links, so revoke needs a way
    // to say "this one is deliberate" that self-heal will respect.
    expect(after.status).toBe(200);
    expect(await clientRow(client.id)).toMatchObject({ user_id: client.uid });
  });

  it('does keep the revoked person out once their email is off the record too', async () => {
    const client = await clientWithPortalAccess(firm.id);
    await owner.api.post(C(client.id, '/revoke-portal-access')).send({});

    // The email is the re-link path, so removing it is what actually closes the
    // door today. This is the control for the case above: without it, the 200
    // there could be read as "the portal ignores the client record entirely".
    await testPool.query('update clients set user_id = null, email = null where id = $1', [client.id]);

    const after = await client.api.get(`/api/client-portal/lawfirm/${firm.id}/dashboard`);
    expect(after.status).toBe(403);
  });

  it('refuses to revoke access a client never had', async () => {
    const client = await createPersonClient(firm.id, { name: 'No Portal' });

    const res = await owner.api.post(C(client.id, '/revoke-portal-access')).send({});

    // A no-op that answered 200 would tell a firm it had removed access that
    // never existed, which hides the real state rather than reporting it.
    expect(res.status).toBe(400);
  });

  it('refuses a member without clients.manage, and leaves access in place', async () => {
    const client = await clientWithPortalAccess(firm.id);
    const bystander = await memberWith(firm.id, ['clients.view']);

    const res = await bystander.api.post(C(client.id, '/revoke-portal-access')).send({});

    expect(res.status).toBe(403);
    expect(await clientRow(client.id)).toMatchObject({ user_id: client.uid });
  });

  it('does not revoke access for another firm client', async () => {
    const theirs = await clientWithPortalAccess(otherFirm.id, 'Their Client');

    const res = await owner.api.post(C(theirs.id, '/revoke-portal-access')).send({});

    // A real client with real access, at another firm. The refusal is the tenant
    // scope, and the row proves nothing happened before it.
    expect(res.status).toBe(404);
    expect(await clientRow(theirs.id)).toMatchObject({ user_id: theirs.uid });
  });
});

describe('per-client billing rates', () => {
  it('serves an empty default before any rate is set', async () => {
    const client = await createPersonClient(firm.id, { name: 'Acme Corp' });

    const res = await owner.api.get(C(client.id, '/billing-rates'));

    expect(res.status).toBe(200);
    // The rate editor renders straight off this shape. A missing `memberRates`
    // would break the per-member table rather than showing it empty.
    expect(res.body.billingRates).toEqual({ defaultRate: null, memberRates: {} });
  });

  it('stores a default rate and a per-member override', async () => {
    const client = await createPersonClient(firm.id, { name: 'Acme Corp' });
    const colleague = await memberWith(firm.id, []);

    const res = await owner.api.put(C(client.id, '/billing-rates'))
      .send({ defaultRate: 350, memberRates: { [colleague.uid]: 425 } });

    expect(res.status).toBe(200);
    const read = await owner.api.get(C(client.id, '/billing-rates'));
    expect(read.body.billingRates.defaultRate).toBe(350);
    expect(read.body.billingRates.memberRates[colleague.uid]).toBe(425);
  });

  it('MERGES a later write rather than replacing the whole object', async () => {
    const client = await createPersonClient(firm.id, { name: 'Acme Corp' });
    const colleague = await memberWith(firm.id, []);
    await owner.api.put(C(client.id, '/billing-rates'))
      .send({ defaultRate: 350, memberRates: { [colleague.uid]: 425 } });

    await owner.api.put(C(client.id, '/billing-rates')).send({ defaultRate: 400 });

    // The write is a jsonb `||` patch. Sending only the default must not drop
    // the per-member table, which the rate screen submits separately. Losing it
    // shows up weeks later as an invoice at the wrong price.
    const read = await owner.api.get(C(client.id, '/billing-rates'));
    expect(read.body.billingRates.defaultRate).toBe(400);
    expect(read.body.billingRates.memberRates[colleague.uid]).toBe(425);
  });

  it('accepts a null default, which clears the override', async () => {
    const client = await createPersonClient(firm.id, { name: 'Acme Corp' });
    await owner.api.put(C(client.id, '/billing-rates')).send({ defaultRate: 350 });

    const res = await owner.api.put(C(client.id, '/billing-rates')).send({ defaultRate: null });

    // Null is meaningfully different from absent here: absent leaves the rate
    // alone, null falls back to the firm rate. A schema that rejected null would
    // make a client rate impossible to remove.
    expect(res.status).toBe(200);
    expect((await owner.api.get(C(client.id, '/billing-rates'))).body.billingRates.defaultRate)
      .toBeNull();
  });

  it('rejects a negative rate, and stores nothing', async () => {
    const client = await createPersonClient(firm.id, { name: 'Acme Corp' });

    const res = await owner.api.put(C(client.id, '/billing-rates')).send({ defaultRate: -50 });

    expect(res.status).toBe(400);
    expect((await owner.api.get(C(client.id, '/billing-rates'))).body.billingRates.defaultRate)
      .toBeNull();
  });

  it('refuses a member whose role grants nothing both the read and the write of rates', async () => {
    const client = await createPersonClient(firm.id, { name: 'Acme Corp' });
    await owner.api.put(C(client.id, '/billing-rates')).send({ defaultRate: 350 });
    const baseline = await memberWith(firm.id, []);

    const read = await baseline.api.get(C(client.id, '/billing-rates'));
    const write = await baseline.api.put(C(client.id, '/billing-rates')).send({ defaultRate: 1 });

    // Neither `billing.viewRates` nor `billing.manageRates` is baseline. Seeded
    // first, so the refusal is not an empty body.
    expect(read.status).toBe(403);
    expect(read.body.billingRates).toBeUndefined();
    expect(write.status).toBe(403);
    expect((await owner.api.get(C(client.id, '/billing-rates'))).body.billingRates.defaultRate)
      .toBe(350);
  });

  it('does not read or write another firm client rates', async () => {
    const theirs = await createPersonClient(otherFirm.id, { name: 'Their Client' });
    await otherOwner.api.put(C(theirs.id, '/billing-rates', otherFirm.id))
      .send({ defaultRate: 999 });

    const read = await owner.api.get(C(theirs.id, '/billing-rates'));
    const write = await owner.api.put(C(theirs.id, '/billing-rates')).send({ defaultRate: 1 });

    expect(read.status).toBe(404);
    expect(write.status).toBe(404);
    // Seeded with a distinctive figure, so the refusal is provably a refusal and
    // the neighbour's rate is provably untouched.
    const theirRead = await otherOwner.api.get(C(theirs.id, '/billing-rates', otherFirm.id));
    expect(theirRead.body.billingRates.defaultRate).toBe(999);
  });
});
