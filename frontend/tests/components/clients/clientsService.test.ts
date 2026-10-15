/**
 * The clients service, tested OFFLINE against a fake transport.
 *
 * The only other coverage of this module is one list call in the LIVE half
 * (`tests/services/services.live.test.ts`, which needs a running backend and a
 * Firebase token, so `npm test` never runs it). That exercises neither the
 * request the browser actually sends nor the normalisers, which is where this
 * module decides what a record IS.
 *
 * WHAT THIS FILE IS ABOUT
 *
 * 1. AN ORGANIZATION IS NOT A PERSON. `clients.client_type` is `'person'` or
 *    `'company'`, immutable after insert, and the UI calls the second one
 *    "Organization". Two spellings for one value is exactly the shape of a bug
 *    that mislabels every organization in the firm, and `normalizeClient`
 *    resolves it by a single equality check.
 *
 * 2. A ROSTER IS NOT A CONTACT LIST. One endpoint serves both, dispatched
 *    server-side on the owning client's type. A COMPANY's roster row links a
 *    real, standalone Person client (`personClientId`); a PERSON's related
 *    contact links a firm directory record (`contactId`). They are told apart
 *    only by which of those two fields is present, and the row's own `id` is a
 *    third thing again - the LINK - which is what every edit and delete
 *    addresses.
 *
 * 3. PATH VERSUS BODY. A client id appears in the path on the client-scoped
 *    routes and in the body on the firm-scoped invitation routes, and the
 *    contact routes carry two ids at once: the owner in the path, the linked
 *    person in the body. Swapping them is the standing failure mode here.
 */
jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import clientsService from '@/services/clients.service';
import { ApiError } from '@/lib/utils/apiErrors';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import { DEFAULT_CLIENT_SETTINGS } from '@/types';

const LAW_FIRM_ID = 'firm-1';
const COMPANY_ID = 'company-1';
const PERSON_ID = 'person-3';

