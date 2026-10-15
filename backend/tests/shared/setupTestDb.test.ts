import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The operator script requires Bash; Windows developers run it through Git Bash.
const describeShell = process.platform === 'win32' ? describe.skip : describe;

describeShell('test database container engine selection', () => {
  let directory: string;
  let log: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'paralegix-container-test-'));
    log = path.join(directory, 'calls.jsonl');
    writeFileSync(log, '');
    for (const command of ['dirname', 'seq', 'grep']) {
      symlinkSync(`/usr/bin/${command}`, path.join(directory, command));
    }
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function installEngine(name: string, healthy = true) {
    writeFileSync(path.join(directory, name), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.ENGINE_TEST_LOG, JSON.stringify({ engine: ${JSON.stringify(name)}, args }) + '\\n');
if (args.includes('pg_isready')) process.exit(${healthy ? 0 : 1});
if (args.some(arg => arg.includes('select 1 from pg_database'))) console.log('1');
if (args.some(arg => arg.includes('select count(*)'))) console.log('4242');
`, { mode: 0o755 });
  }

  function run(overrides: NodeJS.ProcessEnv = {}) {
    const result = spawnSync('/bin/bash', [path.resolve(__dirname, '../../scripts/setup-test-db.sh')], {
      encoding: 'utf8',
      env: {
        PATH: directory,
        ENGINE_TEST_LOG: log,
        TEST_DB_COUNT: '1',
        ...overrides,
      },
    });
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as { engine: string; args: string[] });
    return { ...result, calls };
  }

  function expectBuilt(result: ReturnType<typeof run>, engine: string) {
    expect(result.status).toBe(0);
    // 4242 is the stub's answer above, deliberately not a plausible table count:
    // this asserts the script REPORTS what the database told it, not what the
    // schema happens to contain today.
    expect(result.stdout).toContain('paralegix_test_1 ready (4242 tables)');
    expect(new Set(result.calls.map(call => call.engine))).toEqual(new Set([engine]));
    expect(result.calls.filter(call => call.args[0] === 'cp')).toHaveLength(2);
    expect(result.calls).toContainEqual({
      engine,
      args: ['exec', 'paralegix-pg', 'psql', '-U', 'postgres', '-d', 'paralegix_test_1',
        '-v', 'ON_ERROR_STOP=1', '-q', '-f', '/tmp/schema.sql'],
    });
  }

  it('uses Podman for every local copy and database command when both engines exist', () => {
    installEngine('podman');
    installEngine('docker');
    expectBuilt(run(), 'podman');
  });

  it('retains Docker for machines without Podman', () => {
    installEngine('docker');
    expectBuilt(run(), 'docker');
  });

  it('retains Docker in CI even when Podman is installed', () => {
    installEngine('podman');
    installEngine('docker');
    expectBuilt(run({ CI: 'true' }), 'docker');
  });

  it('honors an explicit Docker override locally', () => {
    installEngine('podman');
    installEngine('docker');
    expectBuilt(run({ CONTAINER_ENGINE: 'docker' }), 'docker');
  });

  it('honors an explicit Podman override in CI', () => {
    installEngine('podman');
    installEngine('docker');
    expectBuilt(run({ CI: 'true', CONTAINER_ENGINE: 'podman' }), 'podman');
  });

  it('stops at an unhealthy Podman container without touching Docker or rebuilding schemas', () => {
    installEngine('podman', false);
    installEngine('docker');
    const result = run();
    expect(result.status).toBe(1);
    expect(result.calls).toEqual([{ engine: 'podman', args: ['exec', 'paralegix-pg', 'pg_isready', '-U', 'postgres'] }]);
    expect(result.stderr).toContain('podman start paralegix-pg');
  });
});
