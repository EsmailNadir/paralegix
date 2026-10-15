/**
 * A name made only of whitespace must be refused, not stored as the empty
 * string.
 *
 * THE SHAPE OF THE BUG. A Zod field written as
 *
 *     name: z.string().min(1, 'Name is required')
 *
 * accepts `'   '`, because `min(1)` counts characters and a space is a
 * character. The service that receives it then calls `.trim()` before writing,
 * so the value that lands in the column is `''`. The request answers 200 and
 * the row is nameless.
 *
 * That combination is only a bug where BOTH halves are present AND nothing else
 * catches it, which is why this file drives the real routes rather than
 * unit-testing the schemas. Auditing the schema alone gets it wrong in both
 * directions: `tasks.validation.ts` still declares a bare `min(1)` and looks
 * broken, but `tasks.service.ts` refuses a blank title itself, so the route is
 * fine. `users.validation.ts` had no such backstop and genuinely stored the
 * empty string until the `.trim()` this file's first case pins was added.
 *
 * WHY IT MATTERS MORE THAN IT LOOKS. These columns are read far from where they
 * are written. `users.name` is the byline on every note, the sender label on
 * every client-facing message and the entry in every firm roster the person
 * belongs to. A task's title is the whole of its row in the task list. In each
 * case the failure renders as a blank where a name should be, on a screen with
 * nothing to explain it and no obvious way to correct it.
 *
 * `matters.name` and `clients.name` already declare `.trim().min(1)` and are
 * included as the positive control: they prove these cases are exercising the
 * real refusal and not a route that rejects every request.
 */
import {
  createFirm,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;

/** Whitespace a user can actually produce: spaces, a tab, a newline. */
const BLANK = '  \t \n ';

beforeEach(async () => {
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
});

describe('a whitespace-only name is refused at the edge', () => {
  it('will not rename a user to nothing', async () => {
    await owner.api.put('/api/users/update-name').send({ name: 'Alice Attorney' });

    const res = await owner.api.put('/api/users/update-name').send({ name: BLANK });

    expect(res.status).toBe(400);
    const { rows } = await testPool.query('select name from users where id = $1', [owner.uid]);
    expect(rows[0].name).toBe('Alice Attorney');
  });

  it('will not create a task with no title', async () => {
    const res = await owner.api.post(`/api/lawfirms/${firm.id}/tasks`).send({ title: BLANK });

    // Refused by the SERVICE here, not the schema, which still declares a bare
    // `min(1)`. The error body is asserted so this cannot pass on a 400 raised
    // by some unrelated missing field, which is the trap a bare status check
    // walks into. If someone tidies that service check away on the strength of
    // the schema looking sufficient, this goes red.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.details ?? res.body)).toMatch(/title/i);
    // The row count, not just the status: a 400 raised after the insert would
    // still leave a blank row in the task list.
    const { rows } = await testPool.query(
      'select count(*)::int n from tasks where law_firm_id = $1', [firm.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('will not create a matter with no name (positive control)', async () => {
    const res = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({ name: BLANK });

    // `matters.validation.ts` already declares `.trim().min(1)`. If this ever
    // starts passing, the fix has been undone there rather than the cases above
    // being wrong.
    expect(res.status).toBe(400);
  });

  it('will not create a client with no name (positive control)', async () => {
    const res = await owner.api.post(`/api/lawfirms/${firm.id}/clients`)
      .send({ name: BLANK, clientType: 'person' });

    expect(res.status).toBe(400);
  });
});

describe('a real name is still accepted', () => {
  it('creates a task whose title merely has surrounding whitespace', async () => {
    const res = await owner.api.post(`/api/lawfirms/${firm.id}/tasks`)
      .send({ title: '  File the reply brief  ' });

    // The other side of the rule, and the reason it is `.trim().min(1)` rather
    // than a rejection of any string containing whitespace: padding is normal
    // from a copy-paste and must be cleaned, not refused.
    expect(res.status).toBe(201);
    const { rows } = await testPool.query(
      'select title from tasks where law_firm_id = $1', [firm.id],
    );
    expect(rows[0].title).toBe('File the reply brief');
  });

  it('renames a user whose name merely has surrounding whitespace', async () => {
    const res = await owner.api.put('/api/users/update-name').send({ name: '  Alice Attorney  ' });

    expect(res.status).toBe(200);
    const { rows } = await testPool.query('select name from users where id = $1', [owner.uid]);
    expect(rows[0].name).toBe('Alice Attorney');
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so its
// top-level bindings stay file-scoped rather than colliding across specs.
export {};
