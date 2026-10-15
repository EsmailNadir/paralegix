/**
 * GET /api/lawfirms/:lawFirmId/file-share-links, as the share dialog reads it.
 *
 * The dialog lists every live link on what it was opened for, and a link made
 * from a selection reaches more than that one item. So each listed link says
 * what it holds: the items the caller may read, by name, and a count of the
 * ones they may not. A link can mix matters, and a member walled off from one
 * must not learn a document's name from a link on something they can read.
 *
 * WHAT THESE TESTS PIN, and what has to break for each to go red:
 *
 *   - every link lists its items, a single-file link included. Drop the item
 *     lookup and the listing test sees none.
 *   - an item behind a wall the caller cannot cross is counted, never named.
 *     Name every item regardless and the walled document's name reaches the
 *     member's response.
 *   - a selection (`fileIds`) lists every link naming ANY selected item, each
 *     once. Match only the first id, or join without de-duplicating, and the
 *     selection test fails.
 *   - a selection is read-gated item by item, as creating a link from it is.
 */
import { installInMemoryBucket, objects } from '../support/inMemoryBucket';
import { rootOf, seedFile, seedFolder, seedMatter } from './fileWorld';
import {
  as,
  createFirm,
  createFirmMember,
  drainEvents,
  ownerOf,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

installInMemoryBucket();

let firm: Firm;
let owner: Actor;
let discovery: { id: string; name: string };
let engagement: { id: string };
let memo: { id: string };

const links = () => `/api/lawfirms/${firm.id}/file-share-links`;

async function createLink(body: Record<string, unknown>, api = owner.api) {
  const res = await api.post(links()).send(body);
  expect(res.status).toBe(201);
  return String(res.body.link.token);
}

beforeEach(async () => {
  objects.clear();
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  const firmRoot = await rootOf(firm.id, {});
  discovery = await seedFolder(firm.id, { parentId: firmRoot, name: 'Discovery' });
  engagement = await seedFile(firm.id, { parentId: firmRoot, name: 'Engagement Letter.pdf' });
  memo = await seedFile(firm.id, { parentId: firmRoot, name: 'Memo.pdf' });
  await drainEvents();
});

describe('each listed link says what it holds', () => {
  it('names every item of a multi-item link, and the one document of a single-file link', async () => {
    const bundle = await createLink({ fileIds: [discovery.id, engagement.id] });
    const single = await createLink({ fileId: engagement.id });

    const res = await owner.api.get(`${links()}?fileId=${engagement.id}`);

    expect(res.status).toBe(200);
    const byToken = new Map(res.body.links.map((l: any) => [l.token, l]));
    expect(byToken.get(bundle)).toMatchObject({
      items: [
        { fileId: discovery.id, name: 'Discovery', isFolder: true },
        { fileId: engagement.id, name: 'Engagement Letter.pdf', isFolder: false },
      ],
      hiddenItemCount: 0,
    });
    expect(byToken.get(single)).toMatchObject({
      items: [{ fileId: engagement.id, name: 'Engagement Letter.pdf', isFolder: false }],
      hiddenItemCount: 0,
    });
  });

  it('counts an item behind a matter wall without naming it', async () => {
    const walled = await seedMatter(firm.id, owner.uid, 'Walled Matter');
    const walledDoc = await seedFile(firm.id, {
      parentId: await rootOf(firm.id, { matterId: walled }), name: 'Walled Settlement.pdf',
    });
    // The owner reaches both, so the link is real.
    const token = await createLink({ fileIds: [engagement.id, walledDoc.id] });
    const member = await createFirmMember(firm.id, { isOwner: false, permissions: ['files.upload'] });
    const memberApi = as(tokenFor({ uid: member.uid }));

    const asMember = await memberApi.get(`${links()}?fileId=${engagement.id}`);
    const asOwner = await owner.api.get(`${links()}?fileId=${engagement.id}`);

    expect(asMember.status).toBe(200);
    expect(asMember.body.links).toHaveLength(1);
    expect(asMember.body.links[0]).toMatchObject({
      token,
      items: [{ fileId: engagement.id, name: 'Engagement Letter.pdf', isFolder: false }],
      hiddenItemCount: 1,
    });
    expect(JSON.stringify(asMember.body)).not.toContain('Walled Settlement.pdf');
    expect(JSON.stringify(asMember.body)).not.toContain(walledDoc.id);
    // The same link, read by someone who may, names both.
    expect(asOwner.body.links[0].items.map((i: any) => i.name))
      .toEqual(['Engagement Letter.pdf', 'Walled Settlement.pdf']);
    expect(asOwner.body.links[0].hiddenItemCount).toBe(0);
  });
});

describe('listing for a selection', () => {
  it('lists every link naming any selected item, each once, newest first', async () => {
    const onDiscovery = await createLink({ fileIds: [discovery.id] });
    const onBoth = await createLink({ fileIds: [discovery.id, engagement.id] });
    const onEngagement = await createLink({ fileId: engagement.id });
    await createLink({ fileId: memo.id });

    const res = await owner.api.get(`${links()}?fileIds=${discovery.id},${engagement.id}`);

    expect(res.status).toBe(200);
    expect(res.body.links.map((l: any) => l.token)).toEqual([onEngagement, onBoth, onDiscovery]);
  });

  it('refuses a selection holding an item the caller cannot read', async () => {
    const walled = await seedMatter(firm.id, null, 'Walled Matter');
    const walledDoc = await seedFile(firm.id, {
      parentId: await rootOf(firm.id, { matterId: walled }), name: 'Walled.pdf',
    });
    await createLink({ fileId: engagement.id });
    const member = await createFirmMember(firm.id, { isOwner: false, permissions: ['files.upload'] });
    const memberApi = as(tokenFor({ uid: member.uid }));

    // The positive half first: the readable item alone is listed.
    const alone = await memberApi.get(`${links()}?fileIds=${engagement.id}`);
    expect(alone.status).toBe(200);
    expect(alone.body.links).toHaveLength(1);

    const res = await memberApi.get(`${links()}?fileIds=${engagement.id},${walledDoc.id}`);
    expect(res.status).toBe(403);
    expect(res.body.links).toBeUndefined();
  });

  it("refuses another firm's item in a selection", async () => {
    const otherFirm = await createFirm();
    const theirs = await seedFile(otherFirm.id, { parentId: await rootOf(otherFirm.id, {}), name: 'Theirs.pdf' });

    const res = await owner.api.get(`${links()}?fileIds=${engagement.id},${theirs.id}`);

    expect(res.status).toBe(404);
  });

  it('takes exactly one of fileId and fileIds', async () => {
    const neither = await owner.api.get(links());
    const both = await owner.api.get(`${links()}?fileId=${memo.id}&fileIds=${engagement.id}`);

    expect(neither.status).toBe(400);
    expect(both.status).toBe(400);
  });
});
