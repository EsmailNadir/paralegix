/**
 * Organization scenario journeys: the bug class the contract battery cannot find.
 *
 * The battery seeds the world in its FINAL state and asks each surface a
 * question. These build the world, then CHANGE it, then ask again. The order of
 * events is the whole point, because the failure mode is access that was decided
 * once and never revisited.
 *
 * This class has shipped here before. Migration 0182 exists because
 * `findOrCreateCanonicalCompanyConversation` seeded its participant list once at
 * creation, so a firm member who joined later was locked out of the thread,
 * could not see it, and could not add themselves.
 *
 * The structural reason to keep watching it: **no event fires when a roster link
 * is created or removed.** `eventTypes.ts` carries CLIENT_CREATED,
 * CLIENT_UPDATED, CLIENT_DELETED and the note events, and nothing for a person
 * joining or leaving an organization. Anything that records access in a table,
 * rather than deriving it per request, therefore has no hook to notice.
 *
 * These are CHARACTERISATION tests. They pin what the code does today, which the
 * probes below established is consistent and sensible. If the product wants
 * different behaviour, change the assertion deliberately rather than discovering
 * the change through a user.
 */
import { testPool, drainEvents } from '../support/setupInProcess';
import { buildOrgWorld, linkIdFor as linkIdInFirm, type OrgWorld } from './world';

let world: OrgWorld;

beforeEach(async () => {
  world = await buildOrgWorld();
  await drainEvents();
});

/** The portal paths that state something the organization owns. */
const portalPath = (firmId: string, suffix: string, orgId: string) =>
  `/api/client-portal/lawfirm/${firmId}/${suffix}?clientRecordId=${orgId}`;

const linkIdFor = (personClientId: string, orgId: string) =>
  linkIdInFirm(world.firm.id, personClientId, orgId);

describe('J1: a person added to an organization after its work exists', () => {
  it('reaches the organization money that predates them', async () => {
    const { firm, org, outsider } = world;

    // The invoice and the trust deposit were seeded before this person joined.
    const before = await outsider.api.get(portalPath(firm.id, 'billing', org.id));
    expect([403, 404]).toContain(before.status);

    // Added through the real endpoint, not a raw insert. A direct write would
    // skip whatever the write path does to invalidate the portal's access-context
    // cache, and the test would then be measuring the cache rather than the
    // widening.
    const added = await world.owner.api
      .post(`/api/lawfirms/${firm.id}/clients/${org.id}/contacts`)
      .send({ personClientId: outsider.clientId, canViewBilling: true });
    expect(added.status).toBe(201);
    await drainEvents();

    // Access is derived per request rather than materialised at link time, so a
    // later joiner needs no backfill. Pinning it because the opposite design
    // shipped once, in messaging.
    const after = await outsider.api.get(portalPath(firm.id, 'billing', org.id));
    expect(after.status).toBe(200);
    expect(JSON.stringify(after.body)).toContain(String(world.orgInvoice.totalCents / 100));
  });

  it('is added to the organization thread that predates them', async () => {
    const { firm, org, owner, outsider } = world;

    // The firm opens the company Messages tab, which creates the canonical
    // thread and seeds its participants from the roster as it stands now.
    const created = await owner.api.get(
      `/api/lawfirms/${firm.id}/messaging/company-conversation/${org.id}`,
    );
    expect(created.status).toBe(200);
    await drainEvents();

    // Group threads only: every person client is also offered their own
    // personal thread in this list, which is not what this journey measures.
    const visible = async () => {
      const res = await outsider.api.get(portalPath(firm.id, 'messages/conversations', org.id));
      return ((res.body as { conversations?: any[] })?.conversations ?? [])
        .filter((c) => c.conversationType === 'group').length;
    };

    expect(await visible()).toBe(0);

    const added = await owner.api
      .post(`/api/lawfirms/${firm.id}/clients/${org.id}/contacts`)
      .send({ personClientId: outsider.clientId, canViewBilling: false });
    expect(added.status).toBe(201);
    await drainEvents();

    // This is the exact shape migration 0182 had to backfill, one level down:
    // a participant list seeded once, and someone who arrived afterwards.
    expect(await visible()).toBe(1);
  });
});

