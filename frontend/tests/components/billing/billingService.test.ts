/**
 * The billing service layer, tested OFFLINE against a fake transport.
 *
 * `billing.service.ts` reports 0% in the default suite. There is a
 * `tests/services/billing.service.test.ts`, but it lives in the LIVE half: it
 * needs a running backend and a Firebase token, so it is excluded from
 * `npm test` and contributes nothing to the coverage the default run measures.
 *
 * This file covers the same module with no server, using the transport harness.
 * That keeps the whole service real, which is the point: the things worth
 * asserting here are exactly the things a stubbed service hides.
 *
 * THE CONTEXT SEGMENT IS THE HAZARD. Nearly every method takes a
 * `BillingContext` of `{ type: 'matter' | 'client', entityId, lawFirmId }` and
 * builds `.../time-entries/{type}/{entityId}` from it, while CREATE instead
 * sends `{ matterId }` or `{ clientId }` in the body. Getting either wrong files
 * a client's billable work under a matter, or bills a matter's work to one
 * client. The backend has the mirror of this bug class, and it produced a
 * cross-tenant write.
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import billingService from '@/services/billing.service';
import { ApiError } from '@/lib/utils/apiErrors';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

const LAW_FIRM_ID = 'firm-1';
const MATTER_CONTEXT = { type: 'matter' as const, entityId: 'matter-9', lawFirmId: LAW_FIRM_ID };
const CLIENT_CONTEXT = { type: 'client' as const, entityId: 'client-7', lawFirmId: LAW_FIRM_ID };

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  // Several cases read the same endpoint in consecutive tests, which trips the
  // dev-only duplicate-GET warning and buries the real output.
  __resetDuplicateRequestGuard();
});

afterEach(() => {
  api.restore();
});

describe('the url a read builds', () => {
  it('puts the firm, the context type and the entity in the path', async () => {
    api.get('/time-entries/matter/matter-9', { timeEntries: [] });

    await billingService.listTimeEntries(MATTER_CONTEXT);

    const [call] = api.calls('GET');
    // All three ids reaching the url is what a wrong-url bug breaks, and the
    // global service stub could never see it: it never built a url at all.
    expect(call.pathname).toContain(LAW_FIRM_ID);
    expect(call.pathname).toContain('/time-entries/matter/matter-9');
  });

  it('uses the CLIENT segment for a client context', async () => {
    api.get('/time-entries/client/client-7', { timeEntries: [] });

    await billingService.listTimeEntries(CLIENT_CONTEXT);

    // The two contexts differ by one path segment. Sending a client context to
    // the matter route asks the server for a matter that does not exist, and the
    // client's work appears to have vanished.
    const [call] = api.calls('GET');
    expect(call.pathname).toContain('/time-entries/client/client-7');
    expect(call.pathname).not.toContain('/matter/');
  });

  it('appends userId as a query parameter when given', async () => {
    api.get('/time-entries/matter/matter-9', { timeEntries: [] });

    await billingService.listTimeEntries(MATTER_CONTEXT, 'member-42');

    expect(api.calls('GET')[0].url).toContain('userId=member-42');
  });

  it('omits userId entirely when not given', async () => {
    api.get('/time-entries/matter/matter-9', { timeEntries: [] });

    await billingService.listTimeEntries(MATTER_CONTEXT);

    // Sending `userId=undefined` would filter the list down to a user of that
    // name, which is nobody, and the screen would show an empty matter.
    expect(api.calls('GET')[0].url).not.toContain('userId');
  });

  it('sends unbilledOnly only when asked', async () => {
    api.get('/time-entries/matter/matter-9', { timeEntries: [] });

    await billingService.listTimeEntries(MATTER_CONTEXT, undefined, { unbilledOnly: true });
    await billingService.listTimeEntries(MATTER_CONTEXT);

    // Opt-in. Sending it by default would hide every already-invoiced entry from
    // the time-tracking view, which is where a firm checks what it has billed.
    expect(api.calls('GET')[0].url).toContain('unbilledOnly=true');
    expect(api.calls('GET')[1].url).not.toContain('unbilledOnly');
  });

  it('escapes an entity id that would otherwise break the path', async () => {
    api.get('/time-entries/matter/a%2Fb%3Fc', { timeEntries: [] });

    await billingService.listTimeEntries({
      type: 'matter', entityId: 'a/b?c', lawFirmId: LAW_FIRM_ID,
    });

    // An unescaped id carrying a slash or a question mark silently becomes extra
    // path segments and a query string, so the request lands on a different
    // route than the caller asked for.
    const [call] = api.calls('GET');
    expect(call.url).toContain('a%2Fb%3Fc');
  });
});

describe('what a read returns', () => {
  it('unwraps the timeEntries envelope', async () => {
    api.get('/time-entries/matter/matter-9', {
      timeEntries: [{ id: 'te-1', hours: 1.5 }],
    });

    const result = await billingService.listTimeEntries(MATTER_CONTEXT);

    // The service unwrapped `{ timeEntries: [...] }` itself. A stubbed service
    // would have returned whatever the stub said, proving nothing about the
    // unwrap.
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('te-1');
  });

  it('returns an empty array when the envelope is missing the key', async () => {
    api.get('/time-entries/matter/matter-9', {});

    const result = await billingService.listTimeEntries(MATTER_CONTEXT);

    // A missing key must not become `undefined`, or every caller that maps over
    // the result throws on a response that was otherwise fine.
    expect(result).toEqual([]);
  });

  it('returns an empty array for an empty list', async () => {
    api.get('/time-entries/matter/matter-9', { timeEntries: [] });

    expect(await billingService.listTimeEntries(MATTER_CONTEXT)).toEqual([]);
  });
});

describe('what a read does with a failure', () => {
  it('THROWS on a 500 rather than returning empty', async () => {
    api.get('/time-entries/matter/matter-9', { status: 500, body: { error: 'Server error' } });

    // The case the old global stub made impossible. A service that swallowed the
    // error and returned `[]` shows an empty matter, and a firm reads that as
    // "no time recorded" rather than "the request failed".
    await expect(billingService.listTimeEntries(MATTER_CONTEXT)).rejects.toBeDefined();
  });

  it('throws on a 403', async () => {
    api.get('/time-entries/matter/matter-9', {
      status: 403, body: { error: 'Forbidden', code: 'FORBIDDEN' },
    });

    await expect(billingService.listTimeEntries(MATTER_CONTEXT)).rejects.toBeDefined();
  });

  it('carries the server message into the thrown error', async () => {
    api.get('/time-entries/matter/matter-9', {
      status: 403,
      body: { error: 'You do not have permission to view billing', code: 'FORBIDDEN' },
    });

    // The backend writes `error` as user-facing copy. A client that discarded it
    // and substituted a generic message throws away the one sentence that tells
    // the user what to do.
    await expect(billingService.listTimeEntries(MATTER_CONTEXT))
      .rejects.toThrow(/permission to view billing/i);
  });
});

describe('creating a time entry', () => {
  it('sends matterId in the body for a matter context', async () => {
    api.post('/time-entries', { timeEntry: { id: 'te-1' } });

    await billingService.createTimeEntry(MATTER_CONTEXT, { hours: 2 } as never);

    // The backend refuses an entry carrying both matterId and clientId, and
    // refuses one carrying neither. Exactly one has to be sent.
    const body = api.calls('POST')[0].body as Record<string, unknown>;
    expect(body.matterId).toBe('matter-9');
    expect(body.clientId).toBeUndefined();
  });

  it('carries the payload alongside the context', async () => {
    api.post('/time-entries', { timeEntry: { id: 'te-1' } });

    await billingService.createTimeEntry(MATTER_CONTEXT, {
      hours: 2.5, description: 'Drafted the motion', hourlyRate: 250,
    } as never);

    const body = api.calls('POST')[0].body as Record<string, unknown>;
    expect(body.hours).toBe(2.5);
    expect(body.description).toBe('Drafted the motion');
    expect(body.hourlyRate).toBe(250);
  });

  it('unwraps the created entry', async () => {
    api.post('/time-entries', { timeEntry: { id: 'te-created', hours: 2 } });

    const result = await billingService.createTimeEntry(MATTER_CONTEXT, { hours: 2 } as never);

    expect(result.id).toBe('te-created');
  });

  it('throws when the server refuses the create', async () => {
    api.post('/time-entries', { status: 400, body: { error: 'Provide exactly one of matterId or clientId' } });

    // A create that resolved on a 400 would leave the UI showing an entry the
    // server never stored, and it would vanish on the next refresh.
    await expect(billingService.createTimeEntry(MATTER_CONTEXT, { hours: 2 } as never))
      .rejects.toThrow(/exactly one of matterId or clientId/i);
  });

  it('sends JSON content type, the Authorization header and the X-Timezone header', async () => {
    api.post('/time-entries', { timeEntry: { id: 'te-1' } });

    await billingService.createTimeEntry(MATTER_CONTEXT, { hours: 2 } as never);

    const { headers } = api.calls('POST')[0];
    // Header keys are lower-cased by the harness, because `apiFetch` builds a
    // real `Headers` instance and those normalise the casing.
    expect(headers['content-type']).toContain('application/json');
    // An unauthenticated billing write is a 401 the user meets as a failed save.
    expect(headers.authorization).toMatch(/^Bearer /);
    // `requireTimezone` is mounted on the billing router, so a request without
    // this header is refused outright. It is added by `prepareApiFetchOptions`
    // rather than by the service, which is exactly the kind of shared behaviour
    // a stubbed service layer hides.
    expect(headers['x-timezone']).toBeTruthy();
  });
});

describe('updating and deleting a time entry', () => {
  it('PUTs to the context-segmented route with the entry id', async () => {
    api.put('/time-entries/matter/matter-9/te-1', { timeEntry: { id: 'te-1' } });

    await billingService.updateTimeEntry(MATTER_CONTEXT, 'te-1', { hours: 3 } as never);

    // Unlike create, update DOES use the context segment, with the entry id
    // last. The two shapes differ, and mixing them up is a 404 on a save the
    // user believes succeeded.
    const [call] = api.calls('PUT');
    expect(call.pathname).toContain('/time-entries/matter/matter-9/te-1');
  });

  it('escapes an entry id in the path', async () => {
    api.put('/time-entries/matter/matter-9/a%2Fb', { timeEntry: { id: 'x' } });

    await billingService.updateTimeEntry(MATTER_CONTEXT, 'a/b', { hours: 3 } as never);

    expect(api.calls('PUT')[0].url).toContain('a%2Fb');
  });

  it('DELETEs the context-segmented route', async () => {
    api.delete('/time-entries/matter/matter-9/te-1', { status: 200, body: {} });

    await billingService.deleteTimeEntry(MATTER_CONTEXT, 'te-1');

    expect(api.calls('DELETE')[0].pathname).toContain('/time-entries/matter/matter-9/te-1');
  });

  it('throws when a delete is refused', async () => {
    api.delete('/time-entries/matter/matter-9/te-1', {
      status: 403,
      body: { error: 'Cannot delete a time entry that has been billed on an invoice' },
    });

    // The backend freezes a billed entry. The client has to surface that refusal,
    // or the row disappears from the screen and returns on the next load.
    await expect(billingService.deleteTimeEntry(MATTER_CONTEXT, 'te-1'))
      .rejects.toThrow(/billed on an invoice/i);
  });
});

describe('invoices', () => {
  it('lists invoices for a context', async () => {
    api.get('/invoices/matter/matter-9', { invoices: [{ id: 'inv-1' }] });

    const result = await billingService.listInvoices(MATTER_CONTEXT);

    expect(result).toHaveLength(1);
    expect(api.calls('GET')[0].pathname).toContain('/invoices/matter/matter-9');
  });

  it('CHARACTERISATION: getInvoice fetches the whole LIST and filters in the browser', async () => {
    api.get('/invoices/matter/matter-9', {
      invoices: [{ id: 'inv-1' }, { id: 'inv-2' }],
    });

    const result = await billingService.getInvoice(MATTER_CONTEXT, 'inv-2');

    // There is no by-id request. Opening one invoice downloads every invoice on
    // the matter, and each carries its line items, payments and credit notes. On
    // a long-running matter that is the whole billing history to render one page.
    //
    // Recorded rather than changed: adding a by-id endpoint is a backend change,
    // and this at least makes the cost visible. The single GET below is the
    // assertion that matters.
    expect(result.id).toBe('inv-2');
    expect(api.calls('GET')).toHaveLength(1);
    expect(api.calls('GET')[0].pathname).toMatch(/\/invoices\/matter\/matter-9$/);
  });

  it('CHARACTERISATION: a missing invoice throws a bare Error, not an ApiError', async () => {
    api.get('/invoices/matter/matter-9', { invoices: [{ id: 'inv-1' }] });

    // Because the lookup happens client-side, a missing invoice never involves
    // the server, so there is no status and no `code` on the thrown error. Every
    // other failure in this service throws an ApiError carrying both, and
    // callers that branch on `err.code` fall through to a generic message here.
    await expect(billingService.getInvoice(MATTER_CONTEXT, 'nope'))
      .rejects.toThrow(/Invoice not found/);
  });

  it('throws rather than returning a partial list on failure', async () => {
    api.get('/invoices/matter/matter-9', {
      status: 500, body: { error: 'Server error' },
    });

    // An invoice screen rendered from a swallowed failure shows zeroes, which
    // reads as a settled invoice rather than a request that never landed.
    await expect(billingService.getInvoice(MATTER_CONTEXT, 'inv-1')).rejects.toBeDefined();
  });

  it('does not fetch anything the test did not set up', async () => {
    api.get('/invoices/matter/matter-9', { invoices: [] });

    await billingService.listInvoices(MATTER_CONTEXT);

    // The harness throws on an unmatched request, so this passing at all means
    // the service made exactly one call. A service that quietly fanned out to
    // several endpoints would have failed above.
    expect(api.calls()).toHaveLength(1);
  });
});

describe('creating an invoice uses a THIRD context shape', () => {
  it('POSTs to the plain invoices route for a matter', async () => {
    api.post('/invoices', { invoice: { id: 'inv-1' } });

    await billingService.createInvoice(MATTER_CONTEXT, { invoiceName: 'March' } as never);

    // Three different shapes now, all in one service: reads use the
    // `/{type}/{entityId}` path segment, createTimeEntry uses a plain route with
    // matterId or clientId in the body, and THIS uses a different ENDPOINT per
    // context as well as a different body key. Nothing makes the three agree, so
    // each needs pinning separately.
    expect(api.calls('POST')[0].pathname).toMatch(/\/invoices$/);
  });

  it('POSTs to the client-scoped route for a client', async () => {
    api.post('/invoices/client/client-7', { invoice: { id: 'inv-1' } });

    await billingService.createInvoice(CLIENT_CONTEXT, { invoiceName: 'March' } as never);

    expect(api.calls('POST')[0].pathname).toMatch(/\/invoices\/client\/client-7$/);
  });

  it('sends matterId in the body for a matter', async () => {
    api.post('/invoices', { invoice: { id: 'inv-1' } });

    await billingService.createInvoice(MATTER_CONTEXT, { invoiceName: 'March' } as never);

    const body = api.calls('POST')[0].body as Record<string, unknown>;
    expect(body.matterId).toBe('matter-9');
    expect(body.contextClientId).toBeUndefined();
  });

  it('sends contextClientId, NOT clientId, for a client', async () => {
    api.post('/invoices/client/client-7', { invoice: { id: 'inv-1' } });

    await billingService.createInvoice(CLIENT_CONTEXT, { invoiceName: 'March' } as never);

    // `contextClientId`, not `clientId`. createTimeEntry sends `clientId` for the
    // same context, so the two writes disagree on the key name for the same
    // concept. Sending the wrong one here means the server never learns which
    // client the invoice belongs to.
    const body = api.calls('POST')[0].body as Record<string, unknown>;
    expect(body.contextClientId).toBe('client-7');
    expect(body.clientId).toBeUndefined();
    expect(body.matterId).toBeUndefined();
  });

  it('carries the payload alongside the context key', async () => {
    api.post('/invoices', { invoice: { id: 'inv-1' } });

    await billingService.createInvoice(MATTER_CONTEXT, {
      invoiceName: 'March 2026', totalAmount: 1200,
    } as never);

    const body = api.calls('POST')[0].body as Record<string, unknown>;
    expect(body.invoiceName).toBe('March 2026');
    expect(body.totalAmount).toBe(1200);
  });

  it('unwraps the created invoice', async () => {
    api.post('/invoices', { invoice: { id: 'inv-created' } });

    const result = await billingService.createInvoice(MATTER_CONTEXT, {} as never);

    expect(result.id).toBe('inv-created');
  });
});

describe('the error message an invoice failure surfaces', () => {
  it('lifts the first FIELD error out of the details', async () => {
    api.post('/invoices', {
      status: 400,
      body: {
        error: 'Validation failed',
        details: { fieldErrors: { invoiceName: ['Name is required'] } },
      },
    });

    // A generic "Validation failed" tells the user nothing about which field to
    // fix. The service digs the first field message out of the envelope, and
    // that message is what reaches the screen.
    await expect(billingService.createInvoice(MATTER_CONTEXT, {} as never))
      .rejects.toThrow(/Name is required/);
  });

  it('lifts a SPLIT-invoice error out of the details', async () => {
    api.post('/invoices', {
      status: 400,
      body: {
        error: 'Validation failed',
        details: { splitInvoices: ['Invoice totals do not match for "Split A".'] },
      },
    });

    // The split path reports under its own key. Its messages name the specific
    // share that does not reconcile, which is the only actionable part.
    await expect(billingService.createInvoice(MATTER_CONTEXT, {} as never))
      .rejects.toThrow(/Invoice totals do not match/);
  });

  it('lifts a FORM error out of the details', async () => {
    api.post('/invoices', {
      status: 400,
      body: { error: 'Validation failed', details: { formErrors: ['Pick a client first'] } },
    });

    await expect(billingService.createInvoice(MATTER_CONTEXT, {} as never))
      .rejects.toThrow(/Pick a client first/);
  });

  it('falls back to the top-level error when there are no details', async () => {
    api.post('/invoices', { status: 403, body: { error: 'You cannot bill this matter' } });

    // The negative half of the extraction. A service that only ever read
    // `details` would throw an empty message on every error that carries none,
    // which is most of them.
    await expect(billingService.createInvoice(MATTER_CONTEXT, {} as never))
      .rejects.toThrow(/You cannot bill this matter/);
  });

  it('preserves the status and code on the thrown error', async () => {
    api.post('/invoices', {
      status: 403, body: { error: 'Forbidden', code: 'FORBIDDEN' },
    });

    // Callers branch on `code` to tell a permission problem from a validation
    // one. Throwing a bare Error would collapse that distinction.
    await expect(billingService.createInvoice(MATTER_CONTEXT, {} as never))
      .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });
});

describe.each([
  {
    kind: 'flat fees',
    collection: 'flat-fees',
    listKey: 'flatFees',
    itemKey: 'flatFee',
    itemId: 'ff-1',
    list: (context: typeof MATTER_CONTEXT) => billingService.listFlatFees(context),
    add: (context: typeof MATTER_CONTEXT | typeof CLIENT_CONTEXT, payload: object) =>
      billingService.addFlatFee(context, payload as never),
    createContext: CLIENT_CONTEXT,
    contextKey: 'clientId',
    contextId: 'client-7',
    payload: { amount: 500 },
    failure: { status: 500, body: { error: 'Server error' } },
  },
  {
    kind: 'expenses',
    collection: 'expenses',
    listKey: 'expenses',
    itemKey: 'expense',
    itemId: 'ex-1',
    list: (context: typeof MATTER_CONTEXT) => billingService.listExpenses(context),
    add: (context: typeof MATTER_CONTEXT | typeof CLIENT_CONTEXT, payload: object) =>
      billingService.addExpense(context, payload as never),
    createContext: MATTER_CONTEXT,
    contextKey: 'matterId',
    contextId: 'matter-9',
    payload: { amount: 125, description: 'Filing fee' },
    failure: { status: 403, body: { error: 'Forbidden' } },
  },
])('$kind', ({
  collection, listKey, itemKey, itemId, list, add, createContext, contextKey, contextId, payload, failure,
}) => {
  it('lists them under the context segment', async () => {
    api.get(`/${collection}/matter/matter-9`, { [listKey]: [{ id: itemId }] });

    const result = await list(MATTER_CONTEXT);

    expect(result).toHaveLength(1);
    expect(api.calls('GET')[0].pathname).toContain(`/${collection}/matter/matter-9`);
  });

  it('returns an empty array when the key is missing', async () => {
    api.get(`/${collection}/matter/matter-9`, {});

    expect(await list(MATTER_CONTEXT)).toEqual([]);
  });

  it('POSTs a new item with the context in the body', async () => {
    api.post(`/${collection}`, { [itemKey]: { id: itemId } });

    await add(createContext, payload);

    // Back to the createTimeEntry shape: a plain route with `clientId` or
    // `matterId` in the body, NOT the `contextClientId` that createInvoice
    // uses. Three writes, three conventions.
    const body = api.calls('POST')[0].body as Record<string, unknown>;
    expect(body[contextKey]).toBe(contextId);
    expect(body.amount).toBe(payload.amount);
  });

  it('throws when the list fails', async () => {
    api.get(`/${collection}/matter/matter-9`, failure);

    await expect(list(MATTER_CONTEXT)).rejects.toBeDefined();
  });
});

describe('flat fee filtering', () => {
  it('sends unbilledOnly only when asked', async () => {
    api.get('/flat-fees/matter/matter-9', { flatFees: [] });

    await billingService.listFlatFees(MATTER_CONTEXT, { unbilledOnly: true });
    await billingService.listFlatFees(MATTER_CONTEXT);

    expect(api.calls('GET')[0].url).toContain('unbilledOnly=true');
    expect(api.calls('GET')[1].url).not.toContain('unbilledOnly');
  });
});

describe('the firm-wide invoice page', () => {
  const PAGE = { invoices: [], totalItems: 0, statusCounts: {}, summary: {} };

  it('always sends a limit', async () => {
    api.get('/invoices/firm', PAGE);

    await billingService.listFirmInvoicesPage(LAW_FIRM_ID);

    // Without one the server falls back to its own default, and a firm with
    // thousands of invoices downloads all of them to render one page.
    expect(api.calls('GET')[0].url).toContain('limit=10');
  });

  it('CLAMPS a limit above the maximum', async () => {
    api.get('/invoices/firm', PAGE);

    await billingService.listFirmInvoicesPage(LAW_FIRM_ID, { limit: 100000 });

    // The cap is what stops one request pulling a firm's whole billing history.
    // Passing it through unclamped defeats the paging entirely.
    const limit = Number(new URL(api.calls('GET')[0].url, 'http://x').searchParams.get('limit'));
    expect(limit).toBeLessThan(100000);
    expect(limit).toBeGreaterThan(0);
  });

  it('clamps a zero or negative limit up to one', async () => {
    api.get('/invoices/firm', PAGE);

    await billingService.listFirmInvoicesPage(LAW_FIRM_ID, { limit: 0 });

    // `limit=0` reads to most servers as "no rows", so a paginated screen would
    // render empty and look like a firm with no invoices.
    expect(api.calls('GET')[0].url).toContain('limit=1');
  });

  it('sends page when no offset is given', async () => {
    api.get('/invoices/firm', PAGE);

    await billingService.listFirmInvoicesPage(LAW_FIRM_ID, { page: 3 });

    const url = api.calls('GET')[0].url;
    expect(url).toContain('page=3');
    expect(url).not.toContain('offset=');
  });

  it('sends offset INSTEAD of page when an offset is given', async () => {
    api.get('/invoices/firm', PAGE);

    await billingService.listFirmInvoicesPage(LAW_FIRM_ID, { offset: 40, page: 3 });

    // The two are alternative ways to say the same thing. Sending both lets the
    // server pick, and the two callers disagree about which page they are on.
    const url = api.calls('GET')[0].url;
    expect(url).toContain('offset=40');
    expect(url).not.toContain('page=');
  });

  it('clamps a negative page and a negative offset', async () => {
    api.get('/invoices/firm', PAGE);

    await billingService.listFirmInvoicesPage(LAW_FIRM_ID, { page: -5 });
    await billingService.listFirmInvoicesPage(LAW_FIRM_ID, { offset: -20 });

    expect(api.calls('GET')[0].url).toContain('page=1');
    expect(api.calls('GET')[1].url).toContain('offset=0');
  });

  it('passes each filter through under its own key', async () => {
    api.get('/invoices/firm', PAGE);

    await billingService.listFirmInvoicesPage(LAW_FIRM_ID, {
      matterId: 'matter-9', clientId: 'client-7', status: 'overdue',
      dateFrom: '2026-01-01', dateTo: '2026-03-31',
    } as never);

    // Each filter narrows what a firm is looking at. One dropped silently widens
    // the result, and the screen shows more than the user asked for without
    // saying so.
    const url = api.calls('GET')[0].url;
    for (const pair of ['matterId=matter-9', 'clientId=client-7', 'status=overdue',
      'dateFrom=2026-01-01', 'dateTo=2026-03-31']) {
      expect(url).toContain(pair);
    }
  });

  it('OMITS a filter that was not given', async () => {
    api.get('/invoices/firm', PAGE);

    await billingService.listFirmInvoicesPage(LAW_FIRM_ID, { status: 'overdue' } as never);

    // The negative half. Sending `matterId=undefined` filters to a matter of
    // that name, which is none, and the screen shows an empty firm.
    const url = api.calls('GET')[0].url;
    expect(url).not.toContain('matterId');
    expect(url).not.toContain('clientId');
  });

  it('sends the boolean flags only when true', async () => {
    api.get('/invoices/firm', PAGE);

    await billingService.listFirmInvoicesPage(LAW_FIRM_ID, { awaitingOnly: true } as never);
    await billingService.listFirmInvoicesPage(LAW_FIRM_ID, { awaitingOnly: false } as never);

    expect(api.calls('GET')[0].url).toContain('awaitingOnly=true');
    // `awaitingOnly=false` is a truthy STRING on the server side, so sending it
    // would filter when the user asked not to.
    expect(api.calls('GET')[1].url).not.toContain('awaitingOnly');
  });

  it('fills in every field of the page envelope', async () => {
    api.get('/invoices/firm', {});

    const page = await billingService.listFirmInvoicesPage(LAW_FIRM_ID);

    // A server response missing a key must not become `undefined` on a page the
    // UI maps and sums over. Each default has to be the right SHAPE, not just
    // non-null.
    expect(page.invoices).toEqual([]);
    expect(page.totalItems).toBe(0);
    expect(page.statusCounts).toEqual({});
    expect(page.summary).toEqual({
      ownedCount: 0, totalBilled: 0, totalPaid: 0, totalOutstanding: 0,
    });
  });

  it('keeps the server values when they ARE present', async () => {
    api.get('/invoices/firm', {
      invoices: [{ id: 'inv-1' }],
      totalItems: 42,
      statusCounts: { overdue: 3 },
      summary: { ownedCount: 1, totalBilled: 100, totalPaid: 40, totalOutstanding: 60 },
    });

    const page = await billingService.listFirmInvoicesPage(LAW_FIRM_ID);

    // The positive half. Defaults that overwrote real values would show every
    // firm a zeroed billing summary.
    expect(page.totalItems).toBe(42);
    expect(page.summary.totalOutstanding).toBe(60);
    expect(page.statusCounts).toEqual({ overdue: 3 });
  });

  it('throws rather than returning an empty page on failure', async () => {
    api.get('/invoices/firm', { status: 500, body: { error: 'Server error' } });

    // An empty page rendered from a swallowed failure reads as a firm with no
    // invoices, which is the most alarming thing a billing screen can say
    // incorrectly.
    await expect(billingService.listFirmInvoicesPage(LAW_FIRM_ID)).rejects.toBeDefined();
  });
});

describe('the three payment operations share one path and differ by VERB', () => {
  const PAY = '/invoices/matter/matter-9/inv-1/payment';

  it('RECORDS a payment with PUT', async () => {
    api.put(PAY, { invoice: { id: 'inv-1' } });

    await billingService.updateInvoicePayment(MATTER_CONTEXT, 'inv-1', { paymentAmount: 200 } as never);

    // One url, three verbs: PUT records, PATCH edits, DELETE removes. The server
    // routes on the method alone, so a wrong verb silently performs a different
    // money operation than the one the user asked for.
    expect(api.calls('PUT')[0].pathname).toContain(PAY);
    expect(api.calls('PATCH')).toHaveLength(0);
    expect(api.calls('DELETE')).toHaveLength(0);
  });

  it('EDITS a payment with PATCH', async () => {
    api.patch(PAY, { invoice: { id: 'inv-1' } });

    await billingService.editInvoicePayment(MATTER_CONTEXT, 'inv-1', {
      paymentIndex: 0, amount: 350,
    } as never);

    expect(api.calls('PATCH')[0].pathname).toContain(PAY);
    expect(api.calls('PUT')).toHaveLength(0);
  });

  it('DELETES a payment with the index in the QUERY, not the path', async () => {
    api.delete(PAY, { invoice: { id: 'inv-1' } });

    await billingService.deleteInvoicePayment(MATTER_CONTEXT, 'inv-1', 0);

    // The index identifies WHICH payment to remove. Putting it in the path would
    // hit a different route; omitting it would leave the server guessing, and
    // guessing here deletes the wrong receipt.
    const call = api.calls('DELETE')[0];
    expect(call.url).toContain('paymentIndex=0');
    expect(call.pathname).toMatch(/\/payment$/);
  });

  it('DELETES by payment id when one is given, keeping the index beside it', async () => {
    api.delete(PAY, { invoice: { id: 'inv-1' } });

    await billingService.deleteInvoicePayment(MATTER_CONTEXT, 'inv-1', 2, 'pay-uuid-1');

    const call = api.calls('DELETE')[0];
    expect(call.query).toEqual({ paymentIndex: ['2'], paymentId: ['pay-uuid-1'] });
  });

  it('UN-PAYS an installment naming the payment that settled it', async () => {
    api.delete('/payment-plan/installment/1/payment', { invoice: { id: 'inv-1' } });

    await billingService.unpayInstallment(MATTER_CONTEXT, 'inv-1', 1, 'pay-uuid-1');

    const call = api.calls('DELETE')[0];
    expect(call.pathname).toMatch(/\/payment-plan\/installment\/1\/payment$/);
    expect(call.query).toEqual({ paymentId: ['pay-uuid-1'] });
  });

  it('sends index ZERO rather than dropping it as falsy', async () => {
    api.delete(PAY, { invoice: { id: 'inv-1' } });

    await billingService.deleteInvoicePayment(MATTER_CONTEXT, 'inv-1', 0);

    // The first payment on an invoice has index 0. A truthiness guard around the
    // parameter would drop it exactly for the most common case, and the server
    // would delete nothing or the wrong entry.
    expect(api.calls('DELETE')[0].url).toContain('paymentIndex=0');
  });

  it('carries the payment amount in the body', async () => {
    api.put(PAY, { invoice: { id: 'inv-1' } });

    await billingService.updateInvoicePayment(MATTER_CONTEXT, 'inv-1', {
      paymentAmount: 200, paidDate: '2026-03-20',
    } as never);

    const body = api.calls('PUT')[0].body as Record<string, unknown>;
    expect(body.paymentAmount).toBe(200);
    expect(body.paidDate).toBe('2026-03-20');
  });

  it('uses the CLIENT segment for a client context', async () => {
    api.put('/invoices/client/client-7/inv-1/payment', { invoice: { id: 'inv-1' } });

    await billingService.updateInvoicePayment(CLIENT_CONTEXT, 'inv-1', { paymentAmount: 200 } as never);

    expect(api.calls('PUT')[0].pathname).toContain('/invoices/client/client-7/');
  });

  it('returns the UPDATED invoice, not the payment', async () => {
    api.put(PAY, { invoice: { id: 'inv-1', amountPaid: 200, balanceDue: 800 } });

    const result = await billingService.updateInvoicePayment(
      MATTER_CONTEXT, 'inv-1', { paymentAmount: 200 } as never,
    );

    // The caller re-renders the invoice from this. Returning the payment instead
    // would leave the screen showing the old balance after a successful save.
    expect(result.id).toBe('inv-1');
    expect((result as never as Record<string, unknown>).amountPaid).toBe(200);
  });

  it('throws when the server refuses a payment', async () => {
    api.put(PAY, { status: 400, body: { error: 'Payment exceeds the balance due' } });

    // A payment that resolved on a 400 shows the user a settled invoice while the
    // server still has it outstanding.
    await expect(
      billingService.updateInvoicePayment(MATTER_CONTEXT, 'inv-1', { paymentAmount: 999 } as never),
    ).rejects.toThrow(/exceeds the balance due/i);
  });

  it('throws when a payment delete is refused', async () => {
    api.delete(PAY, { status: 403, body: { error: 'Forbidden' } });

    await expect(billingService.deleteInvoicePayment(MATTER_CONTEXT, 'inv-1', 0))
      .rejects.toBeDefined();
  });
});

describe('split invoices', () => {
  const SPLIT = '/invoices/matter/matter-9/split';

  it('POSTs to the matter split route', async () => {
    api.post(SPLIT, { splitGroupId: 'grp-1', createdCount: 2, invoices: [] });

    await billingService.createSplitInvoices(LAW_FIRM_ID, 'matter-9', {} as never);

    // Splitting is matter-only: it divides one matter's work between the clients
    // on it, so there is no client-context form of this call.
    expect(api.calls('POST')[0].pathname).toMatch(/\/invoices\/matter\/matter-9\/split$/);
  });

  it('sends the payload through unchanged', async () => {
    api.post(SPLIT, { splitGroupId: 'grp-1', createdCount: 2, invoices: [] });

    const payload = {
      invoiceDate: '2026-03-15',
      splitMode: 'equal',
      sourceSelection: { timeEntries: ['te-1'], flatFees: [] },
      invoices: [
        { matterClientId: 'c1', invoiceName: 'Split A', totalAmount: 200, totalHours: 2 },
        { matterClientId: 'c2', invoiceName: 'Split B', totalAmount: 200, totalHours: 2 },
      ],
    };

    await billingService.createSplitInvoices(LAW_FIRM_ID, 'matter-9', payload as never);

    // The server cross-checks every figure in here against the work being billed
    // and refuses the whole request if any of them disagree. A client that
    // reshaped or dropped part of the payload turns a valid split into a
    // rejection the user cannot explain.
    expect(api.calls('POST')[0].body).toEqual(payload);
  });

  it('returns the split group id and count', async () => {
    api.post(SPLIT, {
      splitGroupId: 'grp-1', createdCount: 2, invoices: [{ id: 'inv-1' }, { id: 'inv-2' }],
    });

    const result = await billingService.createSplitInvoices(LAW_FIRM_ID, 'matter-9', {} as never);

    // The group id is what ties the shares together afterwards. Losing it leaves
    // two invoices that look unrelated.
    expect(result.splitGroupId).toBe('grp-1');
    expect(result.createdCount).toBe(2);
    expect(result.invoices).toHaveLength(2);
  });

  it('escapes a matter id in the path', async () => {
    api.post('/invoices/matter/a%2Fb/split', { splitGroupId: 'g', createdCount: 0, invoices: [] });

    await billingService.createSplitInvoices(LAW_FIRM_ID, 'a/b', {} as never);

    expect(api.calls('POST')[0].url).toContain('a%2Fb');
  });

  it('surfaces the SPECIFIC share that does not reconcile', async () => {
    api.post(SPLIT, {
      status: 400,
      body: {
        error: 'Validation failed',
        details: { splitInvoices: ['Invoice totals do not match for "Split A".'] },
      },
    });

    // The server names the share. That name is the only actionable part of the
    // message, and a client that showed "Validation failed" instead leaves the
    // user re-checking every share by hand.
    await expect(billingService.createSplitInvoices(LAW_FIRM_ID, 'matter-9', {} as never))
      .rejects.toThrow(/Split A/);
  });

  it('falls back to the top-level error when there are no details', async () => {
    api.post(SPLIT, { status: 403, body: { error: 'You cannot bill this matter' } });

    await expect(billingService.createSplitInvoices(LAW_FIRM_ID, 'matter-9', {} as never))
      .rejects.toThrow(/You cannot bill this matter/);
  });
});

/**
 * Exact-path cases for the firm-level billing reads and settings. Each method
 * checks `response.ok` itself, so where the server sends no reason the message
 * the user reads is the method's own fallback: those rows pin that the method's
 * OWN guard ran rather than an error body being unwrapped as data.
 */
