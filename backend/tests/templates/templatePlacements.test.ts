/**
 * Field placements on a Document Overlay template: where each value is stamped
 * on the page, and which of those boxes becomes a fillable merge field.
 *
 * An overlay template is a court form or a fixed-layout agreement. The firm
 * uploads the PDF once and draws boxes on it; every filled copy stamps the
 * caller's values into those boxes. Two derived facts come out of the same save
 * and both are load-bearing:
 *
 *   `templates.fields` is the list of values a filler is asked for. A box that
 *   wrongly lands in it prompts for a value nobody can supply; a box wrongly
 *   missing from it is stamped blank on every copy of the document, and a form
 *   filed with a blank field is a form that gets rejected.
 *
 *   `templates.repeaters` is the row geometry for a repeating table. Its
 *   `fields` are derived from the placements, NEVER taken from the request, so
 *   the two can never disagree about which columns exist.
 *
 * The save is a full replace-set: delete every placement for the template, then
 * insert the payload, in one transaction. That is the right shape for an editor
 * that always submits its whole canvas, and it is also one dropped predicate
 * away from erasing the layouts of every other template in the firm. Several
 * cases below exist only to pin that predicate.
 *
 * Templates are seeded with SQL, as in `templateAccess.test.ts`: creating an
 * overlay template through the API uploads to GCS, which is inert here. The
 * placement paths themselves never reach the bucket, so everything below runs
 * against the real routes.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  createFirmMember,
  ownerOf,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let templateId: string;

const T = (lawFirmId: string) => `/api/lawfirms/${lawFirmId}/templates`;
const P = (lawFirmId = firm.id, id = templateId) => `${T(lawFirmId)}/${id}/placements`;

async function seedTemplate(
  lawFirmId: string,
  options: { type?: 'html' | 'docx' | 'overlay'; name?: string; fields?: string[] } = {},
) {
  const id = randomUUID();
  await testPool.query(
    `insert into templates (id, law_firm_id, name, type, fields, overlay_pdf_object_path)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      lawFirmId,
      options.name ?? `Overlay ${id.slice(0, 8)}`,
      options.type ?? 'overlay',
      options.fields ?? [],
      `lawfirmids/${lawFirmId}/templates/${id}/overlay.pdf`,
    ],
  );
  return id;
}

/**
 * One placement box. The geometry is percent-of-page and is the same on every
 * case here, because none of them are about geometry; overrides carry the part
 * under test.
 */
const box = (overrides: Record<string, unknown> = {}) => ({
  fieldName: 'clientName',
  fieldType: 'text',
  page: 1,
  xPercent: 10,
  yPercent: 20,
  widthPercent: 30,
  heightPercent: 5,
  ...overrides,
});

/**
 * Where the placement-image upload puts an image for this template. The save
 * only accepts paths under this prefix, so every image fixture has to use it.
 */
const ownImagePath = (name: string, lawFirmId = firm.id, id = templateId) =>
  `lawfirmids/${lawFirmId}/templates/${id}/placement-images/${name}`;

const save = (
  body: Record<string, unknown>,
  lawFirmId = firm.id,
  id = templateId,
  api: Actor['api'] = owner.api,
) => api.put(P(lawFirmId, id)).send(body);

const placementRows = async (id = templateId) => {
  const { rows } = await testPool.query(
    `select field_name, field_type, law_firm_id, template_id, repeater_name,
            repeater_row_index, image_object_path, sort_order
       from template_field_placements
      where template_id = $1
      order by sort_order, field_name`,
    [id],
  );
  return rows;
};

const templateRow = async (id = templateId) => {
  const { rows } = await testPool.query('select fields, repeaters from templates where id = $1', [id]);
  return rows[0];
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  templateId = await seedTemplate(firm.id);
});

