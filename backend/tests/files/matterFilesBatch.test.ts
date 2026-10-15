/**
 * GET /api/lawfirms/:lawFirmId/files/list-matters?matterIds=a,b,c
 *
 * The documents of SEVERAL matters in one request.
 *
 * WHY THIS ROUTE EXISTS. Every API instance shares one 12-connection pool
 * against a Supabase session pooler that allows 15. Until this route, matter
 * files could only be listed one matter at a time, so the client detail page's
 * Files tab fired one request per matter the moment the tab opened: a corporate
 * client with eighty matters opened eighty simultaneous requests and one user
 * held the whole pool while everybody else queued behind them.
 *
 * WHAT THESE TESTS PIN, and what has to break for each to go red:
 *
 *   - the batch answers with the SAME entries `/list` answers with, folder
 *     counts included. Reshape either read and the equality test fails, which is
 *     what keeps the Files tab rendering identically once it is rewired.
 *   - the batch applies the SAME access rule as `/list`. Widen it to "any firm
 *     member sees any matter" and the partial-access test fails; drop the tenant
 *     scope and the cross-firm tests fail.
 *   - the batch costs a CONSTANT number of pool checkouts and a constant number
 *     of reads of `files`. Reintroduce a per-matter query and the connection
 *     test fails, which is the entire point of the route.
 *   - the cap is enforced BEFORE any read. Move the check into the handler and
 *     the over-cap test sees a read and fails.
 *
 * The pool observer below is the one in `tests/matters/matterClientsBatch.test.ts`,
 * kept local to each spec rather than shared, because what it records (which
 * statements count as the read under test) is different in each.
 */
import {
  createFirm,
  drainEvents,
  memberWith,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { installInMemoryBucket, objects } from '../support/inMemoryBucket';
import { rootOf, seedFile, seedFolder, seedMatter } from './fileWorld';

// Loaded after the harness, which points DATABASE_URL at this worker's test
// database: `db.ts` reads the URL when it is first imported.
const { pool } = require('../../src/shared/database/db');
// The cap is read from the module that enforces it rather than copied, so a
// change to it moves the boundary these tests probe instead of going unnoticed.
const { MAX_BATCH_MATTER_IDS } = require('../../src/modules/files/files.validation');

installInMemoryBucket();

let firm: Firm;
let owner: Actor;

const F = (lawFirmId: string) => `/api/lawfirms/${lawFirmId}/files`;
const batchUrl = (ids: string[], lawFirmId = firm.id) =>
  `${F(lawFirmId)}/list-matters?matterIds=${ids.join(',')}`;

beforeEach(async () => {
  objects.clear();
  firm = await createFirm({ name: 'Batch & Co' });
  owner = await ownerOf(firm.id);
  await drainEvents();
});

/** A matter the owner is staffed on, holding one file per name given. */
async function matterWithFiles(name: string, fileNames: string[]): Promise<string> {
  const matterId = await seedMatter(firm.id, owner.uid, name);
  if (fileNames.length === 0) return matterId;
  const parentId = await rootOf(firm.id, { matterId });
  for (const fileName of fileNames) {
    // eslint-disable-next-line no-await-in-loop -- fixture, one row at a time
    await seedFile(firm.id, { parentId, name: fileName });
  }
  return matterId;
}

/**
 * What one request cost the pool: how many connections it checked out, and the
 * SQL it ran on them.
 *
 * Read off the app's own pool, so it covers the auth and permission middleware
 * as well as the handler. The SQL is captured by wrapping each checked-out
 * client's `query` for the duration, which observes the real driver rather than
 * standing in for it; the wrapper is removed again on the way out.
 */
async function observe(work: () => Promise<unknown>) {
  // Settle first. A listener still running from an earlier request holds a
  // queued checkout that the pool hands out whenever a connection frees, and
  // counting that stray against this request would make the measurement a race.
  await drainEvents();
  await new Promise((resolve) => setImmediate(resolve));

  let checkouts = 0;
  const sql: string[] = [];
  // Keyed by client, because the pool hands the SAME client back for the next
  // checkout: wrapping it again would stack the recorders and count one
  // statement once per layer.
  const originals = new Map<any, any>();
  const onAcquire = (client: any) => {
    checkouts += 1;
    if (originals.has(client)) return;
    const original = client.query;
    originals.set(client, original);
    client.query = function patched(this: unknown, ...args: any[]) {
      const first = args[0];
      sql.push(typeof first === 'string' ? first : String(first?.text ?? ''));
      return original.apply(this, args);
    };
  };
  pool.on('acquire', onAcquire);
  try {
    const result = await work();
    return { result: result as any, checkouts, sql };
  } finally {
    pool.off('acquire', onAcquire);
    for (const [client, original] of originals) client.query = original;
  }
}

/** The statements that read the file tree. */
const fileReads = (sql: string[]) => sql.filter((text) => /\bfrom files\b/i.test(text));

describe('GET /files/list-matters: tenant isolation', () => {
  it('gives another firm owner nothing for this firm matter ids', async () => {
    const matterId = await matterWithFiles('Alpha', ['Retainer.pdf']);
    const otherFirm = await createFirm({ name: 'Rival LLP' });
    const otherOwner = await ownerOf(otherFirm.id);

    // Asked through their OWN firm, which they legitimately own: the ids are
    // real, but they name matters in a firm the read is not scoped to.
    const throughOwnFirm = await otherOwner.api.get(batchUrl([matterId], otherFirm.id));
    expect(throughOwnFirm.status).toBe(200);
    expect(throughOwnFirm.body.filesByMatterId).toEqual({});
    expect(JSON.stringify(throughOwnFirm.body)).not.toContain('Retainer.pdf');

    // Asked through THIS firm: refused outright, not answered with an empty map.
    const throughThisFirm = await otherOwner.api.get(batchUrl([matterId]));
    expect(throughThisFirm.status).toBe(403);
    expect(JSON.stringify(throughThisFirm.body)).not.toContain('Retainer.pdf');
  });

  it('drops a matter id belonging to another firm from an otherwise valid batch', async () => {
    const mine = await matterWithFiles('Mine', ['My Brief.pdf']);
    const otherFirm = await createFirm({ name: 'Rival LLP' });
    const otherOwner = await ownerOf(otherFirm.id);
    const theirMatter = await seedMatter(otherFirm.id, otherOwner.uid, 'Theirs');
    const theirRoot = await rootOf(otherFirm.id, { matterId: theirMatter });
    await seedFile(otherFirm.id, { parentId: theirRoot, name: 'Their Brief.pdf' });

    // The firm owner takes the owner/admin path, which is the one that could
    // wave a foreign id through if it trusted the caller instead of the scope.
    const res = await owner.api.get(batchUrl([mine, theirMatter]));

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.filesByMatterId)).toEqual([mine]);
    expect(JSON.stringify(res.body)).not.toContain('Their Brief.pdf');
  });
});

