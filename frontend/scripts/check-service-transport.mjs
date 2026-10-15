#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(appRoot, 'src');
const servicesRoot = path.join(sourceRoot, 'services');
const baselinePath = path.join(__dirname, 'firebase-token-baseline.json');

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return /\.(ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  });
}

const allSourceFiles = sourceFiles(sourceRoot);
const serviceFiles = sourceFiles(servicesRoot);
const tokenCalls = allSourceFiles.reduce(
  (count, file) => count + (fs.readFileSync(file, 'utf8').match(/\bgetFirebaseToken\s*\(/g)?.length ?? 0),
  0,
);
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
let failed = false;

if (tokenCalls > baseline.maxCalls) {
  failed = true;
  console.error(
    `Firebase-token surface grew: ${tokenCalls} calls (baseline ${baseline.maxCalls}). `
    + 'Route normal API requests through apiFetch/BaseApiService instead.',
  );
}

for (const file of serviceFiles) {
  const content = fs.readFileSync(file, 'utf8');
  if (/\bfetch\s*\(/.test(content)) {
    failed = true;
    console.error(`Direct fetch is not allowed in services: ${path.relative(appRoot, file)}. Use apiFetch or publicFetch.`);
  }
}

if (failed) process.exit(1);
console.log(`Service transport check passed: ${tokenCalls} Firebase-token calls (baseline ${baseline.maxCalls}).`);
