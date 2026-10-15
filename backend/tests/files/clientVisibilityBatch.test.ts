/**
 * `PATCH /files/bulk-client-visibility`: sharing a whole selection with the
 * client portal in ONE request.
 *
 * WHY IT EXISTS. `PATCH /client-visibility` takes one `fileId`, so sharing a
 * picker's selection sent one request per file. Bounded to four at a time on the
 * browser side, a two-hundred-file share was still two hundred round trips
 * against an instance whose small Postgres pool is shared by every request on
 * it.
 *
 * THE CONTRACT THIS PINS, and it is a deliberate choice rather than a fallback:
 * the batch is NOT all-or-nothing. A file the caller cannot reach is reported in
 * `errors` and the rest of the selection is shared. A selection names ids the
 * caller merely holds a list of (a folder listed a moment ago, a search hit from
 * another matter), so one stale id must not refuse the other hundred and ninety
 * nine. The same reasoning `/list-matters` already applies to a batch read, with
 * one difference that matters: an unreachable id there is silently ABSENT, and
 * here it is REPORTED, because this is a write the user asked for and silence
 * would read as success.
 *
 * WHAT BREAKS THESE: making the route atomic (the mixed batch stops sharing the
 * reachable file); dropping the per-file wall (the other firm's row flips);
 * looping `setVisibility` per id (the connection count grows with the selection);
 * moving the cap out of `validate` into the handler (the over-cap case writes
 * before it refuses).
 */
import { randomUUID } from 'crypto';

import {
  createFirm,
  createPersonClient,
  drainEvents,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { fileRowById, rootOf, seedFile, seedMatter } from './fileWorld';

// Loaded after the harness, which points DATABASE_URL at this worker's test
// database: `db.ts` reads the URL when it is first imported.
const { pool } = require('../../src/shared/database/db');
const { MAX_BULK_VISIBILITY_FILE_IDS } = require('../../src/modules/files/files.validation');

let firm: Firm;
let owner: Actor;
let matterId: string;
let matterRoot: string;
let clientId: string;

/** A second firm, with a real document of its own to reach for. */
let rival: Firm;
let rivalOwner: Actor;
let rivalMatterId: string;
let rivalFile: { id: string };

const bulkUrl = (lawFirmId: string) => `/api/lawfirms/${lawFirmId}/files/bulk-client-visibility`;

/** The clients a share was narrowed to, straight from the table. */
async function restrictedTo(lawFirmId: string, fileId: string): Promise<string[]> {
  const { rows } = await testPool.query(
    'select client_id from file_client_visibility where law_firm_id = $1 and file_id = $2',
    [lawFirmId, fileId],
  );
  return rows.map((r: { client_id: string }) => r.client_id).sort();
}

/** Total pool checkouts a piece of work makes, which is what grows with a loop. */
async function connectionsDuring(work: () => Promise<unknown>) {
  let acquired = 0;
  const onAcquire = () => { acquired += 1; };
  pool.on('acquire', onAcquire);
  try {
    const result = await work();
    return { result, acquired };
  } finally {
    pool.off('acquire', onAcquire);
  }
}

async function seedFiles(count: number) {
  const made: Array<{ id: string; name: string }> = [];
  for (let i = 0; i < count; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- sibling names must not race
    made.push(await seedFile(firm.id, { parentId: matterRoot, name: `doc-${i}.pdf` }));
  }
  return made;
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
  matterId = await seedMatter(firm.id, owner.uid, 'Hollis v. Denton');
  matterRoot = await rootOf(firm.id, { matterId });
  const client = await createPersonClient(firm.id, { name: 'Jane Hollis' });
  clientId = client.id;
  const { rowCount } = await testPool.query(
    'insert into matter_clients (matter_id, client_id, law_firm_id) values ($1, $2, $3)',
    [matterId, clientId, firm.id],
  );
  expect(rowCount).toBe(1);

  rival = await createFirm({ name: 'Vance LLP' });
  rivalOwner = await ownerOf(rival.id);
  rivalMatterId = await seedMatter(rival.id, rivalOwner.uid, 'Vance v. Orr');
  rivalFile = await seedFile(rival.id, {
    parentId: await rootOf(rival.id, { matterId: rivalMatterId }),
    name: 'Deposition.pdf',
  });

  await drainEvents();
});

