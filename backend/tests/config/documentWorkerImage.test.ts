/**
 * The document-worker image installs only the packages the worker imports.
 *
 * The worker is one small entry point that loads `libreoffice-convert` and
 * `puppeteer-core` and nothing else, but its image used to run the API's full `npm ci --omit=dev`:
 * Firebase, Stripe, geoip-lite and the rest, about 294 MB of node_modules it
 * never loads. `scripts/write-worker-manifest.ts` now writes a package.json
 * holding `WORKER_DEPENDENCIES` alone, and the image installs from that.
 *
 * The risk that trade creates is a worker that imports a new package and then
 * crashes on its first request, because the image never installed it. Nothing
 * else would notice: the API boot test in cloudbuild.yaml does not start the
 * worker. The first test below is the guard for that.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { builtinModules } from 'module';

const { WORKER_DEPENDENCIES, workerManifest } = require('../../scripts/write-worker-manifest');

const ROOT = path.join(__dirname, '..', '..');
const ENTRY = path.join(ROOT, 'src', 'document-worker.ts');

/** `@scope/name/sub/path` -> `@scope/name`, `name/sub` -> `name`. */
function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function isBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:') || builtinModules.includes(specifier.split('/')[0]);
}

function resolveLocal(fromFile: string, specifier: string): string {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts'), base]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`Cannot resolve ${specifier} from ${fromFile}`);
}

/**
 * Every external package reachable from the worker entry point at runtime.
 *
 * Follows static imports, `require()` and `import()` through local files.
 * Type-only imports are skipped because tsc erases them, so they need no
 * installed package.
 */
function runtimePackages(entry: string): string[] {
  const packages = new Set<string>();
  const visited = new Set<string>();

  const visit = (file: string) => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

    const record = (specifier: string) => {
      if (specifier.startsWith('.')) visit(resolveLocal(file, specifier));
      else if (!isBuiltin(specifier)) packages.add(packageName(specifier));
    };

    const walk = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        const typeOnly = clause?.isTypeOnly
          || (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
            && clause.namedBindings.elements.length > 0
            && clause.namedBindings.elements.every((element) => element.isTypeOnly));
        if (!typeOnly) record(node.moduleSpecifier.text);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        if (!node.isTypeOnly) record(node.moduleSpecifier.text);
      } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        if (isRequire || isDynamicImport) record(node.arguments[0].text);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  };

  visit(entry);
  return [...packages].sort();
}

const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

