/**
 * Organization roster administration through the real client routes.
 *
 * The portal batteries prove what a linked person can see after a relationship
 * exists. This file proves the firm-side write boundary that creates, edits and
 * removes that relationship, including the less common create-a-new-person and
 * invalid-target paths.
 */
import {
  testPool,
  createOrgClient,
  createPersonClient,
  linkPersonToOrg,
  drainEvents,
  memberWith,
} from '../support/setupInProcess';
import { buildOrgWorld, type OrgWorld, linkIdFor as linkIdInFirm } from './world';

let world: OrgWorld;

const contactsPath = (clientId: string) =>
  `/api/lawfirms/${world.firm.id}/clients/${clientId}/contacts`;

const linkIdFor = (personClientId: string, companyClientId = world.org.id) =>
  linkIdInFirm(world.firm.id, personClientId, companyClientId);

beforeEach(async () => {
  world = await buildOrgWorld();
  await drainEvents();
});

describe('firm-side organization roster writes', () => {
  it('lets a clients.view member read the roster but not change it', async () => {
    const viewer = await memberWith(world.firm.id, ['clients.view']);
    const linkId = await linkIdFor(world.billing.clientId);

    const read = await viewer.api.get(contactsPath(world.org.id));
    expect(read.status).toBe(200);
    expect(read.body.contacts).toHaveLength(2);

    const add = await viewer.api.post(contactsPath(world.org.id)).send({
      personClientId: world.outsider.clientId,
    });
    const edit = await viewer.api.put(`${contactsPath(world.org.id)}/${linkId}`).send({
      canViewBilling: false,
    });
    const remove = await viewer.api.delete(`${contactsPath(world.org.id)}/${linkId}`);

    expect(add.status).toBe(403);
    expect(edit.status).toBe(403);
    expect(remove.status).toBe(403);

    const after = await world.owner.api.get(contactsPath(world.org.id));
    expect(after.body.contacts).toHaveLength(2);
    expect(after.body.contacts.find((contact: any) => contact.personClientId === world.billing.clientId)
      .canViewBilling).toBe(true);
  });

  it('does not let another firm mutate this organization roster', async () => {
    const add = await world.otherFirm.owner.api
      .post(contactsPath(world.org.id))
      .send({ personClientId: world.otherFirm.portal.clientId });

    expect(add.status).toBe(403);
    expect(await linkIdFor(world.otherFirm.portal.clientId)).toBeUndefined();
  });

  it('creates a new standalone person and links them to the organization', async () => {
    const added = await world.owner.api.post(contactsPath(world.org.id)).send({
      name: 'New Organization Contact',
      email: 'new-contact@example.test',
      relationship: 'CFO',
      canViewBilling: true,
      isEmailRecipient: true,
      isPrimary: true,
    });

    expect(added.status).toBe(201);
    expect(added.body.linkId).toEqual(expect.any(String));
    expect(added.body.relationship).toMatchObject({
      name: 'New Organization Contact',
      email: 'new-contact@example.test',
      relationship: 'CFO',
      canViewBilling: true,
      isEmailRecipient: true,
      isPrimary: true,
    });

    const { rows } = await testPool.query(
      `select c.id, c.client_type, c.email, l.is_primary
         from clients c
         join client_company_links l on l.person_client_id = c.id
        where l.id = $1 and l.company_client_id = $2`,
      [added.body.linkId, world.org.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      client_type: 'person',
      email: 'new-contact@example.test',
      is_primary: true,
    });
  });

  it('rejects linking an organization as a roster person', async () => {
    const res = await world.owner.api.post(contactsPath(world.org.id)).send({
      personClientId: world.org.id,
    });

    expect(res.status).toBe(400);
    const { rows } = await testPool.query(
      'select count(*)::int as n from client_company_links where company_client_id = $1',
      [world.org.id],
    );
    expect(rows[0].n).toBe(2);
  });

  it('rejects duplicate organization membership without changing its flags', async () => {
    const res = await world.owner.api.post(contactsPath(world.org.id)).send({
      personClientId: world.billing.clientId,
      canViewBilling: false,
    });

    expect(res.status).toBe(409);
    const linkId = await linkIdFor(world.billing.clientId);
    const { rows } = await testPool.query(
      'select can_view_billing from client_company_links where id = $1', [linkId],
    );
    expect(rows[0].can_view_billing).toBe(true);
  });

  it('edits relationship flags and leaves the linked person identity intact', async () => {
    const linkId = await linkIdFor(world.noBilling.clientId);
    const updated = await world.owner.api.put(`${contactsPath(world.org.id)}/${linkId}`).send({
      relationship: 'General Counsel',
      canViewBilling: true,
      isEmailRecipient: true,
      isPrimary: true,
    });

    expect(updated.status).toBe(200);
    expect(updated.body.relationship).toMatchObject({
      personClientId: world.noBilling.clientId,
      relationship: 'General Counsel',
      canViewBilling: true,
      isEmailRecipient: true,
      isPrimary: true,
    });

    const person = await world.owner.api.get(
      `/api/lawfirms/${world.firm.id}/clients/${world.noBilling.clientId}`,
    );
    expect(person.body).toMatchObject({ name: 'Ned NoBilling' });
    expect(await linkIdFor(world.billing.clientId)).toEqual(expect.any(String));
  });

  it('removes only the relationship and preserves the person client', async () => {
    const linkId = await linkIdFor(world.billing.clientId);
    const removed = await world.owner.api.delete(`${contactsPath(world.org.id)}/${linkId}`);

    expect(removed.status).toBe(200);
    expect(removed.body.linkId).toBe(linkId);

    const { rows: links } = await testPool.query(
      'select id from client_company_links where id = $1', [linkId],
    );
    expect(links).toHaveLength(0);

    const person = await world.owner.api.get(
      `/api/lawfirms/${world.firm.id}/clients/${world.billing.clientId}`,
    );
    expect(person.status).toBe(200);
    expect(person.body.name).toBe('Bea Billing');
  });

  it('returns not found for a link belonging to another organization', async () => {
    const otherOrg = await createOrgClient(world.firm.id, { name: 'Second Organization' });
    const otherPerson = await createPersonClient(world.firm.id, { name: 'Second Contact' });
    await linkPersonToOrg(world.firm.id, otherPerson.id, otherOrg.id, { canViewBilling: false });
    const linkId = await linkIdFor(otherPerson.id, otherOrg.id);

    const res = await world.owner.api.delete(`${contactsPath(world.org.id)}/${linkId}`);

    expect(res.status).toBe(404);
    expect(await linkIdFor(otherPerson.id, otherOrg.id)).toEqual(linkId);
  });

  it('allows the same person to belong to a second organization independently', async () => {
    const secondOrg = await createOrgClient(world.firm.id, { name: 'Second Organization' });
    const added = await world.owner.api.post(contactsPath(secondOrg.id)).send({
      personClientId: world.billing.clientId,
      canViewBilling: false,
      isEmailRecipient: true,
    });

    expect(added.status).toBe(201);
    expect(await linkIdFor(world.billing.clientId, world.org.id)).toEqual(expect.any(String));
    expect(await linkIdFor(world.billing.clientId, secondOrg.id)).toEqual(expect.any(String));

    const first = await world.owner.api.get(contactsPath(world.org.id));
    const second = await world.owner.api.get(contactsPath(secondOrg.id));
    expect(first.body.contacts).toHaveLength(2);
    expect(second.body.contacts).toHaveLength(1);
    expect(second.body.contacts[0].canViewBilling).toBe(false);
  });

  it('supports a roster person without an email address', async () => {
    const added = await world.owner.api.post(contactsPath(world.org.id)).send({
      name: 'No Email Contact',
      relationship: 'Paralegal',
    });

    expect(added.status).toBe(201);
    expect(added.body.relationship).toMatchObject({
      name: 'No Email Contact',
      email: null,
      relationship: 'Paralegal',
    });
    expect(await linkIdFor(added.body.relationship.personClientId)).toEqual(expect.any(String));
  });

  it('removes a person client without leaving a stale organization roster link', async () => {
    const person = await createPersonClient(world.firm.id, { name: 'Disposable Contact' });
    const linked = await world.owner.api.post(contactsPath(world.org.id)).send({
      personClientId: person.id,
    });
    expect(linked.status).toBe(201);

    const deleted = await world.owner.api.delete(
      `/api/lawfirms/${world.firm.id}/clients/${person.id}`,
    );
    expect(deleted.status).toBe(200);

    expect(await linkIdFor(person.id)).toBeUndefined();
    const roster = await world.owner.api.get(contactsPath(world.org.id));
    expect(roster.body.contacts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ personClientId: person.id })]),
    );
  });

  it('can remove the primary flag without silently assigning a different primary', async () => {
    const primaryLink = await linkIdFor(world.billing.clientId);
    const updated = await world.owner.api.put(`${contactsPath(world.org.id)}/${primaryLink}`)
      .send({ isPrimary: false });

    expect(updated.status).toBe(200);
    const roster = await world.owner.api.get(contactsPath(world.org.id));
    expect(roster.body.contacts.every((contact: any) => contact.isPrimary === false)).toBe(true);
  });
});
