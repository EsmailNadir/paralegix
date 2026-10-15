import { createFirm, ownerOf, testPool } from '../support/setupInProcess';

const repo = require('../../src/modules/leads/leads.repository');

it.each([false, true])('rolls back all conversion writes when saving the lead pointers fails (createMatter=%s)', async (createMatter) => {
  const firm = await createFirm();
  const owner = await ownerOf(firm.id);
  const base = `/api/lawfirms/${firm.id}/leads`;
  const created = await owner.api.post(base).send({ name: 'Prospect', email: 'prospect@example.test' });
  expect(created.status).toBe(201);
  const leadId = created.body.lead.id;
  const original = repo.update;
  let converted = false;
  const fault = jest.spyOn(repo, 'update').mockImplementation(async (...args: any[]) => {
    const result = await original.apply(repo, args);
    if (args[2].convertedClientId) {
      converted = true;
      throw new Error('Injected failure after conversion pointers');
    }
    return result;
  });
  try {
    const response = await owner.api.post(`${base}/${leadId}/convert`).send({ createMatter, name: 'Converted matter' });
    expect(response.status).toBe(500);
    expect(converted).toBe(true);
    const { rows } = await testPool.query('select converted_at, converted_client_id, converted_matter_id from leads where id = $1', [leadId]);
    expect(rows).toEqual([{ converted_at: null, converted_client_id: null, converted_matter_id: null }]);
    for (const table of ['clients', 'matters']) {
      const { rows: records } = await testPool.query(`select id from ${table} where law_firm_id = $1`, [firm.id]);
      expect({ table, records }).toEqual({ table, records: [] });
    }
  } finally {
    fault.mockRestore();
  }
});
