/**
 * Post-processes the output of `drizzle-kit pull`.
 *
 * Introspection gets most of this right, but not all of it, and the parts it gets
 * wrong are silent. This script runs as part of `npm run db:pull` so the fixes
 * are reproducible: hand-editing a generated file would be undone by the next
 * pull, and would make `npm run db:drift` fail forever.
 *
 * Everything it changes is listed on stdout. If a future drizzle-kit fixes one of
 * these upstream, the corresponding count drops to 0 and that rule can go.
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'src', 'shared', 'database', 'drizzle');
const SCHEMA = path.join(DIR, 'schema.ts');

/**
 * 1. Empty-string column defaults.
 *
 * A column declared `default ''::text` in Postgres comes back from drizzle-kit as
 * `.default(')` -- it drops one quote and leaves an unterminated string literal,
 * so the generated file does not parse at all. Rewrite to an explicit empty string.
 */
function fixEmptyStringDefaults(src: any) {
  const before = (src.match(/\.default\('\)/g) || []).length;
  return [src.replace(/\.default\('\)/g, '.default("")'), before];
}

/**
 * 1b. Function-call column defaults.
 *
 * A column declared `default gen_random_uuid()::text` comes back from drizzle-kit
 * as `.default((gen_random_uuid()))`: the SQL is emitted as a bare TypeScript
 * expression, so `tsc` reports "Cannot find name 'gen_random_uuid'" and the file
 * does not compile. Wrap it in `sql` so it stays the SQL expression it is.
 *
 * Matches a parenthesised call with no quotes or backticks inside, which is what
 * a defaulted function looks like and what a legitimate `.default("literal")`
 * never does.
 */
function fixFunctionDefaults(src: any) {
  const re = /\.default\(\((\w+\([^()'"`]*\)[^()'"`]*)\)\)/g;
  const before = (src.match(re) || []).length;
  return [src.replace(re, (_m: string, expression: string) => `.default(sql\`${expression}\`)`), before];
}

/**
 * 2. `timestamptz` must come back as a Date, not a string.
 *
 * drizzle-kit emits `mode: 'string'` for every timestamptz. The rest of this
 * application reads timestamptz through node-pg, which returns a JS `Date`, and
 * the output-shaping helpers (`SqlRepository.toEntity`, the per-module `toIso`)
 * all branch on `value instanceof Date`. Leaving Drizzle on `mode: 'string'` would
 * mean a repository half-converted to Drizzle emits a different shape than one
 * that is not -- the exact silent inconsistency this file exists to prevent.
 *
 * Day-only `date` columns are deliberately NOT touched: drizzle's `date()` defaults
 * to string mode, which already matches the oid 1082 parser in db.js.
 */
function fixTimestampMode(src: any) {
  const re = /timestamp\((.*?)\{ withTimezone: true, mode: 'string' \}\)/g;
  const before = (src.match(re) || []).length;
  return [src.replace(re, "timestamp($1{ withTimezone: true, mode: 'date' })"), before];
}

/**
 * 3. Types drizzle-kit cannot parse become `unknown("col")`, which is not even
 *    valid TypeScript -- `unknown` is a type, not a value, so the file fails to
 *    compile with TS2693.
 *
 *    Two Postgres types hit this here: `citext` (15 email columns) and `tsvector`
 *    (court_catalog.search). Both are declared as drizzle `customType`s so the
 *    column keeps its real database type and reads back as a string.
 *
 *    citext matters beyond compilation: it is case-insensitive, which is why
 *    email equality works in SQL without lower() on either side.
 */
const CUSTOM_TYPES = `
/**
 * Postgres types drizzle-kit's introspection cannot map. Declared here so the
 * generated columns below have a real type instead of the invalid \`unknown(...)\`
 * it emits. Injected by db/normalize-drizzle-schema.ts after every pull.
 */
const citext = customType<{ data: string }>({ dataType: () => 'citext' });
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });
`;

function fixUnknownTypes(src: any) {
  const before = (src.match(/\bunknown\("/g) || []).length;
  // court_catalog.search is the only tsvector; every other unmapped column is citext.
  let out = src.replace(/\bunknown\("search"\)/g, 'tsvector("search")');
  out = out.replace(/\bunknown\("/g, 'citext("');
  // `customType` is not in the generated import list until something uses it.
  if (!out.includes('import { customType } from "drizzle-orm/pg-core"')) {
    out = out.replace(
      /^(import \{ pgTable)/m,
      'import { customType } from "drizzle-orm/pg-core"\n$1'
    );
  }
  // Inject the declarations after the import block.
  if (!out.includes('const citext = customType')) {
    out = out.replace(/^(import \{ sql \} from "drizzle-orm"\n)/m, `$1${CUSTOM_TYPES}`);
  }
  return [out, before];
}

/**
 * drizzle-kit does not promise stable ordering for generated imports or table
 * callback entries. Keep both deterministic so a schema pull cannot report a
 * false drift merely because PostgreSQL returned objects in a different order.
 */
function sortGeneratedImports(src: any) {
  return src.replace(
    /^import \{ ([^\n]+) \} from "drizzle-orm\/pg-core"$/gm,
    (_line: string, specifiers: string) => {
      const sorted = specifiers.split(',').map((part: string) => part.trim()).sort((a: string, b: string) => a.localeCompare(b));
      return `import { ${sorted.join(', ')} } from "drizzle-orm/pg-core"`;
    }
  );
}

function sortCallbackEntries(src: any) {
  const lines = src.split('\n');
  const output: string[] = [];
  let inCallback = false;
  let entries: string[][] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length > 0) entries.push(current);
    current = [];
  };

  for (const line of lines) {
    if (!inCallback && /^\}, \(table\) => \[$/.test(line)) {
      inCallback = true;
      output.push(line);
      continue;
    }
    if (inCallback && /^\]\);$/.test(line)) {
      flush();
      entries.sort((a, b) => {
        const key = (entry: string[]) => {
          const text = entry.join('\n');
          const match = text.match(/^(?:\t(?:index|check|unique|primaryKey)\("([^"]+)"|name: "([^"]+)")/m);
          return match?.[1] ?? match?.[2] ?? text;
        };
        return key(a).localeCompare(key(b));
      });
      output.push(...entries.flat(), line);
      entries = [];
      inCallback = false;
      continue;
    }
    if (inCallback && /^\t[a-zA-Z]+\(/.test(line)) {
      flush();
      current.push(line);
      continue;
    }
    if (inCallback) current.push(line);
    else output.push(line);
  }

  flush();
  return output.join('\n');
}

/**
 * 4. Break the invoices <-> billing_plan_periods type cycle.
 *
 * `invoices` declares an FK to `billing_plan_periods` and `billing_plan_periods`
 * declares one back to `invoices`, so TypeScript cannot infer either table's type
 * and reports TS7022/TS7024 on both. Dropping ONE direction breaks the cycle and
 * leaves both tables fully inferred.
 *
 * This removes drizzle METADATA only. The real foreign key lives in the database
 * (invoices_plan_period_fk, created by a numbered migration) and is untouched:
 * Drizzle is a query builder here and never generates or applies DDL, so nothing
 * reads this block. The reverse direction is kept, so the relationship is still
 * described in the file.
 */
function breakInvoicePeriodCycle(src: any) {
  const block = /\tforeignKey\(\{\n\t+columns: \[table\.billingPlanPeriodId\],\n\t+foreignColumns: \[billingPlanPeriods\.id\],\n\t+name: "invoices_plan_period_fk"\n\t+\}\)\.onDelete\("set null"\),\n/;
  const found = block.test(src);
  return [src.replace(block, ''), found ? 1 : 0];
}

/**
 * 5. Emit the tables in a stable order.
 *
 * drizzle-kit does not guarantee one. Two pulls against the same database can
 * order the table declarations differently, which produces a large diff of pure
 * movement and makes `npm run db:drift` cry wolf -- and a drift check that
 * reports false positives is one people stop reading.
 *
 * Sorting by table name makes the file a function of the schema alone. It is
 * also simply easier to find a table in.
 *
 * Safe with respect to declaration order: every cross-table reference lives
 * inside the `(table) => [...]` callback, which Drizzle calls lazily, so a table
 * may reference one declared later in the file.
 */
function sortTableBlocks(src: any) {
  // A block runs from `export const x = pgTable(` to the line that closes it:
  // `]);` when the table has the index/constraint callback, `});` when it does not.
  const re = /^export const (\w+) = pgTable\([\s\S]*?^(?:\]\);|\}\);)$/gm;
  const blocks: Array<{ name: string; text: string }> = [];
  let match;
  while ((match = re.exec(src)) !== null) {
    blocks.push({ name: match[1], text: match[0] });
  }
  if (blocks.length === 0) return [src, 0];

  const firstStart = src.indexOf(blocks[0].text);
  const last = blocks[blocks.length - 1];
  const lastEnd = src.indexOf(last.text) + last.text.length;

  const header = src.slice(0, firstStart);
  const footer = src.slice(lastEnd);

  const sorted = [...blocks].sort((a, b) => a.name.localeCompare(b.name));
  const moved = sorted.some((b, i) => b.name !== blocks[i].name);

  return [header + sorted.map((b) => b.text).join('\n\n') + footer, moved ? blocks.length : 0];
}

/**
 * 6. Drop the index operator-class labels.
 *
 * drizzle-kit annotates every index column with an opclass, as
 * `.op("uuid_ops")`. Two problems, and each on its own is disqualifying.
 *
 * They are WRONG. The labels are assigned to an index's columns in an order
 * that does not match the order the columns are emitted in, so a `date` column
 * is routinely tagged `uuid_ops` and a `timestamptz` one `text_ops`.
 *
 * They are NOT STABLE. Two databases built from db/schema.sql in the same
 * `scripts/setup-test-db.sh` run produce different labels for the same index,
 * which made `npm run db:drift` fail against half the test databases and pass
 * against the other half -- a guard nobody can act on.
 *
 * Nothing reads them. An opclass only matters to `drizzle-kit generate`, which
 * this repository deliberately never runs; index DDL comes from db/schema.sql
 * and the numbered migrations. Removing them leaves a valid index() call and
 * makes the file a function of the schema rather than of the database's build
 * history.
 */
function stripIndexOpclasses(src: any) {
  const re = /\.op\("[a-z0-9_]+"\)/g;
  const before = (src.match(re) || []).length;
  return [src.replace(re, ''), before];
}

/**
 * 7. Emit each table's COLUMNS in a stable order, for the reason rule 5 sorts
 *    the table blocks.
 *
 * drizzle-kit lists columns in physical order, which records how a database was
 * BUILT rather than what it holds. A database built by replaying the numbered
 * migrations has every added column appended at the end; one built in a single
 * pass from db/schema.sql has the same columns inline where they are declared.
 * The two are the same schema and introspect to different files.
 *
 * That made `db:drift` unusable in exactly the workflow it exists for: apply a
 * migration locally, and every later run reports the new column as moved. CI
 * points the guard at a schema.sql-built database and a developer points it at
 * a migrated one, so the two could not both be green.
 *
 * Sorting by property name removes the build history from the output. Column
 * order carries no meaning to Drizzle, which keys the object by name.
 */
function sortColumnEntries(src: any) {
  const lines = src.split('\n');
  const output: string[] = [];
  let entries: string[][] = [];
  let current: string[] = [];
  let inColumns = false;
  let sorted = 0;

  const flush = () => {
    if (current.length) entries.push(current);
    current = [];
  };

  const key = (entry: string[]) => entry[entry.length - 1].match(/^\t(\w+):/)?.[1] ?? '';

  for (const line of lines) {
    if (/^export const \w+ = pgTable\(/.test(line)) {
      inColumns = true;
      output.push(line);
      continue;
    }
    // The first argument closes either into the index callback or into nothing.
    if (inColumns && /^\}(?:, \(table\) => \[|\);)$/.test(line)) {
      flush();
      const before = entries.map(key).join(' ');
      entries.sort((a, b) => key(a).localeCompare(key(b)));
      if (entries.map(key).join(' ') !== before) sorted += 1;
      output.push(...entries.flat(), line);
      entries = [];
      inColumns = false;
      continue;
    }
    // A new column starts here; anything above it (a drizzle-kit comment) belongs to it.
    if (inColumns && /^\t\w+:/.test(line)) {
      flush();
      current.push(line);
      continue;
    }
    if (inColumns) current.push(line);
    else output.push(line);
  }

  flush();
  return [output.join('\n'), sorted];
}

let src = fs.readFileSync(SCHEMA, 'utf8');
const [afterDefaults, defaultCount] = fixEmptyStringDefaults(src);
const [afterFunctionDefaults, functionDefaultCount] = fixFunctionDefaults(afterDefaults);
const [afterTimestamps, timestampCount] = fixTimestampMode(afterFunctionDefaults);
const [afterUnknown, unknownCount] = fixUnknownTypes(afterTimestamps);
const [afterCycle, cycleCount] = breakInvoicePeriodCycle(afterUnknown);
const [afterOpclass, opclassCount] = stripIndexOpclasses(afterCycle);
const [afterColumns, columnCount] = sortColumnEntries(afterOpclass);
const [afterSort, sortedCount] = sortTableBlocks(afterColumns);
src = sortGeneratedImports(sortCallbackEntries(afterSort));
fs.writeFileSync(SCHEMA, src);

/**
 * 5. Delete relations.ts.
 *
 * It describes Drizzle's relational-query graph, which this codebase does not
 * use -- Phase C is query builder only, and relational queries are explicitly out
 * of scope. It also does not compile: the generator emits duplicate keys for
 * tables joined to the same table twice (TS1117). Regenerate it deliberately if
 * relational queries are ever adopted.
 */
const RELATIONS = path.join(DIR, 'relations.ts');
const hadRelations = fs.existsSync(RELATIONS);
if (hadRelations) fs.rmSync(RELATIONS);

/**
 * 3. Drop the generated SQL migration and its metadata.
 *
 * `drizzle-kit pull` always writes a 0000_*.sql snapshot plus a meta/ directory.
 * Neither is ever applied: db/schema.sql and the numbered files in db/migrations
 * are the source of truth, and Drizzle is a query builder here, not the schema
 * owner. Keeping a stray .sql that looks like a migration next to real ones is a
 * trap, so it is removed rather than gitignored.
 */
let removed = 0;
for (const entry of fs.readdirSync(DIR)) {
  const full = path.join(DIR, entry);
  if (entry.endsWith('.sql') || entry === 'meta') {
    fs.rmSync(full, { recursive: true, force: true });
    removed += 1;
  }
}

console.log(`[drizzle-normalize] empty-string defaults fixed: ${defaultCount}`);
console.log(`[drizzle-normalize] function defaults wrapped in sql: ${functionDefaultCount}`);
console.log(`[drizzle-normalize] timestamptz set to mode 'date': ${timestampCount}`);
console.log(`[drizzle-normalize] unmapped types given a customType: ${unknownCount}`);
console.log(`[drizzle-normalize] invoices<->periods FK cycle broken: ${cycleCount}`);
console.log(`[drizzle-normalize] index opclass labels stripped: ${opclassCount}`);
console.log(`[drizzle-normalize] tables whose columns were reordered: ${columnCount}`);
console.log(`[drizzle-normalize] table blocks reordered into name order: ${sortedCount}`);
console.log(`[drizzle-normalize] relations.ts removed: ${hadRelations}`);
console.log(`[drizzle-normalize] generated migration artifacts removed: ${removed}`);

// Marks this file a module rather than a script. Without it every
// top-level const here would share one global scope with the other
// tools and collide on names like `args` and `main`.
export {};
