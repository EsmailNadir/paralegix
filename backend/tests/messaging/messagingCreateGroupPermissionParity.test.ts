/**
 * `messagingParticipants.test.ts` already proves `addGroupParticipants` gates
 * bringing a CLIENT onto an EXISTING group behind `messaging.manageParticipants`,
 * on top of the `messaging.send` baseline every route in this module requires
 * (`messaging.service.ts`'s own comment: "Bringing a CLIENT in ... needs a
 * permission that is not part of the baseline"). `createGroupConversation` can
 * add a client to a BRAND NEW group in exactly the same way — `createGroupSchema`
 * accepts the identical `clientIds`/`clientRecordIds`/`organizationClientIds`
 * shape `groupParticipantsSchema` does — but its route
 * (`POST /lawfirms/:lawFirmId/messaging/groups`) requires only `messaging.send`,
 * and the service never calls `assertFirmPermission(..., 'messaging.manageParticipants')`
 * the way `addGroupParticipants` does.
 *
 * That is the same shared-capability asymmetry the B10 events/attached-clients
 * ticks found: a permission enforced on one path onto the same mutation, skipped
 * on an equivalent path that reaches the identical outcome. Here the built-in
 * "Staff" role is a real instance of the gap (`messaging.send`+`messaging.view`,
 * no `messaging.manageParticipants`) — anyone with it is blocked from adding a
 * client to an existing thread but can hand that same client a brand-new one.
 */
import {
  drainEvents,
  createFirm,
  createPersonClient,
  createPortalUser,
  createFirmMember,
  ownerOf,
  as,
  tokenFor,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let clientUid: string;

const M = () => `/api/lawfirms/${firm.id}/messaging`;

/** Active participant uids for a conversation, read straight from Postgres. */
async function activeParticipants(conversationId: string) {
  const { rows } = await testPool.query(
    `select participant_user_id from conversation_participants
      where conversation_id = $1 and removed_at is null`,
    [conversationId],
  );
  return rows.map((r: any) => r.participant_user_id as string);
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);

  const portal = await createPortalUser({ name: 'Dana Reyes' });
  clientUid = portal.uid;
  await createPersonClient(firm.id, { name: 'Dana Reyes', userId: portal.uid });

  await drainEvents();
});

describe('createGroupConversation / addGroupParticipants permission parity', () => {
  it('blocks a messaging.send-only member from creating a group WITH a client, same as the participants route does', async () => {
    const staffer = await createFirmMember(firm.id, {
      isOwner: false, permissions: ['messaging.view', 'messaging.send'],
    });
    const stafferApi = as(tokenFor({ uid: staffer.uid }));

    // Control: the direct-add path already 403s this caller for the identical act.
    const existing = await owner.api.post(`${M()}/groups`).send({ title: 'Seed', memberIds: [staffer.uid] });
    expect(existing.status).toBe(201);
    const addAttempt = await stafferApi
      .post(`${M()}/groups/${existing.body.conversationId}/participants`)
      .send({ clientIds: [clientUid] });
    expect(addAttempt.status).toBe(403);

    // The route under test: creating a NEW group with the same client attached.
    const created = await stafferApi.post(`${M()}/groups`).send({
      title: 'New group', clientIds: [clientUid],
    });

    expect(created.status).toBe(403);
    if (created.status === 201) {
      expect(await activeParticipants(created.body.conversationId)).not.toContain(clientUid);
    }
  });

  it('still lets a messaging.send-only member create a group of COLLEAGUES only, same baseline as adding one', async () => {
    const staffer = await createFirmMember(firm.id, {
      isOwner: false, permissions: ['messaging.view', 'messaging.send'],
    });
    const colleague = await createFirmMember(firm.id, {
      isOwner: false, permissions: ['messaging.view', 'messaging.send'],
    });

    const created = await as(tokenFor({ uid: staffer.uid })).post(`${M()}/groups`).send({
      title: 'Internal group', memberIds: [colleague.uid],
    });

    expect(created.status).toBe(201);
    expect(await activeParticipants(created.body.conversationId)).toEqual(
      expect.arrayContaining([staffer.uid, colleague.uid]),
    );
  });

  it('lets a member holding messaging.manageParticipants create a group with a client', async () => {
    const manager = await createFirmMember(firm.id, {
      isOwner: false,
      permissions: ['messaging.view', 'messaging.send', 'messaging.manageParticipants'],
    });

    const created = await as(tokenFor({ uid: manager.uid })).post(`${M()}/groups`).send({
      title: 'Managed group', clientIds: [clientUid],
    });

    expect(created.status).toBe(201);
    expect(await activeParticipants(created.body.conversationId)).toContain(clientUid);
  });
});
