/**
 * The firm contact directory service, tested OFFLINE against a fake transport.
 *
 * The only existing coverage of this module is indirect: component specs run
 * under the global service Proxy in `tests/setup.ts`, where every method of
 * `contacts.service` resolves to `{}`. Under that default nothing here can fail,
 * because none of it runs. This file unmocks the service and the deduplicator
 * and fakes `fetch` instead, so url building, query-parameter construction,
 * envelope unwrapping and `ApiError` handling all execute for real.
 *
 * WHAT THIS FILE IS ABOUT
 *
 * 1. THE FIRM SEGMENT IS THE TENANT BOUNDARY. Every contact route is
 *    `/lawfirms/:lawFirmId/contacts...`, and the app, not Postgres, is what
 *    scopes the read. A request that loses that segment returns a
 *    same-shaped list of somebody else's contacts, which no assertion about the
 *    response body would notice.
 *
 * 2. AN OMITTED FILTER IS NOT AN EMPTY ONE. Each filter here is conditional, and
 *    the failure mode is silent in both directions: a filter sent blank narrows
 *    a list to nothing, and a filter dropped widens it past what the user asked
 *    for. Neither looks like an error on screen.
 *
 * 3. A REFUSAL IS NOT AN EMPTY DIRECTORY. A 403 and a firm with no contacts
 *    render the same empty table. Only one of them is worth telling the user
 *    about, so the read has to throw rather than resolve to `[]`.
 */
jest.unmock('@/services/contacts.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import contactsService from '@/services/contacts.service';
import { ApiError } from '@/lib/utils/apiErrors';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

const LAW_FIRM_ID = 'firm-1';
const OTHER_FIRM_ID = 'firm-2';
const CONTACT_ID = 'contact-7';

/**
 * Query parameters read back the way a server reads them.
 *
 * A query string encodes a space as `+`, so a value asserted through
 * `decodeURIComponent` keeps a literal plus and passes on a string the backend
 * would never match.
 */
const paramsOf = (url: string): URLSearchParams => new URL(url, 'http://x').searchParams;

const bodyOf = (call: { body: unknown }): Record<string, unknown> =>
  call.body as Record<string, unknown>;

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  // Several cases read one endpoint twice to compare two parameter sets, which
  // trips the dev-only duplicate-GET warning and buries the real output.
  __resetDuplicateRequestGuard();
});

afterEach(() => {
  api.restore();
});

describe('the firm segment is the tenant boundary', () => {
  it('scopes the directory list to the firm in the path', async () => {
    api.get('/contacts', { contacts: [], totalItems: 0 });

    await contactsService.listContactsPaged(LAW_FIRM_ID);

    // Tenant scoping is the application's job on these routes. Without this
    // segment the request is not a narrower read of the same data, it is a read
    // of another firm's directory, and the response shape is identical.
    expect(api.calls('GET')[0].pathname).toBe('/api/lawfirms/firm-1/contacts');
  });

  it('follows the firm id the caller passed, not a remembered one', async () => {
    api.get('/contacts', { contacts: [], totalItems: 0 });

    await contactsService.listContactsPaged(LAW_FIRM_ID);
    await contactsService.listContactsPaged(OTHER_FIRM_ID);

    // The service is a module singleton shared by every page. Caching the firm
    // on it would serve the first firm's contacts to a user who switched firms.
    expect(api.calls('GET').map((call) => call.pathname)).toEqual([
      '/api/lawfirms/firm-1/contacts',
      '/api/lawfirms/firm-2/contacts',
    ]);
  });

  it('keeps the firm segment on every contact sub-route', async () => {
    api.get(`/contacts/${CONTACT_ID}`, { contact: { id: CONTACT_ID, name: 'Judge Doe' }, matters: [] });
    api.get('/contacts/tags', { tags: [] });
    api.get('/contacts/lookup', { items: [], hasMore: false });
    api.get('/contacts/duplicate-check', { duplicates: [] });

    await contactsService.getContact(LAW_FIRM_ID, CONTACT_ID);
    await contactsService.listTags(LAW_FIRM_ID);
    await contactsService.lookupContacts(LAW_FIRM_ID, { search: 'doe' });
    await contactsService.checkDuplicates(LAW_FIRM_ID, { name: 'Doe' });

    // The typeahead and the duplicate check are the two that leak quietest: both
    // answer with names only, so an unscoped one looks like a working picker
    // that happens to know contacts the firm never entered.
    for (const call of api.calls('GET')) {
      expect(call.pathname.startsWith('/api/lawfirms/firm-1/contacts')).toBe(true);
    }
  });

  it('escapes a firm id so it cannot add a path segment', async () => {
    api.get('/contacts', { contacts: [], totalItems: 0 });

    await contactsService.listContactsPaged('firm/1');

    // Unescaped, a slash in the id splits it across two segments and the request
    // addresses a shorter route that may still answer.
    expect(api.calls('GET')[0].pathname).toBe('/api/lawfirms/firm%2F1/contacts');
  });

  it('sends the credential and the timezone the backend requires', async () => {
    api.get('/contacts', { contacts: [], totalItems: 0 });

    await contactsService.listContactsPaged(LAW_FIRM_ID);

    // `requireTimezone` rejects a request carrying no `X-Timezone`, so losing
    // the header turns every contact read into a 400 that reads as a broken page
    // rather than as a missing header.
    const { headers } = api.calls('GET')[0];
    expect(headers.authorization).toBe('Bearer mock-token');
    expect(headers['x-timezone']).toBeTruthy();
  });
});

