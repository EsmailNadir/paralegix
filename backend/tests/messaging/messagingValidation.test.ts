/**
 * The messaging validation matrix (B02.3): schema-level bounds that no other
 * messaging spec exercises.
 *
 * `messagingCore.test.ts` already covers content-length and required-content
 * rejection for a direct message; the gaps left are the array caps
 * (attachments, mentions, group participant/matter arrays), the attachment
 * shape's numeric field, the group-send content rule (the direct-send rule is
 * duplicated onto a second schema, `groupSendSchema`, and never independently
 * checked), and the standalone endpoints with their own bound (edit length,
 * mark-read's non-empty list, attach-from-files' 1..5 range, and search's
 * minimum query length).
 *
 * Every case below is a pure schema rejection: the array/string that violates
 * one bound is otherwise well-formed, so a regression that widens or removes
 * the bound is what turns these red, not a fixture problem.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  createPortalUser,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let clientUid: string;

const M = () => `/api/lawfirms/${firm.id}/messaging`;

function attachment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'att-1',
    name: 'file.pdf',
    url: 'https://storage.example.test/signed?X-Goog-Signature=deadbeef',
    objectPath: `lawfirmids/${firm.id}/messaging/${firm.id}_${clientUid}/file.pdf`,
    mimeType: 'application/pdf',
    size: 4096,
    ...overrides,
  };
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  const portal = await createPortalUser();
  clientUid = portal.uid;
  await createPersonClient(firm.id, { name: 'Messaged Client', userId: portal.uid });
  await drainEvents();
});

describe('sendMessageSchema array caps', () => {
  it('rejects more than 5 attachments on one message', async () => {
    const attachments = Array.from({ length: 6 }, (_, i) => attachment({ id: `att-${i}`, name: `f${i}.pdf` }));

    const res = await owner.api.post(`${M()}/send`)
      .send({ clientId: clientUid, content: 'Six files', attachments });

    // A cap that stopped being enforced would let a member silently exceed
    // whatever storage/UX assumption the 5-file limit protects.
    expect(res.status).toBe(400);
    const { rows } = await testPool.query(
      `select count(*)::int as n from messages where content = 'Six files'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('rejects more than 50 @mentions on one message', async () => {
    const mentions = Array.from({ length: 51 }, () => randomUUID());

    const res = await owner.api.post(`${M()}/send`)
      .send({ clientId: clientUid, content: 'Too many mentions', mentions });

    expect(res.status).toBe(400);
  });
});

describe('attachmentSchema numeric field', () => {
  it('rejects an attachment with a negative size', async () => {
    const res = await owner.api.post(`${M()}/send`)
      .send({ clientId: clientUid, content: 'Bad size', attachments: [attachment({ size: -1 })] });

    // `size` backs the storage-quota reserve; a negative value that slipped
    // through would undercharge (or corrupt) that accounting.
    expect(res.status).toBe(400);
  });
});

describe('groupSendSchema content rule', () => {
  it('rejects an empty group message with no attachment, same as a direct one', async () => {
    const created = await owner.api.post(`${M()}/groups`).send({ title: 'Empty check', clientIds: [clientUid] });
    expect(created.status).toBe(201);
    const conversationId = created.body.conversationId as string;

    const res = await owner.api.post(`${M()}/groups/${conversationId}/messages`).send({ content: '   ' });

    // groupSendSchema declares its own superRefine, separate from
    // sendMessageSchema's. If the two ever drift, the group route is the one
    // that would silently accept a blank bubble.
    expect(res.status).toBe(400);
  });
});

describe('editMessageSchema length cap', () => {
  it('rejects an edit past the 4000-character content cap', async () => {
    const sent = await owner.api.post(`${M()}/send`).send({ clientId: clientUid, content: 'Original' });
    expect(sent.status).toBe(201);
    const messageId = sent.body.messageId as string;

    const res = await owner.api.patch(`${M()}/messages/${messageId}`).send({ content: 'x'.repeat(4001) });

    expect(res.status).toBe(400);
    const { rows } = await testPool.query('select content from messages where id = $1', [messageId]);
    expect(rows[0].content).toBe('Original');
  });
});

describe('markReadSchema minimum list', () => {
  it('rejects mark-read with an empty messageIds array', async () => {
    const sent = await owner.api.post(`${M()}/send`).send({ clientId: clientUid, content: 'Hi' });
    expect(sent.status).toBe(201);

    const res = await owner.api.put(`${M()}/mark-read`)
      .send({ conversationId: sent.body.conversationId, messageIds: [] });

    // An empty list is a no-op the caller almost certainly didn't intend;
    // letting it through would make "no messageIds validation error" a silent
    // way to discover the field is now optional.
    expect(res.status).toBe(400);
  });
});

describe('attachFromFilesSchema list bounds', () => {
  it('rejects zero files', async () => {
    const res = await owner.api.post(`${M()}/attachments/from-files`)
      .send({ clientId: clientUid, files: [] });

    expect(res.status).toBe(400);
  });

  it('rejects more than 5 files', async () => {
    const files = Array.from({ length: 6 }, (_, i) => ({
      objectPath: `lawfirmids/${firm.id}/messaging/${firm.id}_${clientUid}/f${i}.pdf`,
    }));

    const res = await owner.api.post(`${M()}/attachments/from-files`)
      .send({ clientId: clientUid, files });

    expect(res.status).toBe(400);
  });
});

describe('createGroupSchema array caps', () => {
  it('rejects more than 20 organizationClientIds', async () => {
    const organizationClientIds = Array.from({ length: 21 }, () => randomUUID());

    const res = await owner.api.post(`${M()}/groups`)
      .send({ title: 'Too many orgs', organizationClientIds });

    expect(res.status).toBe(400);
    const { rows } = await testPool.query(
      `select count(*)::int as n from conversations where title = 'Too many orgs'`,
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('searchMessagesSchema minimum length', () => {
  it('rejects a one-character search query', async () => {
    const res = await owner.api.get(`${M()}/search?q=a`);

    expect(res.status).toBe(400);
  });
});
