/**
 * `npm test -- <file>` must run that file, not the whole suite.
 *
 * The test scripts end in `--selectProjects unit`, and `--selectProjects` takes a
 * LIST. npm appends the caller's arguments after it, so a bare path became a
 * second project name and Jest quietly selected all 523 spec files. Asking for one
 * spec then ran the full, memory-heavy suite. `--passWithNoTests=false` after the
 * list closes it; this spec fails if a script loses that and a path stops filtering.
 *
 * It runs each script's own command with `--listTests`, which resolves the
 * selection without running anything.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const scripts: Record<string, string> = require(path.join(ROOT, 'package.json')).scripts;
const TARGET = 'tests/config/storageClientVersion.test.ts';

function listed(script: string, extra: string[]): string[] {
  // Every script is `node <flags> node_modules/.bin/jest <args>`; none quotes an argument.
  const [bin, ...args] = scripts[script].split(' ');
  const watchless = args.filter((a) => a !== '--watch');
  const out = execFileSync(bin === 'node' ? process.execPath : bin, [...watchless, ...extra, '--listTests'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out.split('\n').filter((line) => line.endsWith('.test.ts'));
}

describe.each(['test', 'test:unit', 'test:coverage', 'test:watch'])('npm run %s', (script) => {
  it('selects only the spec path passed after --', () => {
    const files = listed(script, [TARGET]);
    expect(files).toEqual([path.join(ROOT, TARGET)]);
  });
});

describe('npm test with no path', () => {
  it('still selects the whole unit project', () => {
    expect(listed('test', []).length).toBeGreaterThan(100);
  });
});