describe('J2: a person removed from an organization', () => {
  it('loses every organization surface at once', async () => {
    const { firm, org, owner, billing } = world;

    for (const suffix of ['matters', 'billing', 'trust/balance', 'documents', 'dashboard']) {
      const res = await billing.api.get(portalPath(firm.id, suffix, org.id));
      expect(res.status).toBe(200);
    }

    const removal = await owner.api.delete(
      `/api/lawfirms/${firm.id}/clients/${org.id}/contacts/${await linkIdFor(billing.clientId, org.id)}`,
    );
    expect(removal.status).toBe(200);
    await drainEvents();

    // Revoked, not merely hidden from a list. A surface that answered 200 here
    // would mean a direct url still worked after the person was taken off.
    for (const suffix of ['matters', 'billing', 'trust/balance', 'documents', 'dashboard']) {
      const res = await billing.api.get(portalPath(firm.id, suffix, org.id));
      expect(res.status).toBe(403);
    }
  });

  it('leaves the organization thread but keeps the history row', async () => {
    const { firm, org, owner, billing } = world;

    await owner.api.get(`/api/lawfirms/${firm.id}/messaging/company-conversation/${org.id}`);
    await drainEvents();

    // Group threads only, as in J1: the person's own personal thread is not
    // the organization thread this measures.
    const seen = async () => {
      const res = await billing.api.get(portalPath(firm.id, 'messages/conversations', org.id));
      return ((res.body as { conversations?: any[] })?.conversations ?? [])
        .filter((c) => c.conversationType === 'group').length;
    };
    expect(await seen()).toBe(1);

    await owner.api.delete(
      `/api/lawfirms/${firm.id}/clients/${org.id}/contacts/${await linkIdFor(billing.clientId, org.id)}`,
    );
    await drainEvents();

    expect(await seen()).toBe(0);

    // Soft removal: the row survives with `removed_at` set, so the thread's
    // history stays attributable rather than losing who was in it and when.
    const { rows } = await testPool.query(
      `select cp.removed_at from conversation_participants cp
         join conversations c on c.id = cp.conversation_id
        where c.law_firm_id = $1 and cp.participant_user_id = $2`,
      [firm.id, billing.uid],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].removed_at).not.toBeNull();
  });

  it('leaves the person their own client record and their own firm access', async () => {
    const { firm, org, owner, billing } = world;

    await owner.api.delete(
      `/api/lawfirms/${firm.id}/clients/${org.id}/contacts/${await linkIdFor(billing.clientId, org.id)}`,
    );
    await drainEvents();

    // Leaving an organization is not leaving the firm. The person's own record
    // survives, which is what makes them a standalone client rather than a
    // membership row.
    const { rows } = await testPool.query('select id from clients where id = $1', [billing.clientId]);
    expect(rows).toHaveLength(1);

    const own = await billing.api.get(portalPath(firm.id, 'billing', billing.clientId));
    expect(own.status).toBe(200);
  });
});

describe('J3: can_view_billing flipped on an existing link', () => {
  it('refuses the organization money as soon as the flag is cleared', async () => {
    const { firm, org, billing } = world;

    expect((await billing.api.get(portalPath(firm.id, 'billing', org.id))).status).toBe(200);

    const linkId = await linkIdFor(billing.clientId, org.id);
    const updated = await world.owner.api
      .put(`/api/lawfirms/${firm.id}/clients/${org.id}/contacts/${linkId}`)
      .send({ canViewBilling: false });
    expect(updated.status).toBe(200);
    await drainEvents();

    // No cache may outlive the change. The portal memoises the access context,
    // so a stale hit here would keep serving the organization's money after the
    // firm revoked it.
    const after = await billing.api.get(portalPath(firm.id, 'billing', org.id));
    expect(after.status).toBe(403);
  });

  it('grants it as soon as the flag is set, with no re-login', async () => {
    const { firm, org, noBilling } = world;

    expect((await noBilling.api.get(portalPath(firm.id, 'billing', org.id))).status).toBe(403);

    const linkId = await linkIdFor(noBilling.clientId, org.id);
    const updated = await world.owner.api
      .put(`/api/lawfirms/${firm.id}/clients/${org.id}/contacts/${linkId}`)
      .send({ canViewBilling: true });
    expect(updated.status).toBe(200);
    await drainEvents();

    const after = await noBilling.api.get(portalPath(firm.id, 'billing', org.id));
    // The invoice itself, not just the status: a grant that answered 200 with
    // an empty list would leave the firm believing access had been given.
    expect(after.status).toBe(200);
    expect(JSON.stringify(after.body)).toContain(world.orgInvoice.id);
  });

  it('does not widen the flag to the person other organizations', async () => {
    const { firm, billing } = world;
    const { rows: orgRows } = await testPool.query(
      `insert into clients (law_firm_id, name, client_type) values ($1, 'Second Corp', 'company')
       returning id`,
      [firm.id],
    );
    const second = orgRows[0].id;
    await testPool.query(
      `insert into client_company_links
         (law_firm_id, person_client_id, company_client_id, can_view_billing)
       values ($1, $2, $3, false)`,
      [firm.id, billing.clientId, second],
    );
    await drainEvents();

    // The flag lives on the LINK, not on the person. Holding it for one
    // organization must not carry into another.
    expect((await billing.api.get(portalPath(firm.id, 'billing', world.org.id))).status).toBe(200);
    expect((await billing.api.get(portalPath(firm.id, 'billing', second))).status).toBe(403);
  });
});

