/**
 * What actually ends up inside a downloaded archive.
 *
 * `GET /download-folder` and `POST /download-zip` are the only two routes in the
 * module whose answer is a stream rather than JSON, and the only two whose
 * correctness is invisible from the status line: a 200 carrying a zip with the
 * wrong contents looks exactly like a 200 carrying the right one, and the person
 * who finds out is whoever opens the production on the other end.
 *
 * So every case below reads the archive's central directory and asserts the
 * ENTRY NAMES. Three decisions live in those names and nowhere else:
 *
 *   - `.folder` markers are structural and must not appear as files,
 *   - entry paths are relative, so the folder structure survives the download,
 *   - a selection that names both a folder and a file inside it yields one copy.
 *
 * These are firm-side routes: `clientVisible` plays no part, and a mixed tree is
 * used throughout precisely to pin that. A firm member downloading their own
 * matter gets everything in it, shared or not, and an archive that quietly
 * dropped the unshared half would be a partial production handed over as a
 * complete one.
 */
import {
  createFirm,
  memberWith,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { installRichBucket, resetRichBucket, zipEntryNames, zipEntryCompressionMethods } from './richBucket';
import { exportArchive, type ExportResult } from './exportWorld';
import {
  joinMatter,
  rootOf,
  seedFile,
  seedFolder,
  seedMatter,
} from './fileWorld';

installRichBucket();

let firm: Firm;
let owner: Actor;
let matterId: string;
let matterRoot: string;

/** The ids the mixed tree below hands back, by their path within the matter. */
let tree: Record<string, string>;

const F = () => `/api/lawfirms/${firm.id}/files`;

const downloadFolder = (folderId: string, actor: Actor = owner): Promise<ExportResult> =>
  exportArchive(firm.id, actor, { matterId, folderId });

const downloadZip = (fileIds: string[], actor: Actor = owner): Promise<ExportResult> =>
  exportArchive(firm.id, actor, { matterId, fileIds });

/** The archive a successful export published, or a failure naming what came back instead. */
const entriesOf = (res: ExportResult): string[] => {
  if (!res.bytes) {
    throw new Error(
      `No archive was published: request ${res.status}, job ${res.jobStatus}`
      + `${res.failureCode ? ` (${res.failureCode})` : ''}`,
    );
  }
  return zipEntryNames(res.bytes);
};

/**
 * A tree that deliberately mixes shared and unshared documents at two depths:
 *
 *   Closing/                       (folder marker, shared with the portal)
 *     Deed.pdf                     shared
 *     Internal Memo.pdf            NOT shared
 *     Signed/                      (folder marker, not shared)
 *       Final Deed.pdf             shared
 *       Draft Notes.pdf            NOT shared
 *   Settlement.pdf                 at the matter root, outside Closing/
 */
async function seedMixedTree(): Promise<void> {
  const closing = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing', clientVisible: true });
  const deed = await seedFile(firm.id, { parentId: closing.id, name: 'Deed.pdf', bytes: 1024, clientVisible: true });
  const memo = await seedFile(firm.id, { parentId: closing.id, name: 'Internal Memo.pdf', bytes: 512 });
  const signed = await seedFolder(firm.id, { parentId: closing.id, name: 'Signed' });
  const finalDeed = await seedFile(firm.id, { parentId: signed.id, name: 'Final Deed.pdf', bytes: 256, clientVisible: true });
  const notes = await seedFile(firm.id, { parentId: signed.id, name: 'Draft Notes.pdf', bytes: 128 });
  const settlement = await seedFile(firm.id, { parentId: matterRoot, name: 'Settlement.pdf', bytes: 2048 });

  tree = {
    'Closing': closing.id,
    'Closing/Deed.pdf': deed.id,
    'Closing/Internal Memo.pdf': memo.id,
    'Closing/Signed': signed.id,
    'Closing/Signed/Final Deed.pdf': finalDeed.id,
    'Closing/Signed/Draft Notes.pdf': notes.id,
    'Settlement.pdf': settlement.id,
  };
}

beforeEach(async () => {
  resetRichBucket();

  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
  matterId = await seedMatter(firm.id, owner.uid, 'Hollis v. Denton');
  matterRoot = await rootOf(firm.id, { matterId });
});

// ---------------------------------------------------------------------------

/**
 * Count the queries a request issues, and how many walk the tree.
 *
 * Patched on the shared pool rather than on a query helper: every repository
 * destructures its helper when it loads, so reassigning that module's property
 * afterwards is a spy that never fires and every assertion built on it passes
 * against nothing.
 */
async function countQueries(fn: () => Promise<unknown>): Promise<{ total: number; recursive: number; walkPages: number }> {
  const { pool } = require('../../src/shared/database/db');
  const original = pool.query.bind(pool);
  let total = 0;
  let recursive = 0;
  let walkPages = 0;
  pool.query = (config: any, ...rest: any[]) => {
    const text = typeof config === 'string' ? config : config?.text;
    if (typeof text === 'string') {
      total += 1;
      if (/with recursive/i.test(text)) recursive += 1;
      // One page of one folder's children. Counted separately from `total`
      // because the pool is shared: an audit row or a storage-accounting write
      // landing inside this window would otherwise be attributed to the
      // archive and make the assertion depend on unrelated traffic.
      if (/from files\b/i.test(text) && /parent_id = \$2/.test(text)) walkPages += 1;
    }
    return original(config, ...rest);
  };
  try { await fn(); } finally { pool.query = original; }
  return { total, recursive, walkPages };
}

describe('what an archive costs the database', () => {
  it('does not resolve each document ancestor chain separately', async () => {
    // Every entry name used to come from its own recursive upward query. At
    // 2,000 documents that measured 1,473 ms, so a 20,000 document archive
    // spent roughly fifteen seconds of database time on names alone, holding
    // one of ten pooled connections for all of it while other requests queued.
    // The walk down already knows every path, so the count must not follow the
    // document count.
    await seedMixedTree();

    const counted = await countQueries(() => downloadFolder(tree.Closing));

    // Proves the spy fired. Without it the assertion below is satisfied by a
    // request that issued no queries at all.
    expect(counted.total).toBeGreaterThan(0);
    // Four documents across two folder levels. One recursive query per document
    // would be four on its own, before the scope and folder lookups.
    expect(counted.recursive).toBeLessThanOrEqual(1);
  });

  it('does not grow its query count with the number of documents', async () => {
    await seedMixedTree();
    const small = await countQueries(() => downloadFolder(tree.Closing));

    // Double the documents in one folder; the work per document is a page read,
    // not a query.
    for (let i = 0; i < 8; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- ordering keeps names stable
      await seedFile(firm.id, { parentId: tree.Closing, name: `extra-${i}.pdf` });
    }
    const large = await countQueries(() => downloadFolder(tree.Closing));

    // Compared on the walk's own page reads. Comparing every query the shared
    // pool saw made this depend on whether an unrelated background write
    // happened to land inside one window and not the other.
    expect(small.walkPages).toBeGreaterThan(0);
    expect(large.walkPages).toBeLessThanOrEqual(small.walkPages);
    expect(large.recursive).toBeLessThanOrEqual(small.recursive);
  });
});

describe('downloading a folder', () => {
  it('contains every document in the subtree, shared or not', async () => {
    await seedMixedTree();

    const res = await downloadFolder(tree.Closing);

    expect(res.status).toBe(201);
    expect(entriesOf(res)).toEqual([
      'Deed.pdf',
      'Internal Memo.pdf',
      'Signed/Draft Notes.pdf',
      'Signed/Final Deed.pdf',
    ]);
  });

  it('leaves the folder markers out of the archive', async () => {
    await seedMixedTree();

    const res = await downloadFolder(tree.Closing);

    // The markers are how storage records that a folder exists. Included, they
    // arrive as mysterious empty files named `.folder` at every level.
    expect(entriesOf(res).filter((name) => name.endsWith('.folder'))).toEqual([]);
  });

  it('keeps entry paths relative to the folder being downloaded', async () => {
    await seedMixedTree();

    const res = await downloadFolder(tree.Closing);

    // Absolute object names would unpack as `lawfirmids/<firm>/<matter>/...`,
    // exposing the storage layout and burying the documents six levels deep.
    expect(entriesOf(res).every((name) => !name.startsWith('lawfirmids/'))).toBe(true);
  });

  it('takes nothing from outside the folder it was asked for', async () => {
    await seedMixedTree();

    const res = await downloadFolder(tree['Closing/Signed']);

    // A prefix scan that dropped the trailing slash, or scanned the matter
    // instead, shows up here and only here.
    expect(entriesOf(res)).toEqual(['Draft Notes.pdf', 'Final Deed.pdf']);
  });

  it('stores every entry rather than deflating it', async () => {
    await seedMixedTree();

    const res = await downloadFolder(tree.Closing);

    // Method 0 is STORE. Every document type a firm uploads is already
    // compressed, so deflate spends the container's one CPU to save nothing,
    // and a CPU-bound archive of a large folder is the one that hits the
    // request timeout partway through.
    const methods = zipEntryCompressionMethods(res.bytes!);
    expect(methods.size).toBe(4);
    expect([...methods.values()]).toEqual([0, 0, 0, 0]);
  });

  it('names the archive after the folder', async () => {
    await seedMixedTree();

    const res = await downloadFolder(tree.Closing);

    // The name is forced by the minted URL's disposition rather than by a
    // response header, because the browser fetches the archive from storage and
    // never sees a header this app wrote.
    expect(res.filename).toBe('Closing.zip');
  });

  it('strips characters a folder name may carry but a header may not', async () => {
    const odd = await seedFolder(firm.id, { parentId: matterRoot, name: 'Q"uote;Drop' });
    await seedFile(firm.id, { parentId: odd.id, name: 'Deed.pdf', bytes: 128 });

    const res = await downloadFolder(odd.id);

    // A folder name is whatever the firm typed, so a quote in one would either
    // mangle the disposition or make the signing call reject it outright and
    // turn an ordinary download into a 500.
    expect(res.status).toBe(201);
    expect(res.filename).toBe('Q_uote_Drop.zip');
  });

  it('refuses a folder holding no documents', async () => {
    const empty = await seedFolder(firm.id, { parentId: matterRoot, name: 'Empty' });

    const res = await downloadFolder(empty.id);

    // An archive of zero files is not a smaller archive, it is a broken
    // download. Emptiness is only discoverable by walking the folder, which is
    // the worker's job, so the refusal is the job's outcome rather than the
    // request's: settled, not retried, and carrying nothing to fetch.
    expect(res.jobStatus).toBe('failed');
    expect(res.failureCode).toBe('EXPORT_EMPTY');
    expect(res.bytes).toBeNull();
  });

  it('refuses a folder that does not exist', async () => {
    await seedMixedTree();

    const res = await downloadFolder('00000000-0000-4000-8000-000000000000');

    expect(res.status).toBe(404);
  });

  it('refuses a folder belonging to another matter of the same firm', async () => {
    await seedMixedTree();
    const otherMatter = await seedMatter(firm.id, owner.uid, 'Ambrose Estate');
    const otherRoot = await rootOf(firm.id, { matterId: otherMatter });
    const theirs = await seedFolder(firm.id, { parentId: otherRoot, name: 'Theirs' });
    await seedFile(firm.id, { parentId: theirs.id, name: 'Private.pdf', bytes: 64 });

    const res = await downloadFolder(theirs.id);

    // The caller is on both matters, so this is not a membership case. The
    // request names one matter and a folder in another, and the row is what
    // decides which is true.
    expect(res.status).toBe(404);
  });

  it('refuses a member who is not on the matter', async () => {
    await seedMixedTree();
    const walled = await memberWith(firm.id, ['files.view']);

    const res = await downloadFolder(tree.Closing, walled);

    // Downloading a matter's whole file tree deliberately requires matter
    // MEMBERSHIP, which is stricter than the read access the listing routes
    // grant: taking a copy of everything is not the same act as seeing it is
    // there.
    expect(res.status).toBe(403);
  });

  it('serves a member who IS on the matter', async () => {
    await seedMixedTree();
    const insider = await memberWith(firm.id, ['files.view']);
    await joinMatter(firm.id, matterId, insider.uid);

    const res = await downloadFolder(tree.Closing, insider);

    // Without this the refusal above would pass against a route that refused
    // every non-owner.
    expect(res.status).toBe(201);
    expect(entriesOf(res)).toHaveLength(4);
  });
});

describe('downloading a selection', () => {
  it('contains exactly the files that were selected', async () => {
    await seedMixedTree();

    const res = await downloadZip([tree['Settlement.pdf'], tree['Closing/Deed.pdf']]);

    expect(res.status).toBe(201);
    expect(entriesOf(res)).toEqual(['Closing/Deed.pdf', 'Settlement.pdf']);
  });

  it('keeps entry paths relative to the matter, so the structure survives', async () => {
    await seedMixedTree();

    const res = await downloadZip([tree['Closing/Signed/Final Deed.pdf']]);

    // Relative to the SCOPE here, not to a folder: a multi-select spans folders,
    // so flattening to basenames would collide two files of the same name from
    // different folders and silently drop one.
    expect(entriesOf(res)).toEqual(['Closing/Signed/Final Deed.pdf']);
  });

  it('expands a selected folder into everything under it', async () => {
    await seedMixedTree();

    const res = await downloadZip([tree.Closing]);

    // A folder arrives in the selection as its marker path. Treated as a file it
    // would produce a zip holding one empty `.folder` entry.
    expect(entriesOf(res)).toEqual([
      'Closing/Deed.pdf',
      'Closing/Internal Memo.pdf',
      'Closing/Signed/Draft Notes.pdf',
      'Closing/Signed/Final Deed.pdf',
    ]);
  });

  it('includes a file once when the selection also names its folder', async () => {
    await seedMixedTree();

    const res = await downloadZip([tree.Closing, tree['Closing/Deed.pdf']]);

    // Ticking a folder and then a file inside it is an ordinary thing to do in
    // a file browser. A duplicated entry makes some unzip tools prompt and
    // others silently overwrite.
    const names = entriesOf(res);
    expect(names.filter((name) => name === 'Closing/Deed.pdf')).toHaveLength(1);
    expect(names).toHaveLength(4);
  });

  it('names the multi-select archive generically', async () => {
    await seedMixedTree();

    const res = await downloadZip([tree['Settlement.pdf']]);

    // A multi-select is rooted at the scope, whose root folder has no name, so
    // the archive falls back to a generic one rather than to an empty filename.
    expect(res.filename).toBe('files.zip');
  });

  it('refuses a selection that resolves to nothing', async () => {
    await seedMixedTree();

    const res = await downloadZip(['00000000-0000-4000-8000-000000000000']);

    // A selection naming nothing that exists expands to nothing, which is a
    // refusal rather than an empty archive for the same reason as above.
    expect(res.status).toBe(404);
  });

  it('drops a file id belonging to another matter of the same firm', async () => {
    await seedMixedTree();
    const otherMatter = await seedMatter(firm.id, owner.uid, 'Ambrose Estate');
    const otherRoot = await rootOf(firm.id, { matterId: otherMatter });
    const theirs = await seedFile(firm.id, { parentId: otherRoot, name: 'Private.pdf', bytes: 64 });

    const res = await downloadZip([tree['Settlement.pdf'], theirs.id]);

    // The rows decide what is in scope, so an id from another matter is simply
    // not in the archive. This is the check the prefix comparison used to make,
    // and it is the one that stops a multi-select becoming a way to pull a
    // document out of a matter the caller named nowhere.
    expect(entriesOf(res)).toEqual(['Settlement.pdf']);
  });

  it('refuses an empty selection', async () => {
    const res = await downloadZip([]);

    expect(res.status).toBe(400);
  });

  it('refuses a member who is not on the matter', async () => {
    await seedMixedTree();
    const walled = await memberWith(firm.id, ['files.view']);

    const res = await downloadZip([tree['Settlement.pdf']], walled);

    expect(res.status).toBe(403);
  });
});
