import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// `require` rather than `import`: resolveDbUrl.js is CommonJS.
const { resolveDbUrl } = require('./src/shared/database/resolveDbUrl');

/**
 * Drizzle is a QUERY BUILDER here, not the schema owner.
 *
 * db/schema.sql plus the numbered migrations in db/migrations remain the single
 * source of truth. This config exists so `drizzle-kit pull` can INTROSPECT that
 * database into TypeScript types. Nothing here should ever generate or apply a
 * migration -- `drizzle-kit push` and `generate` are deliberately not wired into
 * any npm script.
 *
 * The connection string comes from the same resolveDbUrl the app uses, so
 * DB_TARGET=local/staging/prod selects the same database here as everywhere else
 * rather than introducing a second, silently divergent rule.
 *
 * `out` is under src/ deliberately. The generated schema is application source
 * that the app imports, and tsconfig sets `rootDir: "src"` -- a file outside it
 * cannot be imported without TS6059. It sits in its own `drizzle/` directory
 * beside `drizzleClient.ts`, which is the hand-written half.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/shared/database/drizzle/schema.ts',
  out: './src/shared/database/drizzle',
  dbCredentials: { url: resolveDbUrl() as string },
  // `schema_migrations` is db/run-sql.ts's own bookkeeping, not application
  // data, and db/schema.sql does not create it. Without this exclusion the pull
  // depends on HOW the database was built -- the ledger appears when a database
  // was migrated and is absent when it was built from schema.sql -- so
  // `npm run db:drift` could never be green against both. Nothing reads it
  // through Drizzle.
  tablesFilter: ['!schema_migrations'],
  verbose: true,
  strict: true,
});