const BILLING = `/api/lawfirms/${LAW_FIRM_ID}/billing`;
const CONNECT = `/api/stripe/connect/${LAW_FIRM_ID}`;
const TRUST_CONNECT = `/api/stripe/trust-connect/${LAW_FIRM_ID}/acct-1`;

function onlyCall(method: string) {
  const calls = api.calls(method);
  expect(calls).toHaveLength(1);
  return calls[0];
}

async function rejectionOf(promise: Promise<unknown>): Promise<ApiError> {
  return promise.then(
    () => { throw new Error('expected the call to reject'); },
    (error: unknown) => error as ApiError,
  );
}

type Verb = 'get' | 'post' | 'put' | 'delete';
function registerExact(method: Verb, path: string, handler: object) {
  const register = { get: api.getExact, post: api.postExact, put: api.putExact, delete: api.deleteExact }[method];
  register(path, handler);
}

describe('firm billing settings', () => {
  it('GETs the settings and returns them unwrapped', async () => {
    api.getExact(`${BILLING}/settings`, { settings: { clientPaymentEmails: true } });

    await expect(billingService.getBillingSettings(LAW_FIRM_ID)).resolves.toEqual({ clientPaymentEmails: true });
  });

  it('PUTs exactly the toggle and returns the saved settings', async () => {
    api.putExact(`${BILLING}/settings`, { settings: { clientPaymentEmails: false } });

    const saved = await billingService.updateBillingSettings(LAW_FIRM_ID, { clientPaymentEmails: false });

    expect(onlyCall('PUT').body).toEqual({ clientPaymentEmails: false });
    expect(saved).toEqual({ clientPaymentEmails: false });
  });
});

