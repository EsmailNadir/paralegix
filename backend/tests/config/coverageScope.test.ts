import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

it('reports imported and unimported TypeScript under their original source paths', () => {
  const backend = path.resolve(__dirname, '../..');
  const directory = mkdtempSync(path.join(tmpdir(), 'paralegix-coverage-path-'));
  try {
    execFileSync(process.execPath, [
      path.join(backend, 'node_modules/jest/bin/jest.js'), '--selectProjects', 'unit',
      '--runInBand', '--runTestsByPath', 'tests/shared/searchTerm.test.ts', '--coverage',
      '--collectCoverageFrom=src/shared/{database/searchTerm,utils/positiveIntFromEnv}.ts',
      '--coverageReporters=json-summary', `--coverageDirectory=${directory}`,
    ], { cwd: backend, encoding: 'utf8', stdio: 'pipe' });
    const summary = JSON.parse(readFileSync(path.join(directory, 'coverage-summary.json'), 'utf8'));
    const source = path.join(backend, 'src/shared/database/searchTerm.ts');
    const unimported = path.join(backend, 'src/shared/utils/positiveIntFromEnv.ts');
    expect(Object.keys(summary).filter((key) => key !== 'total').sort()).toEqual([source, unimported].sort());
    expect(summary[unimported].statements.total).toBeGreaterThan(0);
    expect(summary[unimported].statements.covered).toBe(0);
    expect(summary[source].statements.covered).toBeGreaterThan(0);
    const effective = JSON.parse(execFileSync(process.execPath, [
      path.join(backend, 'node_modules/jest/bin/jest.js'), '--showConfig',
    ], { cwd: backend, encoding: 'utf8' }));
    expect(effective.globalConfig.coverageProvider).toBe('v8');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
