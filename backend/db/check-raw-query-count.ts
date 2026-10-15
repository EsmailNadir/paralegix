/**
 * Ratchet for direct calls to node-postgres' `.query()` API in backend/src.
 *
 * Receiver names are deliberately irrelevant. The tree uses `pool`, `client`,
 * `executor`, `db`, `conn`, and `dbClient`, and a name-based grep misses calls
 * as soon as a callback parameter is renamed. Parsing call expressions also
 * avoids counting comments and documentation examples.
 *
 * Usage:
 *   npx tsx db/check-raw-query-count.ts
 *   npx tsx db/check-raw-query-count.ts --list
 *   npx tsx db/check-raw-query-count.ts --json
 *   npx tsx db/check-raw-query-count.ts --write-inventory
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

type QueryOperation = 'read' | 'insert' | 'update' | 'delete' | 'transaction' | 'other';
type QueryScope =
  | 'direct_tenant'
  | 'privileged_admin'
  | 'public_token'
  | 'infrastructure'
  | 'review_required';

interface RawQuerySite {
  file: string;
  line: number;
  column: number;
  receiver: string;
  operation: QueryOperation;
  scope: QueryScope;
  shapes: string[];
  sqlPreview: string | null;
}

const BACKEND_DIR = path.join(__dirname, '..');
const SRC_DIR = path.join(BACKEND_DIR, 'src');
const BASELINE_FILE = path.join(__dirname, 'raw-query-baseline.json');
const INVENTORY_FILE = path.join(__dirname, 'raw-query-inventory.json');
const args = new Set(process.argv.slice(2));

function walkTypeScript(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTypeScript(absolute));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(absolute);
    }
  }
  return files.sort();
}

function staticSql(
  node: ts.Expression,
  source: ts.SourceFile,
  initializers: Map<string, ts.Expression>,
  seen = new Set<string>(),
): string | null {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => `?${span.literal.text}`)].join('');
  }
  if (ts.isIdentifier(node) && !seen.has(node.text)) {
    const initializer = initializers.get(node.text);
    if (initializer) {
      const nextSeen = new Set(seen).add(node.text);
      return staticSql(initializer, source, initializers, nextSeen);
    }
  }
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (
        ts.isPropertyAssignment(property)
        && ((ts.isIdentifier(property.name) && property.name.text === 'text')
          || (ts.isStringLiteral(property.name) && property.name.text === 'text'))
      ) {
        return staticSql(property.initializer, source, initializers, seen);
      }
    }
  }
  if (ts.isTaggedTemplateExpression(node)) {
    return staticSql(node.template, source, initializers, seen);
  }
  return null;
}

function classifyOperation(sql: string | null): QueryOperation {
  if (!sql) return 'other';
  const normalized = sql.replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*/g, '').trim().toLowerCase();
  if (/^(begin|commit|rollback|savepoint|release\s+savepoint|set\s+local)\b/.test(normalized)) return 'transaction';
  if (/^(select|with|values|explain)\b/.test(normalized)) return 'read';
  if (/^insert\b/.test(normalized)) return 'insert';
  if (/^update\b/.test(normalized)) return 'update';
  if (/^delete\b/.test(normalized)) return 'delete';
  return 'other';
}

