/**
 * What a template's HTML body becomes on its way to storage: sanitized, stripped
 * of inline image payloads, and charged against the firm's disk quota.
 *
 * The stored object is the security boundary, not the editor. A template is
 * later rendered into a same-origin blob iframe so a firm member can read it
 * before sending it to a client, which means a `<script>` that survives the save
 * runs with that member's session. The editor cannot be trusted to prevent it:
 * the API takes the body straight from a request, and a request does not have to
 * come from the editor.
 *
 * THE GCS STUB. Every other file in this directory stops before the bucket,
 * because the harness's Firebase mock makes GCS throw by name. The paths here
 * are the ones that cannot: the body IS an object, and there is nothing to
 * assert without one. So this file swaps `admin.storage()` for an in-memory map,
 * which is what the harness's own mock tells a spec to do rather than hand the
 * case to the live suite.
 *
 * The stub is deliberately not the thing under test. Nothing below asserts that
 * the fake bucket works; every assertion is about what the SERVICE decided to
 * put in it, where it decided to put it, and what it decided to take back out.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;

const T = (lawFirmId: string) => `/api/lawfirms/${lawFirmId}/templates`;

/** Object path -> stored bytes. Reset per test. */
let objects: Map<string, Buffer>;

/**
 * An in-memory stand-in for one GCS object, exposing only the five operations
 * the templates service actually calls. A missing object throws, exactly as the
 * real client does, because several code paths here exist specifically to
 * survive that (`objectSizeBytes` treats it as a first write; the asset delete
 * swallows it).
 */
function fakeFile(objectPath: string) {
  return {
    save: async (body: Buffer | string) => {
      objects.set(objectPath, Buffer.from(body as never));
    },
    getMetadata: async () => {
      const stored = objects.get(objectPath);
      if (!stored) throw Object.assign(new Error('No such object'), { code: 404 });
      return [{ size: stored.length }];
    },
    download: async () => {
      const stored = objects.get(objectPath);
      if (!stored) throw Object.assign(new Error('No such object'), { code: 404 });
      return [stored];
    },
    delete: async () => {
      if (!objects.delete(objectPath)) throw Object.assign(new Error('No such object'), { code: 404 });
    },
    getSignedUrl: async () => [`https://signed.test/${encodeURIComponent(objectPath)}`],
  };
}

const storedText = (objectPath: string) => objects.get(objectPath)?.toString('utf8');

const templateRow = async (id: string) => {
  const { rows } = await testPool.query(
    'select name, html_object_path, assets, folder_id from templates where id = $1',
    [id],
  );
  return rows[0];
};

const templateCount = async () => {
  const { rows } = await testPool.query(
    'select count(*)::int n from templates where law_firm_id = $1',
    [firm.id],
  );
  return rows[0].n;
};

const storageUsedBytes = async () => {
  const { rows } = await testPool.query(
    'select storage_used_bytes from law_firms where id = $1',
    [firm.id],
  );
  return Number(rows[0].storage_used_bytes || 0);
};

/**
 * A 1x1 PNG as a data URL. Real bytes rather than a placeholder string, because
 * the service base64-decodes the payload and stores the result; a decode that
 * silently produced nothing would still satisfy a "something was uploaded"
 * assertion.
 */
const PNG_DATA_URL = 'data:image/png;base64,'
  + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const imageTag = (src: string, extra = '') =>
  `<img data-template-object-image="true" data-template-file-name="logo.png" ${extra} src="${src}">`;

const createTemplate = (body: Record<string, unknown> = {}) =>
  owner.api.post(T(firm.id)).send({
    name: 'Engagement Letter',
    html: '<p>Dear client</p>',
    fields: [],
    ...body,
  });