describe('saving a layout', () => {
  it('stores the placements', async () => {
    const res = await save({ placements: [box({ fieldName: 'clientName' }), box({ fieldName: 'matterNumber' })] });

    expect(res.status).toBe(200);
    expect((await placementRows()).map((r) => r.field_name)).toEqual(['clientName', 'matterNumber']);
  });

  it('stamps the firm id onto every placement row', async () => {
    await save({ placements: [box()] });

    // The table carries its own `law_firm_id` and every read scopes on it. A row
    // written with the wrong one, or with none, is invisible to the firm that
    // owns the template and visible to whoever it was mis-stamped with.
    const rows = await placementRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].law_firm_id).toBe(firm.id);
    expect(rows[0].template_id).toBe(templateId);
  });

  it('returns the saved placements with numeric geometry, not strings', async () => {
    const res = await save({ placements: [box({ xPercent: 12.5, widthPercent: 33.25 })] });

    // The percent columns are `numeric`, which the driver hands back as a
    // string to protect precision. The overlay editor positions boxes by
    // arithmetic on these values, and `"12.5" * 2` is NaN, so the cast on the
    // way out is what keeps a reloaded layout from collapsing to the origin.
    expect(res.body.placements[0].xPercent).toBe(12.5);
    expect(res.body.placements[0].widthPercent).toBe(33.25);
  });

  it('derives the fillable field list from the placements', async () => {
    await save({ placements: [box({ fieldName: 'clientName' }), box({ fieldName: 'filingDate', fieldType: 'date' })] });

    // This list is what the fill dialog asks a user for. It is derived here
    // rather than sent by the client so it can never disagree with the boxes
    // actually on the page.
    expect((await templateRow()).fields).toEqual(['clientName', 'filingDate']);
  });

  it('REPLACES the previous field list rather than adding to it', async () => {
    templateId = await seedTemplate(firm.id, { fields: ['staleField'] });

    await save({ placements: [box({ fieldName: 'clientName' })] });

    // A template whose boxes were redrawn keeps prompting for the removed field
    // otherwise, and the person filling it has no way to know the value goes
    // nowhere.
    expect((await templateRow()).fields).toEqual(['clientName']);
  });

  it('de-duplicates a field placed in more than one box', async () => {
    await save({
      placements: [
        box({ fieldName: 'clientName', page: 1 }),
        box({ fieldName: 'clientName', page: 2 }),
        box({ fieldName: 'matterNumber' }),
      ],
    });

    // The same value legitimately appears on several pages of a court form. The
    // fill dialog must ask for it once, and both boxes must still be saved.
    expect((await templateRow()).fields).toEqual(['clientName', 'matterNumber']);
    expect(await placementRows()).toHaveLength(3);
  });

  it('refuses flat textbox content without replacing the current layout', async () => {
    expect((await save({ placements: [box({ fieldName: 'currentField' })] })).status).toBe(200);
    const res = await save({ placements: [box({ fieldType: 'textbox', textContent: 'Old flat content' })] });
    expect(res.status).toBe(400);
    expect((await placementRows()).map((row) => row.field_name)).toEqual(['currentField']);
  });

  it('EXCLUDES a text box from the fillable field list', async () => {
    await save({
      placements: [
        box({ fieldName: 'clientName' }),
        box({ fieldName: 'disclaimer', fieldType: 'textbox', richText: [{ bullet: false, runs: [{ text: 'Attorney work product.', bold: false, italic: false, color: '#000000' }] }] }),
      ],
    });

    // A textbox stamps its own literal content on every copy. Listing it as a
    // merge field would prompt the filler for a value that is never read, and
    // the fixed disclaimer would look like something they were supposed to
    // supply.
    expect((await templateRow()).fields).toEqual(['clientName']);
    expect((await placementRows()).map((r) => r.field_type).sort()).toEqual(['text', 'textbox']);
  });

  it('EXCLUDES an image from the fillable field list', async () => {
    await save({
      placements: [
        box({ fieldName: 'clientName' }),
        box({ fieldName: 'firmSeal', fieldType: 'image', imageObjectPath: ownImagePath('seal.png') }),
      ],
    });

    // Same reasoning as the textbox: an image placement stamps uploaded bytes,
    // so there is no value for a filler to type.
    expect((await templateRow()).fields).toEqual(['clientName']);
    const image = (await placementRows()).find((r) => r.field_type === 'image');
    expect(image.image_object_path).toBe(ownImagePath('seal.png'));
  });

  it('clears the layout when an empty set is saved', async () => {
    await save({ placements: [box()] });
    expect(await placementRows()).toHaveLength(1);

    const res = await save({ placements: [] });

    // Deleting the last box in the editor and saving has to actually empty the
    // layout. The insert is skipped for an empty payload, so the delete has to
    // run on its own path.
    expect(res.status).toBe(200);
    expect(await placementRows()).toHaveLength(0);
    expect((await templateRow()).fields).toEqual([]);
  });

  it('drops a placement that is no longer in the payload', async () => {
    await save({ placements: [box({ fieldName: 'clientName' }), box({ fieldName: 'obsolete' })] });

    await save({ placements: [box({ fieldName: 'clientName' })] });

    // Replace-set, not merge. A save that only inserted would leave the removed
    // box stamping onto every filled document forever.
    expect((await placementRows()).map((r) => r.field_name)).toEqual(['clientName']);
  });

  it('does NOT disturb another template layout in the same firm', async () => {
    const sibling = await seedTemplate(firm.id, { name: 'Other Overlay' });
    const seeded = await save({ placements: [box({ fieldName: 'siblingField' })] }, firm.id, sibling);
    expect(seeded.status).toBe(200);

    await save({ placements: [box({ fieldName: 'clientName' })] });

    // The delete half of the replace-set is scoped by firm AND by template. Lose
    // the template predicate and one edit silently erases the layout of every
    // other overlay template the firm owns, which nothing on screen reveals
    // until somebody fills one.
    expect((await placementRows(sibling)).map((r) => r.field_name)).toEqual(['siblingField']);
  });

  it('keeps the editor sort order', async () => {
    // The names are deliberately in the OPPOSITE alphabetical order to the sort
    // order being asserted. Names that happened to sort the same way both times
    // would pass against an ordering that had been changed to anything at all,
    // which is how the first draft of this case survived its own mutation.
    await save({
      placements: [
        box({ fieldName: 'apple', sortOrder: 3 }),
        box({ fieldName: 'cherry', sortOrder: 1 }),
        box({ fieldName: 'banana', sortOrder: 2 }),
      ],
    });

    const res = await owner.api.get(P());

    // The list is ordered in SQL by sort order. The editor's tab order and the
    // fill dialog's field order both come from it, so an unordered read makes a
    // long form unusable to work through.
    expect(res.body.placements.map((p: any) => p.fieldName)).toEqual(['cherry', 'banana', 'apple']);
  });
});