describe('the billing dashboard reads', () => {
  it('returns the billing summary body as is, with the viewer timezone sent', async () => {
    const summary = { totalBilledThisMonth: 1200.5, totalOutstanding: 300 };
    api.getExact(`${BILLING}/analytics/billing-summary`, summary);

    await expect(billingService.getBillingSummary(LAW_FIRM_ID)).resolves.toEqual(summary);
    // "This month" is the viewer's calendar month; the route requires the zone.
    expect(onlyCall('GET').headers['x-timezone']).toBeTruthy();
  });

  it('sends the attention window, keeping a zero page', async () => {
    api.getExact(`${BILLING}/workbench?attentionLimit=5&attentionPage=0`, { attention: [] });

    await expect(billingService.getBillingWorkbench(LAW_FIRM_ID, { attentionLimit: 5, attentionPage: 0 }))
      .resolves.toEqual({ attention: [] });
  });

  it('sends no query for the default workbench', async () => {
    api.getExact(`${BILLING}/workbench`, { attention: [] });

    await billingService.getBillingWorkbench(LAW_FIRM_ID);

    expect(onlyCall('GET').search).toBe('');
  });

  it('bounds the payment calendar to the window given', async () => {
    const dates = [{ invoiceId: 'inv-1', date: '2026-03-15', amount: 500 }];
    api.getExact(`${BILLING}/invoices/calendar-payment-dates?from=2026-03-01&to=2026-03-31`, { paymentDates: dates });

    await expect(billingService.getCalendarPaymentDates(LAW_FIRM_ID, { from: '2026-03-01', to: '2026-03-31' }))
      .resolves.toEqual(dates);
  });

  it('reads the unbounded payment calendar with no query, and defaults a bare envelope to empty', async () => {
    api.getExact(`${BILLING}/invoices/calendar-payment-dates`, {});

    await expect(billingService.getCalendarPaymentDates(LAW_FIRM_ID)).resolves.toEqual([]);
  });

  it('lists a client invoices through the client context segment', async () => {
    api.getExact(`${BILLING}/invoices/client/client-7`, { invoices: [{ id: 'inv-1' }] });

    await expect(billingService.listClientInvoices(LAW_FIRM_ID, 'client-7')).resolves.toEqual([{ id: 'inv-1' }]);
  });
});

