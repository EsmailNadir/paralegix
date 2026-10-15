/**
 * The three readers behind `/list`, `/list-folder` and `/search`.
 *
 * A file is a client's confidential document, so the first property is that one
 * firm's documents never surface in another firm's browser. The second is that a
 * matter-linked task's documents belong to the TASK: they sit in the matter's
 * own tree, tagged with the task id, so the matter browser has to exclude them
 * by ownership and the task browser has to pull them back in. That split is the
 * fiddliest rule in the module and each of the three readers applies it.
 *
 * There is one implementation now. There used to be two of every reader, one
 * over the storage bucket and one over the table, chosen by a flag that was
 * never turned on because they had drifted: the table half returned direct
 * children only, so a file picker could not reach a document two folders down,
 * and it did not apply the task-ownership split, so a matter listing would have
 * shown every task's attachments. Both of those have their own case below.
 */
import {
  createFirm,
  createFirmMember,
  memberWith,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { installInMemoryBucket, objects } from '../support/inMemoryBucket';
import { joinMatter, rootOf, seedFile, seedFolder, seedMatter, seedTask } from './fileWorld';

installInMemoryBucket();

const filesRepo = require('../../src/modules/files/files.repository');

let firm: Firm;
let owner: Actor;
let matterId: string;
let taskId: string;
let root: string;

/** The other firm. Its documents must never appear in this firm's answers. */
let rival: Firm;
let rivalOwner: Actor;

const F = (lawFirmId: string) => `/api/lawfirms/${lawFirmId}/files`;

beforeEach(async () => {
  objects.clear();
  firm = await createFirm({ name: 'Reader & Co' });
  owner = await ownerOf(firm.id);
  matterId = await seedMatter(firm.id, owner.uid, 'Ellis v. Hart');
  root = await rootOf(firm.id, { matterId });
  // A matter-linked task: its documents live in the matter's tree, tagged.
  taskId = await seedTask(firm.id, { matterId, title: 'Serve the complaint' });

  rival = await createFirm({ name: 'Rival LLP' });
  rivalOwner = await ownerOf(rival.id);
});

describe('GET /list paging', () => {
  const list = (query: string) => owner.api.get(`${F(firm.id)}/list?matterId=${matterId}&${query}`);

  /** Walk every page and return the names in order. */
  async function drain(pageSize: number): Promise<string[]> {
    const names: string[] = [];
    let cursor = '';
    let pages = 0;
    do {
      // eslint-disable-next-line no-await-in-loop -- paging is the subject
      const res = await list(`limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(res.status).toBe(200);
      expect(res.body.files.length).toBeLessThanOrEqual(pageSize);
      names.push(...res.body.files.map((f: any) => f.name));
      cursor = res.body.cursor || '';
      pages += 1;
      expect(pages).toBeLessThan(50);
    } while (cursor);
    return names;
  }

  it('returns one page and a cursor, not the whole scope', async () => {
    for (const n of ['a', 'b', 'c', 'd', 'e']) {
      // eslint-disable-next-line no-await-in-loop -- ordering keeps names stable
      await seedFile(firm.id, { parentId: root, name: `${n}.pdf` });
    }

    const res = await list('limit=2');

    // The read behind this used to return every descendant row of the scope,
    // so its cost grew with how long the firm had used the product rather than
    // with the request.
    expect(res.body.files).toHaveLength(2);
    expect(res.body.cursor).toBeTruthy();
    expect(res.body.truncated).toBe(true);
  });

  it('covers the whole scope across pages, with nothing missed or repeated', async () => {
    const made = ['a', 'b', 'c', 'd', 'e'];
    for (const n of made) {
      // eslint-disable-next-line no-await-in-loop -- ordering keeps names stable
      await seedFile(firm.id, { parentId: root, name: `${n}.pdf` });
    }

    const seen = await drain(2);

    expect(seen.sort()).toEqual(made.map((n) => `${n}.pdf`));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('says it is finished on the last page', async () => {
    await seedFile(firm.id, { parentId: root, name: 'only.pdf' });

    const res = await list('limit=10');

    // A cursor here sends the client back for an empty page every time.
    expect(res.body.cursor).toBeNull();
    expect(res.body.truncated).toBe(false);
  });

  it('keeps the old response shape, so a client that ignores the cursor still works', async () => {
    await seedFile(firm.id, { parentId: root, name: 'one.pdf' });

    const res = await list('');

    expect(res.body).toEqual(expect.objectContaining({
      rootId: root, count: 1, truncated: false,
    }));
    expect(Array.isArray(res.body.files)).toBe(true);
  });

  it('still excludes another firm while paging', async () => {
    // Paging must not become a way around the scope check. A cursor is opaque
    // but a caller can still send one, and the firm is resolved from the route
    // and the token, never from the cursor.
    const rivalMatter = await seedMatter(rival.id, rivalOwner.uid, 'Theirs');
    const rivalRoot = await rootOf(rival.id, { matterId: rivalMatter });
    await seedFile(rival.id, { parentId: rivalRoot, name: 'Privileged.pdf' });
    await seedFile(firm.id, { parentId: root, name: 'Ours.pdf' });

    const seen = await drain(1);

    expect(seen).toEqual(['Ours.pdf']);
  });

  it('still applies the task-ownership split while paging', async () => {
    await seedFile(firm.id, { parentId: root, name: 'task-owned.pdf', taskId });
    await seedFile(firm.id, { parentId: root, name: 'matter-owned.pdf' });

    // A page size of one puts a page boundary between the two, which is where a
    // filter applied to the page rather than the query would show up.
    const seen = await drain(1);

    expect(seen).toEqual(['matter-owned.pdf']);
  });

  it('restarts rather than failing on a cursor it cannot read', async () => {
    await seedFile(firm.id, { parentId: root, name: 'one.pdf' });

    const res = await list('cursor=not-a-real-cursor');

    // A cursor reaches the server from a bookmark or a truncated query string.
    // A 500 there turns a stale link into an outage.
    expect(res.status).toBe(200);
    expect(res.body.files.map((f: any) => f.name)).toEqual(['one.pdf']);
  });
});

describe('GET /list', () => {
  const list = (lawFirmId: string, actor: Actor, id = matterId) =>
    actor.api.get(`${F(lawFirmId)}/list?matterId=${id}`);

  it("returns the matter's own documents", async () => {
    await seedFile(firm.id, { parentId: root, name: 'Complaint.pdf' });
    await seedFile(firm.id, { parentId: root, name: 'Answer.pdf' });

    const res = await list(firm.id, owner);

    expect(res.status).toBe(200);
    expect(res.body.files.map((f: any) => f.name).sort()).toEqual(['Answer.pdf', 'Complaint.pdf']);
  });

  it('reaches a document two folders down', async () => {
    const a = await seedFolder(firm.id, { parentId: root, name: 'Discovery' });
    const b = await seedFolder(firm.id, { parentId: a.id, name: 'Depositions' });
    const deep = await seedFile(firm.id, { parentId: b.id, name: 'transcript.pdf' });

    const res = await list(firm.id, owner);

    // This is what the file pickers read, and a picker that could not reach a
    // nested document could not be used to attach one. The old table-backed
    // half returned direct children only, which is the defect that kept the
    // whole path switched off.
    expect(res.body.files.map((f: any) => f.id)).toContain(deep.id);
  });

  it("withholds another firm's documents", async () => {
    const rivalMatter = await seedMatter(rival.id, rivalOwner.uid, 'Theirs');
    const rivalRoot = await rootOf(rival.id, { matterId: rivalMatter });
    const theirs = await seedFile(rival.id, { parentId: rivalRoot, name: 'Privileged.pdf' });
    await seedFile(firm.id, { parentId: root, name: 'Ours.pdf' });

    const res = await list(firm.id, owner);

    // Asserted against a document that really exists: an empty answer from an
    // empty table would prove nothing.
    expect(res.body.files.map((f: any) => f.name)).toEqual(['Ours.pdf']);
    expect(res.body.files.map((f: any) => f.id)).not.toContain(theirs.id);
  });

  it('puts folders ahead of files', async () => {
    await seedFile(firm.id, { parentId: root, name: 'Aaa.pdf' });
    await seedFolder(firm.id, { parentId: root, name: 'Zzz' });

    const res = await list(firm.id, owner);

    // Alphabetically the file comes first, so this fails if the ordering is a
    // plain name sort.
    expect(res.body.files[0]).toMatchObject({ name: 'Zzz', isFolder: true });
  });

  it('describes a folder as a folder rather than a zero-byte file', async () => {
    await seedFolder(firm.id, { parentId: root, name: 'Contracts' });

    const res = await list(firm.id, owner);

    expect(res.body.files[0]).toMatchObject({
      name: 'Contracts', isFolder: true, contentType: 'folder', size: 0,
    });
  });

  it('carries the stored size and mime type onto a file entry', async () => {
    await seedFile(firm.id, { parentId: root, name: 'Brief.pdf', bytes: 4096, contentType: 'application/pdf' });

    const res = await list(firm.id, owner);

    expect(res.body.files[0]).toMatchObject({ size: 4096, contentType: 'application/pdf' });
  });

  it('falls back to a generic mime type for a row that has none', async () => {
    const doc = await seedFile(firm.id, { parentId: root, name: 'Unknown' });
    await testPool.query('update files set mime_type = null where id = $1', [doc.id]);

    const res = await list(firm.id, owner);

    expect(res.body.files[0].contentType).toBe('application/octet-stream');
  });

  it('reports which documents are shared with the client portal', async () => {
    await seedFile(firm.id, { parentId: root, name: 'Shared.pdf', clientVisible: true });
    await seedFile(firm.id, { parentId: root, name: 'Internal.pdf' });

    const res = await list(firm.id, owner);

    const byName = Object.fromEntries(res.body.files.map((f: any) => [f.name, f.clientVisible]));
    // The pair matters: a reader that reported everything as shared would pass
    // the first assertion on its own.
    expect(byName['Shared.pdf']).toBe(true);
    expect(byName['Internal.pdf']).toBe(false);
  });

  it('refuses a matter belonging to another firm', async () => {
    const rivalMatter = await seedMatter(rival.id, rivalOwner.uid, 'Theirs');

    const res = await owner.api.get(`${F(firm.id)}/list?matterId=${rivalMatter}`);

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('GET /list-folder', () => {
  const listFolder = (params: string) =>
    owner.api.get(`${F(firm.id)}/list-folder?${params}`);

  it("returns the matter root's children", async () => {
    await seedFolder(firm.id, { parentId: root, name: 'Contracts' });
    await seedFile(firm.id, { parentId: root, name: 'Complaint.pdf' });

    const res = await listFolder(`matterId=${matterId}`);

    expect(res.status).toBe(200);
    expect(res.body.files.map((f: any) => f.name)).toEqual(['Contracts', 'Complaint.pdf']);
  });

  it("does NOT show a matter-linked task's documents in the matter browser", async () => {
    await seedFile(firm.id, { parentId: root, name: 'Matter Own.pdf' });
    await seedFile(firm.id, { parentId: root, name: 'Task Attachment.pdf', taskId });

    const res = await listFolder(`matterId=${matterId}`);

    // A matter-linked task files into the matter's tree, so without the
    // ownership split every task's attachments fill the matter's browser. The
    // old table-backed reader had no such filter, which is the second reason
    // the read switch was never flipped.
    expect(res.body.files.map((f: any) => f.name)).toEqual(['Matter Own.pdf']);
  });

  it("shows the task's own documents when the listing is narrowed to a task", async () => {
    await seedFile(firm.id, { parentId: root, name: 'Matter Own.pdf' });
    await seedFile(firm.id, { parentId: root, name: 'Task Attachment.pdf', taskId });

    const res = await listFolder(`matterId=${matterId}&taskId=${taskId}`);

    // The other half of the same rule, and what makes the exclusion above a
    // split rather than a document disappearing.
    expect(res.body.files.map((f: any) => f.name)).toEqual(['Task Attachment.pdf']);
  });

  it("withholds another firm's rows", async () => {
    const rivalMatter = await seedMatter(rival.id, rivalOwner.uid, 'Theirs');
    const rivalRoot = await rootOf(rival.id, { matterId: rivalMatter });
    const theirs = await seedFile(rival.id, { parentId: rivalRoot, name: 'Privileged.pdf' });
    await seedFile(firm.id, { parentId: root, name: 'Ours.pdf' });

    const res = await listFolder(`matterId=${matterId}`);

    expect(res.body.files.map((f: any) => f.id)).not.toContain(theirs.id);
  });

  it("counts a folder's recursive children", async () => {
    const contracts = await seedFolder(firm.id, { parentId: root, name: 'Contracts' });
    const signed = await seedFolder(firm.id, { parentId: contracts.id, name: 'Signed' });
    await seedFile(firm.id, { parentId: signed.id, name: 'a.pdf' });
    await seedFile(firm.id, { parentId: contracts.id, name: 'b.pdf' });

    const res = await listFolder(`matterId=${matterId}`);

    // The count is recursive while the listing is one level, which is what lets
    // the browser say "Contracts, 2 files" without loading them. The folder's
    // own row must not be counted as one of its children.
    expect(res.body.files[0]).toMatchObject({ name: 'Contracts', fileCount: 2, folderCount: 1 });
  });

  it('carries the folder colour and portal share state', async () => {
    await seedFolder(firm.id, { parentId: root, name: 'Urgent', color: '#ff0000', clientVisible: true });

    const res = await listFolder(`matterId=${matterId}`);

    expect(res.body.files[0]).toMatchObject({ folderColor: '#ff0000', clientVisible: true });
  });

  it('descends into a named folder', async () => {
    const contracts = await seedFolder(firm.id, { parentId: root, name: 'Contracts' });
    await seedFile(firm.id, { parentId: contracts.id, name: 'inside.pdf' });
    await seedFile(firm.id, { parentId: root, name: 'outside.pdf' });

    const res = await listFolder(`matterId=${matterId}&folderId=${contracts.id}`);

    expect(res.body.files.map((f: any) => f.name)).toEqual(['inside.pdf']);
  });

  it('shows only the level asked for, not the whole subtree', async () => {
    const contracts = await seedFolder(firm.id, { parentId: root, name: 'Contracts' });
    const signed = await seedFolder(firm.id, { parentId: contracts.id, name: 'Signed' });
    await seedFile(firm.id, { parentId: signed.id, name: 'buried.pdf' });

    const res = await listFolder(`matterId=${matterId}&folderId=${contracts.id}`);

    // A browser shows one level. Pulling the subtree in was what made opening a
    // deep folder cost more the deeper it got.
    expect(res.body.files.map((f: any) => f.name)).toEqual(['Signed']);
  });

  it('reports the breadcrumb of the folder it listed', async () => {
    const contracts = await seedFolder(firm.id, { parentId: root, name: 'Contracts' });
    const signed = await seedFolder(firm.id, { parentId: contracts.id, name: 'Signed' });

    const res = await listFolder(`matterId=${matterId}&folderId=${signed.id}`);

    // The browser used to build this by splitting an object path. It comes from
    // the parent chain now, which is why a rename cannot break it.
    expect(res.body.breadcrumb.map((b: any) => b.name)).toEqual(['Contracts', 'Signed']);
  });

  it('reports a share inherited from an ancestor folder', async () => {
    const shared = await seedFolder(firm.id, { parentId: root, name: 'Shared', clientVisible: true });
    const inner = await seedFolder(firm.id, { parentId: shared.id, name: 'Inner' });

    const res = await listFolder(`matterId=${matterId}&folderId=${inner.id}`);

    // Lets the firm side show the documents inside a shared folder as visible.
    // One walk up the parent chain, rather than one storage call per ancestor.
    expect(res.body.inheritedClientVisible).toBe(true);
  });
});

describe('GET /search', () => {
  const search = (query: string, extra = '') =>
    owner.api.get(`${F(firm.id)}/search?matterId=${matterId}&query=${encodeURIComponent(query)}${extra}`);

  it('finds a document nested in a folder', async () => {
    const contracts = await seedFolder(firm.id, { parentId: root, name: 'Contracts' });
    const buried = await seedFile(firm.id, { parentId: contracts.id, name: 'Settlement Agreement.pdf' });
    await seedFile(firm.id, { parentId: root, name: 'Unrelated.pdf' });

    const res = await search('settlement');

    expect(res.status).toBe(200);
    expect(res.body.files.map((f: any) => f.id)).toEqual([buried.id]);
  });

  it('says which folder a hit lives in', async () => {
    const contracts = await seedFolder(firm.id, { parentId: root, name: 'Contracts' });
    const signed = await seedFolder(firm.id, { parentId: contracts.id, name: 'Signed' });
    await seedFile(firm.id, { parentId: signed.id, name: 'retainer.pdf' });

    const res = await search('retainer');

    // A hit with no way back to where it lives is a name and nothing else.
    expect(res.body.files[0].folderPath).toBe('Contracts/Signed');
  });

  it("withholds another firm's matching documents", async () => {
    const rivalMatter = await seedMatter(rival.id, rivalOwner.uid, 'Theirs');
    const rivalRoot = await rootOf(rival.id, { matterId: rivalMatter });
    const theirs = await seedFile(rival.id, { parentId: rivalRoot, name: 'Settlement Theirs.pdf' });
    await seedFile(firm.id, { parentId: root, name: 'Settlement Ours.pdf' });

    const res = await search('settlement');

    expect(res.body.files.map((f: any) => f.id)).not.toContain(theirs.id);
    expect(res.body.files.map((f: any) => f.name)).toEqual(['Settlement Ours.pdf']);
  });

  it("keeps a task's documents out of a matter search", async () => {
    await seedFile(firm.id, { parentId: root, name: 'Notice Matter.pdf' });
    await seedFile(firm.id, { parentId: root, name: 'Notice Task.pdf', taskId });

    const res = await search('notice');

    // The same ownership split the listings apply. A search that ignored it
    // would surface through the box sitting above the matter's own documents.
    expect(res.body.files.map((f: any) => f.name)).toEqual(['Notice Matter.pdf']);
  });
});

describe('GET /search is bounded', () => {
  const search = (query: string) =>
    owner.api.get(`${F(firm.id)}/search?matterId=${matterId}&query=${encodeURIComponent(query)}`);

  it('returns at most 200 hits and says there are more', async () => {
    for (let i = 0; i < 205; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- fixture rows
      await seedFile(firm.id, { parentId: root, name: `agreement-${String(i).padStart(3, '0')}.pdf`, bytes: 8 });
    }

    const res = await search('agreement');

    // Every hit costs a recursive ancestor query and a signed URL. A search for
    // a common word in a large matter was all of them, in one request.
    expect(res.status).toBe(200);
    expect(res.body.files).toHaveLength(200);
    expect(res.body.truncated).toBe(true);
  });

  it('says nothing was held back when every hit fits', async () => {
    for (const name of ['lease-a.pdf', 'lease-b.pdf', 'lease-c.pdf']) {
      // eslint-disable-next-line no-await-in-loop -- fixture rows
      await seedFile(firm.id, { parentId: root, name, bytes: 8 });
    }

    const res = await search('lease');

    expect(res.body.files.map((f: any) => f.name)).toEqual(['lease-a.pdf', 'lease-b.pdf', 'lease-c.pdf']);
    expect(res.body.truncated).toBe(false);
  });

  it('resolves hit trails with no more than eight ancestor reads in flight', async () => {
    for (let i = 0; i < 30; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- fixture rows
      await seedFile(firm.id, { parentId: root, name: `deed-${String(i).padStart(2, '0')}.pdf`, bytes: 8 });
    }

    let inFlight = 0;
    let peak = 0;
    const realAncestors = filesRepo.ancestors.bind(filesRepo);
    const spy = jest.spyOn(filesRepo, 'ancestors').mockImplementation(async (...args: any[]) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await new Promise((resolve) => { setTimeout(resolve, 5); });
        return await realAncestors(...args);
      } finally {
        inFlight -= 1;
      }
    });

    try {
      const res = await search('deed');
      expect(res.body.files).toHaveLength(30);
      // One recursive query per hit, all at once, is thirty pool connections
      // asked for by one request on a pool of ten.
      expect(peak).toBeLessThanOrEqual(8);
      expect(res.body.files[0].trail).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('a search hit says where it lives', () => {
  it('carries the trail of folders above it, by id', async () => {
    const root = await rootOf(firm.id, { matterId });
    const discovery = await seedFolder(firm.id, { parentId: root, name: 'Discovery' });
    const depositions = await seedFolder(firm.id, { parentId: discovery.id, name: 'Depositions' });
    const buried = await seedFile(firm.id, { parentId: depositions.id, name: 'transcript.pdf' });

    const res = await owner.api.get(`${F(firm.id)}/search?lawFirmId=${firm.id}&matterId=${matterId}&query=transcript`);

    // A search spans the whole scope, so a hit can sit anywhere under it.
    // Opening one has to move the browser to where the hit actually is, and the
    // trail of ids is what it moves by. The names alone would not do it: two
    // folders can share a name in different parts of the tree.
    const hit = res.body.files.find((f: any) => f.id === buried.id);
    expect(hit.trail).toEqual([
      { id: discovery.id, name: 'Discovery' },
      { id: depositions.id, name: 'Depositions' },
    ]);
    expect(hit.folderPath).toBe('Discovery/Depositions');
  });

  it('gives a hit at the scope root an empty trail', async () => {
    const root = await rootOf(firm.id, { matterId });
    const top = await seedFile(firm.id, { parentId: root, name: 'toplevel.pdf' });

    const res = await owner.api.get(`${F(firm.id)}/search?lawFirmId=${firm.id}&matterId=${matterId}&query=toplevel`);

    // The boundary from the other side: the root is not a crumb, so a hit
    // sitting in it navigates to nowhere rather than to a nameless folder.
    const hit = res.body.files.find((f: any) => f.id === top.id);
    expect(hit.trail).toEqual([]);
    expect(hit.folderPath).toBe('');
  });
});

describe('where one document sits', () => {
  it('answers the scope and the folders above it', async () => {
    const root = await rootOf(firm.id, { matterId });
    const discovery = await seedFolder(firm.id, { parentId: root, name: 'Discovery' });
    const doc = await seedFile(firm.id, { parentId: discovery.id, name: 'notice.pdf' });

    const res = await owner.api.get(`${F(firm.id)}/location?lawFirmId=${firm.id}&fileId=${doc.id}`);

    // "Reveal this file" needs this: a surface holding only a file id has to
    // move the browser to the right folder before it can flash the row. It used
    // to slice the object path, which no longer says anything about the tree.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ fileId: doc.id, scope: 'matter', matterId });
    expect(res.body.trail).toEqual([{ id: discovery.id, name: 'Discovery' }]);
  });

  it('refuses a document the caller cannot read', async () => {
    const walled = await memberWith(firm.id, ['files.view']);
    const root = await rootOf(firm.id, { matterId });
    const secret = await seedFolder(firm.id, { parentId: root, name: 'Privileged' });
    const doc = await seedFile(firm.id, { parentId: secret.id, name: 'strategy.pdf' });

    const res = await walled.api.get(`${F(firm.id)}/location?lawFirmId=${firm.id}&fileId=${doc.id}`);

    // The same gate the download path applies. Folder NAMES alone say how a
    // walled-off matter is organised, so describing a document's location is a
    // read of it.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.trail).toBeUndefined();
  });

  it('refuses a document belonging to another firm', async () => {
    const rival = await createFirm({ name: 'Rival LLP' });
    const rivalOwner = await ownerOf(rival.id);
    const rivalMatter = await seedMatter(rival.id, rivalOwner.uid, 'Theirs');
    const rivalRoot = await rootOf(rival.id, { matterId: rivalMatter });
    const theirs = await seedFile(rival.id, { parentId: rivalRoot, name: 'theirs.pdf' });

    const res = await owner.api.get(`${F(firm.id)}/location?lawFirmId=${firm.id}&fileId=${theirs.id}`);

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
