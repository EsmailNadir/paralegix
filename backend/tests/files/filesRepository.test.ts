/**
 * The file tree repository: the only code that knows the `files` table.
 *
 * These are the four properties the old path-as-tree design could not hold, and
 * each is tested against the real database rather than through a route, because
 * the guarantee is the database's:
 *
 *   - ONE root per scope, even when several writes race to create the first file
 *     in a matter. Two roots would split that matter's documents into two trees,
 *     each invisible from the other.
 *   - A name is decided by the unique index, not by asking storage. The old
 *     resolver probed for an object that did not exist yet, so two concurrent
 *     uploads of `Retainer.pdf` were handed the same path and one was lost.
 *   - A move is one statement and cannot put a folder inside itself.
 *   - Visibility is inherited down the tree and narrowed by client, both in SQL.
 *     The per-client narrowing used to live in object metadata, where the SQL
 *     read path could not see it at all.
 */
import { randomUUID } from 'crypto';

import {
  createFirm,
  createPersonClient,
  ensureUser,
  testPool,
  type Firm,
} from '../support/setupInProcess';
import { seedMatter } from './fileWorld';

const repo = require('../../src/modules/files/files.repository');

/**
 * A file that has landed. `createFile` claims the name before any bytes exist,
 * and only `finalize` makes it a document, so a test that wants one in a listing
 * has to do both.
 */
async function landedFile(lawFirmId: string, opts: any) {
  const row = await repo.createFile(lawFirmId, {
    mimeType: 'application/pdf', uploadedBy: 'author-uid', ...opts,
  });
  await repo.finalize(lawFirmId, row.id, { sizeBytes: opts.sizeBytes ?? 1024, mimeType: 'application/pdf' });
  return row;
}

let firm: Firm;
let matterId: string;

beforeEach(async () => {
  firm = await createFirm();
  matterId = await seedMatter(firm.id, null, 'Estate of Ellis');
  await ensureUser('author-uid');
});