describe('charge codes', () => {
  it('asks for active codes only by default', async () => {
    api.getExact(`${BILLING}/charge-codes?includeInactive=false`, { chargeCodes: [{ id: 'cc-1' }] });

    await expect(billingService.getChargeCodes(LAW_FIRM_ID)).resolves.toEqual({ chargeCodes: [{ id: 'cc-1' }] });
  });

  it('asks for inactive codes too when told to', async () => {
    api.getExact(`${BILLING}/charge-codes?includeInactive=true`, { chargeCodes: [] });

    await billingService.getChargeCodes(LAW_FIRM_ID, true);

    expect(api.calls('GET')).toHaveLength(1);
  });

  it('reads one code by id and returns the body as is', async () => {
    api.getExact(`${BILLING}/charge-codes/cc-1`, { id: 'cc-1', code: 'LIT' });

    await expect(billingService.getChargeCode(LAW_FIRM_ID, 'cc-1')).resolves.toEqual({ id: 'cc-1', code: 'LIT' });
  });

  it('PUTs an edit to the code by id', async () => {
    api.putExact(`${BILLING}/charge-codes/cc-1`, { message: 'Updated' });

    await expect(billingService.updateChargeCode(LAW_FIRM_ID, 'cc-1', { isActive: false }))
      .resolves.toEqual({ message: 'Updated' });
    expect(onlyCall('PUT').body).toEqual({ isActive: false });
  });

  it('DELETEs a code by id', async () => {
    api.deleteExact(`${BILLING}/charge-codes/cc-1`, { message: 'Deleted' });

    await expect(billingService.deleteChargeCode(LAW_FIRM_ID, 'cc-1')).resolves.toEqual({ message: 'Deleted' });
  });

  it('PUTs the full new order as an id list', async () => {
    api.putExact(`${BILLING}/charge-codes/reorder`, { message: 'Reordered' });

    await billingService.reorderChargeCodes(LAW_FIRM_ID, ['cc-3', 'cc-1', 'cc-2']);

    expect(onlyCall('PUT').body).toEqual({ chargeCodeIds: ['cc-3', 'cc-1', 'cc-2'] });
  });
});

