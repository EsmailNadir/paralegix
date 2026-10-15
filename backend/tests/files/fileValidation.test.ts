/**
 * The guards that run BEFORE any storage call on the files routes.
 *
 * Google Cloud Storage is inert in this harness, so a file operation's success
 * path cannot be tested here. Its REFUSALS can, and they are the half that
 * matters: path traversal, containment inside the firm's own prefix, and the
 * executable upload deny-list all run before the first bucket call.
 *
 * Two of these are genuine security boundaries rather than tidiness:
 *
 *   TRAVERSAL. Every folder name and path fragment is concatenated onto the
 *   caller's scope prefix to build a storage object name. A `..` or a backslash
 *   that survives validation writes outside the prefix the scope check just
 *   authorised.
 *
 *   THE UPLOAD DENY-LIST. The portal serves these files back to clients, so an
 *   accepted `.exe` or `.sh` is a firm handing malware to its own client under
 *   the firm's name.
 *
 * `.js`, `.pl` and `.cgi` were deliberately REMOVED from the deny-list, so a
 * test asserting they are blocked would be wrong. They are not asserted here.
 */
import {
  drainEvents,
  createFirm,
  createPersonClient,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import {
  countRows,
  rivalFirmWithDocument,
  rootOf,
  seedFile,
  seedFolder,
  storageReservedBytes,
  storageUsedBytes,
} from './fileWorld';

let firm: Firm;
let owner: Actor;
let matterId: string;

const F = () => `/api/lawfirms/${firm.id}/files`;

const uploadInit = (files: unknown[]) =>
  owner.api.post(`${F()}/upload-init`).send({ files, matterId, context: 'matter' });

const oneFile = (overrides: Record<string, unknown> = {}) => ([{
  name: 'Statement.pdf', size: 1024, contentType: 'application/pdf', ...overrides,
}]);

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  const client = await createPersonClient(firm.id, { name: 'Pat Person' });
  const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
    name: 'Host Matter', clients: [{ clientId: client.id, name: 'Pat Person' }],
  });
  // Assert the fixture SUCCEEDED before reading what it produced. Without this,
  // a create that fails for any reason surfaces as a TypeError on `undefined`
  // several lines later, and the failure names the destructure instead of the
  // request. That has cost real diagnosis time on this suite.
  expect(matter.status).toBe(201);
  matterId = matter.body.matterId;
  await drainEvents();
});

describe('path traversal is refused before it reaches storage', () => {
  // The name is concatenated onto the scope prefix to build an object name. A
  // surviving `..` writes outside the prefix the scope check just authorised. A
  // backslash is checked separately, because a validator written only against
  // forward slashes lets a Windows-style separator through, and some clients
  // normalise it back.
  it.each([
    ['..', '../escape', /Invalid folderName/],
    ['a backslash', 'a\\b', /Invalid folderName/],
    ['a bare dot', '.', /Invalid folderName/],
    ['nothing', '', /folderName are required/],
  ])('refuses a folder name of %s', async (_label, folderName, message) => {
    const res = await owner.api.post(`${F()}/create-folder`).send({ folderName, matterId });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(await countRows('files', `law_firm_id = $1 and kind = 'folder' and parent_id is not null`, [firm.id])).toBe(0);
  });

  it('refuses a traversal in a RENAME target', async () => {
    const root = await rootOf(firm.id, { matterId });
    const doc = await seedFile(firm.id, { parentId: root, name: 'Statement.pdf' });

    const res = await owner.api.post(`${F()}/rename`)
      .send({ fileId: doc.id, newName: '../escape', matterId });

    // A name is a column value now, not a path segment, so `..` cannot reach an
    // object name at all. The guard stays because a name holding a slash still
    // breaks every breadcrumb and archive path built from the tree.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid newName/);
  });

  it('refuses a MOVE destination that is not a folder in this scope', async () => {
    const root = await rootOf(firm.id, { matterId });
    const doc = await seedFile(firm.id, { parentId: root, name: 'a.pdf' });

    const res = await owner.api.post(`${F()}/move`)
      .send({ fileId: doc.id, destinationFolderId: '../escape', matterId });

    // The destination is a row id. A traversal string is not one, so it resolves
    // to no folder rather than to a path outside the scope.
    expect(res.status).toBe(404);
    expect((await owner.api.get(`${F()}/list-folder?matterId=${matterId}&folderId=${root}`)).body.files
      .map((f: any) => f.name)).toEqual(['a.pdf']);
  });

  it('refuses a FOLDER COLOUR change on a folder in another firm', async () => {
    const rival = await rivalFirmWithDocument();
    const theirFolder = await seedFolder(rival.firm.id, { parentId: rival.root, name: 'Private' });

    const res = await owner.api.post(`${F()}/update-folder-color`)
      .send({ folderId: theirFolder.id, folderColor: 'red', matterId });

    // The row lookup is scoped to the caller firm, so another firm folder is
    // not found rather than refused. Probing must not tell the two apart.
    expect(res.status).toBe(404);
  });
});