describe('scope roots', () => {
  it('creates exactly one root when eight writes race for it', async () => {
    const ids = await Promise.all(
      Array.from({ length: 8 }, () => repo.ensureScopeRoot(firm.id, { scope: 'matter', matterId })),
    );

    // Every caller has to come back with the SAME id. An `on conflict do
    // nothing` that then failed to re-select would return null here, which is
    // the other way this goes wrong.
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toEqual(expect.any(String));
    const { rows } = await testPool.query(
      `select count(*)::int as n from files where law_firm_id = $1 and parent_id is null and scope = 'matter'`,
      [firm.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('gives each scope its own root', async () => {
    const a = await repo.ensureScopeRoot(firm.id, { scope: 'matter', matterId });
    const b = await repo.ensureScopeRoot(firm.id, { scope: 'firm' });
    const client = await createPersonClient(firm.id);
    const c = await repo.ensureScopeRoot(firm.id, { scope: 'client', clientId: client.id });

    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe('naming', () => {
  it('hands two concurrent uploads of one name two distinct rows', async () => {
    const root = await repo.ensureScopeRoot(firm.id, { scope: 'matter', matterId });

    const [a, b] = await Promise.all([
      landedFile(firm.id, { parentId: root, name: 'Retainer.pdf' }),
      landedFile(firm.id, { parentId: root, name: 'Retainer.pdf' }),
    ]);

    // Neither upload is lost and neither overwrites the other: the loser of the
    // unique index takes the next free name.
    expect(new Set([a.name, b.name])).toEqual(new Set(['Retainer.pdf', 'Retainer (1).pdf']));
    expect(a.id).not.toBe(b.id);
    expect(new Set([a.objectPath, b.objectPath]).size).toBe(2);
  });

  it('names the object after the row, not after the file', async () => {
    const root = await repo.ensureScopeRoot(firm.id, { scope: 'matter', matterId });
    const file = await landedFile(firm.id, { parentId: root, name: 'Retainer.pdf' });

    // This is what makes a rename free. The object never moves because its name
    // says nothing about where the file sits or what it is called.
    expect(file.objectPath).toBe(`lawfirmids/${firm.id}/objects/${file.id}`);
  });

  it('keeps the extension when it numbers a duplicate', async () => {
    const root = await repo.ensureScopeRoot(firm.id, { scope: 'matter', matterId });
    await repo.createFile(firm.id, { parentId: root, name: 'Brief.docx', mimeType: 'application/pdf', uploadedBy: 'author-uid' });
    const second = await repo.createFile(firm.id, { parentId: root, name: 'Brief.docx', mimeType: 'application/pdf', uploadedBy: 'author-uid' });

    // "Brief.docx (1)" would not open on a desktop.
    expect(second.name).toBe('Brief (1).docx');
  });

  it('refuses a duplicate folder name rather than numbering it', async () => {
    const root = await repo.ensureScopeRoot(firm.id, { scope: 'matter', matterId });
    await repo.createFolder(firm.id, { parentId: root, name: 'Contracts', createdBy: 'author-uid' });

    // Two files of one name are two documents; two folders of one name is a
    // typo, and silently making "Contracts (1)" hides the mistake.
    await expect(repo.createFolder(firm.id, { parentId: root, name: 'Contracts', createdBy: 'author-uid' }))
      .rejects.toMatchObject({ code: 'NAME_TAKEN' });
  });
});

describe('move and rename', () => {
  it('refuses to move a folder into its own subtree', async () => {
    const root = await repo.ensureScopeRoot(firm.id, { scope: 'matter', matterId });
    const a = await repo.createFolder(firm.id, { parentId: root, name: 'A', createdBy: 'author-uid' });
    const b = await repo.createFolder(firm.id, { parentId: a.id, name: 'B', createdBy: 'author-uid' });

    // A cycle detaches the whole subtree from the root: nothing lists it, and
    // the recursive reads below it never terminate at a root.
    await expect(repo.move(firm.id, a.id, b.id)).rejects.toMatchObject({ code: 'MOVE_INTO_SELF' });
    await expect(repo.move(firm.id, a.id, a.id)).rejects.toMatchObject({ code: 'MOVE_INTO_SELF' });
  });

  it('moves a folder holding three thousand files without touching them', async () => {
    const root = await repo.ensureScopeRoot(firm.id, { scope: 'matter', matterId });
    const from = await repo.createFolder(firm.id, { parentId: root, name: 'From', createdBy: 'author-uid' });
    const to = await repo.createFolder(firm.id, { parentId: root, name: 'To', createdBy: 'author-uid' });
    await testPool.query(
      `insert into files (law_firm_id, kind, name, parent_id, scope, matter_id, object_path, finalized_at)
       select $1::uuid, 'file', 'doc-' || g, $2::uuid, 'matter', $3::uuid,
              'lawfirmids/' || $4 || '/objects/' || gen_random_uuid(), now()
         from generate_series(1, 3000) g`,
      [firm.id, from.id, matterId, firm.id],
    );
    const { rows: [before] } = await testPool.query(
      `select max(updated_at) as t from files where parent_id = $1`, [from.id],
    );

    await repo.move(firm.id, from.id, to.id);

    // The descendants are untouched: their rows never changed, and no object
    // moved. That is the whole point of the design.
    const { rows: [after] } = await testPool.query(
      `select max(updated_at) as t from files where parent_id = $1`, [from.id],
    );
    expect(after.t).toEqual(before.t);
    expect((await repo.findById(firm.id, from.id)).parentId).toBe(to.id);
    const { rows: [count] } = await testPool.query(
      `select count(*)::int as n from files where parent_id = $1`, [from.id],
    );
    expect(count.n).toBe(3000);
  });

  it('refuses a rename onto a sibling name and leaves the row alone', async () => {
    const root = await repo.ensureScopeRoot(firm.id, { scope: 'matter', matterId });
    await repo.createFolder(firm.id, { parentId: root, name: 'Taken', createdBy: 'author-uid' });
    const mine = await repo.createFolder(firm.id, { parentId: root, name: 'Mine', createdBy: 'author-uid' });

    await expect(repo.rename(firm.id, mine.id, 'Taken')).rejects.toMatchObject({ code: 'NAME_TAKEN' });
    expect((await repo.findById(firm.id, mine.id)).name).toBe('Mine');
  });
});

describe('listing', () => {
  it('returns one level, with recursive counts for each subfolder', async () => {
    const root = await repo.ensureScopeRoot(firm.id, { scope: 'matter', matterId });
    const a = await repo.createFolder(firm.id, { parentId: root, name: 'A', createdBy: 'author-uid' });
    const deep = await repo.createFolder(firm.id, { parentId: a.id, name: 'Deep', createdBy: 'author-uid' });
    await landedFile(firm.id, { parentId: deep.id, name: 'buried.pdf' });
    await landedFile(firm.id, { parentId: root, name: 'top.pdf' });

    const { folders, files } = await repo.listChildren(firm.id, root);
    expect(folders.map((f: any) => f.name)).toEqual(['A']);
    expect(files.map((f: any) => f.name)).toEqual(['top.pdf']);

    // The count is recursive while the listing is not: the browser shows "A"
    // holding one file without loading the subtree to say so.
    const counts = await repo.subtreeCounts(firm.id, [a.id]);
    expect(counts[a.id]).toMatchObject({ fileCount: 1, folderCount: 1 });
  });

  it('reaches every descendant in the flat subtree read', async () => {
    const root = await repo.ensureScopeRoot(firm.id, { scope: 'matter', matterId });
    const a = await repo.createFolder(firm.id, { parentId: root, name: 'A', createdBy: 'author-uid' });
    const b = await repo.createFolder(firm.id, { parentId: a.id, name: 'B', createdBy: 'author-uid' });
    const deep = await landedFile(firm.id, { parentId: b.id, name: 'deep.pdf' });

    // This is what the file pickers read. The old SQL half returned direct
    // children only, so a file two folders down could not be picked at all.
    const { rows } = await repo.listSubtreePage(firm.id, root);
    expect(rows.map((r: any) => r.id)).toContain(deep.id);
  });

  it('hides a soft-deleted row and everything under it', async () => {
    const root = await repo.ensureScopeRoot(firm.id, { scope: 'matter', matterId });
    const a = await repo.createFolder(firm.id, { parentId: root, name: 'A', createdBy: 'author-uid' });
    const inside = await landedFile(firm.id, { parentId: a.id, name: 'inside.pdf' });

    await repo.softDeleteSubtree(firm.id, a.id, 'author-uid');

    expect((await repo.listChildren(firm.id, root)).folders).toEqual([]);
    expect((await repo.listSubtreePage(firm.id, root)).rows.map((r: any) => r.id)).not.toContain(inside.id);
    // The rows are still there, which is what makes the trash restorable.
    expect((await repo.findById(firm.id, inside.id, { includeDeleted: true })).deletedAt).toBeTruthy();
  });

  it('finds a file by name anywhere in the subtree', async () => {
    const root = await repo.ensureScopeRoot(firm.id, { scope: 'matter', matterId });
    const a = await repo.createFolder(firm.id, { parentId: root, name: 'A', createdBy: 'author-uid' });
    await landedFile(firm.id, { parentId: a.id, name: 'Settlement Agreement.pdf' });
    await landedFile(firm.id, { parentId: root, name: 'Unrelated.pdf' });

    const hits = await repo.search(firm.id, root, 'settlement');
    expect(hits.map((h: any) => h.name)).toEqual(['Settlement Agreement.pdf']);
  });
});

describe('visibility', () => {
  it('inherits a share from the nearest shared ancestor', async () => {
    const client = await createPersonClient(firm.id);
    const root = await repo.ensureScopeRoot(firm.id, { scope: 'matter', matterId });
    const shared = await repo.createFolder(firm.id, { parentId: root, name: 'Shared', createdBy: 'author-uid' });
    const deep = await repo.createFolder(firm.id, { parentId: shared.id, name: 'Deep', createdBy: 'author-uid' });
    const file = await landedFile(firm.id, { parentId: deep.id, name: 'shared.pdf' });
    const hidden = await landedFile(firm.id, { parentId: root, name: 'internal.pdf' });

    await repo.setVisibility(firm.id, shared.id, { visible: true, clientIds: null });

    expect(await repo.visibleToClient(firm.id, file.id, client.id)).toBe(true);
    // The pair matters: a check that returned true for everything would pass
    // the first assertion on its own.
    expect(await repo.visibleToClient(firm.id, hidden.id, client.id)).toBe(false);
  });

  it('narrows a shared folder to the named clients', async () => {
    const allowed = await createPersonClient(firm.id, { name: 'Allowed' });
    const excluded = await createPersonClient(firm.id, { name: 'Excluded' });
    const root = await repo.ensureScopeRoot(firm.id, { scope: 'matter', matterId });
    const shared = await repo.createFolder(firm.id, { parentId: root, name: 'Shared', createdBy: 'author-uid' });
    const file = await landedFile(firm.id, { parentId: shared.id, name: 'restricted.pdf' });

    await repo.setVisibility(firm.id, shared.id, { visible: true, clientIds: [allowed.id] });

    // Both clients are on the matter. Only one was named, and the other must not
    // see the document: this is the restriction that used to live in object
    // metadata where no SQL read could apply it.
    expect(await repo.visibleToClient(firm.id, file.id, allowed.id)).toBe(true);
    expect(await repo.visibleToClient(firm.id, file.id, excluded.id)).toBe(false);
  });

  it('shares everything under a shared folder, however deep', async () => {
    const client = await createPersonClient(firm.id);
    const root = await repo.ensureScopeRoot(firm.id, { scope: 'matter', matterId });
    const shared = await repo.createFolder(firm.id, { parentId: root, name: 'Shared', createdBy: 'author-uid' });
    const inner = await repo.createFolder(firm.id, { parentId: shared.id, name: 'Inner', createdBy: 'author-uid' });
    const file = await landedFile(firm.id, { parentId: inner.id, name: 'draft.pdf' });

    await repo.setVisibility(firm.id, shared.id, { visible: true, clientIds: null });

    // Sharing a folder shares its whole subtree. `client_visible` is a boolean,
    // so there is no way to mark one subfolder private inside a shared one; a
    // firm that wants a document private keeps it outside the shared folder.
    // This pins the rule so a later inheritance change is a deliberate one.
    expect(await repo.visibleToClient(firm.id, file.id, client.id)).toBe(true);
  });

  it('lists exactly what one client may see', async () => {
    const client = await createPersonClient(firm.id);
    const root = await repo.ensureScopeRoot(firm.id, { scope: 'matter', matterId });
    const shared = await repo.createFolder(firm.id, { parentId: root, name: 'Shared', createdBy: 'author-uid' });
    const visible = await landedFile(firm.id, { parentId: shared.id, name: 'visible.pdf' });
    await landedFile(firm.id, { parentId: root, name: 'internal.pdf' });
    await repo.setVisibility(firm.id, shared.id, { visible: true, clientIds: null });

    const rows = await repo.listVisibleForClient(firm.id, root, client.id);

    expect(rows.filter((r: any) => r.kind === 'file').map((r: any) => r.id)).toEqual([visible.id]);
  });
});

describe('usage', () => {
  it('counts finalized files only', async () => {
    const root = await repo.ensureScopeRoot(firm.id, { scope: 'matter', matterId });
    const done = await landedFile(firm.id, { parentId: root, name: 'done.pdf', sizeBytes: 4096 });
    // An upload that was started and abandoned: a row, no bytes, no charge.
    await repo.createFile(firm.id, { parentId: root, name: 'abandoned.pdf', mimeType: 'application/pdf', uploadedBy: 'author-uid' });

    expect(await repo.sumFinalizedBytes(firm.id)).toEqual({ bytes: 4096, count: 1 });
  });

  it('stops counting a file once it is deleted', async () => {
    const root = await repo.ensureScopeRoot(firm.id, { scope: 'matter', matterId });
    const file = await landedFile(firm.id, { parentId: root, name: 'gone.pdf', sizeBytes: 1024 });

    await repo.softDeleteSubtree(firm.id, file.id, 'author-uid');

    // A firm should not pay for its trash.
    expect(await repo.sumFinalizedBytes(firm.id)).toEqual({ bytes: 0, count: 0 });
  });
});

describe('lookup by object path', () => {
  it('finds a landed file by its object path, and only under its own firm', async () => {
    const root = await repo.ensureScopeRoot(firm.id, { scope: 'matter', matterId });
    const file = await landedFile(firm.id, { parentId: root, name: 'retainer.pdf' });
    const otherFirm = await createFirm();

    expect((await repo.findByObjectPath(firm.id, file.objectPath))?.id).toBe(file.id);
    // The access checks that call this decide a matter wall from the row it
    // returns, so another firm naming the same path must get nothing back.
    expect(await repo.findByObjectPath(otherFirm.id, file.objectPath)).toBeNull();
  });

  it('answers null for a firm id that is not a uuid, instead of a cast error', async () => {
    // `law_firm_id` is a uuid column. Without the guard Postgres rejects the
    // comparison (22P02) and every caller turns a malformed id into a 500.
    const root = await repo.ensureScopeRoot(firm.id, { scope: 'matter', matterId });
    const file = await landedFile(firm.id, { parentId: root, name: 'retainer.pdf' });

    await expect(repo.findByObjectPath('not-a-firm', file.objectPath)).resolves.toBeNull();
  });

  it('hides a soft-deleted file unless asked to include it', async () => {
    const root = await repo.ensureScopeRoot(firm.id, { scope: 'matter', matterId });
    const file = await landedFile(firm.id, { parentId: root, name: 'gone.pdf' });
    await repo.softDeleteSubtree(firm.id, file.id, 'author-uid');

    expect(await repo.findByObjectPath(firm.id, file.objectPath)).toBeNull();
    expect((await repo.findByObjectPath(firm.id, file.objectPath, { includeDeleted: true }))?.id)
      .toBe(file.id);
  });
});

describe('ancestors', () => {
  it('returns the chain from the root down, for breadcrumbs', async () => {
    const root = await repo.ensureScopeRoot(firm.id, { scope: 'matter', matterId });
    const a = await repo.createFolder(firm.id, { parentId: root, name: 'A', createdBy: 'author-uid' });
    const b = await repo.createFolder(firm.id, { parentId: a.id, name: 'B', createdBy: 'author-uid' });
    const file = await landedFile(firm.id, { parentId: b.id, name: 'leaf.pdf' });

    const chain = await repo.ancestors(firm.id, file.id);

    expect(chain.map((r: any) => r.id)).toEqual([root, a.id, b.id]);
  });
});

describe('the recursive subtree walk', () => {
  it('returns a nested row identical to reading that row directly', async () => {
    const root = await repo.ensureScopeRoot(firm.id, { scope: 'matter', matterId });
    const folder = await repo.createFolder(firm.id, { parentId: root, name: 'Nested', createdBy: 'author-uid' });
    const deep = await landedFile(firm.id, { parentId: folder.id, name: 'buried.pdf' });

    const { rows: subtree } = await repo.listSubtreePage(firm.id, root);
    const fromWalk = subtree.find((row: any) => row.id === deep.id);

    // The walk is a UNION: its first branch selects the column list, and its
    // recursive branch has to select exactly the same columns in the same order.
    // Postgres reports a mismatch only at run time, and only as a count, so a
    // column added to one branch and not the other breaks every subtree read at
    // once: listing, moving, deleting and restoring. Comparing whole rows pins
    // the ORDER too, which a count comparison would miss.
    expect(fromWalk).toEqual(await repo.findById(firm.id, deep.id));
  });

  it('deletes a row three levels down', async () => {
    const root = await repo.ensureScopeRoot(firm.id, { scope: 'matter', matterId });
    const a = await repo.createFolder(firm.id, { parentId: root, name: 'A', createdBy: 'author-uid' });
    const b = await repo.createFolder(firm.id, { parentId: a.id, name: 'B', createdBy: 'author-uid' });
    const deep = await landedFile(firm.id, { parentId: b.id, name: 'deep.pdf' });

    // Reaching depth three needs the recursive branch to have run twice. A
    // one-level delete would pass a shallower case and leave orphans here.
    await repo.softDeleteSubtree(firm.id, a.id, 'author-uid');

    expect((await repo.findById(firm.id, deep.id, { includeDeleted: true })).deletedAt).not.toBeNull();
    expect(await repo.findById(firm.id, deep.id)).toBeNull();
  });
});
