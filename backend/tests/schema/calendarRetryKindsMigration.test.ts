import { readFileSync } from 'fs';
import { join } from 'path';
import type { PoolClient } from 'pg';
import { testPool } from '../support/setupInProcess';

const migration = () => readFileSync(join(__dirname, '../../db/migrations/0038_calendar_retry_kinds.sql'), 'utf8');

async function withOldQueue(run: (client: PoolClient) => Promise<void>) {
  const client = await testPool.connect();
  try {
    await client.query('begin');
    await client.query('create temporary table calendar_sync_failures (like public.calendar_sync_failures including all) on commit drop');
    await client.query('alter table calendar_sync_failures drop constraint calendar_sync_failures_kind_check');
    await client.query(`alter table calendar_sync_failures add constraint calendar_sync_failures_kind_check
      check (kind in ('webhook', 'stop_channel', 'notification', 'outbound'))`);
    await run(client);
  } finally {
    await client.query('rollback');
    client.release();
  }
}

test('the correction preserves all supported queued work and rejects the retired kind', async () => {
  await withOldQueue(async (client) => {
    for (const kind of ['webhook', 'stop_channel', 'outbound']) {
      await client.query('insert into calendar_sync_failures (kind, dedupe_key) values ($1, $1)', [kind]);
    }
    await client.query(migration());
    expect((await client.query('select kind from calendar_sync_failures order by kind')).rows)
      .toEqual([{ kind: 'outbound' }, { kind: 'stop_channel' }, { kind: 'webhook' }]);
    await expect(client.query("insert into calendar_sync_failures (kind, dedupe_key) values ('notification', 'retired')"))
      .rejects.toMatchObject({ code: '23514', constraint: 'calendar_sync_failures_kind_check' });
  });
});

test('the correction refuses pending retired work without deleting it or changing the constraint', async () => {
  await withOldQueue(async (client) => {
    await client.query("insert into calendar_sync_failures (kind, dedupe_key) values ('notification', 'pending')");
    await client.query('savepoint correction');
    await expect(client.query(migration())).rejects.toMatchObject({
      code: 'P0001', message: 'Cannot retire notification calendar work while queued rows remain',
    });
    await client.query('rollback to savepoint correction');
    expect((await client.query('select kind, dedupe_key from calendar_sync_failures')).rows)
      .toEqual([{ kind: 'notification', dedupe_key: 'pending' }]);
    expect((await client.query("insert into calendar_sync_failures (kind, dedupe_key) values ('notification', 'still-supported')")).rowCount)
      .toBe(1);
  });
});
