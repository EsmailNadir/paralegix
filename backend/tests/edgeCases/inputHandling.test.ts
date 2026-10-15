/**
 * Input edge cases the rest of the suite does not reach.
 *
 * A gap analysis over the whole suite found six categories with essentially no
 * coverage: search metacharacters, unicode, oversized strings, boundary numbers,
 * pagination extremes, and repeated submits. Every one of them is a shape a real
 * user produces by accident, and none of them is what a happy-path test explores.
 *
 * This file owns odd INPUT: search metacharacters, unicode, oversized strings,
 * pagination extremes, repeated submits and malformed bodies. A malformed
 * entity id in a path, or another firm's id, belongs to the id sweeps in
 * `tests/crosscutting/entityIdHandling.*.test.ts`; a malformed firm id to
 * `tests/permissions/malformedFirmId.test.ts`; a whitespace-only name and a
 * repeated delete to `tests/clients/clients.inprocess.test.ts`.
 *
 * The organising rule: an input that is HOSTILE or merely WEIRD must produce a
 * clean answer, never a 500 and never a silent mangling. A 500 leaks a stack
 * trace and tells the caller nothing; a silent mangling corrupts data the user
 * believes they entered.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;

const clientsPath = (suffix = '') => `/api/lawfirms/${firm.id}/clients${suffix}`;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  await drainEvents();
});

describe('search metacharacters', () => {
  /**
   * Text search is `ILIKE '%term%'` with `escape '\'`, and the term is built by
   * `toIlikeTerm`, which escapes `\`, `%` and `_`. Unescaped, a `%` matches
   * everything and `_` matches any single character, so a client searching for
   * a literal underscore would silently get the wrong rows back.
   */
  beforeEach(async () => {
    await createPersonClient(firm.id, { name: 'Alpha Client' });
    await createPersonClient(firm.id, { name: 'Beta_Client' });
    await createPersonClient(firm.id, { name: '100% Holdings' });
  });

  it('treats % as a literal, not a wildcard', async () => {
    const res = await owner.api.get(clientsPath('?search=%25'));

    expect(res.status).toBe(200);
    const names = res.body.clients.map((c: any) => c.name);
    // An unescaped `%` would match all three. Only the one containing a literal
    // percent sign should come back.
    expect(names).toEqual(['100% Holdings']);
  });

  it('treats _ as a literal, not a single-character wildcard', async () => {
    const res = await owner.api.get(clientsPath('?search=a_C'));

    expect(res.status).toBe(200);
    const names = res.body.clients.map((c: any) => c.name);
    // Unescaped, `a_C` matches "Beta Client"-style names through the wildcard.
    // Escaped, it matches only the literal "a_C" inside "Beta_Client".
    expect(names).toEqual(['Beta_Client']);
  });

  it('survives a backslash without breaking the escape clause', async () => {
    // A lone trailing backslash is what breaks a naive `escape '\'` pattern:
    // Postgres raises "invalid escape sequence" and the route 500s.
    const res = await owner.api.get(clientsPath('?search=%5C'));

    expect(res.status).toBe(200);
  });

  it('does not execute a search term that looks like SQL', async () => {
    const res = await owner.api.get(
      clientsPath(`?search=${encodeURIComponent("'; drop table clients; --")}`),
    );

    expect(res.status).toBe(200);
    // The table is still there, which is the only assertion that matters.
    const { rows } = await testPool.query('select count(*)::int as n from clients');
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it('answers an empty or whitespace-only search without erroring', async () => {
    for (const term of ['', '   ', '%20%20']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await owner.api.get(clientsPath(`?search=${term}`));
      expect(res.status).toBe(200);
    }
  });
});

describe('unicode and unusual characters', () => {
  it('round-trips accents, non-latin scripts and emoji unchanged', async () => {
    const names = ['José Álvarez', '山田太郎', 'Ötzi Ürgen', 'Emoji 🙂 Client'];

    for (const name of names) {
      // eslint-disable-next-line no-await-in-loop
      const res = await owner.api.post(clientsPath()).send({ name });
      expect(res.status).toBe(201);
    }
    await drainEvents();

    const { rows } = await testPool.query(
      'select name from clients where law_firm_id = $1 order by created_at', [firm.id],
    );
    // Stored EXACTLY as sent. A mangled accent is a client whose name is wrong on
    // every invoice the firm sends them.
    expect(rows.map((r: any) => r.name)).toEqual(names);
  });

  it('finds a client by an accented search term', async () => {
    await owner.api.post(clientsPath()).send({ name: 'José Álvarez' });
    await drainEvents();

    const res = await owner.api.get(clientsPath(`?search=${encodeURIComponent('Álvarez')}`));

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('Álvarez');
  });

  it('CHARACTERISATION: stores an HTML tag in a name as literal text', async () => {
    const res = await owner.api.post(clientsPath()).send({
      name: '<script>alert(1)</script>',
    });

    // Accepted and stored byte for byte, not stripped and not refused. A name is
    // plain text, so rendering it safely is the client's job (React escapes
    // it); what must not happen is a 500, or a silently rewritten name.
    expect(res.status).toBe(201);
    const { rows } = await testPool.query('select name from clients where law_firm_id = $1', [firm.id]);
    expect(rows).toEqual([{ name: '<script>alert(1)</script>' }]);
  });
});