/**
 * Query parameters read back the way a server reads them.
 *
 * A query string encodes a space as `+`, which `decodeURIComponent` leaves as a
 * literal plus, so an organization name asserted that way silently passes on a
 * value the backend would never match.
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

describe('an organization is not a person', () => {
  it('keeps the stored value "company" as it came off the wire', async () => {
    api.get('/clients', {
      clients: [{ id: COMPANY_ID, name: 'Acme Holdings', clientType: 'company' }],
    });

    const [client] = await clientsService.listClients(LAW_FIRM_ID);

    // `company` is the enum value in Postgres and the only one the backend
    // accepts. Everything downstream - the org badge, the roster tab, the
    // company-thread messaging - branches on it.
    expect(client.clientType).toBe('company');
  });

  it('does NOT accept the UI word "organization" as an organization', async () => {
    api.get('/clients', {
      clients: [{ id: COMPANY_ID, name: 'Acme Holdings', clientType: 'organization' }],
    });

    const [client] = await clientsService.listClients(LAW_FIRM_ID);

    // The product calls this an Organization and the database calls it a
    // company. Widening the check to accept the label would make the two
    // spellings interchangeable here and nowhere else, so a record created
    // through one path would read as an organization in the list and as a
    // person on its own page.
    expect(client.clientType).toBe('person');
  });

  it('treats a client with no clientType as a person', async () => {
    api.get('/clients', { clients: [{ id: PERSON_ID, name: 'Ada Lovelace' }] });

    const [client] = await clientsService.listClients(LAW_FIRM_ID);

    // Rows predating the organization migration carry no type. Defaulting the
    // other way would turn the firm's entire back catalogue of people into
    // organizations, each expecting a roster it does not have.
    expect(client.clientType).toBe('person');
  });

  it('asks the list for one client type by its stored value', async () => {
    api.get('/clients', { clients: [], totalItems: 0 });

    await clientsService.listClientsPaged(LAW_FIRM_ID, { clientType: 'company' });

    expect(paramsOf(api.calls('GET')[0].url).get('clientType')).toBe('company');
  });

  it('omits the type filter entirely when the caller did not narrow', async () => {
    api.get('/clients', { clients: [], totalItems: 0 });

    await clientsService.listClientsPaged(LAW_FIRM_ID);

    // An unfiltered list must return both kinds. A default of `person` slipped
    // in here would hide every organization from the clients page while the
    // page still reported a total that counted them.
    expect(paramsOf(api.calls('GET')[0].url).get('clientType')).toBeNull();
  });

  it('narrows a typeahead lookup to one type as well', async () => {
    api.get('/clients/lookup', { items: [], hasMore: false });

    await clientsService.lookupClients(LAW_FIRM_ID, { clientType: 'person', search: 'ada' });

    // The signer picker and the roster picker both need people only. Losing
    // this offers an organization where a human signature is required.
    const query = paramsOf(api.calls('GET')[0].url);
    expect(query.get('clientType')).toBe('person');
    expect(query.get('search')).toBe('ada');
  });

  it('keeps the spaces in an exact organization name', async () => {
    api.get('/clients/lookup', { items: [], hasMore: false });

    await clientsService.lookupClients(LAW_FIRM_ID, { exactOrganization: 'Acme Holdings LLC' });

    // Read through URLSearchParams: the query string carries this as
    // `Acme+Holdings+LLC`, and an exact match against "Acme+Holdings+LLC"
    // returns nobody, which reads as an organization with no colleagues.
    expect(paramsOf(api.calls('GET')[0].url).get('exactOrganization')).toBe('Acme Holdings LLC');
  });

  it('resolves labels by portal uid under a different key than by client id', async () => {
    api.get('/clients/lookup', { items: [], hasMore: false });

    await clientsService.lookupClients(LAW_FIRM_ID, { userIds: ['uid-a', 'uid-b'] });

    // Messaging stores participants by Firebase uid, not by client row id, so
    // those pickers have no id to resolve. The server rejects a request sending
    // both keys, and sending the uids under `ids` matches no client at all.
    const query = paramsOf(api.calls('GET')[0].url);
    expect(query.get('userIds')).toBe('uid-a,uid-b');
    expect(query.get('ids')).toBeNull();
  });

  it('excludes clients already linked to an organization from the picker', async () => {
    api.get('/clients/lookup', { items: [], hasMore: false });

    await clientsService.lookupClients(LAW_FIRM_ID, {
      excludeLinkedToClientId: COMPANY_ID, excludeArchived: true,
    });

    // The "add an existing client" picker on an organization's roster must not
    // offer someone already on it, because the link endpoint then rejects the
    // choice as a duplicate and the user has no way to tell which name is safe.
    const query = paramsOf(api.calls('GET')[0].url);
    expect(query.get('excludeLinkedToClientId')).toBe(COMPANY_ID);
    expect(query.get('excludeArchived')).toBe('true');
  });
});

describe('an organization roster is not a person related contacts', () => {
  it('keeps the LINK id and the linked person id apart on a roster row', async () => {
    api.get(`/clients/${COMPANY_ID}/contacts`, {
      contacts: [{ id: 'link-1', personClientId: 'person-9', name: 'Ada Lovelace' }],
    });

    const [contact] = await clientsService.listClientContacts(LAW_FIRM_ID, COMPANY_ID);

    // Three ids are in play: the organization (path), the link row, and the
    // person's own client record. Taking `id` from `personClientId` would make
    // every roster edit address the person's client row through the link
    // endpoint, which either 404s or patches an unrelated link.
    expect(contact.id).toBe('link-1');
    expect(contact.personClientId).toBe('person-9');
    expect(contact.contactId).toBeUndefined();
  });

  it('keeps a person related contact pointing at the directory record', async () => {
    api.get(`/clients/${PERSON_ID}/contacts`, {
      contacts: [{ id: 'link-2', contactId: 'directory-5', name: 'Grace Hopper', title: 'Guardian' }],
    });

    const [contact] = await clientsService.listClientContacts(LAW_FIRM_ID, PERSON_ID);

    // The two variants are told apart by which id is present. A related contact
    // that acquired a `personClientId` would be rendered as a roster member,
    // offering navigation to a client record that does not exist.
    expect(contact.contactId).toBe('directory-5');
    expect(contact.personClientId).toBeUndefined();
    expect(contact.id).toBe('link-2');
  });

  it('grants the link-owned access flags only on a literal true', async () => {
    api.get(`/clients/${COMPANY_ID}/contacts`, {
      contacts: [{
        id: 'link-1', personClientId: 'person-9', name: 'Ada Lovelace',
        canViewBilling: 'yes', isEmailRecipient: 1, isPrimary: 'true',
      }],
    });

    const [contact] = await clientsService.listClientContacts(LAW_FIRM_ID, COMPANY_ID);

    // `canViewBilling` decides whether this person sees the organization's
    // invoices in the portal. Loosening the check to truthiness lets any
    // non-empty value the backend happens to send open the firm's billing to
    // someone who was never granted it.
    expect(contact.canViewBilling).toBe(false);
    expect(contact.isEmailRecipient).toBe(false);
    expect(contact.isPrimary).toBe(false);
  });

  it('drops a contact row that carries no id', async () => {
    api.get(`/clients/${COMPANY_ID}/contacts`, {
      contacts: [{ personClientId: 'person-9', name: 'No Link' }, { id: 'link-1', personClientId: 'person-8', name: 'Ada' }],
    });

    const contacts = await clientsService.listClientContacts(LAW_FIRM_ID, COMPANY_ID);

    // A row with no link id renders a name whose edit and remove buttons both
    // address the empty string.
    expect(contacts.map((contact) => contact.id)).toEqual(['link-1']);
  });

  it('reads a person memberships from a different endpoint than their contacts', async () => {
    api.get(`/clients/${PERSON_ID}/contacts`, { contacts: [] });
    api.get(`/clients/${PERSON_ID}/company-relationships`, { relationships: [] });

    await clientsService.listClientContacts(LAW_FIRM_ID, PERSON_ID);
    await clientsService.listClientCompanyRelationships(LAW_FIRM_ID, PERSON_ID);

    // Opposite directions of the same link table. `/contacts` is who belongs to
    // this client; `/company-relationships` is which organizations this person
    // belongs to. Pointing one at the other shows a person's own contacts as
    // their employers, and the access flags would then be edited on the wrong row.
    const [contacts, memberships] = api.calls('GET').map((call) => call.pathname);
    expect(contacts).toMatch(/\/clients\/person-3\/contacts$/);
    expect(memberships).toMatch(/\/clients\/person-3\/company-relationships$/);
  });

  it('drops a membership missing the organization it points at', async () => {
    api.get(`/clients/${PERSON_ID}/company-relationships`, {
      relationships: [
        { id: 'link-1', companyName: 'Orphan', isPrimary: false, isEmailRecipient: false, canViewBilling: false },
        { id: 'link-2', companyClientId: COMPANY_ID, companyName: 'Acme', isPrimary: true, isEmailRecipient: true, canViewBilling: true },
      ],
    });

    const relationships = await clientsService.listClientCompanyRelationships(LAW_FIRM_ID, PERSON_ID);

    // The card links through to the organization. Without a company id it
    // navigates to the clients route with an empty segment.
    expect(relationships.map((relationship) => relationship.id)).toEqual(['link-2']);
  });

  it('normalizes the email-recipient count to a number, defaulting to zero', async () => {
    api.get(`/clients/${PERSON_ID}/company-relationships`, {
      relationships: [
        { id: 'l1', companyClientId: 'c1', companyName: 'A', isPrimary: false, isEmailRecipient: true, canViewBilling: false, companyEmailRecipientCount: '3' },
        { id: 'l2', companyClientId: 'c2', companyName: 'B', isPrimary: false, isEmailRecipient: false, canViewBilling: false },
      ],
    });

    const [withCount, without] = await clientsService.listClientCompanyRelationships(LAW_FIRM_ID, PERSON_ID);

    // The UI compares this against one to decide whether clearing "Receives
    // emails" would leave the organization with nobody to invoice. An undefined
    // count makes that comparison false, so the last recipient can be removed
    // and the organization's invoices then reach no one.
    expect(withCount.companyEmailRecipientCount).toBe(3);
    expect(without.companyEmailRecipientCount).toBe(0);
  });
});

describe('which id goes in the path and which in the body', () => {
  it('puts the owning organization in the path and the linked person in the body', async () => {
    api.post(`/clients/${COMPANY_ID}/contacts`, { message: 'ok', contactId: 'link-1' });

    await clientsService.createClientContact(LAW_FIRM_ID, COMPANY_ID, {
      personClientId: 'person-9', relationship: 'CFO', isEmailRecipient: true,
    });

    // Two client ids in one request, pointing opposite ways. Swapped, the
    // request adds the organization to the person's roster - a valid-looking
    // link that inverts the relationship and hands the wrong party billing
    // visibility.
    const call = api.calls('POST')[0];
    expect(call.pathname).toMatch(/\/clients\/company-1\/contacts$/);
    expect(bodyOf(call).personClientId).toBe('person-9');
    expect(bodyOf(call).clientId).toBeUndefined();
  });

  it('sends the directory id in the body when the owner is a person', async () => {
    api.post(`/clients/${PERSON_ID}/contacts`, { message: 'ok', contactId: 'link-2' });

    await clientsService.createClientContact(LAW_FIRM_ID, PERSON_ID, {
      contactId: 'directory-5', relationship: 'Guardian', title: 'Trustee',
    });

    // The same endpoint, a different body shape, chosen by the owning client's
    // own type. `personClientId` here would try to link a Person client as a
    // related contact of another person, which the roster branch alone accepts.
    const call = api.calls('POST')[0];
    expect(call.pathname).toMatch(/\/clients\/person-3\/contacts$/);
    expect(bodyOf(call).contactId).toBe('directory-5');
    expect(bodyOf(call).personClientId).toBeUndefined();
  });

  it('edits and removes a contact by its LINK id', async () => {
    api.put(`/clients/${COMPANY_ID}/contacts/link-1`, { message: 'ok' });
    api.delete(`/clients/${COMPANY_ID}/contacts/link-1`, { message: 'ok' });

    await clientsService.updateClientContact(LAW_FIRM_ID, COMPANY_ID, 'link-1', {
      relationship: 'CEO', canViewBilling: true,
    });
    await clientsService.deleteClientContact(LAW_FIRM_ID, COMPANY_ID, 'link-1');

    // The flags being edited belong to the link, not to the person, so they can
    // differ per organization. Addressing the person's client id instead would
    // change their standing at every organization they belong to.
    expect(api.calls('PUT')[0].pathname).toMatch(/\/contacts\/link-1$/);
    expect(api.calls('DELETE')[0].pathname).toMatch(/\/contacts\/link-1$/);
    expect(bodyOf(api.calls('PUT')[0])).toEqual({ relationship: 'CEO', canViewBilling: true });
  });

  it('escapes a link id so it cannot add a path segment', async () => {
    api.delete(`/contacts/${encodeURIComponent('link/1 a')}`, { message: 'ok' });

    await clientsService.deleteClientContact(LAW_FIRM_ID, COMPANY_ID, 'link/1 a');

    // Unescaped, `link/1 a` splits the id across two segments and the request
    // addresses a route that does not exist, or a shorter one that does.
    const { pathname } = api.calls('DELETE')[0];
    expect(pathname).toMatch(/\/clients\/company-1\/contacts\/[^/]+$/);
    expect(pathname).toContain(encodeURIComponent('link/1 a'));
  });

  it('names the client in the BODY on the firm-scoped resend route', async () => {
    api.post('/invitations/resend-client-invite', { message: 'sent', sent: true, resendCount: 1 });

    await clientsService.resendClientInvitation(LAW_FIRM_ID, PERSON_ID);

    // This route hangs off `/invitations`, not off the client, so the client id
    // has nowhere to go but the body. Moving it into the path 404s; dropping it
    // asks the server to resend an invitation to nobody in particular.
    const call = api.calls('POST')[0];
    expect(call.pathname).toMatch(/\/lawfirms\/firm-1\/invitations\/resend-client-invite$/);
    expect(call.pathname).not.toContain(PERSON_ID);
    expect(bodyOf(call).clientId).toBe(PERSON_ID);
  });

  it('names the client in the PATH on the client-scoped revoke route', async () => {
    api.post(`/clients/${PERSON_ID}/revoke-portal-access`, { message: 'revoked' });

    await clientsService.revokePortalAccess(LAW_FIRM_ID, PERSON_ID);

    // The mirror of the case above, and the reason both are worth pinning:
    // adjacent operations on the same subject put the same id in different
    // places, so copying one to write the other puts it in the wrong one.
    expect(api.calls('POST')[0].pathname).toMatch(/\/clients\/person-3\/revoke-portal-access$/);
  });

  it('revokes a pending invitation by INVITE id, not by client id', async () => {
    api.post('/invitations/client-invites/invite-7/revoke', { message: 'revoked', inviteId: 'invite-7' });

    await clientsService.revokeClientInvitation(LAW_FIRM_ID, 'invite-7');

    // A pending invite has no client row behind it yet. Addressing it by a
    // client id cancels nothing, and the invitation stays live.
    expect(api.calls('POST')[0].pathname).toMatch(/\/invitations\/client-invites\/invite-7\/revoke$/);
  });
});

describe('archiving a client is not deleting one', () => {
  it('archives with a status change, issuing no delete', async () => {
    api.put(`/clients/${PERSON_ID}`, { message: 'ok' });

    await clientsService.archiveClient(LAW_FIRM_ID, PERSON_ID);

    // Archiving keeps the row, its matters, its invoices and its history, and
    // only takes it out of the pickers. A delete here destroys a client the
    // firm expected to be able to reinstate.
    const call = api.calls('PUT')[0];
    expect(call.pathname).toMatch(/\/clients\/person-3$/);
    expect(bodyOf(call)).toEqual({ status: 'archived' });
    expect(api.calls('DELETE')).toHaveLength(0);
  });

  it('deletes with DELETE on the same path, sending no status', async () => {
    api.delete(`/clients/${PERSON_ID}`, { message: 'ok' });

    await clientsService.deleteClient(LAW_FIRM_ID, PERSON_ID);

    const call = api.calls('DELETE')[0];
    expect(call.pathname).toMatch(/\/clients\/person-3$/);
    expect(call.body).toBeNull();
    expect(api.calls('PUT')).toHaveLength(0);
  });
});

describe('what a client read returns', () => {
  it('throws on a refusal rather than reporting a firm with no clients', async () => {
    api.get('/clients', { status: 403, body: { error: 'Forbidden' } });

    // An empty list and a forbidden list look identical on the clients page.
    // One means the firm has no clients; the other means this member may not
    // see them, and only one of those is worth telling the user about.
    await expect(clientsService.listClients(LAW_FIRM_ID)).rejects.toBeInstanceOf(ApiError);
  });

  it('drops a client record with no usable id', async () => {
    api.get('/clients', {
      clients: [{ name: 'Nameless' }, { id: PERSON_ID, name: 'Ada Lovelace' }],
    });

    const clients = await clientsService.listClients(LAW_FIRM_ID);

    // An id-less row renders a row whose link goes to `/clients/` and whose
    // every action addresses the empty string.
    expect(clients.map((client) => client.id)).toEqual([PERSON_ID]);
  });

  it('accepts a client under an envelope or on its own', async () => {
    api.get(`/clients/${PERSON_ID}`, { client: { id: PERSON_ID, name: 'Ada', clientType: 'person' } });
    const wrapped = await clientsService.getClient(LAW_FIRM_ID, PERSON_ID);

    api.get(`/clients/${PERSON_ID}`, { id: PERSON_ID, name: 'Ada', clientType: 'person' });
    const bare = await clientsService.getClient(LAW_FIRM_ID, PERSON_ID);

    // Both shapes are in service across the client routes. Handling only one
    // leaves the detail page with an empty id, which it reads as "not found".
    expect(wrapped.id).toBe(PERSON_ID);
    expect(bare.id).toBe(PERSON_ID);
  });

  it('sends a multi-word client search the server can read back whole', async () => {
    api.get('/clients', { clients: [], totalItems: 0 });

    await clientsService.listClientsPaged(LAW_FIRM_ID, {
      search: 'Ada Lovelace', status: 'active', matterId: 'matter-9',
    });

    // Read through URLSearchParams, because the space is on the wire as `+`.
    const query = paramsOf(api.calls('GET')[0].url);
    expect(query.get('search')).toBe('Ada Lovelace');
    expect(query.get('status')).toBe('active');
    expect(query.get('matterId')).toBe('matter-9');
  });

  it('falls back to the returned count when the server sends no total', async () => {
    api.get('/clients', {
      clients: [{ id: 'c1', name: 'A' }, { id: 'c2', name: 'B' }],
    });

    const { totalItems } = await clientsService.listClientsPaged(LAW_FIRM_ID);

    // The pager divides by this. Undefined renders a NaN page count and the
    // "next" control never enables, stranding the user on page one.
    expect(totalItems).toBe(2);
  });
});

describe('client settings and billing rates', () => {
  it('keeps the defaults the server did not mention', async () => {
    api.get(`/clients/${PERSON_ID}/settings`, {
      settings: { notifications: { emailOnMatterUpdate: true } },
    });

    const settings = await clientsService.getClientSettings(LAW_FIRM_ID, PERSON_ID);

    // The server stores only what was changed. Replacing the defaults instead
    // of merging onto them leaves every unmentioned preference undefined, and
    // an undefined toggle renders off, so the settings page reports that this
    // client has invoice emails switched off when they never touched it.
    expect(settings.notifications.emailOnMatterUpdate).toBe(true);
    expect(settings.notifications.emailOnNewInvoice)
      .toBe(DEFAULT_CLIENT_SETTINGS.notifications.emailOnNewInvoice);
    expect(settings.communication).toEqual(DEFAULT_CLIENT_SETTINGS.communication);
    expect(settings.portal).toEqual(DEFAULT_CLIENT_SETTINGS.portal);
  });

  it('wraps a settings update under a settings key', async () => {
    api.put(`/clients/${PERSON_ID}/settings`, { message: 'ok' });

    await clientsService.updateClientSettings(LAW_FIRM_ID, PERSON_ID, {
      portal: { defaultView: 'invoices' },
    });

    // The route validates `body.settings`. Sending the object bare passes
    // schema validation on an empty object and saves nothing, with a 200.
    const body = bodyOf(api.calls('PUT')[0]);
    expect(body).toEqual({ settings: { portal: { defaultView: 'invoices' } } });
  });

  it('sends a cleared default rate as null rather than omitting it', async () => {
    api.put(`/clients/${PERSON_ID}/billing-rates`, { message: 'ok' });

    await clientsService.updateClientBillingRates(LAW_FIRM_ID, PERSON_ID, {
      defaultRate: null, memberRates: { 'user-1': 425 },
    });

    // null clears the client's negotiated rate and returns them to the firm
    // default; omitting the key leaves the old rate in place. The two look
    // identical in the form and bill differently forever after.
    const body = bodyOf(api.calls('PUT')[0]);
    expect('defaultRate' in body).toBe(true);
    expect(body.defaultRate).toBeNull();
    expect(body.memberRates).toEqual({ 'user-1': 425 });
  });
});

describe('client events', () => {
  it('states which side an event came from when deleting it', async () => {
    api.delete(`/clients/${PERSON_ID}/events/event-4`, { message: 'ok' });

    await clientsService.deleteClientEvent(LAW_FIRM_ID, PERSON_ID, 'event-4', 'matter', 'matter-9');

    // A client's event list shows both its own events and the events of the
    // matters it is on. Deleting a matter event needs the matter, and without
    // `source` the server cannot tell which table the id belongs to.
    const query = paramsOf(api.calls('DELETE')[0].url);
    expect(query.get('source')).toBe('matter');
    expect(query.get('matterId')).toBe('matter-9');
  });

  it('omits the matter when the event is the client own', async () => {
    api.delete(`/clients/${PERSON_ID}/events/event-4`, { message: 'ok' });

    await clientsService.deleteClientEvent(LAW_FIRM_ID, PERSON_ID, 'event-4', 'client');

    const query = paramsOf(api.calls('DELETE')[0].url);
    expect(query.get('source')).toBe('client');
    expect(query.get('matterId')).toBeNull();
  });

  it('sends the status window on the url, not only in the dedup key', async () => {
    api.get(`/clients/${PERSON_ID}/events`, { events: [], totalEvents: 0 });

    await clientsService.getEventsPage(LAW_FIRM_ID, PERSON_ID, {
      status: 'upcoming', page: 2, limit: 25,
    });

    // The deduplicator's key decides which in-flight requests coalesce; the
    // query string is what the server reads. Sending the window in one and not
    // the other is how every page of this list came back holding the same rows.
    const query = paramsOf(api.calls('GET')[0].url);
    expect(query.get('status')).toBe('upcoming');
    expect(query.get('page')).toBe('2');
    expect(query.get('limit')).toBe('25');
  });
});

describe('the typeahead lookup', () => {
  it('sends search and limit as query params', async () => {
    api.get('/clients/lookup', { items: [], hasMore: false });

    await clientsService.lookupClients(LAW_FIRM_ID, { search: 'ada', limit: 5 });

    const [call] = api.calls('GET');
    expect(call.pathname).toMatch(new RegExp(`/lawfirms/${LAW_FIRM_ID}/clients/lookup$`));
    expect(call.query.search).toEqual(['ada']);
    expect(call.query.limit).toEqual(['5']);
  });

  it('sends ids comma separated', async () => {
    api.get('/clients/lookup', { items: [], hasMore: false });

    await clientsService.lookupClients(LAW_FIRM_ID, { ids: ['c1', 'c2'] });

    expect(api.calls('GET')[0].query.ids).toEqual(['c1,c2']);
  });

  it('sends portalOnly only when asked for', async () => {
    api.get('/clients/lookup', { items: [], hasMore: false });

    await clientsService.lookupClients(LAW_FIRM_ID, { portalOnly: true });
    await clientsService.lookupClients(LAW_FIRM_ID, { search: 'ada' });

    const [asked, notAsked] = api.calls('GET');
    expect(asked.query.portalOnly).toEqual(['true']);
    expect(notAsked.query.portalOnly).toBeUndefined();
  });

  it('omits params that were not supplied', async () => {
    api.get('/clients/lookup', { items: [], hasMore: false });

    await clientsService.lookupClients(LAW_FIRM_ID);

    expect(api.calls('GET')[0].query).toEqual({});
  });

  it('sends the timezone header', async () => {
    api.get('/clients/lookup', { items: [], hasMore: false });

    await clientsService.lookupClients(LAW_FIRM_ID, { search: 'x' });

    expect(api.calls('GET')[0].headers['x-timezone']).toBeTruthy();
  });

  it('normalizes a malformed response instead of throwing', async () => {
    api.get('/clients/lookup', null);

    await expect(clientsService.lookupClients(LAW_FIRM_ID)).resolves.toEqual({
      items: [],
      hasMore: false,
    });
  });
});

/**
 * Exact-path cases for the rest of the client surface. `getExact`/`postExact`
 * match the WHOLE pathname and query, so a request that drifts to another firm,
 * another client, or grows a stray parameter matches nothing and the transport
 * throws.
 */