describe('bulk client-visibility: another firm', () => {
  // The first case for any new route. A 200 to the wrong firm is the most
  // expensive defect this codebase can ship and it never looks wrong on screen.
  it('refuses the rival firm owner outright and leaves both trees alone', async () => {
    const [mine] = await seedFiles(1);

    const res = await rivalOwner.api.patch(bulkUrl(firm.id)).send({
      matterId,
      fileIds: [mine.id],
      clientVisible: true,
    });

    expect(res.status).toBe(403);
    expect((await fileRowById(firm.id, mine.id)).client_visible).toBe(false);
  });

  // The other half: a caller fully legitimate inside their own firm, naming a
  // file id that belongs to somebody else. The row lookup is firm-scoped, so the
  // id resolves to nothing rather than to a row a comparison then has to catch.
  it('cannot flip another firm\'s document by naming its id from inside its own firm', async () => {
    const res = await rivalOwner.api.patch(bulkUrl(rival.id)).send({
      matterId: rivalMatterId,
      fileIds: [rivalFile.id],
      clientVisible: true,
    });
    // Control: the rival really can share their own file, so the refusal below
    // is about whose file it is and not about a route that refuses everyone.
    expect(res.status).toBe(200);

    const [mine] = await seedFiles(1);
    const reach = await rivalOwner.api.patch(bulkUrl(rival.id)).send({
      matterId: rivalMatterId,
      fileIds: [mine.id],
      clientVisible: true,
    });

    expect(reach.status).toBe(200);
    expect(reach.body).toMatchObject({ requested: 1, updated: 0, failed: [mine.id] });
    expect(reach.body.errors[mine.id]).toMatch(/not found/i);
    expect((await fileRowById(firm.id, mine.id)).client_visible).toBe(false);
  });
});

describe('bulk client-visibility: the partial contract', () => {
  it('shares the reachable file and reports the unreachable one, rather than refusing the batch', async () => {
    const [mine] = await seedFiles(1);

    const res = await owner.api.patch(bulkUrl(firm.id)).send({
      matterId,
      fileIds: [mine.id, rivalFile.id],
      clientVisible: true,
      notifyClient: false,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      requested: 2,
      updated: 1,
      failed: [rivalFile.id],
    });
    expect(res.body.errors[rivalFile.id]).toMatch(/not found/i);
    expect(res.body.errors[mine.id]).toBeUndefined();

    // The whole point of the contract: the reachable half really went through.
    expect((await fileRowById(firm.id, mine.id)).client_visible).toBe(true);
    // And the other firm's document did not.
    expect((await fileRowById(rival.id, rivalFile.id)).client_visible).toBe(false);
  });

  it('reports a file from a matter the caller was not authorized for in THIS request', async () => {
    const [inScope] = await seedFiles(1);
    const otherMatter = await seedMatter(firm.id, owner.uid, 'Ortiz Estate');
    const elsewhere = await seedFile(firm.id, {
      parentId: await rootOf(firm.id, { matterId: otherMatter }),
      name: 'Will.pdf',
    });

    const res = await owner.api.patch(bulkUrl(firm.id)).send({
      matterId,
      fileIds: [inScope.id, elsewhere.id],
      clientVisible: true,
      notifyClient: false,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ requested: 2, updated: 1, failed: [elsewhere.id] });
    // The scope named in the request is the authorization; a row outside it was
    // never covered by that check, whoever owns it.
    expect((await fileRowById(firm.id, elsewhere.id)).client_visible).toBe(false);
    expect((await fileRowById(firm.id, inScope.id)).client_visible).toBe(true);
  });

  it('writes the visibility rows, and clears them again on an unshare', async () => {
    const files = await seedFiles(3);
    const coClient = await createPersonClient(firm.id, { name: 'Ruth Denton' });
    await testPool.query(
      'insert into matter_clients (matter_id, client_id, law_firm_id) values ($1, $2, $3)',
      [matterId, coClient.id, firm.id],
    );

    const shared = await owner.api.patch(bulkUrl(firm.id)).send({
      matterId,
      fileIds: files.map((f) => f.id),
      clientVisible: true,
      visibleClientIds: [clientId],
      notifyClient: false,
    });
    await drainEvents();

    expect(shared.status).toBe(200);
    expect(shared.body).toMatchObject({ requested: 3, updated: 3, failed: [], errors: {} });
    for (const file of files) {
      // eslint-disable-next-line no-await-in-loop
      expect((await fileRowById(firm.id, file.id)).client_visible).toBe(true);
      // The narrowing is a row per file per named client, not a flag: without it
      // the co-client on the same matter would see all three documents.
      // eslint-disable-next-line no-await-in-loop
      expect(await restrictedTo(firm.id, file.id)).toEqual([clientId]);
    }

    const unshared = await owner.api.patch(bulkUrl(firm.id)).send({
      matterId,
      fileIds: files.map((f) => f.id),
      clientVisible: false,
    });
    await drainEvents();

    expect(unshared.body).toMatchObject({ requested: 3, updated: 3 });
    for (const file of files) {
      // eslint-disable-next-line no-await-in-loop
      expect((await fileRowById(firm.id, file.id)).client_visible).toBe(false);
      // A stale narrowing row left behind would re-restrict the next share.
      // eslint-disable-next-line no-await-in-loop
      expect(await restrictedTo(firm.id, file.id)).toEqual([]);
    }
  });
});

