/**
 * Fails if a foreign key to users(id) can silently lose data when an account is
 * deleted, without the unverified-account sweep guarding against it.
 *
 * The sweep in `src/modules/users/unverifiedAccounts.service.ts` is the only code
 * path that deletes a live account with no human asking. It is safe because of a
 * split: of the ~86 foreign keys to users(id), the great majority have no delete
 * action, so Postgres itself aborts a delete that would orphan them. The rest -
 * `on delete cascade` and `on delete set null` - are the ones the database will
 * quietly destroy or unlink, so `findAccountActivity` has to check each one
 * explicitly.
 *
 * That list is only correct while it matches the schema. Adding a cascading FK
 * to users(id) and forgetting to probe it would make the sweep delete a real
 * person's row and report success, and nothing else in the build would notice.
 * This script is that forcing function. It follows the precedent of
 * a cheap script the build runs, not a linter plugin.
 */

// `export {}` makes this a module: db/ and scripts/ compile as one program under
// tsconfig.tools.json, so top-level `const fs`/`path` here would otherwise
// collide with the same names in a sibling script.
export {};

const fs = require('fs');
const path = require('path');

const BACKEND_DIR = path.join(__dirname, '..');
const SCHEMA_FILE = path.join(BACKEND_DIR, 'db', 'schema.sql');
const REPO_FILE = path.join(BACKEND_DIR, 'src', 'modules', 'users', 'users.repository.ts');

/**
 * Columns whose reference is about authorship of an unrelated record rather than
 * a relationship to the account, so losing it on delete costs nothing. Each entry
 * needs a reason, and adding one should be a deliberate call in review.
 */
const ALLOWED_UNGUARDED: Record<string, string> = {
  'email_verification_whitelist.created_by':
    'records which admin added a whitelist entry, not a relationship to the account; the entry itself survives',
  'file_export_jobs.requested_by':
    'a temporary zip of documents the firm already owns, made for one person and swept within 24 hours; '
    + 'nothing is lost when it goes with the account, and restricting instead would refuse to delete an '
    + 'account over a download it took last week',
  'storage_reservations.created_by':
    'quota held for an upload still in flight, which lapses within hours on its own; it records no '
    + 'data, so nothing is lost when it goes with the account',
};

const snakeToCamel = (name: string) => name
  .split('_')
  .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
  .join('');

const schema = fs.readFileSync(SCHEMA_FILE, 'utf8');

// Every FK to users(id) that cascades or nulls, as `table.column` -> rule.
const silent = new Map<string, string>();
let table: string | null = null;
for (const line of schema.split('\n')) {
  const tableMatch = /create table if not exists (\w+)/i.exec(line);
  if (tableMatch) table = tableMatch[1];
  const fkMatch = /^\s*(\w+)\s+.*references users\(id\)\s+on delete (cascade|set null)/i.exec(line);
  if (fkMatch && table) silent.set(`${table}.${fkMatch[1]}`, fkMatch[2].toLowerCase());
}

if (!silent.size) {
  console.error(
    '[user-delete-guards] FAIL: parsed no cascading foreign keys to users(id) from db/schema.sql.\n'
    + 'That almost certainly means this script stopped matching the schema format\n'
    + 'rather than that the keys are gone. Fix the parser before trusting a pass.'
  );
  process.exit(1);
}

const repoSource = fs.readFileSync(REPO_FILE, 'utf8');
const start = repoSource.indexOf('async findAccountActivity');
const end = repoSource.indexOf('Hard-delete a users row');
if (start === -1 || end === -1 || end < start) {
  console.error(
    '[user-delete-guards] FAIL: could not find findAccountActivity in users.repository.ts.\n'
    + 'If it was renamed or moved, update this script to match.'
  );
  process.exit(1);
}
const probed = new Set(
  Array.from(repoSource.slice(start, end).matchAll(/\.from\((\w+)\)/g)).map((m: any) => m[1])
);

const gaps: string[] = [];
for (const [reference] of silent) {
  const [referencedTable] = reference.split('.');
  if (probed.has(snakeToCamel(referencedTable))) continue;
  if (ALLOWED_UNGUARDED[reference]) continue;
  gaps.push(reference);
}

if (gaps.length) {
  console.error(
    `[user-delete-guards] FAIL: ${gaps.length} foreign key(s) to users(id) cascade or set null\n`
    + 'but are not checked by findAccountActivity, so deleting an account would\n'
    + 'silently destroy or unlink them:\n'
    + gaps.map((g) => `  ${g} -> on delete ${silent.get(g)}`).join('\n')
    + '\n\nAdd a probe for each in users.repository.ts findAccountActivity, or, if the\n'
    + 'reference genuinely does not represent a relationship to the account, add it\n'
    + 'to ALLOWED_UNGUARDED in db/check-user-delete-guards.ts with a reason.'
  );
  process.exit(1);
}

console.log(
  `[user-delete-guards] OK: all ${silent.size - Object.keys(ALLOWED_UNGUARDED).length} `
  + `cascading/set-null foreign keys to users(id) are guarded `
  + `(${Object.keys(ALLOWED_UNGUARDED).length} deliberately exempt).`
);
