import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const source = path.resolve(__dirname, '../../document-layout');
let fixture: string;
let layout: string;
let consumer: string;

beforeEach(() => {
  fixture = mkdtempSync(path.join(tmpdir(), 'document-layout-build-'));
  layout = path.join(fixture, 'document-layout');
  consumer = path.join(fixture, 'frontend');
  mkdirSync(layout);
  mkdirSync(consumer);
  for (const file of ['build.mjs', 'tsconfig.json', 'src']) {
    cpSync(path.join(source, file), path.join(layout, file), { recursive: true });
  }
});

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
});

function prepare() {
  return spawnSync(process.execPath, [path.join(layout, 'build.mjs')], {
    env: { ...process.env, INIT_CWD: consumer, PATH: '' },
    encoding: 'utf8',
  });
}

function installCompiler() {
  mkdirSync(path.join(consumer, 'node_modules'));
  symlinkSync(path.dirname(require.resolve('typescript/package.json')), path.join(consumer, 'node_modules/typescript'));
}

it('defers compilation when the consumer compiler is not installed yet', () => {
  const result = prepare();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('deferred');
  expect(existsSync(path.join(layout, 'dist/templateReflow.js'))).toBe(false);
});

it('compiles with the consumer TypeScript even when tsc is absent from PATH', () => {
  installCompiler();
  const result = prepare();
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe('');
  expect(result.status).toBe(0);
  for (const file of ['textFit.js', 'textFit.d.ts', 'textFitRich.js', 'templateReflow.js']) {
    expect(existsSync(path.join(layout, 'dist', file))).toBe(true);
  }
});

it('fails installation when an available compiler reports a source error', () => {
  installCompiler();
  writeFileSync(path.join(layout, 'src/invalid.ts'), 'const invalid: number = "string";');
  const result = prepare();
  expect(result.status).not.toBe(0);
  expect(result.stdout).toContain('TS2322');
});

it('uses the precompiled package without requiring a compiler in runtime installs', () => {
  mkdirSync(path.join(layout, 'dist'));
  writeFileSync(path.join(layout, 'dist/templateReflow.js'), 'module.exports = {};');
  const result = prepare();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe('');
});