const CLIENTS = `/api/lawfirms/${LAW_FIRM_ID}/clients`;
const PERSON = `${CLIENTS}/${PERSON_ID}`;
const INVITATIONS = `/api/lawfirms/${LAW_FIRM_ID}/invitations`;

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

describe('portal clients and the client summary', () => {
  it('asks for portal clients only and normalizes each, dropping rows with no id', async () => {
    api.getExact(`${CLIENTS}?portalOnly=true`, {
      clients: [
        { id: 'c-1', name: '  Jane Roe  ', status: 'bogus', preferredContactMethod: 'fax' },
        { name: 'No id at all' },
      ],
    });

    const clients = await clientsService.listPortalClients(LAW_FIRM_ID);

    expect(clients).toHaveLength(1);
    // Trimmed name; an unknown status reads as active and an unknown contact
    // method as email, rather than passing an arbitrary string to the UI.
    expect(clients[0]).toMatchObject({ id: 'c-1', name: 'Jane Roe', status: 'active', preferredContactMethod: 'email', clientType: 'person' });
  });

  it('returns no portal clients when the key is not an array', async () => {
    api.getExact(`${CLIENTS}?portalOnly=true`, { clients: { id: 'c-1' } });

    await expect(clientsService.listPortalClients(LAW_FIRM_ID)).resolves.toEqual([]);
  });

  it('returns the summary body as is, money in cents', async () => {
    const summary = {
      matterCount: 2,
      billing: { invoiceCount: 3, totalBilledCents: 150001, totalPaidCents: 50000, outstandingCents: 100001 },
    };
    api.getExact(`${PERSON}/summary`, summary);

    await expect(clientsService.getClientSummary(LAW_FIRM_ID, PERSON_ID)).resolves.toEqual(summary);
  });
});

