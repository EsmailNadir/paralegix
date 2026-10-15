#!/usr/bin/env node
/**
 * Frontend reachability / dead-exports checker.
 *
 * Runs ts-prune to find candidate unused exports, filters out Next.js page/layout/route
 * exports, TypeScript declaration files, and verifies candidate identifiers across the
 * frontend src, tests, and config files to catch JSX/string/dynamic references.
 *
 * Usage:
 *   node scripts/check-dead-exports.mjs
 *   node scripts/check-dead-exports.mjs --list
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '..');
const ROOTS = ['src', 'tests'];
const args = new Set(process.argv.slice(2));

// Next.js convention exports that framework consumers call implicitly
const NEXT_CONVENTION_EXPORTS = new Set([
  'default',
  'metadata',
  'generateMetadata',
  'generateStaticParams',
  'viewport',
  'generateViewport',
  'size',
  'contentType',
  'alt',
  'revalidate',
  'dynamic',
  'dynamicParams',
  'fetchCache',
  'runtime',
  'preferredRegion',
  'maxDuration',
]);

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      out.push(...walk(absolute));
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) {
      out.push(path.relative(FRONTEND_DIR, absolute));
    }
  }
  return out;
}

function candidates() {
  const raw = execFileSync('npx', ['ts-prune', '-p', 'tsconfig.json'], {
    cwd: FRONTEND_DIR,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });

  return raw
    .split('\n')
    .filter((line) => line.trim() && !line.includes('(used in module)'))
    .map((line) => {
      const [location, name] = line.split(' - ');
      return { file: (location || '').split(':')[0], name: (name || '').trim() };
    })
    .filter(({ file, name }) => {
      if (!file || !name) return false;
      if (file.startsWith('.next/')) return false;
      if (file.endsWith('.d.ts')) return false;

      // Next.js App Router route conventions
      if (file.startsWith('src/app/') && NEXT_CONVENTION_EXPORTS.has(name)) {
        return false;
      }
      return true;
    });
}

const files = ROOTS.flatMap((r) => walk(path.join(FRONTEND_DIR, r)));
const identifiers = new Map();

for (const file of files) {
  const body = fs.readFileSync(path.join(FRONTEND_DIR, file), 'utf8');
  identifiers.set(file, new Set(body.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || []));
}

// Allowlisted baseline: exported types/constants intentionally kept for caller ergonomics
const BASELINE_ALLOWLIST = new Set([
  'src/components/ui/FieldLabel.tsx:FIELD_LABEL_DEFAULT_CLS',
  'src/hooks/clientHooks/useClients.ts:useAllClients',
  'src/lib/files/fileScope.ts:FileScopeType',
]);

const dead = candidates().filter(({ file, name }) =>
  !BASELINE_ALLOWLIST.has(`${file}:${name}`) &&
  !files.some((other) => other !== file && identifiers.get(other)?.has(name)),
);

if (args.has('--list') || dead.length > 0) {
  for (const { file, name } of dead) {
    console.log(`${file} - ${name}`);
  }
}

if (dead.length > 0) {
  console.error(`\n[frontend-dead-exports] FAIL: ${dead.length} export(s) have no external reader.`);
  process.exit(1);
}

console.log(`[frontend-dead-exports] OK: 0 exports without a reader (${files.length} files scanned, baseline preserved).`);