describe('document-worker image dependencies', () => {
  it('lists exactly the packages the worker imports at runtime', () => {
    const imported = runtimePackages(ENTRY);
    // Proves the walk reached the converter. An empty graph would also match
    // an empty list and prove nothing.
    expect(imported).toContain('libreoffice-convert');
    expect([...WORKER_DEPENDENCIES].sort()).toEqual(imported);
  });

  it('writes a manifest with only the worker packages, at the API versions', () => {
    const manifest = workerManifest(packageJson);

    expect(manifest.dependencies).toEqual(
      Object.fromEntries(WORKER_DEPENDENCIES.map((name: string) => [name, packageJson.dependencies[name]])),
    );
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.scripts).toBeUndefined();
    expect(manifest.overrides).toEqual(packageJson.overrides);
  });

  it('refuses a worker package that the API does not declare as a runtime dependency', () => {
    const withoutConverter = {
      ...packageJson,
      dependencies: { ...packageJson.dependencies, 'libreoffice-convert': undefined },
    };
    expect(() => workerManifest(withoutConverter)).toThrow('libreoffice-convert');
  });

  it('installs the runtime stage from the trimmed manifest, not the API package.json', () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile.document-worker'), 'utf8');
    const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));

    expect(dockerfile).toContain('scripts/write-worker-manifest.ts');
    expect(runtimeStage).toMatch(/COPY --from=build \/app\/worker-manifest\/package\.json/);
    expect(runtimeStage).not.toMatch(/^COPY package\.json/m);
  });

  it.each(['Dockerfile', 'Dockerfile.document-worker'])('%s installs the shared layout from the compiled build artifact', (file) => {
    const dockerfile = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const stages = [dockerfile.slice(0, dockerfile.lastIndexOf('\nFROM ')), dockerfile.slice(dockerfile.lastIndexOf('\nFROM '))];
    expect(stages[0].indexOf('COPY document-layout ./document-layout')).toBeGreaterThan(-1);
    expect(stages[0].indexOf('COPY document-layout ./document-layout')).toBeLessThan(stages[0].indexOf('RUN npm ci'));
    expect(stages[1].indexOf('COPY --from=build /app/document-layout ./document-layout')).toBeGreaterThan(-1);
    expect(stages[1].indexOf('COPY --from=build /app/document-layout ./document-layout')).toBeLessThan(stages[1].indexOf('RUN npm ci'));
  });

  it('starts the worker as the unprivileged node user', () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile.document-worker'), 'utf8');
    const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
    const userLine = runtimeStage.search(/^USER node$/m);

    // Found at all, and after the last root-only step, so the install still
    // runs as root and the process that parses untrusted documents does not.
    expect(userLine).toBeGreaterThan(-1);
    expect(userLine).toBeGreaterThan(runtimeStage.lastIndexOf('RUN '));
    expect(userLine).toBeLessThan(runtimeStage.indexOf('CMD '));
    expect(runtimeStage.slice(userLine)).not.toMatch(/^USER (?!node$)/m);
  });

  it('gives the node user a writable HOME, which LibreOffice needs to convert anything', () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile.document-worker'), 'utf8');
    const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));

    // Measured in the built image: with HOME unwritable, a txt to docx
    // conversion fails with "Fontconfig error: No writable cache directories".
    expect(runtimeStage).toMatch(/^ENV HOME=\/home\/node$/m);
  });

  it('installs Chromium and names it in CHROMIUM_PATH, which PDF export launches', () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile.document-worker'), 'utf8');
    const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
    const pathLine = runtimeStage.match(/^ENV CHROMIUM_PATH=(\S+)$/m);

    // `puppeteer-core` ships no browser. Without the system package the worker
    // boots, answers /health, and fails every export.
    expect(runtimeStage).toMatch(/apt-get install[^\n]*\bchromium\b/);
    expect(pathLine?.[1]).toBe('/usr/bin/chromium');
  });

  it.each(['Dockerfile', 'Dockerfile.document-worker'])(
    '%s does not download the puppeteer dev dependency browser in its build stage',
    (file) => {
      const dockerfile = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const buildStage = dockerfile.slice(0, dockerfile.lastIndexOf('\nFROM '));
      const skip = buildStage.search(/^ENV PUPPETEER_SKIP_DOWNLOAD=true$/m);

      // The build stage installs dev dependencies to compile, and `puppeteer`
      // would fetch a Chrome there on every deploy that nothing ever runs: the
      // worker drives the system Chromium and the API image has no browser.
      expect(skip).toBeGreaterThan(-1);
      expect(skip).toBeLessThan(buildStage.search(/^RUN npm ci/m));
    },
  );

  it('Cloud Build installs dependencies for its checks without downloading that browser either', () => {
    // Step 1 of cloudbuild.yaml runs `npm ci --include=dev` outside Docker, so
    // the Dockerfiles' own setting does not reach it. Nothing in the build runs
    // a browser: the typecheck, lint and guard steps never launch one.
    const cloudbuild = fs.readFileSync(path.join(ROOT, 'cloudbuild.yaml'), 'utf8');
    const install = cloudbuild.slice(0, cloudbuild.indexOf('\n  - name:', cloudbuild.indexOf("args: ['ci', '--include=dev']")));

    expect(install).toContain("args: ['ci', '--include=dev']");
    expect(install).toMatch(/env: \['PUPPETEER_SKIP_DOWNLOAD=true'\]/);
  });
});

