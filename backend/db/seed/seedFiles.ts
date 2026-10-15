/**
 * Shared file seeding for the demo seed scripts.
 *
 * `seed-matter-details.ts` and `seed-matter-files.ts` both fill a matter's Files
 * tab with the same folder tree and the same PDF bytes. They had a copy each,
 * and both copies broke together when the files model moved from object-path
 * upserts to a real parent/child tree. This is the one implementation.
 *
 * Everything is written through `files.repository`, exactly as the upload and
 * create-folder routes write it:
 *   - `ensureScopeRoot` resolves the matter's root folder
 *   - `createFolder` / `createFile` insert the rows
 *   - the GCS object goes to the `object_path` the repository generated, which
 *     is `lawfirmids/<firm>/objects/<file uuid>` and is NOT human readable
 *   - `finalize` stamps the row with the size storage actually reports, which
 *     is what makes the file visible to every listing
 *
 * Idempotent. A re-run deletes the folders this seeder owns by name, along with
 * their contents and their GCS objects, then rebuilds them. Files a person
 * uploaded into the same matter under a different folder are left alone.
 */

const fs = require('fs');
const path = require('path');

/**
 * Read the demo PDFs once and map them to the keys a file plan asks for.
 *
 * The directory is gitignored, so it holds whatever PDFs the developer dropped
 * in. A plan asking for a name that is not there falls back to whatever is,
 * which keeps the seeder working on a machine with only one fixture.
 */
function loadFixtures(fixtureDir: string, preferredByKey: Record<string, string>) {
  if (!fs.existsSync(fixtureDir)) {
    throw new Error(`No fixtures directory at ${fixtureDir}. Create it and drop a few PDFs in.`);
  }
  const present = fs.readdirSync(fixtureDir)
    .filter((f: string) => f.toLowerCase().endsWith('.pdf'))
    .sort();
  if (present.length === 0) throw new Error(`No PDFs in ${fixtureDir}. Drop a few in and re-run.`);

  const cache = new Map<string, Buffer>();
  const read = (name: string): Buffer => {
    if (!cache.has(name)) cache.set(name, fs.readFileSync(path.join(fixtureDir, name)));
    return cache.get(name) as Buffer;
  };
  const resolved: Record<string, Buffer> = {};
  let cursor = 0;
  for (const [key, preferred] of Object.entries(preferredByKey)) {
    resolved[key] = read(present.includes(preferred) ? preferred : present[cursor++ % present.length]);
  }
  return resolved;
}

/**
 * Remove what a previous run of this seeder left in one matter's tree.
 *
 * Scoped by name to the folders the seeder owns, plus the root-level documents
 * its plan names. `files.parent_id` cascades on delete, so removing a top-level
 * folder takes its whole subtree with it; the recursive walk runs first only to
 * collect the GCS object paths, which no cascade can reach.
 */
async function clearPreviousRun({ bucket, query, lawFirmId, rootId, ownedNames }: any) {
  const { rows } = await query(
    `with recursive owned as (
       select id, kind, object_path, size_bytes, 0 as depth
         from files
        where law_firm_id = $1 and parent_id = $2 and lower(name) = any($3::text[])
       union all
       select c.id, c.kind, c.object_path, c.size_bytes, o.depth + 1
         from files c join owned o on c.parent_id = o.id
        where c.law_firm_id = $1
     )
     select id, kind, object_path, size_bytes, depth from owned`,
    [lawFirmId, rootId, ownedNames]
  );
  if (!rows.length) return 0;

  let removedBytes = 0;
  for (const row of rows) {
    if (row.kind !== 'file' || !row.object_path) continue;
    removedBytes += Number(row.size_bytes || 0);
    await bucket.file(row.object_path).delete({ ignoreNotFound: true });
  }
  const topIds = rows.filter((r: any) => r.depth === 0).map((r: any) => r.id);
  await query('delete from files where law_firm_id = $1 and id = any($2::uuid[])', [lawFirmId, topIds]);
  return removedBytes;
}

/**
 * Write one matter's folder tree and its PDFs.
 *
 * `folders` is `[{ path, color, visible }]`, where `path` may nest with `/`.
 * `plan` is `[{ folder, name, fixture, visible }]`, where `folder` matches a
 * folder `path` and an empty one puts the document at the root of the tree.
 *
 * Returns the byte delta so the caller can keep the firm's storage counter
 * honest across re-runs.
 */
async function seedMatterFiles({
  bucket, filesRepo, query, lawFirmId, matterId, actor, folders, plan, fixtures, seedMark,
}: any) {
  const rootId = await filesRepo.ensureScopeRoot(lawFirmId, { scope: 'matter', matterId });

  // Only the FIRST segment of each folder path is named here: parent_id cascades
  // on delete, so removing a top-level folder takes its nested folders with it.
  const ownedNames = [
    ...new Set([
      ...folders.map((f: any) => String(f.path).split('/')[0].toLowerCase()),
      ...plan.filter((f: any) => !f.folder).map((f: any) => String(f.name).toLowerCase()),
    ]),
  ];
  const removedBytes = await clearPreviousRun({ bucket, query, lawFirmId, rootId, ownedNames });

  // A folder path may nest ("Discovery/Dashcam and CAD"). Each segment is walked
  // in turn so an intermediate level is created once and reused, and the colour
  // and the share land on the leaf the plan actually named.
  const folderIds = new Map<string, string>([['', rootId]]);
  for (const folder of folders) {
    const segments = String(folder.path).split('/').filter(Boolean);
    let parentId = rootId;
    let walked = '';
    for (const [n, segment] of segments.entries()) {
      walked = walked ? `${walked}/${segment}` : segment;
      const isLeaf = n === segments.length - 1;
      let folderId = folderIds.get(walked);
      if (!folderId) {
        const row = await filesRepo.createFolder(lawFirmId, {
          parentId,
          name: segment,
          createdBy: actor,
          folderColor: isLeaf ? folder.color || null : null,
        });
        folderId = row.id as string;
        folderIds.set(walked, folderId);
      }
      // A shared folder shares everything under it, so this one call is what
      // puts the whole folder in front of the client portal.
      if (isLeaf && folder.visible) {
        await filesRepo.setVisibility(lawFirmId, folderId, { visible: true });
      }
      parentId = folderId;
    }
  }

  let addedBytes = 0;
  for (const file of plan) {
    const buffer = fixtures[file.fixture] || Object.values(fixtures)[0];
    const row = await filesRepo.createFile(lawFirmId, {
      parentId: folderIds.get(file.folder || '') || rootId,
      name: file.name,
      mimeType: 'application/pdf',
      uploadedBy: actor,
      sizeBytes: buffer.length,
      clientVisible: !!file.visible,
    });
    // The object path belongs to the row, so the upload has to follow the insert
    // rather than the other way round.
    await bucket.file(row.objectPath).save(buffer, {
      resumable: false,
      metadata: {
        contentType: 'application/pdf',
        metadata: { uploadedBy: actor, lawFirmId, matterId, seedSource: seedMark },
      },
    });
    await filesRepo.finalize(lawFirmId, row.id, {
      sizeBytes: buffer.length,
      mimeType: 'application/pdf',
    });
    addedBytes += buffer.length;
  }

  return { addedBytes, removedBytes };
}

module.exports = { loadFixtures, seedMatterFiles };

// Marks this file a module rather than a script. Without it every
// top-level const here would share one global scope with the other
// tools and collide on names like `args` and `main`.
export {};