describe('the list window the pager depends on', () => {
  it('asks for a first page of fifty when the caller names no window', async () => {
    api.get('/contacts', { contacts: [], totalItems: 0 });

    await contactsService.listContactsPaged(LAW_FIRM_ID);

    // An absent limit is not an unlimited read: the endpoint would answer with
    // its own default and the pager would then divide by a page size it never
    // chose, so the last page is unreachable.
    const query = paramsOf(api.calls('GET')[0].url);
    expect(query.get('limit')).toBe('50');
    expect(query.get('page')).toBe('1');
  });

  it('clamps an oversized limit to what the endpoint schema accepts', async () => {
    api.get('/contacts', { contacts: [], totalItems: 0 });

    await contactsService.listContactsPaged(LAW_FIRM_ID, { limit: 5000 });

    // The route's schema caps this at 500 and rejects anything larger outright.
    // Trimming here turns "export everything" into a served request instead of a
    // 400 the export button has no way to explain.
    expect(paramsOf(api.calls('GET')[0].url).get('limit')).toBe('500');
  });

  it('raises a zero limit to one rather than asking for nothing', async () => {
    api.get('/contacts', { contacts: [], totalItems: 0 });

    await contactsService.listContactsPaged(LAW_FIRM_ID, { limit: 0 });

    // `limit=0` is a request for an empty page that the pager reads as a firm
    // with no contacts.
    expect(paramsOf(api.calls('GET')[0].url).get('limit')).toBe('1');
  });

  it('sends an explicit offset instead of a page, never both', async () => {
    api.get('/contacts', { contacts: [], totalItems: 0 });

    await contactsService.listContactsPaged(LAW_FIRM_ID, { offset: 40, page: 3 });

    // The server prefers offset when both arrive, so sending a page alongside it
    // is at best noise in the React Query key and at worst a second, conflicting
    // window on an endpoint that later stops tolerating the pair.
    const query = paramsOf(api.calls('GET')[0].url);
    expect(query.get('offset')).toBe('40');
    expect(query.get('page')).toBeNull();
  });

  it('sends a page when there is no offset', async () => {
    api.get('/contacts', { contacts: [], totalItems: 0 });

    await contactsService.listContactsPaged(LAW_FIRM_ID, { page: 3 });

    const query = paramsOf(api.calls('GET')[0].url);
    expect(query.get('page')).toBe('3');
    expect(query.get('offset')).toBeNull();
  });
});

