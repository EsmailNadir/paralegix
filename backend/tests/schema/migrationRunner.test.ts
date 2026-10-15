/**
 * `db/run-sql.ts` is the only thing standing between a corrupted or
 * out-of-order migration file and a database that silently drifts from what
 * `schema_migrations` claims was applied. It is a CLI script with no exported
 * entry point, so this suite drives it the way an operator does: as a real
 * child process, against a real, disposable Postgres database created and
 * dropped by this file alone.
 *
 * Every test here uses its own throwaway file under `db/migrations/` (prefix
 * `9999_scratch_`, well outside any real numbering) so the runner's
 * path-based "is this a tracked migration" check exercises the real code path
 * instead of a re-implementation of it. Every such file is removed in the
 * test's own `finally` block, with an `afterAll` sweep as a safety net in case
 * a test throws before cleanup runs. None of this ever touches a real
 * migration file, and no shared `TEST_DB_SLOT` database is used: the scratch
 * database this file creates is destructive to point at (tampered ledger
 * rows, deliberately-failing SQL) and must never overlap with a database
 * other concurrent test runs depend on.
 */
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';

const BACKEND_ROOT = path.join(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(BACKEND_ROOT, 'db', 'migrations');
const RUN_SQL = path.join(BACKEND_ROOT, 'db', 'run-sql.ts');
// tsx's own CLI entry point, not the node_modules/.bin shim. The shim is an
// extensionless shell script plus a .cmd twin; on Windows the shell script is
// not executable and execFileSync refuses the .cmd outright (EINVAL, since Node
// 20), so spawning the shim produced no output at all and every assertion below
// read an empty string. Running the entry point under the current node binary
// needs no shell, so it behaves the same on every platform.
const TSX_CLI = path.join(BACKEND_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const TEST_BASE = process.env.DATABASE_URL_TEST
  || 'postgresql://postgres:postgres@localhost:5433/paralegix_test';

/**
 * One scratch database per Jest worker, REUSED across runs rather than created
 * and dropped per run.
 *
 * `DROP DATABASE` forces an immediate checkpoint and waits for it
 * (`wait_event = CheckpointDone`). On this container that checkpoint routinely
 * runs for minutes, so a per-run drop timed the suite out in its own `afterAll`
 * even with nothing else running, and a run killed before that drop left the
 * database behind to be dropped by the next one. Resetting the schema instead
 * takes no checkpoint at all.
 *
 * Keyed on the worker id, like the shared test databases in `tests/support/db.ts`,
 * so two workers can never target the same one. Reset happens at SETUP, not
 * teardown: an interrupted run leaves a dirty database that the next run cleans
 * before use, rather than leaving one nothing ever cleans.
 */
const SCRATCH_DB = `paralegix_test_scratch_${process.env.JEST_WORKER_ID || '1'}`;
// Belt and suspenders: this name reaches `create database` and a `drop schema`,
// both destructive enough to double-check rather than trust the template.
if (!/^paralegix_test_scratch_[0-9]{1,3}$/.test(SCRATCH_DB)) {
  throw new Error(`Refusing to run: generated scratch database name looks wrong (${SCRATCH_DB}).`);
}

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

const MAINTENANCE_URL = withDatabase(TEST_BASE, 'postgres');
const SCRATCH_URL = withDatabase(TEST_BASE, SCRATCH_DB);

beforeAll(async () => {
  const admin = new Client({ connectionString: MAINTENANCE_URL });
  await admin.connect();
  // `create database` is cheap and does not checkpoint; only the DROP does.
  // Tolerate the database already existing from a previous run.
  const existing = await admin.query('select 1 from pg_database where datname = $1', [SCRATCH_DB]);
  if (!existing.rowCount) await admin.query(`create database "${SCRATCH_DB}"`);
  await admin.end();

  // Reset to a bare database. This is what makes the reuse safe: whatever a
  // previous (possibly interrupted) run left behind, including its
  // `schema_migrations` ledger, is gone before the first test reads it.
  const scratch = new Client({ connectionString: SCRATCH_URL });
  await scratch.connect();
  await scratch.query('drop schema if exists public cascade');
  await scratch.query('create schema public');
  await scratch.end();
});

afterAll(async () => {
  // The scratch database is deliberately NOT dropped: see SCRATCH_DB above.
  // `beforeAll` resets it, so leaving it costs one idle database per worker and
  // saves a multi-minute checkpoint on every run.
  //
  // Scratch MIGRATION FILES are a different matter and must go: they live in the
  // real `db/migrations/` directory, and one left behind would be picked up as a
  // real migration by the next `run-sql.ts` invocation. The 9999/"scratch"
  // naming is deliberately outside the real numbering so this glob can never
  // touch an actual migration.
  for (const name of fs.readdirSync(MIGRATIONS_DIR)) {
    if (/^9999_scratch_.*\.sql$/.test(name)) {
      fs.unlinkSync(path.join(MIGRATIONS_DIR, name));
    }
  }
});

function scratchMigrationFile(label: string): string {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
  return path.join(MIGRATIONS_DIR, `9999_scratch_${label}_${suffix}.sql`);
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runMigrationCli(file: string, extraArgs: string[] = []): CliResult {
  try {
    const stdout = execFileSync(process.execPath, [TSX_CLI, RUN_SQL, file, ...extraArgs], {
      cwd: BACKEND_ROOT,
      env: {
        ...process.env,
        DB_TARGET: 'local',
        DATABASE_URL_LOCAL: SCRATCH_URL,
        // The suite's own db.ts pins this to a value that refuses to
        // resolve; make sure a bug in run-sql's DB_TARGET handling can't
        // fall through to it and quietly "succeed" against nothing.
        DATABASE_URL: 'postgres://paralegix-suite-blocked/do-not-connect',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      code: e.status ?? 1,
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
    };
  }
}

async function withScratchClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: SCRATCH_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

describe('db/run-sql.ts checksum-mismatch refusal', () => {
  it('refuses a migration whose on-disk content no longer matches the checksum it was recorded with', async () => {
    const file = scratchMigrationFile('checksum');
    const name = path.basename(file);
    fs.writeFileSync(
      file,
      ['-- migration-mode: expand', 'create table if not exists checksum_probe (id int);', ''].join('\n'),
    );

    try {
      // Simulate a migration that was applied once, then the file on disk was
      // edited afterward (or corrupted) -- schema_migrations still names the
      // ORIGINAL checksum, which no longer matches what run-sql computes for
      // the current file.
      await withScratchClient(async (client) => {
        await client.query(`create table if not exists schema_migrations (
          name        text primary key,
          applied_at  timestamptz not null default now(),
          checksum    text
        )`);
        await client.query(
          'insert into schema_migrations (name, checksum) values ($1, $2)',
          [name, 'deadbeefdeadbeef'],
        );
      });

      const result = runMigrationCli(file);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(
        `${name} was already applied with checksum deadbeefdeadbeef, but the current file is`,
      );
      expect(result.stderr).toContain('Never edit/replay an applied migration; add a new one.');

      // The refusal must happen BEFORE the SQL runs, not after a failed
      // attempt: the table the migration would have created must not exist.
      await withScratchClient(async (client) => {
        const { rows } = await client.query(`select to_regclass('public.checksum_probe') as t`);
        expect(rows[0].t).toBeNull();
      });
    } finally {
      fs.unlinkSync(file);
    }
  });
});

describe('db/run-sql.ts repeat-application handling', () => {
  it('recognizes an unchanged, already-applied migration as a no-op instead of silently re-running it', async () => {
    const file = scratchMigrationFile('repeat');
    const name = path.basename(file);
    // Deliberately NOT idempotent (no IF NOT EXISTS). If the runner ever
    // actually re-executed this statement on the second invocation, Postgres
    // would raise 42P07 (duplicate_table) and that run would fail loudly
    // instead of reporting SKIPPED -- this is what makes the assertion below
    // proof of "not rerun", not just "printed a nice message".
    fs.writeFileSync(file, ['-- migration-mode: expand', 'create table repeat_probe (id int);', ''].join('\n'));

    try {
      const first = runMigrationCli(file);
      expect(first.code).toBe(0);
      expect(first.stdout).toContain(`Applied ${file}`);

      const second = runMigrationCli(file);
      expect(second.code).toBe(0);
      expect(second.stdout).toContain(`SKIPPED ${name}: already applied`);

      await withScratchClient(async (client) => {
        const { rows } = await client.query(
          'select count(*)::int as n from schema_migrations where name = $1',
          [name],
        );
        expect(rows[0].n).toBe(1);
      });
    } finally {
      fs.unlinkSync(file);
    }
  });
});

describe('db/run-sql.ts upgrade of a table that already holds rows', () => {
  it('adds the column, leaves existing data alone, and records the migration once', async () => {
    // This used to apply the real `0188_law_firms_storage_reserved_bytes.sql`
    // against a snapshot of the table as it stood before it. That file is gone
    // with the rest of the chain, and no database can replay it again, so the
    // case is written as what it was actually proving: the runner applies a
    // migration to a table that already has rows without disturbing them.
    const file = scratchMigrationFile('upgrade_with_rows');
    const name = path.basename(file);

    await withScratchClient(async (client) => {
      await client.query(`create table scratch_firms (
        id uuid primary key,
        name text not null,
        storage_used_bytes bigint not null default 0
      )`);
      await client.query(
        `insert into scratch_firms (id, name, storage_used_bytes)
         values ('00000000-0000-0000-0000-000000000188', 'Pre-upgrade firm', 987654321)`,
      );
    });

    fs.writeFileSync(file, [
      '-- migration-mode: expand',
      'alter table scratch_firms',
      "  add column storage_reserved_bytes bigint not null default 0",
      '  check (storage_reserved_bytes >= 0);',
      '',
    ].join('\n'));

    try {
      const result = runMigrationCli(file);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`Applied ${file}`);

      await withScratchClient(async (client) => {
        const firm = await client.query(
          `select storage_used_bytes, storage_reserved_bytes
             from scratch_firms
            where id = '00000000-0000-0000-0000-000000000188'`,
        );
        // The accounted usage is untouched, and the new balance is explicitly
        // zero: a deployment cannot infer an in-flight reservation from an old
        // row, so the default is the only safe answer for one that predates it.
        expect(firm.rows).toEqual([{ storage_used_bytes: '987654321', storage_reserved_bytes: '0' }]);

        const column = await client.query(
          `select data_type, is_nullable, column_default
             from information_schema.columns
            where table_schema = 'public'
              and table_name = 'scratch_firms'
              and column_name = 'storage_reserved_bytes'`,
        );
        expect(column.rows).toEqual([{
          data_type: 'bigint',
          is_nullable: 'NO',
          column_default: '0',
        }]);

        await expect(
          client.query(`update scratch_firms set storage_reserved_bytes = -1`),
        ).rejects.toMatchObject({ code: '23514' });

        const ledger = await client.query(
          'select count(*)::int as n from schema_migrations where name = $1',
          [name],
        );
        expect(ledger.rows[0].n).toBe(1);
      });
    } finally {
      await withScratchClient(async (client) => {
        await client.query('drop table if exists scratch_firms');
        await client.query('delete from schema_migrations where name = $1', [name]);
      });
    }
  });
});

describe('db/run-sql.ts contract-mode refusal', () => {
  it('refuses to apply a contract-mode migration without a separate --allow-contract authorization', () => {
    const file = scratchMigrationFile('contract');
    fs.writeFileSync(file, ['-- migration-mode: contract', 'drop table if exists contract_probe;', ''].join('\n'));

    try {
      const result = runMigrationCli(file);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(
        'Contract migrations are never applied automatically; separately authorize --allow-contract.',
      );
    } finally {
      fs.unlinkSync(file);
    }

    // --allow-contract is the deliberate escape hatch; recorded here as
    // documentation of the boundary, not exercised, since actually applying a
    // contract migration is a separately-authorized production action this
    // test plan does not grant itself.
  });
});

describe('db/run-sql.ts transactional partial-application handling', () => {
  // A single multi-statement string sent over Postgres's simple query
  // protocol is ALREADY atomic on its own (Postgres implicitly wraps it in a
  // transaction unless the string contains its own BEGIN/COMMIT) -- so a
  // migration file with two statements where the second one fails proves
  // nothing about run-sql.ts specifically; it would pass identically even
  // with run-sql's own `begin`/`commit` wrapper deleted (verified by hand
  // while writing this test, by commenting the wrapper out and re-running).
  //
  // What run-sql.ts actually adds is binding the ledger INSERT (a SEPARATE
  // `client.query()` call, sent after the migration's own SQL) into the SAME
  // transaction. That is the specific guarantee this test isolates: force
  // the ledger insert itself to fail, via a trigger this test installs on
  // its own scratch database, while the migration's own SQL succeeds
  // cleanly. If run-sql's transaction really spans both calls, the
  // already-successful CREATE TABLE must be undone along with the ledger
  // write that failed after it.
  it('rolls back an already-successful migration statement when the ledger insert that follows it fails', async () => {
    const file = scratchMigrationFile('partial_forcefail');
    const name = path.basename(file);
    fs.writeFileSync(file, ['-- migration-mode: expand', 'create table partial_probe (id int);', ''].join('\n'));

    try {
      await withScratchClient(async (client) => {
        await client.query(`create table if not exists schema_migrations (
          name        text primary key,
          applied_at  timestamptz not null default now(),
          checksum    text
        )`);
        await client.query(`create or replace function scratch_force_ledger_failure()
          returns trigger as $$
          begin
            if new.name like '%forcefail%' then
              raise exception 'scratch test: forced ledger-insert failure';
            end if;
            return new;
          end;
          $$ language plpgsql`);
        await client.query(`drop trigger if exists scratch_force_ledger_failure_trg on schema_migrations`);
        await client.query(`create trigger scratch_force_ledger_failure_trg
          before insert on schema_migrations
          for each row execute function scratch_force_ledger_failure()`);
      });

      try {
        const result = runMigrationCli(file);
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain('FAILED:');
        expect(result.stderr).toContain('scratch test: forced ledger-insert failure');

        await withScratchClient(async (client) => {
          const { rows: tableRows } = await client.query(`select to_regclass('public.partial_probe') as t`);
          // The CREATE TABLE succeeded on its own -- proof the failure is
          // downstream of it, not a syntax error that never ran anything.
          // It must still be gone: the ledger insert that followed it, in
          // the SAME transaction, failed and rolled the whole thing back.
          expect(tableRows[0].t).toBeNull();

          const { rows: ledgerRows } = await client.query(
            'select count(*)::int as n from schema_migrations where name = $1',
            [name],
          );
          expect(ledgerRows[0].n).toBe(0);
        });
      } finally {
        await withScratchClient(async (client) => {
          await client.query('drop trigger if exists scratch_force_ledger_failure_trg on schema_migrations');
          await client.query('drop function if exists scratch_force_ledger_failure()');
        });
      }
    } finally {
      fs.unlinkSync(file);
    }
  });
});
