/**
 * A ratchet against the next unbounded module-scope cache.
 *
 * Six of these were found at once: `_canViewCache`, `_firmNameCache`,
 * `billingRecipientsCache`, the permission `store` with its `firmIndex`, the
 * photo `cache`, and `calendarTimeZoneCache`, which had no expiry at all. Each
 * was a plain `new Map()` at module scope, keyed on a firm, a user or a
 * calendar, so each grew with the customer base for the life of the instance,
 * on the same 512 MiB container that signs documents.
 *
 * They were all written the same way and none of them looked wrong in review,
 * so fixing the six without stopping the seventh would only buy time. This scans
 * the source for the shape and fails on one that is not accounted for.
 *
 * It cannot tell a cache from a lookup table by reading it, so it does not try.
 * Every module-scope `Map` and `Set` is listed below with what it is, and a new
 * one has to be classified deliberately. That is the whole mechanism: the
 * failure message is the review question.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const SRC = path.join(__dirname, '..', '..', 'src');

/**
 * Module-scope `Map`/`Set` collections that are NOT per-request caches.
 *
 * Each entry says why it cannot grow with traffic. Adding to this list is a
 * claim about a specific collection, so it must be one of these shapes:
 *
 *   fixed        built once from a constant or a static table; never written
 *                to again at request time.
 *   self-erasing every write is paired with a delete on a path that always
 *                runs, so the size tracks work in flight, not work ever done.
 *   capped       already has both a size ceiling and a TTL, and says why it is
 *                not using the shared helper.
 */
const ALLOWED: Record<string, string> = {
  'modules/audit/audit.service.ts:inFlightAuditWrites':
    'self-erasing: the write is removed in the finally of the promise that added it',
  'modules/calendar/calendar.events.ts:inFlightSyncs':
    'self-erasing: the sync is removed in the finally of the promise that added it',
  'modules/calendar/calendar.events.ts:pendingSyncs':
    'self-erasing: the debounce timer deletes its own key when it fires or is cancelled',
  'modules/calendar/shared/calendarHelpers.ts:inflightRefresh':
    'self-erasing: the refresh deletes its key in a finally',
  'modules/files/shareNotifications.service.ts:inFlight':
    'self-erasing: each digest delivery is removed in the finally of the promise that added it',
  'modules/files/shareNotifications.service.ts:timers':
    'self-erasing: the batched-notification timer deletes its key when it fires',
  'shared/middleware/auth.ts:inflightVerifications':
    'self-erasing: the verification deletes its token key when it settles',
  'shared/utils/backgroundWrites.ts:inFlight':
    'self-erasing: the promise removes itself once it settles',

  'modules/billing/invoices/invoices.repository.ts:childColumnTypes':
    'fixed: one entry per child table in the schema, read from the catalog once per process',
  'modules/templates/overlayFill.service.ts:EMBEDDED_FONT_BYTES':
    'fixed: one entry per bundled font file on disk',
  'modules/templates/overlayFill.service.ts:GLYPH_TABLES':
    'fixed: one parsed face per bundled font file, keyed only by the fontFamilies() table',
  'modules/signatures/signingJobs.ts:handlers':
    'fixed: one entry per job kind, registered at module load and never keyed on data',

  'shared/middleware/auth.ts:tokenCache':
    'capped: TTL plus a 5000-entry ceiling, LRU eviction and a periodic sweep. '
    + 'This is the shape createBoundedCache was generalised from. It stays hand-written '
    + 'because it also expires an entry at the token\'s own exp, which the helper has no '
    + 'concept of.',
};

interface Found { key: string; name: string; file: string; line: number }

/**
 * Whether `name` is mutated anywhere outside the expression that built it.
 *
 * Looks for `name.set(...)`, `name.add(...)` or `name.delete(...)`. A write is
 * what separates a cache from a lookup table: a table is filled by the `new
 * Map([...])` argument and read for the rest of the process, so its size is
 * decided at load and cannot follow traffic.
 */
function isWrittenAfterConstruction(source: ts.SourceFile, name: string, ctor: ts.Node): boolean {
  let written = false;

  const visit = (node: ts.Node) => {
    if (written) return;
    // Skip the constructor argument itself: `new Map([...])` and a builder that
    // fills it in place at load time are both fixed at boot.
    if (node === ctor) return;
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === name
      && ['set', 'add', 'delete'].includes(node.expression.name.text)
    ) {
      written = true;
      return;
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
  return written;
}

/** Every top-level `const x = new Map()` / `new Set()` under src/. */
function findModuleScopeCollections(): Found[] {
  const out: Found[] = [];

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ts')) continue;

      const text = fs.readFileSync(full, 'utf8');
      const source = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true);
      const rel = path.relative(SRC, full).split(path.sep).join('/');

      // Only top-level statements. A Map created inside a function lives and
      // dies with the call, which is the safe case and is not what this is for.
      for (const statement of source.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const decl of statement.declarationList.declarations) {
          const init = decl.initializer;
          if (!init || !ts.isNewExpression(init)) continue;
          const ctor = init.expression.getText(source);
          if (ctor !== 'Map' && ctor !== 'Set' && ctor !== 'WeakMap') continue;
          const name = decl.name.getText(source);
          // Only a collection that is WRITTEN after it is built can grow. A
          // constant table built from a literal and never touched again is
          // fixed by construction, so it needs no allowance and does not appear
          // here. This is a structural fact about the file, not a guess from
          // the identifier's name.
          if (!isWrittenAfterConstruction(source, name, init)) continue;
          const line = source.getLineAndCharacterOfPosition(decl.getStart(source)).line + 1;
          out.push({ key: `${rel}:${name}`, name, file: rel, line });
        }
      }
    }
  };

  walk(SRC);
  return out;
}

it('has no module-scope Map or Set that is not accounted for', () => {
  const found = findModuleScopeCollections();
  const unexplained = found.filter((f) => !ALLOWED[f.key]);

  const detail = unexplained
    .map((f) => `  ${f.file}:${f.line}  ${f.name}`)
    .join('\n');

  expect(
    unexplained.length === 0 ? '' :
      'Module-scope Map/Set with no entry in ALLOWED:\n' + detail + '\n\n' +
      'If this caches anything keyed on a firm, user, calendar, token or\n' +
      'document, it grows with the customer base for the life of the\n' +
      'instance. Use createBoundedCache from shared/utils/boundedCache,\n' +
      'which requires both a size ceiling and a TTL.\n\n' +
      'If it genuinely cannot grow with traffic, add it to ALLOWED in\n' +
      'tests/shared/moduleScopeCaches.test.ts with which shape it is.',
  ).toBe('');
});

it('lists nothing in ALLOWED that no longer exists', () => {
  // A stale allowance is how the next one slips through: the name gets reused
  // for something that IS a cache and the ratchet stays quiet.
  const present = new Set(findModuleScopeCollections().map((f) => f.key));

  expect(Object.keys(ALLOWED).filter((k) => !present.has(k))).toEqual([]);
});