describe('creating, deleting and revoking a client', () => {
  it('POSTs a new client with exactly the payload and returns the body', async () => {
    api.postExact(CLIENTS, { status: 201, body: { message: 'Client created', clientId: 'c-new' } });

    const payload = { clientType: 'company', name: 'Acme Holdings', email: 'ap@acme.test' } as never;
    const result = await clientsService.createClient(LAW_FIRM_ID, payload);

    expect(onlyCall('POST').body).toEqual({ clientType: 'company', name: 'Acme Holdings', email: 'ap@acme.test' });
    expect(result).toEqual({ message: 'Client created', clientId: 'c-new' });
  });

  it('carries the request on a refused create', async () => {
    api.postExact(CLIENTS, { status: 409, body: { error: 'A client with this email already exists' } });

    const error = await rejectionOf(clientsService.createClient(LAW_FIRM_ID, { name: 'Dup' } as never));

    expect(error.message).toBe('A client with this email already exists');
    expect(error.requestMethod).toBe('POST');
    expect(error.requestUrl).toContain(CLIENTS);
  });

  it('DELETEs a client by id', async () => {
    api.deleteExact(PERSON, { message: 'Client removed' });

    await expect(clientsService.deleteClient(LAW_FIRM_ID, PERSON_ID)).resolves.toEqual({ message: 'Client removed' });
  });

  it('revokes portal access with a bodiless POST', async () => {
    api.postExact(`${PERSON}/revoke-portal-access`, { message: 'Portal access revoked' });

    await expect(clientsService.revokePortalAccess(LAW_FIRM_ID, PERSON_ID)).resolves.toEqual({ message: 'Portal access revoked' });
    expect(onlyCall('POST').body).toBeNull();
  });
});