describe('expense categories', () => {
  it('POSTs a new category and returns its id', async () => {
    api.postExact(`${BILLING}/expense-categories`, { message: 'Created', expenseCategoryId: 'ec-1' });

    const result = await billingService.createExpenseCategory(LAW_FIRM_ID, { code: 'TRV', name: 'Travel' });

    expect(onlyCall('POST').body).toEqual({ code: 'TRV', name: 'Travel' });
    expect(result).toEqual({ message: 'Created', expenseCategoryId: 'ec-1' });
  });

  it('PUTs an edit to one category by id', async () => {
    api.putExact(`${BILLING}/expense-categories/ec-1`, { message: 'Updated' });

    await expect(billingService.updateExpenseCategory(LAW_FIRM_ID, 'ec-1', { isActive: false }))
      .resolves.toEqual({ message: 'Updated' });
    expect(onlyCall('PUT').body).toEqual({ isActive: false });
  });

  it('DELETEs one category by id', async () => {
    api.deleteExact(`${BILLING}/expense-categories/ec-1`, { message: 'Deleted' });

    await expect(billingService.deleteExpenseCategory(LAW_FIRM_ID, 'ec-1')).resolves.toEqual({ message: 'Deleted' });
  });

  it('PUTs the full new order as an id list', async () => {
    api.putExact(`${BILLING}/expense-categories/reorder`, { message: 'Reordered' });

    await billingService.reorderExpenseCategories(LAW_FIRM_ID, ['ec-2', 'ec-1']);

    expect(onlyCall('PUT').body).toEqual({ expenseCategoryIds: ['ec-2', 'ec-1'] });
  });
});

