/**
 * Adding a client to a group needs `messaging.manageParticipants`; removing
 * that client revokes the same externally-visible membership and must use the
 * same capability. A plain `messaging.send` member may still manage internal
 * firm-member staffing on a group they participate in.
 */
import {
  createFirm,
  createFirmMember,
  createPersonClient,
  createPortalUser,
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

const M = (suffix = '') => `/api/lawfirms/${firm.id}/messaging${suffix}`;

async function isActiveParticipant(conversationId: string, userId: string) {
  const { rows } = await testPool.query(
    `select 1 from conversation_participants
      where conversation_id = $1 and participant_user_id = $2 and removed_at is null`,
    [conversationId, userId],
  );
  return rows.length === 1;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  const portal = await createPortalUser({ name: 'Quinn Client' });
  clientUid = portal.uid;
  await createPersonClient(firm.id, { name: 'Quinn Client', userId: clientUid });
});

describe('removeGroupParticipant permission parity for client participants', () => {
  it('does not let a messaging.send-only participant remove a client', async () => {
    const staffer = await createFirmMember(firm.id, {
      isOwner: false,
      permissions: ['messaging.view', 'messaging.send'],
    });
    const seeded = await owner.api.post(M('/groups')).send({
      title: 'Client group', memberIds: [staffer.uid], clientIds: [clientUid],
    });
    expect(seeded.status).toBe(201);

    const removed = await as(tokenFor({ uid: staffer.uid }))
      .delete(M(`/groups/${seeded.body.conversationId}/participants/${clientUid}`));

    expect(removed.status).toBe(403);
    expect(await isActiveParticipant(seeded.body.conversationId, clientUid)).toBe(true);
  });

  it('still lets a messaging.send-only participant remove a firm colleague', async () => {
    const staffer = await createFirmMember(firm.id, {
      isOwner: false,
      permissions: ['messaging.view', 'messaging.send'],
    });
    const colleague = await createFirmMember(firm.id, {
      isOwner: false,
      permissions: ['messaging.view', 'messaging.send'],
    });
    const seeded = await owner.api.post(M('/groups')).send({
      title: 'Internal group', memberIds: [staffer.uid, colleague.uid],
    });
    expect(seeded.status).toBe(201);

    const removed = await as(tokenFor({ uid: staffer.uid }))
      .delete(M(`/groups/${seeded.body.conversationId}/participants/${colleague.uid}`));

    expect(removed.status).toBe(200);
    expect(await isActiveParticipant(seeded.body.conversationId, colleague.uid)).toBe(false);
  });

  it('allows a participant manager to remove a client', async () => {
    const manager = await createFirmMember(firm.id, {
      isOwner: false,
      permissions: ['messaging.view', 'messaging.send', 'messaging.manageParticipants'],
    });
    const seeded = await owner.api.post(M('/groups')).send({
      title: 'Managed client group', memberIds: [manager.uid], clientIds: [clientUid],
    });
    expect(seeded.status).toBe(201);

    const removed = await as(tokenFor({ uid: manager.uid }))
      .delete(M(`/groups/${seeded.body.conversationId}/participants/${clientUid}`));

    expect(removed.status).toBe(200);
    expect(await isActiveParticipant(seeded.body.conversationId, clientUid)).toBe(false);
  });
});