describe('an omitted filter is not an empty one', () => {
  it('carries every directory filter under the name the route reads', async () => {
    api.get('/contacts', { contacts: [], totalItems: 0 });

    await contactsService.listContactsPaged(LAW_FIRM_ID, {
      category: 'opposing_counsel',
      matterId: 'matter-9',
      courtId: 'court-3',
      hasCourt: true,
      tags: ['probate', 'urgent'],
      archived: 'all',
      oneTime: 'false',
    });

    // `matterId` and `courtId` are both ids of a thing a contact is attached to,
    // and swapping them returns a plausible non-empty list of the wrong
    // contacts: the people at a court rather than the people on a matter.
    const query = paramsOf(api.calls('GET')[0].url);
    expect(query.get('category')).toBe('opposing_counsel');
    expect(query.get('matterId')).toBe('matter-9');
    expect(query.get('courtId')).toBe('court-3');
    expect(query.get('hasCourt')).toBe('true');
    expect(query.get('tags')).toBe('probate,urgent');
    expect(query.get('archived')).toBe('all');
    expect(query.get('oneTime')).toBe('false');
  });

  it('drops the filters the caller left unset rather than sending them blank', async () => {
    api.get('/contacts', { contacts: [], totalItems: 0 });

    await contactsService.listContactsPaged(LAW_FIRM_ID, {
      category: '', tags: [], hasCourt: false,
    });

    // The "All categories" option is the empty string. Sent as `category=`, the
    // route matches contacts whose category is blank, which is none of them, so
    // clearing the filter empties the directory.
    const query = paramsOf(api.calls('GET')[0].url);
    expect(query.get('category')).toBeNull();
    expect(query.get('tags')).toBeNull();
    expect(query.get('hasCourt')).toBeNull();
    expect(api.calls('GET')[0].url).not.toContain('undefined');
  });

  it('never spells an absent value as the string "undefined"', async () => {
    api.get('/contacts', { contacts: [], totalItems: 0 });

    await contactsService.listContactsPaged(LAW_FIRM_ID, { page: 2 });

    // A parameter interpolated without a guard reaches the server as the literal
    // text `undefined`, which passes a "was it sent" check and matches no row.
    const query = paramsOf(api.calls('GET')[0].url);
    expect(query.get('category')).toBeNull();
    expect(query.get('matterId')).toBeNull();
    expect(query.get('archived')).toBeNull();
    expect(query.get('oneTime')).toBeNull();
  });

  it('trims a search term and omits one that is only whitespace', async () => {
    api.get('/contacts', { contacts: [], totalItems: 0 });

    await contactsService.listContactsPaged(LAW_FIRM_ID, { search: '  Ada Lovelace  ' });
    await contactsService.listContactsPaged(LAW_FIRM_ID, { search: '   ' });

    // Read through URLSearchParams, because a space is on the wire as `+`.
    // A whitespace-only search comes from a user clearing the box; sent, it
    // matches nothing and the directory looks empty instead of restored.
    const [searched, cleared] = api.calls('GET').map((call) => paramsOf(call.url));
    expect(searched.get('search')).toBe('Ada Lovelace');
    expect(cleared.get('search')).toBeNull();
  });

  it('serializes a multi-column sort as the field:direction pairs the route validates', async () => {
    api.get('/contacts', { contacts: [], totalItems: 0 });

    await contactsService.listContactsPaged(LAW_FIRM_ID, {
      sort: [{ field: 'name', sort: 'asc' }, { field: 'category', sort: 'desc' }],
      sortBy: 'name',
      order: 'asc',
    });

    // The backend validates this string with a regex and 400s on any other
    // shape, so a JSON-encoded sort model fails the whole read rather than
    // falling back to the default order.
    const query = paramsOf(api.calls('GET')[0].url);
    expect(query.get('sort')).toBe('name:asc,category:desc');
    expect(query.get('sortBy')).toBe('name');
    expect(query.get('order')).toBe('asc');
  });
});