describe('matters and tasks under a client', () => {
  it('links matters with exactly the id list', async () => {
    api.postExact(`${PERSON}/matters`, { message: 'Updated', added: ['m-1', 'm-2'] });

    await clientsService.addClientMatters(LAW_FIRM_ID, PERSON_ID, ['m-1', 'm-2']);

    expect(onlyCall('POST').body).toEqual({ matterIds: ['m-1', 'm-2'] });
  });

  it('unlinks one matter by id in the path', async () => {
    api.deleteExact(`${PERSON}/matters/m-1`, { message: 'Removed' });

    await expect(clientsService.removeClientMatter(LAW_FIRM_ID, PERSON_ID, 'm-1')).resolves.toEqual({ message: 'Removed' });
  });

  it('lists the client matters and tasks, empty when the key is not an array', async () => {
    api.getExact(`${PERSON}/matters`, { matters: [{ id: 'm-1' }] });
    api.getExact(`${PERSON}/tasks`, { tasks: 'nope' });

    await expect(clientsService.listClientMatters(LAW_FIRM_ID, PERSON_ID)).resolves.toEqual([{ id: 'm-1' }]);
    await expect(clientsService.listClientTasks(LAW_FIRM_ID, PERSON_ID)).resolves.toEqual([]);
  });
});

