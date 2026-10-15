import { ApiClient } from '../../../scripts/stress-test/client';
import type { Sample } from '../../../scripts/stress-test/stats';

const tokens = { token: async () => 'test-token' };
afterEach(() => jest.restoreAllMocks());

it.each(['templates.fillPdf', 'esign.convertFinalize'])('lets %s receive the server conversion deadline response', async (name) => {
  const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
  jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ code: 'REQUEST_TIMEOUT' }), { status: 504 }));
  const samples: Sample[] = [];
  const client = new ApiClient('http://localhost:5001', tokens, samples);
  expect(await client.call(name, 'POST', '/document-operation', {})).toEqual({ status: 504, body: { code: 'REQUEST_TIMEOUT' } });
  expect(timeout).toHaveBeenCalledWith(300_000);
  expect(samples).toEqual([expect.objectContaining({ name, status: 504, code: 'REQUEST_TIMEOUT' })]);
});

it('keeps core operations bounded by the ordinary request budget', async () => {
  const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
  jest.spyOn(global, 'fetch').mockRejectedValue(new Error('connection closed'));
  const samples: Sample[] = [];
  const client = new ApiClient('http://localhost:5001', tokens, samples);
  expect(await client.call('matters.list', 'GET', '/api/lawfirms/firm/matters')).toEqual({ status: 0, body: null });
  expect(timeout).toHaveBeenCalledWith(60_000);
  expect(samples).toEqual([expect.objectContaining({ name: 'matters.list', status: 0, code: null })]);
});

it('gives direct storage uploads the browser upload budget', async () => {
  const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
  const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 200 }));
  const samples: Sample[] = [];
  const client = new ApiClient('http://localhost:5001', tokens, samples);
  expect(await client.upload('esign.sourcePut', 'https://storage.example/upload', Buffer.from('bytes'), 'application/pdf')).toEqual({ status: 200, body: null });
  expect(timeout).toHaveBeenCalledWith(300_000);
  expect(fetch).toHaveBeenCalledWith('https://storage.example/upload', expect.objectContaining({ method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: new Uint8Array(Buffer.from('bytes')) }));
  expect(samples).toEqual([expect.objectContaining({ name: 'esign.sourcePut', status: 200 })]);
});
