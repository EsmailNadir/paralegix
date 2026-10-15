import { createFirm, createPersonClient, ownerOf, testPool } from '../support/setupInProcess';
import { gateMethod } from '../support/gate';

const settingsRepo = require('../../src/modules/settings/settings.repository');

it.each(['firm', 'user', 'client'] as const)('preserves disjoint nested %s settings patches that overlap at the write', async (scope) => {
  const firm = await createFirm();
  const owner = await ownerOf(firm.id);
  const client = await createPersonClient(firm.id);
  const url = scope === 'firm' ? `/api/lawfirms/${firm.id}/settings/firm`
    : scope === 'client' ? `/api/lawfirms/${firm.id}/clients/${client.id}/settings` : '/api/settings/user';
  const table = scope === 'firm' ? 'law_firms' : scope === 'client' ? 'clients' : 'users';
  const column = scope === 'user' ? 'preferences' : 'settings';
  const id = scope === 'firm' ? firm.id : scope === 'client' ? client.id : owner.uid;
  const seeded = await testPool.query(`update ${table} set ${column} = $1::jsonb where id = $2`, [JSON.stringify({ retained: { marker: 'existing setting' } }), id]);
  expect(seeded.rowCount).toBe(1);
  const method = scope === 'firm' ? 'updateFirmSettings' : scope === 'client' ? 'updateClientSettings' : 'updateUserSettings';
  const gate = gateMethod(settingsRepo, method);
  const patches = scope === 'firm' ? [{ billing: { invoicePrefix: 'FIRM' } }, { billing: { taxRate: 8 } }]
    : scope === 'client' ? [{ notifications: { email: { message: false } } }, { notifications: { email: { invoiceReminder: false } } }]
      : [{ notifications: { email: { message: false } } }, { notifications: { email: { invoiceReminder: false } } }];
  async function fire(patch: unknown) {
    const body = scope === 'user' ? { preferences: patch } : { settings: patch };
    return scope === 'user' ? owner.api.post(url).send(body) : owner.api.put(url).send(body);
  }
  const first = fire(patches[0]);
  const second = fire(patches[1]);
  try {
    await gate.arrived(2);
    expect(gate.waiting()).toBe(2);
    gate.open();
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const { rows } = await testPool.query(`select ${column} as stored from ${table} where id = $1`, [id]);
    expect(rows[0].stored.retained).toEqual({ marker: 'existing setting' });
    for (const patch of patches) expect(rows[0].stored).toMatchObject(patch);
  } finally { gate.restore(); await Promise.allSettled([first, second]); }
});
