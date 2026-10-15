/**
 * The constraints that make the file tree correct under concurrent use.
 *
 * The tree lives in `files.parent_id`, and the object under
 * `lawfirmids/{firm}/objects/{id}` never moves. That shifts three decisions from
 * application code into the database, and each of them is a race the old
 * path-as-tree design lost:
 *
 *   1. Two people uploading the same filename into one folder at the same moment.
 *      The old resolver asked storage whether the path existed, and at that
 *      moment neither upload had written a byte, so both were handed the same
 *      path and the second overwrote the first.
 *   2. Two people creating the same folder. The old check-then-write replaced the
 *      first marker, losing its colour and its client share state.
 *   3. A folder with no `.folder` marker read as a file, so deleting it orphaned
 *      the whole subtree. `kind` is a column now, not metadata on an object that
 *      can go missing.
 *
 * These are unit tests against the constraints themselves, not the routes: a
 * route test proves the handler asks correctly, and this proves the database
 * refuses even when it does not.
 */
import { randomUUID } from 'crypto';

import { testPool, createFirm, type Firm } from '../support/setupInProcess';

let firm: Firm;

const objectPath = () => `lawfirmids/${firm.id}/objects/${randomUUID()}`;

async function insertRoot(scope = 'firm', ids: Record<string, string | null> = {}) {
  const { rows } = await testPool.query(
    `insert into files (law_firm_id, kind, name, scope, matter_id, task_id, client_id)
     values ($1, 'folder', '', $2, $3, $4, $5) returning id`,
    [firm.id, scope, ids.matterId ?? null, ids.taskId ?? null, ids.clientId ?? null],
  );
  return rows[0].id as string;
}

beforeEach(async () => {
  firm = await createFirm();
});

describe('sibling names', () => {
  it('refuses two files with the same name in one folder', async () => {
    const root = await insertRoot();
    await testPool.query(
      `insert into files (law_firm_id, kind, name, parent_id, scope, object_path)
       values ($1, 'file', 'Retainer.pdf', $2, 'firm', $3)`,
      [firm.id, root, objectPath()],
    );

    // 23505 is unique_violation. The upload route turns this into the "(1)"
    // suffix; what matters here is that the database is what decides, so two
    // concurrent inserts cannot both win.
    await expect(testPool.query(
      `insert into files (law_firm_id, kind, name, parent_id, scope, object_path)
       values ($1, 'file', 'Retainer.pdf', $2, 'firm', $3)`,
      [firm.id, root, objectPath()],
    )).rejects.toMatchObject({ code: '23505' });
  });

  it('treats names case-insensitively', async () => {
    const root = await insertRoot();
    await testPool.query(
      `insert into files (law_firm_id, kind, name, parent_id, scope, object_path)
       values ($1, 'file', 'Retainer.pdf', $2, 'firm', $3)`,
      [firm.id, root, objectPath()],
    );

    // Two files whose names differ only in case read as the same document to a
    // person, and on a case-insensitive client they cannot both be downloaded.
    await expect(testPool.query(
      `insert into files (law_firm_id, kind, name, parent_id, scope, object_path)
       values ($1, 'file', 'retainer.PDF', $2, 'firm', $3)`,
      [firm.id, root, objectPath()],
    )).rejects.toMatchObject({ code: '23505' });
  });

  it('allows the same name in two different folders', async () => {
    const root = await insertRoot();
    const { rows: [a] } = await testPool.query(
      `insert into files (law_firm_id, kind, name, parent_id, scope) values ($1, 'folder', 'A', $2, 'firm') returning id`,
      [firm.id, root],
    );
    const { rows: [b] } = await testPool.query(
      `insert into files (law_firm_id, kind, name, parent_id, scope) values ($1, 'folder', 'B', $2, 'firm') returning id`,
      [firm.id, root],
    );

    // The pair above is what makes the two refusals meaningful: the constraint
    // is scoped to one parent, not to the firm.
    for (const parent of [a.id, b.id]) {
      const inserted = await testPool.query(
        `insert into files (law_firm_id, kind, name, parent_id, scope, object_path)
         values ($1, 'file', 'Retainer.pdf', $2, 'firm', $3)`,
        [firm.id, parent, objectPath()],
      );
      expect(inserted.rowCount).toBe(1);
    }
  });

  it('frees the name once the row is soft-deleted', async () => {
    const root = await insertRoot();
    const { rows: [first] } = await testPool.query(
      `insert into files (law_firm_id, kind, name, parent_id, scope, object_path)
       values ($1, 'file', 'Retainer.pdf', $2, 'firm', $3) returning id`,
      [firm.id, root, objectPath()],
    );
    await testPool.query(`update files set deleted_at = now() where id = $1`, [first.id]);

    // Deleting a document and uploading a replacement under the same name is
    // ordinary. The trash keeps the old row, so the index has to ignore it.
    const replacement = await testPool.query(
      `insert into files (law_firm_id, kind, name, parent_id, scope, object_path)
       values ($1, 'file', 'Retainer.pdf', $2, 'firm', $3)`,
      [firm.id, root, objectPath()],
    );
    expect(replacement.rowCount).toBe(1);
  });
});

describe('files and folders', () => {
  it('refuses a folder that carries an object', async () => {
    const root = await insertRoot();

    // A folder is a row, not an object. One that carried an object path would
    // be reachable by the download and signing routes, which sign whatever the
    // row points at.
    await expect(testPool.query(
      `insert into files (law_firm_id, kind, name, parent_id, scope, object_path)
       values ($1, 'folder', 'Contracts', $2, 'firm', $3)`,
      [firm.id, root, objectPath()],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a file with no object', async () => {
    const root = await insertRoot();

    // The mirror of the case above: a file row with nothing behind it is a
    // listing entry that cannot be downloaded.
    await expect(testPool.query(
      `insert into files (law_firm_id, kind, name, parent_id, scope)
       values ($1, 'file', 'Ghost.pdf', $2, 'firm')`,
      [firm.id, root],
    )).rejects.toMatchObject({ code: '23514' });
  });
});

describe('scope roots', () => {
  it('refuses a second root for one matter', async () => {
    const { rows: [matter] } = await testPool.query(
      `insert into matters (law_firm_id, name, matter_reference_id, status)
       values ($1, 'Estate of Ellis', $2, 'active') returning id`,
      [firm.id, `REF-${randomUUID().slice(0, 8)}`],
    );
    await insertRoot('matter', { matterId: matter.id });

    // Two roots would split one matter's documents into two trees, each
    // invisible from the other. `ensureScopeRoot` inserts on conflict, and this
    // is the conflict it relies on.
    await expect(insertRoot('matter', { matterId: matter.id }))
      .rejects.toMatchObject({ code: '23505' });
  });

  it('refuses a second firm-general root', async () => {
    await insertRoot('firm');

    await expect(insertRoot('firm')).rejects.toMatchObject({ code: '23505' });
  });

  it('refuses a root whose scope does not match the id it carries', async () => {
    // `scope` decides which listing a root serves, so a 'matter' root with no
    // matter id would be unreachable and a 'firm' root with one would shadow
    // that matter's own.
    await expect(insertRoot('matter', {})).rejects.toMatchObject({ code: '23514' });
  });
});