describe('repeaters', () => {
  const repeaterMeta = (overrides: Record<string, unknown> = {}) => ({
    name: 'exhibits',
    anchorPage: 1,
    anchorYPercent: 40,
    rowHeightPercent: 6,
    rowCount: 5,
    ...overrides,
  });

  it('records the repeater columns and its row geometry', async () => {
    const res = await save({
      placements: [
        box({ fieldName: 'label', repeaterName: 'exhibits', repeaterRowIndex: 0 }),
        box({ fieldName: 'date', fieldType: 'date', repeaterName: 'exhibits', repeaterRowIndex: 0 }),
      ],
      repeaters: [repeaterMeta()],
    });

    expect(res.status).toBe(200);
    expect((await templateRow()).repeaters).toEqual([{
      name: 'exhibits',
      fields: ['label', 'date'],
      anchorPage: 1,
      anchorYPercent: 40,
      rowHeightPercent: 6,
      rowCount: 5,
    }]);
  });

  it('keeps repeater columns OUT of the flat field list', async () => {
    await save({
      placements: [
        box({ fieldName: 'clientName' }),
        box({ fieldName: 'label', repeaterName: 'exhibits', repeaterRowIndex: 0 }),
      ],
      repeaters: [repeaterMeta()],
    });

    // A repeater column is filled per row, from `repeaterValues`. Listing it
    // flat would ask for one value for a whole table and stamp that answer into
    // every row.
    expect((await templateRow()).fields).toEqual(['clientName']);
  });

  it('IGNORES a column list supplied by the client', async () => {
    await save({
      placements: [box({ fieldName: 'label', repeaterName: 'exhibits', repeaterRowIndex: 0 })],
      repeaters: [{ ...repeaterMeta(), fields: ['injected', 'notReal'] }],
    });

    // `fields` is derived from the placements and is not an accepted input. A
    // client-supplied list would drift from the boxes on the page the first time
    // somebody edited one, and the fill dialog follows the list, not the boxes.
    expect((await templateRow()).repeaters[0].fields).toEqual(['label']);
  });

  it('excludes a repeater text box from the column list but still saves it', async () => {
    await save({
      placements: [
        box({ fieldName: 'label', repeaterName: 'exhibits', repeaterRowIndex: 0 }),
        box({
          fieldName: 'rowNote',
          fieldType: 'textbox',
          richText: [{ bullet: false, runs: [{ text: 'See attached', bold: false, italic: false, color: '#000000' }] }],
          repeaterName: 'exhibits',
          repeaterRowIndex: 0,
        }),
      ],
      repeaters: [repeaterMeta()],
    });

    // A repeater's textbox is allowed to exist, unlike its exclusion from the
    // fillable list: it is author-fixed content that may reference a sibling
    // column inline. So it must be persisted while staying out of `fields`.
    expect((await templateRow()).repeaters[0].fields).toEqual(['label']);
    expect((await placementRows()).map((r) => r.field_name).sort()).toEqual(['label', 'rowNote']);
  });

  it('refuses a placement pointing at a repeater that was not declared', async () => {
    const res = await save({
      placements: [box({ fieldName: 'label', repeaterName: 'ghosts', repeaterRowIndex: 0 })],
      repeaters: [repeaterMeta()],
    });

    // Without the declaration there is no anchor, no row height and no row
    // count, so the stamp has nowhere to put the column and the value is
    // dropped from every filled copy without a word.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/unknown repeater/i);
  });

  it('refuses a declared repeater that has no columns', async () => {
    const res = await save({
      placements: [box({ fieldName: 'clientName' })],
      repeaters: [repeaterMeta({ name: 'exhibits' })],
    });

    // An empty repeater reserves vertical space on the page for rows that stamp
    // nothing, pushing whatever the author put below it off the layout.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/no field placements/i);
  });

  it('refuses an image inside a repeater column', async () => {
    const res = await save({
      placements: [
        box({ fieldName: 'label', repeaterName: 'exhibits', repeaterRowIndex: 0 }),
        box({
          fieldName: 'thumb',
          fieldType: 'image',
          imageObjectPath: ownImagePath('thumb.png'),
          repeaterName: 'exhibits',
          repeaterRowIndex: 0,
        }),
      ],
      repeaters: [repeaterMeta()],
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/cannot be part of a repeater/i);
  });

  it('writes nothing when it refuses a repeater payload', async () => {
    const seeded = await save({ placements: [box({ fieldName: 'survivor' })] });
    expect(seeded.status).toBe(200);

    await save({
      placements: [box({ fieldName: 'label', repeaterName: 'ghosts', repeaterRowIndex: 0 })],
      repeaters: [],
    });

    // The validation runs before the delete-then-insert. A refusal that had
    // already deleted would leave the firm with a template it can no longer
    // fill, from a save it was told had failed.
    expect((await placementRows()).map((r) => r.field_name)).toEqual(['survivor']);
  });
});

describe('what the layout endpoint refuses', () => {
  it('refuses placements on a template that is not an overlay', async () => {
    const htmlTemplate = await seedTemplate(firm.id, { type: 'html' });

    const res = await save({ placements: [box()] }, firm.id, htmlTemplate);

    // Only an overlay template has a page to place boxes on. Accepting them on
    // an HTML or DOCX template would rewrite `templates.fields` from boxes that
    // are never stamped, so the fill dialog would ask for the wrong values.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Document Overlay/i);
    expect(await placementRows(htmlTemplate)).toHaveLength(0);
  });

  it('refuses to save onto ANOTHER firm template', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    const seeded = await save({ placements: [box({ fieldName: 'ours' })] });
    expect(seeded.status).toBe(200);

    const res = await save({ placements: [box({ fieldName: 'theirs' })] }, otherFirm.id, templateId, otherOwner.api);

    expect(res.status).toBe(404);
    expect((await placementRows()).map((r) => r.field_name)).toEqual(['ours']);
  });

  it('refuses to READ another firm layout', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    const seeded = await save({ placements: [box({ fieldName: 'confidentialField' })] });
    expect(seeded.status).toBe(200);

    const res = await otherOwner.api.get(P(otherFirm.id, templateId));

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('confidentialField');
  });

  it('refuses a view-only member the right to redraw the layout', async () => {
    const seeded = await save({ placements: [box({ fieldName: 'ours' })] });
    expect(seeded.status).toBe(200);
    const viewer = await createFirmMember(firm.id, { isOwner: false, permissions: ['templates.view'] });
    const viewerApi = as(tokenFor({ uid: viewer.uid }));

    const res = await viewerApi.put(P()).send({ placements: [] });

    // Reading the layout is a `templates.view` action; redrawing it is not. A
    // `templates.view` caller who could send an empty set would wipe the
    // template's whole layout.
    expect((await viewerApi.get(P())).status).toBe(200);
    expect(res.status).toBe(403);
    expect(await placementRows()).toHaveLength(1);
  });

  it('answers not-found for a malformed template id', async () => {
    const res = await owner.api.put(P(firm.id, 'not-a-uuid')).send({ placements: [] });

    expect(res.status).toBe(404);
  });

  it('refuses a placement with no field name', async () => {
    const res = await save({ placements: [box({ fieldName: '' })] });

    // The field name is the key the fill values are looked up under. An empty
    // one matches nothing and stamps blank.
    expect(res.status).toBe(400);
    expect(await placementRows()).toHaveLength(0);
  });

  it('refuses a box with no width', async () => {
    const res = await save({ placements: [box({ widthPercent: 0 })] });

    // A zero-width box fits no text at all, and the stamping path auto-fits
    // font size to the box, so it silently renders nothing.
    expect(res.status).toBe(400);
  });

  it('refuses a page number below one', async () => {
    const res = await save({ placements: [box({ page: 0 })] });

    // Pages are one-based on the stamped PDF. Page 0 addresses no page, so the
    // value never appears on the document.
    expect(res.status).toBe(400);
  });

  it('refuses a text box with nothing in it', async () => {
    const res = await save({ placements: [box({ fieldName: 'blankNote', fieldType: 'textbox' })] });

    // A textbox has no bound value, so empty content means the box stamps
    // nothing and exists only to confuse the next author.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/text content/i);
  });

  it('refuses an image placement with no uploaded image', async () => {
    const res = await save({ placements: [box({ fieldName: 'seal', fieldType: 'image' })] });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/uploaded image/i);
  });

  it('refuses a colour that is not a hex value', async () => {
    const res = await save({ placements: [box({ color: 'red' })] });

    // The colour is parsed into rgb components by the stamping path. A name it
    // cannot parse either throws mid-render or stamps the wrong colour onto a
    // filed document.
    expect(res.status).toBe(400);
  });

  it('refuses a font the stamping path cannot embed', async () => {
    const res = await save({ placements: [box({ fontFamily: 'comic-sans' })] });

    // Only the built-in pdf-lib fonts and the TTFs shipped in the module can be
    // embedded. Anything else fails at fill time, not at save time, which is
    // long after the author could have fixed it.
    expect(res.status).toBe(400);
  });

  it('refuses a repeater placement on a row other than the first', async () => {
    const res = await save({
      placements: [box({ fieldName: 'label', repeaterName: 'exhibits', repeaterRowIndex: 2 })],
      repeaters: [{ name: 'exhibits', anchorPage: 1, anchorYPercent: 40, rowHeightPercent: 6, rowCount: 5 }],
    });

    // Only the authored first row is stored; the rest are derived from the row
    // height at fill time. A placement claiming row 2 would be stamped as if it
    // were row 0 and overlap whatever is really there.
    expect(res.status).toBe(400);
  });

  it('refuses a row index on a placement that is not in a repeater', async () => {
    const res = await save({ placements: [box({ repeaterRowIndex: 0 })] });

    expect(res.status).toBe(400);
  });

  it('refuses negative width or height dimensions', async () => {
    const negWidth = await save({ placements: [box({ widthPercent: -15 })] });
    expect(negWidth.status).toBe(400);

    const negHeight = await save({ placements: [box({ heightPercent: -10 })] });
    expect(negHeight.status).toBe(400);

    const zeroHeight = await save({ placements: [box({ heightPercent: 0 })] });
    expect(zeroHeight.status).toBe(400);
  });

  it('refuses negative or fractional page numbers', async () => {
    const negPage = await save({ placements: [box({ page: -1 })] });
    expect(negPage.status).toBe(400);

    const fractionalPage = await save({ placements: [box({ page: 2.5 })] });
    expect(fractionalPage.status).toBe(400);
  });

  it('refuses a textbox placement with empty or invalid richText runs', async () => {
    const res = await save({
      placements: [box({
        fieldName: 'invalidRich',
        fieldType: 'textbox',
        richText: [{
          bullet: false,
          runs: [{ text: '   ', bold: false, italic: false, color: '#000000' }],
        }],
      })],
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/text content/i);
  });

  it('refuses more than two hundred rich-text blocks without replacing the saved layout', async () => {
    const seeded = await save({ placements: [box({ fieldName: 'existingField' })] });
    expect(seeded.status).toBe(200);
    const richText = Array.from({ length: 201 }, (_, index) => ({
      bullet: false,
      runs: [{ text: `Paragraph ${index + 1}`, bold: false, italic: false, color: '#000000' }],
    }));

    const res = await save({
      placements: [box({ fieldName: 'oversizedText', fieldType: 'textbox', richText })],
    });

    // Save is a replace-set. Validation must run before its delete phase, or a
    // malformed editor payload would erase the otherwise valid court-form layout.
    expect(res.status).toBe(400);
    expect((await placementRows()).map((row) => row.field_name)).toEqual(['existingField']);
  });

  it('refuses more than two hundred styled runs in one block without replacing the saved layout', async () => {
    const seeded = await save({ placements: [box({ fieldName: 'existingField' })] });
    expect(seeded.status).toBe(200);
    const runs = Array.from({ length: 201 }, (_, index) => ({
      text: `Run ${index + 1}`,
      bold: false,
      italic: false,
      color: '#000000',
    }));

    const res = await save({
      placements: [box({
        fieldName: 'oversizedRuns',
        fieldType: 'textbox',
        richText: [{ bullet: false, runs }],
      })],
    });

    expect(res.status).toBe(400);
    expect((await placementRows()).map((row) => row.field_name)).toEqual(['existingField']);
  });

  it('refuses a styled run longer than five hundred characters without replacing the saved layout', async () => {
    const seeded = await save({ placements: [box({ fieldName: 'existingField' })] });
    expect(seeded.status).toBe(200);

    const res = await save({
      placements: [box({
        fieldName: 'overlongRun',
        fieldType: 'textbox',
        richText: [{
          bullet: false,
          runs: [{ text: 'x'.repeat(501), bold: false, italic: false, color: '#000000' }],
        }],
      })],
    });

    expect(res.status).toBe(400);
    expect((await placementRows()).map((row) => row.field_name)).toEqual(['existingField']);
  });
});