describe('J5: the primary contact moves to a different person', () => {
  it('moves the seat, leaving exactly one primary', async () => {
    const { firm, org, owner, billing, noBilling } = world;

    // `client_company_links_one_primary_idx` is a partial unique index over
    // (law_firm_id, company_client_id) WHERE is_primary, so the write path has
    // to clear the old seat before setting the new one. The same index is what
    // broke the merge (see regressions.test.ts BUG-2).
    const moved = await owner.api
      .put(`/api/lawfirms/${firm.id}/clients/${org.id}/contacts/${await linkIdFor(noBilling.clientId, org.id)}`)
      .send({ isPrimary: true });
    expect(moved.status).toBe(200);
    await drainEvents();

    const { rows } = await testPool.query(
      `select person_client_id from client_company_links
        where company_client_id = $1 and is_primary`,
      [org.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].person_client_id).toBe(noBilling.clientId);

    // And the former primary is still ON the roster, just not the primary. A
    // write path that cleared the seat by deleting the link would silently
    // remove someone from the organization.
    const { rows: still } = await testPool.query(
      'select is_primary from client_company_links where person_client_id = $1 and company_client_id = $2',
      [billing.clientId, org.id],
    );
    expect(still).toHaveLength(1);
    expect(still[0].is_primary).toBe(false);
  });

  it('does not change who can see the money', async () => {
    const { firm, org, owner, billing, noBilling } = world;

    await owner.api
      .put(`/api/lawfirms/${firm.id}/clients/${org.id}/contacts/${await linkIdFor(noBilling.clientId, org.id)}`)
      .send({ isPrimary: true });
    await drainEvents();

    // `is_primary` is billing DELIVERY, `can_view_billing` is billing ACCESS.
    // Conflating them would either hand the new primary access they were never
    // granted, or strip it from the person who still holds the flag.
    expect((await billing.api.get(portalPath(firm.id, 'billing', org.id))).status).toBe(200);
    expect((await noBilling.api.get(portalPath(firm.id, 'billing', org.id))).status).toBe(403);
  });
});

describe('J6: an organization with a roster is deleted', () => {
  it('removes the roster with it and leaves the people as standalone clients', async () => {
    const { firm, org, owner, billing, noBilling } = world;

    // The organization is deleted, not merged. Its people are their own client
    // records and must survive: they are standalone clients who happened to be
    // linked, not rows belonging to the organization.
    const deleted = await owner.api.delete(`/api/lawfirms/${firm.id}/clients/${org.id}`);
    expect([200, 204, 409]).toContain(deleted.status);
    await drainEvents();

    if (deleted.status === 409) {
      // Refusal is valid while the organization still owns work, but it must be
      // observable: the organization and its roster must remain intact.
      const { rows: orgStillThere } = await testPool.query(
        'select id from clients where id = $1', [org.id],
      );
      expect(orgStillThere).toHaveLength(1);
      const { rows: linksStillThere } = await testPool.query(
        'select count(*)::int as n from client_company_links where company_client_id = $1',
        [org.id],
      );
      expect(linksStillThere[0].n).toBe(2);
      return;
    }

    const { rows: links } = await testPool.query(
      'select count(*)::int as n from client_company_links where company_client_id = $1',
      [org.id],
    );
    expect(links[0].n).toBe(0);

    for (const person of [billing, noBilling]) {
      const { rows } = await testPool.query('select id from clients where id = $1', [person.clientId]);
      expect(rows).toHaveLength(1);
    }
  });
});
