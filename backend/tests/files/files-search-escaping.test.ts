/**
 * Search escaping in the files repository, against the real database.
 *
 * A search term reaches SQL as `name ilike '%term%'`, so the two LIKE
 * metacharacters have to be escaped or a search means something other than what
 * was typed. Both arrive in practice: the upload sanitizer strips `%` from a
 * filename but keeps `_`, and maps spaces to `_`.
 *
 * The prefix half of this file is gone. Search used to bound itself with
 * `object_path like 'prefix%'`, so the PREFIX needed escaping too, and a folder
 * whose name held an underscore silently widened the subtree being searched.
 * The subtree is `parent_id` now, so there is no pattern to escape and no
 * boundary to slip.
 */
import { createFirm, testPool, type Firm } from '../support/setupInProcess';
import { seedMatter } from './fileWorld';

const filesRepo = require('../../src/modules/files/files.repository');

const NAMES = [
  '50% discount notes.pdf',
  '500 pages.pdf',
  'plain report.pdf',
  'quarterly summary.pdf',
];

let firm: Firm;
let root: string;

beforeEach(async () => {
  firm = await createFirm({ name: 'Escaping & Co' });
  const matterId = await seedMatter(firm.id, null, 'Escaping v. Wildcards');
  root = await filesRepo.ensureScopeRoot(firm.id, { scope: 'matter', matterId });
  for (const name of NAMES) {
    const row = await filesRepo.createFile(firm.id, { parentId: root, name, mimeType: 'application/pdf' });
    await filesRepo.finalize(firm.id, row.id, { sizeBytes: 1024, mimeType: 'application/pdf' });
  }
});

describe('search escapes LIKE metacharacters', () => {
  it('treats a literal % as text rather than a wildcard', async () => {
    const rows = await filesRepo.search(firm.id, root, '50%');

    // Unescaped, `%50%%` matches every file in the tree. Escaped, it matches
    // only the one whose name actually contains "50%".
    const names = rows.map((r: any) => r.name).sort();
    expect(names).toEqual(['50% discount notes.pdf']);
    expect(names).not.toContain('500 pages.pdf');
    expect(rows.length).toBeLessThan(NAMES.length);
  });

  it('treats a literal _ as text rather than a single-character wildcard', async () => {
    // "_ pages.pdf" would match "0 pages.pdf" and friends if `_` stayed a
    // wildcard; as a literal it matches nothing, since no name has one.
    expect(await filesRepo.search(firm.id, root, '_ pages')).toEqual([]);
  });

  it('still finds ordinary substrings', async () => {
    const rows = await filesRepo.search(firm.id, root, 'pages');
    expect(rows.map((r: any) => r.name)).toEqual(['500 pages.pdf']);
  });

  it('treats a term of nothing but wildcards literally', async () => {
    // A bare `%` used to compile to `%%%` and return the whole tree. Escaped it
    // is an ordinary one-character search for a percent sign.
    const rows = await filesRepo.search(firm.id, root, '%');
    expect(rows.map((r: any) => r.name)).toEqual(['50% discount notes.pdf']);
  });

  it('returns nothing for an empty term', async () => {
    // Better than matching the firm's entire file tree, which is what an
    // unguarded empty term compiles to.
    expect(await filesRepo.search(firm.id, root, '')).toEqual([]);
    expect(await filesRepo.search(firm.id, root, '   ')).toEqual([]);
  });
});

describe('search stays inside the tree it was given', () => {
  it('does not reach a sibling matter, whatever the term', async () => {
    const otherMatter = await seedMatter(firm.id, null, 'Unrelated');
    const otherRoot = await filesRepo.ensureScopeRoot(firm.id, { scope: 'matter', matterId: otherMatter });
    const hidden = await filesRepo.createFile(firm.id, {
      parentId: otherRoot, name: 'plain report.pdf', mimeType: 'application/pdf',
    });
    await filesRepo.finalize(firm.id, hidden.id, { sizeBytes: 1024, mimeType: 'application/pdf' });

    const rows = await filesRepo.search(firm.id, root, 'report');

    // Same name in two matters. The subtree walk is what separates them; there
    // is no prefix string a crafted name could widen.
    expect(rows.map((r: any) => r.id)).not.toContain(hidden.id);
    expect(rows.map((r: any) => r.name)).toEqual(['plain report.pdf']);
  });

  it('finds a match nested several folders down', async () => {
    const a = await filesRepo.createFolder(firm.id, { parentId: root, name: 'Discovery' });
    const b = await filesRepo.createFolder(firm.id, { parentId: a.id, name: 'Depositions' });
    const deep = await filesRepo.createFile(firm.id, {
      parentId: b.id, name: 'buried transcript.pdf', mimeType: 'application/pdf',
    });
    await filesRepo.finalize(firm.id, deep.id, { sizeBytes: 1024, mimeType: 'application/pdf' });

    const rows = await filesRepo.search(firm.id, root, 'transcript');

    // The recursive walk is the point: a search that stopped at one level would
    // report nothing here and read as "no such document".
    expect(rows.map((r: any) => r.id)).toEqual([deep.id]);
  });
});
