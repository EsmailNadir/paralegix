import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Runtime images copy the already compiled package from their build stage.
// Install hooks can run before the consumer's compiler is installed. Both app
// build commands compile this package after dependency installation finishes.
if (!existsSync(new URL('./dist/templateReflow.js', import.meta.url))) {
  const require = createRequire(import.meta.url);
  let compiler;
  try {
    compiler = require.resolve('typescript/bin/tsc', {
      paths: [process.env.INIT_CWD || fileURLToPath(new URL('.', import.meta.url))],
    });
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    console.log('Document-layout compilation deferred until the consuming app build installs TypeScript.');
    process.exit(0);
  }
  const result = spawnSync(process.execPath, [compiler, '-p', fileURLToPath(new URL('./tsconfig.json', import.meta.url))], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
