/**
 * A matter invoice bills one of the matter's own clients.
 *
 * Plan-created drafts and split invoices already refuse a client who is not on
 * the matter; a hand-made matter invoice must hold the same line, otherwise a
 * bill (and its recipient and trust linkage) can name a client the matter has
 * nothing to do with. A client-context invoice has no matter and is unaffected.
 *
 * RED IF: POST /billing/invoices accepts a matter invoice whose clientId is not
 * on the matter (including a client of another firm), or refuses a client who is.
 */
import {
  testPool, createFirm, createPersonClient, ownerOf, type Actor, type Firm, type ClientRecord,
} from '../support/setupInProcess';
import { seedMatter } from '../support/matters';

let firm: Firm;
let owner: Actor;
let onMatter: ClientRecord;
let stranger: ClientRecord;
let matterId: string;

const invoicesBase = () => `/api/lawfirms/${firm.id}/billing/invoices`;
const flatFeeBody = (name: string) => ({
  invoiceName: name, invoiceDate: '2026-03-01', dueDate: '2026-03-31',
  totalAmount: 500, flatFeesAmount: 500, flatFees: [{ description: name, amount: 500 }],
});
const invoiceCount = async () => Number((await testPool.query(
  'select count(*)::int as n from invoices where law_firm_id = $1', [firm.id])).rows[0].n);

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  onMatter = await createPersonClient(firm.id, { name: 'On Matter', email: 'on-matter@example.test' });
  stranger = await createPersonClient(firm.id, { name: 'Stranger', email: 'stranger@example.test' });
  matterId = await seedMatter(firm.id, { memberUids: [owner.uid], clientIds: [onMatter.id] });
});

it('creates a matter invoice for a client on the matter (control)', async () => {
  const res = await owner.api.post(invoicesBase()).send({ ...flatFeeBody('Matter client bill'), matterId, clientId: onMatter.id });

  expect(res.status).toBe(201);
  expect(res.body.invoice.clientId).toBe(onMatter.id);
  expect(await invoiceCount()).toBe(1);
});

it('refuses a client of the firm who is not on the matter, and writes nothing', async () => {
  const res = await owner.api.post(invoicesBase()).send({ ...flatFeeBody('Wrong client'), matterId, clientId: stranger.id });

  expect(res.status).toBe(400);
  expect(JSON.stringify(res.body)).toContain('The client must be a client on this matter.');
  expect(await invoiceCount()).toBe(0);
});

it('refuses a client of another firm, and writes nothing', async () => {
  const rival = await createFirm();
  const foreign = await createPersonClient(rival.id, { name: 'Foreign', email: 'foreign@example.test' });

  const res = await owner.api.post(invoicesBase()).send({ ...flatFeeBody('Foreign client'), matterId, clientId: foreign.id });

  expect(res.status).toBe(400);
  expect(JSON.stringify(res.body)).toContain('The client must be a client on this matter.');
  expect(await invoiceCount()).toBe(0);
});

it('still creates a matter invoice that names no client', async () => {
  const res = await owner.api.post(invoicesBase()).send({ ...flatFeeBody('Unassigned'), matterId });

  expect(res.status).toBe(201);
  expect(await invoiceCount()).toBe(1);
});

it('leaves a client-context invoice alone, whatever matters the client is on', async () => {
  const res = await owner.api.post(`${invoicesBase()}/client/${stranger.id}`).send(flatFeeBody('Client bill'));

  expect(res.status).toBe(201);
  expect(res.body.invoice.clientId).toBe(stranger.id);
});
