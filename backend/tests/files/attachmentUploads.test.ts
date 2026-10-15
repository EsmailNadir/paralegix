/**
 * Note and task attachments: the uploads that are addressed by the record that
 * owns them rather than browsed to.
 *
 * These differ from the browsable uploads in what they hand back. They keep the
 * user's ORIGINAL filename in the record (a note body renders it, so
 * `Exhibit A.pdf` must not come back as `Exhibit_A.pdf`), they return a signed
 * url the record stores, and they carry a `type` tag on the object saying which
 * kind of attachment they are.
 *
 * What is asserted throughout is the ROW: which folder it sits in, and which
 * ids tie it to its parent. A row with no `task_id` never appears in the task's
 * file view, and a row in the wrong folder is a document filed where the firm
 * cannot find it.
 *
 * `DELETE /delete-task-attachment` is the other half of the same surface. It
 * takes a file id and checks that the row really belongs to the task named,
 * which is what most of the refusals below exercise.
 */
import { objects } from '../support/inMemoryBucket';
import {
  createFirm,
  createPersonClient,
  memberWith,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { installRichBucket, resetRichBucket } from './richBucket';
import {
  countRows,
  fileRowById,
  joinMatter,
  rootOf,
  seedFile,
  seedMatter,
  seedTask,
  storageReservedBytes,
  storageUsedBytes,
  taskAttachments,
  attachFileToTask,
  rivalFirmWithDocument,
  uploadThroughRoutes,
} from './fileWorld';

installRichBucket();

const filesRepo = require('../../src/modules/files/files.repository');

let firm: Firm;
let owner: Actor;
let matterId: string;
let otherMatterId: string;
let clientId: string;
let standaloneTask: string;
let linkedTask: string;
let matterRoot: string;

const F = () => `/api/lawfirms/${firm.id}/files`;

const bytes = (n: number) => Buffer.alloc(n, 0x70);

/** The `note-attachments` folder under a scope root, if the route made one. */
async function attachmentsFolderIn(rootId: string) {
  const { folders } = await filesRepo.listChildren(firm.id, rootId);
  return folders.find((f: any) => f.name === 'note-attachments') || null;
}

/** The one file directly inside a folder, when a test arranged for there to be one. */
async function soleFileIn(folderId: string) {
  const { files } = await filesRepo.listChildren(firm.id, folderId);
  expect(files).toHaveLength(1);
  return files[0];
}

/** Every live file row directly inside a folder. */
async function filesIn(folderId: string) {
  const { files } = await filesRepo.listChildren(firm.id, folderId);
  return files;
}


/**
 * A note or task attachment upload, through `upload-init` / `upload-finalize`
 * like every other document. `attachmentFolder` is what separates the two
 * kinds: a NOTE attachment asks for the `note-attachments` folder, a TASK
 * attachment takes the scope root.
 */
const uploadAttachments = (
  actor: Actor, scope: Record<string, unknown>, files: Array<{ name: string; size: number }>,
) => uploadThroughRoutes(
  actor, firm.id, scope, files.map((f) => ({ ...f, contentType: 'application/pdf' })),
);

/** A note attachment: lands in the `note-attachments` folder of its scope. */
const uploadNoteAttachments = (
  actor: Actor, scope: Record<string, unknown>, files: Array<{ name: string; size: number }>,
) => uploadAttachments(actor, { ...scope, attachmentFolder: 'note-attachments' }, files);

beforeEach(async () => {
  resetRichBucket();

  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
  matterId = await seedMatter(firm.id, owner.uid, 'Hollis v. Denton');
  otherMatterId = await seedMatter(firm.id, owner.uid, 'Ambrose Estate');
  ({ id: clientId } = await createPersonClient(firm.id, { name: 'Marisol Vance' }));
  standaloneTask = await seedTask(firm.id, { title: 'Renew the registration' });
  linkedTask = await seedTask(firm.id, { matterId, title: 'File the reply brief' });
  matterRoot = await rootOf(firm.id, { matterId });
});

// ---------------------------------------------------------------------------

describe('uploading a note attachment', () => {
  it('files it in the note-attachments folder of the matter it belongs to', async () => {
    const res = await uploadNoteAttachments(owner, { context: 'matter', matterId: matterId }, [{ name: 'Exhibit A.pdf', size: 1024 }]);

    expect(res.status).toBe(201);
    // A real folder row in the matter's tree, so the firm can browse to it. It
    // used to be a path segment with no folder behind it, which is why the
    // browser showed a `note-attachments` folder nothing could rename or delete.
    const folder = await attachmentsFolderIn(matterRoot);
    expect(folder).not.toBeNull();
    expect((await soleFileIn(folder.id)).name).toBe('Exhibit A.pdf');
  });

  it('keeps the ORIGINAL filename in the record, not a sanitized one', async () => {
    const res = await uploadNoteAttachments(owner, { context: 'matter', matterId: matterId }, [{ name: 'Exhibit A.pdf', size: 1024 }]);

    // The note body renders this name. The old sanitizer replaced everything
    // outside `[a-zA-Z0-9._-]`, because the name was part of the object path;
    // it is not any more, so a space survives.
    expect(res.body.files[0]).toMatchObject({ name: 'Exhibit A.pdf', size: 1024 });
    const folder = await attachmentsFolderIn(matterRoot);
    const row = await fileRowById(firm.id, (await soleFileIn(folder.id)).id);
    expect(row).toMatchObject({ name: 'Exhibit A.pdf', matter_id: matterId });
  });

  it('tags the object with its kind and its matter', async () => {
    await uploadNoteAttachments(owner, { context: 'matter', matterId: matterId }, [{ name: 'Exhibit.pdf', size: 1024 }]);

    const folder = await attachmentsFolderIn(matterRoot);
    const stored = await soleFileIn(folder.id);
    // `type` and `originalName` used to be stamped on the OBJECT here. Nothing
    // ever read them: the row is what says a document is a note attachment, and
    // `delete-task-attachment` works from the row's `task_id`. They are not
    // carried onto the shared upload path, so what is left is what is used.
    expect(objects.get(stored.objectPath)?.custom).toMatchObject({
      matterId,
      uploadedBy: owner.uid,
    });
  });

  it('hands back a signed url and the file id the note record stores', async () => {
    const res = await uploadNoteAttachments(owner, { context: 'matter', matterId: matterId }, [{ name: 'Exhibit.pdf', size: 1024 }]);

    const folder = await attachmentsFolderIn(matterRoot);
    const stored = await soleFileIn(folder.id);
    // Attachments are not browsed to, so the record stores the url. Returning
    // none would leave the note pointing at nothing until a refresh. The id is
    // the row's, so deleting an attachment later is a lookup rather than a
    // path match.
    expect(res.body.files[0].signedUrl).toEqual(expect.any(String));
    expect(res.body.files[0].fileId).toBe(stored.id);
    expect(res.body.files[0].objectPath).toBe(stored.objectPath);
  });

  it('keeps two files of the SAME name apart', async () => {
    const res = await uploadNoteAttachments(owner, { context: 'matter', matterId: matterId }, [{ name: 'Exhibit.pdf', size: 1024 }, { name: 'Exhibit.pdf', size: 2048 }]);

    expect(res.status).toBe(201);
    const folder = await attachmentsFolderIn(matterRoot);
    const stored = await filesIn(folder.id);
    // Two rows, two objects, and the second is named by the same "(n)" rule any
    // duplicate gets. The unique index decides it, so two uploads racing for the
    // name cannot both win: the old randomized path segment hid the collision
    // instead of resolving it, and the folder listed two files called Exhibit.
    expect(stored.map((f: any) => f.name).sort()).toEqual(['Exhibit (1).pdf', 'Exhibit.pdf']);
    expect(new Set(stored.map((f: any) => f.objectPath)).size).toBe(2);
    expect(await storageUsedBytes(firm.id)).toBe(1024 + 2048);
  });

  it('reuses one note-attachments folder across uploads rather than making a second', async () => {
    await uploadNoteAttachments(owner, { context: 'matter', matterId }, [{ name: 'First.pdf', size: 512 }]);
    await uploadNoteAttachments(owner, { context: 'matter', matterId }, [{ name: 'Second.pdf', size: 512 }]);

    expect(await countRows(
      'files',
      `law_firm_id = $1 and parent_id = $2 and kind = 'folder'
         and lower(name) = 'note-attachments' and deleted_at is null`,
      [firm.id, matterRoot],
    )).toBe(1);
    const folder = await attachmentsFolderIn(matterRoot);
    expect((await filesIn(folder.id)).map((f: any) => f.name).sort()).toEqual(['First.pdf', 'Second.pdf']);
  });

  it('files a CLIENT note attachment under that client folder', async () => {
    const res = await uploadNoteAttachments(owner, { context: 'client', clientId: clientId }, [{ name: 'Intake.pdf', size: 512 }]);

    // One route serves matter, task and client notes: it forwards whichever id
    // the note carries instead of demanding a matter. A client note attachment
    // filed under a matter would be visible in that matter's browser.
    expect(res.status).toBe(201);
    const clientRoot = await rootOf(firm.id, { clientId });
    const folder = await attachmentsFolderIn(clientRoot);
    expect(await filesIn(folder.id)).toHaveLength(1);
    expect(await filesIn(matterRoot)).toEqual([]);
  });

  it('files a STANDALONE TASK note attachment under that task folder', async () => {
    const res = await uploadNoteAttachments(owner, { context: 'task', taskId: standaloneTask }, [{ name: 'Checklist.pdf', size: 512 }]);

    expect(res.status).toBe(201);
    const taskRoot = await rootOf(firm.id, { taskId: standaloneTask });
    const folder = await attachmentsFolderIn(taskRoot);
    expect(await filesIn(folder.id)).toHaveLength(1);
  });

  it('refuses a note attachment naming no parent at all', async () => {
    // No context at all, which is what a note with no parent amounts to. The
    // browsable uploads fall back to the firm's general folder; an ATTACHMENT
    // with no record to hang on is a file nobody can reach, so it is refused.
    const res = await uploadNoteAttachments(owner, {}, [{ name: 'Orphan.pdf', size: 512 }]);

    // Unlike the browsable uploads there is no firm-general fallback here: an
    // attachment with no record to hang on is a file nobody can reach.
    expect(res.status).toBe(400);
    expect(await storageUsedBytes(firm.id)).toBe(0);
  });

  it('refuses a caller who is not on the matter', async () => {
    const walled = await memberWith(firm.id, ['files.view', 'files.upload']);

    const res = await uploadNoteAttachments(walled, { context: 'matter', matterId: matterId }, [{ name: 'Planted.pdf', size: 512 }]);

    expect(res.status).toBe(403);
    expect(await filesIn(matterRoot)).toEqual([]);
  });

  // `attachmentFolder` is a NAME, resolved inside the scope root. Treated as a
  // path it would reach any folder in the firm.
  it.each([
    ['tries to climb out', '../../other'],
    ['contains a separator', 'a/b'],
  ])('refuses a folder name that %s', async (_label, attachmentFolder) => {
    const res = await uploadAttachments(owner, { context: 'matter', matterId, attachmentFolder }, [{ name: 'Planted.pdf', size: 512 }]);

    expect(res.status).toBe(400);
    expect(await storageReservedBytes(firm.id)).toBe(0);
    expect(await filesIn(matterRoot)).toEqual([]);
  });

  it('still refuses another firm matter as the scope', async () => {
    const rival = await rivalFirmWithDocument();

    const res = await uploadNoteAttachments(owner, { context: 'matter', matterId: rival.matterId }, [{ name: 'Planted.pdf', size: 512 }]);

    // The folder option must not become a way past the scope check.
    expect(res.status).toBe(404);
    expect(await storageReservedBytes(firm.id)).toBe(0);
    const { files: theirs } = await filesRepo.listChildren(rival.firm.id, rival.root);
    expect(theirs.map((f: any) => f.id)).toEqual([rival.file.id]);
  });
});

describe('uploading a task attachment', () => {
  it('files a standalone task attachment in the task own root', async () => {
    const res = await uploadAttachments(owner, { context: 'task', taskId: standaloneTask }, [{ name: 'Renewal.pdf', size: 1024 }]);

    expect(res.status).toBe(201);
    const taskRoot = await rootOf(firm.id, { taskId: standaloneTask });
    const stored = await soleFileIn(taskRoot);
    // `type: 'task-attachment'` used to be stamped on the object. Nothing read
    // it: the row's `task_id` is what makes this a task attachment, and
    // `delete-task-attachment` works from the row.
    expect(objects.get(stored.objectPath)?.custom)
      .toMatchObject({ taskId: standaloneTask });
    expect(await fileRowById(firm.id, stored.id))
      .toMatchObject({ name: 'Renewal.pdf', task_id: standaloneTask, matter_id: null });
  });

  it('files a matter-linked task attachment in the MATTER root, tagged both ways', async () => {
    const res = await uploadAttachments(owner, { context: 'task', taskId: linkedTask }, [{ name: 'Reply.pdf', size: 1024 }]);

    expect(res.status).toBe(201);
    const stored = await soleFileIn(matterRoot);
    // Both ids, because both browsers have to reach it: the matter's file view
    // filters these OUT by the task id, the task's view filters them IN, and
    // the matter id is what puts the document under the matter's legal hold.
    expect(objects.get(stored.objectPath)?.custom).toMatchObject({
      taskId: linkedTask,
      matterId,
      taskTitle: 'File the reply brief',
    });
    expect(await fileRowById(firm.id, stored.id))
      .toMatchObject({ task_id: linkedTask, matter_id: matterId });
  });

  it('charges the firm for the attachment bytes', async () => {
    await uploadAttachments(owner, { context: 'task', taskId: standaloneTask }, [{ name: 'Renewal.pdf', size: 4096 }]);

    expect(await storageUsedBytes(firm.id)).toBe(4096);
  });

  it('refuses a matter-linked task when the caller is not on its matter', async () => {
    const walled = await memberWith(firm.id, ['files.view', 'files.upload']);

    const res = await uploadAttachments(walled, { context: 'task', taskId: linkedTask }, [{ name: 'Planted.pdf', size: 512 }]);

    expect(res.status).toBe(403);
    expect(await filesIn(matterRoot)).toEqual([]);
  });

  it('refuses a member without the upload permission', async () => {
    const readOnly = await memberWith(firm.id, ['files.view']);
    await joinMatter(firm.id, matterId, readOnly.uid);

    const res = await uploadAttachments(readOnly, { context: 'task', taskId: linkedTask }, [{ name: 'Planted.pdf', size: 512 }]);

    expect(res.status).toBe(403);
    expect(await filesIn(matterRoot)).toEqual([]);
  });

  it('refuses a request with no task named', async () => {
    const res = await uploadAttachments(owner, {}, [{ name: 'Orphan.pdf', size: 512 }]);

    expect(res.status).toBe(400);
  });
});

describe('deleting a task attachment', () => {
  /** Upload one attachment through the route and return its row. */
  async function uploadAttachment(taskId: string, folderId: string) {
    const res = await uploadAttachments(owner, { context: 'task', taskId: taskId }, [{ name: 'Reply.pdf', size: 2048 }]);
    expect(res.status).toBe(201);
    return soleFileIn(folderId);
  }

  /**
   * Deleting the task takes its attachments with it, matter-linked or not.
   *
   * `tasks.service#deleteTask` used to run a second sweep of its own over the
   * task's `attachments` jsonb array. That array is gone (migration 0260) and
   * the sweep with it, on the grounds that the snapshot it already takes covers
   * the same set: every task attachment carries `files.task_id`, which is what
   * `scopeSnapshot` matches on and what the foreign key cascades on, even when
   * the document sits in the MATTER's tree. This is that reasoning, checked.
   */
  it('takes a matter-linked task attachment with the task', async () => {
    const stored = await uploadAttachment(linkedTask, matterRoot);
    expect(await fileRowById(firm.id, stored.id))
      .toMatchObject({ task_id: linkedTask, matter_id: matterId });

    const res = await owner.api.delete(`/api/lawfirms/${firm.id}/tasks/${linkedTask}`);
    expect(res.status).toBe(200);

    // Gone from the table, not soft-deleted: the composite foreign key on
    // (law_firm_id, task_id) cascades.
    expect(await fileRowById(firm.id, stored.id)).toBeUndefined();
  });

  it('leaves a note attachment of a matter-linked task in the matter tree', async () => {
    // The note route files into the same folder but does NOT tag the row with
    // the task, because the attachment belongs to the note. The note cascades
    // with the task; the document stays where the matter's browser lists it.
    const res = await uploadNoteAttachments(owner, { context: 'task', taskId: linkedTask }, [{ name: 'Exhibit.pdf', size: 1024 }]);
    expect(res.status).toBe(201);
    const folder = await attachmentsFolderIn(matterRoot);
    const stored = await soleFileIn(folder.id);
    expect(await fileRowById(firm.id, stored.id)).toMatchObject({ task_id: null, matter_id: matterId });

    expect((await owner.api.delete(`/api/lawfirms/${firm.id}/tasks/${linkedTask}`)).status).toBe(200);

    expect(await fileRowById(firm.id, stored.id)).toMatchObject({ name: 'Exhibit.pdf' });
  });

  it('DOES keep the task tag on a STANDALONE task note attachment', async () => {
    // The other half. A standalone task's row inherits `task_id` from the
    // folder it sits in, so clearing it would leave the row and the authorized
    // scope disagreeing, and finalize would refuse the row it just created.
    const res = await uploadNoteAttachments(owner, { context: 'task', taskId: standaloneTask }, [{ name: 'Checklist.pdf', size: 512 }]);

    expect(res.status).toBe(201);
    expect(await fileRowById(firm.id, res.body.files[0].fileId)).toMatchObject({ task_id: standaloneTask });
  });

  const del = (taskId: string, fileId: string, actor: Actor = owner) => actor.api.delete(
    `${F()}/delete-task-attachment?lawFirmId=${firm.id}&taskId=${taskId}&fileId=${fileId}`,
  );

  it('removes the row', async () => {
    const stored = await uploadAttachment(linkedTask, matterRoot);

    const res = await del(linkedTask, stored.id);

    expect(res.status).toBe(200);
    expect(await filesRepo.findById(firm.id, stored.id)).toBeNull();
  });

  it('credits the bytes back to the firm', async () => {
    const stored = await uploadAttachment(linkedTask, matterRoot);
    expect(await storageUsedBytes(firm.id)).toBe(2048);

    await del(linkedTask, stored.id);

    // Usage that only ever goes up strands a firm at its limit on documents it
    // has already thrown away.
    expect(await storageUsedBytes(firm.id)).toBe(0);
  });

  it('revokes a live share link to the deleted attachment', async () => {
    const stored = await uploadAttachment(linkedTask, matterRoot);
    const token = 'sharetoken0123456789abcdef01234567';
    const { rowCount } = await testPool.query(
      `insert into file_share_links (token, law_firm_id, file_id, display_name, expires_at)
       values ($1, $2, $3, 'Reply.pdf', now() + interval '7 days')`,
      [token, firm.id, stored.id],
    );
    expect(rowCount).toBe(1);

    await del(linkedTask, stored.id);

    // The token needs no login to follow, so a link outliving its document is a
    // door left open on a file the firm believes it deleted.
    const { rows } = await testPool.query(
      'select revoked_at from file_share_links where token = $1', [token],
    );
    expect(rows[0].revoked_at).not.toBeNull();
  });

  it('deletes a STANDALONE task attachment from the task own root', async () => {
    const taskRoot = await rootOf(firm.id, { taskId: standaloneTask });
    const stored = await uploadAttachment(standaloneTask, taskRoot);

    const res = await del(standaloneTask, stored.id);

    expect(res.status).toBe(200);
    expect(await filesRepo.findById(firm.id, stored.id)).toBeNull();
  });

  it('takes the deleted document off the task that had it attached', async () => {
    const stored = await uploadAttachment(linkedTask, matterRoot);
    await attachFileToTask(firm.id, linkedTask, stored.id);
    expect(await taskAttachments(linkedTask)).toHaveLength(1);

    const res = await del(linkedTask, stored.id);

    // The task used to keep a jsonb copy of the file, so this route deleted the
    // document and left an entry naming bytes that were gone; the task editor
    // was expected to notice and save the task again. The link is a row against
    // the file now, so the one delete settles both.
    expect(res.status).toBe(200);
    expect(await filesRepo.findById(firm.id, stored.id)).toBeNull();
    expect(await taskAttachments(linkedTask)).toEqual([]);
  });

  it('refuses a file belonging to a DIFFERENT matter of the same firm', async () => {
    const otherRoot = await rootOf(firm.id, { matterId: otherMatterId });
    const elsewhere = await seedFile(firm.id, {
      parentId: otherRoot, name: 'Someone Else.pdf', bytes: 999,
    });

    const res = await del(linkedTask, elsewhere.id);

    // The task id the caller names is not on its own a licence to delete. The
    // row has to carry that task id, and this one carries none.
    expect(res.status).toBe(403);
    expect(await filesRepo.findById(firm.id, elsewhere.id)).not.toBeNull();
  });

  it('refuses a file under a STANDALONE task other than the one named', async () => {
    const otherTask = await seedTask(firm.id, { title: 'Unrelated' });
    const otherRoot = await rootOf(firm.id, { taskId: otherTask });
    const elsewhere = await seedFile(firm.id, {
      parentId: otherRoot, name: 'Theirs.pdf', bytes: 999, taskId: otherTask,
    });

    const res = await del(standaloneTask, elsewhere.id);

    expect(res.status).toBe(403);
    expect(await filesRepo.findById(firm.id, elsewhere.id)).not.toBeNull();
  });

  it('refuses a file belonging to another firm', async () => {
    const { firm: rival, file: theirs } = await rivalFirmWithDocument();

    const res = await del(linkedTask, theirs.id);

    // The first case for any route. The lookup is scoped to the caller's firm,
    // so a real id from another firm resolves to nothing at all.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await filesRepo.findById(rival.id, theirs.id)).not.toBeNull();
  });

  it('refuses to delete an attachment of a matter under legal hold', async () => {
    const stored = await uploadAttachment(linkedTask, matterRoot);
    const { rowCount } = await testPool.query(
      `insert into legal_holds (law_firm_id, matter_id, reason)
       values ($1, $2, 'fixture hold')`,
      [firm.id, matterId],
    );
    expect(rowCount).toBe(1);

    const res = await del(linkedTask, stored.id);

    // A matter-linked task's attachments live in the matter's tree, so the
    // matter's hold covers them. Reaching them through the task route would
    // otherwise be a way around a litigation hold.
    expect(res.status).toBe(403);
    expect(await filesRepo.findById(firm.id, stored.id)).not.toBeNull();
    expect(await storageUsedBytes(firm.id)).toBe(2048);
  });

  it('refuses a member holding only the upload permission', async () => {
    const stored = await uploadAttachment(linkedTask, matterRoot);
    const uploader = await memberWith(firm.id, ['files.view', 'files.upload']);
    await joinMatter(firm.id, matterId, uploader.uid);

    const res = await del(linkedTask, stored.id, uploader);

    expect(res.status).toBe(403);
    expect(await filesRepo.findById(firm.id, stored.id)).not.toBeNull();
  });

  it('answers not-found for a file id with nothing behind it', async () => {
    const res = await del(linkedTask, '00000000-0000-4000-8000-000000000000');

    expect(res.status).toBe(404);
  });
});