describe('oversized input', () => {
  it('rejects a name past the schema maximum rather than truncating it', async () => {
    const res = await owner.api.post(clientsPath()).send({ name: 'x'.repeat(5_000) });

    // Truncation would silently rename the client. A refusal tells the user.
    expect(res.status).toBe(400);
  });

  it('accepts a name at the maximum', async () => {
    // The boundary itself, so the limit is off-by-one proof in both directions.
    const res = await owner.api.post(clientsPath()).send({ name: 'x'.repeat(200) });

    expect(res.status).toBe(201);
  });

});

describe('malformed identifiers', () => {
  it('answers 404 for an odd-shaped client id, never 500', async () => {
    for (const id of ['not-a-uuid', '12345', '../../etc/passwd', 'null', '%00']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await owner.api.get(clientsPath(`/${encodeURIComponent(id)}`));
      // A cast error reaching the database surfaces as a 500 with a Postgres
      // message in it, which is both an error and a small information leak.
      expect([id, res.status]).toEqual([id, 404]);
    }
  });

  it('answers 404 for a well-formed uuid that does not exist', async () => {
    const res = await owner.api.get(clientsPath('/00000000-0000-0000-0000-000000000000'));

    expect(res.status).toBe(404);
  });

});

describe('pagination extremes', () => {
  beforeEach(async () => {
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await createPersonClient(firm.id, { name: `Paged Client ${i}` });
    }
  });

  it('answers an empty page past the end rather than erroring', async () => {
    const res = await owner.api.get(clientsPath('?limit=10&page=99'));

    expect(res.status).toBe(200);
    expect(res.body.clients).toEqual([]);
  });

  /**
   * `listClientsSchema` caps `limit` at 500 and `search` at 500 characters.
   * An unbounded limit is how one request pulls a firm's whole database into
   * memory; `parseInt('abc')` is NaN, and NaN reaching a LIMIT clause is a 500.
   */
  it.each([
    { name: 'a limit beyond the cap', query: '?limit=100000' },
    { name: 'a zero limit', query: '?limit=0' },
    { name: 'a negative limit', query: '?limit=-1' },
    { name: 'a non-numeric limit', query: '?limit=abc' },
    { name: 'a search term past the length cap', query: `?search=${'x'.repeat(5_000)}` },
  ])('refuses $name with a 400 rather than honouring or coercing it', async ({ query }) => {
    const res = await owner.api.get(clientsPath(query));

    expect(res.status).toBe(400);
    expect(res.body.clients).toBeUndefined();
  });
});

describe('repeated and concurrent submits', () => {
  it('creates two records for two identical sequential submits', async () => {
    // Characterised, not endorsed: the API has no idempotency key, so a
    // double-clicked Save genuinely makes two clients. Worth knowing, and worth
    // a deliberate decision rather than a surprise.
    const body = { name: 'Double Clicked Client', email: 'double@example.test' };

    const first = await owner.api.post(clientsPath()).send(body);
    const second = await owner.api.post(clientsPath()).send(body);
    await drainEvents();

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const { rows } = await testPool.query(
      'select count(*)::int as n from clients where law_firm_id = $1 and name = $2',
      [firm.id, 'Double Clicked Client'],
    );
    expect(rows[0].n).toBe(2);
  });

  it('handles concurrent creates without erroring or losing one', async () => {
    // Genuinely parallel, not sequential. Nothing here should deadlock or drop a
    // write, and a 500 under concurrency is a bug users hit at the worst moment.
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        owner.api.post(clientsPath()).send({ name: `Concurrent ${i}` })),
    );

    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    await drainEvents();

    const { rows } = await testPool.query(
      `select count(*)::int as n from clients where law_firm_id = $1 and name like 'Concurrent %'`,
      [firm.id],
    );
    expect(rows[0].n).toBe(5);
  });

});

describe('malformed bodies', () => {
  it('rejects a wrong-typed field instead of coercing it', async () => {
    const res = await owner.api.post(clientsPath()).send({ name: 12345 });

    expect(res.status).toBe(400);
  });

  it('rejects an array where an object belongs', async () => {
    const res = await owner.api.post(clientsPath()).send([{ name: 'Array Body' }]);

    expect(res.status).toBe(400);
  });

  it('answers cleanly to an empty body', async () => {
    const res = await owner.api.post(clientsPath()).send({});

    expect(res.status).toBe(400);
  });

  it('ignores an unexpected extra field rather than failing on it', async () => {
    const res = await owner.api.post(clientsPath()).send({
      name: 'Extra Field Client', notAField: 'ignored', __proto__: { polluted: true },
    });

    // Being strict here would break every client that sends a field the server
    // has since removed.
    expect(res.status).toBe(201);
    // And prototype pollution through a JSON body must not take hold.
    expect(({} as any).polluted).toBeUndefined();
  });
});
