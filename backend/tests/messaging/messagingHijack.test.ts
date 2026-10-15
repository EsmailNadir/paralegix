/**
 * `validate()`'s `writeBack()` merges the zod-parsed body over the raw
 * `req.body` (`{ ...current, ...parsed }`), not in place of it. A body key the
 * schema does not declare is stripped from the PARSED result but survives on
 * the raw `req.body`. Both group-conversation handlers below build their
 * service-call object as `{ lawFirmId: req.params.lawFirmId, ..., ...req.body }`
 * — trusted fields first, `...req.body` last — so a same-named body key
 * silently wins the object literal and overrides the trusted value.
 *
 * `createGroupSchema` and `groupParticipantsSchema`
 * (`messaging.validation.ts`) declare no `lawFirmId`, `userId` or
 * `conversationId` in `body`, so all three survive on the raw body untouched.
 * That is enough to redirect a write into a firm the caller only borrowed
 * `messaging.send` from via the URL, never actually held permission in.
 *
 * Both cases below use one real person who is a full member (owner) of their
 * own firm and ALSO a bare, zero-permission member of a second firm — the
 * same dual-membership shape `tasks.test.ts` uses for its
 * "server-owned fields cannot be widened from the body" cases.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  drainEvents,
  createFirm,
  createFirmMember,
  ownerOf,
  memberWith,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firmA: Firm;
let firmB: Firm;
/** Owner of firmA (holds messaging.send there) and a bare member of firmB (holds nothing there). */
let actor: Actor;

beforeEach(async () => {
  firmA = await createFirm();
  firmB = await createFirm();
  actor = await ownerOf(firmA.id);
  await memberWith(firmB.id, [], { uid: actor.uid });
  await drainEvents();
});

describe('createGroupConversation: a body lawFirmId cannot redirect the write to another firm', () => {
  it('does not create a group under firm B for a caller with zero permissions there', async () => {
    // A real firm-B member, so the create has a valid participant to add if the
    // hijack succeeds — otherwise the service's "at least one other person"
    // check would reject the request for an unrelated reason and the case
    // would prove nothing.
    const firmBColleague = await createFirmMember(firmB.id);

    const res = await actor.api
      .post(`/api/lawfirms/${firmA.id}/messaging/groups`)
      .send({ title: 'Hijack Attempt', lawFirmId: firmB.id, memberIds: [firmBColleague.uid] });

    // Whatever the fixed route does with this request (succeed inside firm A,
    // or reject outright), the one outcome that must never happen is a group
    // conversation landing inside firm B — the actor holds no messaging.send
    // grant there at all, only in firm A.
    const leaked = await testPool.query(
      `select id from conversations where law_firm_id = $1 and title = $2`,
      [firmB.id, 'Hijack Attempt'],
    );
    expect(leaked.rows).toHaveLength(0);
    // A conversation ever attributed to firm B (even indirectly) is the bug;
    // confirm nothing conversation-shaped for firm B exists at all beyond the
    // fixture's own untouched state.
    if (res.status === 201) {
      const created = await testPool.query(
        `select law_firm_id from conversations where id = $1`,
        [res.body.conversationId],
      );
      expect(created.rows[0]?.law_firm_id).toBe(firmA.id);
    }
  });
});

describe('addGroupParticipants: body lawFirmId/conversationId cannot redirect the write to another conversation', () => {
  it('does not add a participant to a firm-B group for a caller with zero permissions there', async () => {
    // Seed a real group conversation in firm B where the actor is already an
    // active participant (added by firm B's own owner), but the actor's role
    // in firm B grants nothing — no messaging.send, no manageParticipants.
    const firmBOwner = await ownerOf(firmB.id);
    const seed = await firmBOwner.api
      .post(`/api/lawfirms/${firmB.id}/messaging/groups`)
      .send({ title: 'Firm B internal group', memberIds: [actor.uid] });
    expect(seed.status).toBe(201);
    const firmBConversationId: string = seed.body.conversationId;

    const before = await testPool.query(
      `select participant_user_id from conversation_participants
        where conversation_id = $1 and removed_at is null`,
      [firmBConversationId],
    );

    const targetMember = await createFirmMember(firmB.id);

    // The URL conversationId only needs to satisfy the route's uuid params
    // check — it is never dereferenced if the body's conversationId wins the
    // object-literal override, so a fresh random uuid stands in for "some
    // conversation the actor owns in firm A".
    const decoyConversationId = randomUUID();
    const res = await actor.api
      .post(`/api/lawfirms/${firmA.id}/messaging/groups/${decoyConversationId}/participants`)
      .send({ conversationId: firmBConversationId, lawFirmId: firmB.id, memberIds: [targetMember.uid] });

    const after = await testPool.query(
      `select participant_user_id from conversation_participants
        where conversation_id = $1 and removed_at is null`,
      [firmBConversationId],
    );
    expect(after.rows.map((r: any) => r.participant_user_id).sort())
      .toEqual(before.rows.map((r: any) => r.participant_user_id).sort());
    expect(res.status).not.toBe(200);
  });
});
