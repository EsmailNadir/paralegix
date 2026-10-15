/** @jest-environment node */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

// Read the options passed to Next without booting its server configuration.
jest.mock('next/jest', () => () => (config: unknown) => async () => config);

it('counts every source TypeScript file even when no test imports it', async () => {
  const loadConfig = jest.requireActual('../../jest.config.js');
  const config = await loadConfig();
  const micromatch = jest.requireActual('micromatch');
  const files: string[] = [];
  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.tsx?$/.test(file) && !file.endsWith('.d.ts')) files.push(file);
    }
  }
  walk('src');
  expect(files.length).toBeGreaterThan(500);
  const counted = new Set<string>(micromatch(files, config.collectCoverageFrom || []));
  expect(files.filter((file) => !counted.has(file))).toEqual([]);
});

it('uses native coverage so serialized worker functions keep no instrumentation dependencies', async () => {
  const config = await jest.requireActual('../../jest.config.js')();
  expect(config.coverageProvider).toBe('v8');
});
