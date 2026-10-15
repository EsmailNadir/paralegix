/**
 * Deleting a populated matter: the rest of the graph.
 *
 * `tests/events/deleteCascades.test.ts` already covers the LISTENER-driven
 * half of a matter delete (files, share links, notifications, storage-usage
 * accounting, the task fan-out) and deliberately excludes anything that
 * cascades by a plain database foreign key, on the grounds that asserting on
 * one of those "proves the FK works, not the listener" (see that file's top
 * comment). Nobody has ever run that FK cascade end to end, though: nothing
 * proves that deleting a matter through the real route actually removes its
 * notes, replies, document requests, subtasks, calendar events, contact
 * links, and activity log rather than tripping over an unrelated `on delete
 * restrict` somewhere in the chain, or that it does so ONLY for that matter's
 * own rows.
 *
 * This file is that proof, for the row types deleteCascades.test.ts does not
 * touch: matter notes/replies, document requests/items, task subtasks,
 * matter events, matter contacts, and matter activity. Billing and trust
 * records are deliberately absent from the fixture: `assertMatterIsDeletable`
 * (matters.service.ts) refuses to delete a matter carrying either, so those
 * children never reach a cascade at all — that refusal is already covered by
 * `tests/trust/trustRetentionAndDeletion.test.ts`. Group-conversation
 * membership is the other half of the story: `conversation_matters` (the
 * many-to-many scope) cascades by FK, but `conversations.matter_id` and
 * `messages.matter_id` carry no foreign key at all (schema.sql calls the
 * first "an organizational tag ... not a confidentiality gate"), so the
 * conversation and its messages are expected to SURVIVE the matter with a now
 * stale primary-matter id. That is asserted here as the documented behavior,
 * not treated as a bug.
 *
 * Every case seeds a same-firm sibling matter and a second firm's matter with
 * an identical parallel graph, so a listener/FK that forgot its scope (the
 * whole firm, or every matter) would be caught, not just "some row vanished."
 */
import { randomUUID } from 'crypto';
const eventBus = require('../../src/shared/events/eventBus');
const { MATTER_DELETED, TASK_DELETED } = require('../../src/shared/events/eventTypes');

import { installInMemoryBucket } from '../support/inMemoryBucket';
import {
  testPool,
  createFirm,
  createFirmMember,
  ownerOf,
  type Firm,
  type Actor,
} from '../support/setupInProcess';
import { seedMatter } from '../support/matters';

// The delete route's MATTER_DELETED listeners include a GCS sweep
// (files.events); without a working bucket double it throws "GCS is not
// available" noise on every delete in this file even though nothing here
// asserts on storage.
installInMemoryBucket();

// `assertMatterMembership` (matters.service.deleteMatter's first call) requires
// an actual matter_members row even for the firm owner - firm-level permission
// alone is not matter access.
const seedMemberMatter = (lawFirmId: string, name: string, memberUid: string) =>
  seedMatter(lawFirmId, { name, memberUids: [memberUid] });

async function seedContact(lawFirmId: string): Promise<string> {
  const id = randomUUID();
  await testPool.query(`insert into contacts (id, law_firm_id, name) values ($1, $2, 'Opposing Counsel')`, [id, lawFirmId]);
  return id;
}

/** A note, its reply, a document request with one item, a task with a
 *  subtask, a calendar event, a contact link, an activity-log row, and a
 *  group conversation scoped to the matter with one message in it. Returns
 *  the ids needed to assert on afterward. */
