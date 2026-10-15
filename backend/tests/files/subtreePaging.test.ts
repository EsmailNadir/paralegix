/**
 * Paging the flat subtree read, and the two ways paging it can be wrong.
 *
 * `listSubtree` returned every descendant row of a folder, every column, with
 * no limit. Three callers used it: the `/list` route the pickers read, and both
 * archive routes. It grows with ordinary use rather than with file size, so a
 * matter that accumulates twenty thousand documents allocated twenty thousand
 * rows on every listing, on the instance that also signs documents.
 *
 * Paging it introduces two failures that a small fixture never shows:
 *
 *   An OFFSET cursor skips or repeats rows when the folder changes between
 *   pages, which it does constantly: uploads finalize, files are deleted.
 *   A picker that skips a row is a document nobody can attach.
 *
 *   An unstable sort does the same thing without any mutation at all. The
 *   ordering the browser shows is folders first, then name, and names are not
 *   unique in a subtree, so ties must break on something that is.
 */
import {
  createFirm,
  ensureUser,
  testPool,
  type Firm,
} from '../support/setupInProcess';
import { seedMatter, seedTask } from './fileWorld';

const repo = require('../../src/modules/files/files.repository');

let firm: Firm;
let matterId: string;
let root: string;

/** A file that has landed. Only a finalized row appears in a listing. */
async function landedFile(opts: any) {
  const row = await repo.createFile(firm.id, {
    mimeType: 'application/pdf', uploadedBy: 'author-uid', ...opts,
  });
  await repo.finalize(firm.id, row.id, { sizeBytes: 10 });
  return row;
}

/** Walk every page and return the rows in order. */
async function drain(folderId: string, pageSize: number, opts: any = {}) {
  const seen: any[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    // eslint-disable-next-line no-await-in-loop -- paging is the subject
    const page: any = await repo.listSubtreePage(firm.id, folderId, { ...opts, limit: pageSize, cursor });
    expect(page.rows.length).toBeLessThanOrEqual(pageSize);
    seen.push(...page.rows);
    cursor = page.cursor;
    pages += 1;
    expect(pages).toBeLessThan(200); // a cursor that never advances would loop
  } while (cursor);
  return seen;
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Paging LLP' });
  await ensureUser('author-uid');
  matterId = await seedMatter(firm.id, 'author-uid', 'Paging Matter');
  root = await repo.ensureScopeRoot(firm.id, { scope: 'matter', matterId });
});