describe('containment inside the caller own scope', () => {
  it('refuses to change visibility on a file in ANOTHER firm', async () => {
    const { file: theirDoc } = await rivalFirmWithDocument();

    const res = await owner.api.patch(`${F()}/client-visibility`).send({
      fileId: theirDoc.id,
      matterId,
      clientVisible: true,
    });

    // Marking a file client-visible publishes it to the client portal. Doing it
    // to another firm document would expose their file through this firm portal.
    expect(res.status).toBe(404);
  });

  it('refuses a file in this firm but OUTSIDE the resolved scope', async () => {
    const firmRoot = await rootOf(firm.id, {});
    const general = await seedFile(firm.id, { parentId: firmRoot, name: 'Firm General.pdf' });

    const res = await owner.api.patch(`${F()}/client-visibility`).send({
      fileId: general.id,
      matterId,
      clientVisible: true,
    });

    // Same firm, wrong scope: a firm-general document addressed through a matter
    // scope. The row carries its own scope, which is what stops one scope
    // authorization being used to act on another files.
    expect(res.status).toBe(404);
  });
});

describe('the executable upload deny-list', () => {
  // The portal serves these files back to clients. An accepted `.exe` is a firm
  // handing malware to its own client, under the firm's name. The check is
  // extension OR mime: a caller controls the declared content type, so trusting
  // it alone is bypassed by sending `text/plain`, and renaming an executable to
  // `.pdf` is the obvious bypass of an extension-only list.
  it.each([
    ['a Windows executable', 'invoice.exe', 'application/octet-stream'],
    ['a shell script with an innocent mime type', 'setup.sh', 'text/plain'],
    ['a batch file', 'run.bat', 'text/plain'],
    ['a PHP script', 'shell.php', 'text/plain'],
    ['a JAR', 'payload.jar', 'application/java-archive'],
    ['a dangerous MIME TYPE under a harmless extension', 'harmless.pdf', 'application/x-msdownload'],
  ])('refuses %s', async (_label, name, contentType) => {
    const res = await uploadInit(oneFile({ name, contentType }));

    expect(res.status).toBe(415);
    expect(res.body.code).toBe('FILE_TYPE_NOT_ALLOWED');
    expect(await storageReservedBytes(firm.id)).toBe(0);
  });

  it('names the offending file in the refusal', async () => {
    const res = await uploadInit([
      { name: 'Statement.pdf', size: 10, contentType: 'application/pdf' },
      { name: 'invoice.exe', size: 10, contentType: 'application/octet-stream' },
    ]);

    // A batch refusal that did not say WHICH file was rejected leaves the user
    // re-selecting twenty documents to find out.
    expect(res.status).toBe(415);
    expect(res.body.error).toContain('invoice.exe');
  });
});