beforeEach(async () => {
  objects = new Map();
  // Swapped per test rather than once at module scope: `getBucket()` resolves
  // the bucket on every call, so a spy installed here covers every request the
  // test makes, and `restoreAllMocks` below puts the inert bucket back for any
  // spec that runs afterwards in this worker.
  const { admin } = require('../../src/shared/database/firebase');
  jest.spyOn(admin, 'storage').mockReturnValue({ bucket: () => ({ file: fakeFile }) });

  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('storing the body', () => {
  it('creates the template and writes its body to storage', async () => {
    const res = await createTemplate({ html: '<p>Dear client</p>' });

    expect(res.status).toBe(201);
    const row = await templateRow(res.body.templateId);
    expect(row.html_object_path).toBe(`lawfirmids/${firm.id}/templates/${res.body.templateId}.html`);
    expect(storedText(row.html_object_path)).toBe('<p>Dear client</p>');
  });

  it('keeps the body out of the row entirely', async () => {
    const res = await createTemplate();

    // The body moved out of the row because PDF imports emit a span per
    // character and blew past the old per-document size ceiling. The row now
    // carries only the path, so the ceiling cannot come back.
    const row = await templateRow(res.body.templateId);
    expect(row.html_object_path).toBeTruthy();
    expect('html' in row).toBe(false);
  });

  it('reads the body back from storage', async () => {
    const created = await createTemplate({ html: '<p>Round trip</p>' });
    expect(created.status).toBe(201);

    const res = await owner.api.get(`${T(firm.id)}/${created.body.templateId}`);

    // The whole point of the indirection: the row no longer holds the body, so a
    // read that did not go to storage would hand the editor an empty template
    // and the next save would overwrite the real one with nothing.
    expect(res.status).toBe(200);
    expect(res.body.template.html).toBe('<p>Round trip</p>');
  });

  it('replaces the stored body on update', async () => {
    const created = await createTemplate({ html: '<p>First draft</p>' });
    expect(created.status).toBe(201);
    const path = (await templateRow(created.body.templateId)).html_object_path;

    await owner.api.put(`${T(firm.id)}/${created.body.templateId}`).send({ html: '<p>Second draft</p>' });

    expect(storedText(path)).toBe('<p>Second draft</p>');
  });

  it('writes the body under the creating firm own prefix', async () => {
    const otherFirm = await createFirm();
    const res = await createTemplate();

    expect(res.status).toBe(201);
    const path = (await templateRow(res.body.templateId)).html_object_path;
    // Every object path is the tenant boundary inside the bucket, and the GC
    // sweep, the quota accounting and the signed-URL reads all key off this
    // prefix. A body written under the wrong firm is readable by that firm and
    // is swept away as an orphan by its own.
    expect(path.startsWith(`lawfirmids/${firm.id}/`)).toBe(true);
    expect(path).not.toContain(otherFirm.id);
  });

  it('refuses a folder that belongs to ANOTHER firm and creates nothing', async () => {
    const otherFirm = await createFirm();
    const foreignFolder = randomUUID();
    await testPool.query(
      'insert into template_folders (id, law_firm_id, name) values ($1, $2, $3)',
      [foreignFolder, otherFirm.id, 'Their Retainers'],
    );

    const res = await createTemplate({ folderId: foreignFolder });

    // Checked before the row is written, so a rejected create leaves no
    // half-built template behind in the list.
    expect(res.status).toBe(404);
    expect(await templateCount()).toBe(0);
    expect(objects.size).toBe(0);
  });
});

describe('sanitizing the body', () => {
  const storedBodyOf = async (html: string) => {
    const res = await createTemplate({ html });
    expect(res.status).toBe(201);
    return storedText((await templateRow(res.body.templateId)).html_object_path) ?? '';
  };

  it('strips a script tag and its contents', async () => {
    const stored = await storedBodyOf('<p>Terms</p><script>fetch("/api/lawfirms")</script>');

    // The stored body is rendered same-origin for whoever opens the template, so
    // this script would run with that member's session and their whole firm
    // behind it. The paragraph is asserted too: a sanitizer that dropped
    // everything would pass the first half of this on its own.
    expect(stored).not.toMatch(/script/i);
    expect(stored).not.toContain('fetch(');
    expect(stored).toContain('<p>Terms</p>');
  });

  it('strips an inline event handler', async () => {
    const stored = await storedBodyOf('<p>Terms</p><img src="https://x.test/a.png" onerror="alert(1)">');

    // `onerror` on a broken image is the shortest working stored-XSS payload
    // there is, and it needs no script tag at all.
    expect(stored).not.toMatch(/onerror/i);
    expect(stored).not.toContain('alert(1)');
  });

  it('strips an iframe', async () => {
    const stored = await storedBodyOf('<p>Terms</p><iframe src="https://evil.test"></iframe>');

    expect(stored).not.toMatch(/iframe/i);
    expect(stored).toContain('<p>Terms</p>');
  });

  it('strips a javascript: link', async () => {
    const stored = await storedBodyOf('<p><a href="javascript:alert(1)">Accept</a></p>');

    // The anchor may survive; the scheme must not. A firm member clicking
    // "Accept" in what looks like their own boilerplate is the delivery step
    // this closes.
    expect(stored).not.toContain('javascript:');
  });

  it('KEEPS the formatting a real template depends on', async () => {
    const stored = await storedBodyOf(
      '<div class="pdf-page" style="position:absolute"><strong>PARTIES</strong>'
      + '<span data-template-placeholder="clientName">{{clientName}}</span></div>',
    );

    // Templates are absolutely positioned and carry a family of data-*
    // attributes that the fill, reflow and export steps read. A sanitizer tuned
    // only for safety would strip the layout and every template in the firm
    // would render as a wall of unstyled text.
    expect(stored).toContain('<strong>PARTIES</strong>');
    expect(stored).toContain('style="position:absolute"');
    expect(stored).toContain('data-template-placeholder="clientName"');
  });

  it('sanitizes an UPDATE as well as a create', async () => {
    const created = await createTemplate({ html: '<p>Clean</p>' });
    expect(created.status).toBe(201);
    const path = (await templateRow(created.body.templateId)).html_object_path;

    await owner.api.put(`${T(firm.id)}/${created.body.templateId}`)
      .send({ html: '<p>Clean</p><script>alert(1)</script>' });

    // Create and update normalize through the same helper today. They have not
    // always, and an unsanitized edit path is worth exactly as much to an
    // attacker as an unsanitized create.
    expect(storedText(path)).not.toMatch(/script/i);
  });
});

describe('inline images', () => {
  it('uploads an embedded image as its own object', async () => {
    const res = await createTemplate({ html: `<p>Header</p>${imageTag(PNG_DATA_URL)}` });

    expect(res.status).toBe(201);
    const row = await templateRow(res.body.templateId);
    expect(row.assets).toHaveLength(1);
    expect(row.assets[0].mimeType).toBe('image/png');
    expect(row.assets[0].objectPath)
      .toMatch(new RegExp(`^lawfirmids/${firm.id}/templates/${res.body.templateId}/assets/.+\\.png$`));
    expect(objects.has(row.assets[0].objectPath)).toBe(true);
  });

  it('removes the base64 payload from the stored body', async () => {
    const res = await createTemplate({ html: imageTag(PNG_DATA_URL) });
    expect(res.status).toBe(201);

    const row = await templateRow(res.body.templateId);
    const stored = storedText(row.html_object_path) ?? '';
    // A body that kept the data URL would carry the image twice and grow without
    // limit as pages are added, which is the size problem that moved the body
    // out of the row in the first place.
    expect(stored).not.toContain('base64');
    expect(stored).toContain(`data-template-asset-id="${row.assets[0].id}"`);
  });

  it('decodes the image rather than storing the text of the data URL', async () => {
    const res = await createTemplate({ html: imageTag(PNG_DATA_URL) });
    expect(res.status).toBe(201);

    const row = await templateRow(res.body.templateId);
    // PNG magic number. Storing the base64 TEXT would still produce a non-empty
    // object at the right path and satisfy every other case in this block, and
    // the template would render a broken image forever.
    expect(objects.get(row.assets[0].objectPath)?.subarray(0, 4))
      .toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('refuses an SVG, which can carry script', async () => {
    const svg = 'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+';

    const res = await createTemplate({ html: imageTag(svg) });

    // An SVG passes the `data:image/` check the sanitizer applies and is then
    // served back to viewers from the firm's own bucket, script and all. It is
    // excluded by MIME type at upload for that reason.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/SVG/i);
  });

  it('leaves NO template row behind when the create is rejected', async () => {
    const svg = 'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+';

    const res = await createTemplate({ name: 'Engagement Letter', html: imageTag(svg) });
    expect(res.status).toBe(400);

    // `createTemplate` has to write the row BEFORE it normalizes the body,
    // because an inline image is stored under the template's own id. That makes
    // every step after the insert a chance to fail with a row already committed:
    // a rejected SVG here, and equally a 502 from the storage write on the next
    // line. The service rolls the draft row back rather than returning an error
    // while leaving a named, empty, unopenable template in the firm's list that
    // nothing cleans up and that the firm cannot tell from a real one until they
    // open it.
    //
    // Asserting the COUNT rather than the status: the 400 above was already
    // correct while the row was still being left behind, so the status proves
    // nothing about this.
    expect(await templateCount()).toBe(0);
  });

  it('KEEPS an asset the edited body still references', async () => {
    const created = await createTemplate({ html: imageTag(PNG_DATA_URL) });
    expect(created.status).toBe(201);
    const first = await templateRow(created.body.templateId);
    const keptPath = first.assets[0].objectPath;

    await owner.api.put(`${T(firm.id)}/${created.body.templateId}`).send({
      html: `<p>New heading</p><img data-template-object-image="true" data-template-asset-id="${first.assets[0].id}">`,
    });

    // The edited body no longer carries a `src`, only the asset id, so the save
    // has to recognise the reference and carry the asset forward. Treating it as
    // gone would delete the object and leave a dead image in a document the firm
    // sends to clients.
    const after = await templateRow(created.body.templateId);
    expect(after.assets.map((a: any) => a.objectPath)).toEqual([keptPath]);
    expect(objects.has(keptPath)).toBe(true);
  });

  it('deletes an asset the edited body dropped', async () => {
    const created = await createTemplate({ html: imageTag(PNG_DATA_URL) });
    expect(created.status).toBe(201);
    const droppedPath = (await templateRow(created.body.templateId)).assets[0].objectPath;
    expect(objects.has(droppedPath)).toBe(true);

    await owner.api.put(`${T(firm.id)}/${created.body.templateId}`).send({ html: '<p>No image now</p>' });

    // Removed AFTER the row update commits, and it does have to be removed: an
    // image nothing references still occupies the bucket and still counts
    // against the firm's quota.
    expect(await templateRow(created.body.templateId)).toMatchObject({ assets: [] });
    expect(objects.has(droppedPath)).toBe(false);
  });
});

describe('storage accounting', () => {
  it('charges the body against the firm usage', async () => {
    const body = `<p>${'x'.repeat(500)}</p>`;
    expect(await storageUsedBytes()).toBe(0);

    const res = await createTemplate({ html: body });

    // Template objects live in the same bucket and under the same firm prefix as
    // everything the files module tracks, and they were not charged at all until
    // recently: a firm could bank unlimited 50 MB uploads against a quota that
    // never moved.
    expect(res.status).toBe(201);
    expect(await storageUsedBytes()).toBe(Buffer.byteLength(body));
  });

  it('charges only the DIFFERENCE when the body is rewritten', async () => {
    const created = await createTemplate({ html: `<p>${'x'.repeat(500)}</p>` });
    expect(created.status).toBe(201);
    const longer = `<p>${'x'.repeat(900)}</p>`;

    await owner.api.put(`${T(firm.id)}/${created.body.templateId}`).send({ html: longer });

    // Every edit rewrites the same object. Charging the full size each time
    // would inflate a busy firm's usage without bound until it could not upload
    // a file, from templates it never grew.
    expect(await storageUsedBytes()).toBe(Buffer.byteLength(longer));
  });

  it('credits the bytes back when the template is deleted', async () => {
    const created = await createTemplate({ html: `<p>${'x'.repeat(500)}</p>${imageTag(PNG_DATA_URL)}` });
    expect(created.status).toBe(201);
    expect(await storageUsedBytes()).toBeGreaterThan(0);

    const res = await owner.api.delete(`${T(firm.id)}/${created.body.templateId}`);

    // Usage that only ever went up would ratchet a firm toward its quota on
    // work it had already thrown away.
    expect(res.status).toBe(200);
    expect(await storageUsedBytes()).toBe(0);
  });

  it('removes the stored objects when the template is deleted', async () => {
    const created = await createTemplate({ html: imageTag(PNG_DATA_URL) });
    expect(created.status).toBe(201);
    const row = await templateRow(created.body.templateId);
    expect(objects.size).toBe(2);

    await owner.api.delete(`${T(firm.id)}/${created.body.templateId}`);

    // Both the body and the image. Anything left behind is invisible to every
    // screen in the product and is only ever reclaimed by the GC sweep.
    expect(objects.has(row.html_object_path)).toBe(false);
    expect(objects.has(row.assets[0].objectPath)).toBe(false);
  });
});