describe('field chips inside a text box', () => {
  const chipRun = (fieldName: string) => ({ text: `{${fieldName}}`, fieldName, bold: false, italic: false, color: '#000000' });
  const literalRun = (text: string) => ({ text, bold: false, italic: false, color: '#000000' });

  it('asks the filler for a field a standalone text box references inline', async () => {
    const res = await save({
      placements: [
        box({ fieldName: 'clientName' }),
        box({
          fieldName: 'Dear',
          fieldType: 'textbox',
          richText: [{ bullet: false, runs: [literalRun('Dear '), chipRun('salutation'), literalRun(',')] }],
        }),
      ],
    });

    // A chip the filler is never asked about stamps as nothing, and a letter
    // that opens "Dear ," goes out looking unfinished. The chip's field has to
    // be in the fillable list even though the text box itself is not a value.
    expect((await templateRow()).fields).toEqual(['clientName', 'salutation']);
    // The editor shows the list straight from the save response.
    expect(res.body.fields).toEqual(['clientName', 'salutation']);
  });

  it('does not list a chip twice when a field of the same name is also placed', async () => {
    await save({
      placements: [
        box({ fieldName: 'clientName' }),
        box({
          fieldName: 'Note',
          fieldType: 'textbox',
          richText: [{ bullet: false, runs: [literalRun('For '), chipRun('clientName')] }],
        }),
      ],
    });

    expect((await templateRow()).fields).toEqual(['clientName']);
  });

  it('treats a chip in a repeater column as per-row when it names a sibling column, and as a document field otherwise', async () => {
    await save({
      placements: [
        box({ fieldName: 'label', repeaterName: 'exhibits', repeaterRowIndex: 0 }),
        box({
          fieldName: 'caption',
          fieldType: 'textbox',
          repeaterName: 'exhibits',
          repeaterRowIndex: 0,
          richText: [{ bullet: false, runs: [literalRun('Exhibit '), chipRun('label'), literalRun(' for '), chipRun('matterNumber')] }],
        }),
      ],
      repeaters: [{ name: 'exhibits', anchorPage: 1, anchorYPercent: 40, rowHeightPercent: 6, rowCount: 5 }],
    });

    const row = await templateRow();
    // `label` resolves from the row's own data, so it stays a repeater field
    // and is not asked for again per document.
    expect(row.repeaters[0].fields).toEqual(['label']);
    // `matterNumber` is not a column, so it can only resolve from the
    // document-level values and has to be asked for there.
    expect(row.fields).toEqual(['matterNumber']);
  });

  it('stores the rich runs a text box was saved with', async () => {
    const richText = [{ bullet: true, runs: [literalRun('Bold '), { ...literalRun('part'), bold: true }] }];
    await save({ placements: [box({ fieldName: 'Note', fieldType: 'textbox', richText })] });

    const res = await owner.api.get(P());
    expect(res.body.placements[0].richText).toEqual(richText);
  });
});