/**
 * `requestDeduplicator.execute` resolves to the PARSED BODY and throws an
 * ApiError itself on a refusal. Treating its result as a `Response` once made
 * every successful read take the error branch, because a JSON body has no `ok`.
 */
describe('reads routed through the request deduplicator', () => {
  it('getUtbmsCodes resolves with the codes the server sent', async () => {
    const codes = { taskCodes: [{ code: 'L110', label: 'Fact investigation' }], activityCodes: [], expenseCodes: [] };
    api.getExact(`${BILLING}/utbms-codes`, codes);

    await expect(billingService.getUtbmsCodes(LAW_FIRM_ID)).resolves.toEqual(codes);
  });

  it('listExpenseCategories resolves with the categories the server sent', async () => {
    const body = { expenseCategories: [{ id: 'ec-1', code: 'TRV', name: 'Travel' }] };
    api.getExact(`${BILLING}/expense-categories`, body);

    await expect(billingService.listExpenseCategories(LAW_FIRM_ID)).resolves.toEqual(body);
  });

  it('rejects when the UTBMS read is refused', async () => {
    api.getExact(`${BILLING}/utbms-codes`, { status: 403, body: { error: 'Forbidden' } });

    await expect(billingService.getUtbmsCodes(LAW_FIRM_ID)).rejects.toMatchObject({ status: 403 });
    expect(onlyCall('GET').pathname).toBe(`${BILLING}/utbms-codes`);
  });

  it('asks for inactive expense categories with a query flag', async () => {
    api.getExact(`${BILLING}/expense-categories?includeInactive=true`, { expenseCategories: [] });

    await billingService.listExpenseCategories(LAW_FIRM_ID, true);

    expect(onlyCall('GET').search).toBe('?includeInactive=true');
  });
});

