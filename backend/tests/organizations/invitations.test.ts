/** A person invited from an organization roster is still a standalone portal
 * client: accepting the invite must grant that person both their own record
 * and the organization records they are linked to. */
import {
  testPool,
  as,
  tokenFor,
  createPortalUser,
  createPersonClient,
  linkPersonToOrg,
  drainEvents,
} from '../support/setupInProcess';
import { buildOrgWorld, type OrgWorld } from './world';

let world: OrgWorld;
let invitedUid: string;
let invitedEmail: string;
let personId: string;

const invitations = () =>
  `/api/lawfirms/${world.firm.id}/invitations`;

beforeEach(async () => {
  world = await buildOrgWorld();
  invitedUid = `org-invite-${Math.random().toString(36).slice(2, 10)}`;
  invitedEmail = `${invitedUid}@example.test`;

  const person = await createPersonClient(
    world.firm.id,
    { name: 'Invited Organization Contact', email: invitedEmail },
  );
  personId = person.id;
  await linkPersonToOrg(world.firm.id, personId, world.org.id, {
    canViewBilling: true,
    isEmailRecipient: true,
  });
  await drainEvents();
});

async function sendInvite() {
  return world.owner.api.post(`${invitations()}/send-client-invite`).send({
    clientId: personId,
    email: invitedEmail,
  });
}

describe('organization roster portal invitations', () => {
  it('accepting a roster person invite binds the person and exposes the organization', async () => {
    const sent = await sendInvite();
    expect(sent.status).toBe(200);

    await createPortalUser({ uid: invitedUid });
    const accepted = await as(tokenFor({ uid: invitedUid }))
      .post('/api/invitations/accept').send({ token: sent.body.token });
    expect(accepted.status).toBe(200);

    const identity = await testPool.query('select user_id from clients where id = $1', [personId]);
    expect(identity.rows[0].user_id).toBe(invitedUid);

    const associations = await as(tokenFor({ uid: invitedUid }))
      .get(`/api/client-portal/lawfirm/${world.firm.id}/associations`);
    expect(associations.status).toBe(200);
    expect(associations.body.associations.map((entry: any) => entry.clientRecordId))
      .toEqual(expect.arrayContaining([personId, world.org.id]));
  });

  it('revoking a roster person invite prevents later portal acceptance', async () => {
    const sent = await sendInvite();
    expect(sent.status).toBe(200);
    const pending = await world.owner.api.get(`${invitations()}/pending-client-invites`);
    const invite = pending.body.invites.find((entry: any) => entry.email === invitedEmail);
    expect(invite).toBeDefined();

    const revoked = await world.owner.api
      .post(`${invitations()}/client-invites/${invite.id}/revoke`).send({});
    expect(revoked.status).toBe(200);

    await createPortalUser({ uid: invitedUid });
    const accepted = await as(tokenFor({ uid: invitedUid }))
      .post('/api/invitations/accept').send({ token: sent.body.token });
    expect(accepted.status).toBeGreaterThanOrEqual(400);

    const identity = await testPool.query('select user_id from clients where id = $1', [personId]);
    expect(identity.rows[0].user_id).toBeNull();
  });
});