function classifyShapes(sql: string | null): string[] {
  if (!sql) return ['dynamic'];
  const lower = sql.toLowerCase();
  const shapes: string[] = [];
  if (/\bjoin\b/.test(lower)) shapes.push('join');
  if (/^\s*with\b/.test(lower)) shapes.push('cte');
  if (/\bunion(?:\s+all)?\b|\bintersect\b|\bexcept\b/.test(lower)) shapes.push('set_operation');
  if (/\b(count|sum|avg|min|max)\s*\(/.test(lower)) shapes.push('aggregate');
  if (/\bfor\s+(update|share)\b/.test(lower)) shapes.push('row_lock');
  if (/\bpg_(?:try_)?advisory_(?:xact_)?(?:lock|unlock)\b/.test(lower)) shapes.push('advisory_lock');
  if (/\b(limit|offset)\b/.test(lower)) shapes.push('pagination');
  return shapes.length ? shapes : ['simple'];
}

function classifyScope(relativeFile: string, sql: string | null): QueryScope {
  const normalizedPath = relativeFile.replaceAll(path.sep, '/');
  const lower = (sql || '').toLowerCase();
  if (normalizedPath === 'src/app.ts' || normalizedPath.startsWith('src/shared/database/')) {
    return 'infrastructure';
  }
  if (normalizedPath.startsWith('src/modules/admin/')) return 'privileged_admin';
  if (
    (normalizedPath.startsWith('src/modules/share/') || normalizedPath.startsWith('src/modules/signatures/'))
    && /\b(token|share_token|session_token)\b/.test(lower)
  ) {
    return 'public_token';
  }
  if (/\blaw_firm_id\b/.test(lower)) return 'direct_tenant';
  return 'review_required';
}

function collectSites(): RawQuerySite[] {
  const sites: RawQuerySite[] = [];
  for (const absolute of walkTypeScript(SRC_DIR)) {
    const text = fs.readFileSync(absolute, 'utf8');
    const source = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const relativeFile = path.relative(BACKEND_DIR, absolute);
    const initializers = new Map<string, ts.Expression>();

    function collectInitializers(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        initializers.set(node.name.text, node.initializer);
      }
      ts.forEachChild(node, collectInitializers);
    }
    collectInitializers(source);

    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'query'
      ) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        const sql = node.arguments[0] ? staticSql(node.arguments[0], source, initializers) : null;
        sites.push({
          file: relativeFile,
          line: position.line + 1,
          column: position.character + 1,
          receiver: node.expression.expression.getText(source),
          operation: classifyOperation(sql),
          scope: classifyScope(relativeFile, sql),
          shapes: classifyShapes(sql),
          sqlPreview: sql ? sql.replace(/\s+/g, ' ').trim().slice(0, 180) : null,
        });
      }
      ts.forEachChild(node, visit);
    }

    visit(source);
  }
  return sites;
}

const sites = collectSites();

if (args.has('--write-inventory')) {
  fs.writeFileSync(INVENTORY_FILE, `${JSON.stringify({ count: sites.length, sites }, null, 2)}\n`);
  console.log(`[raw-query-inventory] wrote ${sites.length} sites to ${path.relative(BACKEND_DIR, INVENTORY_FILE)}.`);
}

if (args.has('--json')) {
  process.stdout.write(`${JSON.stringify({ count: sites.length, sites }, null, 2)}\n`);
  process.exit(0);
}

if (args.has('--list')) {
  for (const site of sites) {
    console.log(
      `${site.file}:${site.line}:${site.column} ${site.receiver}.query `
      + `[${site.operation}/${site.scope}/${site.shapes.join(',')}]`,
    );
  }
}

if (!fs.existsSync(BASELINE_FILE)) {
  console.error(`[raw-query-ratchet] Missing baseline: ${path.relative(BACKEND_DIR, BASELINE_FILE)}`);
  process.exit(1);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).count;
if (!Number.isInteger(baseline) || baseline < 0) {
  console.error('[raw-query-ratchet] Baseline count must be a non-negative integer.');
  process.exit(1);
}

if (sites.length > baseline) {
  console.error(`[raw-query-ratchet] FAIL: ${sites.length} raw query calls; baseline is ${baseline}.`);
  for (const site of sites) console.error(`  ${site.file}:${site.line}:${site.column} ${site.receiver}.query`);
  process.exit(1);
}

if (sites.length < baseline) {
  console.log(
    `[raw-query-ratchet] ${sites.length} raw query calls; baseline is ${baseline}. `
    + 'Lower db/raw-query-baseline.json to lock in the migration.',
  );
} else {
  console.log(`[raw-query-ratchet] OK: ${sites.length} raw query calls, at baseline.`);
}
