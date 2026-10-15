/**
 * Firm-custom note types: the vocabulary the note composer's type dropdown adds
 * on top of the eight built-ins, and the per-firm colour override that shares
 * the same table.
 *
 * `note_types` is unique on (law_firm_id, value), and `value` is a SLUG derived
 * from a label the user types. Everything interesting in this module is the
 * consequence of that pair. A label that collides with a built-in, with an
 * existing custom type, or with another label that happens to slugify the same
 * way all have to resolve to something, and the wrong answer is either a 500 on
 * the unique index or a second dropdown entry indistinguishable from the first.
 *
 * The colour route is keyed on the slug rather than on an id, which means it is
 * also the one route in the module that can be pointed at a value belonging to
 * another firm, so the tenant scope is asserted on it directly.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let otherFirm: Firm;
let otherOwner: Actor;

const N = (lawFirmId: string, suffix = '') => `/api/lawfirms/${lawFirmId}/note-types${suffix}`;

async function seedNoteType(
  lawFirmId: string,
  options: { value?: string; label?: string; color?: string | null } = {},
) {
  const id = randomUUID();
  const value = options.value ?? `type-${id.slice(0, 8)}`;
  await testPool.query(
    'insert into note_types (id, law_firm_id, value, label, color) values ($1, $2, $3, $4, $5)',
    [id, lawFirmId, value, options.label ?? value, options.color ?? null],
  );
  return { id, value };
}

const typeRows = async (lawFirmId: string) => {
  const { rows } = await testPool.query(
    'select value, label, color from note_types where law_firm_id = $1 order by value',
    [lawFirmId],
  );
  return rows;
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  otherFirm = await createFirm();
  otherOwner = await ownerOf(otherFirm.id);
});

describe('creating a note type', () => {
  it('derives a slug from the label and writes it into the caller firm only', async () => {
    const res = await owner.api.post(N(firm.id)).send({ label: 'Client Call' });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Note type created successfully');
    expect(res.body.noteType).toMatchObject({ value: 'client-call', label: 'Client Call' });
    expect(await typeRows(firm.id)).toEqual([
      expect.objectContaining({ value: 'client-call', label: 'Client Call', color: null }),
    ]);
    expect(await typeRows(otherFirm.id)).toEqual([]);
  });

  it('trims the label before storing and slugifying it', async () => {
    const res = await owner.api.post(N(firm.id)).send({ label: '  Client Call  ' });

    expect(res.body.noteType).toMatchObject({ value: 'client-call', label: 'Client Call' });
  });

  it('reuses a built-in instead of creating a shadow copy of it', async () => {
    const res = await owner.api.post(N(firm.id)).send({ label: 'phone call' });

    // The built-ins are a static frontend list with no rows of their own. A row
    // slugging to 'phone-call' would appear in the dropdown BESIDE the built-in
    // with the same label, and the two would be indistinguishable to the user.
    // Matched case-insensitively, so 'phone call' is the same answer.
    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Note type already exists');
    expect(res.body.noteType).toEqual({ value: 'phone-call', label: 'Phone Call' });
    expect(await typeRows(firm.id)).toEqual([]);
  });

  it('reuses an existing custom type rather than adding a second one', async () => {
    const first = await owner.api.post(N(firm.id)).send({ label: 'Client Call' });

    const res = await owner.api.post(N(firm.id)).send({ label: 'CLIENT CALL' });

    // Without the case-insensitive label check this slugifies to 'client-call',
    // finds it taken, and creates 'client-call-2' with the same visible label:
    // two dropdown entries reading "Client Call" that store different values,
    // so filtering notes by type silently splits the firm's history in two.
    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Note type already exists');
    expect(res.body.noteType.value).toBe(first.body.noteType.value);
    expect(await typeRows(firm.id)).toHaveLength(1);
  });

  it('picks the next free slug when two different labels slugify the same way', async () => {
    await owner.api.post(N(firm.id)).send({ label: 'Client Call' });

    const res = await owner.api.post(N(firm.id)).send({ label: 'Client-Call!' });

    // Genuinely different labels, one slug. `note_types` is unique on
    // (law_firm_id, value), so reusing the slug is a constraint violation and a
    // 500 on an ordinary user action. Both types must survive with distinct
    // values.
    expect(res.status).toBe(201);
    expect(res.body.noteType.value).toBe('client-call-2');
    expect((await typeRows(firm.id)).map((row: any) => row.value))
      .toEqual(['client-call', 'client-call-2']);
  });

  it('avoids colliding with a built-in slug', async () => {
    // The label differs from the built-in's ("Court Appearance"), so the
    // reuse branch does not fire, but the slug lands on the built-in 'court'.
    const res = await owner.api.post(N(firm.id)).send({ label: 'Court' });

    expect(res.body.noteType.value).toBe('court-2');
    expect(res.body.noteType.label).toBe('Court');
  });

  it('falls back to a usable slug for a label with no alphanumerics', async () => {
    const res = await owner.api.post(N(firm.id)).send({ label: '***' });

    // Slugifying '***' yields the empty string, which cannot be a primary key
    // component or a stored note_type. The fallback keeps it addressable by the
    // colour route rather than writing a row nothing can reference.
    expect(res.status).toBe(201);
    expect(res.body.noteType.value).toBe('note-type');
  });

  it('refuses an empty label and writes nothing', async () => {
    const res = await owner.api.post(N(firm.id)).send({ label: '' });

    expect(res.status).toBe(400);
    expect(await typeRows(firm.id)).toEqual([]);
  });

  it('refuses a label past the length ceiling', async () => {
    const res = await owner.api.post(N(firm.id)).send({ label: 'x'.repeat(51) });

    expect(res.status).toBe(400);
    expect(await typeRows(firm.id)).toEqual([]);
  });

  it('lets two firms each hold the same slug', async () => {
    await owner.api.post(N(firm.id)).send({ label: 'Client Call' });

    const res = await otherOwner.api.post(N(otherFirm.id)).send({ label: 'Client Call' });

    // Uniqueness is (law_firm_id, value). A global one would let the first firm
    // to name a type reserve that slug for every other firm on the platform.
    expect(res.status).toBe(201);
    expect(res.body.noteType.value).toBe('client-call');
    expect(await typeRows(otherFirm.id)).toHaveLength(1);
  });

  it('refuses a member with an empty role and writes nothing', async () => {
    const narrow = await memberWith(firm.id, []);

    const res = await narrow.api.post(N(firm.id)).send({ label: 'Client Call' });

    expect(res.status).toBe(403);
    expect(await typeRows(firm.id)).toEqual([]);
  });

  it('refuses a member of another firm creating under this firm', async () => {
    const res = await otherOwner.api.post(N(firm.id)).send({ label: 'Client Call' });

    expect(res.status).toBe(403);
    expect(await typeRows(firm.id)).toEqual([]);
  });
});

describe('listing note types', () => {
  it('lists the firm custom types ordered by label', async () => {
    await seedNoteType(firm.id, { value: 'zebra', label: 'Zebra Note' });
    await seedNoteType(firm.id, { value: 'apple', label: 'Apple Note' });

    const res = await owner.api.get(N(firm.id));

    expect(res.status).toBe(200);
    expect(res.body.noteTypes.map((row: any) => row.label)).toEqual(['Apple Note', 'Zebra Note']);
  });

  it('does NOT list another firm note types', async () => {
    await seedNoteType(otherFirm.id, { value: 'secret', label: 'Confidential Type' });
    await seedNoteType(firm.id, { value: 'ours', label: 'Our Own Type' });

    const res = await owner.api.get(N(firm.id));

    expect(res.body.noteTypes.map((row: any) => row.label)).toEqual(['Our Own Type']);
  });

  it('CHARACTERISATION: a member with an empty role can still read the list', async () => {
    await seedNoteType(firm.id, { value: 'ours', label: 'Our Own Type' });
    const narrow = await memberWith(firm.id, []);

    const res = await narrow.api.get(N(firm.id));

    // `noteTypes.view` is in DEFAULT_PERMISSIONS: the type dropdown is on the
    // note composer every member uses, so withholding it produces a broken
    // composer rather than confidentiality.
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('Our Own Type');
  });

  it('refuses a member of another firm asking under this firm', async () => {
    await seedNoteType(firm.id, { value: 'ours', label: 'Confidential Type' });

    const res = await otherOwner.api.get(N(firm.id));

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('Confidential Type');
  });
});

describe('setting a note type colour', () => {
  it('recolours a custom type in place', async () => {
    await seedNoteType(firm.id, { value: 'client-call', label: 'Client Call', color: null });

    const res = await owner.api.patch(N(firm.id, '/client-call/color')).send({ color: 'purple' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Note type color updated successfully');
    expect(await typeRows(firm.id)).toEqual([
      expect.objectContaining({ value: 'client-call', label: 'Client Call', color: 'purple' }),
    ]);
  });

  it('keeps the custom label when recolouring, rather than overwriting it', async () => {
    await seedNoteType(firm.id, { value: 'client-call', label: 'Client Call' });

    await owner.api.patch(N(firm.id, '/client-call/color')).send({ color: 'teal' });

    // The upsert writes value, label and colour together, so the label it
    // supplies has to be the one already on the row. Take it from the request
    // or from a built-in map instead and recolouring silently renames the type.
    expect((await typeRows(firm.id))[0].label).toBe('Client Call');
  });

  it('creates the override row the first time a built-in is recoloured', async () => {
    const res = await owner.api.patch(N(firm.id, '/meeting/color')).send({ color: 'info' });

    // A built-in has no row of its own, so the colour has nowhere to live until
    // one is created. The label comes from the server's built-in map rather than
    // from anything the client sent.
    expect(res.status).toBe(200);
    expect(await typeRows(firm.id)).toEqual([
      expect.objectContaining({ value: 'meeting', label: 'Meeting', color: 'info' }),
    ]);
  });

  it('recolours a built-in twice without creating a second row', async () => {
    await owner.api.patch(N(firm.id, '/meeting/color')).send({ color: 'info' });

    const res = await owner.api.patch(N(firm.id, '/meeting/color')).send({ color: 'danger' });

    // The write is an upsert on (law_firm_id, value). A plain insert violates
    // that unique index on the second recolour and answers 500 from the colour
    // picker.
    expect(res.status).toBe(200);
    expect(await typeRows(firm.id)).toEqual([
      expect.objectContaining({ value: 'meeting', color: 'danger' }),
    ]);
  });

  it('answers not-found for a value the firm does not have', async () => {
    const res = await owner.api.patch(N(firm.id, '/never-created/color')).send({ color: 'info' });

    expect(res.status).toBe(404);
    expect(await typeRows(firm.id)).toEqual([]);
  });

  it('answers not-found when the slug case does not match', async () => {
    await seedNoteType(firm.id, { value: 'client-call', label: 'Client Call' });

    const res = await owner.api.patch(N(firm.id, '/Client-Call/color')).send({ color: 'info' });

    // The stored value is the slug, matched exactly. Nothing lower-cases the
    // path segment, so the display label is not a usable key here.
    expect(res.status).toBe(404);
  });

  it('refuses a colour outside the status palette', async () => {
    await seedNoteType(firm.id, { value: 'client-call', label: 'Client Call', color: 'info' });

    const res = await owner.api.patch(N(firm.id, '/client-call/color')).send({ color: 'red' });

    // The value is read as a StatusVariant key by every badge that renders it.
    // A free string reaches the frontend as a class name that resolves to
    // nothing, so the badge loses its colour entirely.
    expect(res.status).toBe(400);
    expect((await typeRows(firm.id))[0].color).toBe('info');
  });

  it('does NOT recolour another firm type of the same slug', async () => {
    await seedNoteType(firm.id, { value: 'client-call', label: 'Client Call', color: 'info' });
    await seedNoteType(otherFirm.id, { value: 'client-call', label: 'Client Call', color: 'info' });

    const res = await otherOwner.api.patch(N(otherFirm.id, '/client-call/color'))
      .send({ color: 'danger' });

    // The route is keyed on a slug, not on an id, and both firms legitimately
    // hold the same slug. The upsert conflict target includes law_firm_id for
    // exactly this reason: drop it and one firm's colour choice repaints
    // another firm's notes.
    expect(res.status).toBe(200);
    expect((await typeRows(otherFirm.id))[0].color).toBe('danger');
    expect((await typeRows(firm.id))[0].color).toBe('info');
  });

  it('refuses a member with an empty role and leaves the colour alone', async () => {
    await seedNoteType(firm.id, { value: 'client-call', label: 'Client Call', color: 'info' });
    const narrow = await memberWith(firm.id, []);

    const res = await narrow.api.patch(N(firm.id, '/client-call/color')).send({ color: 'danger' });

    // The baseline grants `noteTypes.view`, not `noteTypes.manage`: a member can
    // see the vocabulary without repainting it for the whole firm.
    expect(res.status).toBe(403);
    expect((await typeRows(firm.id))[0].color).toBe('info');
  });

  it('refuses a member of another firm patching under this firm', async () => {
    await seedNoteType(firm.id, { value: 'client-call', label: 'Client Call', color: 'info' });

    const res = await otherOwner.api.patch(N(firm.id, '/client-call/color')).send({ color: 'danger' });

    expect(res.status).toBe(403);
    expect((await typeRows(firm.id))[0].color).toBe('info');
  });
});