describe('repeater row geometry', () => {
  it('refuses a column taller than its repeater row', async () => {
    const res = await save({
      placements: [box({ fieldName: 'label', repeaterName: 'exhibits', repeaterRowIndex: 0, heightPercent: 8 })],
      repeaters: [{ name: 'exhibits', anchorPage: 1, anchorYPercent: 40, rowHeightPercent: 6, rowCount: 5 }],
    });

    // Row height is the distance between rows. A column taller than that
    // prints over the row below it on every filled copy, and the editor's
    // own clamp is the only thing that has stopped it until now.
    expect(res.status).toBe(400);
    expect(res.body.message ?? res.body.error).toMatch(/taller than/i);
    expect(await placementRows()).toHaveLength(0);
  });

  it('accepts a column exactly as tall as its row', async () => {
    const res = await save({
      placements: [box({ fieldName: 'label', repeaterName: 'exhibits', repeaterRowIndex: 0, heightPercent: 6 })],
      repeaters: [{ name: 'exhibits', anchorPage: 1, anchorYPercent: 40, rowHeightPercent: 6, rowCount: 5 }],
    });

    expect(res.status).toBe(200);
  });
});

describe('image placement paths', () => {
  /**
   * The image path is sent by the editor, so it is caller-controlled. The fill
   * reads whatever object it names and a later save deletes it once it drops out
   * of the layout, so a path outside this template's own upload prefix is a
   * cross-template (or cross-firm) read and delete.
   */
  const imageBox = (imageObjectPath: string) => box({ fieldName: 'seal', fieldType: 'image', imageObjectPath });

  async function refusedWithoutWriting(imageObjectPath: string) {
    const seeded = await save({ placements: [box({ fieldName: 'survivor' })] });
    expect(seeded.status).toBe(200);

    const res = await save({ placements: [imageBox(imageObjectPath)] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/image/i);
    // Refused before the replace-set ran, so the saved layout is untouched and
    // the foreign path was never stored.
    expect((await placementRows()).map((r) => r.field_name)).toEqual(['survivor']);
  }

  it('accepts an image uploaded for this template', async () => {
    const res = await save({ placements: [imageBox(ownImagePath('seal.png'))] });

    expect(res.status).toBe(200);
    expect((await placementRows())[0].image_object_path).toBe(ownImagePath('seal.png'));
  });

  it('refuses an image path belonging to another template in the same firm', async () => {
    const sibling = await seedTemplate(firm.id);

    await refusedWithoutWriting(ownImagePath('seal.png', firm.id, sibling));
  });

  it('refuses an image path belonging to another firm', async () => {
    const otherFirm = await createFirm();

    await refusedWithoutWriting(ownImagePath('seal.png', otherFirm.id, templateId));
  });

  it('refuses this template\'s own source PDF as an image', async () => {
    // Inside the template's folder but not an uploaded image. Accepting it would
    // let the next save that drops the box delete the template's source PDF.
    await refusedWithoutWriting(`lawfirmids/${firm.id}/templates/${templateId}/overlay.pdf`);
  });

  it('refuses a path that climbs out of the image folder with ..', async () => {
    const sibling = await seedTemplate(firm.id);

    await refusedWithoutWriting(ownImagePath(`../../${sibling}/placement-images/seal.png`));
  });

  it('refuses an image path longer than storage allows', async () => {
    await refusedWithoutWriting(ownImagePath(`${'a'.repeat(1100)}.png`));
  });

  it('never deletes a foreign image path that is already stored when it leaves the layout', async () => {
    // A row written before the save-time check existed. Seeded directly because
    // the route now refuses to store it.
    const otherFirm = await createFirm();
    const foreignPath = ownImagePath('victim.png', otherFirm.id, randomUUID());
    const ownPath = ownImagePath('mine.png');
    for (const [name, imagePath] of [['foreign', foreignPath], ['own', ownPath]]) {
      // eslint-disable-next-line no-await-in-loop -- fixture setup
      await testPool.query(
        `insert into template_field_placements
           (id, law_firm_id, template_id, field_name, field_type, page,
            x_percent, y_percent, width_percent, height_percent, image_object_path, sort_order)
         values ($1, $2, $3, $4, 'image', 1, 10, 10, 20, 10, $5, 0)`,
        [randomUUID(), firm.id, templateId, name, imagePath],
      );
    }

    const deleted: string[] = [];
    const { admin } = require('../../src/shared/database/firebase');
    const spy = jest.spyOn(admin, 'storage').mockReturnValue({
      bucket: () => ({
        file: (objectPath: string) => ({
          getMetadata: async () => [{ size: '10' }],
          delete: async () => { deleted.push(objectPath); },
          getSignedUrl: async () => ['https://signed.test/x'],
        }),
      }),
    });
    try {
      const res = await save({ placements: [] });

      expect(res.status).toBe(200);
      // The template's own image is cleaned up, which proves the delete pass ran.
      expect(deleted).toContain(ownPath);
      expect(deleted).not.toContain(foreignPath);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('box geometry', () => {
  // Percent-of-page boxes. The editor's clampPlacementBox keeps every box on
  // the page, so anything off it came from somewhere else and stamps nothing
  // visible, or stamps onto the margin of a filed document.
  it.each([
    ['x below zero', { xPercent: -1 }],
    ['x past the page', { xPercent: 101, widthPercent: 5 }],
    ['y below zero', { yPercent: -1 }],
    ['y past the page', { yPercent: 101, heightPercent: 5 }],
    ['width over the page', { xPercent: 0, widthPercent: 101 }],
    ['height over the page', { yPercent: 0, heightPercent: 101 }],
    ['a box running off the right edge', { xPercent: 80, widthPercent: 21 }],
    ['a box running off the bottom edge', { yPercent: 96, heightPercent: 5 }],
  ])('refuses %s', async (_label, overrides) => {
    const res = await save({ placements: [box(overrides)] });

    expect(res.status).toBe(400);
    expect(await placementRows()).toHaveLength(0);
  });

  it('accepts a box flush with the bottom-right corner, allowing float drift', async () => {
    // 70.1 + 29.9 is not exactly 100 in floating point; the editor produces
    // values like it whenever a box is dragged to the edge.
    const res = await save({
      placements: [
        box({ fieldName: 'corner', xPercent: 80, yPercent: 95, widthPercent: 20, heightPercent: 5 }),
        box({ fieldName: 'drift', xPercent: 70.1, yPercent: 0, widthPercent: 29.9, heightPercent: 100 }),
      ],
    });

    expect(res.status).toBe(200);
    expect(await placementRows()).toHaveLength(2);
  });

  const repeaterSave = (meta: Record<string, unknown>) => save({
    placements: [box({ fieldName: 'label', repeaterName: 'exhibits', repeaterRowIndex: 0 })],
    repeaters: [{ name: 'exhibits', anchorPage: 1, anchorYPercent: 40, rowHeightPercent: 6, rowCount: 5, ...meta }],
  });

  it.each([
    ['a negative anchor', { anchorYPercent: -5 }],
    ['an anchor at the bottom of the page', { anchorYPercent: 100 }],
    ['an anchor past the page', { anchorYPercent: 5000 }],
    ['a row taller than the page', { rowHeightPercent: 101 }],
  ])('refuses a repeater with %s', async (_label, meta) => {
    const res = await repeaterSave(meta);

    expect(res.status).toBe(400);
    expect(await placementRows()).toHaveLength(0);
  });
});

describe('payload size limits', () => {
  it('refuses more placements than a page layout can need', async () => {
    const placements = Array.from({ length: 1001 }, (_, i) => box({ fieldName: `f${i}` }));

    const res = await save({ placements });

    expect(res.status).toBe(400);
    expect(await placementRows()).toHaveLength(0);
  });

  it('refuses more than fifty repeaters', async () => {
    const names = Array.from({ length: 51 }, (_, i) => `r${i}`);

    const res = await save({
      placements: names.map((name) => box({ fieldName: 'label', repeaterName: name, repeaterRowIndex: 0 })),
      repeaters: names.map((name) => ({ name, anchorPage: 1, anchorYPercent: 40, rowHeightPercent: 6, rowCount: 5 })),
    });

    expect(res.status).toBe(400);
    expect(await placementRows()).toHaveLength(0);
  });

  it('refuses a repeater with more than a hundred rows per page', async () => {
    // rowCount is rows per page. It sets how many continuation pages a fill
    // copies, so an unbounded one is a lever on the size of every filled copy.
    const res = await save({
      placements: [box({ fieldName: 'label', repeaterName: 'exhibits', repeaterRowIndex: 0, heightPercent: 1 })],
      repeaters: [{ name: 'exhibits', anchorPage: 1, anchorYPercent: 0, rowHeightPercent: 1, rowCount: 101 }],
    });

    expect(res.status).toBe(400);
  });

  it('refuses a field name longer than a merge field chip allows', async () => {
    const res = await save({ placements: [box({ fieldName: 'x'.repeat(121) })] });

    expect(res.status).toBe(400);
    expect(await placementRows()).toHaveLength(0);
  });

  it('refuses a repeater name longer than a field name allows', async () => {
    const name = 'r'.repeat(121);

    const res = await save({
      placements: [box({ fieldName: 'label', repeaterName: name, repeaterRowIndex: 0 })],
      repeaters: [{ name, anchorPage: 1, anchorYPercent: 40, rowHeightPercent: 6, rowCount: 5 }],
    });

    expect(res.status).toBe(400);
  });
});

describe('a template deleted while its layout saves', () => {
  it('answers 404 rather than a foreign-key 500 when the row is gone by the time the save locks it', async () => {
    // The delete lands between the save's own existence check and its lock:
    // the lock finds no row, and inserting placements for it would violate
    // the template foreign key.
    // Required here, not imported at the top: loading the app's modules before
    // the in-process harness has set up the environment breaks every route.
    const templatesRepo = require('../../src/modules/templates/templates.repository');
    const lock = jest.spyOn(templatesRepo, 'lockForUpdate').mockResolvedValueOnce(null);

    const res = await save({ placements: [box({ fieldName: 'orphan' })] });

    expect(lock).toHaveBeenCalled();
    expect(res.status).toBe(404);
    expect(await placementRows()).toEqual([]);
  });
});

describe('concurrent saves', () => {
  it('leaves exactly one of two overlapping layouts, never both', async () => {
    // The save is delete-then-insert. Two overlapping saves that each delete
    // before the other commits both insert, and the template ends up stamping
    // the union of two layouts on top of each other.
    const layoutA = ['a1', 'a2', 'a3'];
    const layoutB = ['b1', 'b2'];
    for (let round = 0; round < 5; round += 1) {
      // eslint-disable-next-line no-await-in-loop -- each round must finish before the next
      const [resA, resB] = await Promise.all([
        save({ placements: layoutA.map((fieldName) => box({ fieldName })) }),
        save({ placements: layoutB.map((fieldName) => box({ fieldName })) }),
      ]);
      expect([resA.status, resB.status]).toEqual([200, 200]);

      // eslint-disable-next-line no-await-in-loop -- each round must finish before the next
      const names = (await placementRows()).map((r) => r.field_name).sort();
      expect([layoutA, layoutB]).toContainEqual(names);
    }
  });
});