describe('GET /files/list-matters: matter-level access', () => {
  it('returns the matters a member is staffed on and omits the one they are not', async () => {
    const member = await memberWith(firm.id, ['files.view', 'matters.view']);
    const onIt = await seedMatter(firm.id, member.uid, 'Staffed');
    const offIt = await seedMatter(firm.id, owner.uid, 'Not Staffed');
    await seedFile(firm.id, {
      parentId: await rootOf(firm.id, { matterId: onIt }), name: 'Visible.pdf',
    });
    await seedFile(firm.id, {
      parentId: await rootOf(firm.id, { matterId: offIt }), name: 'Walled Off.pdf',
    });

    const res = await member.api.get(batchUrl([onIt, offIt]));

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.filesByMatterId)).toEqual([onIt]);
    expect(res.body.filesByMatterId[onIt].files.map((f: any) => f.name)).toEqual(['Visible.pdf']);
    // The whole point of the omission: the unstaffed matter's document never
    // crosses the wire, not even as a name the caller could read.
    expect(JSON.stringify(res.body)).not.toContain('Walled Off.pdf');
  });

  it('answers a readable matter that holds no documents as present and empty', async () => {
    const empty = await seedMatter(firm.id, owner.uid, 'Nothing Filed Yet');
    // Nothing has ever been filed here, so the matter has no scope root either:
    // the batch must answer for it without creating one.
    const before = await testPool.query(
      'select id from files where law_firm_id = $1 and matter_id = $2', [firm.id, empty],
    );
    expect(before.rows).toHaveLength(0);

    const res = await owner.api.get(batchUrl([empty]));

    expect(res.status).toBe(200);
    expect(res.body.filesByMatterId[empty]).toEqual({ files: [], truncated: false });
    const after = await testPool.query(
      'select id from files where law_firm_id = $1 and matter_id = $2', [firm.id, empty],
    );
    expect(after.rows).toHaveLength(0);
  });
});

