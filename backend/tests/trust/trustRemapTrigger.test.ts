import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  createPersonClient,
  createTrustDeposit,
} from '../support/setupInProcess';

describe('trust client remap exemption', () => {
  it('allows only the declared client pair and keeps the completed entry immutable otherwise', async () => {
    const firm = await createFirm();
    const from = await createPersonClient(firm.id, { name: 'Placeholder' });
    const to = await createPersonClient(firm.id, { name: 'Survivor' });
    const trust = await createTrustDeposit(firm.id, from.id);

    await expect(testPool.query(
      'update trust_transactions set client_id = $2 where id = $1',
      [trust.transactionId, to.id],
    )).rejects.toMatchObject({ code: 'P0001' });

    const client = await testPool.connect();
    try {
      await client.query('begin');
      await client.query(
        "select set_config('paralegix.trust_client_remap', $1, true)",
        [`${from.id}:${to.id}`],
      );
      await client.query(
        'update trust_transactions set client_id = $2 where id = $1',
        [trust.transactionId, to.id],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }

    const { rows } = await testPool.query(
      'select client_id, amount_cents from trust_transactions where id = $1',
      [trust.transactionId],
    );
    expect(rows).toEqual([{ client_id: to.id, amount_cents: String(trust.amountCents) }]);

    const other = randomUUID();
    await expect(testPool.query(
      `update trust_transactions
          set client_id = $2, description = 'tampered'
        where id = $1`,
      [trust.transactionId, other],
    )).rejects.toMatchObject({ code: 'P0001' });
  });
});
