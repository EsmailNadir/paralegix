/**
 * There is one repository base class, and the legacy one cannot come back.
 *
 * `SqlRepository` was constructed with a snake_case table NAME and guessed the
 * column mapping from the entity keys. `DrizzleRepository` takes the table
 * object, so the mapping, the jsonb handling and the tenant predicate all come
 * from the schema. Three files still extended the old one; they do not now, and
 * the file is deleted.
 *
 * WHAT MAKES THIS GO RED: reintroducing the file, or a class that extends it.
 * A grep is the right shape here because the failure is textual: the old class
 * was reached by name from a `require`, so nothing would fail to compile if a
 * copy of it reappeared under the same name somewhere else.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const BACKEND_ROOT = path.join(__dirname, '..', '..');

/** Every match of `pattern` under `src/`, or an empty list. `grep` exits 1 on none. */
function grepSrc(pattern: string): string[] {
  try {
    return execFileSync('grep', ['-rn', '--include=*.ts', pattern, 'src'], {
      cwd: BACKEND_ROOT, encoding: 'utf8',
    }).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

describe('the repository base class', () => {
  it('has no SqlRepository module left to extend', () => {
    expect(fs.existsSync(path.join(BACKEND_ROOT, 'src/shared/database/SqlRepository.ts'))).toBe(false);
  });

  it('is extended by nothing but DrizzleRepository', () => {
    // Comments naming the old class are fine and several explain a migration.
    // What must not exist is a class declaration extending it.
    expect(grepSrc('extends SqlRepository')).toEqual([]);
  });

  it('is what the repositories that used to extend the old one now extend', () => {
    const migrated = [
      'src/modules/clients/clients.repository.ts',
      'src/modules/trust/trust.repository.ts',
      'src/modules/matters/deadlineSets/deadlineSets.repository.ts',
    ];
    for (const file of migrated) {
      const source = fs.readFileSync(path.join(BACKEND_ROOT, file), 'utf8');
      expect(source).toContain('extends DrizzleRepository');
    }
  });
});