describe('client notes delegate to the shared notes routes under this client', () => {
  const NOTE = `${PERSON}/notes/note-1`;
  const rows: Array<[string, string, string, () => Promise<unknown>]> = [
    ['listClientNotes', 'GET', `${PERSON}/notes`, () => clientsService.listClientNotes(LAW_FIRM_ID, PERSON_ID)],
    ['getClientNote', 'GET', NOTE, () => clientsService.getClientNote(LAW_FIRM_ID, PERSON_ID, 'note-1')],
    ['addClientNote', 'POST', `${PERSON}/notes`, () => clientsService.addClientNote(LAW_FIRM_ID, PERSON_ID, { content: 'x' } as never)],
    ['updateClientNote', 'PUT', NOTE, () => clientsService.updateClientNote(LAW_FIRM_ID, PERSON_ID, 'note-1', { content: 'y' } as never)],
    ['retractClientNote', 'DELETE', NOTE, () => clientsService.retractClientNote(LAW_FIRM_ID, PERSON_ID, 'note-1', 'wrong client')],
    ['addClientNoteTimeEntry', 'POST', `${NOTE}/time`, () => clientsService.addClientNoteTimeEntry(LAW_FIRM_ID, PERSON_ID, 'note-1', { hours: 1 } as never)],
    ['updateClientNoteTimeEntry', 'PUT', `${NOTE}/time/te-1`, () => clientsService.updateClientNoteTimeEntry(LAW_FIRM_ID, PERSON_ID, 'note-1', 'te-1', { hours: 2 } as never)],
    ['removeClientNoteTimeEntry', 'DELETE', `${NOTE}/time/te-1`, () => clientsService.removeClientNoteTimeEntry(LAW_FIRM_ID, PERSON_ID, 'note-1', 'te-1')],
    ['setClientNotePinned', 'PUT', `${NOTE}/pin`, () => clientsService.setClientNotePinned(LAW_FIRM_ID, PERSON_ID, 'note-1', true)],
    ['listClientNoteVersions', 'GET', `${NOTE}/versions`, () => clientsService.listClientNoteVersions(LAW_FIRM_ID, PERSON_ID, 'note-1')],
    ['listClientNoteReplies', 'GET', `${NOTE}/replies`, () => clientsService.listClientNoteReplies(LAW_FIRM_ID, PERSON_ID, 'note-1')],
    ['addClientNoteReply', 'POST', `${NOTE}/replies`, () => clientsService.addClientNoteReply(LAW_FIRM_ID, PERSON_ID, 'note-1', { content: 'r' } as never)],
    ['updateClientNoteReply', 'PUT', `${NOTE}/replies/rep-1`, () => clientsService.updateClientNoteReply(LAW_FIRM_ID, PERSON_ID, 'note-1', 'rep-1', { content: 'r2' } as never)],
    ['retractClientNoteReply', 'DELETE', `${NOTE}/replies/rep-1`, () => clientsService.retractClientNoteReply(LAW_FIRM_ID, PERSON_ID, 'note-1', 'rep-1')],
  ];

  it.each(rows)('%s', async (_name, method, path, run) => {
    // Route only: the shared notes module owns response shaping and has its own
    // specs. This pins that the client wrapper reaches the right verb on the
    // right route under the right CLIENT, not a matter or task.
    const register = { GET: api.get, POST: api.post, PUT: api.put, DELETE: api.delete }[method]!;
    register(path, { status: 422, body: { error: 'stop here' } });

    await expect(run()).rejects.toThrow('stop here');

    expect(onlyCall(method).pathname).toBe(path);
  });
});

