/**
 * The conversation list's preview is DERIVED from the newest message.
 *
 * `conversations` used to carry the preview as a column, written once at send
 * and never touched again. It could not follow an edit, a delete, or anything
 * else that changed the message it was quoting, and every read already joined
 * that message and coalesced the copy over the join.
 *
 * The copy is gone. What replaces it is one SQL expression,
 * `NEWEST_MESSAGE_PREVIEW` in `messaging.repository.ts`, used by the direct
 * list, the group list and all three search predicates. These cases pin its
 * rules, because a derived preview has more ways to be subtly wrong than a
 * stored one:
 *
 *   - it must skip system rows, which the stored copy did by never being
 *     written for them;
 *   - it must render an attachment-only message as its attachment, which the
 *     stored copy did in TypeScript at send time;
 *   - it must follow an edit, which the stored copy could not;
 *   - it must show nothing for a soft-deleted message, which the stored copy
 *     never did: every other read path masks a deleted message and the list
 *     went on quoting its first 100 characters forever.
 *
 * WHAT MAKES THESE GO RED: re-adding either column, or a change to that
 * expression that drops one of the four rules. The list preview is what a
 * reader sees before opening a thread, so a blank or stale one is visible
 * damage that no other suite would notice.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  ownerOf,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: { uid: string; api: any };
let clientUid: string;
let conversationId: string;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  clientUid = `client-${randomUUID().slice(0, 8)}`;
  await testPool.query(
    `insert into users (id, email, name, user_type) values ($1, $2, 'Portal Person', 'client')`,
    [clientUid, `${clientUid}@example.test`],
  );
  const { rows } = await testPool.query(
    `insert into conversations (law_firm_id, client_id, last_message_at)
     values ($1, $2, now()) returning id`,
    [firm.id, clientUid],
  );
  conversationId = rows[0].id;
});

/**
 * One message on the thread. `createdAt` is explicit wherever order matters:
 * two rows inserted in the same statement batch can share a timestamp, and
 * "the newest message" is the whole subject here.
 */
async function seedMessage(opts: {
  content?: string;
  attachments?: unknown[];
  kind?: 'user' | 'system';
  deleted?: boolean;
  createdAt?: string;
} = {}): Promise<string> {
  const { rows } = await testPool.query(
    `insert into messages (conversation_id, law_firm_id, sender_user_id, sender_type,
                           content, attachments, kind, deleted_at, created_at)
     values ($1, $2, $3, 'firm_member', $4, $5::jsonb, $6, $7,
             coalesce($8::timestamptz, now()))
     returning id`,
    [
      conversationId, firm.id, owner.uid,
      opts.content ?? '',
      JSON.stringify(opts.attachments ?? []),
      opts.kind ?? 'user',
      opts.deleted ? new Date() : null,
      opts.createdAt ?? null,
    ],
  );
  return rows[0].id;
}

const previewOf = async () => {
  const res = await owner.api.get(`/api/lawfirms/${firm.id}/messaging/conversations`);
  expect(res.status).toBe(200);
  const list = res.body.conversations ?? res.body.items ?? [];
  expect(list).toHaveLength(1);
  return list[0].lastMessagePreview;
};

describe('the conversation list preview', () => {
  it('carries neither the preview nor the full-body column it replaced', async () => {
    const { rows } = await testPool.query(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'conversations'
          and column_name in ('last_message_preview', 'last_message_content')
        order by column_name`,
    );
    expect(rows).toEqual([]);
  });

  it('quotes the newest message', async () => {
    await seedMessage({ content: 'Filed the motion this morning.', createdAt: '2026-03-01T10:00:00Z' });
    await seedMessage({ content: 'The deposition is confirmed for Tuesday.', createdAt: '2026-03-02T10:00:00Z' });

    expect(await previewOf()).toBe('The deposition is confirmed for Tuesday.');
  });

  it('follows an edit, which a copy written at send could not', async () => {
    const id = await seedMessage({ content: 'Hearing is on the 4th.' });
    expect(await previewOf()).toBe('Hearing is on the 4th.');

    await testPool.query(
      `update messages set content = 'Hearing moved to the 11th.', edited_at = now() where id = $1`,
      [id],
    );

    expect(await previewOf()).toBe('Hearing moved to the 11th.');
  });

  it('shows the deleted tombstone for a soft-deleted newest message', async () => {
    await seedMessage({ content: 'Kept message.', createdAt: '2026-03-01T10:00:00Z' });
    await seedMessage({ content: 'Sent by mistake.', deleted: true, createdAt: '2026-03-02T10:00:00Z' });

    // Not the previous message, and not the deleted text either. The list shows
    // the same tombstone the thread renders for a deleted message.
    expect(await previewOf()).toBe('Message deleted');
  });

  it('names the attachment when the message has no text', async () => {
    await seedMessage({ content: '', attachments: [{ name: 'Exhibit A.pdf' }] });

    expect(await previewOf()).toBe('[Attachment: Exhibit A.pdf]');
  });

  it('stays on real messages when a participant event is the newest row', async () => {
    await seedMessage({ content: 'The last thing anyone said.', createdAt: '2026-03-01T10:00:00Z' });
    await seedMessage({
      content: 'Dana Ross was added to the conversation',
      kind: 'system',
      createdAt: '2026-03-02T10:00:00Z',
    });

    // A system row is an inline add/remove event that the UI renders from its
    // own payload. Letting it become the preview would replace the last thing
    // anyone actually said with a membership change.
    expect(await previewOf()).toBe('The last thing anyone said.');
  });

  it('truncates to a hundred characters', async () => {
    await seedMessage({ content: 'x'.repeat(250) });

    expect(await previewOf()).toBe('x'.repeat(100));
  });

  it('is empty for a thread with no messages', async () => {
    expect(await previewOf()).toBe('');
  });
});

/**
 * Searching the conversation LIST, not the messages in one thread.
 *
 * The list search matched `last_message_preview` alongside the client's name
 * and the group title. That column is gone, so the same three predicates now
 * reach the derived preview instead. All three are the same expression, and a
 * change that broke it would silently narrow every search rather than fail.
 */
describe('searching the conversation list', () => {
  const found = async (q: string, path = 'conversations') => {
    const res = await owner.api.get(
      `/api/lawfirms/${firm.id}/messaging/${path}?search=${encodeURIComponent(q)}`,
    );
    expect(res.status).toBe(200);
    return res.body.conversations ?? res.body.items ?? [];
  };

  it('matches a thread on the text of its newest message', async () => {
    await seedMessage({ content: 'Subpoena served on the registered agent.' });

    expect(await found('registered agent')).toHaveLength(1);
    expect(await found('registered agent', 'inbox')).toHaveLength(1);
  });

  it('does not match on a term the thread never contained', async () => {
    await seedMessage({ content: 'Subpoena served on the registered agent.' });

    // The sibling above proves the search runs at all, so this one is a real
    // filter rather than a query that returns nothing for its own reasons.
    expect(await found('mediation')).toHaveLength(0);
  });
});
