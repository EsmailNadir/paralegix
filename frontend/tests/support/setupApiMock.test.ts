/**
 * `setupApiMock()` replaces the hand-written install/restore pair, so it has to
 * give every test its own mock and put the real `fetch` back afterwards. A
 * handle that leaked one test's routes or calls into the next would make a spec
 * pass on data it never set up.
 */
jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');

import { setupApiMock } from './apiMock';
import clientsService from '@/services/clients.service';

const realFetch = global.fetch;
const api = setupApiMock();

let readOutsideATest: unknown = null;
try {
  api.calls();
} catch (error) {
  readOutsideATest = error;
}

describe('setupApiMock', () => {
  it('forwards to a mock installed for the running test', async () => {
    expect(global.fetch).not.toBe(realFetch);
    api.get('/clients', { clients: [] });

    await clientsService.listClients('firm-1');

    expect(api.calls('GET')).toHaveLength(1);
  });

  it('starts each test with no routes and no recorded calls', async () => {
    expect(api.calls()).toEqual([]);
    api.allowUnhandled();

    await expect(clientsService.listClients('firm-1')).rejects.toThrow('apiMock: no handler for GET /api/lawfirms/firm-1/clients');
  });

  it('refuses to be read outside a test', () => {
    expect(String(readOutsideATest)).toMatch(/`calls` was read outside a test/);
  });
});

afterAll(() => {
  expect(global.fetch).toBe(realFetch);
});
