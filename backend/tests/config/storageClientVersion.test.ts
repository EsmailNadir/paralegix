/**
 * Every bucket call goes through the storage client that firebase-admin loads.
 *
 * No file in src/ imports `@google-cloud/storage`. `admin.storage().bucket()`
 * reaches it through `firebase-admin/storage`, and firebase-admin lists it only
 * as an OPTIONAL dependency. package.json declares it directly so that the
 * install cannot silently drop it.
 *
 * That declaration only helps when both names resolve to the same copy. When
 * firebase-admin 14.4.0 raised its own range to ^8.1.0 while package.json
 * still said ^7.17.0, npm nested 8.1.0 under firebase-admin. The app then ran
 * on 8.1.0 while package.json and the top-level copy said 7.22.0, and the
 * suite could not notice, because it stubs storage. This fails on that split.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');

function packageRoot(resolvedEntry: string): string {
  let dir = path.dirname(resolvedEntry);
  while (!fs.existsSync(path.join(dir, 'package.json')) || !dir.endsWith(path.join('@google-cloud', 'storage'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`No package root above ${resolvedEntry}`);
    dir = parent;
  }
  return dir;
}

describe('storage client version', () => {
  it('firebase-admin loads the same @google-cloud/storage copy that package.json declares', () => {
    const declared = packageRoot(require.resolve('@google-cloud/storage', { paths: [ROOT] }));
    const loadedByFirebase = packageRoot(
      require.resolve('@google-cloud/storage', { paths: [path.dirname(require.resolve('firebase-admin/storage'))] }),
    );

    expect(loadedByFirebase).toBe(declared);
  });
});
