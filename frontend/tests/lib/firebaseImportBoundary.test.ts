import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const sourceRoot = path.resolve(__dirname, '../../src');
const initializedConfig = path.join(sourceRoot, 'lib/firebase/config');

function filesUnder(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : /\.tsx?$/.test(file) ? [file] : [];
  });
}

function staticConfigImports(file: string, source: string): string[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  function visit(node: ts.Node) {
    const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
      ? node.moduleSpecifier
      : ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require'
        ? node.arguments[0]
        : undefined;
    if (specifier && ts.isStringLiteral(specifier)) {
      const value = specifier.text;
      const resolved = value.startsWith('@/')
        ? path.resolve(sourceRoot, value.slice(2))
        : path.resolve(path.dirname(file), value);
      if (resolved.replace(/\.[cm]?[jt]sx?$/, '') === initializedConfig) imports.push(value);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return imports;
}

it('keeps initialized Firebase config out of static SSR imports', () => {
  const violations = filesUnder(sourceRoot).flatMap((file) =>
    staticConfigImports(file, fs.readFileSync(file, 'utf8')).map((specifier) =>
      `${path.relative(sourceRoot, file)}: ${specifier}`));
  expect(violations).toEqual([]);
});

it('detects relative imports and reexports while allowing call-site dynamic initialization', () => {
  const file = path.join(sourceRoot, 'services/example.ts');
  expect(staticConfigImports(file, "import { auth } from '../lib/firebase/config';")).toEqual(['../lib/firebase/config']);
  expect(staticConfigImports(file, "export { auth } from '@/lib/firebase/config';")).toEqual(['@/lib/firebase/config']);
  expect(staticConfigImports(file, "const { auth } = require('@/lib/firebase/config');")).toEqual(['@/lib/firebase/config']);
  expect(staticConfigImports(file, "async function token() { const { auth } = await import('@/lib/firebase/config'); } import type { User } from 'firebase/auth';")).toEqual([]);
});
