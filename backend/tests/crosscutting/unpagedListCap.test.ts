/**
 * A list request that names no `limit` still gets a bounded page.
 *
 * The contact and client directory reads used to return EVERY matching row
 * when `limit` was omitted. The database side of that is cheap; the process
 * side is not: every row becomes a JS object and then part of one JSON string,
 * so a large firm's directory, or anyone calling the API without a page size,
 * could put tens of megabytes on one request in a 512 MiB container. The
 * frontend always sends `limit` for these two endpoints (its list windows
 * default to 50 and clamp to 500), so no screen relies on the unbounded form.
 *
 * An omitted `limit` now means the largest page the endpoint accepts, and the
 * response carries `totalItems` so a caller can tell the page is not the whole
 * set and ask for the next one.
 *
 * The contacts EXPORT reads the same repository function with no limit on
 * purpose, because a file download of the directory must be the whole
 * directory. It is pinned here so the cap is never pushed down into the
 * repository, where it would silently truncate the export instead.
 */
import {
  testPool,
  createFirm,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;

/** One past the largest page, so a cap shows up as exactly one missing row. */
const ROWS = 501;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

async function seedContacts(count: number) {
  await testPool.query(
    `insert into contacts (law_firm_id, name)
     select $1, 'Contact ' || lpad(n::text, 4, '0') from generate_series(1, $2) as n`,
    [firm.id, count],
  );
}

async function seedClients(count: number) {
  await testPool.query(
    `insert into clients (law_firm_id, name, client_type)
     select $1, 'Client ' || lpad(n::text, 4, '0'), 'person' from generate_series(1, $2) as n`,
    [firm.id, count],
  );
}

describe('GET /contacts without a limit', () => {
  it('returns at most 500 contacts and reports the full count', async () => {
    await seedContacts(ROWS);

    const res = await owner.api.get(`/api/lawfirms/${firm.id}/contacts`);

    expect(res.status).toBe(200);
    expect(res.body.contacts).toHaveLength(500);
    expect(res.body.totalItems).toBe(ROWS);
  });

  it('still honours an explicit limit and page', async () => {
    await seedContacts(ROWS);

    const res = await owner.api.get(`/api/lawfirms/${firm.id}/contacts?limit=500&page=2`);

    expect(res.status).toBe(200);
    expect(res.body.contacts).toHaveLength(1);
    expect(res.body.totalItems).toBe(ROWS);
  });

  it('does NOT cap the CSV export, which must hold the whole directory', async () => {
    await seedContacts(ROWS);

    const res = await owner.api.get(`/api/lawfirms/${firm.id}/contacts/export?format=csv`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('Contact 0001');
    expect(res.text).toContain(`Contact 0${ROWS}`);
  });
});

describe('GET /clients without a limit', () => {
  it('returns at most 500 clients and reports the full count', async () => {
    await seedClients(ROWS);

    const res = await owner.api.get(`/api/lawfirms/${firm.id}/clients`);

    expect(res.status).toBe(200);
    expect(res.body.clients).toHaveLength(500);
    expect(res.body.totalItems).toBe(ROWS);
  });
});
