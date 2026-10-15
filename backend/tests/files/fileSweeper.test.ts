/**
 * The sweeper: what a delete leaves behind, and when it finally goes.
 *
 * A delete is soft. The row keeps its id and its object, and only `deleted_at`
 * is set, which is what makes a delete recoverable, keeps a legal hold holding
 * something, and lets a share link answer "no longer available" rather than
 * 404-ing on a token nobody recognises.
 *
 * That half is useless without this one. A firm that never destroys anything
 * keeps paying storage on documents they threw away a year ago, and every
 * claimed-but-abandoned upload holds a name in its folder forever.
 *
 * Two properties matter here and both are one-way. Destroying too EARLY is
 * unrecoverable: the document is gone, and a legal hold that was supposed to
 * preserve it has been broken by a timer. Destroying too LATE is a bill. So
 * every case below states which side of the window it sits on, and each has its
 * pair on the other side.
 */
import { inMemoryBucket, installInMemoryBucket, objects } from '../support/inMemoryBucket';
import {
  createFirm,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { rootOf, seedFile, seedFolder, seedMatter } from './fileWorld';

installInMemoryBucket();

const filesRepo = require('../../src/modules/files/files.repository');
const { sweepDestroyedFiles } = require('../../src/modules/files/files.sweeper');

let firm: Firm;
let owner: Actor;
let matterId: string;
let root: string;

/** Backdate a row's delete so it sits outside the retention window. */
async function deletedDaysAgo(fileId: string, days: number) {
  await filesRepo.softDeleteSubtree(firm.id, fileId, owner.uid);
  await testPool.query(
    `update files set deleted_at = now() - ($2 || ' days')::interval where id = $1`,
    [fileId, String(days)],
  );
}

/** Backdate a claimed-but-unfinished upload so it looks abandoned. */
async function claimedHoursAgo(fileId: string, hours: number) {
  await testPool.query(
    `update files set created_at = now() - ($2 || ' hours')::interval where id = $1`,
    [fileId, String(hours)],
  );
}

const rowExists = async (fileId: string) => {
  const { rowCount } = await testPool.query('select 1 from files where id = $1', [fileId]);
  return rowCount === 1;
};

beforeEach(async () => {
  objects.clear();
  firm = await createFirm({ name: 'Sweeper LLP' });
  owner = await ownerOf(firm.id);
  matterId = await seedMatter(firm.id, owner.uid, 'Hale v. Denton');
  root = await rootOf(firm.id, { matterId });
});

describe('a deleted document', () => {
  it('is destroyed once its retention window has cleared', async () => {
    const doc = await seedFile(firm.id, { parentId: root, name: 'old.pdf' });
    await deletedDaysAgo(doc.id, 40);

    const result = await sweepDestroyedFiles();

    // The object goes with the row. Removing one and not the other is how a
    // bucket fills with bytes nothing can name.
    expect(result).toMatchObject({ destroyed: 1, objectsRemoved: 1 });
    expect(await rowExists(doc.id)).toBe(false);
    expect(objects.has(doc.objectPath)).toBe(false);
  });

  it('is left alone while it is still inside the window', async () => {
    const doc = await seedFile(firm.id, { parentId: root, name: 'recent.pdf' });
    await deletedDaysAgo(doc.id, 3);

    await sweepDestroyedFiles();

    // The pair that makes the case above a WINDOW rather than "delete anything
    // marked deleted". Three days in, the firm can still change their mind.
    expect(await rowExists(doc.id)).toBe(true);
    expect(objects.has(doc.objectPath)).toBe(true);
  });

  it('leaves a live document completely alone', async () => {
    const live = await seedFile(firm.id, { parentId: root, name: 'live.pdf' });
    const doomed = await seedFile(firm.id, { parentId: root, name: 'doomed.pdf' });
    await deletedDaysAgo(doomed.id, 40);

    await sweepDestroyedFiles();

    // Without this, every case above passes just as well against a sweeper that
    // empties the table.
    expect(await rowExists(live.id)).toBe(true);
    expect(objects.has(live.objectPath)).toBe(true);
  });
});

describe('an upload that was claimed and never finished', () => {
  it('is collected once it is too old to still be in flight', async () => {
    const abandoned = await seedFile(firm.id, {
      parentId: root, name: 'abandoned.pdf', finalized: false,
    });
    await claimedHoursAgo(abandoned.id, 48);

    await sweepDestroyedFiles();

    // `upload-init` claims a row before the bytes exist, so a closed browser tab
    // leaves one behind. Nothing lists it and nobody is charged for it, but it
    // holds its name in the folder against the next upload of the same name.
    expect(await rowExists(abandoned.id)).toBe(false);
  });

  it('leaves a young unfinished upload alone', async () => {
    const inFlight = await seedFile(firm.id, {
      parentId: root, name: 'in-flight.pdf', finalized: false,
    });
    await claimedHoursAgo(inFlight.id, 1);

    await sweepDestroyedFiles();

    // A resumable upload of a large document over a slow connection can
    // legitimately run for hours. Collecting one still in flight deletes the
    // object the browser is at that moment writing into.
    expect(await rowExists(inFlight.id)).toBe(true);
  });
});

describe('a legal hold outranks the retention window', () => {
  it('spares a held document however long ago it was deleted', async () => {
    const doc = await seedFile(firm.id, { parentId: root, name: 'evidence.pdf' });
    await deletedDaysAgo(doc.id, 400);
    const { rowCount } = await testPool.query(
      `insert into legal_holds (law_firm_id, file_id, reason)
       values ($1, $2, 'preservation notice')`,
      [firm.id, doc.id],
    );
    expect(rowCount).toBe(1);

    await sweepDestroyedFiles();

    // Destroying held evidence because a timer expired is the one failure here
    // that cannot be undone. A hold is released by a person, not by a clock.
    expect(await rowExists(doc.id)).toBe(true);
    expect(objects.has(doc.objectPath)).toBe(true);
  });

  it('spares a document held through its MATTER, not named directly', async () => {
    const doc = await seedFile(firm.id, { parentId: root, name: 'exhibit.pdf' });
    await deletedDaysAgo(doc.id, 400);
    await testPool.query(
      `insert into legal_holds (law_firm_id, matter_id, reason) values ($1, $2, 'litigation hold')`,
      [firm.id, matterId],
    );

    await sweepDestroyedFiles();

    // A hold is placed on the matter, which is how a firm actually receives one.
    // A sweeper that only checked file-level holds would destroy every document
    // under it.
    expect(await rowExists(doc.id)).toBe(true);
  });

  it('collects it again once the hold is released', async () => {
    const doc = await seedFile(firm.id, { parentId: root, name: 'released.pdf' });
    await deletedDaysAgo(doc.id, 400);
    await testPool.query(
      `insert into legal_holds (law_firm_id, file_id, reason, released_at)
       values ($1, $2, 'expired notice', now())`,
      [firm.id, doc.id],
    );

    await sweepDestroyedFiles();

    // A released hold is KEPT as a record of what was held and for how long, so
    // the sweeper has to read `released_at` rather than the row's existence.
    // Reading it wrong preserves everything forever, silently.
    expect(await rowExists(doc.id)).toBe(false);
  });
});

describe('when the object is already gone', () => {
  it('still collects the row rather than retrying forever', async () => {
    const doc = await seedFile(firm.id, { parentId: root, name: 'orphan.pdf' });
    await deletedDaysAgo(doc.id, 40);
    objects.delete(doc.objectPath);

    const result = await sweepDestroyedFiles();

    // The previous pass removed the object and failed before the row. A sweeper
    // that treated "already gone" as a failure would keep that row forever and
    // report the same work undone on every run.
    expect(result.destroyed).toBe(1);
    expect(await rowExists(doc.id)).toBe(false);
  });
});

describe('a deleted folder', () => {
  it('is collected once the documents inside it are gone', async () => {
    const folder = await seedFolder(firm.id, { parentId: root, name: 'Discovery' });
    const nested = await seedFolder(firm.id, { parentId: folder.id, name: 'Depositions' });
    const inside = await seedFile(firm.id, { parentId: nested.id, name: 'note.pdf' });
    await filesRepo.softDeleteSubtree(firm.id, folder.id, owner.uid);
    await testPool.query(
      `update files set deleted_at = now() - interval '40 days' where id in ($1, $2, $3)`,
      [folder.id, nested.id, inside.id],
    );

    await sweepDestroyedFiles();

    // A folder holds no bytes, so there is nothing to reclaim from it, but a
    // row that is never collected is a row forever. A firm that makes and
    // deletes folders all day would otherwise accumulate them without limit,
    // and every subtree read below their parent would walk them.
    //
    // Both levels go in one pass, deepest first: a folder is collected only
    // once nothing remains under it, so the order is forced by the tree.
    expect(await rowExists(inside.id)).toBe(false);
    expect(await rowExists(nested.id)).toBe(false);
    expect(await rowExists(folder.id)).toBe(false);
  });

  it('is kept while a document inside it is still held', async () => {
    const folder = await seedFolder(firm.id, { parentId: root, name: 'Evidence' });
    const held = await seedFile(firm.id, { parentId: folder.id, name: 'exhibit.pdf' });
    await filesRepo.softDeleteSubtree(firm.id, folder.id, owner.uid);
    await testPool.query(
      `update files set deleted_at = now() - interval '400 days' where id in ($1, $2)`,
      [folder.id, held.id],
    );
    await testPool.query(
      `insert into legal_holds (law_firm_id, file_id, reason) values ($1, $2, 'notice')`,
      [firm.id, held.id],
    );

    await sweepDestroyedFiles();

    // The held document is spared, and its folder has to be spared with it:
    // destroying the folder would orphan the very row the hold protects.
    expect(await rowExists(held.id)).toBe(true);
    expect(await rowExists(folder.id)).toBe(true);
  });

  it('is kept while it is still inside the retention window', async () => {
    const folder = await seedFolder(firm.id, { parentId: root, name: 'Recent' });
    await filesRepo.softDeleteSubtree(firm.id, folder.id, owner.uid);
    await testPool.query(
      `update files set deleted_at = now() - interval '3 days' where id = $1`, [folder.id],
    );

    await sweepDestroyedFiles();

    // An empty folder is still recoverable for as long as a document is.
    expect(await rowExists(folder.id)).toBe(true);
  });

  it('never collects a scope root', async () => {
    // A root has no parent and is never soft-deleted, but a sweep that matched
    // "folder with nothing under it" would find every empty matter's root.
    await sweepDestroyedFiles();

    expect(await rowExists(root)).toBe(true);
  });
});

describe('what one pass will not do', () => {

  it('stops at its per-pass limit rather than running unbounded', async () => {
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- ordered seeding
      const doc = await seedFile(firm.id, { parentId: root, name: `doc-${i}.pdf` });
      // eslint-disable-next-line no-await-in-loop
      await deletedDaysAgo(doc.id, 40);
    }

    const result = await sweepDestroyedFiles({ limit: 2 });

    // One pass runs inside a cron request. An unbounded one on a firm that just
    // deleted a hundred thousand documents holds that request open until it is
    // killed, and the work restarts from nothing.
    expect(result).toMatchObject({ examined: 2, destroyed: 2 });
  });
});

describe('removing the objects', () => {
  it('works several at a time, and never more than eight at once', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- fixture rows
      const file = await seedFile(firm.id, { parentId: root, name: `old-${i}.pdf`, bytes: 8 });
      // eslint-disable-next-line no-await-in-loop -- fixture rows
      await deletedDaysAgo(file.id, 40);
      ids.push(file.id);
    }

    let inFlight = 0;
    let peak = 0;
    const realFile = inMemoryBucket.file;
    const spy = jest.spyOn(inMemoryBucket, 'file').mockImplementation((path: string, options?: any) => {
      const handle: any = (realFile as any)(path, options);
      const realDelete = handle.delete;
      handle.delete = async (...args: any[]) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          await new Promise((resolve) => { setTimeout(resolve, 5); });
          return await realDelete(...args);
        } finally {
          inFlight -= 1;
        }
      };
      return handle;
    });

    let result: any;
    try {
      result = await sweepDestroyedFiles();
    } finally {
      spy.mockRestore();
    }

    // One awaited delete at a time made a pass as long as its row count times a
    // storage round trip. Unbounded, it is five hundred at once.
    expect(result.destroyed).toBe(20);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop -- one read per fixture row
      expect(await rowExists(id)).toBe(false);
    }
  });
});
