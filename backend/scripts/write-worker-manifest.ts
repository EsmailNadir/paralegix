/**
 * Writes the package.json the document-worker image installs from.
 *
 * The worker entry point (`src/document-worker.ts`) loads three packages. The API
 * package.json declares about thirty, so installing from it put roughly 294 MB
 * of node_modules into an image that never loads them. This writes a manifest
 * that declares only `WORKER_DEPENDENCIES`, at the same version ranges as the
 * API. `Dockerfile.document-worker` then prunes a copy of the API lockfile to
 * match, so the worker still gets the exact locked versions.
 *
 * `tests/config/documentWorkerImage.test.ts` fails when the worker imports a
 * package this list does not name.
 *
 * Run: `npx tsx scripts/write-worker-manifest.ts <outDir>`
 */
import * as fs from 'fs';
import * as path from 'path';

/** Every package the worker loads at runtime. */
export const WORKER_DEPENDENCIES = ['@paralegix/document-layout', 'libreoffice-convert', 'puppeteer-core'] as const;

interface PackageJson {
  name: string;
  version: string;
  dependencies: Record<string, string | undefined>;
  overrides?: Record<string, string>;
  [field: string]: unknown;
}

export function workerManifest(api: PackageJson) {
  const dependencies: Record<string, string> = {};
  for (const name of WORKER_DEPENDENCIES) {
    const range = api.dependencies[name];
    // A package absent from the API's runtime dependencies has no locked
    // production version to pin, so installing it would resolve a fresh one.
    if (!range) throw new Error(`${name} is not a runtime dependency in package.json`);
    dependencies[name] = range;
  }
  return {
    name: `${api.name}-document-worker`,
    version: api.version,
    private: true,
    dependencies,
    // Kept so the pruned lockfile resolves shared transitive packages the same
    // way the API lockfile does.
    overrides: api.overrides,
  };
}

function main() {
  const outDir = process.argv[2];
  if (!outDir) throw new Error('Usage: tsx scripts/write-worker-manifest.ts <outDir>');

  const api = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, 'package.json');
  fs.writeFileSync(target, `${JSON.stringify(workerManifest(api), null, 2)}\n`);
  console.log(`[build] Wrote document-worker manifest -> ${target}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err: any) {
    console.error('Failed to write the worker manifest:', err.message || err);
    process.exit(1);
  }
}