describe('upload declaration limits', () => {
  it('refuses more than twenty files in one upload', async () => {
    const res = await uploadInit(
      Array.from({ length: 21 }, (_, i) => ({
        name: `Document ${i}.pdf`, size: 10, contentType: 'application/pdf',
      })),
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/max 20 per upload/i);
  });

  it('refuses a file with no name', async () => {
    const res = await uploadInit(oneFile({ name: '   ' }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/requires a name/i);
  });

  it('refuses a negative size', async () => {
    const res = await uploadInit(oneFile({ size: -5 }));

    // Size is caller-declared and drives the storage quota reservation. A
    // negative one would CREDIT the firm's usage and let it exceed its quota.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid size/i);
    expect(await storageReservedBytes(firm.id)).toBe(0);
  });

  it('refuses a non-numeric size', async () => {
    const res = await uploadInit(oneFile({ size: 'lots' }));

    expect(res.status).toBe(400);
  });

  it('refuses a matter upload with no matter id', async () => {
    const res = await owner.api.post(`${F()}/upload-init`)
      .send({ files: oneFile(), context: 'matter' });

    expect(res.status).toBe(400);
  });
});

describe('export selection limits', () => {
  // These run before any archive is built, which is the point: an export that
  // was accepted has already committed a job row and a transfer slot to work
  // that can never produce anything.
  const requestExportOf = (body: Record<string, unknown>) => owner.api
    .post(`${F()}/export-jobs`).send(body);

  it('refuses more than five thousand items in one export', async () => {
    const res = await requestExportOf({
      fileIds: Array.from({ length: 5001 }, () => '00000000-0000-4000-8000-000000000000'),
      matterId,
    });

    // A selected folder is expanded to its whole subtree, so the cap is what
    // stops one request archiving a firm's entire storage.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at most 5000/i);
  });

  it('refuses an empty selection', async () => {
    const res = await requestExportOf({ fileIds: [], matterId });

    expect(res.status).toBe(400);
  });

  it('refuses a request naming neither a folder nor a selection', async () => {
    const res = await requestExportOf({ matterId });

    // Without this, "no folder and no ids" would fall through to the scope root
    // and quietly archive the whole matter.
    expect(res.status).toBe(400);
  });

  it('refuses when nothing in the selection belongs to this scope', async () => {
    const { file: theirs } = await rivalFirmWithDocument();

    const res = await owner.api.post(`${F()}/export-jobs`)
      .send({ fileIds: [theirs.id], matterId });

    // Each id resolves to a row, and a row outside this scope is dropped. When
    // nothing survives, refusing beats queueing an archive that would come back
    // empty and read as "the files were missing".
    expect(res.status).toBe(404);
    expect(await countRows('file_export_jobs')).toBe(0);
  });

  it('refuses a folder export naming a folder in another firm', async () => {
    const rival = await rivalFirmWithDocument();
    const theirFolder = await seedFolder(rival.firm.id, { parentId: rival.root, name: 'Private' });

    const res = await owner.api.post(`${F()}/export-jobs`)
      .send({ folderId: theirFolder.id, matterId });

    expect(res.status).toBe(404);
    expect(await countRows('file_export_jobs')).toBe(0);
  });
});

describe('tenancy on the files routes', () => {
  it('does not let one firm create a folder on another firm matter', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .post(`/api/lawfirms/${otherFirm.id}/files/create-folder`)
      .send({ folderName: 'Injected', matterId });

    expect(res.status).toBe(404);
    expect(await countRows('files', `kind = 'folder' and name = 'Injected'`)).toBe(0);
  });

  it('does not let one firm start an upload against another firm matter', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .post(`/api/lawfirms/${otherFirm.id}/files/upload-init`)
      .send({ files: oneFile(), matterId, context: 'matter' });

    expect(res.status).toBe(404);
    // No quota reserved or charged against either firm.
    expect(await storageReservedBytes(otherFirm.id)).toBe(0);
    expect(await storageReservedBytes(firm.id)).toBe(0);
    expect(await storageUsedBytes(otherFirm.id)).toBe(0);
  });
});

describe('the upload deny-list exists TWICE, and the copies must not drift', () => {
  /**
   * `src/shared/utils/uploadPolicy.ts` and `src/modules/files/files.storage.ts`
   * each define their own `BLOCKED_UPLOAD_MIME_TYPES`,
   * `BLOCKED_UPLOAD_EXTENSIONS` and `rejectUploadIfDangerous`.
   *
   * The file routes import the `files.storage.ts` copy, while messaging
   * attachments and the shared direct-upload path check the `shared/utils` one.
   * Someone hardening the upload policy in one place would leave the other
   * surface on the old list, and no type error would tell them.
   *
   * Compared through BEHAVIOUR rather than by reading the Sets, because the
   * `files.storage.ts` copies are not exported. A first draft here reached for
   * `live.BLOCKED_UPLOAD_MIME_TYPES ?? []`, which is the fallback-chain trap:
   * `undefined` became an empty Set and the comparison would have gone green the
   * moment the export was renamed.
   *
   * The real fix is to delete one copy. That is a refactor of a widely imported
   * module rather than a test change, so this pins the agreement in the meantime.
   */
  const shared = require('../../src/shared/utils/uploadPolicy');
  const live = require('../../src/modules/files/files.storage');

  const SAMPLES: Array<[string, string]> = [
    ['payload.exe', 'application/octet-stream'],
    ['setup.sh', 'text/plain'],
    ['run.bat', 'text/plain'],
    ['shell.php', 'text/plain'],
    ['payload.jar', 'application/java-archive'],
    ['macro.hta', 'text/plain'],
    ['script.ps1', 'text/plain'],
    ['installer.msi', 'application/octet-stream'],
    ['app.dmg', 'application/octet-stream'],
    ['harmless.pdf', 'application/x-msdownload'],
    ['archive.pdf', 'application/pdf'],
    ['photo.png', 'image/png'],
    ['notes.txt', 'text/plain'],
    ['page.html', 'text/html'],
    ['app.js', 'text/javascript'],
  ];

  it.each(SAMPLES)('agrees on %s (%s)', (originalname, mimetype) => {
    const sharedVerdict = Boolean(shared.rejectUploadIfDangerous({ originalname, mimetype }));
    const liveVerdict = Boolean(live.rejectUploadIfDangerous({ originalname, mimetype }));

    expect(liveVerdict).toBe(sharedVerdict);
  });

  it('actually rejects something, so the agreement is not vacuous', () => {
    // Without this, two implementations that both accepted everything would
    // agree on all fifteen samples above and pass.
    expect(live.rejectUploadIfDangerous({
      originalname: 'payload.exe', mimetype: 'application/octet-stream',
    })).toBeTruthy();
    expect(live.rejectUploadIfDangerous({
      originalname: 'notes.txt', mimetype: 'text/plain',
    })).toBeNull();
  });
});
