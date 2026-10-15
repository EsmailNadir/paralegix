import { createFirm, ownerOf, createPersonClient, testPool } from '../support/setupInProcess';

const repo = require('../../src/modules/documentRequests/documentRequests.repository');

describe('document request atomic updates', () => {
  it.each(['header and items', 'item status'])('rolls back %s when the request rollup fails', async (operation) => {
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);
    const client = await createPersonClient(firm.id);
    const base = `/api/lawfirms/${firm.id}/document-requests`;
    const created = await owner.api.post(base).send({
      clientId: client.id, title: 'Original', items: [{ label: 'Passport' }],
    });
    expect(created.status).toBe(201);
    const requestId = created.body.request.id;
    const itemId = created.body.request.items[0].id;
    const original = repo.recomputeStatus;
    let rolledUp = false;
    const fault = jest.spyOn(repo, 'recomputeStatus').mockImplementation(async (...args: any[]) => {
      await original.apply(repo, args);
      rolledUp = true;
      throw new Error('Injected failure after rollup');
    });
    try {
      const response = operation === 'header and items'
        ? await owner.api.patch(`${base}/${requestId}`).send({ title: 'Changed', addItems: [{ label: 'License' }] })
        : await owner.api.patch(`${base}/${requestId}/items/${itemId}`).send({ status: 'received' });
      expect(response.status).toBe(500);
      expect(rolledUp).toBe(true);
      const { rows: headers } = await testPool.query('select title, status from document_requests where id = $1', [requestId]);
      expect(headers).toEqual([{ title: 'Original', status: 'open' }]);
      const { rows: items } = await testPool.query('select label, status from document_request_items where request_id = $1', [requestId]);
      expect(items).toEqual([{ label: 'Passport', status: 'pending' }]);
    } finally {
      fault.mockRestore();
    }
  });
});