describe('the firm operating account on Stripe Connect', () => {
  it('starts onboarding with an empty JSON body and returns the redirect url', async () => {
    api.postExact(`${CONNECT}/create-account`, { url: 'https://connect.stripe.test/onboard', accountId: 'acct_1' });

    await expect(billingService.createFirmConnectAccount(LAW_FIRM_ID))
      .resolves.toEqual({ url: 'https://connect.stripe.test/onboard', accountId: 'acct_1' });
    expect(onlyCall('POST').body).toEqual({});
  });

  it('returns the connection status body as is', async () => {
    const status = { connected: true, stripeAccountId: 'acct_1', chargesEnabled: true, payoutsEnabled: false, onboardingComplete: false };
    api.getExact(`${CONNECT}/status`, status);

    await expect(billingService.getFirmConnectStatus(LAW_FIRM_ID)).resolves.toEqual(status);
  });

  it('reads a dashboard link', async () => {
    api.getExact(`${CONNECT}/dashboard-link`, { url: 'https://dashboard.stripe.test' });

    await expect(billingService.getFirmConnectDashboardLink(LAW_FIRM_ID)).resolves.toEqual({ url: 'https://dashboard.stripe.test' });
  });

  it('disconnects with a DELETE on the firm route', async () => {
    api.deleteExact(CONNECT, { disconnected: true });

    await expect(billingService.disconnectFirmConnect(LAW_FIRM_ID)).resolves.toEqual({ disconnected: true });
  });
});