describe('GET /files/list-matters: equals the per-matter route', () => {
  it('returns, for three matters, exactly what three single calls return', async () => {
    const first = await matterWithFiles('One', ['Complaint.pdf', 'Answer.pdf']);
    const second = await matterWithFiles('Two', ['Invoice.pdf']);
    const third = await seedMatter(firm.id, owner.uid, 'Three');

    // A folder with a document inside it, because `fileCount` on a folder entry
    // is a second query in the single read and the field most easily lost when a
    // batch reshapes the projection.
    const contracts = await seedFolder(firm.id, {
      parentId: await rootOf(firm.id, { matterId: first }), name: 'Contracts',
    });
    await seedFile(firm.id, { parentId: contracts.id, name: 'NDA.pdf' });

    const singles: Record<string, unknown> = {};
    for (const matterId of [first, second, third]) {
      // eslint-disable-next-line no-await-in-loop -- the per-matter route is the subject
      const res = await owner.api.get(`${F(firm.id)}/list?matterId=${matterId}`);
      expect(res.status).toBe(200);
      singles[matterId] = { files: res.body.files, truncated: res.body.truncated };
    }
    // Proves the comparison below is not three empty objects agreeing. The
    // listing is recursive and flattened, folders first then files by name, so
    // the document inside Contracts appears beside the ones at the root.
    expect((singles[first] as any).files.map((f: any) => f.name))
      .toEqual(['Contracts', 'Answer.pdf', 'Complaint.pdf', 'NDA.pdf']);
    expect((singles[first] as any).files[0].fileCount).toBe(1);
    expect((singles[third] as any).files).toEqual([]);

    const batch = await owner.api.get(batchUrl([first, second, third]));

    expect(batch.status).toBe(200);
    expect(batch.body.filesByMatterId).toEqual(singles);
  });
});

describe('GET /files/list-matters: connection cost', () => {
  it('takes the same number of pool checkouts and reads for ten matters as for one', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- fixture, one matter at a time
      const matterId = await matterWithFiles(`Matter ${i}`, [`Doc ${i}.pdf`]);
      // eslint-disable-next-line no-await-in-loop
      await seedFolder(firm.id, {
        parentId: await rootOf(firm.id, { matterId }), name: `Folder ${i}`,
      });
      ids.push(matterId);
    }
    // Warm the permission cache, so the measurements below compare the read
    // itself rather than one request's cold members/roles lookup.
    await owner.api.get(batchUrl([ids[0]]));

    const one = await observe(() => owner.api.get(batchUrl([ids[0]])));
    const ten = await observe(() => owner.api.get(batchUrl(ids)));

    expect(one.result.status).toBe(200);
    expect(ten.result.status).toBe(200);
    expect(Object.keys(ten.result.body.filesByMatterId)).toHaveLength(10);
    // Proves the listener is attached to the pool the request actually uses, so
    // the equality below is a measurement and not a pair of zeroes.
    expect(one.checkouts).toBeGreaterThan(0);
    expect(ten.checkouts).toBe(one.checkouts);
    expect(ten.sql).toHaveLength(one.sql.length);
    // The connection count alone would still allow ten sequential reads down one
    // connection. Ten matters must cost the SAME two reads of the tree one
    // matter costs: the subtree rows, and the folder counts over them.
    expect(fileReads(ten.sql)).toHaveLength(2);
    expect(fileReads(one.sql)).toHaveLength(2);
  });
});

describe('GET /files/list-matters: the cap', () => {
  it('refuses more ids than the cap, and reads nothing when it does', async () => {
    const real = await matterWithFiles('Real', ['Real Document.pdf']);
    // Warm the permission cache, so what the over-cap request runs below is
    // whatever it runs on a warm instance rather than a first-request lookup.
    await owner.api.get(batchUrl([real]));

    const overCap = [
      real,
      ...Array.from(
        { length: MAX_BATCH_MATTER_IDS },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      ),
    ];

    const refused = await observe(() => owner.api.get(batchUrl(overCap)));
    expect(refused.result.status).toBe(400);
    expect(JSON.stringify(refused.result.body)).toMatch(/matterIds/);
    // The cap is enforced by the validation middleware, so the request is
    // refused before anything looks a matter or a document up: a real matter id
    // sits in the list above and still nothing reads it.
    expect(refused.sql.filter((text) => /\bfiles\b|\bmatters\b/i.test(text))).toEqual([]);
    expect(JSON.stringify(refused.result.body)).not.toContain('Real Document.pdf');

    // Exactly at the cap still answers, so the boundary is the cap and not one
    // below it.
    const atCap = overCap.slice(0, MAX_BATCH_MATTER_IDS);
    expect(atCap).toHaveLength(MAX_BATCH_MATTER_IDS);
    const allowed = await owner.api.get(batchUrl(atCap));
    expect(allowed.status).toBe(200);
    expect(allowed.body.filesByMatterId[real].files.map((f: any) => f.name))
      .toEqual(['Real Document.pdf']);
  });
});