async function seedFullGraph(lawFirmId: string, matterId: string, actorUid: string, contactId: string) {
  const noteId = randomUUID();
  await testPool.query(
    `insert into notes (id, matter_id, law_firm_id, content, created_by)
     values ($1, $2, $3, 'Fixture note', $4)`,
    [noteId, matterId, lawFirmId, actorUid],
  );
  // No matter_id: migration 0207 dropped the copied parent columns, so a reply
  // reaches its matter only through its note. The cascade assertion below is
  // what proves that indirection still deletes it.
  const replyId = randomUUID();
  await testPool.query(
    `insert into note_replies (id, law_firm_id, note_id, content, created_by)
     values ($1, $2, $3, 'Fixture reply', $4)`,
    [replyId, lawFirmId, noteId, actorUid],
  );

  const requestId = randomUUID();
  const clientId = randomUUID();
  await testPool.query(
    `insert into clients (id, law_firm_id, name, client_type) values ($1, $2, 'Fixture client', 'person')`,
    [clientId, lawFirmId],
  );
  await testPool.query(
    `insert into document_requests (id, law_firm_id, matter_id, client_id, title)
     values ($1, $2, $3, $4, 'Fixture request')`,
    [requestId, lawFirmId, matterId, clientId],
  );
  const requestItemId = randomUUID();
  await testPool.query(
    `insert into document_request_items (id, law_firm_id, request_id, label) values ($1, $2, $3, 'Exhibit A')`,
    [requestItemId, lawFirmId, requestId],
  );

  const taskId = randomUUID();
  await testPool.query(
    `insert into tasks (id, law_firm_id, matter_id, title) values ($1, $2, $3, 'Fixture task')`,
    [taskId, lawFirmId, matterId],
  );
  const subtaskId = randomUUID();
  await testPool.query(
    `insert into task_subtasks (id, law_firm_id, task_id, title) values ($1, $2, $3, 'Fixture subtask')`,
    [subtaskId, lawFirmId, taskId],
  );

  const eventId = randomUUID();
  await testPool.query(
    `insert into events (id, law_firm_id, matter_id, title, date) values ($1, $2, $3, 'Fixture hearing', now())`,
    [eventId, lawFirmId, matterId],
  );

  const matterContactId = randomUUID();
  await testPool.query(
    `insert into matter_contacts (id, law_firm_id, matter_id, contact_id, role)
     values ($1, $2, $3, $4, 'opposing_counsel')`,
    [matterContactId, lawFirmId, matterId, contactId],
  );

  const activityId = randomUUID();
  await testPool.query(
    `insert into activity_log (id, law_firm_id, matter_id, activity_type, summary)
     values ($1, $2, $3, 'fixture', 'Fixture activity')`,
    [activityId, lawFirmId, matterId],
  );

  const conversationId = randomUUID();
  await testPool.query(
    `insert into conversations (id, law_firm_id, conversation_type, title, matter_id)
     values ($1, $2, 'group', 'Fixture group', $3)`,
    [conversationId, lawFirmId, matterId],
  );
  await testPool.query(
    `insert into conversation_matters (conversation_id, law_firm_id, matter_id) values ($1, $2, $3)`,
    [conversationId, lawFirmId, matterId],
  );
  const messageId = randomUUID();
  await testPool.query(
    `insert into messages (id, conversation_id, law_firm_id, sender_user_id, content, matter_id)
     values ($1, $2, $3, $4, 'Fixture message', $5)`,
    [messageId, conversationId, lawFirmId, actorUid, matterId],
  );

  return {
    noteId, replyId, requestId, requestItemId, taskId, subtaskId, eventId,
    matterContactId, activityId, conversationId, messageId,
  };
}

async function rowCount(table: string, column: string, id: string): Promise<number> {
  const { rowCount } = await testPool.query(`select 1 from public.${table} where ${column} = $1`, [id]);
  return rowCount ?? 0;
}