describe('bulk client-visibility: the cost of the batch', () => {
  it('holds the same number of connections for eight files as for one', async () => {
    const files = await seedFiles(8);

    // Warm the membership and permission caches, so what is measured below is
    // the route's own work rather than whichever run happened to go first.
    await owner.api.patch(bulkUrl(firm.id)).send({
      matterId, fileIds: [files[0].id], clientVisible: false,
    });

    const one = await connectionsDuring(() => owner.api.patch(bulkUrl(firm.id)).send({
      matterId,
      fileIds: [files[0].id],
      clientVisible: true,
      visibleClientIds: [clientId],
      notifyClient: false,
    }));
    await drainEvents();

    const eight = await connectionsDuring(() => owner.api.patch(bulkUrl(firm.id)).send({
      matterId,
      fileIds: files.map((f) => f.id),
      clientVisible: true,
      visibleClientIds: [clientId],
      notifyClient: false,
    }));
    await drainEvents();

    expect((one.result as { status: number }).status).toBe(200);
    expect((eight.result as { body: { updated: number } }).body.updated).toBe(8);
    // Proves the listener sees the request's queries at all, so an equality
    // below is a real measurement and not two detached zeroes.
    expect(one.acquired).toBeGreaterThanOrEqual(2);
    expect(eight.acquired).toBe(one.acquired);
  });
});

describe('bulk client-visibility: the cap', () => {
  it('refuses more ids than the cap with a 400 and writes nothing', async () => {
    const [mine] = await seedFiles(1);
    const filler = Array.from({ length: MAX_BULK_VISIBILITY_FILE_IDS }, () => randomUUID());

    const res = await owner.api.patch(bulkUrl(firm.id)).send({
      matterId,
      // The caller's own real file is FIRST, so a handler that started writing
      // before checking the cap would leave it shared.
      fileIds: [mine.id, ...filler],
      clientVisible: true,
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(new RegExp(String(MAX_BULK_VISIBILITY_FILE_IDS)));
    // Refused, never silently truncated: a dropped id reads downstream as "this
    // file was shared" when it was not.
    expect((await fileRowById(firm.id, mine.id)).client_visible).toBe(false);
  });

  it('accepts a batch exactly at the cap', async () => {
    const files = await seedFiles(2);
    const padding = Array.from(
      { length: MAX_BULK_VISIBILITY_FILE_IDS - files.length },
      () => randomUUID(),
    );

    const res = await owner.api.patch(bulkUrl(firm.id)).send({
      matterId,
      fileIds: [...files.map((f) => f.id), ...padding],
      clientVisible: true,
      notifyClient: false,
    });

    expect(res.status).toBe(200);
    expect(res.body.requested).toBe(MAX_BULK_VISIBILITY_FILE_IDS);
    expect(res.body.updated).toBe(2);
  });

  it('refuses an empty id list', async () => {
    const res = await owner.api.patch(bulkUrl(firm.id)).send({
      matterId, fileIds: [], clientVisible: true,
    });
    expect(res.status).toBe(400);
  });
});