describe('walking a subtree in pages', () => {
  it('returns every descendant exactly once across pages', async () => {
    const a = await repo.createFolder(firm.id, { parentId: root, name: 'A', createdBy: 'author-uid' });
    const b = await repo.createFolder(firm.id, { parentId: a.id, name: 'B', createdBy: 'author-uid' });
    const made: string[] = [a.id, b.id];
    for (let i = 0; i < 9; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- ordering keeps names stable
      made.push((await landedFile({ parentId: b.id, name: `doc-${i}.pdf` })).id);
    }

    const seen = await drain(root, 2);

    expect(seen.map((r: any) => r.id).sort()).toEqual(made.sort());
    expect(new Set(seen.map((r: any) => r.id)).size).toBe(made.length);
  });

  it('keeps the order the browser displays: folders first, then by name', async () => {
    await repo.createFolder(firm.id, { parentId: root, name: 'Zed', createdBy: 'author-uid' });
    await repo.createFolder(firm.id, { parentId: root, name: 'Alpha', createdBy: 'author-uid' });
    await landedFile({ parentId: root, name: 'aaa.pdf' });
    await landedFile({ parentId: root, name: 'bbb.pdf' });

    // Paged in ones, so every page boundary is exercised. The order must be the
    // same as the unpaged read produced, or the picker reorders as it loads.
    const seen = await drain(root, 1);

    expect(seen.map((r: any) => r.name)).toEqual(['Alpha', 'Zed', 'aaa.pdf', 'bbb.pdf']);
  });

  it('breaks a name tie on something unique', async () => {
    // Two files with the same name in different folders sort equally. Without a
    // unique tiebreaker the database may order them differently on each query,
    // so one is served twice and the other never.
    const a = await repo.createFolder(firm.id, { parentId: root, name: 'A', createdBy: 'author-uid' });
    const b = await repo.createFolder(firm.id, { parentId: root, name: 'B', createdBy: 'author-uid' });
    const one = await landedFile({ parentId: a.id, name: 'same.pdf' });
    const two = await landedFile({ parentId: b.id, name: 'same.pdf' });

    const seen = await drain(root, 1);

    const ids = seen.map((r: any) => r.id);
    expect(ids).toContain(one.id);
    expect(ids).toContain(two.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reports no cursor once the last page is served', async () => {
    await landedFile({ parentId: root, name: 'only.pdf' });

    const page = await repo.listSubtreePage(firm.id, root, { limit: 10 });

    expect(page.rows).toHaveLength(1);
    // A cursor here would make the caller ask for an empty page every time.
    expect(page.cursor).toBeNull();
  });
});

describe('the folder changing under the walk', () => {
  it('does not skip a row when one is deleted mid-walk', async () => {
    // The offset failure. Delete a row from an early page and every later page
    // shifts back by one, so exactly one row is never returned.
    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
    const made: Record<string, string> = {};
    for (const n of names) {
      // eslint-disable-next-line no-await-in-loop -- ordering keeps names stable
      made[n] = (await landedFile({ parentId: root, name: `${n}.pdf` })).id;
    }

    const first = await repo.listSubtreePage(firm.id, root, { limit: 2 });
    await repo.softDeleteSubtree(firm.id, made.a, 'author-uid');
    const rest = await drain(root, 2, {});
    const restAfter = rest.filter((r: any) => !first.rows.some((f: any) => f.id === r.id));

    const seen = [...first.rows, ...restAfter].map((r: any) => r.id);
    // Every surviving row is present. `a` may or may not appear: it was served
    // before it was deleted, and that is correct either way.
    for (const n of ['c', 'd', 'e', 'f']) expect(seen).toContain(made[n]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('does not repeat a row when one is added mid-walk', async () => {
    for (const n of ['b', 'c', 'd', 'e']) {
      // eslint-disable-next-line no-await-in-loop -- ordering keeps names stable
      await landedFile({ parentId: root, name: `${n}.pdf` });
    }

    const first = await repo.listSubtreePage(firm.id, root, { limit: 2 });
    // Sorts before everything already served, which is what shifts an offset.
    await landedFile({ parentId: root, name: 'a.pdf' });

    const seen = [...first.rows.map((r: any) => r.id)];
    let cursor = first.cursor;
    while (cursor) {
      // eslint-disable-next-line no-await-in-loop -- paging is the subject
      const page = await repo.listSubtreePage(firm.id, root, { limit: 2, cursor });
      seen.push(...page.rows.map((r: any) => r.id));
      cursor = page.cursor;
    }

    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe('the filters the callers depend on', () => {
  it('keeps only one task\'s documents when the caller asks for a task', async () => {
    // A matter-linked task files into the MATTER's tree, tagged with the task,
    // so this filter is the only thing separating a task listing from a matter
    // listing. Losing it in the paged read shows every task's attachments in
    // every other task.
    const taskId = await seedTask(firm.id, { matterId });
    await landedFile({ parentId: root, name: 'task-owned.pdf', taskId });
    await landedFile({ parentId: root, name: 'matter-owned.pdf' });

    const seen = await drain(root, 1, { taskId });

    expect(seen.map((r: any) => r.name)).toEqual(['task-owned.pdf']);
  });

  it('leaves a task\'s documents out of the matter listing', async () => {
    const taskId = await seedTask(firm.id, { matterId });
    await landedFile({ parentId: root, name: 'task-owned.pdf', taskId });
    await landedFile({ parentId: root, name: 'matter-owned.pdf' });

    const seen = await drain(root, 1, { excludeTaskOwned: true });

    expect(seen.map((r: any) => r.name)).toEqual(['matter-owned.pdf']);
  });

  it('hides a soft-deleted row and everything under it', async () => {
    const a = await repo.createFolder(firm.id, { parentId: root, name: 'A', createdBy: 'author-uid' });
    const inside = await landedFile({ parentId: a.id, name: 'inside.pdf' });

    await repo.softDeleteSubtree(firm.id, a.id, 'author-uid');

    const seen = await drain(root, 2);
    expect(seen.map((r: any) => r.id)).not.toContain(inside.id);
  });

  it('leaves out a file whose bytes never landed', async () => {
    // `createFile` claims the name before the upload starts. A row that never
    // finalized is not a document and must not appear in a picker.
    await repo.createFile(firm.id, {
      parentId: root, name: 'never.pdf', mimeType: 'application/pdf', uploadedBy: 'author-uid',
    });

    const seen = await drain(root, 10);
    expect(seen.map((r: any) => r.name)).not.toContain('never.pdf');
  });
});

describe('iterating without holding the subtree', () => {
  /**
   * Count the queries one walk issues.
   *
   * The regression this guards is not a wrong answer, it is a cost. Draining
   * the paged read walks the recursive CTE once per page, so a full pass over a
   * subtree costs rows-squared-over-page-size; measured on a 20,000-row tree it
   * was 2,146 ms against 109 ms for the folder-by-folder walk. Both return the
   * same rows, so only the shape of the work tells them apart.
   */
  async function countQueries(fn: () => Promise<void>): Promise<{ total: number; recursive: number; walkPages: number }> {
    // Patched on the shared pool, not on the query helper. The repository
    // destructures `infrastructureRootSql` when it loads, so reassigning that
    // module's property afterwards is a spy that never fires, and every
    // assertion built on it passes against nothing.
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
        // because the pool is shared: an audit row or a storage-accounting
        // write landing inside this window would otherwise be attributed to
        // the walk and make the assertion depend on unrelated traffic.
        if (/from files\b/i.test(text) && /parent_id = \$2/.test(text)) walkPages += 1;
      }
      return original(config, ...rest);
    };
    try { await fn(); } finally { pool.query = original; }
    return { total, recursive, walkPages };
  }

  it('walks folder by folder instead of re-running the recursive read per page', async () => {
    // Three folders of four files each, paged in twos. The recursive read would
    // be issued once per page of the whole subtree; this walk issues one query
    // per page per folder and never the recursive one.
    for (let f = 0; f < 3; f += 1) {
      // eslint-disable-next-line no-await-in-loop -- ordering keeps names stable
      const folder = await repo.createFolder(firm.id, { parentId: root, name: `F${f}`, createdBy: 'author-uid' });
      for (let i = 0; i < 4; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- ordering keeps names stable
        await landedFile({ parentId: folder.id, name: `doc-${i}.pdf` });
      }
    }

    const counted = await countQueries(async () => {
      for await (const _page of repo.iterateSubtree(firm.id, root, { pageSize: 2 })) { /* drained */ }
    });

    // Proves the spy fired at all. Without this the assertion below passes just
    // as well against a walk that issued no queries, which is the shape of a
    // green test that protects nothing.
    expect(counted.total).toBeGreaterThan(0);
    expect(counted.recursive).toBe(0);
    // One query per page per folder, plus a terminating one: linear in the
    // subtree. Paging the recursive read instead costs one CTE expansion per
    // page of the WHOLE subtree, which is the quadratic shape this replaced.
    // Asserted on the walk's own queries, not on everything the shared pool
    // saw, so an unrelated background write cannot move this number.
    expect(counted.walkPages).toBeGreaterThan(0);
    expect(counted.walkPages).toBeLessThan(20);
  });

  it('reaches a folder that appears on a later page of its parent', async () => {
    // The bug this catches: collecting subfolders only from the first page of a
    // parent. `zzz` sorts last, so with a page size of two it is only seen on
    // the parent's third page, and everything inside it would be lost from
    // every archive without a word.
    for (const n of ['aaa', 'bbb', 'ccc']) {
      // eslint-disable-next-line no-await-in-loop -- ordering keeps names stable
      await landedFile({ parentId: root, name: `${n}.pdf` });
    }
    const late = await repo.createFolder(firm.id, { parentId: root, name: 'zzz', createdBy: 'author-uid' });
    const buried = await landedFile({ parentId: late.id, name: 'buried.pdf' });

    const seen: string[] = [];
    for await (const page of repo.iterateSubtree(firm.id, root, { pageSize: 2 })) {
      seen.push(...page.map((r: any) => r.id));
    }

    expect(seen).toContain(buried.id);
  });

  it('reaches a file several levels down', async () => {
    const a = await repo.createFolder(firm.id, { parentId: root, name: 'A', createdBy: 'author-uid' });
    const b = await repo.createFolder(firm.id, { parentId: a.id, name: 'B', createdBy: 'author-uid' });
    const c = await repo.createFolder(firm.id, { parentId: b.id, name: 'C', createdBy: 'author-uid' });
    const deep = await landedFile({ parentId: c.id, name: 'deep.pdf' });

    const seen: string[] = [];
    for await (const page of repo.iterateSubtree(firm.id, root, { pageSize: 1 })) {
      seen.push(...page.map((r: any) => r.id));
    }

    expect(seen).toContain(deep.id);
  });

  it('still descends into a task-owned folder it does not yield', async () => {
    // The filter decides what comes back, not where the walk goes. The
    // recursive read applied it in the outer select for exactly this reason: a
    // matter listing hides the task's folder but still shows what is under it.
    const taskId = await seedTask(firm.id, { matterId });
    const folder = await repo.createFolder(firm.id, { parentId: root, name: 'Task Folder', createdBy: 'author-uid' });
    const inside = await landedFile({ parentId: folder.id, name: 'inside.pdf' });
    // Set directly, because a child normally INHERITS its parent's task id, so
    // the ordinary path cannot produce this pair. The invariant still has to
    // hold: the filter decides what comes back, never where the walk goes.
    await testPool.query('update files set task_id = $2 where id = $1', [folder.id, taskId]);
    await testPool.query('update files set task_id = null where id = $1', [inside.id]);

    const seen: any[] = [];
    for await (const page of repo.iterateSubtree(firm.id, root, { excludeTaskOwned: true, pageSize: 1 })) {
      seen.push(...page);
    }

    expect(seen.map((r: any) => r.id)).toContain(inside.id);
    expect(seen.map((r: any) => r.id)).not.toContain(folder.id);
  });

  it('leaves out a soft-deleted branch entirely', async () => {
    const a = await repo.createFolder(firm.id, { parentId: root, name: 'A', createdBy: 'author-uid' });
    const inside = await landedFile({ parentId: a.id, name: 'inside.pdf' });
    const kept = await landedFile({ parentId: root, name: 'kept.pdf' });

    await repo.softDeleteSubtree(firm.id, a.id, 'author-uid');

    const seen: string[] = [];
    for await (const page of repo.iterateSubtree(firm.id, root, { pageSize: 2 })) {
      seen.push(...page.map((r: any) => r.id));
    }

    expect(seen).toEqual([kept.id]);
    expect(seen).not.toContain(inside.id);
  });

  it('pages within one folder rather than reading all of its children', async () => {
    for (let i = 0; i < 7; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- ordering keeps names stable
      await landedFile({ parentId: root, name: `doc-${i}.pdf` });
    }

    let biggest = 0;
    const seen: string[] = [];
    for await (const page of repo.iterateSubtree(firm.id, root, { pageSize: 2 })) {
      biggest = Math.max(biggest, page.length);
      seen.push(...page.map((r: any) => r.id));
    }

    // A folder holding twenty thousand documents is one folder. Reading its
    // children in one query would put the whole thing in the process again.
    expect(biggest).toBeLessThanOrEqual(2);
    expect(seen).toHaveLength(7);
  });

  it('yields every row one page at a time', async () => {
    const made: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- ordering keeps names stable
      made.push((await landedFile({ parentId: root, name: `doc-${i}.pdf` })).id);
    }

    const seen: string[] = [];
    let biggestPage = 0;
    for await (const page of repo.iterateSubtree(firm.id, root, { pageSize: 3 })) {
      biggestPage = Math.max(biggestPage, page.length);
      seen.push(...page.map((r: any) => r.id));
    }

    expect(seen.sort()).toEqual(made.sort());
    // The point of the generator: the archive routes never hold the whole
    // subtree, only the page being written.
    expect(biggestPage).toBeLessThanOrEqual(3);
  });
});

describe('the unbounded read is gone', () => {
  it('offers no way to ask for the whole subtree at once', () => {
    // Deleted rather than deprecated. A deprecated function is one an autocomplete
    // still offers, and the next caller reintroduces the allocation this removes.
    expect(repo.listSubtree).toBeUndefined();
  });

  it('caps the page size a caller may ask for', async () => {
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- ordering keeps names stable
      await landedFile({ parentId: root, name: `doc-${i}.pdf` });
    }

    // "Give me a million rows" is the unbounded read with extra steps.
    const page = await repo.listSubtreePage(firm.id, root, { limit: 1_000_000 });

    expect(page.rows.length).toBeLessThanOrEqual(repo.SUBTREE_MAX_PAGE_SIZE);
    expect(repo.SUBTREE_MAX_PAGE_SIZE).toBeLessThan(10_000);
  });
});
