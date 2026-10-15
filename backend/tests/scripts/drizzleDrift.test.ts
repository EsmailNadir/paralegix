import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

jest.mock('node:child_process', () => ({ spawnSync: jest.fn() }));

let workspace: string;
let schema: string;
const originalTarget = process.env.DB_TARGET;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'paralegix-drift-'));
  schema = join(workspace, 'src/shared/database/drizzle/schema.ts');
  mkdirSync(join(workspace, 'src/shared/database/drizzle'), { recursive: true });
  writeFileSync(schema, 'working tree schema\n');
  jest.spyOn(process, 'cwd').mockReturnValue(workspace);
  jest.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit ${code}`); });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  process.env.DB_TARGET = 'local';
});

afterEach(() => {
  jest.restoreAllMocks();
  process.env.DB_TARGET = originalTarget;
  rmSync(workspace, { recursive: true, force: true });
});

it('accepts an unchanged generated working-tree snapshot even when it is uncommitted', () => {
  (spawnSync as jest.Mock).mockImplementation((command) => ({ status: command === 'git' ? 1 : 0 }));
  expect(() => jest.isolateModules(() => { require('../../db/check-drizzle-drift'); })).not.toThrow();
});

it('rejects a regeneration that changes the working-tree snapshot', () => {
  (spawnSync as jest.Mock).mockImplementation(() => {
    writeFileSync(schema, 'different database schema\n');
    return { status: 0 };
  });
  expect(() => jest.isolateModules(() => { require('../../db/check-drizzle-drift'); })).toThrow('exit 1');
});

it('restores the working-tree snapshot and reports the diff after a failing check', () => {
  (spawnSync as jest.Mock).mockImplementation(() => {
    writeFileSync(schema, 'different database schema\n');
    return { status: 0 };
  });
  expect(() => jest.isolateModules(() => { require('../../db/check-drizzle-drift'); })).toThrow('exit 1');
  expect(readFileSync(schema, 'utf8')).toBe('working tree schema\n');
  const reported = (console.error as jest.Mock).mock.calls.map((c) => String(c[0])).join('\n');
  expect(reported).toContain('+ different database schema');
  expect(reported).toContain('- working tree schema');
});

it('restores the snapshot when db:pull itself fails after rewriting the file', () => {
  (spawnSync as jest.Mock).mockImplementation(() => {
    writeFileSync(schema, 'half written\n');
    return { status: 3 };
  });
  expect(() => jest.isolateModules(() => { require('../../db/check-drizzle-drift'); })).toThrow('exit 3');
  expect(readFileSync(schema, 'utf8')).toBe('working tree schema\n');
});