describe('a trust account on Stripe Connect is addressed by firm AND trust account', () => {
  it('starts onboarding for that one trust account', async () => {
    api.postExact(`${TRUST_CONNECT}/create-account`, { url: 'https://connect.stripe.test/t', accountId: 'acct_t' });

    await expect(billingService.createTrustConnectAccount(LAW_FIRM_ID, 'acct-1'))
      .resolves.toEqual({ url: 'https://connect.stripe.test/t', accountId: 'acct_t' });
    expect(onlyCall('POST').body).toEqual({});
  });

  it('reads that trust account status', async () => {
    const status = { connected: false, chargesEnabled: false, payoutsEnabled: false, onboardingComplete: false };
    api.getExact(`${TRUST_CONNECT}/status`, status);

    await expect(billingService.getTrustConnectStatus(LAW_FIRM_ID, 'acct-1')).resolves.toEqual(status);
  });

  it('reads that trust account dashboard link', async () => {
    api.getExact(`${TRUST_CONNECT}/dashboard-link`, { url: 'https://dashboard.stripe.test/t' });

    await expect(billingService.getTrustConnectDashboardLink(LAW_FIRM_ID, 'acct-1')).resolves.toEqual({ url: 'https://dashboard.stripe.test/t' });
  });

  it('disconnects that trust account only', async () => {
    api.deleteExact(TRUST_CONNECT, { disconnected: true });

    await expect(billingService.disconnectTrustConnect(LAW_FIRM_ID, 'acct-1')).resolves.toEqual({ disconnected: true });
  });
});

describe('a refusal with no server reason throws the method\'s own message', () => {
  const rows: Array<[string, Verb, string, () => Promise<unknown>, string]> = [
    ['getBillingSettings', 'get', `${BILLING}/settings`, () => billingService.getBillingSettings(LAW_FIRM_ID), 'Failed to fetch billing settings'],
    ['updateBillingSettings', 'put', `${BILLING}/settings`, () => billingService.updateBillingSettings(LAW_FIRM_ID, { clientPaymentEmails: true }), 'Failed to update billing settings'],
    ['getBillingSummary', 'get', `${BILLING}/analytics/billing-summary`, () => billingService.getBillingSummary(LAW_FIRM_ID), 'Failed to fetch billing summary'],
    ['getBillingWorkbench', 'get', `${BILLING}/workbench`, () => billingService.getBillingWorkbench(LAW_FIRM_ID), 'Failed to fetch billing workbench'],
    ['getCalendarPaymentDates', 'get', `${BILLING}/invoices/calendar-payment-dates`, () => billingService.getCalendarPaymentDates(LAW_FIRM_ID), 'Failed to fetch payment dates'],
    ['getChargeCodes', 'get', `${BILLING}/charge-codes?includeInactive=false`, () => billingService.getChargeCodes(LAW_FIRM_ID), 'Failed to fetch charge codes'],
    ['getChargeCode', 'get', `${BILLING}/charge-codes/cc-1`, () => billingService.getChargeCode(LAW_FIRM_ID, 'cc-1'), 'Failed to fetch charge code'],
    ['createChargeCode', 'post', `${BILLING}/charge-codes`, () => billingService.createChargeCode(LAW_FIRM_ID, { code: 'c', name: 'n' }), 'Failed to create charge code'],
    ['updateChargeCode', 'put', `${BILLING}/charge-codes/cc-1`, () => billingService.updateChargeCode(LAW_FIRM_ID, 'cc-1', {}), 'Failed to update charge code'],
    ['deleteChargeCode', 'delete', `${BILLING}/charge-codes/cc-1`, () => billingService.deleteChargeCode(LAW_FIRM_ID, 'cc-1'), 'Failed to delete charge code'],
    ['reorderChargeCodes', 'put', `${BILLING}/charge-codes/reorder`, () => billingService.reorderChargeCodes(LAW_FIRM_ID, []), 'Failed to reorder charge codes'],
    ['createExpenseCategory', 'post', `${BILLING}/expense-categories`, () => billingService.createExpenseCategory(LAW_FIRM_ID, { code: 'c', name: 'n' }), 'Failed to create expense category'],
    ['updateExpenseCategory', 'put', `${BILLING}/expense-categories/ec-1`, () => billingService.updateExpenseCategory(LAW_FIRM_ID, 'ec-1', {}), 'Failed to update expense category'],
    ['deleteExpenseCategory', 'delete', `${BILLING}/expense-categories/ec-1`, () => billingService.deleteExpenseCategory(LAW_FIRM_ID, 'ec-1'), 'Failed to delete expense category'],
    ['reorderExpenseCategories', 'put', `${BILLING}/expense-categories/reorder`, () => billingService.reorderExpenseCategories(LAW_FIRM_ID, []), 'Failed to reorder expense categories'],
    ['createFirmConnectAccount', 'post', `${CONNECT}/create-account`, () => billingService.createFirmConnectAccount(LAW_FIRM_ID), 'Failed to connect Stripe'],
    ['getFirmConnectStatus', 'get', `${CONNECT}/status`, () => billingService.getFirmConnectStatus(LAW_FIRM_ID), 'Failed to load payment settings'],
    ['getFirmConnectDashboardLink', 'get', `${CONNECT}/dashboard-link`, () => billingService.getFirmConnectDashboardLink(LAW_FIRM_ID), 'Failed to open Stripe dashboard'],
    ['disconnectFirmConnect', 'delete', CONNECT, () => billingService.disconnectFirmConnect(LAW_FIRM_ID), 'Failed to disconnect Stripe'],
    ['createTrustConnectAccount', 'post', `${TRUST_CONNECT}/create-account`, () => billingService.createTrustConnectAccount(LAW_FIRM_ID, 'acct-1'), 'Failed to start trust account onboarding'],
    ['getTrustConnectStatus', 'get', `${TRUST_CONNECT}/status`, () => billingService.getTrustConnectStatus(LAW_FIRM_ID, 'acct-1'), 'Failed to fetch trust account connection status'],
    ['getTrustConnectDashboardLink', 'get', `${TRUST_CONNECT}/dashboard-link`, () => billingService.getTrustConnectDashboardLink(LAW_FIRM_ID, 'acct-1'), 'Failed to open Stripe dashboard'],
    ['disconnectTrustConnect', 'delete', TRUST_CONNECT, () => billingService.disconnectTrustConnect(LAW_FIRM_ID, 'acct-1'), 'Failed to disconnect trust bank account'],
  ];

  it.each(rows)('%s', async (_name, method, path, run, message) => {
    registerExact(method, path, { status: 422, body: {} });

    const error = await rejectionOf(run());

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe(message);
    expect(error.status).toBe(422);
  });
});
