/**
 * The client portal service, tested OFFLINE against a fake transport.
 *
 * `client-portal.service.ts` reports 0%. It is the whole surface a person
 * OUTSIDE the firm reads the firm through: their matters, their invoices, the
 * documents the firm chose to share, and the threads they can post into. Every
 * request it builds carries two identities that have to agree - which FIRM is
 * being read, and which of the caller's client records they are reading it AS -
 * and the second one is the newer of the two, so it is the one a method is
 * likely to drop.
 *
 * WHAT GETS THE MOST ATTENTION
 * 1. `clientRecordId` placement. `withClientRecordId` appends it to the QUERY
 *    for every method, GET and POST alike, matching how `portal.routes.ts` reads
 *    it (`req.query?.clientRecordId || req.body?.clientRecordId`). A method that
 *    put it in the body instead would still work today and silently stop working
 *    the moment that route's body becomes `.strict()`-validated.
 * 2. Refusals. A portal read that swallowed a 403 and returned an empty list
 *    tells a client they have no invoices, no documents and no matters, which
 *    is indistinguishable from a firm that has shared nothing with them.
 * 3. Uploads. Three methods here hand-build an `XMLHttpRequest` because `fetch`
 *    has no request-progress API, so they attach the credential themselves and
 *    are invisible to a fetch-level fake. `xhrMock` covers those.
 *
 * Money is integer cents end to end (`outstandingBalanceCents`, `amountCents`).
 * The assertions compare the number, not its rendering, because a service that
 * divided by 100 somewhere would still produce a string containing the digits.
 */