describe('a person company relationships', () => {
  it('drops rows missing an id or a company, and zero-fills the recipient count', async () => {
    api.getExact(`${PERSON}/company-relationships`, {
      relationships: [
        { id: 'rel-1', companyClientId: COMPANY_ID, companyEmailRecipientCount: '2' },
        { id: 'rel-2', companyClientId: 'company-2' },
        { id: 'rel-3' },
      ],
    });

    const relationships = await clientsService.listClientCompanyRelationships(LAW_FIRM_ID, PERSON_ID);

    expect(relationships).toEqual([
      { id: 'rel-1', companyClientId: COMPANY_ID, companyEmailRecipientCount: 2 },
      { id: 'rel-2', companyClientId: 'company-2', companyEmailRecipientCount: 0 },
    ]);
  });
});

describe('client invitations', () => {
  it('sends the invite email trimmed', async () => {
    api.postExact(`${INVITATIONS}/send-client-invite`, { message: 'Invitation sent' });

    await clientsService.inviteClientToLawFirm('  jane@roe.test  ', LAW_FIRM_ID);

    expect(onlyCall('POST').body).toEqual({ email: 'jane@roe.test' });
  });

  it('normalizes pending invites and defaults the resend count to zero', async () => {
    api.getExact(`${INVITATIONS}/pending-client-invites`, {
      invites: [
        { id: 'inv-1', email: 'jane@roe.test', invitedAt: '2026-03-01T00:00:00.000Z', invitationFailed: true, invitationResendCount: 2 },
        { id: 'inv-2', email: 'joe@roe.test' },
      ],
    });

    const invites = await clientsService.listPendingClientInvites(LAW_FIRM_ID);

    expect(invites).toEqual([
      {
        id: 'inv-1', email: 'jane@roe.test', invitedAt: '2026-03-01T00:00:00.000Z', invitationSentAt: undefined,
        invitationFailed: true, invitationResendCount: 2, status: 'pending',
      },
      {
        id: 'inv-2', email: 'joe@roe.test', invitedAt: undefined, invitationSentAt: undefined,
        invitationFailed: false, invitationResendCount: 0, status: 'pending',
      },
    ]);
  });

  it('revokes an invite by id in the path', async () => {
    api.postExact(`${INVITATIONS}/client-invites/inv-1/revoke`, { message: 'Cancelled', inviteId: 'inv-1' });

    await expect(clientsService.revokeClientInvitation(LAW_FIRM_ID, 'inv-1')).resolves.toEqual({ message: 'Cancelled', inviteId: 'inv-1' });
  });

  it('resends an invite for one client id in the body', async () => {
    api.postExact(`${INVITATIONS}/resend-client-invite`, { message: 'Resent', sent: true, resendCount: 1 });

    await clientsService.resendClientInvitation(LAW_FIRM_ID, PERSON_ID);

    expect(onlyCall('POST').body).toEqual({ clientId: PERSON_ID });
  });

  it('associates an existing account directly, email trimmed', async () => {
    api.postExact(`${INVITATIONS}/associate-client-direct`, { message: 'Associated' });

    await clientsService.associateClientDirect(' jane@roe.test ', LAW_FIRM_ID);

    expect(onlyCall('POST').body).toEqual({ email: 'jane@roe.test' });
  });
});