describe('deleting a populated matter through the real route', () => {
  let firm: Firm;
  let owner: Actor;
  let rival: Firm;
  let rivalOwner: Actor;
  let doomed: string;
  let sibling: string;
  let rivalMatter: string;

  let doomedGraph: Awaited<ReturnType<typeof seedFullGraph>>;
  let siblingGraph: Awaited<ReturnType<typeof seedFullGraph>>;
  let rivalGraph: Awaited<ReturnType<typeof seedFullGraph>>;

  beforeEach(async () => {
    firm = await createFirm();
    owner = await ownerOf(firm.id);
    rival = await createFirm();
    rivalOwner = await ownerOf(rival.id);

    doomed = await seedMemberMatter(firm.id, 'Doomed matter', owner.uid);
    sibling = await seedMemberMatter(firm.id, 'Surviving matter', owner.uid);
    rivalMatter = await seedMemberMatter(rival.id, 'Rival matter', rivalOwner.uid);

    const contact = await seedContact(firm.id);
    const rivalContact = await seedContact(rival.id);

    doomedGraph = await seedFullGraph(firm.id, doomed, owner.uid, contact);
    siblingGraph = await seedFullGraph(firm.id, sibling, owner.uid, contact);
    rivalGraph = await seedFullGraph(rival.id, rivalMatter, rivalOwner.uid, rivalContact);
  });

  it('finishes matter deletion listeners before acknowledging removal', async () => {
    let finished = false;
    const listener = async ({ matterId }: { matterId: string }) => {
      if (matterId !== doomed) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
      finished = true;
    };
    eventBus.on(MATTER_DELETED, listener);
    try {
      const res = await owner.api.delete(`/api/lawfirms/${firm.id}/matters/${doomed}`);
      expect(res.status).toBe(200);
      expect(finished).toBe(true);
    } finally {
      eventBus.off(MATTER_DELETED, listener);
    }
  });

  it('finishes cascaded task deletion listeners before acknowledging matter removal', async () => {
    let finished = false;
    const listener = async ({ taskId }: { taskId: string }) => {
      if (taskId !== doomedGraph.taskId) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
      finished = true;
    };
    eventBus.on(TASK_DELETED, listener);
    try {
      const res = await owner.api.delete(`/api/lawfirms/${firm.id}/matters/${doomed}`);
      expect(res.status).toBe(200);
      expect(finished).toBe(true);
    } finally {
      eventBus.off(TASK_DELETED, listener);
    }
  });

  it('passes former matter members to cascaded task deletion', async () => {
    let recipients: string[] | undefined;
    const listener = ({ taskId, recipientUserIds }: { taskId: string; recipientUserIds?: string[] }) => {
      if (taskId === doomedGraph.taskId) recipients = recipientUserIds;
    };
    eventBus.on(TASK_DELETED, listener);
    try {
      const res = await owner.api.delete(`/api/lawfirms/${firm.id}/matters/${doomed}`);
      expect(res.status).toBe(200);
      expect(recipients).toContain(owner.uid);
    } finally {
      eventBus.off(TASK_DELETED, listener);
    }
  });

  it('bulk deletion finishes task cleanup with each former matter member', async () => {
    const colleague = await createFirmMember(firm.id);
    await testPool.query(
      `insert into matter_members (matter_id, user_id, law_firm_id, role, joined_at)
       values ($1, $2, $3, 'member', now())`,
      [doomed, colleague.uid, firm.id],
    );
    let finished = false;
    let recipients: string[] | undefined;
    const listener = async ({ taskId, recipientUserIds }: { taskId: string; recipientUserIds?: string[] }) => {
      if (taskId !== doomedGraph.taskId) return;
      recipients = recipientUserIds;
      await new Promise((resolve) => setTimeout(resolve, 50));
      finished = true;
    };
    eventBus.on(TASK_DELETED, listener);
    try {
      const res = await owner.api.post(`/api/lawfirms/${firm.id}/matters/bulk-delete`)
        .send({ matterIds: [doomed] });
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(1);
      expect(recipients?.sort()).toEqual([owner.uid, colleague.uid].sort());
      expect(finished).toBe(true);
      expect(await rowCount('matters', 'id', doomed)).toBe(0);
    } finally {
      eventBus.off(TASK_DELETED, listener);
    }
  });

  // One DELETE on the heavy fixture, with four independent readings of it.
  //
  // RED IF: any of the seeded tables loses its `(law_firm_id, matter_id)`
  // cascade; the delete route stops actually removing the matter row; the
  // conversation tag stops being a tag; or the cascade widens past its matter
  // or past `law_firm_id`.
  it('cascades the matter graph, leaves conversations tagged, and touches no other matter or firm', async () => {
    const res = await owner.api.delete(`/api/lawfirms/${firm.id}/matters/${doomed}`);
    expect(res.status).toBe(200);

    // 1. Notes, replies, document requests and items, subtasks, events,
    //    contact links and activity all go with the matter.
    expect(await rowCount('matters', 'id', doomed)).toBe(0);
    expect(await rowCount('notes', 'id', doomedGraph.noteId)).toBe(0);
    expect(await rowCount('note_replies', 'id', doomedGraph.replyId)).toBe(0);
    expect(await rowCount('document_requests', 'id', doomedGraph.requestId)).toBe(0);
    expect(await rowCount('document_request_items', 'id', doomedGraph.requestItemId)).toBe(0);
    expect(await rowCount('tasks', 'id', doomedGraph.taskId)).toBe(0);
    expect(await rowCount('task_subtasks', 'id', doomedGraph.subtaskId)).toBe(0);
    expect(await rowCount('events', 'id', doomedGraph.eventId)).toBe(0);
    expect(await rowCount('matter_contacts', 'id', doomedGraph.matterContactId)).toBe(0);
    expect(await rowCount('activity_log', 'id', doomedGraph.activityId)).toBe(0);
    expect(await rowCount('conversation_matters', 'conversation_id', doomedGraph.conversationId)).toBe(0);

    // 2. The group conversation and its message stay, with a now-stale primary
    //    matter id: schema.sql's stated design is that matter_id on
    //    conversations/messages is a tag, not a constrained reference.
    const { rows: convRows } = await testPool.query(
      `select matter_id from conversations where id = $1`, [doomedGraph.conversationId],
    );
    expect(convRows).toHaveLength(1);
    expect(convRows[0].matter_id).toBe(doomed);

    const { rows: msgRows } = await testPool.query(
      `select matter_id from messages where id = $1`, [doomedGraph.messageId],
    );
    expect(msgRows).toHaveLength(1);
    expect(msgRows[0].matter_id).toBe(doomed);

    // 3. An unrelated same-firm matter with an identical graph is untouched.
    // 4. So is the other firm's. Both firms' matters were created back to back,
    //    so a firm-scope leak has adjacent ids to collide with.
    for (const [matterId, graph] of [[sibling, siblingGraph], [rivalMatter, rivalGraph]] as const) {
      expect(await rowCount('matters', 'id', matterId)).toBe(1);
      expect(await rowCount('notes', 'id', graph.noteId)).toBe(1);
      expect(await rowCount('note_replies', 'id', graph.replyId)).toBe(1);
      expect(await rowCount('document_requests', 'id', graph.requestId)).toBe(1);
      expect(await rowCount('document_request_items', 'id', graph.requestItemId)).toBe(1);
      expect(await rowCount('tasks', 'id', graph.taskId)).toBe(1);
      expect(await rowCount('task_subtasks', 'id', graph.subtaskId)).toBe(1);
      expect(await rowCount('events', 'id', graph.eventId)).toBe(1);
      expect(await rowCount('matter_contacts', 'id', graph.matterContactId)).toBe(1);
      expect(await rowCount('activity_log', 'id', graph.activityId)).toBe(1);
      expect(await rowCount('conversation_matters', 'conversation_id', graph.conversationId)).toBe(1);
    }
  });

  // RED IF: a retried delete request (the client double-submitting, or a
  // second tab) throws something other than a clean not-found, or manages to
  // re-run the cascade against whatever now occupies the id.
  it('retrying the same delete request after the matter is already gone answers not-found and touches nothing else', async () => {
    const first = await owner.api.delete(`/api/lawfirms/${firm.id}/matters/${doomed}`);
    expect(first.status).toBe(200);

    const second = await owner.api.delete(`/api/lawfirms/${firm.id}/matters/${doomed}`);
    expect(second.status).toBe(404);

    expect(await rowCount('matters', 'id', sibling)).toBe(1);
    expect(await rowCount('notes', 'id', siblingGraph.noteId)).toBe(1);
    expect(await rowCount('matters', 'id', rivalMatter)).toBe(1);
    expect(await rowCount('notes', 'id', rivalGraph.noteId)).toBe(1);
  });
});