jest.unmock('@/services/client-portal.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import { installXhrMock, formDataValues, formDataFieldOrder, type XhrMock } from '../../support/xhrMock';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import clientPortalService from '@/services/client-portal.service';

const LAW_FIRM_ID = 'firm-1';
const MATTER_ID = 'matter-9';
const CLIENT_RECORD_ID = 'client-record-3';

let api: ApiMock;
let xhr: XhrMock;

/** Query parameters of a recorded call, read back the way a server reads them. */
const paramsOf = (url: string): URLSearchParams => new URL(url, 'http://x').searchParams;

const fileNamed = (name: string, type = 'application/pdf'): File =>
  new File(['x'], name, { type });

beforeEach(() => {
  api = installApiMock();
  xhr = installXhrMock();
  // The dev-only duplicate-GET guard warns when a spec hits the same endpoint
  // twice inside its window, which is normal here and would otherwise bury the
  // real output.
  __resetDuplicateRequestGuard();
});

afterEach(() => {
  api.restore();
  xhr.restore();
});

describe('the firms a client belongs to', () => {
  it('GETs the firm summaries route', async () => {
    api.get('/firm-summaries', { lawFirms: [] });

    await clientPortalService.getFirmSummaries();

    // One request for every firm plus its counts. The route exists so the
    // dashboard does not fan out per firm just to read a matter count.
    expect(api.calls('GET')[0].pathname).toMatch(/\/firm-summaries$/);
  });

  it('keeps the outstanding balance in the integer cents the backend sent', async () => {
    api.get('/firm-summaries', {
      lawFirms: [{ id: LAW_FIRM_ID, name: 'Firm', matterCount: 2, outstandingBalanceCents: 123456 }],
    });

    const { lawFirms } = await clientPortalService.getFirmSummaries();

    // Compared as a NUMBER. A service that pre-divided by 100 for display would
    // hand the dashboard 1234.56 and the dashboard would divide again, showing a
    // client a bill of $12.35 against a real balance of $1,234.56.
    expect(lawFirms[0].outstandingBalanceCents).toBe(123456);
  });

  it('defaults a missing lawFirms list to an empty array', async () => {
    api.get('/firm-summaries', {});

    // The dashboard maps over this. `undefined` is a crash on the client's first
    // screen after signing in.
    expect((await clientPortalService.getFirmSummaries()).lawFirms).toEqual([]);
  });

  it('keeps the firms the server sent', async () => {
    api.get('/firm-summaries', { lawFirms: [{ id: 'a' }, { id: 'b' }] });

    // The positive half: a guard that replaced a real list with `[]` would show
    // every client an empty dashboard and look like a permissions problem.
    expect((await clientPortalService.getFirmSummaries()).lawFirms).toHaveLength(2);
  });

  it('reads features from the MATCHING firm, not the first one', async () => {
    api.get('/my-lawfirms', {
      lawFirms: [
        { id: 'other-firm', name: 'Other', features: { billing: false } },
        { id: LAW_FIRM_ID, name: 'Ours', features: { billing: true } },
      ],
    });

    const features = await clientPortalService.getLawFirmFeatures(LAW_FIRM_ID);

    // Features decide which portal tabs exist. Reading them off the wrong firm
    // shows a client a billing tab their firm turned off, or hides one it pays
    // for.
    expect(features).toEqual({ billing: true });
  });

  it('answers null for a firm the client is not associated with', async () => {
    api.get('/my-lawfirms', { lawFirms: [{ id: 'other-firm', features: { billing: true } }] });

    // Not a fallback to whatever firm happens to be first. A client who reaches
    // a firm id they have no association with must get nothing back from it.
    expect(await clientPortalService.getLawFirmFeatures(LAW_FIRM_ID)).toBeNull();
  });

  it('CHARACTERISATION: throws when /my-lawfirms omits the list entirely', async () => {
    api.get('/my-lawfirms', {});

    // `getFirmSummaries` guards its array and this path does not, so the two
    // sibling reads fail differently on the same malformed payload: one degrades
    // to empty, this one throws a TypeError out of `.find`. Recorded so the
    // asymmetry is visible rather than discovered in a portal that will not load.
    await expect(clientPortalService.getLawFirmFeatures(LAW_FIRM_ID)).rejects.toBeDefined();
  });
});

describe('associations', () => {
  it('GETs the associations for one firm, with the firm in the path', async () => {
    api.get('/associations', { associations: [] });

    await clientPortalService.getAssociations(LAW_FIRM_ID);

    const { pathname } = api.calls('GET')[0];
    expect(pathname).toContain(`/lawfirm/${LAW_FIRM_ID}/`);
    expect(pathname).toMatch(/\/associations$/);
  });

  it('returns EVERY association rather than the first', async () => {
    api.get('/associations', {
      associations: [
        { clientRecordId: 'c1', clientType: 'person', clientName: 'Pat', companyLinkId: null, canViewBilling: true },
        { clientRecordId: 'c2', clientType: 'company', clientName: 'Acme', companyLinkId: 'l1', canViewBilling: false },
      ],
    });

    const { associations } = await clientPortalService.getAssociations(LAW_FIRM_ID);

    // The portal auto-selects when there is exactly one and offers a switcher
    // otherwise. Losing the second entry silently locks a person who acts for a
    // company into whichever record came back first.
    expect(associations.map((a) => a.clientRecordId)).toEqual(['c1', 'c2']);
  });

  it('preserves canViewBilling: false', async () => {
    api.get('/associations', {
      associations: [{ clientRecordId: 'c2', clientType: 'company', clientName: 'Acme', companyLinkId: 'l1', canViewBilling: false }],
    });

    const { associations } = await clientPortalService.getAssociations(LAW_FIRM_ID);

    // This flag is the difference between a company contact who sees the
    // organization's invoices and one who must not. A default applied over a
    // false would open a firm's billing to the wrong person on the roster.
    expect(associations[0].canViewBilling).toBe(false);
  });

  it('defaults a missing associations list to an empty array', async () => {
    api.get('/associations', {});

    expect((await clientPortalService.getAssociations(LAW_FIRM_ID)).associations).toEqual([]);
  });
});

describe('clientRecordId travels in the QUERY, never the body', () => {
  it('appends it to a GET', async () => {
    api.get('/matters', { matters: [] });

    await clientPortalService.getMatters(LAW_FIRM_ID, CLIENT_RECORD_ID);

    expect(paramsOf(api.calls('GET')[0].url).get('clientRecordId')).toBe(CLIENT_RECORD_ID);
  });

  it('OMITS it entirely when the caller has none', async () => {
    api.get('/matters', { matters: [] });

    await clientPortalService.getMatters(LAW_FIRM_ID);

    // Absent is not the same as empty. The backend falls back to the caller's
    // sole association when the parameter is missing, and 400s when there is
    // more than one; sending `clientRecordId=undefined` would instead be an
    // exact-match check against a record named "undefined", which never matches.
    expect(api.calls('GET')[0].url).not.toContain('clientRecordId');
  });

  it('puts it in the query of a POST too, leaving the body to the payload', async () => {
    api.post('/documents/refresh-url', { downloadUrl: 'https://signed/x' });

    await clientPortalService.refreshDocumentUrl(LAW_FIRM_ID, 'firms/f1/x.pdf', CLIENT_RECORD_ID);

    // Two sources for one fact can disagree. The routes read the query first, so
    // a body copy would be dead weight that starts overriding nothing - until a
    // route's body schema turns `.strict()` and rejects the unexpected key.
    const call = api.calls('POST')[0];
    expect(paramsOf(call.url).get('clientRecordId')).toBe(CLIENT_RECORD_ID);
    expect((call.body as Record<string, unknown>).clientRecordId).toBeUndefined();
    expect((call.body as Record<string, unknown>).objectPath).toBe('firms/f1/x.pdf');
  });

  it('joins onto an existing query string with & rather than a second ?', async () => {
    api.get('/document-requests', { requests: [] });

    await clientPortalService.getDocumentRequests(LAW_FIRM_ID, MATTER_ID, CLIENT_RECORD_ID);

    // `?matterId=...?clientRecordId=...` parses as a single matterId value
    // ending in the whole second clause, so the matter filter silently matches
    // nothing and the client sees no document requests at all.
    const params = paramsOf(api.calls('GET')[0].url);
    expect(params.get('matterId')).toBe(MATTER_ID);
    expect(params.get('clientRecordId')).toBe(CLIENT_RECORD_ID);
  });

  it('encodes a value carrying url-significant characters', async () => {
    api.get('/matters', { matters: [] });

    await clientPortalService.getMatters(LAW_FIRM_ID, 'a b&limit=999');

    // Read back through URLSearchParams, never decodeURIComponent: a query
    // string may encode a space as `+`, which decodeURIComponent leaves alone.
    // Unencoded, the `&` would split into a second parameter and smuggle a
    // caller-controlled `limit` onto the request.
    const params = paramsOf(api.calls('GET')[0].url);
    expect(params.get('clientRecordId')).toBe('a b&limit=999');
    expect(params.get('limit')).toBeNull();
  });

  it('CHARACTERISATION: builds a request even with NO firm id', async () => {
    api.get('/matters', { matters: [] });

    await clientPortalService.getMatters(undefined as unknown as string);

    // There is no guard here, unlike `matters.service.createMatter`, which
    // refuses before building a url. The request goes out against the literal
    // path segment "undefined" and comes back a 404, which the client reads as
    // the portal being broken rather than as a missing firm context.
    expect(api.calls('GET')[0].pathname).toContain('/lawfirm/undefined/matters');
  });
});

describe('billing', () => {
  const EMPTY_PAGE = { invoices: [], totalItems: 0, summary: { totalBilled: 0, totalPaid: 0, totalOutstanding: 0 }, statusCounts: {} };

  it('sends page, limit and status each under its own key', async () => {
    api.get('/billing', EMPTY_PAGE);

    await clientPortalService.getBilling(LAW_FIRM_ID, { page: 2, limit: 25, status: 'overdue' });

    const params = paramsOf(api.calls('GET')[0].url);
    expect(params.get('page')).toBe('2');
    expect(params.get('limit')).toBe('25');
    expect(params.get('status')).toBe('overdue');
  });

  it('OMITS a filter the caller did not set', async () => {
    api.get('/billing', EMPTY_PAGE);

    await clientPortalService.getBilling(LAW_FIRM_ID, { page: 2 });

    // A literal `status=undefined` filters to a status no invoice has, so the
    // client is told they have no bills.
    const url = api.calls('GET')[0].url;
    expect(url).not.toContain('status');
    expect(url).not.toContain('limit');
  });

  it('CHARACTERISATION: does NOT clamp the limit', async () => {
    api.get('/billing', EMPTY_PAGE);

    await clientPortalService.getBilling(LAW_FIRM_ID, { limit: 100000 });

    // Unlike `matters.service.getMattersPaged`, which caps at 500 before
    // sending, this forwards whatever it is given and leaves the ceiling to the
    // backend's validator. The cost of the difference is that an over-limit
    // request fails as a 400 the client sees, rather than quietly returning the
    // largest allowed page.
    expect(paramsOf(api.calls('GET')[0].url).get('limit')).toBe('100000');
  });

  it('CHARACTERISATION: drops a limit of 0 instead of sending it', async () => {
    api.get('/billing', EMPTY_PAGE);

    await clientPortalService.getBilling(LAW_FIRM_ID, { limit: 0 });

    // The guard is truthiness, so a computed page size of zero silently becomes
    // "no limit at all" - the widest possible request, from the narrowest ask.
    expect(api.calls('GET')[0].url).not.toContain('limit');
  });

  it('falls back to the page length when the server sends no total', async () => {
    api.get('/billing', { invoices: [{ id: 'i1' }, { id: 'i2' }] });

    const page = await clientPortalService.getBilling(LAW_FIRM_ID);

    // Older responses carried no count. Reporting 0 would make the pager hide
    // itself over a list that is visibly not empty.
    expect(page.totalItems).toBe(2);
  });

  it('keeps a real total that is LARGER than the page', async () => {
    api.get('/billing', { invoices: [{ id: 'i1' }], totalItems: 40 });

    // The positive half. A fallback that overwrote the server's count would cap
    // the pager at one page and hide 39 invoices.
    expect((await clientPortalService.getBilling(LAW_FIRM_ID)).totalItems).toBe(40);
  });

  it('passes the money summary through untouched', async () => {
    api.get('/billing', {
      invoices: [],
      summary: { totalBilled: 500000, totalPaid: 250000, totalOutstanding: 250000 },
      statusCounts: { paid: 1, overdue: 2 },
    });

    const page = await clientPortalService.getBilling(LAW_FIRM_ID);

    // The backend derives every one of these; re-deriving on the client is how
    // the two drift. Compared as numbers of cents.
    expect(page.summary.totalOutstanding).toBe(250000);
    expect(page.statusCounts).toEqual({ paid: 1, overdue: 2 });
  });

  it('defaults a missing summary and statusCounts', async () => {
    api.get('/billing', { invoices: [] });

    const page = await clientPortalService.getBilling(LAW_FIRM_ID);

    // The filter chips read `statusCounts` by key and the header reads the
    // summary. `undefined` for either is a blank billing page.
    expect(page.summary).toEqual({ totalBilled: 0, totalPaid: 0, totalOutstanding: 0 });
    expect(page.statusCounts).toEqual({});
  });

  it('THROWS when billing is refused rather than reporting no invoices', async () => {
    api.get('/billing', { status: 403, body: { error: 'You cannot view billing for this organization' } });

    // The single most important failure on this page. A swallowed 403 returns
    // zero invoices and a zero balance, which a client reads as "I owe nothing"
    // - the same screen a fully-paid client sees.
    await expect(clientPortalService.getBilling(LAW_FIRM_ID))
      .rejects.toThrow(/cannot view billing/i);
  });

  it('encodes an invoice id into the single-invoice path', async () => {
    api.get('/invoices/INV%2F2024%2F1', { invoice: { id: 'INV/2024/1' } });

    const { invoice } = await clientPortalService.getInvoice(LAW_FIRM_ID, 'INV/2024/1');

    // An unencoded slash would split into extra path segments and address a
    // different route entirely.
    expect(invoice.id).toBe('INV/2024/1');
    expect(api.calls('GET')[0].pathname).toMatch(/\/invoices\/INV%2F2024%2F1$/);
  });

  it('throws the server message when one invoice cannot be loaded', async () => {
    api.get('/invoices/inv-1', { status: 404, body: { error: 'Invoice not found' } });

    // An invoice page rendered from a swallowed 404 shows a bill with no lines
    // and a zero total, which reads as a real invoice for nothing.
    await expect(clientPortalService.getInvoice(LAW_FIRM_ID, 'inv-1'))
      .rejects.toThrow(/not found/i);
  });

  it('asks for a Stripe checkout url per invoice', async () => {
    api.get('/billing/pay/inv-1', { checkoutUrl: 'https://checkout.stripe.com/x' });

    const result = await clientPortalService.getPaymentCheckoutUrl(LAW_FIRM_ID, 'inv-1', CLIENT_RECORD_ID);

    expect(result.checkoutUrl).toBe('https://checkout.stripe.com/x');
    expect(paramsOf(api.calls('GET')[0].url).get('clientRecordId')).toBe(CLIENT_RECORD_ID);
  });

  it('surfaces the specific validation detail when checkout is refused', async () => {
    api.get('/billing/pay/inv-1', {
      status: 400,
      body: { error: 'Payment unavailable', details: { invoice: ['This invoice is already paid in full.'] } },
    });

    // The generic message tells a client nothing about why the button did not
    // work. The detail is the only copy that names the actual reason.
    await expect(clientPortalService.getPaymentCheckoutUrl(LAW_FIRM_ID, 'inv-1'))
      .rejects.toThrow(/already paid in full/i);
  });

  it('falls back to the stripe detail when there is no invoice detail', async () => {
    api.get('/billing/pay/inv-1', {
      status: 400,
      body: { error: 'Payment unavailable', details: { stripe: ['This firm has not finished connecting Stripe.'] } },
    });

    // The two detail keys mean different things - the invoice is not payable
    // versus the firm cannot accept payment - and only one of them is ever set.
    await expect(clientPortalService.getPaymentCheckoutUrl(LAW_FIRM_ID, 'inv-1'))
      .rejects.toThrow(/finished connecting Stripe/i);
  });

  it('keeps the server message when there is no detail at all', async () => {
    api.get('/billing/pay/inv-1', { status: 402, body: { error: 'This firm cannot accept payments right now.' } });

    await expect(clientPortalService.getPaymentCheckoutUrl(LAW_FIRM_ID, 'inv-1'))
      .rejects.toThrow(/cannot accept payments/i);
  });

  it('sends the chosen payment method alongside the client record', async () => {
    api.get('/billing/pay/inv-1', { checkoutUrl: 'https://checkout.stripe.com/bank' });

    await clientPortalService.getPaymentCheckoutUrl(LAW_FIRM_ID, 'inv-1', CLIENT_RECORD_ID, 'bank');

    // Breaks if the method is dropped: the server would mint the old any-method
    // session with no fee, whatever the client chose.
    const params = paramsOf(api.calls('GET')[0].url);
    expect(params.get('method')).toBe('bank');
    expect(params.get('clientRecordId')).toBe(CLIENT_RECORD_ID);
  });

  it('asks no method when none is chosen', async () => {
    api.get('/billing/pay/inv-1', { checkoutUrl: 'https://checkout.stripe.com/x' });

    await clientPortalService.getPaymentCheckoutUrl(LAW_FIRM_ID, 'inv-1');

    expect(paramsOf(api.calls('GET')[0].url).has('method')).toBe(false);
  });
});

describe('paying online: the method quote', () => {
  it('reads what each method costs', async () => {
    const quote = {
      invoiceCents: 38_000,
      methods: [
        { method: 'card', feeCents: 1_532, totalCents: 39_532 },
        { method: 'bank', feeCents: 0, totalCents: 38_000 },
      ],
    };
    api.get('/billing/pay/inv-1/options', quote);

    const result = await clientPortalService.getPaymentOptions(LAW_FIRM_ID, 'inv-1', CLIENT_RECORD_ID);

    expect(result).toEqual(quote);
    expect(paramsOf(api.calls('GET')[0].url).get('clientRecordId')).toBe(CLIENT_RECORD_ID);
  });

  it('surfaces the invoice detail when the quote is refused', async () => {
    api.get('/billing/pay/inv-1/options', {
      status: 400,
      body: { error: 'Payment unavailable', details: { invoice: ['This invoice has been voided.'] } },
    });

    await expect(clientPortalService.getPaymentOptions(LAW_FIRM_ID, 'inv-1'))
      .rejects.toThrow(/has been voided/i);
  });
});

describe('documents the firm shared', () => {
  it('normalizes a sparse document rather than passing holes through', async () => {
    api.get('/documents', { documents: [{ id: 'd1', size: '2048' }] });

    const [document] = (await clientPortalService.getDocuments(LAW_FIRM_ID)).documents;

    // Every one of these renders directly in the client's file list. A missing
    // name renders as blank row, and a string size breaks the size formatter.
    expect(document.name).toBe('Untitled document');
    expect(document.type).toBe('application/octet-stream');
    expect(document.size).toBe(2048);
  });

  it('scores an unparseable size as 0 rather than NaN', async () => {
    api.get('/documents', { documents: [{ id: 'd1', size: 'huge' }] });

    const [document] = (await clientPortalService.getDocuments(LAW_FIRM_ID)).documents;

    expect(document.size).toBe(0);
  });

  it('infers a matter context from a matterId the server did not label', async () => {
    api.get('/documents', { documents: [{ id: 'd1', name: 'brief.pdf', matterId: MATTER_ID }] });

    const [document] = (await clientPortalService.getDocuments(LAW_FIRM_ID)).documents;

    // The label is what tells the client whether a file belongs to their matter
    // or to their own file area, and the grouping on the Documents page follows
    // it.
    expect(document.contextType).toBe('matter');
    expect(document.sourceLabel).toBe('Matter file');
    expect(document.entityId).toBe(MATTER_ID);
  });

  it('labels a document with no matter as a client file', async () => {
    api.get('/documents', { documents: [{ id: 'd1', name: 'id.png' }] });

    const [document] = (await clientPortalService.getDocuments(LAW_FIRM_ID)).documents;

    // The negative half: a normalizer that hardcoded 'matter' would file every
    // personal document under a matter the client may not even be on.
    expect(document.contextType).toBe('client');
    expect(document.sourceLabel).toBe('Client file');
    expect(document.entityId).toBeNull();
  });

  it('marks a document new ONLY on a strict true', async () => {
    api.get('/documents', {
      documents: [
        { id: 'd1', name: 'a.pdf', isNew: true },
        { id: 'd2', name: 'b.pdf', isNew: 'true' },
        { id: 'd3', name: 'c.pdf' },
      ],
    });

    const { documents } = await clientPortalService.getDocuments(LAW_FIRM_ID);

    // The "New" badge is how a client notices the firm sent something. A loose
    // truthiness check would light it for the string "true" and for every other
    // non-empty value the backend might one day put there.
    expect(documents.map((d) => d.isNew)).toEqual([true, false, false]);
  });

  it('carries the truncated flag both ways', async () => {
    api.get('/documents', { documents: [{ id: 'd1', name: 'a.pdf' }], truncated: true });
    const partial = await clientPortalService.getDocuments(LAW_FIRM_ID);

    api.get('/documents', { documents: [{ id: 'd1', name: 'a.pdf' }] });
    const complete = await clientPortalService.getDocuments(LAW_FIRM_ID);

    // Without this the client cannot tell a short list from a complete one, and
    // concludes the firm never sent the document they are looking for.
    expect(partial.truncated).toBe(true);
    expect(complete.truncated).toBe(false);
  });

  it('defaults the documents and folders lists', async () => {
    api.get('/documents', {});

    const result = await clientPortalService.getDocuments(LAW_FIRM_ID);

    expect(result.documents).toEqual([]);
    expect(result.folders).toEqual([]);
  });

  it('keeps the folder colours the firm chose', async () => {
    api.get('/documents', {
      documents: [],
      folders: [{ matterId: MATTER_ID, relPath: 'contracts/', folderColor: 'blue' }],
    });

    const { folders } = await clientPortalService.getDocuments(LAW_FIRM_ID);

    expect(folders).toEqual([{ matterId: MATTER_ID, relPath: 'contracts/', folderColor: 'blue' }]);
  });

  it('reads ONE matter through the matter-scoped route', async () => {
    api.get(`/matters/${MATTER_ID}/documents`, { documents: [{ id: 'd1', name: 'a.pdf' }] });

    const result = await clientPortalService.getMatterDocuments(LAW_FIRM_ID, MATTER_ID);

    // The firm-wide route walks the storage prefix of every matter the client is
    // on, so it hits its scan cap sooner. This spec registers only the
    // matter-scoped url, so falling back to the wide one is an unmatched request
    // and fails loudly.
    expect(result.documents).toHaveLength(1);
    expect(api.calls('GET')[0].pathname).toMatch(/\/matters\/matter-9\/documents$/);
  });


  it('THROWS when the document list is refused', async () => {
    api.get('/documents', { status: 403, body: { error: 'Access to this portal was removed' } });

    // An empty document list is what a client with nothing shared sees. It must
    // not also be what a client whose access was revoked sees.
    await expect(clientPortalService.getDocuments(LAW_FIRM_ID))
      .rejects.toThrow(/access to this portal/i);
  });
});

describe('opening a document', () => {
  it('POSTs the object path and returns the signed url', async () => {
    api.post('/documents/refresh-url', { downloadUrl: 'https://signed/x' });

    const result = await clientPortalService.refreshDocumentUrl(LAW_FIRM_ID, 'firms/f1/clients/c1/x.pdf');

    // Listings carry no url, so this call IS how a document opens. The server
    // re-checks the share from the object path, which is why the path is the
    // whole request.
    expect((api.calls('POST')[0].body as Record<string, unknown>).objectPath)
      .toBe('firms/f1/clients/c1/x.pdf');
    expect(result.downloadUrl).toBe('https://signed/x');
  });

  it('throws with a usable message when the share was withdrawn', async () => {
    api.post('/documents/refresh-url', { status: 403, body: {} });

    // A document un-shared since the list loaded is refused here. With no
    // message in the body the service's own fallback copy has to carry it, or
    // the client gets a blank error toast.
    await expect(clientPortalService.refreshDocumentUrl(LAW_FIRM_ID, 'firms/f1/x.pdf'))
      .rejects.toThrow(/failed to open this document/i);
  });

  it('uses the matter-scoped route for the matter-scoped variant', async () => {
    api.post(`/matters/${MATTER_ID}/documents/refresh-url`, { downloadUrl: 'https://signed/y' });

    await clientPortalService.refreshMatterDocumentUrl(LAW_FIRM_ID, MATTER_ID, 'firms/f1/matters/m9/y.pdf');

    // Two near-identical methods differing only by path. Only the matter route
    // is registered here, so sending this to the general one fails loudly.
    expect(api.calls('POST')[0].pathname).toMatch(/\/matters\/matter-9\/documents\/refresh-url$/);
  });
});

describe('document requests', () => {
  it('scopes the list to one matter when asked', async () => {
    api.get('/document-requests', { requests: [{ id: 'r1' }] });

    await clientPortalService.getDocumentRequests(LAW_FIRM_ID, MATTER_ID);

    expect(paramsOf(api.calls('GET')[0].url).get('matterId')).toBe(MATTER_ID);
  });

  it('omits the matter filter for the firm-wide list', async () => {
    api.get('/document-requests', { requests: [] });

    await clientPortalService.getDocumentRequests(LAW_FIRM_ID);

    // General requests carry a null matterId server-side. Filtering by
    // "undefined" would hide exactly those.
    expect(api.calls('GET')[0].url).not.toContain('matterId');
  });

  it('defaults a missing requests list to an empty array', async () => {
    api.get('/document-requests', {});

    expect(await clientPortalService.getDocumentRequests(LAW_FIRM_ID)).toEqual([]);
  });

  it('signs a url for one file attached to a checklist item', async () => {
    api.get('/fulfillments/ful-1/url', { signedUrl: 'https://signed/f', fileName: 'w2.pdf', contentType: 'application/pdf', size: 10 });

    const result = await clientPortalService.getRequestFulfillmentUrl(LAW_FIRM_ID, 'req-1', 'item-1', 'ful-1');

    // Four ids address one file. The path is the only thing distinguishing this
    // client's upload from another client's on a neighbouring request.
    expect(api.calls('GET')[0].pathname)
      .toMatch(/\/document-requests\/req-1\/items\/item-1\/fulfillments\/ful-1\/url$/);
    expect(result.fileName).toBe('w2.pdf');
  });

  it('DELETEs one fulfillment and returns the refreshed request', async () => {
    api.delete('/fulfillments/ful-1', { request: { id: 'req-1', items: [{ id: 'item-1', fulfillments: [] }] } });

    const request = await clientPortalService.deleteRequestFulfillment(LAW_FIRM_ID, 'req-1', 'item-1', 'ful-1');

    // The unwrapped `request` is what the page re-renders from. Returning the
    // envelope instead would leave the deleted file on screen until a reload.
    expect(request.id).toBe('req-1');
    expect(api.calls('DELETE')[0].pathname).toMatch(/\/fulfillments\/ful-1$/);
  });

  it('throws when removing a file is refused', async () => {
    api.delete('/fulfillments/ful-1', { status: 403, body: { error: 'Only the uploader can remove this file' } });

    // The server allows a client to remove only their own upload. Swallowing
    // that would make the row vanish locally and return on the next load.
    await expect(clientPortalService.deleteRequestFulfillment(LAW_FIRM_ID, 'req-1', 'item-1', 'ful-1'))
      .rejects.toThrow(/only the uploader/i);
  });
});

describe('what an upload actually puts on the wire', () => {
  const DOC_SESSION_A = 'https://storage.googleapis.com/upload/doc-a';
  const DOC_SESSION_B = 'https://storage.googleapis.com/upload/doc-b';

  /**
   * Answer the three legs of a document upload.
   *
   * It used to be a single multipart POST that carried up to ten files at a
   * hundred megabytes each through the API container. `base` is the route the
   * two document uploads differ by.
   */
  function arrangeDocumentUpload(
    base: string,
    sessions: string[] = [DOC_SESSION_A],
    // By default the server files every row init claimed, as it does when
    // nothing is refused.
    finalizeBody: Record<string, unknown> = {
      documents: sessions.map((_, i) => ({ fileId: `file-${i}`, name: `${i}.pdf` })),
    },
  ) {
    api.post(`${base}/upload-init`, {
      uploads: sessions.map((url, i) => ({
        uploadUrl: url, objectPath: `docs/${i}.pdf`, fileId: `file-${i}`, fileName: `${i}.pdf`,
      })),
      reservedBytes: 10,
    });
    sessions.forEach((url) => xhr.onExact('PUT', url, { status: 200 }));
    api.post(`${base}/upload-finalize`, finalizeBody);
  }

  const MATTER_DOCS = `/lawfirm/${LAW_FIRM_ID}/matters/${MATTER_ID}/documents`;

  it('declares every file to the server, in order', async () => {
    arrangeDocumentUpload(MATTER_DOCS, [DOC_SESSION_A, DOC_SESSION_B], { documents: [{ name: 'a.pdf' }] });

    await clientPortalService.uploadMatterDocuments(
      LAW_FIRM_ID, MATTER_ID, [fileNamed('a.pdf'), fileNamed('b.pdf')],
    );

    // The server claims one file ROW per declared file and hands back a session
    // for each. A dropped or reordered entry pairs a file with another's row,
    // and each lands under the other's name.
    const declared = (api.callsTo(`${MATTER_DOCS}/upload-init`)[0].body as any).files;
    expect(declared.map((f: any) => f.fileName)).toEqual(['a.pdf', 'b.pdf']);
  });

  it('sends the bytes to storage, not through the API', async () => {
    arrangeDocumentUpload(MATTER_DOCS);

    await clientPortalService.uploadMatterDocuments(LAW_FIRM_ID, MATTER_ID, [fileNamed('a.pdf')]);

    expect(xhr.calls('PUT')[0].url).toBe(DOC_SESSION_A);
  });

  it('does NOT carry the portal credential to storage', async () => {
    arrangeDocumentUpload(MATTER_DOCS);

    await clientPortalService.uploadMatterDocuments(LAW_FIRM_ID, MATTER_ID, [fileNamed('a.pdf')]);

    // Inverted from the multipart path, where the service attached the token by
    // hand. A signed session url IS the authorization; a bearer token here
    // sends this client's credential to a third-party host.
    const headers = Object.keys(xhr.calls('PUT')[0].headers).map((h) => h.toLowerCase());
    expect(headers).not.toContain('authorization');
  });

  it('finalizes the sessions it was handed and sends no reservation of its own', async () => {
    arrangeDocumentUpload(MATTER_DOCS);

    await clientPortalService.uploadMatterDocuments(LAW_FIRM_ID, MATTER_ID, [fileNamed('a.pdf')]);

    // The server derives what init reserved from the rows it claimed. A client
    // number here could release someone else's reservation or charge twice.
    const done = api.callsTo(`${MATTER_DOCS}/upload-finalize`)[0];
    expect((done.body as any).uploads.map((u: any) => u.fileId)).toEqual(['file-0']);
    expect((done.body as any).reservedBytes).toBeUndefined();
  });

  it('carries clientRecordId on BOTH the init and the finalize url', async () => {
    arrangeDocumentUpload(MATTER_DOCS);

    await clientPortalService.uploadMatterDocuments(
      LAW_FIRM_ID, MATTER_ID, [fileNamed('a.pdf')], undefined, CLIENT_RECORD_ID,
    );

    // Without it the server cannot decide which of the caller's client records
    // is uploading. It is needed on finalize too, which re-resolves the access
    // rather than trusting the init that preceded it.
    for (const call of api.calls('POST')) {
      expect(paramsOf(call.url).get('clientRecordId')).toBe(CLIENT_RECORD_ID);
    }
  });

  it('reports progress as a whole percentage that never goes backwards', async () => {
    arrangeDocumentUpload(MATTER_DOCS, [DOC_SESSION_A, DOC_SESSION_B]);
    const seen: number[] = [];

    await clientPortalService.uploadMatterDocuments(
      LAW_FIRM_ID, MATTER_ID, [fileNamed('a.pdf'), fileNamed('b.pdf')], (p) => seen.push(p),
    );

    // The progress bar is the only feedback during a large upload. Across the
    // batch, not per file: a per-file percentage drops to zero on the second
    // document, which reads as the upload restarting.
    expect(seen.every((p) => Number.isInteger(p) && p >= 0 && p <= 100)).toBe(true);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it('rejects when finalize filed none of the files it was sent', async () => {
    arrangeDocumentUpload(MATTER_DOCS, [DOC_SESSION_A], {});

    // A finalize that filed nothing for a file that was sent is a failure, not
    // an empty success: resolving here reported a refused file as uploaded.
    await expect(clientPortalService.uploadMatterDocuments(LAW_FIRM_ID, MATTER_ID, [fileNamed('a.pdf')]))
      .rejects.toThrow(/could not be saved/i);
  });

  it('does nothing at all for an empty selection', async () => {
    expect(await clientPortalService.uploadMatterDocuments(LAW_FIRM_ID, MATTER_ID, []))
      .toEqual({ documents: [], failures: [] });
    expect(api.calls()).toEqual([]);
    expect(xhr.calls()).toEqual([]);
  });

  it('rejects with the server message when an upload is refused', async () => {
    api.post(`${MATTER_DOCS}/upload-init`, {
      status: 413, body: { error: 'This file is larger than your firm allows.' },
    });

    // A rejected upload that resolved would leave the client believing the firm
    // has a document it never received.
    await expect(clientPortalService.uploadMatterDocuments(LAW_FIRM_ID, MATTER_ID, [fileNamed('a.pdf')]))
      .rejects.toThrow(/larger than your firm allows/i);
    expect(xhr.calls()).toEqual([]);
  });

  it('does not finalize when the bytes never landed', async () => {
    api.post(`${MATTER_DOCS}/upload-init`, {
      uploads: [{ uploadUrl: DOC_SESSION_A, objectPath: 'docs/0.pdf', fileId: 'file-0', fileName: '0.pdf' }],
      reservedBytes: 10,
    });
    // 410 is the session being gone, which the uploader treats as terminal.
    xhr.onExact('PUT', DOC_SESSION_A, { status: 410 });
    api.allowUnhandled();

    await expect(clientPortalService.uploadMatterDocuments(LAW_FIRM_ID, MATTER_ID, [fileNamed('a.pdf')]))
      .rejects.toThrow();

    // Finalizing here stamps rows over objects that are not there.
    expect(api.callsTo(`${MATTER_DOCS}/upload-finalize`)).toEqual([]);
  });

  it('fulfills a checklist item through the item\'s own route', async () => {
    const base = `/lawfirm/${LAW_FIRM_ID}/document-requests/req-1/items/item-1/fulfill`;
    arrangeDocumentUpload(base, [DOC_SESSION_A], {
      documents: [{ name: 'w2.pdf' }], requestId: 'req-1', itemId: 'item-1',
    });

    const result = await clientPortalService.fulfillRequestItem(
      LAW_FIRM_ID, 'req-1', 'item-1', [fileNamed('w2.pdf')],
    );

    // Unlike the matter upload, this resolves the WHOLE body: the caller needs
    // the request and item ids back to move that one checklist line to
    // "received" without refetching the request.
    expect(result.requestId).toBe('req-1');
    expect(result.itemId).toBe('item-1');
    expect(result.documents).toHaveLength(1);
    expect(api.callsTo(`${base}/upload-init`)).toHaveLength(1);
  });

  it('reuses a failed checklist upload action and skips bytes already finalized by the server', async () => {
    const base = `/lawfirm/${LAW_FIRM_ID}/document-requests/req-retry/items/item-retry/fulfill`;
    const selected = [fileNamed('w2.pdf')];
    let initCount = 0;
    api.post(`${base}/upload-init`, () => {
      initCount += 1;
      return { uploads: [{ uploadUrl: DOC_SESSION_A, objectPath: 'docs/retry', fileId: 'file-retry',
        fileName: 'w2.pdf', ...(initCount > 1 ? { isFinalized: true } : {}) }] };
    });
    xhr.onExact('PUT', DOC_SESSION_A, { status: 200 });
    let finalizes = 0;
    api.post(`${base}/upload-finalize`, () => {
      finalizes += 1;
      return finalizes === 1
        ? { status: 503, body: { error: 'Connection interrupted' } }
        : { documents: [{ fileId: 'file-retry', name: 'w2.pdf' }] };
    });
    await expect(clientPortalService.fulfillRequestItem(LAW_FIRM_ID, 'req-retry', 'item-retry', selected))
      .rejects.toThrow('Connection interrupted');
    const result = await clientPortalService.fulfillRequestItem(LAW_FIRM_ID, 'req-retry', 'item-retry', selected);
    expect(result.documents.map((d) => d.fileId)).toEqual(['file-retry']);
    const inits = api.callsTo(`${base}/upload-init`).map((c) => c.body as { actionKey?: string });
    expect(inits[0].actionKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(inits[1].actionKey).toBe(inits[0].actionKey);
    expect(xhr.calls().filter((c) => c.url === DOC_SESSION_A)).toHaveLength(1);
    await clientPortalService.fulfillRequestItem(LAW_FIRM_ID, 'req-retry', 'item-retry', selected);
    const third = api.callsTo(`${base}/upload-init`)[2].body as { actionKey?: string };
    expect(third.actionKey).not.toBe(inits[0].actionKey);
  });

  /** Session urls the portal upload is answered with. */
  const PORTAL_SESSION = 'https://storage.googleapis.com/upload/portal-a';

  /** Answer the two JSON legs and the storage PUT for one attachment. */
  function arrangeAttachmentUpload(attachments: unknown[] = []) {
    api.post(`/lawfirm/${LAW_FIRM_ID}/messages/attachments/upload-init`, {
      uploads: [{ uploadUrl: PORTAL_SESSION, objectPath: 'msg/a.pdf', fileName: 'a.pdf' }],
      reservedBytes: 10,
    });
    xhr.onExact('PUT', PORTAL_SESSION, { status: 200 });
    api.post(`/lawfirm/${LAW_FIRM_ID}/messages/attachments/upload-finalize`, {
      attachments, failures: [],
    });
  }

  it('names the conversation when attaching to a group thread', async () => {
    arrangeAttachmentUpload([{ objectPath: 'p' }]);

    await clientPortalService.uploadMessageAttachments(
      LAW_FIRM_ID, [fileNamed('a.pdf')], undefined, 'conv-1',
    );

    // The group's folder is the only one the group send endpoint accepts
    // attachments from, and the server refuses outright if this client is not a
    // participant. Losing the id here stores the file in the client's own
    // folder and the send that follows is then refused.
    const init = api.callsTo(`/lawfirm/${LAW_FIRM_ID}/messages/attachments/upload-init`)[0];
    expect((init.body as any).conversationId).toBe('conv-1');
  });

  it('names it again at finalize, where the folder is resolved a second time', async () => {
    // The finalize route is reachable on its own and re-resolves the folder
    // from the caller's access. Omitting the id there would check the paths
    // against the wrong folder.
    arrangeAttachmentUpload();

    await clientPortalService.uploadMessageAttachments(
      LAW_FIRM_ID, [fileNamed('a.pdf')], undefined, 'conv-1',
    );

    const done = api.callsTo(`/lawfirm/${LAW_FIRM_ID}/messages/attachments/upload-finalize`)[0];
    expect((done.body as any).conversationId).toBe('conv-1');
  });

  it('sends no reservation of its own at finalize', async () => {
    arrangeAttachmentUpload();

    await clientPortalService.uploadMessageAttachments(LAW_FIRM_ID, [fileNamed('a.pdf')]);

    const done = api.callsTo(`/lawfirm/${LAW_FIRM_ID}/messages/attachments/upload-finalize`)[0];
    expect((done.body as any).uploads.map((u: any) => u.objectPath)).toEqual(['msg/a.pdf']);
    expect((done.body as any).reservedBytes).toBeUndefined();
  });

  it('omits conversationId entirely for the direct thread', async () => {
    arrangeAttachmentUpload();

    await clientPortalService.uploadMessageAttachments(LAW_FIRM_ID, [fileNamed('a.pdf')]);

    // The string "undefined" is a conversation id the client is not in, and the
    // server would refuse the send that follows.
    const init = api.callsTo(`/lawfirm/${LAW_FIRM_ID}/messages/attachments/upload-init`)[0];
    expect(init.body).not.toHaveProperty('conversationId');
  });

  it('does not carry the portal credential to storage', async () => {
    // A signed session url IS the authorization. A bearer token here sends this
    // client's credential to a third-party host.
    arrangeAttachmentUpload();

    await clientPortalService.uploadMessageAttachments(LAW_FIRM_ID, [fileNamed('a.pdf')]);

    const put = xhr.calls('PUT')[0];
    expect(Object.keys(put.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
  });
});

describe('stopping a document upload, and what it files', () => {
  const MATTER_DOCS = `/lawfirm/${LAW_FIRM_ID}/matters/${MATTER_ID}/documents`;
  const sessionFor = (i: number) => `https://storage.googleapis.com/upload/doc-${i}`;

  /**
   * Answer init for any number of groups, each opening one session per declared
   * file, numbered across the whole selection so every file has its own url.
   * `events` records the order storage and finalize were reached in.
   */
  function arrangeGroupedUpload(
    base: string,
    count: number,
    options: {
      events?: string[];
      onPut?: (i: number) => void;
      finalize?: (uploads: Array<{ fileId: string; objectPath: string }>) => unknown;
    } = {},
  ) {
    const { events = [], onPut, finalize } = options;
    let opened = 0;
    api.post(`${base}/upload-init`, (call) => {
      const declared = (call.body as { files: Array<{ fileName: string }> }).files;
      const uploads = declared.map((f) => {
        const i = opened;
        opened += 1;
        return {
          uploadUrl: sessionFor(i), objectPath: `docs/${i}`, fileId: `file-${i}`, fileName: f.fileName,
          declaredSize: 1, reservationId: `res-${i}`,
        };
      });
      return { uploads, reservedBytes: uploads.length };
    });
    for (let i = 0; i < count; i += 1) {
      xhr.onExact('PUT', sessionFor(i), () => {
        events.push(`put:${i}`);
        onPut?.(i);
        return { status: 200 };
      });
    }
    api.post(`${base}/upload-finalize`, (call) => {
      const uploads = (call.body as { uploads: Array<{ fileId: string; objectPath: string }> }).uploads;
      events.push(`finalize:${uploads.length}`);
      return finalize
        ? finalize(uploads)
        : { documents: uploads.map((u) => ({ fileId: u.fileId, name: u.fileId })), failures: [] };
    });
    api.post(`${base}/upload-cancel`, (call) => {
      events.push('cancel');
      return { cancelled: (call.body as { uploads: unknown[] }).uploads.length };
    });
    return events;
  }

  const files = (n: number) => Array.from({ length: n }, (_, i) => fileNamed(`f${i}.pdf`));

  /** What a release names for the first `n` sessions: each row and its reservation. */
  const released = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ fileId: `file-${i}`, reservationId: `res-${i}` }));

  /** Poll until a condition holds, for the release the caller does not wait on. */
  async function waitFor(condition: () => boolean, turns = 100): Promise<void> {
    for (let i = 0; i < turns && !condition(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  // The release goes out without the rejection waiting on it, so it can still
  // be on its way when a spec ends. A moment here lands it in this spec's fake
  // rather than the next one's.
  afterEach(async () => {
    await waitFor(() => false, 5);
  });

  it('stops the transfer on a cancel and never reaches finalize', async () => {
    const controller = new AbortController();
    arrangeGroupedUpload(MATTER_DOCS, 2, { onPut: (i) => { if (i === 0) controller.abort(); } });

    await expect(clientPortalService.uploadMatterDocuments(
      LAW_FIRM_ID, MATTER_ID, files(2), undefined, undefined, controller.signal,
    )).rejects.toMatchObject({ name: 'UploadCancelledError' });

    // The second file is never sent and nothing is filed: finalize stamps what
    // landed, so reaching it would keep half of a selection the user abandoned.
    expect(xhr.calls('PUT').map((c) => c.url)).toEqual([sessionFor(0)]);
    expect(api.callsTo(`${MATTER_DOCS}/upload-finalize`)).toEqual([]);
  });

  it('does not finalize when the cancel arrives after the last byte landed', async () => {
    const controller = new AbortController();
    arrangeGroupedUpload(MATTER_DOCS, 1);

    await expect(clientPortalService.uploadMatterDocuments(
      LAW_FIRM_ID, MATTER_ID, files(1),
      (p) => { if (p === 100) controller.abort(); },
      undefined, controller.signal,
    )).rejects.toMatchObject({ name: 'UploadCancelledError' });

    // No request was aborted, so only a check between the bytes and finalize
    // can tell this apart from a finished upload.
    expect(api.callsTo(`${MATTER_DOCS}/upload-finalize`)).toEqual([]);
  });

  it('sends no bytes when the cancel arrives while init is still answering', async () => {
    const controller = new AbortController();
    arrangeGroupedUpload(MATTER_DOCS, 1);
    api.post(`${MATTER_DOCS}/upload-init`, () => {
      controller.abort();
      return { uploads: [{ uploadUrl: sessionFor(0), objectPath: 'docs/0', fileId: 'file-0', fileName: 'f0.pdf' }] };
    });

    await expect(clientPortalService.uploadMatterDocuments(
      LAW_FIRM_ID, MATTER_ID, files(1), undefined, undefined, controller.signal,
    )).rejects.toMatchObject({ name: 'UploadCancelledError' });

    expect(xhr.calls('PUT')).toEqual([]);
    expect(api.callsTo(`${MATTER_DOCS}/upload-finalize`)).toEqual([]);
  });

  it('tells the caller when the server starts filing, after every byte and before finalize', async () => {
    const events = arrangeGroupedUpload(MATTER_DOCS, 2);

    await clientPortalService.uploadMatterDocuments(
      LAW_FIRM_ID, MATTER_ID, files(2), undefined, undefined, new AbortController().signal,
      () => events.push('finalizing'),
    );

    // Past this point a cancel stops nothing, so the caller drops its control.
    expect(events).toEqual(['put:0', 'put:1', 'finalizing', 'finalize:2']);
  });

  it('declares more than ten files in groups the server accepts, and finalizes them together after every byte', async () => {
    const events = arrangeGroupedUpload(MATTER_DOCS, 12);

    const result = await clientPortalService.uploadMatterDocuments(LAW_FIRM_ID, MATTER_ID, files(12));

    // The server refuses an init naming more than ten files. Finalize takes
    // the whole selection, since each finalize tells the firm of an upload.
    const declared = api.callsTo(`${MATTER_DOCS}/upload-init`).map((c) => (c.body as any).files.length);
    expect(declared).toEqual([10, 2]);
    const firstFinalize = events.findIndex((e) => e.startsWith('finalize'));
    expect(events.slice(0, firstFinalize)).toHaveLength(12);
    expect(events.slice(firstFinalize)).toEqual(['finalize:12']);
    expect(result.documents).toHaveLength(12);
  });

  it('files fifty documents in ONE finalize, so the firm hears of the upload once', async () => {
    const events = arrangeGroupedUpload(MATTER_DOCS, 50);

    const result = await clientPortalService.uploadMatterDocuments(LAW_FIRM_ID, MATTER_ID, files(50));

    // Red with a finalize per init group: five "documents uploaded" notices to
    // the firm for one selection.
    expect(api.callsTo(`${MATTER_DOCS}/upload-init`)).toHaveLength(5);
    expect(events.filter((e) => e.startsWith('finalize'))).toEqual(['finalize:50']);
    expect(result.documents).toHaveLength(50);
  });

  it.each([
    ['a matter upload', (n: number) => clientPortalService.uploadMatterDocuments(LAW_FIRM_ID, MATTER_ID, files(n))],
    ['a checklist item', (n: number) => clientPortalService.fulfillRequestItem(LAW_FIRM_ID, 'req-1', 'item-1', files(n))],
  ])('refuses more than fifty files for %s before opening anything', async (_label, send) => {
    // Red without the guard: five inits claim fifty rows and reserve their
    // quota, and then the finalize naming fifty-one is refused outright.
    await expect(send(51)).rejects.toThrow('Only 50 files can be uploaded at once.');
    expect(api.calls()).toEqual([]);
    expect(xhr.calls()).toEqual([]);
  });

  it('echoes each reservation init handed out at finalize', async () => {
    arrangeGroupedUpload(MATTER_DOCS, 2);

    await clientPortalService.uploadMatterDocuments(LAW_FIRM_ID, MATTER_ID, files(2));

    // Finalize deletes the reservations the body names. One left out stays
    // held for two hours while the same bytes also count as saved.
    const [done] = api.callsTo(`${MATTER_DOCS}/upload-finalize`);
    expect((done.body as { uploads: Array<{ reservationId?: string }> }).uploads.map((u) => u.reservationId))
      .toEqual(['res-0', 'res-1']);
  });

  it('gives back every session every group opened on a cancel', async () => {
    const controller = new AbortController();
    arrangeGroupedUpload(MATTER_DOCS, 12, { onPut: (i) => { if (i === 10) controller.abort(); } });

    await expect(clientPortalService.uploadMatterDocuments(
      LAW_FIRM_ID, MATTER_ID, files(12), undefined, CLIENT_RECORD_ID, controller.signal,
    )).rejects.toMatchObject({ name: 'UploadCancelledError' });

    // Red without the release: twelve rows stay claimed and their quota held
    // for two hours, including the file that was never sent. The client record
    // travels as on every other leg, since the route re-resolves the access.
    await waitFor(() => api.callsTo(`${MATTER_DOCS}/upload-cancel`).length > 0);
    const calls = api.callsTo(`${MATTER_DOCS}/upload-cancel`);
    expect(calls.map((c) => c.body)).toEqual([{ uploads: released(12) }]);
    expect(paramsOf(calls[0].url).get('clientRecordId')).toBe(CLIENT_RECORD_ID);
  });

  it('gives back the sessions of an init the cancel overtook', async () => {
    const controller = new AbortController();
    arrangeGroupedUpload(MATTER_DOCS, 1);
    api.post(`${MATTER_DOCS}/upload-init`, {
      delayMs: 50,
      body: { uploads: [{ uploadUrl: sessionFor(0), objectPath: 'docs/0', fileId: 'file-0', fileName: 'f0.pdf', reservationId: 'res-0' }] },
    });

    const pending = clientPortalService.uploadMatterDocuments(
      LAW_FIRM_ID, MATTER_ID, files(1), undefined, undefined, controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'UploadCancelledError' });

    // The init still answers after the cancel, having claimed a row and
    // reserved quota. Red if that late answer is dropped.
    await waitFor(() => api.callsTo(`${MATTER_DOCS}/upload-cancel`).length > 0);
    expect(api.callsTo(`${MATTER_DOCS}/upload-cancel`).map((c) => c.body)).toEqual([{ uploads: released(1) }]);
  });

  it('does not hold the cancel back for the release, and never reports a refused one', async () => {
    const controller = new AbortController();
    arrangeGroupedUpload(MATTER_DOCS, 2, { onPut: () => controller.abort() });
    let answerRelease!: (response: unknown) => void;
    api.post(`${MATTER_DOCS}/upload-cancel`, () => new Promise((resolve) => { answerRelease = resolve; }));

    const pending = clientPortalService.uploadMatterDocuments(
      LAW_FIRM_ID, MATTER_ID, files(2), undefined, undefined, controller.signal,
    );
    const outcome = await Promise.race([
      pending.then(() => 'resolved', (err) => err),
      new Promise((resolve) => setTimeout(() => resolve('waiting on the release'), 200)),
    ]);

    // Red if the rejection waits for the release to answer.
    expect(outcome).toMatchObject({ name: 'UploadCancelledError' });
    await waitFor(() => api.callsTo(`${MATTER_DOCS}/upload-cancel`).length > 0);
    // Red if a refused release escapes as an unhandled rejection.
    answerRelease({ status: 500, body: { error: 'Internal error' } });
    await waitFor(() => false, 5);
    expect(api.callsTo(`${MATTER_DOCS}/upload-cancel`)).toHaveLength(1);
  });

  it('gives back every session when a transfer fails before finalize', async () => {
    arrangeGroupedUpload(MATTER_DOCS, 2);
    // 410 is the session being gone, which the uploader treats as terminal.
    xhr.onExact('PUT', sessionFor(1), { status: 410 });

    const outcome = await clientPortalService.uploadMatterDocuments(LAW_FIRM_ID, MATTER_ID, files(2))
      .then(() => 'resolved', (err) => err);

    // A failure, not a cancel, and it never reaches finalize. Red without the
    // release: nothing else gives back the rows and quota init claimed.
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toMatchObject({ name: 'UploadCancelledError' });
    expect(api.callsTo(`${MATTER_DOCS}/upload-finalize`)).toEqual([]);
    await waitFor(() => api.callsTo(`${MATTER_DOCS}/upload-cancel`).length > 0);
    expect(api.callsTo(`${MATTER_DOCS}/upload-cancel`).map((c) => c.body)).toEqual([{ uploads: released(2) }]);
  });

  it('files nothing from the first group when the cancel lands in the second', async () => {
    const controller = new AbortController();
    arrangeGroupedUpload(MATTER_DOCS, 12, { onPut: (i) => { if (i === 10) controller.abort(); } });

    await expect(clientPortalService.uploadMatterDocuments(
      LAW_FIRM_ID, MATTER_ID, files(12), undefined, undefined, controller.signal,
    )).rejects.toMatchObject({ name: 'UploadCancelledError' });

    // All or nothing across the selection, however many requests it took.
    expect(api.callsTo(`${MATTER_DOCS}/upload-finalize`)).toEqual([]);
  });

  it('names each file the server refused at finalize instead of dropping it', async () => {
    arrangeGroupedUpload(MATTER_DOCS, 2, {
      finalize: () => ({
        documents: [{ fileId: 'file-0', name: 'f0.pdf' }],
        failures: [{ objectPath: 'docs/1', fileName: 'f1.pdf', error: 'That file type is not allowed.' }],
      }),
    });

    const result = await clientPortalService.uploadMatterDocuments(LAW_FIRM_ID, MATTER_ID, files(2));

    expect(result.documents.map((d) => d.fileId)).toEqual(['file-0']);
    expect(result.failures).toEqual([{ name: 'f1.pdf', error: 'That file type is not allowed.', index: 1 }]);
  });

  it('counts a file finalize neither filed nor named as not saved', async () => {
    arrangeGroupedUpload(MATTER_DOCS, 2, {
      finalize: () => ({ documents: [{ fileId: 'file-0', name: 'f0.pdf' }] }),
    });

    const result = await clientPortalService.uploadMatterDocuments(LAW_FIRM_ID, MATTER_ID, files(2));

    expect(result.failures.map((f) => f.name)).toEqual(['f1.pdf']);
  });

  it('rejects with the server reason when finalize filed nothing at all', async () => {
    arrangeGroupedUpload(MATTER_DOCS, 1, {
      finalize: () => ({
        documents: [],
        failures: [{ objectPath: 'docs/0', fileName: 'f0.pdf', error: 'That file type is not allowed.' }],
      }),
    });

    // Resolving here is how a refused single file read as "Upload complete".
    await expect(clientPortalService.uploadMatterDocuments(LAW_FIRM_ID, MATTER_ID, files(1)))
      .rejects.toThrow('That file type is not allowed.');
  });

  it('keeps the groups init opened when another group is refused, and names the refused files', async () => {
    let inits = 0;
    arrangeGroupedUpload(MATTER_DOCS, 10);
    api.post(`${MATTER_DOCS}/upload-init`, (call) => {
      inits += 1;
      const declared = (call.body as { files: Array<{ fileName: string }> }).files;
      if (inits === 2) return { status: 413, body: { error: 'Your firm is out of storage.' } };
      return {
        uploads: declared.map((f, i) => ({
          uploadUrl: sessionFor(i), objectPath: `docs/${i}`, fileId: `file-${i}`, fileName: f.fileName, declaredSize: 1,
        })),
      };
    });

    const result = await clientPortalService.uploadMatterDocuments(LAW_FIRM_ID, MATTER_ID, files(12));

    // The first group's rows and reservation are settled by its finalize rather
    // than left claimed because a later group was refused.
    expect(api.callsTo(`${MATTER_DOCS}/upload-finalize`)).toHaveLength(1);
    expect(result.documents).toHaveLength(10);
    expect(result.failures).toEqual([
      { name: 'f10.pdf', error: 'Your firm is out of storage.', index: 10 },
      { name: 'f11.pdf', error: 'Your firm is out of storage.', index: 11 },
    ]);
  });

  it('stops a checklist item upload on a cancel before it is recorded', async () => {
    const base = `/lawfirm/${LAW_FIRM_ID}/document-requests/req-1/items/item-1/fulfill`;
    const controller = new AbortController();
    arrangeGroupedUpload(base, 1, { onPut: () => controller.abort() });

    await expect(clientPortalService.fulfillRequestItem(
      LAW_FIRM_ID, 'req-1', 'item-1', files(1), undefined, undefined, controller.signal,
    )).rejects.toMatchObject({ name: 'UploadCancelledError' });

    // Finalize is what moves the checklist line to "received".
    expect(api.callsTo(`${base}/upload-finalize`)).toEqual([]);
  });

  it('gives back a cancelled checklist item upload through the item\'s own route', async () => {
    const base = `/lawfirm/${LAW_FIRM_ID}/document-requests/req-1/items/item-1/fulfill`;
    const controller = new AbortController();
    arrangeGroupedUpload(base, 1, { onPut: () => controller.abort() });

    await expect(clientPortalService.fulfillRequestItem(
      LAW_FIRM_ID, 'req-1', 'item-1', files(1), undefined, undefined, controller.signal,
    )).rejects.toMatchObject({ name: 'UploadCancelledError' });

    // The item route is the one that checks the request is still this
    // client's; the matter route would refuse a request-scoped row.
    await waitFor(() => api.callsTo(`${base}/upload-cancel`).length > 0);
    expect(api.callsTo(`${base}/upload-cancel`).map((c) => c.body)).toEqual([{ uploads: released(1) }]);
  });

  it('names the checklist files the server refused', async () => {
    const base = `/lawfirm/${LAW_FIRM_ID}/document-requests/req-1/items/item-1/fulfill`;
    arrangeGroupedUpload(base, 2, {
      finalize: () => ({
        documents: [{ fileId: 'file-0', name: 'f0.pdf' }],
        failures: [{ objectPath: 'docs/1', fileName: 'f1.pdf', error: 'Too large.' }],
        requestId: 'req-1',
        itemId: 'item-1',
      }),
    });

    const result = await clientPortalService.fulfillRequestItem(LAW_FIRM_ID, 'req-1', 'item-1', files(2));

    expect(result.failures).toEqual([{ name: 'f1.pdf', error: 'Too large.', index: 1 }]);
    expect(result.requestId).toBe('req-1');
  });
});

describe('messaging', () => {
  it('POSTs a message with its matter and attachments', async () => {
    api.post('/messages', { messageId: 'msg-1' });

    await clientPortalService.sendMessage(LAW_FIRM_ID, 'Hello', MATTER_ID, [{ objectPath: 'p' } as never]);

    const body = api.calls('POST')[0].body as Record<string, unknown>;
    expect(body.content).toBe('Hello');
    expect(body.matterId).toBe(MATTER_ID);
    expect(body.attachments).toEqual([{ objectPath: 'p' }]);
  });

  it('omits the matter on a message that is not about one', async () => {
    api.post('/messages', { messageId: 'msg-1' });

    await clientPortalService.sendMessage(LAW_FIRM_ID, 'Hello');

    // A message tagged to a matter appears on that matter's thread for the firm.
    // Inventing one files a general question under a case it has nothing to do
    // with.
    expect((api.calls('POST')[0].body as Record<string, unknown>).matterId).toBeUndefined();
  });

  it('edits and deletes through the SHARED messaging routes, not the portal base', async () => {
    api.patch('/messaging/messages/msg-1', { messageId: 'msg-1', editedAt: '2026-01-01T00:00:00.000Z' });
    api.delete('/messaging/messages/msg-1', { messageId: 'msg-1' });

    await clientPortalService.editMessage('msg-1', 'Edited');
    await clientPortalService.deleteMessage('msg-1');

    // These two are the only methods on this service that leave the
    // `/client-portal` base. Sender-only enforcement lives on the shared
    // messaging router, so pointing them at a portal path would 404 rather than
    // reaching the check.
    expect(api.calls('PATCH')[0].pathname).toMatch(/\/messaging\/messages\/msg-1$/);
    expect(api.calls('DELETE')[0].pathname).toMatch(/\/messaging\/messages\/msg-1$/);
    expect((api.calls('PATCH')[0].body as Record<string, unknown>).content).toBe('Edited');
  });

  it('throws when an edit is refused', async () => {
    api.patch('/messaging/messages/msg-1', { status: 403, body: { error: 'You can only edit your own messages' } });

    await expect(clientPortalService.editMessage('msg-1', 'Edited'))
      .rejects.toThrow(/only edit your own/i);
  });

  it('sends a search phrase with its spaces intact', async () => {
    api.get('/messaging/search', { results: [{ id: 'm1' }] });

    await clientPortalService.searchMessages('retainer agreement');

    // Read back through URLSearchParams. A query string encodes a space as `+`,
    // so a raw substring check on the url would fail on a perfectly correct
    // request and a decodeURIComponent check would leave the `+` in place.
    expect(paramsOf(api.calls('GET')[0].url).get('q')).toBe('retainer agreement');
  });

  it('defaults a missing search results list', async () => {
    api.get('/messaging/search', {});

    expect(await clientPortalService.searchMessages('x')).toEqual([]);
  });

  it('PUTs the exact id list when marking messages read', async () => {
    api.put('/messages/mark-read', {});

    await clientPortalService.markAsRead(LAW_FIRM_ID, ['m1', 'm2']);

    // The list is the whole instruction. Marking the wrong ids read hides
    // unread firm messages behind a cleared badge.
    expect((api.calls('PUT')[0].body as Record<string, unknown>).messageIds).toEqual(['m1', 'm2']);
  });

  it('pages the direct thread by limit and cursor', async () => {
    api.get('/messages', { messages: [], hasMore: false });

    await clientPortalService.getMessages(LAW_FIRM_ID, { limit: 30, lastMessageId: 'msg-40' });

    // `lastMessageId` is the OLDEST message already held, so the server returns
    // the page before it. Dropping it re-serves the newest page forever and the
    // thread never scrolls back.
    const params = paramsOf(api.calls('GET')[0].url);
    expect(params.get('limit')).toBe('30');
    expect(params.get('lastMessageId')).toBe('msg-40');
  });

  it('omits both paging parameters on the first page', async () => {
    api.get('/messages', { messages: [] });

    await clientPortalService.getMessages(LAW_FIRM_ID);

    expect(api.calls('GET')[0].url).not.toContain('lastMessageId');
    expect(api.calls('GET')[0].url).not.toContain('limit');
  });

  it('lists every conversation for one firm', async () => {
    api.get('/messages/conversations', { conversations: [{ id: 'c1' }, { id: 'c2' }], totalItems: 2 });

    const result = await clientPortalService.listConversations(LAW_FIRM_ID);

    // A person on two companies has a direct thread plus a canonical thread per
    // company. Returning only one of them hides a whole conversation.
    expect(result.conversations).toHaveLength(2);
  });

  it('CHARACTERISATION: a group page sends limit 0 where the direct thread drops it', async () => {
    api.get('/client-groups/conv-1', { conversation: {}, messages: [] });
    api.get('/messages', { messages: [] });

    await clientPortalService.getGroup('conv-1', { limit: 0 });
    await clientPortalService.getMessages(LAW_FIRM_ID, { limit: 0 });

    // The two guards differ: `!= null` here, truthiness there. A caller that
    // computes a page size and lands on zero therefore asks the group route for
    // an explicit empty page and the direct route for the server default. The
    // divergence is recorded rather than unified, because unifying it changes
    // one of the two live behaviours.
    expect(paramsOf(api.calls('GET')[0].url).get('limit')).toBe('0');
    expect(api.calls('GET')[1].url).not.toContain('limit');
  });

  it('sends a group message to the group route and marks it read on another', async () => {
    api.post('/client-groups/conv-1/messages', { messageId: 'm1', conversationId: 'conv-1' });
    api.put('/client-groups/conv-1/mark-read', {});

    await clientPortalService.sendGroupMessage('conv-1', 'Hi', [{ objectPath: 'p' } as never]);
    await clientPortalService.markGroupRead('conv-1');

    expect(api.calls('POST')[0].pathname).toMatch(/\/client-groups\/conv-1\/messages$/);
    expect(api.calls('PUT')[0].pathname).toMatch(/\/client-groups\/conv-1\/mark-read$/);
  });

  it('defaults a missing group list', async () => {
    api.get('/messaging/client-groups', {});

    expect(await clientPortalService.listGroups()).toEqual([]);
  });

  it('sends a credential on the unread poll', async () => {
    api.get('/unread-count', { totalUnread: 3, unreadByFirm: { [LAW_FIRM_ID]: 3 } });

    const result = await clientPortalService.getUnreadCount();

    // This one resolves its own token with a forced refresh instead of going
    // through `authenticatedHeaders`, so the header is built by hand and is the
    // only thing scoping the count to this client.
    expect(api.calls('GET')[0].headers.authorization).toMatch(/^Bearer /);
    expect(result.totalUnread).toBe(3);
  });
});

describe('trust money', () => {
  it('reads the balance in integer cents', async () => {
    api.get('/trust/balance', {
      clientId: 'c1', totalBalanceCents: 250000,
      accountBalances: [{ clientId: 'c1', trustAccountId: 't1', accountName: 'IOLTA', balanceCents: 250000 }],
    });

    const result = await clientPortalService.getTrustBalance(LAW_FIRM_ID, CLIENT_RECORD_ID);

    // $2,500.00 held in trust. Compared as cents; a service that scaled it would
    // show a client the wrong figure for money that is legally theirs.
    expect(result.totalBalanceCents).toBe(250000);
    expect(paramsOf(api.calls('GET')[0].url).get('clientRecordId')).toBe(CLIENT_RECORD_ID);
  });

  it('sends an offset of ZERO for the first ledger page', async () => {
    api.get('/trust/ledger', { transactions: [], totalItems: 0 });

    await clientPortalService.getTrustLedger(LAW_FIRM_ID, { limit: 50, offset: 0 });

    // The guard is `typeof === 'number'`, not truthiness, and it has to be: a
    // truthiness guard drops offset 0 and every "back to page one" click would
    // silently keep the previous page's offset.
    const params = paramsOf(api.calls('GET')[0].url);
    expect(params.get('offset')).toBe('0');
    expect(params.get('limit')).toBe('50');
  });

  it('omits paging entirely when the caller passes none', async () => {
    api.get('/trust/ledger', { transactions: [], totalItems: 0 });

    await clientPortalService.getTrustLedger(LAW_FIRM_ID);

    const url = api.calls('GET')[0].url;
    expect(url).not.toContain('limit');
    expect(url).not.toContain('offset');
  });

  it('CHARACTERISATION: forwards a limit above the backend maximum', async () => {
    api.get('/trust/ledger', { transactions: [], totalItems: 0 });

    await clientPortalService.getTrustLedger(LAW_FIRM_ID, { limit: 5000 });

    // The route validates 1-200 and answers 400. Nothing clamps client-side, so
    // an over-large page size surfaces as a failed ledger rather than a capped
    // one. Recorded so a future clamp is a deliberate change.
    expect(paramsOf(api.calls('GET')[0].url).get('limit')).toBe('5000');
  });

  it('throws when the ledger is refused', async () => {
    api.get('/trust/ledger', { status: 403, body: { error: 'Trust access is not enabled for you' } });

    // An empty ledger reads as "no money has moved". For a trust account that is
    // the wrong thing to tell someone.
    await expect(clientPortalService.getTrustLedger(LAW_FIRM_ID))
      .rejects.toThrow(/trust access/i);
  });
});

describe('events', () => {
  it('scopes the agenda to one matter when asked', async () => {
    api.get('/events', { events: [{ id: 'e1' }], truncated: false });

    await clientPortalService.getEvents(LAW_FIRM_ID, { matterId: 'matter with space' });

    // The server caps the agenda, so a matter's events can sit entirely past the
    // cap of the firm-wide list. Read back through URLSearchParams so the
    // space's encoding does not decide the result.
    expect(paramsOf(api.calls('GET')[0].url).get('matterId')).toBe('matter with space');
  });

  it('defaults the event list and carries truncation', async () => {
    api.get('/events', { truncated: true });

    const result = await clientPortalService.getEvents(LAW_FIRM_ID);

    expect(result.events).toEqual([]);
    expect(result.truncated).toBe(true);
  });


});

describe('notifications', () => {
  it('sends unreadOnly only when it is true', async () => {
    api.get('/notifications', { notifications: [] });

    await clientPortalService.getNotifications(LAW_FIRM_ID, { unreadOnly: true });
    await clientPortalService.getNotifications(LAW_FIRM_ID, { unreadOnly: false });

    // "false" is a truthy string server-side, so sending it would filter to
    // unread when the client asked for everything.
    expect(paramsOf(api.calls('GET')[0].url).get('unreadOnly')).toBe('true');
    expect(api.calls('GET')[1].url).not.toContain('unreadOnly');
  });

  it('sends each cursor field under its own key', async () => {
    api.get('/notifications', { notifications: [] });

    await clientPortalService.getNotifications(LAW_FIRM_ID, {
      limit: 20, before: '2026-01-01T00:00:00.000Z', beforeId: 'n-40',
    });

    // The cursor is a timestamp PLUS an id, because notifications created in the
    // same millisecond would otherwise repeat or be skipped between pages.
    const params = paramsOf(api.calls('GET')[0].url);
    expect(params.get('limit')).toBe('20');
    expect(params.get('before')).toBe('2026-01-01T00:00:00.000Z');
    expect(params.get('beforeId')).toBe('n-40');
  });

  it('coerces a string unread count to a number', async () => {
    api.get('/notifications', { notifications: [], unreadCount: '5' });

    // The bell renders this and compares it to zero. A string "0" is truthy and
    // would show a badge to a client with nothing unread.
    expect((await clientPortalService.getNotifications(LAW_FIRM_ID)).unreadCount).toBe(5);
  });

  it('falls back to zero for an unreadable count', async () => {
    api.get('/notifications', { notifications: [] });

    expect((await clientPortalService.getNotifications(LAW_FIRM_ID)).unreadCount).toBe(0);
  });

  it('defaults both cursor fields to null', async () => {
    api.get('/notifications', { notifications: [] });

    const result = await clientPortalService.getNotifications(LAW_FIRM_ID);

    // The feed stops paging on null. `undefined` would be passed straight back
    // as the next cursor and re-request the newest page.
    expect(result.nextBefore).toBeNull();
    expect(result.nextBeforeId).toBeNull();
  });

  it('marks one notification read, and all of them, on DIFFERENT routes', async () => {
    api.post('/notifications/n-1/read', {});
    api.post('/notifications/mark-all-read', {});

    await clientPortalService.markNotificationRead(LAW_FIRM_ID, 'n-1');
    await clientPortalService.markAllNotificationsRead(LAW_FIRM_ID);

    // Near-identical signatures over a one-row update and a whole-feed update.
    // Sending the single one to mark-all-read clears every unread notice the
    // client had, and they never learn what was in them.
    expect(api.calls('POST')[0].pathname).toMatch(/\/notifications\/n-1\/read$/);
    expect(api.calls('POST')[1].pathname).toMatch(/\/notifications\/mark-all-read$/);
  });

  it('throws when marking read is refused', async () => {
    api.post('/notifications/n-1/read', { status: 404, body: { error: 'Notification not found' } });

    await expect(clientPortalService.markNotificationRead(LAW_FIRM_ID, 'n-1'))
      .rejects.toThrow(/not found/i);
  });
});