describe('what a directory read returns', () => {
  it('unwraps the contacts key and reports the server total', async () => {
    api.get('/contacts', {
      contacts: [{ id: CONTACT_ID, name: 'Judge Doe' }],
      totalItems: 87,
    });

    const { contacts, totalItems } = await contactsService.listContactsPaged(LAW_FIRM_ID);

    // The envelope key is the contract. Reading the response as the array itself
    // yields an empty directory on a request that succeeded.
    expect(contacts).toHaveLength(1);
    expect(contacts[0].id).toBe(CONTACT_ID);
    expect(totalItems).toBe(87);
  });

  it('falls back to the returned count when the server sends no total', async () => {
    api.get('/contacts', { contacts: [{ id: 'c1', name: 'A' }, { id: 'c2', name: 'B' }] });

    const { totalItems } = await contactsService.listContactsPaged(LAW_FIRM_ID);

    // The pager divides by this. Undefined renders a NaN page count and the
    // next-page control never enables.
    expect(totalItems).toBe(2);
  });

  it('unwraps a lookup into items and the truncation flag', async () => {
    api.get('/contacts/lookup', {
      items: [{ id: CONTACT_ID, label: 'Judge Doe' }],
      hasMore: true,
    });

    const result = await contactsService.lookupContacts(LAW_FIRM_ID, { search: 'doe' });

    // `hasMore` is how the picker knows to prompt for a narrower search rather
    // than presenting a truncated list as the complete set.
    expect(result.items).toHaveLength(1);
    expect(result.hasMore).toBe(true);
  });

  it('reports a lookup that mentioned neither key as empty and complete', async () => {
    api.get('/contacts/lookup', {});

    const result = await contactsService.lookupContacts(LAW_FIRM_ID);

    // An undefined `items` would be mapped over by the picker, and an undefined
    // `hasMore` renders the "narrow your search" hint on every empty result.
    expect(result.items).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it('unwraps the tags list for the filter menu', async () => {
    api.get('/contacts/tags', { tags: ['probate', 'urgent'] });

    const tags = await contactsService.listTags(LAW_FIRM_ID);

    expect(tags).toEqual(['probate', 'urgent']);
  });

  it('reads a contact and its matter links out of one envelope', async () => {
    api.get(`/contacts/${CONTACT_ID}`, {
      contact: { id: CONTACT_ID, name: 'Judge Doe', tags: ['probate'] },
      matters: [{ linkId: 'link-1', matterId: 'matter-9', matterName: 'Estate of Doe', role: 'judge' }],
    });

    const { contact, matters } = await contactsService.getContact(LAW_FIRM_ID, CONTACT_ID);

    // Two collections in one response, and the detail page renders each in its
    // own panel. Crossing them shows matter links where the contact's own
    // fields belong.
    expect(contact.id).toBe(CONTACT_ID);
    expect(matters[0].matterId).toBe('matter-9');
    expect(matters[0].linkId).toBe('link-1');
  });

  it('defaults the matter links to empty rather than undefined', async () => {
    api.get(`/contacts/${CONTACT_ID}`, { contact: { id: CONTACT_ID, name: 'Judge Doe' } });

    const { matters } = await contactsService.getContact(LAW_FIRM_ID, CONTACT_ID);

    // The detail page maps over this. Undefined throws while rendering a contact
    // that loaded perfectly well.
    expect(matters).toEqual([]);
  });

  it('refuses to return a contact the response did not contain', async () => {
    api.get(`/contacts/${CONTACT_ID}`, { matters: [] });

    // A 200 carrying no contact is a route change or a deleted row, and passing
    // the undefined through leaves the detail page reading fields off nothing.
    await expect(contactsService.getContact(LAW_FIRM_ID, CONTACT_ID))
      .rejects.toThrow('Contact not found');
    expect(api.callsTo(`/contacts/${CONTACT_ID}`)).toHaveLength(1);
  });
});

describe('a lookup narrows the picker it feeds', () => {
  it('excludes the contacts already on a matter', async () => {
    api.get('/contacts/lookup', { items: [], hasMore: false });

    await contactsService.lookupContacts(LAW_FIRM_ID, {
      search: 'doe', excludeMatterId: 'matter-9', category: 'expert', limit: 10,
    });

    // The add-to-matter picker must not offer someone already linked, because
    // the link endpoint then rejects the choice as a duplicate and the user has
    // no way to tell which name is safe to pick.
    const query = paramsOf(api.calls('GET')[0].url);
    expect(query.get('excludeMatterId')).toBe('matter-9');
    expect(query.get('category')).toBe('expert');
    expect(query.get('limit')).toBe('10');
    expect(query.get('search')).toBe('doe');
  });

  it('resolves a set of known ids as one comma-joined parameter', async () => {
    api.get('/contacts/lookup', { items: [], hasMore: false });

    await contactsService.lookupContacts(LAW_FIRM_ID, { ids: ['c1', 'c2', 'c3'] });

    // The label resolver for already-selected chips sends the ids it holds.
    // Repeating the key or JSON-encoding the array both parse to something the
    // route matches no contact against, so the chips render with blank names.
    const query = paramsOf(api.calls('GET')[0].url);
    expect(query.get('ids')).toBe('c1,c2,c3');
    expect(query.getAll('ids')).toHaveLength(1);
  });

  it('asks for whole contacts only when the caller needs to pre-fill a form', async () => {
    api.get('/contacts/lookup', { items: [], hasMore: false });

    await contactsService.lookupContacts(LAW_FIRM_ID, { search: 'doe', full: true });
    await contactsService.lookupContacts(LAW_FIRM_ID, { search: 'doe' });

    // `full=true` returns the entire record per row. Sending it by default makes
    // every typeahead keystroke carry the whole directory; never sending it
    // leaves the pre-fill form with a label and an id and nothing else.
    const [withFull, withoutFull] = api.calls('GET').map((call) => paramsOf(call.url));
    expect(withFull.get('full')).toBe('true');
    expect(withoutFull.get('full')).toBeNull();
  });

  it('sends an explicit limit of zero rather than treating it as unset', async () => {
    api.get('/contacts/lookup', { items: [], hasMore: false });

    await contactsService.lookupContacts(LAW_FIRM_ID, { limit: 0 });

    // Zero is a real value a caller can pass to ask only for `hasMore`. Guarding
    // on truthiness instead of on null drops it and fetches a full page.
    expect(paramsOf(api.calls('GET')[0].url).get('limit')).toBe('0');
  });
});

describe('which id goes in the path and which in the body', () => {
  it('addresses one contact by id in the path, not as a query parameter', async () => {
    api.get(`/contacts/${CONTACT_ID}`, { contact: { id: CONTACT_ID, name: 'Judge Doe' }, matters: [] });

    await contactsService.getContact(LAW_FIRM_ID, CONTACT_ID);

    // The service also hands the ids to the deduplicator as its cache key. Those
    // are two different things: the key decides which in-flight reads coalesce,
    // the url decides what is read. Sending the id only as the key requests the
    // whole directory and renders its first row as the contact.
    const call = api.calls('GET')[0];
    expect(call.pathname).toBe(`/api/lawfirms/firm-1/contacts/${CONTACT_ID}`);
    expect(paramsOf(call.url).get('contactId')).toBeNull();
  });

  it('escapes a contact id so it cannot add a path segment', async () => {
    const messyId = 'contact/7 a';
    api.get(`/contacts/${encodeURIComponent(messyId)}`, { contact: { id: messyId, name: 'X' }, matters: [] });

    await contactsService.getContact(LAW_FIRM_ID, messyId);

    const { pathname } = api.calls('GET')[0];
    expect(pathname).toBe(`/api/lawfirms/firm-1/contacts/${encodeURIComponent(messyId)}`);
  });

  it('creates on the collection and updates on the member', async () => {
    api.post('/contacts', { message: 'ok', contactId: CONTACT_ID, contact: { id: CONTACT_ID } });
    api.put(`/contacts/${CONTACT_ID}`, { message: 'ok', contact: { id: CONTACT_ID } });

    await contactsService.createContact(LAW_FIRM_ID, { name: 'Judge Doe', category: 'judge' });
    await contactsService.updateContact(LAW_FIRM_ID, CONTACT_ID, { title: 'Presiding Judge' });

    // A create posted to the member url addresses a contact that does not exist
    // yet; an update put to the collection replaces nothing and answers 404 or,
    // worse, creates a second record.
    expect(api.calls('POST')[0].pathname).toBe('/api/lawfirms/firm-1/contacts');
    expect(api.calls('PUT')[0].pathname).toBe(`/api/lawfirms/firm-1/contacts/${CONTACT_ID}`);
  });

  it('sends a cleared field as null rather than dropping it from the update', async () => {
    api.put(`/contacts/${CONTACT_ID}`, { message: 'ok', contact: { id: CONTACT_ID } });

    await contactsService.updateContact(LAW_FIRM_ID, CONTACT_ID, {
      barNumber: null, organization: 'Doe & Partners',
    });

    // null clears the stored value; an omitted key leaves the old one in place.
    // The two look identical in an emptied form field and differ forever after.
    const body = bodyOf(api.calls('PUT')[0]);
    expect('barNumber' in body).toBe(true);
    expect(body.barNumber).toBeNull();
    expect(body.organization).toBe('Doe & Partners');
  });

  it('deletes the member with DELETE and reports the links it cascaded', async () => {
    api.delete(`/contacts/${CONTACT_ID}`, {
      message: 'ok', contactId: CONTACT_ID, unlinkedMatters: 3,
    });

    const result = await contactsService.deleteContact(LAW_FIRM_ID, CONTACT_ID);

    // The confirmation dialog quotes this count before the user commits, so
    // losing it understates how much the delete takes with it.
    expect(api.calls('DELETE')[0].pathname).toBe(`/api/lawfirms/firm-1/contacts/${CONTACT_ID}`);
    expect(result.unlinkedMatters).toBe(3);
  });
});

describe('import, export and the duplicate check', () => {
  it('posts the raw file text with the dialect the server should parse it as', async () => {
    api.post('/contacts/import', { message: 'ok', imported: 4, skipped: [], failed: [] });

    await contactsService.importContacts(LAW_FIRM_ID, 'vcard', 'BEGIN:VCARD\nFN:Judge Doe\nEND:VCARD');

    // Both dialects are parsed server-side so they are defined in one place.
    // Mislabelling the format parses a vCard as CSV, which yields one contact
    // per line, each named after a header field.
    const call = api.calls('POST')[0];
    expect(call.pathname).toBe('/api/lawfirms/firm-1/contacts/import');
    expect(bodyOf(call).format).toBe('vcard');
    expect(bodyOf(call).content).toContain('FN:Judge Doe');
  });

  it('reports the rows it skipped as already present', async () => {
    api.post('/contacts/import', {
      message: 'ok',
      imported: 1,
      skipped: [{ row: 2, name: 'Judge Doe', existingContactId: CONTACT_ID }],
      failed: [{ row: 5, reason: 'missing name' }],
    });

    const result = await contactsService.importContacts(LAW_FIRM_ID, 'csv', 'name\nJudge Doe');

    // The import summary tells the user which rows did not land and why. Losing
    // either list reports a clean import over a file that half failed.
    expect(result.imported).toBe(1);
    expect(result.skipped[0].existingContactId).toBe(CONTACT_ID);
    expect(result.failed[0].reason).toBe('missing name');
  });

  it('carries the on-screen filters onto the export so the file matches the table', async () => {
    api.get('/contacts/export', { ok: true });

    const blob = await contactsService.exportContacts(LAW_FIRM_ID, 'csv', {
      search: 'Ada Lovelace', category: 'expert', tags: ['probate', 'urgent'], archived: 'false',
    });

    // The export button sits above a filtered table. Dropping the filters
    // downloads the whole directory under a filename that says otherwise.
    const query = paramsOf(api.calls('GET')[0].url);
    expect(query.get('format')).toBe('csv');
    expect(query.get('search')).toBe('Ada Lovelace');
    expect(query.get('category')).toBe('expert');
    expect(query.get('tags')).toBe('probate,urgent');
    expect(query.get('archived')).toBe('false');
    expect(blob).toBeInstanceOf(Blob);
  });

  it('omits the export filters the caller did not set', async () => {
    api.get('/contacts/export', { ok: true });

    await contactsService.exportContacts(LAW_FIRM_ID, 'vcard');

    const query = paramsOf(api.calls('GET')[0].url);
    expect(query.get('format')).toBe('vcard');
    expect(query.get('search')).toBeNull();
    expect(query.get('tags')).toBeNull();
    expect(api.calls('GET')[0].url).not.toContain('undefined');
  });

  it('checks for a near-duplicate on the fields the user has typed so far', async () => {
    api.get('/contacts/duplicate-check', {
      duplicates: [{ id: CONTACT_ID, name: 'Judge Doe' }],
    });

    const { duplicates } = await contactsService.checkDuplicates(LAW_FIRM_ID, { name: 'Judge Doe' });

    // The create form calls this while the user types, so a half-filled form
    // sends only what it has. Sending the absent email as an empty parameter
    // matches every contact without one and warns on all of them.
    const query = paramsOf(api.calls('GET')[0].url);
    expect(query.get('name')).toBe('Judge Doe');
    expect(query.get('email')).toBeNull();
    expect(duplicates).toHaveLength(1);
  });

  it('reports no duplicates rather than undefined when the server found none', async () => {
    api.get('/contacts/duplicate-check', {});

    const { duplicates } = await contactsService.checkDuplicates(LAW_FIRM_ID, { email: 'doe@example.com' });

    // This result is rendered as an advisory list, not thrown. Undefined here
    // breaks the create form on a check that succeeded and found nothing.
    expect(duplicates).toEqual([]);
    expect(paramsOf(api.calls('GET')[0].url).get('email')).toBe('doe@example.com');
  });
});

describe('a refusal is not an empty directory', () => {
  it('throws a forbidden ApiError from the list rather than resolving to no contacts', async () => {
    api.get('/contacts', { status: 403, body: { error: 'Forbidden', code: 'FORBIDDEN' } });

    const error = await contactsService.listContactsPaged(LAW_FIRM_ID).catch((e) => e);

    // The request has to have gone out before the outcome means anything: an
    // assertion about the failure would pass just as well if nothing was sent.
    expect(api.callsTo('/contacts')).toHaveLength(1);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).isForbidden).toBe(true);
    expect((error as ApiError).status).toBe(403);
  });

  it('reads a refusal from the code alone when the status does not say so', async () => {
    api.get('/contacts/tags', { status: 400, body: { error: 'Denied', code: 'FORBIDDEN' } });

    const error = await contactsService.listTags(LAW_FIRM_ID).catch((e) => e);

    // Some routes answer a permission failure with a coded 400. Keying the
    // locked empty state off the status alone shows those as an error banner
    // telling the user to retry something that will never succeed.
    expect(api.callsTo('/contacts/tags')).toHaveLength(1);
    expect((error as ApiError).isForbidden).toBe(true);
  });

  it('does not read a plain 400 as a refusal', async () => {
    api.get('/contacts', { status: 400, body: { error: 'Bad limit', code: 'VALIDATION_ERROR' } });

    const error = await contactsService.listContactsPaged(LAW_FIRM_ID).catch((e) => e);

    // A validation failure is the caller's fault and is fixable; showing it as
    // a permissions lock hides a bug behind a message about access.
    expect(api.callsTo('/contacts')).toHaveLength(1);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).isForbidden).toBe(false);
  });

  it('throws on a refused write instead of reporting a saved contact', async () => {
    api.post('/contacts', { status: 403, body: { error: 'Forbidden', code: 'FORBIDDEN' } });

    const error = await contactsService
      .createContact(LAW_FIRM_ID, { name: 'Judge Doe' })
      .catch((e) => e);

    // Without the response check the method returns the parsed error body as if
    // it were the created contact, so the form closes and the directory shows a
    // row that was never saved.
    expect(api.calls('POST')).toHaveLength(1);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).isForbidden).toBe(true);
  });

  it('throws on a refused delete instead of reporting a removed contact', async () => {
    api.delete(`/contacts/${CONTACT_ID}`, { status: 403, body: { error: 'Forbidden', code: 'FORBIDDEN' } });

    const error = await contactsService.deleteContact(LAW_FIRM_ID, CONTACT_ID).catch((e) => e);

    expect(api.calls('DELETE')).toHaveLength(1);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).isForbidden).toBe(true);
  });

  it('throws on a refused update instead of reporting a saved edit', async () => {
    api.put(`/contacts/${CONTACT_ID}`, { status: 403, body: { error: 'Forbidden', code: 'FORBIDDEN' } });

    const error = await contactsService
      .updateContact(LAW_FIRM_ID, CONTACT_ID, { title: 'Presiding Judge' })
      .catch((e) => e);

    // Without the response check the method returns the parsed refusal as the
    // updated contact, so the edit form closes over changes the server rejected
    // and the row reverts on the next load with no explanation.
    expect(api.calls('PUT')).toHaveLength(1);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).isForbidden).toBe(true);
  });

  it('throws on a refused import rather than reporting an undefined count', async () => {
    api.post('/contacts/import', { status: 413, body: { error: 'File too large' } });

    const error = await contactsService
      .importContacts(LAW_FIRM_ID, 'csv', 'name\nJudge Doe')
      .catch((e) => e);

    // The import summary reads `imported` off the response. Handing the refusal
    // body back unchecked renders "undefined contacts imported" as a success.
    expect(api.calls('POST')).toHaveLength(1);
    expect((error as ApiError).message).toBe('File too large');
    expect((error as ApiError).status).toBe(413);
  });

  it('throws on a refused export rather than downloading the error body', async () => {
    api.get('/contacts/export', { status: 403, body: { error: 'Forbidden', code: 'FORBIDDEN' } });

    const error = await contactsService.exportContacts(LAW_FIRM_ID, 'csv').catch((e) => e);

    // The export path reads the response as a blob. Skipping the status check
    // hands the user a downloaded file whose contents are the JSON refusal.
    expect(api.callsTo('/contacts/export')).toHaveLength(1);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).isForbidden).toBe(true);
  });
});