describe('client events', () => {
  it('bounds the firm-wide calendar read to the window', async () => {
    api.getExact(`${CLIENTS}/events?from=2026-03-01&to=2026-03-31`, { events: [{ id: 'ev-1' }], totalEvents: 1 });

    await expect(clientsService.listAllClientEvents(LAW_FIRM_ID, { from: '2026-03-01', to: '2026-03-31' }))
      .resolves.toEqual({ events: [{ id: 'ev-1' }], totalEvents: 1 });
  });

  it('reads every firm event with no window, empty for a bare envelope', async () => {
    api.getExact(`${CLIENTS}/events`, {});

    await expect(clientsService.listAllClientEvents(LAW_FIRM_ID)).resolves.toEqual({ events: [], totalEvents: 0 });
  });

  it('reads one client events', async () => {
    api.getExact(`${PERSON}/events`, { events: [{ id: 'ev-1' }], totalEvents: 4 });

    await expect(clientsService.listClientEvents(LAW_FIRM_ID, PERSON_ID)).resolves.toEqual({ events: [{ id: 'ev-1' }], totalEvents: 4 });
  });

  it('creates and updates an event with exactly the payload', async () => {
    api.postExact(`${PERSON}/events`, { message: 'Created', eventId: 'ev-2', event: { id: 'ev-2' } });
    api.putExact(`${PERSON}/events/ev-2`, { message: 'Updated', event: { id: 'ev-2' } });

    await clientsService.createClientEvent(LAW_FIRM_ID, PERSON_ID, { title: 'Intake call', startDate: '2026-04-01' } as never);
    await clientsService.updateClientEvent(LAW_FIRM_ID, PERSON_ID, 'ev-2', { title: 'Intake call (moved)' } as never);

    expect(onlyCall('POST').body).toEqual({ title: 'Intake call', startDate: '2026-04-01' });
    expect(onlyCall('PUT').body).toEqual({ title: 'Intake call (moved)' });
  });

  it('deletes a client event with its source, and a matter event with its matter', async () => {
    api.deleteExact(`${PERSON}/events/ev-1?source=client`, { message: 'Deleted' });
    api.deleteExact(`${PERSON}/events/ev-2?source=matter&matterId=m-1`, { message: 'Deleted' });

    await clientsService.deleteClientEvent(LAW_FIRM_ID, PERSON_ID, 'ev-1', 'client');
    await clientsService.deleteClientEvent(LAW_FIRM_ID, PERSON_ID, 'ev-2', 'matter', 'm-1');

    expect(api.calls('DELETE')).toHaveLength(2);
  });
});

describe('client billing rates', () => {
  it('returns the rates body as is', async () => {
    const rates = { billingRates: { defaultRate: 275.5, memberRates: { 'u-1': 300 } } };
    api.getExact(`${PERSON}/billing-rates`, rates);

    await expect(clientsService.getClientBillingRates(LAW_FIRM_ID, PERSON_ID)).resolves.toEqual(rates);
  });

  it('PUTs the rates exactly as given, a cleared default as null', async () => {
    api.putExact(`${PERSON}/billing-rates`, { message: 'Updated' });

    await clientsService.updateClientBillingRates(LAW_FIRM_ID, PERSON_ID, { defaultRate: null, memberRates: { 'u-1': 199.99 } });

    expect(onlyCall('PUT').body).toEqual({ defaultRate: null, memberRates: { 'u-1': 199.99 } });
  });
});

describe('a mutation refused with no server reason throws the method\'s own message', () => {
  const rows: Array<[string, 'post' | 'put' | 'delete', string, () => Promise<unknown>, string]> = [
    ['createClient', 'post', CLIENTS, () => clientsService.createClient(LAW_FIRM_ID, {} as never), 'Failed to create client'],
    ['deleteClient', 'delete', PERSON, () => clientsService.deleteClient(LAW_FIRM_ID, PERSON_ID), 'Failed to remove client'],
    ['revokePortalAccess', 'post', `${PERSON}/revoke-portal-access`, () => clientsService.revokePortalAccess(LAW_FIRM_ID, PERSON_ID), 'Failed to revoke portal access'],
    ['addClientMatters', 'post', `${PERSON}/matters`, () => clientsService.addClientMatters(LAW_FIRM_ID, PERSON_ID, []), 'Failed to update client matter associations'],
    ['removeClientMatter', 'delete', `${PERSON}/matters/m-1`, () => clientsService.removeClientMatter(LAW_FIRM_ID, PERSON_ID, 'm-1'), 'Failed to remove matter association'],
    ['inviteClientToLawFirm', 'post', `${INVITATIONS}/send-client-invite`, () => clientsService.inviteClientToLawFirm('a@b.test', LAW_FIRM_ID), 'Failed to invite client'],
    ['revokeClientInvitation', 'post', `${INVITATIONS}/client-invites/inv-1/revoke`, () => clientsService.revokeClientInvitation(LAW_FIRM_ID, 'inv-1'), 'Failed to cancel client invitation'],
    ['resendClientInvitation', 'post', `${INVITATIONS}/resend-client-invite`, () => clientsService.resendClientInvitation(LAW_FIRM_ID, PERSON_ID), 'Failed to resend invitation'],
    ['createClientEvent', 'post', `${PERSON}/events`, () => clientsService.createClientEvent(LAW_FIRM_ID, PERSON_ID, {} as never), 'Failed to create event'],
    ['updateClientEvent', 'put', `${PERSON}/events/ev-1`, () => clientsService.updateClientEvent(LAW_FIRM_ID, PERSON_ID, 'ev-1', {} as never), 'Failed to update event'],
    ['deleteClientEvent', 'delete', `${PERSON}/events/ev-1?source=client`, () => clientsService.deleteClientEvent(LAW_FIRM_ID, PERSON_ID, 'ev-1', 'client'), 'Failed to delete event'],
    ['associateClientDirect', 'post', `${INVITATIONS}/associate-client-direct`, () => clientsService.associateClientDirect('a@b.test', LAW_FIRM_ID), 'Failed to associate client'],
    ['updateClientBillingRates', 'put', `${PERSON}/billing-rates`, () => clientsService.updateClientBillingRates(LAW_FIRM_ID, PERSON_ID, {}), 'Failed to update client billing rates'],
  ];

  it.each(rows)('%s', async (_name, method, path, run, message) => {
    ({ post: api.postExact, put: api.putExact, delete: api.deleteExact })[method](path, { status: 422, body: {} });

    const error = await rejectionOf(run());

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe(message);
    expect(error.status).toBe(422);
  });
});
